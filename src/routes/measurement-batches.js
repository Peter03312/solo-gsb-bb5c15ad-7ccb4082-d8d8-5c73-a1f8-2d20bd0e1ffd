'use strict';

/*
 * 实测 CSV 导入批次路由（规则 18）。
 *   POST /api/measurement-batches/preview     保管员：解析 + 逐行校验 + 整批预计占用试算，不写库
 *   POST /api/measurement-batches             保管员：导入为待确认批次（有错误整批不保存）
 *   GET  /api/measurement-batches             登录：批次列表（exhibitId/planId/status 过滤）
 *   GET  /api/measurement-batches/:id         登录：批次详情（含逐行）
 *   POST /api/measurement-batches/:id/confirm 保管员：展品锁内重核，全部有效才原子生成
 *                                             已确认实测并记批次审计；重复确认返回原批次结果
 * 待确认批次不占额度、不参与重叠判定；确认导致超限仍入账（409 报告超额年份并转待复核）。
 */

const express = require('express');
const { query, withExhibitTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError, ConflictError } = require('../validation');
const {
  ACTIVE_PLAN_STATUSES,
  lockExhibit,
  getPlan,
  computeOccupancy,
  evaluateMeasurementBatch,
  overflowInfoFromOccupancy,
  flagPlansForOverflow,
} = require('../service');
const { round3 } = require('../dosing');
const { parseMeasurementCsvRows } = require('../csv');

const router = express.Router();

router.use(requireAuth);

/** 原始 CSV 也可经 text/csv、text/plain 直接提交（planId 走查询参数）。 */
const textCsv = express.text({ type: ['text/csv', 'text/plain'], limit: '1mb' });

/** JSONB 字段兼容：真实 pg 返回对象，个别内存驱动可能返回字符串。 */
function asJson(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch (_) {
      return fallback;
    }
  }
  return v;
}

/** 批次行对外字段（驼峰）。 */
function serializeBatchRow(r) {
  return {
    row: r.row,
    line: r.line,
    start: r.start,
    end: r.end,
    actualLux: r.lux,
    note: r.note || null,
    yearly: r.yearly || {},
  };
}

/** 批次对外字段（驼峰）；withRows=false 时不带逐行明细（列表/展品详情摘要用）。 */
function serializeMeasurementBatch(b, { withRows = true } = {}) {
  const out = {
    id: Number(b.id),
    planId: Number(b.plan_id),
    exhibitId: Number(b.exhibit_id),
    planTitle: b.plan_title || null,
    status: b.status,
    sourceName: b.source_name || null,
    rowCount: Number(b.row_count),
    totalYearly: asJson(b.total_yearly, {}),
    createdBy: b.created_by != null ? Number(b.created_by) : null,
    creatorName: b.creator_name || null,
    createdAt: b.created_at,
    confirmedBy: b.confirmed_by != null ? Number(b.confirmed_by) : null,
    confirmedAt: b.confirmed_at || null,
    measurementIds: asJson(b.measurement_ids, null),
  };
  if (withRows) out.rows = (asJson(b.rows_json, []) || []).map(serializeBatchRow);
  const confirmResult = asJson(b.confirm_result, null);
  if (confirmResult) out.confirmResult = confirmResult;
  return out;
}

/** hasHeader 参数：true/false 显式指定，缺省自动检测。 */
function parseHasHeader(v) {
  if (v === undefined || v === null || v === '') return undefined;
  if (v === true || v === 'true' || v === '1' || v === 1) return true;
  if (v === false || v === 'false' || v === '0' || v === 0) return false;
  throw new ValidationError('hasHeader 只能是 true/false');
}

/** 从请求提取 { planId, csv, sourceName, hasHeader }：JSON body 或 text/csv 原文。 */
function extractCsvPayload(req) {
  const body = req.body || {};
  if (typeof body === 'string') {
    const planId = Number(req.query.planId);
    if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效（查询参数 planId）');
    const sourceName = typeof req.query.sourceName === 'string'
      ? req.query.sourceName.slice(0, 200) : null;
    return { planId, csv: body, sourceName, hasHeader: parseHasHeader(req.query.hasHeader) };
  }
  const planId = Number(body.planId);
  if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
  if (typeof body.csv !== 'string' || body.csv.trim() === '') {
    throw new ValidationError('CSV 内容不能为空（字段 csv）');
  }
  const sourceName = typeof body.sourceName === 'string' && body.sourceName.trim() !== ''
    ? body.sourceName.trim().slice(0, 200) : null;
  return { planId, csv: body.csv, sourceName, hasHeader: parseHasHeader(body.hasHeader) };
}

/** 行级错误对外结构：行号（数据行/文件行）+ 全部原因 + 结构化冲突。 */
function serializeRowError(r) {
  const conflicts = {};
  if (r.conflicts) {
    for (const [k, v] of Object.entries(r.conflicts)) {
      if (Array.isArray(v) && v.length > 0) conflicts[k] = v;
    }
  }
  return {
    row: r.row,
    line: r.line,
    reasons: r.errors.map((e) => e.message),
    kinds: [...new Set(r.errors.map((e) => e.kind))],
    conflicts,
  };
}

/**
 * 把逐行错误归并为一次失败：取值/窗口类（value/window）-> 400；纯相交类 -> 409；
 * forceConflict（批次确认重核）一律 409。details.rows 列出全部行号与原因。
 */
function batchValidationFailure(rows, { prefix, forceConflict = false }) {
  const errorRows = rows.filter((r) => r.errors.length > 0);
  const hasValueError = errorRows.some((r) => r.errors.some((e) => e.kind !== 'overlap'));
  const parts = errorRows.map((r) => `第 ${r.row} 行：${r.errors.map((e) => e.message).join('；')}`);
  const details = { rows: errorRows.map(serializeRowError) };
  if (!forceConflict && hasValueError) {
    const err = new ValidationError(`${prefix}${parts.join('；')}`);
    err.details = details;
    return err;
  }
  return new ConflictError(`${prefix}${parts.join('；')}`, details);
}

/**
 * 整批预计占用（预览/导入共用，不写库）：
 * 以「批次确认后实测替代估算」的同一口径预演占用，逐年给出
 * 上限 / 当前占用 / 本批剂量 / 被替代的估算 / 预计合计 / 剩余 / 是否超限。
 */
async function projectedYearsForBatch(client, plan, validRows, totalYearly) {
  const exhibitId = plan.exhibit_id;
  const before = await computeOccupancy(client, exhibitId);
  const after = await computeOccupancy(client, exhibitId, {
    extraMeasurements: validRows.map((r) => ({
      planId: plan.id,
      start: r.startMs,
      end: r.endMs,
      lux: r.lux,
    })),
  });
  const years = new Set([
    ...Object.keys(before.limits),
    ...Object.keys(before.used),
    ...Object.keys(totalYearly),
  ].map(Number));
  const out = {};
  for (const year of [...years].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = before.limits[key] !== undefined ? round3(before.limits[key]) : null;
    const usedBefore = round3(before.used[key] || 0);
    const projected = round3(after.used[key] || 0);
    const batchDose = round3(totalYearly[key] || 0);
    out[key] = {
      year,
      limit,
      usedBefore,
      batchDose,
      replacedEstimate: round3(usedBefore + batchDose - projected),
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      over: limit === null ? false : projected - limit > 0.005,
      missingLimit: limit === null && projected > 0,
    };
  }
  return out;
}

/** 计划须为已批准/待复核（与单条实测录入同口径）。 */
function assertPlanImportable(plan) {
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError(
      `只有已批准（或待复核）计划才能导入实测批次（当前状态：${plan.status}）`
    );
  }
}

/**
 * 批次列表（登录可读；布展员只读）。
 * 过滤参数（均可空）：exhibitId / planId / status（pending|confirmed）。
 */
router.get('/', async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.exhibitId !== undefined) {
      const exhibitId = Number(req.query.exhibitId);
      if (!Number.isInteger(exhibitId)) throw new ValidationError('展品 ID 无效');
      params.push(exhibitId);
      conds.push(`b.exhibit_id = $${params.length}`);
    }
    if (req.query.planId !== undefined) {
      const planId = Number(req.query.planId);
      if (!Number.isInteger(planId)) throw new ValidationError('计划 ID 无效');
      params.push(planId);
      conds.push(`b.plan_id = $${params.length}`);
    }
    if (req.query.status !== undefined) {
      const status = String(req.query.status);
      if (!['pending', 'confirmed'].includes(status)) {
        throw new ValidationError('批次状态只能是 pending 或 confirmed');
      }
      params.push(status);
      conds.push(`b.status = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT b.*, p.title AS plan_title, u.display_name AS creator_name
         FROM measurement_import_batches b
         JOIN plans p ON p.id = b.plan_id
         LEFT JOIN users u ON u.id = b.created_by
        ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
        ORDER BY b.id DESC`,
      params
    );
    res.json({ batches: rows.map((b) => serializeMeasurementBatch(b, { withRows: false })) });
  } catch (err) {
    next(err);
  }
});

/** 批次详情（登录可读，含逐行与确认结果）。 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('批次 ID 无效');
    const { rows } = await query(
      `SELECT b.*, p.title AS plan_title, u.display_name AS creator_name
         FROM measurement_import_batches b
         JOIN plans p ON p.id = b.plan_id
         LEFT JOIN users u ON u.id = b.created_by
        WHERE b.id = $1`,
      [id]
    );
    if (rows.length === 0) throw new ValidationError('实测批次不存在');
    res.json({ batch: serializeMeasurementBatch(rows[0]) });
  } catch (err) {
    next(err);
  }
});

/**
 * 预览（保管员）：解析 CSV + 逐行校验 + 整批预计占用试算，不写库、不改变额度。
 * 有错误时返回行号与原因（取值/窗口类 400，纯相交类 409）。
 */
router.post('/preview', requireRole('conservator'), textCsv, async (req, res, next) => {
  try {
    const { planId, csv, hasHeader } = extractCsvPayload(req);
    const { rows, headerDetected } = parseMeasurementCsvRows(csv, { hasHeader });
    const plan = await getPlan({ query }, planId);
    assertPlanImportable(plan);

    const { rows: evaluated, errorRows, totalYearly } =
      await evaluateMeasurementBatch({ query }, plan, rows);
    if (errorRows.length > 0) {
      throw batchValidationFailure(evaluated, { prefix: '实测 CSV 校验失败：' });
    }
    const projectedYears = await projectedYearsForBatch({ query }, plan, evaluated, totalYearly);
    res.json({
      preview: {
        planId: Number(plan.id),
        exhibitId: Number(plan.exhibit_id),
        planTitle: plan.title,
        rowCount: evaluated.length,
        headerDetected,
        rows: evaluated.map(serializeBatchRow),
        totalYearly,
        projectedYears,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 导入（保管员）：与预览同一校验口径；全部有效才保存为待确认批次（不改变额度），
 * 任一错误整批不保存并在 details.rows 列出行号与原因。
 * 成功响应（201）：batch（含逐行按年剂量）+ projectedYears（整批预计占用）。
 */
router.post('/', requireRole('conservator'), textCsv, async (req, res, next) => {
  try {
    const { planId, csv, sourceName, hasHeader } = extractCsvPayload(req);
    const { rows, headerDetected } = parseMeasurementCsvRows(csv, { hasHeader });
    const prePlan = await getPlan({ query }, planId);

    const result = await withExhibitTransaction(prePlan.exhibit_id, async (client) => {
      await lockExhibit(client, prePlan.exhibit_id);
      const plan = await getPlan(client, planId);
      assertPlanImportable(plan);

      const { rows: evaluated, errorRows, totalYearly } =
        await evaluateMeasurementBatch(client, plan, rows);
      if (errorRows.length > 0) {
        throw batchValidationFailure(evaluated, { prefix: '实测 CSV 校验失败，整批未保存：' });
      }

      const storedRows = evaluated.map((r) => ({
        row: r.row,
        line: r.line,
        start: r.start,
        end: r.end,
        startMs: r.startMs,
        endMs: r.endMs,
        lux: r.lux,
        note: r.note || null,
        yearly: r.yearly,
      }));
      const inserted = await client.query(
        `INSERT INTO measurement_import_batches
           (plan_id, exhibit_id, status, source_name, row_count, rows_json, total_yearly, created_by)
         VALUES ($1, $2, 'pending', $3, $4, $5::jsonb, $6::jsonb, $7)
         RETURNING *`,
        [plan.id, plan.exhibit_id, sourceName, evaluated.length,
          JSON.stringify(storedRows), JSON.stringify(totalYearly), req.sessionUser.userId]
      );
      const batch = inserted.rows[0];
      await recordAudit(client, req.sessionUser, 'measurement_batch.import',
        'measurement_batch', batch.id, {
          planId: Number(plan.id),
          exhibitId: Number(plan.exhibit_id),
          rowCount: evaluated.length,
          totalYearly,
          sourceName,
        });
      const projectedYears = await projectedYearsForBatch(client, plan, evaluated, totalYearly);
      return { batch, projectedYears };
    });

    res.status(201).json({
      batch: serializeMeasurementBatch({
        ...result.batch,
        plan_title: prePlan.title,
        creator_name: req.sessionUser.displayName,
      }),
      projectedYears: result.projectedYears,
      headerDetected,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 确认（保管员）：展品锁事务内按实时占用重新校验整批：
 *   - 计划仍须为已批准/待复核；逐行窗口与相交核对（含批次内部）全部通过，
 *     才原子生成已确认实测（关联批次）并记录批次审计；
 *   - 任一校验失败：批次保持待确认且不计量（409，details.rows 列出行号与原因）；
 *   - 确认导致超限仍入账：列出超额年份，相关年度尚未开始且有估算残余的已批准计划转待复核；
 *   - 重复确认幂等：直接返回原批次结果（confirmResult），不重复生成实测。
 */
router.post('/:id/confirm', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('批次 ID 无效');
    const pre = await query('SELECT exhibit_id FROM measurement_import_batches WHERE id = $1', [id]);
    if (pre.rows.length === 0) throw new ValidationError('实测批次不存在');
    const exhibitId = pre.rows[0].exhibit_id;

    const result = await withExhibitTransaction(exhibitId, async (client) => {
      await lockExhibit(client, exhibitId);
      const bRows = await client.query(
        'SELECT * FROM measurement_import_batches WHERE id = $1 FOR UPDATE',
        [id]
      );
      const batch = bRows.rows[0];
      if (!batch) throw new ValidationError('实测批次不存在');

      const { exhibitDetail } = require('./exhibits');

      // 重复确认：原批次结果原样返回，不再生成实测
      if (batch.status === 'confirmed') {
        const joined = (await client.query(
          `SELECT b.*, p.title AS plan_title, u.display_name AS creator_name
             FROM measurement_import_batches b
             JOIN plans p ON p.id = b.plan_id
             LEFT JOIN users u ON u.id = b.created_by
            WHERE b.id = $1`,
          [id]
        )).rows[0];
        const detail = await exhibitDetail(client, exhibitId, { lock: true });
        return { duplicate: true, batch: joined, detail };
      }

      const plan = await getPlan(client, batch.plan_id);
      if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
        throw new ConflictError(
          `计划 #${plan.id} 当前状态为 ${plan.status}，批次确认失败，批次保持待确认`,
          { batchId: id, planId: Number(plan.id), planStatus: plan.status }
        );
      }

      // 按实时占用重新校验整批（行内容以导入时保存的为准）
      const storedRows = asJson(batch.rows_json, []) || [];
      const rows = storedRows.map((r) => ({
        row: r.row,
        line: r.line,
        startMs: r.startMs,
        endMs: r.endMs,
        lux: r.lux,
        note: r.note || null,
        errors: [],
      }));
      const { rows: evaluated, errorRows, totalYearly } =
        await evaluateMeasurementBatch(client, plan, rows);
      if (errorRows.length > 0) {
        throw batchValidationFailure(evaluated, {
          prefix: `实测批次 #${id} 确认校验失败，批次保持待确认且不计量：`,
          forceConflict: true,
        });
      }

      // 全部有效：原子生成已确认实测（关联批次）
      const measurementIds = [];
      for (const r of evaluated) {
        const ins = await client.query(
          `INSERT INTO measurements
             (plan_id, exhibit_id, start_ts, end_ts, actual_lux, note, status,
              created_by, confirmed_by, confirmed_at, import_batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $7, now(), $8)
           RETURNING id`,
          [plan.id, exhibitId, new Date(r.startMs), new Date(r.endMs), r.lux,
            r.note || null, req.sessionUser.userId, id]
        );
        measurementIds.push(Number(ins.rows[0].id));
      }

      // 实时占用（新实测已入账）：找出本次剂量影响年份的超额
      const occupancy = await computeOccupancy(client, exhibitId);
      const candidateYears = Object.keys(totalYearly).map(Number);
      const { overflows, overflowYears } = overflowInfoFromOccupancy(occupancy, candidateYears);

      // 超限仍入账：相关年度尚未开始且有估算残余的已批准计划转待复核（既有规则）
      let flagged = [];
      if (overflowYears.length > 0) {
        flagged = await flagPlansForOverflow(client, req.sessionUser, {
          exhibitId,
          occupancy,
          overflowYears,
          trigger: { triggerMeasurementBatchId: id },
          reason: () => `实测批次 #${id} 确认后导致 ${overflowYears.join('、')} 年额度超限，转待复核`,
        });
      }

      // 批次确认入账（含可能的待复核转态）后：锁事务内仅重算整批剂量影响到的年份。
      // 先刷新派生占用，再以最终占用判定这些年份的预警边沿。
      const { refreshUsageYears, recomputeExhibitUsage } = require('../usage');
      const affectedYears = Object.keys(totalYearly).map(Number);
      await refreshUsageYears(client, exhibitId, affectedYears);
      const alertEvents = (await recomputeExhibitUsage(
        client, exhibitId, affectedYears, {
          actor: req.sessionUser,
          trigger: {
            type: 'measurement_batch.confirm',
            detail: { batchId: id, measurementIds, totalYearly },
          },
        }
      )).events;

      const confirmResult = {
        rowCount: evaluated.length,
        measurementIds,
        totalYearly,
        overflows,
        overflowYears,
        flaggedPlans: flagged,
        confirmedBy: req.sessionUser.userId,
      };
      await client.query(
        `UPDATE measurement_import_batches
            SET status = 'confirmed', confirmed_by = $2, confirmed_at = now(),
                measurement_ids = $3::jsonb, confirm_result = $4::jsonb
          WHERE id = $1`,
        [id, req.sessionUser.userId, JSON.stringify(measurementIds), JSON.stringify(confirmResult)]
      );
      await recordAudit(client, req.sessionUser, 'measurement_batch.confirm',
        'measurement_batch', id, {
          planId: Number(plan.id),
          exhibitId: Number(exhibitId),
          rowCount: evaluated.length,
          measurementIds,
          totalYearly,
          overflows,
        });

      const updated = (await client.query(
        `SELECT b.*, p.title AS plan_title, u.display_name AS creator_name
           FROM measurement_import_batches b
           JOIN plans p ON p.id = b.plan_id
           LEFT JOIN users u ON u.id = b.created_by
          WHERE b.id = $1`,
        [id]
      )).rows[0];
      const detail = await exhibitDetail(client, exhibitId, { lock: true });
      return { duplicate: false, batch: updated, confirmResult, detail, overflows, flagged, alertEvents };
    });

    if (result.duplicate) {
      return res.json({
        duplicate: true,
        batch: serializeMeasurementBatch(result.batch),
        confirmResult: asJson(result.batch.confirm_result, null),
        detail: result.detail,
      });
    }
    const payload = {
      batch: serializeMeasurementBatch(result.batch),
      confirmResult: result.confirmResult,
      detail: result.detail,
      quotaAlertEvents: result.alertEvents,
    };
    if (result.overflows.length > 0) {
      // 批次已确认入账，但触发超限：用 409 明确报告年份、超额量及被转待复核的计划
      return res.status(409).json({
        message:
          `实测批次 #${id} 已确认并入账，但确认后超限：` +
          result.overflows.map((o) => `${o.year} 年超出 ${o.excess} lx·h`).join('；') +
          (result.flagged.length
            ? `。已将 ${result.flagged.length} 条尚未开始的计划转为待复核`
            : '；该年度没有尚未开始的已批准计划'),
        overflows: result.overflows,
        flaggedPlans: result.flagged,
        ...payload,
      });
    }
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

module.exports = { router, serializeMeasurementBatch };
