'use strict';

/*
 * 展厅驻留（陈列关系）与展厅路由（规则 19）。
 *   GET  /api/halls                 登录：展厅列表（附驻留条数）
 *   GET  /api/residences            登录：驻留列表（可按 exhibitId / hallCode 过滤）
 *   POST /api/residences            保管员：以“展厅标识 + 展品编号 + 驻留起止”登记陈列关系
 *                                   （未知展品 400；起止无效 400；同展品驻留区间重叠 409）
 *   PUT  /api/residences/:id        保管员：修改尚未被共享照明归属覆盖的驻留（已覆盖拒绝回改）
 *   DELETE /api/residences/:id      保管员：删除尚未被共享照明归属覆盖的驻留
 * 已被共享照明归属覆盖的驻留永久不得回改；驻留记录一经覆盖只可原样保留。
 */

const express = require('express');
const {
  query,
  withTransaction,
  withKeyLock,
  withOrderedKeyTransaction,
} = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const {
  ValidationError,
  ConflictError,
  assertDate,
  nonEmptyString,
  parseTimeToMinutes,
} = require('../validation');
const {
  lockExhibit,
  getHallByCode,
  loadResidenceView,
  registerResidence,
} = require('../service');
const { wallToTs, tsToWallString } = require('../dosing');

const router = express.Router();
/** 展厅只读列表单独挂在 /api/halls（与驻留写接口同一个模块导出）。 */
const hallRouter = express.Router();

router.use(requireAuth);
hallRouter.use(requireAuth);

/** 驻留对外字段（驼峰）。 */
function serializeResidence(r) {
  const start = r.start != null ? r.start : tsToWallString(new Date(r.start_ts).getTime());
  const end = r.end != null ? r.end : tsToWallString(new Date(r.end_ts).getTime());
  return {
    id: Number(r.id),
    exhibitId: Number(r.exhibit_id != null ? r.exhibit_id : r.exhibitId),
    hallId: Number(r.hall_id != null ? r.hall_id : r.hallId),
    hallCode: r.hall_code != null ? r.hall_code : r.hallCode,
    start,
    end,
    createdBy: r.created_by != null ? r.created_by : r.createdBy,
    createdAt: r.created_at != null ? r.created_at : r.createdAt,
    covered: r.covered === true,
  };
}

/**
 * 解析驻留起止：{ exhibitId, hallCode, startDate, [startTime], endDate, [endTime] }。
 * 开始时刻缺省为当日 00:00；结束时刻缺省为结束日期次日 00:00（即该日整天，左闭右开）。
 */
function parseResidenceBody(body) {
  const exhibitId = Number(body.exhibitId);
  if (!Number.isInteger(exhibitId) || exhibitId <= 0) throw new ValidationError('展品 ID 无效');
  const hallCode = nonEmptyString(body.hallCode, '展厅标识', 64);
  const startDate = assertDate(body.startDate, '驻留开始日期');
  const endDate = body.endDate ? assertDate(body.endDate, '驻留结束日期') : startDate;
  if (endDate < startDate) throw new ValidationError('驻留结束日期不能早于开始日期');
  const startMinute = body.startTime === undefined || body.startTime === null || body.startTime === ''
    ? 0 : parseTimeToMinutes(body.startTime);
  // 结束日期当天 24:00 用次日 0 分钟表示：endDate+1 00:00
  let endMs;
  if (body.endTime === undefined || body.endTime === null || body.endTime === '') {
    const y = Number(endDate.slice(0, 4));
    const m = Number(endDate.slice(5, 7));
    const d = Number(endDate.slice(8, 10));
    endMs = Date.UTC(y, m - 1, d + 1) - require('../config').tzOffsetMs;
  } else {
    endMs = wallToTs(endDate, parseTimeToMinutes(body.endTime));
  }
  const startMs = wallToTs(startDate, startMinute);
  return { exhibitId, hallCode, startMs, endMs };
}

/** 展厅列表（登录可读），附驻留条数。 */
hallRouter.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM halls ORDER BY hall_code, id');
    const counts = new Map();
    if (rows.length > 0) {
      const ph = rows.map((_, i) => `$${i + 1}`).join(',');
      const cRows = (await query(
        `SELECT hall_id, COUNT(*)::int AS n FROM exhibit_residences
          WHERE hall_id IN (${ph}) GROUP BY hall_id`,
        rows.map((h) => h.id)
      )).rows;
      for (const c of cRows) counts.set(Number(c.hall_id), Number(c.n));
    }
    res.json({
      halls: rows.map((h) => ({
        id: Number(h.id),
        hallCode: h.hall_code,
        name: h.name,
        residenceCount: counts.get(Number(h.id)) || 0,
        createdAt: h.created_at,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * 驻留列表（登录可读）：可按 exhibitId / hallCode 过滤，逐条附 covered 是否已被共享照明覆盖。
 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = req.query.exhibitId ? Number(req.query.exhibitId) : null;
    const hallCode = req.query.hallCode ? String(req.query.hallCode) : null;
    if (exhibitId !== null && !Number.isInteger(exhibitId)) {
      throw new ValidationError('展品 ID 无效');
    }

    let targetExhibitIds;
    if (exhibitId !== null) {
      targetExhibitIds = [exhibitId];
    } else if (hallCode !== null) {
      const hall = await getHallByCode({ query }, hallCode);
      if (!hall) return res.json({ residences: [] });
      const { rows } = await query(
        `SELECT exhibit_id FROM exhibit_residences WHERE hall_id = $1`,
        [hall.id]
      );
      targetExhibitIds = [...new Set(rows.map((r) => Number(r.exhibit_id)))];
    } else {
      const { rows } = await query('SELECT id FROM exhibits ORDER BY id');
      targetExhibitIds = rows.map((r) => Number(r.id));
    }

    const items = [];
    for (const exId of targetExhibitIds) {
      const view = await loadResidenceView({ query }, exId);
      let list = view.items;
      if (hallCode !== null) list = list.filter((x) => x.hallCode === hallCode);
      items.push(...list);
    }
    items.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));
    res.json({ residences: items.map(serializeResidence) });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员登记陈列关系（驻留）：展厅首次使用时自动创建展厅；同展品驻留区间不得重叠。
 * 加锁顺序统一为“展厅键 → 展品键”（与共享照明登记一致），避免跨键循环等待。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const input = parseResidenceBody(req.body || {});

    // 未知展品 → 400（先于事务校验）
    const ex = await query('SELECT id FROM exhibits WHERE id = $1', [input.exhibitId]);
    if (ex.rows.length === 0) throw new ValidationError('展品不存在');

    // 展厅不存在则先在独立事务内创建（创建仅取展厅键，未与展品锁形成交叉）。
    let hall = await getHallByCode({ query }, input.hallCode);
    if (!hall) {
      hall = await withKeyLock(`hall:code:${input.hallCode}`, () =>
        withTransaction(async (client) => {
          const existing = await getHallByCode(client, input.hallCode);
          if (existing) return existing;
          const ins = await client.query(
            'INSERT INTO halls (hall_code, created_by) VALUES ($1, $2) RETURNING *',
            [input.hallCode, req.sessionUser.userId]
          );
          await recordAudit(client, req.sessionUser, 'hall.create', 'hall', ins.rows[0].id, {
            hallCode: input.hallCode,
          });
          return ins.rows[0];
        })
      );
    }

    const result = await withOrderedKeyTransaction(
      [`hall:${hall.id}`, `exhibit:${input.exhibitId}`],
      async (client) => {
        await client.query('SELECT id FROM halls WHERE id = $1 FOR UPDATE', [hall.id]);
        await lockExhibit(client, input.exhibitId);
        const row = await registerResidence(client, {
          exhibitId: input.exhibitId,
          hallId: hall.id,
          startMs: input.startMs,
          endMs: input.endMs,
        }, req.sessionUser);
        await recordAudit(client, req.sessionUser, 'residence.create', 'exhibit_residence', row.id, {
          exhibitId: input.exhibitId,
          hallId: Number(hall.id),
          hallCode: input.hallCode,
          start: tsToWallString(input.startMs),
          end: tsToWallString(input.endMs),
        });
        return row;
      }
    );

    res.status(201).json({
      residence: serializeResidence({
        ...result,
        hall_id: hall.id,
        hall_code: input.hallCode,
        covered: false,
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** 读取驻留行（不存在抛 400）。 */
async function requireResidence(client, id) {
  const { rows } = await client.query(
    `SELECT r.*, h.hall_code FROM exhibit_residences r JOIN halls h ON h.id = r.hall_id
      WHERE r.id = $1`,
    [id]
  );
  if (rows.length === 0) throw new ValidationError('驻留记录不存在');
  return rows[0];
}

/** 驻留是否已被共享照明归属覆盖。 */
async function isResidenceCovered(client, residenceId) {
  const { rows } = await client.query(
    'SELECT 1 FROM shared_lighting_allocations WHERE residence_id = $1 LIMIT 1',
    [residenceId]
  );
  return rows.length > 0;
}

/**
 * 保管员修改驻留（仅未被共享照明归属覆盖者）：可改展厅标识与起止；展品不可改。
 * 已被照明覆盖的驻留不得回改 → 409；同展品新区间与其他驻留重叠 → 409。
 */
router.put('/:id', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('驻留 ID 无效');

    const pre = await query(
      `SELECT r.*, h.hall_code FROM exhibit_residences r JOIN halls h ON h.id = r.hall_id
        WHERE r.id = $1`,
      [id]
    );
    if (pre.rows.length === 0) throw new ValidationError('驻留记录不存在');
    const current = pre.rows[0];
    const exhibitId = Number(current.exhibit_id);

    // 允许部分更新：未提供的字段沿用原值（仍要求正时长与不重叠）。
    const body = req.body || {};
    const hallCode = body.hallCode !== undefined
      ? nonEmptyString(body.hallCode, '展厅标识', 64)
      : current.hall_code;
    let hall = await getHallByCode({ query }, hallCode);
    if (!hall) {
      hall = await withKeyLock(`hall:code:${hallCode}`, () =>
        withTransaction(async (client) => {
          const existing = await getHallByCode(client, hallCode);
          if (existing) return existing;
          const ins = await client.query(
            'INSERT INTO halls (hall_code, created_by) VALUES ($1, $2) RETURNING *',
            [hallCode, req.sessionUser.userId]
          );
          await recordAudit(client, req.sessionUser, 'hall.create', 'hall', ins.rows[0].id, {
            hallCode,
          });
          return ins.rows[0];
        })
      );
    }

    let startMs;
    let endMs;
    const cfg = require('../config');
    if (body.startDate !== undefined || body.startTime !== undefined) {
      const startDate = assertDate(
        body.startDate !== undefined ? body.startDate : new Date(Number(current.start_ts) + cfg.tzOffsetMs)
          .toISOString().slice(0, 10),
        '驻留开始日期'
      );
      const startMinute = body.startTime !== undefined && body.startTime !== ''
        ? parseTimeToMinutes(body.startTime) : 0;
      startMs = wallToTs(startDate, startMinute);
    } else {
      startMs = new Date(current.start_ts).getTime();
    }
    if (body.endDate !== undefined || body.endTime !== undefined) {
      const endDate = assertDate(
        body.endDate !== undefined ? body.endDate : new Date(Number(current.end_ts) + cfg.tzOffsetMs)
          .toISOString().slice(0, 10),
        '驻留结束日期'
      );
      if (body.endTime !== undefined && body.endTime !== '') {
        endMs = wallToTs(endDate, parseTimeToMinutes(body.endTime));
      } else {
        const y = Number(endDate.slice(0, 4));
        const m = Number(endDate.slice(5, 7));
        const d = Number(endDate.slice(8, 10));
        endMs = Date.UTC(y, m - 1, d + 1) - cfg.tzOffsetMs;
      }
    } else {
      endMs = new Date(current.end_ts).getTime();
    }

    const oldHallId = Number(current.hall_id);
    const newHallId = Number(hall.id);
    const lockKeys = [...new Set([`hall:${oldHallId}`, `hall:${newHallId}`, `exhibit:${exhibitId}`])];

    const updated = await withOrderedKeyTransaction(lockKeys, async (client) => {
      const residence = await requireResidence(client, id);
      if (await isResidenceCovered(client, id)) {
        throw new ConflictError(
          `驻留 #${id} 已被共享照明归属覆盖，归属不得回改（不可修改/删除）`,
          { residenceId: id, coveredByLighting: true }
        );
      }
      if (!(endMs > startMs)) throw new ValidationError('驻留结束必须晚于开始');
      const { rows: clashRows } = await client.query(
        `SELECT id FROM exhibit_residences
          WHERE exhibit_id = $1 AND id <> $2 AND start_ts < $4 AND end_ts > $3
          ORDER BY id LIMIT 1`,
        [exhibitId, id, new Date(startMs), new Date(endMs)]
      );
      if (clashRows.length > 0) {
        throw new ConflictError(
          `该展品已有驻留 #${clashRows[0].id} 与修改后的区间重叠，单件展品的驻留区间不得重叠`,
          { overlappingResidenceId: Number(clashRows[0].id) }
        );
      }
      const upd = await client.query(
        `UPDATE exhibit_residences SET hall_id = $2, start_ts = $3, end_ts = $4
          WHERE id = $1 RETURNING *`,
        [id, newHallId, new Date(startMs), new Date(endMs)]
      );
      await recordAudit(client, req.sessionUser, 'residence.update', 'exhibit_residence', id, {
        exhibitId,
        oldHallId,
        newHallId,
        hallCode,
        start: tsToWallString(startMs),
        end: tsToWallString(endMs),
      });
      return upd.rows[0];
    });

    res.json({ residence: serializeResidence({ ...updated, hall_code: hallCode, covered: false }) });
  } catch (err) {
    next(err);
  }
});

/**
 * 保管员删除驻留（仅未被共享照明归属覆盖者）。已覆盖 → 409。
 */
router.delete('/:id', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('驻留 ID 无效');
    const pre = await query('SELECT exhibit_id, hall_id FROM exhibit_residences WHERE id = $1', [id]);
    if (pre.rows.length === 0) throw new ValidationError('驻留记录不存在');
    const exhibitId = Number(pre.rows[0].exhibit_id);
    const hallId = Number(pre.rows[0].hall_id);

    await withOrderedKeyTransaction([`hall:${hallId}`, `exhibit:${exhibitId}`], async (client) => {
      await requireResidence(client, id);
      if (await isResidenceCovered(client, id)) {
        throw new ConflictError(
          `驻留 #${id} 已被共享照明归属覆盖，归属不得回改（不可修改/删除）`,
          { residenceId: id, coveredByLighting: true }
        );
      }
      await client.query('DELETE FROM exhibit_residences WHERE id = $1', [id]);
      await recordAudit(client, req.sessionUser, 'residence.delete', 'exhibit_residence', id, {
        exhibitId, hallId,
      });
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = { router, hallRouter, serializeResidence };
