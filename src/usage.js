'use strict';

/*
 * 年度占用的“按受影响自然年局部重算”统一机制。
 *
 * 所有会改变占用的操作（计划批准/取消/调整、实测确认/纠错、停灯、事故、
 * 共享照明归属、上限变更）都在原有的展品/展厅锁事务内、业务写入完成后调用
 * recomputeExhibitUsage：
 *   - 只重算本次变更受影响的自然年（跨年记录涉及的年份并集；作废/替换为旧新年份并集）；
 *   - 用与展品详情/审批试算/下调预演/账册封存/分级预警完全相同的来源与 round3 口径
 *     （computeOccupancy 的 scoped 计算）得到新占用，原子替换 annual_usage 中对应年份的行；
 *   - 顺带在同一事务内重算这些年份的分级预警边沿（向上跨档才留事件），
 *     多展品操作失败时事务回滚、占用结果与预警事件一并回滚；
 *   - 单次变更只读取受影响年份区间内的历史记录，不扫描无关年份的全部历史。
 *
 * 派生结果（annual_usage）可由 scripts/rebuild-usage.js 对既有数据全量重建：
 * 重建按展品逐个在事务内进行，任何错误都会抛出并回滚，绝不留下新旧占用混杂的状态。
 */

const { computeOccupancy, yearsToRanges } = require('./service');
const { round3 } = require('./dosing');

/**
 * 按统一口径重算指定年份的占用并原子落库（须在已持有展品行锁的事务内调用）。
 * 只写 annual_usage，不触碰预警；通常用 recomputeExhibitUsage（含预警边沿重算）。
 * 返回 scoped occupancy（sources/used/years 仅含 years 涉及的年份）。
 */
async function refreshUsageYears(client, exhibitId, years, { occupancy = null } = {}) {
  const yearList = [...new Set((years || []).map(Number))]
    .filter((y) => Number.isInteger(y))
    .sort((a, b) => a - b);
  if (yearList.length === 0) {
    return occupancy || (await computeOccupancy(client, exhibitId, { years: [] }));
  }
  const occ = occupancy || (await computeOccupancy(client, exhibitId, { years: yearList }));

  // 各组成部分从统一来源汇总（与 computeOccupancy 的来源顺序/口径一致）。
  for (const year of yearList) {
    const key = String(year);
    let confirmed = 0;
    let incident = 0;
    let shared = 0;
    let residue = 0;
    for (const s of occ.sources) {
      const dose = round3(s.yearly[key] || 0);
      if (dose === 0) continue;
      if (s.kind === 'measurement') confirmed = round3(confirmed + dose);
      else if (s.kind === 'incident') incident = round3(incident + dose);
      else if (s.kind === 'sharedLighting') shared = round3(shared + dose);
      else residue = round3(residue + dose);
    }
    const used = round3(occ.used[key] || 0);
    // 防御性校验：分部分合计必须等于总额（同为 round3 口径）；不一致直接报错，
    // 不把混杂结果写入派生表。
    const partsTotal = round3(confirmed + incident + shared + residue);
    if (Math.abs(partsTotal - used) > 0.005) {
      throw new Error(
        `展品 #${exhibitId} ${year} 年占用重算不一致：分部分合计 ${partsTotal} ≠ 总额 ${used}`
      );
    }
    await client.query(
      `INSERT INTO annual_usage
         (exhibit_id, year, used_lxh, confirmed_lxh, incident_lxh, shared_lxh, residue_lxh, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (exhibit_id, year) DO UPDATE
         SET used_lxh = EXCLUDED.used_lxh,
             confirmed_lxh = EXCLUDED.confirmed_lxh,
             incident_lxh = EXCLUDED.incident_lxh,
             shared_lxh = EXCLUDED.shared_lxh,
             residue_lxh = EXCLUDED.residue_lxh,
             updated_at = now()`,
      [exhibitId, year, used, confirmed, incident, shared, residue]
    );
  }
  return occ;
}

/**
 * 统一入口：在展品锁事务内重算受影响年份的派生占用 + 分级预警边沿。
 * options:
 *   actor    触发操作的操作者（预警事件 created_by）；
 *   trigger  { type, detail } 预警触发来源；
 *   occupancy 调用方已算好的占用（须与本次 years 同口径，通常不传）。
 * 返回 { occupancy, events }（events 为本事务内新产生的预警事件）。
 */
async function recomputeExhibitUsage(client, exhibitId, years, {
  actor = null,
  trigger = null,
  occupancy = null,
} = {}) {
  const yearList = [...new Set((years || []).map(Number))]
    .filter((y) => Number.isInteger(y))
    .sort((a, b) => a - b);
  const occ = await refreshUsageYears(client, exhibitId, yearList, { occupancy });
  let events = [];
  if (yearList.length > 0) {
    // 延迟 require 规避循环依赖（service -> routes 不经 usage；alerts -> service）。
    const alerts = require('./alerts');
    const out = await alerts.recomputeAlerts(client, exhibitId, {
      occupancy: occ,
      years: yearList,
      actor,
      trigger,
    });
    events = out.events;
  }
  return { occupancy: occ, events };
}

/** 读取 annual_usage 中某展品某年行（不存在返回 null）。 */
async function getUsageRow(client, exhibitId, year) {
  const { rows } = await client.query(
    'SELECT * FROM annual_usage WHERE exhibit_id = $1 AND year = $2',
    [exhibitId, year]
  );
  return rows[0] || null;
}

/** 读取某展品全部派生占用年份（按年升序）。 */
async function getUsageRows(client, exhibitId) {
  const { rows } = await client.query(
    'SELECT * FROM annual_usage WHERE exhibit_id = $1 ORDER BY year',
    [exhibitId]
  );
  return rows;
}

/**
 * 列出一件展品需要纳入重建的全部自然年：
 * 已登记上限年份、已确认实测/事故/共享照明归属年份、已批准/待复核计划开灯窗年份、
 * 已设置预警阈值年份的并集。
 */
async function yearsForRebuild(client, exhibitId) {
  const years = new Set();
  const addYearRows = (rows) => {
    for (const r of rows) years.add(Number(r.year));
  };
  addYearRows((await client.query(
    'SELECT year FROM annual_limits WHERE exhibit_id = $1', [exhibitId]
  )).rows);
  addYearRows((await client.query(
    'SELECT year FROM annual_quota_thresholds WHERE exhibit_id = $1', [exhibitId]
  )).rows);

  const { doseByYear } = require('./dosing');
  const addIntervalRows = (rows, luxCol) => {
    for (const r of rows) {
      const yearly = doseByYear(
        [{ start: new Date(r.start_ts).getTime(), end: new Date(r.end_ts).getTime() }],
        luxCol ? Number(r[luxCol]) : 1
      );
      for (const y of yearly.keys()) years.add(y);
    }
  };
  addIntervalRows((await client.query(
    `SELECT start_ts, end_ts FROM measurements
      WHERE exhibit_id = $1 AND status = 'confirmed'`, [exhibitId]
  )).rows);
  addIntervalRows((await client.query(
    'SELECT start_ts, end_ts FROM lighting_incidents WHERE exhibit_id = $1', [exhibitId]
  )).rows);
  addIntervalRows((await client.query(
    'SELECT start_ts, end_ts FROM shared_lighting_allocations WHERE exhibit_id = $1', [exhibitId]
  )).rows);

  const { buildWindows, yearMapToObject } = require('./dosing');
  const { parsePeriods } = require('./validation');
  const { dateYmd } = require('./service');
  const planRows = (await client.query(
    `SELECT * FROM plans WHERE exhibit_id = $1 AND status IN ('approved','pending_review')`,
    [exhibitId]
  )).rows;
  for (const plan of planRows) {
    let periods = plan.light_periods;
    if (typeof periods === 'string') periods = JSON.parse(periods);
    const windows = buildWindows(
      dateYmd(plan.start_date), dateYmd(plan.end_date), parsePeriods(periods)
    );
    const yearly = yearMapToObject(doseByYear(windows, Number(plan.estimated_lux)));
    for (const y of Object.keys(yearly)) years.add(Number(y));
  }

  return [...years].sort((a, b) => a - b);
}

/**
 * 全量重建一件展品的派生占用（须在已持有展品行锁的事务内调用）：
 * 删除该展品全部旧 annual_usage 行后，按统一口径对所有相关自然年逐批写回，
 * 并把分级预警阈值行的 last_used_lxh / last_level 同步为最新值（不补发历史事件）。
 * 任一年份不一致即抛错，由调用方事务回滚——绝不留下新旧占用混杂的结果。
 * 返回 { exhibitId, years }。
 */
async function rebuildExhibitUsage(client, exhibitId) {
  const service = require('./service');
  const alerts = require('./alerts');
  await service.lockExhibit(client, exhibitId);
  const years = await yearsForRebuild(client, exhibitId);

  await client.query('DELETE FROM annual_usage WHERE exhibit_id = $1', [exhibitId]);

  // 分批按年重算（每批不超过 40 个年份，保持“按年局部计算”的读取范围；年份通常很少）。
  const BATCH = 40;
  for (let i = 0; i < years.length; i += BATCH) {
    await refreshUsageYears(client, exhibitId, years.slice(i, i + BATCH));
  }

  // 同步预警阈值行的最近占用/级别（不补发事件）。
  if (years.length > 0) {
    const occ = await service.computeOccupancy(client, exhibitId);
    const thresholdRows = await client.query(
      'SELECT * FROM annual_quota_thresholds WHERE exhibit_id = $1 ORDER BY year',
      [exhibitId]
    );
    for (const row of thresholdRows.rows) {
      const info = occ.years[String(Number(row.year))];
      const used = info ? round3(info.used) : 0;
      const limit = info && info.limit !== null && info.limit !== undefined
        ? round3(info.limit) : null;
      const level = alerts.levelOf({
        used,
        limit,
        lowPct: Number(row.low_pct),
        highPct: Number(row.high_pct),
      });
      await client.query(
        `UPDATE annual_quota_thresholds
            SET last_used_lxh = $3, last_level = $4
          WHERE id = $1 AND exhibit_id = $2`,
        [row.id, exhibitId, used, level]
      );
    }
  }

  // 校验：annual_usage 行数应等于相关年份数（重建失败立即报错，不留下半新半旧结果）。
  const { rows: countRows } = await client.query(
    'SELECT COUNT(*)::int AS n FROM annual_usage WHERE exhibit_id = $1',
    [exhibitId]
  );
  if (Number(countRows[0].n) !== years.length) {
    throw new Error(
      `展品 #${exhibitId} 占用重建结果不完整：期望 ${years.length} 年，实际 ${countRows[0].n} 年`
    );
  }
  return { exhibitId, years };
}

module.exports = {
  yearsToRanges,
  refreshUsageYears,
  recomputeExhibitUsage,
  rebuildExhibitUsage,
  getUsageRow,
  getUsageRows,
  yearsForRebuild,
};
