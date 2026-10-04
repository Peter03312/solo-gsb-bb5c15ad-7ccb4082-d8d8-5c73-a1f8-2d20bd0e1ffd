'use strict';

const {
  ValidationError,
  ConflictError,
  parsePeriods,
  assertDate,
  positiveNumber,
  nonEmptyString,
} = require('./validation');
const { recordAudit } = require('./audit');
const {
  buildWindows,
  doseByYear,
  subtractIntervals,
  yearMapToObject,
  addYearDose,
  intersects,
  containsInterval,
  anyIntersect,
  clipIntervalToWindows,
  round3,
  wallToTs,
  tsToWallString,
  yearOfTs,
} = require('./dosing');
const config = require('./config');

const ACTIVE_PLAN_STATUSES = ['approved', 'pending_review'];
const PENDING_ADJUSTMENT = 'pending';

/**
 * 一组自然年 -> 覆盖它们的连续 [startMs, endMs) 时间区间列表（墙上年界）。
 * 按年局部重算用它把历史记录的读取限定在受影响年份内，避免扫描无关年份的全部历史。
 * 端点按毫秒取整（年界本身为整点），跨年纪录只要与某年有交集就会落入对应区间。
 */
function yearsToRanges(years) {
  const sorted = [...new Set(years.map(Number))].filter((y) => Number.isInteger(y)).sort((a, b) => a - b);
  const ranges = [];
  let runStart = null;
  let prev = null;
  const yearStartMs = (y) => Date.UTC(y, 0, 1) - config.tzOffsetMs;
  for (const y of sorted) {
    if (runStart === null) {
      runStart = y;
    } else if (y !== prev + 1) {
      ranges.push({ startMs: yearStartMs(runStart), endMs: yearStartMs(prev + 1) });
      runStart = y;
    }
    prev = y;
  }
  if (runStart !== null) ranges.push({ startMs: yearStartMs(runStart), endMs: yearStartMs(prev + 1) });
  return ranges;
}

/** 时间区间（毫秒）按墙上自然年拆分涉及的年份集合（左闭右开）。 */
function yearsOfInterval(startMs, endMs) {
  return new Set(doseByYear([{ start: startMs, end: endMs }], 1).keys());
}

/** 多段区间涉及年份的并集。 */
function yearsOfIntervals(intervals) {
  const years = new Set();
  for (const it of intervals || []) {
    for (const y of yearsOfInterval(it.start, it.end)) years.add(y);
  }
  return years;
}

/**
 * 由 bounds（{startMs,endMs} 连续年区间列表）构造 SQL 的 OR 相交子句与绑定参数。
 * 表别名/列名由调用方以固定字符串给出（非用户输入），值追加到 params 并返回占位片段。
 * intersects: start_col < rangeEnd AND end_col > rangeStart（左闭右开，端点相接不算）。
 */
function buildRangeClauses(ranges, startCol, endCol, params) {
  if (!ranges || ranges.length === 0) return null;
  const clauses = [];
  for (const r of ranges) {
    const i = params.length + 1;
    const j = params.length + 2;
    params.push(new Date(r.startMs), new Date(r.endMs));
    clauses.push(`(${startCol} < $${j} AND ${endCol} > $${i})`);
  }
  return clauses.join(' OR ');
}

/** 规范化 DATE 值：真实 pg 经类型解析返回 'YYYY-MM-DD'；个别驱动（如内存测试）可能给 Date。 */
function dateYmd(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate()
    ).padStart(2, '0')}`;
  }
  return v;
}

/** 读取展品（可加行锁，事务内批准/确认时使用）。 */
async function lockExhibit(client, exhibitId) {
  const { rows } = await client.query('SELECT * FROM exhibits WHERE id = $1 FOR UPDATE', [exhibitId]);
  if (rows.length === 0) throw new ValidationError('展品不存在');
  return rows[0];
}

async function getPlan(client, planId) {
  const { rows } = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
  if (rows.length === 0) throw new ValidationError('计划不存在');
  return rows[0];
}

/**
 * 取该展品占用额度的计划（已批准、待复核）。excludePlanId 用于把待批计划自身排除。
 * bounds 为 yearsToRanges 的结果时，只返回展期日期与任一受影响年份区间相交的计划
 * （跨年计划的相关年份由后续窗口拆分处理），避免按年局部重算时读取无关年份的全部计划。
 */
async function getOccupyingPlans(client, exhibitId, excludePlanId = null, bounds = null) {
  // 状态为模块内固定白名单，直接内联到 SQL（避免不同驱动对 ANY($) 数组绑定的差异）
  const statusList = ACTIVE_PLAN_STATUSES.map((s) => `'${s}'`).join(',');
  const params = [exhibitId, excludePlanId];
  // 展期按整日（墙上年界也对齐到 00:00）相交：start_date < 区间末年 且 end_date >= 区间首年
  // （DATE 与时间戳比较在 pg-mem 上不稳妥，这里取出后在 JS 侧按日期过滤）。
  const { rows } = await client.query(
    `SELECT * FROM plans
      WHERE exhibit_id = $1 AND status IN (${statusList})
        AND ($2::bigint IS NULL OR id <> $2)
      ORDER BY id`,
    params
  );
  if (!bounds || bounds.length === 0) return rows;
  return rows.filter((plan) => {
    const windows = planWindows(plan);
    return windows.some((w) =>
      bounds.some((r) => w.start < r.endMs && r.startMs < w.end)
    );
  });
}

/**
 * 取已确认实测；bounds 非空时只取与受影响年份区间相交的记录
 * （一条跨年实测会被各相关年份的重算各自读取，剂量按年拆分后只保留该年部分）。
 */
async function getActiveMeasurements(client, exhibitId, bounds = null) {
  const params = [exhibitId];
  let rangeSql = '';
  if (bounds && bounds.length > 0) {
    const clause = buildRangeClauses(bounds, 'm.start_ts', 'm.end_ts', params);
    rangeSql = ` AND (${clause})`;
  }
  const { rows } = await client.query(
    `SELECT m.*, p.status AS plan_status
       FROM measurements m JOIN plans p ON p.id = m.plan_id
      WHERE m.exhibit_id = $1 AND m.status = 'confirmed'${rangeSql}
      ORDER BY m.start_ts`,
    params
  );
  return rows;
}

function planWindows(plan) {
  return buildWindows(dateYmd(plan.start_date), dateYmd(plan.end_date), parsePeriods(normalizePeriods(plan.light_periods)));
}

/** JSONB 开灯时段：真实 pg 驱动返回数组，个别驱动（如内存测试）返回字符串，统一成数组。 */
function normalizePeriods(value) {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (_) {
      throw new ValidationError('开灯时段数据格式无效');
    }
  }
  return value;
}

/**
 * 读取展品的全部停灯记录（永久保留，计划已取消/驳回也带出），附计划字段供按窗计算。
 * 仅 planId 过滤时返回该计划的停灯（用于调整核对窗外判定）。
 * 注意：拆成多条简单查询而非 JOIN —— 个别内存驱动（pg-mem）对多表 JOIN 的实现有缺陷。
 */
async function getBlackoutRows(client, exhibitId, { planId = null, bounds = null } = {}) {
  const params = [exhibitId, planId];
  let rangeSql = '';
  if (bounds && bounds.length > 0) {
    const clause = buildRangeClauses(bounds, 'start_ts', 'end_ts', params);
    rangeSql = ` AND (${clause})`;
  }
  const { rows } = await client.query(
    `SELECT * FROM blackouts
      WHERE exhibit_id = $1
        AND ($2::bigint IS NULL OR plan_id = $2)${rangeSql}
      ORDER BY start_ts, id`,
    params
  );
  if (rows.length === 0) return rows;
  const planIds = [...new Set(rows.map((r) => Number(r.plan_id)))];
  const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: planRows } = await client.query(
    `SELECT id, title, status, start_date, end_date, light_periods, estimated_lux
       FROM plans WHERE id IN (${placeholders})`,
    planIds
  );
  const planById = new Map(planRows.map((p) => [Number(p.id), p]));
  const userIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length > 0) {
    const uph = userIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: userRows } = await client.query(
      `SELECT id, display_name FROM users WHERE id IN (${uph})`,
      userIds
    );
    for (const u of userRows) userMap.set(Number(u.id), u.display_name);
  }
  return rows.map((row) => {
    const p = planById.get(Number(row.plan_id));
    return {
      ...row,
      plan_title: p ? p.title : null,
      plan_status: p ? p.status : null,
      plan_start_date: p ? p.start_date : null,
      plan_end_date: p ? p.end_date : null,
      plan_light_periods: p ? p.light_periods : null,
      plan_estimated_lux: p ? p.estimated_lux : null,
      creator_name: row.created_by ? userMap.get(Number(row.created_by)) || null : null,
    };
  });
}

/**
 * 一条停灯记录“从估算中实际扣减”的有效时间窗：
 *   停灯区间 ∩ 所属计划开灯窗 − 同展品全部已确认实测覆盖。
 * 口径：停灯只从所属计划未被已确认实测覆盖的估算时段扣除；与实测相交的部分（业务上互斥，
 * 此处为防御性处理）不扣估算（该部分由实测计量）。
 */
function effectiveBlackoutWindows(row, planWindowsById, confirmedWindows) {
  const windows = planWindowsById.get(Number(row.plan_id)) || [];
  const clipped = clipIntervalToWindows(
    { start: new Date(row.start_ts).getTime(), end: new Date(row.end_ts).getTime() },
    windows
  );
  return subtractIntervals(clipped, confirmedWindows);
}

/**
 * 构造展品停灯视图：每条记录附按年扣减量（按其所属计划预计照度，按自然年拆分）。
 * 返回 { items, windowsByPlan: Map<planId, [{start,end}有效扣减窗]>,
 *        totalDeductionYearly: {year: dose} }
 *
 * 口径说明：
 *  - 停灯记录永久保留；所属计划已不再占用（取消/驳回）时，记录照常列出并给出“若按当前计划窗
    *    计算的名义扣减量”，但 isActive=false 且不计入 totalDeductionYearly（computeOccupancy 本就
    *    不含这些计划的估算残余）。
 *  - confirmedRows: 该展品已确认实测行（默认自行查询）。
 */
async function loadBlackoutView(client, exhibitId, { confirmedRows = null, bounds = null } = {}) {
  const rows = await getBlackoutRows(client, exhibitId, { bounds });
  const activePlans = await getOccupyingPlans(client, exhibitId, null, bounds);
  const activeIds = new Set(activePlans.map((p) => Number(p.id)));
  const measurements = confirmedRows || (await getActiveMeasurements(client, exhibitId));
  const confirmedWindows = measurements.map((m) => ({
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));

  // 以记录联表的计划字段构造计划窗（含已取消计划，便于给出名义扣减量）
  const planWindowsById = new Map();
  const planLuxById = new Map();
  for (const row of rows) {
    const pid = Number(row.plan_id);
    if (!planWindowsById.has(pid)) {
      planWindowsById.set(pid, buildWindows(
        dateYmd(row.plan_start_date),
        dateYmd(row.plan_end_date),
        parsePeriods(normalizePeriods(row.plan_light_periods))
      ));
      planLuxById.set(pid, Number(row.plan_estimated_lux));
    }
  }

  const windowsByPlan = new Map();
  const totalDeductionYearly = {};
  const items = rows.map((row) => {
    const pid = Number(row.plan_id);
    const eff = effectiveBlackoutWindows(row, planWindowsById, confirmedWindows);
    const yearly = yearMapToObject(doseByYear(eff, planLuxById.get(pid)));
    const isActive = activeIds.has(pid);
    if (isActive) {
      if (!windowsByPlan.has(pid)) windowsByPlan.set(pid, []);
      windowsByPlan.get(pid).push(...eff);
      addYearDose(totalDeductionYearly, yearly);
    }
    return {
      id: row.id,
      planId: pid,
      exhibitId: Number(row.exhibit_id),
      planTitle: row.plan_title,
      planStatus: row.plan_status,
      start: tsToWallString(new Date(row.start_ts).getTime()),
      end: tsToWallString(new Date(row.end_ts).getTime()),
      reason: row.reason,
      createdBy: row.created_by,
      creatorName: row.creator_name || null,
      createdAt: row.created_at,
      yearly,
      deductionActive: isActive,
    };
  });

  return { items, windowsByPlan, totalDeductionYearly };
}

/** 取同展品与给定区间相交的未作废实测（含待确认草稿），排除 excludeId。 */
async function findOverlappingMeasurement(client, exhibitId, startMs, endMs, excludeId = null) {
  const { rows } = await client.query(
    `SELECT id, start_ts, end_ts FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  return rows[0] || null;
}

/** 取同展品与给定区间相交的其他停灯记录（停灯永久保留，无作废状态），排除 excludeId。 */
async function findOverlappingBlackout(client, exhibitId, startMs, endMs, excludeId = null) {
  // 不使用 JOIN：个别内存驱动（pg-mem）对 JOIN + 时间不等式组合的实现有缺陷
  const { rows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts FROM blackouts
      WHERE exhibit_id = $1
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  return rows[0] || null;
}

/**
 * 取同展品与给定区间相交的其他计划外照明事故（事故永久保留，无作废状态），排除 excludeId。
 * 事故与未作废实测（含草稿）、停灯、其他事故均互斥。
 */
async function findOverlappingIncident(client, exhibitId, startMs, endMs, excludeId = null) {
  const { rows } = await client.query(
    `SELECT id, start_ts, end_ts, reason FROM lighting_incidents
      WHERE exhibit_id = $1
        AND ($4::bigint IS NULL OR id <> $4)
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs), excludeId]
  );
  return rows[0] || null;
}

/**
 * 取同展品与给定区间相交的共享照明归属窗（归属永久保留，无作废状态）。
 * 返回首条相交归属（含共享照明编号、展厅标识）；后续实测/停灯/事故/纠错碰到共享照明时段一律拒绝。
 */
async function findOverlappingSharedLighting(client, exhibitId, startMs, endMs) {
  const { rows } = await client.query(
    `SELECT a.id AS allocation_id, a.session_id, a.start_ts, a.end_ts, h.hall_code
       FROM shared_lighting_allocations a
       JOIN shared_lightings s ON s.id = a.session_id
       JOIN halls h ON h.id = s.hall_id
      WHERE a.exhibit_id = $1
        AND a.start_ts < $3 AND a.end_ts > $2
      ORDER BY a.id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs)]
  );
  return rows[0] || null;
}

/**
 * 取同展品与给定区间相交的全部共享照明归属（供一次性列出全部冲突）。
 * 返回 [{allocationId, sessionId, hallCode, start, end}]（毫秒）。
 */
async function findOverlappingSharedLightings(client, exhibitId, startMs, endMs) {
  const { rows } = await client.query(
    `SELECT a.id AS allocation_id, a.session_id, a.start_ts, a.end_ts, h.hall_code
       FROM shared_lighting_allocations a
       JOIN shared_lightings s ON s.id = a.session_id
       JOIN halls h ON h.id = s.hall_id
      WHERE a.exhibit_id = $1
        AND a.start_ts < $3 AND a.end_ts > $2
      ORDER BY a.id`,
    [exhibitId, new Date(startMs), new Date(endMs)]
  );
  return rows.map((r) => ({
    allocationId: Number(r.allocation_id),
    sessionId: Number(r.session_id),
    hallCode: r.hall_code,
    start: new Date(r.start_ts).getTime(),
    end: new Date(r.end_ts).getTime(),
  }));
}

/**
 * 读取一件展品的全部驻留记录（按开始时刻），附展厅标识。
 */
async function getResidenceRows(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT r.*, h.hall_code
       FROM exhibit_residences r JOIN halls h ON h.id = r.hall_id
      WHERE r.exhibit_id = $1
      ORDER BY r.start_ts, r.id`,
    [exhibitId]
  );
  return rows;
}

/**
 * 构造展品驻留视图：逐条驻留附展厅标识、按年驻留时长，及 covered（是否已被共享照明归属覆盖）。
 * 已被照明覆盖的驻留不得回改（由修改/删除接口据此拒绝）。
 */
async function loadResidenceView(client, exhibitId) {
  const rows = await getResidenceRows(client, exhibitId);
  if (rows.length === 0) return { items: [], windows: [] };
  const ids = rows.map((r) => Number(r.id));
  const ph = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows: covRows } = await client.query(
    `SELECT DISTINCT residence_id FROM shared_lighting_allocations WHERE residence_id IN (${ph})`,
    ids
  );
  const coveredIds = new Set(covRows.map((r) => Number(r.residence_id)));
  const windows = [];
  const items = rows.map((row) => {
    const seg = { start: new Date(row.start_ts).getTime(), end: new Date(row.end_ts).getTime() };
    windows.push({ ...seg, id: Number(row.id), hallCode: row.hall_code });
    return {
      id: Number(row.id),
      exhibitId: Number(row.exhibit_id),
      hallId: Number(row.hall_id),
      hallCode: row.hall_code,
      start: tsToWallString(seg.start),
      end: tsToWallString(seg.end),
      createdBy: row.created_by,
      createdAt: row.created_at,
      covered: coveredIds.has(Number(row.id)),
    };
  });
  return { items, windows };
}

/**
 * 按展厅标识读取展厅（不存在返回 null）。
 */
async function getHallByCode(client, hallCode) {
  const { rows } = await client.query('SELECT * FROM halls WHERE hall_code = $1', [hallCode]);
  return rows[0] || null;
}

/** 读取展厅（不存在返回 null）。 */
async function getHallById(client, hallId) {
  const { rows } = await client.query('SELECT * FROM halls WHERE id = $1', [hallId]);
  return rows[0] || null;
}

/**
 * 取展厅在给定区间内驻留的展品驻留行（与区间相交），用于共享照明归属切分。
 * 返回行附 hall_code。
 */
async function getResidencesIntersecting(client, hallId, startMs, endMs) {
  const { rows } = await client.query(
    `SELECT r.*, h.hall_code
       FROM exhibit_residences r JOIN halls h ON h.id = r.hall_id
      WHERE r.hall_id = $1
        AND r.start_ts < $3 AND r.end_ts > $2
      ORDER BY r.start_ts, r.id`,
    [hallId, new Date(startMs), new Date(endMs)]
  );
  return rows;
}

/**
 * 登记驻留（由路由在已持有展品行锁/展厅锁的事务内调用）：
 *  - 正时长；同展品驻留区间不得重叠（端点相接不算重叠，排除自身 excludeId）。
 * 返回插入的驻留行。
 */
async function registerResidence(client, { exhibitId, hallId, startMs, endMs }, actor) {
  if (!(endMs > startMs)) throw new ValidationError('驻留结束必须晚于开始');
  const { rows: clashRows } = await client.query(
    `SELECT id FROM exhibit_residences
      WHERE exhibit_id = $1 AND start_ts < $3 AND end_ts > $2
      ORDER BY id
      LIMIT 1`,
    [exhibitId, new Date(startMs), new Date(endMs)]
  );
  if (clashRows.length > 0) {
    throw new ConflictError(
      `该展品已有驻留 #${clashRows[0].id} 与本驻留区间重叠，单件展品的驻留区间不得重叠`,
      { overlappingResidenceId: Number(clashRows[0].id) }
    );
  }
  const inserted = await client.query(
    `INSERT INTO exhibit_residences (exhibit_id, hall_id, start_ts, end_ts, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [exhibitId, hallId, new Date(startMs), new Date(endMs), actor.userId]
  );
  return inserted.rows[0];
}

/**
 * 校验并登记一次共享照明（规则 19，由路由在已按序持有展厅锁与各展品行锁的事务内调用）：
 *  - 起点早于终点、结束不晚于当前时间（只登记已发生照明）、实际照度为正、原因必填（400，
 *    路由层先行校验，这里防御性复核）；
 *  - 按与各驻留区间的交集归属各展品并跨自然年拆分；
 *  - 与任一归属展品的未作废实测（含草稿）、停灯、已有照明事故相交 → 整次拒绝（409，
 *    details 按展品分组一次性列出全部冲突，不保存）；
 *  - 无任何展品驻留交集 → 拒绝（409）。
 * 返回 { session, allocations }；allocations 元素
 *   { exhibitId, residenceId, start, end（毫秒）, residenceStart, residenceEnd, yearly }。
 */
async function registerSharedLighting(client, { hallId, startMs, endMs, actualLux, reason }, actor) {
  if (!(endMs > startMs)) throw new ValidationError('共享照明起点须早于终点');
  const nowMs = Date.now();
  if (endMs > nowMs) {
    throw new ValidationError(
      `共享照明结束时刻（${tsToWallString(endMs)}）晚于当前时间，只能登记已发生的照明`
    );
  }
  const reasonText = nonEmptyString(reason, '共享照明原因', 1000);
  const lux = positiveNumber(actualLux, '共享照明实际照度（lx）', { max: 1000000 });

  const sessionSeg = { start: startMs, end: endMs };
  const residenceRows = await getResidencesIntersecting(client, hallId, startMs, endMs);
  if (residenceRows.length === 0) {
    throw new ValidationError(
      `共享照明时段 ${tsToWallString(startMs)} ~ ${tsToWallString(endMs)} ` +
      '与该展厅任何展品的驻留区间都没有交集，无法归属，已拒绝'
    );
  }

  // 归属切分：照明窗 ∩ 各驻留区间（端点相接不算）。同一展品驻留互不重叠。
  const allocations = [];
  for (const res of residenceRows) {
    const resSeg = {
      start: new Date(res.start_ts).getTime(),
      end: new Date(res.end_ts).getTime(),
    };
    const parts = clipIntervalToWindows(sessionSeg, [resSeg]);
    for (const part of parts) {
      allocations.push({
        exhibitId: Number(res.exhibit_id),
        residenceId: Number(res.id),
        start: part.start,
        end: part.end,
      });
    }
  }
  allocations.sort((a, b) => a.exhibitId - b.exhibitId || a.start - b.start || a.residenceId - b.residenceId);

  // 冲突按展品分组一次性收集：未作废实测（含草稿）、停灯、照明事故
  const byExhibit = new Map();
  for (const alloc of allocations) {
    if (!byExhibit.has(alloc.exhibitId)) byExhibit.set(alloc.exhibitId, []);
    byExhibit.get(alloc.exhibitId).push(alloc);
  }

  // 计划标题（冲突消息用）
  const titleMap = new Map();
  const conflictsByExhibit = {};
  const messageParts = [];
  for (const [exhibitId, allocs] of byExhibit) {
    const overlappingMeasurements = [];
    const overlappingBlackouts = [];
    const overlappingIncidents = [];
    for (const alloc of allocs) {
      const { rows: measRows } = await client.query(
        `SELECT id, plan_id, start_ts, end_ts, status
           FROM measurements
          WHERE exhibit_id = $1 AND status <> 'annulled'
            AND start_ts < $3 AND end_ts > $2
          ORDER BY id`,
        [exhibitId, new Date(alloc.start), new Date(alloc.end)]
      );
      for (const m of measRows) {
        overlappingMeasurements.push({
          id: m.id,
          planId: m.plan_id,
          status: m.status,
          start: tsToWallString(new Date(m.start_ts).getTime()),
          end: tsToWallString(new Date(m.end_ts).getTime()),
        });
      }
      const { rows: blackoutRows } = await client.query(
        `SELECT id, plan_id, start_ts, end_ts FROM blackouts
          WHERE exhibit_id = $1
            AND start_ts < $3 AND end_ts > $2
          ORDER BY id`,
        [exhibitId, new Date(alloc.start), new Date(alloc.end)]
      );
      for (const b of blackoutRows) {
        overlappingBlackouts.push({
          id: b.id,
          planId: b.plan_id,
          start: tsToWallString(new Date(b.start_ts).getTime()),
          end: tsToWallString(new Date(b.end_ts).getTime()),
        });
      }
      const { rows: incidentRows } = await client.query(
        `SELECT id, start_ts, end_ts FROM lighting_incidents
          WHERE exhibit_id = $1
            AND start_ts < $3 AND end_ts > $2
          ORDER BY id`,
        [exhibitId, new Date(alloc.start), new Date(alloc.end)]
      );
      for (const x of incidentRows) {
        overlappingIncidents.push({
          id: x.id,
          start: tsToWallString(new Date(x.start_ts).getTime()),
          end: tsToWallString(new Date(x.end_ts).getTime()),
        });
      }
    }
    const dedupe = (arr, keyFn) => {
      const seen = new Set();
      return arr.filter((x) => {
        const k = keyFn(x);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    };
    const mm = dedupe(overlappingMeasurements, (x) => x.id);
    const bb = dedupe(overlappingBlackouts, (x) => x.id);
    const xx = dedupe(overlappingIncidents, (x) => x.id);
    if (mm.length === 0 && bb.length === 0 && xx.length === 0) continue;

    // 补计划标题
    for (const b of bb) {
      if (!titleMap.has(Number(b.planId))) {
        const t = await client.query('SELECT title FROM plans WHERE id = $1', [b.planId]);
        titleMap.set(Number(b.planId), t.rows[0] ? t.rows[0].title : null);
      }
      b.planTitle = titleMap.get(Number(b.planId)) || null;
    }
    conflictsByExhibit[String(exhibitId)] = {
      exhibitId,
      overlappingMeasurements: mm,
      overlappingBlackouts: bb,
      overlappingIncidents: xx,
    };
    for (const m of mm) {
      messageParts.push(`展品 #${exhibitId}：与${m.status === 'draft' ? '待确认' : '已确认'}` +
        `实测 #${m.id}（${m.start} ~ ${m.end}）相交`);
    }
    for (const b of bb) {
      messageParts.push(`展品 #${exhibitId}：与停灯记录 #${b.id}（计划「${b.planTitle}」，` +
        `${b.start} ~ ${b.end}）相交`);
    }
    for (const x of xx) {
      messageParts.push(`展品 #${exhibitId}：与计划外照明事故 #${x.id}（${x.start} ~ ${x.end}）相交`);
    }
  }

  if (messageParts.length > 0) {
    throw new ConflictError(
      `共享照明登记失败：${messageParts.join('；')}，整次登记未保存`,
      { conflictsByExhibit }
    );
  }

  const inserted = await client.query(
    `INSERT INTO shared_lightings (hall_id, start_ts, end_ts, actual_lux, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [hallId, new Date(startMs), new Date(endMs), lux, reasonText, actor.userId]
  );
  const session = inserted.rows[0];
  for (const alloc of allocations) {
    const ins = await client.query(
      `INSERT INTO shared_lighting_allocations
         (session_id, residence_id, exhibit_id, start_ts, end_ts, actual_lux)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [session.id, alloc.residenceId, alloc.exhibitId,
        new Date(alloc.start), new Date(alloc.end), lux]
    );
    alloc.id = Number(ins.rows[0].id);
    alloc.yearly = yearMapToObject(doseByYear([{ start: alloc.start, end: alloc.end }], lux));
  }
  return { session, allocations };
}

/** 读取展品全部计划外照明事故（永久保留），按开始时刻排序。bounds 非空时只取与受影响年份相交的。 */
async function getIncidentRows(client, exhibitId, bounds = null) {
  const params = [exhibitId];
  let rangeSql = '';
  if (bounds && bounds.length > 0) {
    const clause = buildRangeClauses(bounds, 'i.start_ts', 'i.end_ts', params);
    rangeSql = ` AND (${clause})`;
  }
  const { rows } = await client.query(
    `SELECT i.*, u.display_name AS creator_name
       FROM lighting_incidents i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.exhibit_id = $1${rangeSql}
      ORDER BY i.start_ts, i.id`,
    params
  );
  return rows;
}

/**
 * 构造展品计划外照明事故视图：
 * 返回 { items, windows }。
 *  - windows：全部事故区间 [{start,end,lux,id}]（事故实际用光窗，供计划残余扣除窗内相交部分）；
 *  - items：逐条事故对外字段，附
 *      yearly        该事故实际用光按年剂量（事故剂量始终全额计入实际用光）；
 *      yearlyInside  与当前已批准/待复核计划开灯窗相交部分的按年剂量（替代计划估算）；
 *      yearlyOutside 窗外部分的按年剂量（窗外单独计量）；
 *      insidePlanIds 相交到的计划编号。
 * 事故不可改删；计划取消后相交部分不再有计划残余可替代，窗外/窗内划分按当前占用计划重算，
 * 事故全额剂量（yearly）不变、仍计入实际用光。
 */
async function loadIncidentView(client, exhibitId, { bounds = null } = {}) {
  const rows = await getIncidentRows(client, exhibitId, bounds);
  if (rows.length === 0) return { items: [], windows: [] };

  const activePlans = await getOccupyingPlans(client, exhibitId, null, bounds);
  const planWindowList = [];
  for (const plan of activePlans) {
    for (const w of planWindows(plan)) {
      planWindowList.push({ ...w, planId: Number(plan.id) });
    }
  }

  const windows = [];
  const items = rows.map((row) => {
    const seg = { start: new Date(row.start_ts).getTime(), end: new Date(row.end_ts).getTime() };
    windows.push({ ...seg, lux: Number(row.actual_lux), id: Number(row.id) });
    const lux = Number(row.actual_lux);
    const insideParts = clipIntervalToWindows(seg, planWindowList);
    const outsideParts = subtractIntervals([seg], insideParts);
    const insidePlanIds = [...new Set(
      planWindowList
        .filter((w) => intersects(w, seg))
        .map((w) => w.planId)
    )].sort((a, b) => a - b);
    return {
      id: Number(row.id),
      exhibitId: Number(row.exhibit_id),
      start: tsToWallString(seg.start),
      end: tsToWallString(seg.end),
      actualLux: lux,
      reason: row.reason,
      createdBy: row.created_by,
      creatorName: row.creator_name || null,
      createdAt: row.created_at,
      yearly: yearMapToObject(doseByYear([seg], lux)),
      yearlyInside: yearMapToObject(doseByYear(insideParts, lux)),
      yearlyOutside: yearMapToObject(doseByYear(outsideParts, lux)),
      insidePlanIds,
    };
  });

  return { items, windows };
}

/** 读取展品全部共享照明归属（永久保留），按归属开始时刻排序。 */
async function getSharedLightingAllocationRows(client, exhibitId, bounds = null) {
  // 拆成多条简单查询而非 JOIN —— 个别内存驱动（pg-mem）对多表 JOIN 的实现有缺陷。
  const params = [exhibitId];
  let rangeSql = '';
  if (bounds && bounds.length > 0) {
    const clause = buildRangeClauses(bounds, 'start_ts', 'end_ts', params);
    rangeSql = ` AND (${clause})`;
  }
  const { rows: allocRows } = await client.query(
    `SELECT * FROM shared_lighting_allocations
      WHERE exhibit_id = $1${rangeSql}
      ORDER BY start_ts, id`,
    params
  );
  if (allocRows.length === 0) return [];
  const sessionIds = [...new Set(allocRows.map((r) => Number(r.session_id)))];
  const resIds = [...new Set(allocRows.map((r) => Number(r.residence_id)))];
  let ph = sessionIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: sessionRows } = await client.query(
    `SELECT s.*, h.hall_code
       FROM shared_lightings s JOIN halls h ON h.id = s.hall_id
      WHERE s.id IN (${ph})`,
    sessionIds
  );
  const sessions = new Map(sessionRows.map((s) => [Number(s.id), s]));
  ph = resIds.map((_, i) => `$${i + 1}`).join(',');
  const { rows: resRows } = await client.query(
    `SELECT id, hall_id, start_ts, end_ts FROM exhibit_residences WHERE id IN (${ph})`,
    resIds
  );
  const residences = new Map(resRows.map((r) => [Number(r.id), r]));
  const userIds = [...new Set(sessionRows.map((s) => s.created_by).filter(Boolean))];
  const userMap = new Map();
  if (userIds.length > 0) {
    const uph = userIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: userRows } = await client.query(
      `SELECT id, display_name FROM users WHERE id IN (${uph})`,
      userIds
    );
    for (const u of userRows) userMap.set(Number(u.id), u.display_name);
  }
  return allocRows.map((row) => ({
    ...row,
    session: sessions.get(Number(row.session_id)) || null,
    residence: residences.get(Number(row.residence_id)) || null,
    creator_name: row.creator_name || null,
  }));
}

/**
 * 构造展品共享照明视图（规则 19）：
 * 返回 { items, windows }。
 *  - windows：该展品全部共享照明归属窗 [{start,end,lux,id}]（始终以共享照明实际照度
 *    全额计入实际用光，供计划残余扣除窗内相交部分）；
 *  - items：逐条共享照明（按 session 聚合所有归属段），附
 *      yearly         该次共享照明归属本展品的实际用光按年剂量（始终全额）；
 *      yearlyInside   与当前已批准/待复核计划开灯窗相交部分（替代计划估算）；
 *      yearlyOutside  窗外部分（窗外单独计量）；
 *      insidePlanIds  相交到的计划编号；
 *      allocations    各归属段（驻留编号、起止、按年剂量）。
 * 与事故视图同构；驻留/计划变化后窗内/窗外按当前占用计划重算，yearly 不变。
 */
async function loadSharedLightingView(client, exhibitId, { bounds = null } = {}) {
  const rows = await getSharedLightingAllocationRows(client, exhibitId, bounds);
  if (rows.length === 0) return { items: [], windows: [] };

  const activePlans = await getOccupyingPlans(client, exhibitId, null, bounds);
  const planWindowList = [];
  for (const plan of activePlans) {
    for (const w of planWindows(plan)) {
      planWindowList.push({ ...w, planId: Number(plan.id) });
    }
  }

  const windows = [];
  const bySession = new Map();
  for (const row of rows) {
    const seg = { start: new Date(row.start_ts).getTime(), end: new Date(row.end_ts).getTime() };
    windows.push({ ...seg, lux: Number(row.actual_lux), id: Number(row.id) });
    if (!bySession.has(Number(row.session_id))) bySession.set(Number(row.session_id), []);
    bySession.get(Number(row.session_id)).push({ row, seg });
  }

  const userIds = [...new Set(
    [...bySession.values()]
      .map((group) => group[0].row.session && group[0].row.session.created_by)
      .filter(Boolean)
  )];
  const creatorMap = new Map();
  if (userIds.length > 0) {
    const uph = userIds.map((_, i) => `$${i + 1}`).join(',');
    const { rows: userRows } = await client.query(
      `SELECT id, display_name FROM users WHERE id IN (${uph})`,
      userIds
    );
    for (const u of userRows) creatorMap.set(Number(u.id), u.display_name);
  }

  const items = [];
  for (const [sessionId, group] of bySession) {
    const first = group[0].row;
    const session = first.session;
    const segs = group.map((g) => g.seg);
    // 同一驻留/不同驻留的归属段互不相交（驻留同展品不重叠）；合并以防端点相邻。
    const allParts = subtractIntervals(segs, []);
    const insideParts = clipIntervalToWindowsForPlan(planWindowList, segs.map((s) => ({ ...s })));
    const outsideParts = subtractIntervals(allParts, insideParts);
    const insidePlanIds = [...new Set(
      planWindowList
        .filter((w) => segs.some((seg) => intersects(w, seg)))
        .map((w) => w.planId)
    )].sort((a, b) => a - b);
    const lux = Number(session ? session.actual_lux : first.actual_lux);
    items.push({
      id: sessionId,
      hallId: session ? Number(session.hall_id) : null,
      hallCode: session ? session.hall_code : null,
      exhibitId: Number(first.exhibit_id),
      start: tsToWallString(new Date(session.start_ts).getTime()),
      end: tsToWallString(new Date(session.end_ts).getTime()),
      actualLux: lux,
      reason: session ? session.reason : null,
      createdBy: session ? session.created_by : null,
      creatorName: session && session.created_by
        ? (creatorMap.get(Number(session.created_by)) || null)
        : null,
      createdAt: session ? session.created_at : null,
      yearly: yearMapToObject(doseByYear(allParts, lux)),
      yearlyInside: yearMapToObject(doseByYear(insideParts, lux)),
      yearlyOutside: yearMapToObject(doseByYear(outsideParts, lux)),
      insidePlanIds,
      allocations: group
        .map(({ row, seg }) => ({
          id: Number(row.id),
          residenceId: Number(row.residence_id),
          start: tsToWallString(seg.start),
          end: tsToWallString(seg.end),
          actualLux: Number(row.actual_lux),
          yearly: yearMapToObject(doseByYear([seg], Number(row.actual_lux))),
        }))
        .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id)),
    });
  }
  items.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.id - a.id));

  return { items, windows };
}

/**
 * 计划在扣除“已确认实测覆盖 + 本计划停灯 + 事故窗内部分 + 共享照明窗内部分”后的估算剂量（按年）。
 * 统一扣减口径：共享照明与事故一样按自身实际照度全额计入实际用光，此处只把窗内相交部分
 * 从计划估算中移除（替代估算），窗外部分单独计量，不释放计划排期。
 */
function planResidueYearlyWithShared(plan, measWindows, blackoutWindowsByPlan, incidentWindows, sharedWindows) {
  const windows = planWindows(plan);
  const coverers = measWindows.filter((mw) => windows.some((w) => intersects(w, mw)));
  const blackouts = (blackoutWindowsByPlan && blackoutWindowsByPlan.get(Number(plan.id))) || [];
  const incidents = clipIntervalToWindowsForPlan(windows, incidentWindows);
  const shared = clipIntervalToWindowsForPlan(windows, sharedWindows);
  const remaining = subtractIntervals(windows, [...coverers, ...blackouts, ...incidents, ...shared]);
  return yearMapToObject(doseByYear(remaining, Number(plan.estimated_lux)));
}

/**
 * 计划在扣除“已确认实测覆盖 + 本计划停灯 + 与计划窗相交的计划外事故”后的估算剂量（按年）。
 * 统一扣减口径：批准/复核、占用查询、调整试算/成对核准、上限下调预演、联合核准均经此或同构逻辑。
 * 事故与实测、停灯业务互斥（登记时强制），故三类扣除窗互不相交；
 * 事故按其自身实际照度全额计入实际用光，此处只把窗内相交部分从计划估算中移除（替代估算），
 * 窗外部分由 computeOccupancy 单独计量，事故不释放计划排期（计划间开灯窗重叠判定不变）。
 */
function planResidueYearly(plan, measWindows, blackoutWindowsByPlan, incidentWindows = []) {
  return planResidueYearlyWithShared(plan, measWindows, blackoutWindowsByPlan, incidentWindows, []);
}

/** 取事故窗与某计划开灯窗的相交部分（合并后区间）。 */
function clipIntervalToWindowsForPlan(planWinList, incidentWindows) {
  const parts = [];
  for (const hole of incidentWindows) {
    for (const part of clipIntervalToWindows(hole, planWinList)) parts.push(part);
  }
  if (parts.length === 0) return [];
  return subtractIntervals(parts, []);
}

/**
 * 计算一件展品的年度额度占用（统一来源 + round3 舍入口径，展品详情/审批试算/下调预演/
 * 账册封存对照/分级预警均以此为准）。
 * 口径：
 *   used[year] = Σ 已确认实测剂量（按时窗自然年拆分）
 *              + Σ 计划外照明事故实际剂量（事故始终按实际照度全额计入实际用光）
 *              + Σ 共享照明归属实际剂量（按驻留交集归属，始终全额）
 *              + Σ 已批准/待复核计划“开灯窗 − 已确认实测覆盖 − 本计划停灯
 *                − 事故窗内部分 − 共享照明窗内部分”后的估算剂量
 *
 * options.years 非空时为“按受影响自然年局部重算”：只读取与这些年份相交的历史记录与计划，
 * 返回的 used/sources/years 也只含这些年份（各来源剂量先按自然年拆分再裁剪到目标年份，
 * 跨年记录的各年互不干扰）；展品详情等读取场景不传 years，行为与历史完全一致。
 */
async function computeOccupancy(client, exhibitId, {
  excludePlanId = null,
  extraMeasurement = null,
  extraMeasurements = null,
  years = null,
} = {}) {
  const bounds = years && years.length > 0 ? yearsToRanges(years) : null;
  const yearSet = bounds ? new Set(bounds.length === 0 ? [] : years.map(Number)) : null;

  const plans = await getOccupyingPlans(client, exhibitId, excludePlanId, bounds);
  const measurements = await getActiveMeasurements(client, exhibitId, bounds);
  const limitParams = [exhibitId];
  let limitSql = 'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1';
  if (bounds && bounds.length > 0) {
    // 年份集合通常很小，直接用 IN 绑定（整数入参，无注入面）
    const yearList = [...yearSet].sort((a, b) => a - b);
    const ph = yearList.map((_, i) => `$${i + 2}`).join(',');
    limitSql += ` AND year IN (${ph})`;
    limitParams.push(...yearList);
  }
  const limitRows = await client.query(limitSql, limitParams);
  const limits = {};
  for (const r of limitRows.rows) limits[String(r.year)] = Number(r.limit_lxh);

  const measWindows = measurements.map((m) => ({
    id: m.id,
    planId: m.plan_id,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
  }));
  // 预演一条或多条尚未确认（或刚录入）的实测，用于超额预判
  // （实测批次预览/导入时传入整批行，口径与确认后一致：实测替代估算）
  const extras = [];
  if (extraMeasurement) extras.push(extraMeasurement);
  if (Array.isArray(extraMeasurements)) extras.push(...extraMeasurements);
  for (const em of extras) {
    measWindows.push({
      id: em.id || -1,
      planId: em.planId,
      start: em.start,
      end: em.end,
      lux: em.lux,
      draft: true,
    });
  }

  // 停灯视图：记录列表（附按年扣减量）+ 按计划分组的“有效扣减窗”（仅占用中的计划计入）
  const blackoutView = await loadBlackoutView(client, exhibitId, { confirmedRows: measurements, bounds });

  // 计划外照明事故视图：逐条实际用光 + 全部事故时间窗（供计划残余扣除窗内相交部分）
  const incidentView = await loadIncidentView(client, exhibitId, { bounds });

  // 共享照明视图：逐条归属实际用光 + 全部归属窗（与事故同口径：窗内替代估算、窗外单独计量）
  const sharedView = await loadSharedLightingView(client, exhibitId, { bounds });

  // 局部重算时把各类时间窗先裁剪到受影响年份的年界区间，再做相减/相交，
  // 保证窗外年份的剂量不会经事故替代估算等途径渗入目标年份。
  const clipToBounds = (windows) => {
    if (!bounds) return windows;
    const parts = [];
    for (const w of windows) {
      for (const r of bounds) {
        const s = Math.max(w.start, r.startMs);
        const e = Math.min(w.end, r.endMs);
        if (e > s) parts.push({ ...w, start: s, end: e });
      }
    }
    return subtractIntervals(parts, []);
  };
  const scopedMeasWindows = clipToBounds(measWindows);
  const scopedIncidentWindows = clipToBounds(incidentView.windows);
  const scopedSharedWindows = clipToBounds(sharedView.windows);
  // 停灯有效扣减窗按计划裁剪
  const scopedBlackoutByPlan = new Map();
  for (const [pid, ws] of blackoutView.windowsByPlan) {
    scopedBlackoutByPlan.set(pid, clipToBounds(ws));
  }

  /** 按年剂量对象裁剪到目标年份（局部重算用）。 */
  const keepYears = (yearly) => {
    if (!yearSet) return yearly;
    const out = {};
    for (const [y, v] of Object.entries(yearly)) {
      if (yearSet.has(Number(y))) out[y] = v;
    }
    return out;
  };

  const used = {};
  const sources = [];

  // 1) 实测部分（停灯不减实测）
  for (const mw of scopedMeasWindows) {
    const yearly = keepYears(yearMapToObject(doseByYear([{ start: mw.start, end: mw.end }], mw.lux)));
    addYearDose(used, yearly);
    sources.push({
      kind: 'measurement',
      id: mw.id,
      planId: mw.planId,
      start: tsToWallString(mw.start),
      end: tsToWallString(mw.end),
      lux: mw.lux,
      yearly,
    });
  }

  // 1b) 计划外照明事故：始终按实际照度全额计入实际用光（按自然年拆分）
  for (const inc of incidentView.items) {
    const yearly = keepYears(inc.yearly);
    if (yearSet && Object.keys(yearly).length === 0) continue;
    addYearDose(used, yearly);
    sources.push({
      kind: 'incident',
      id: inc.id,
      start: inc.start,
      end: inc.end,
      lux: inc.actualLux,
      reason: inc.reason,
      yearly,
      yearlyInside: keepYears(inc.yearlyInside),
      yearlyOutside: keepYears(inc.yearlyOutside),
      insidePlanIds: inc.insidePlanIds,
    });
  }

  // 1c) 共享照明（规则 19）：按与驻留区间的交集归属本展品的实际用光，始终全额计入
  for (const sh of sharedView.items) {
    const yearly = keepYears(sh.yearly);
    if (yearSet && Object.keys(yearly).length === 0) continue;
    addYearDose(used, yearly);
    sources.push({
      kind: 'sharedLighting',
      id: sh.id,
      hallCode: sh.hallCode,
      start: sh.start,
      end: sh.end,
      lux: sh.actualLux,
      reason: sh.reason,
      yearly,
      yearlyInside: keepYears(sh.yearlyInside),
      yearlyOutside: keepYears(sh.yearlyOutside),
      insidePlanIds: sh.insidePlanIds,
      allocations: (sh.allocations || []).map((a) => ({ ...a, yearly: keepYears(a.yearly) }))
        .filter((a) => !yearSet || Object.keys(a.yearly).length > 0),
    });
  }

  // 2) 计划的估算残余
  //    （开灯窗 − 已确认实测覆盖 − 本计划停灯 − 事故窗内部分 − 共享照明窗内部分）
  //    局部重算时先把计划开灯窗裁到目标年份，再做同口径扣除：跨年计划各年的残余彼此独立。
  for (const plan of plans) {
    let yearly;
    if (bounds) {
      const planWin = planWindows(plan);
      const clippedWin = clipToBounds(planWin);
      const coverers = scopedMeasWindows.filter((mw) => clippedWin.some((w) => intersects(w, mw)));
      const blackouts = scopedBlackoutByPlan.get(Number(plan.id)) || [];
      const incidents = clipIntervalToWindowsForPlan(clippedWin, scopedIncidentWindows);
      const shared = clipIntervalToWindowsForPlan(clippedWin, scopedSharedWindows);
      const remaining = subtractIntervals(clippedWin, [...coverers, ...blackouts, ...incidents, ...shared]);
      yearly = keepYears(yearMapToObject(doseByYear(remaining, Number(plan.estimated_lux))));
    } else {
      yearly = planResidueYearlyWithShared(
        plan, measWindows, blackoutView.windowsByPlan,
        incidentView.windows, sharedView.windows
      );
    }
    addYearDose(used, yearly);
    sources.push({
      kind: 'plan',
      id: plan.id,
      title: plan.title,
      status: plan.status,
      startDate: plan.start_date,
      endDate: plan.end_date,
      periods: plan.light_periods,
      lux: Number(plan.estimated_lux),
      yearly,
    });
  }

  const yearsReport = {};
  const allYears = new Set([
    ...Object.keys(limits).map(Number),
    ...Object.keys(used).map(Number),
    ...(yearSet ? [...yearSet] : []),
  ]);
  for (const year of [...allYears].sort((a, b) => a - b)) {
    const key = String(year);
    const usedVal = round3(used[key] || 0);
    const limitVal = limits[key] !== undefined ? round3(limits[key]) : null;
    yearsReport[key] = {
      year,
      limit: limitVal,
      used: usedVal,
      remaining: limitVal === null ? null : round3(limitVal - usedVal),
      over: limitVal === null ? false : usedVal - limitVal > 0.005,
    };
  }

  return {
    limits,
    used,
    years: yearsReport,
    sources,
    plans,
    measurements,
    blackouts: blackoutView.items,
    blackoutDeductionYearly: keepYears(blackoutView.totalDeductionYearly),
    incidents: incidentView.items,
    incidentWindows: incidentView.windows,
    sharedLightings: sharedView.items,
    sharedLightingWindows: sharedView.windows,
  };
}

/** 检查新增/复核的年度剂量并入当前占用后是否超限，返回超额明细数组。 */
function buildOverflows(currentUsed, limits, addedYearly) {
  const overflows = [];
  for (const [yearStr, add] of Object.entries(addedYearly)) {
    const limit = limits[yearStr];
    if (limit === undefined || limit === null) {
      throw new ConflictError(`${yearStr} 年尚未登记年度额度，无法批准`, {
        missingLimit: yearStr,
      });
    }
    const projected = round3((currentUsed[yearStr] || 0) + add);
    if (projected - limit > 0.005) {
      overflows.push({
        year: Number(yearStr),
        limit: round3(limit),
        usedBefore: round3(currentUsed[yearStr] || 0),
        addedByThisPlan: round3(add),
        projected,
        excess: round3(projected - limit),
      });
    }
  }
  return overflows;
}

/** 计划时间窗是否与同展品另一占用计划相交。 */
function planOverlaps(targetWindows, otherPlan) {
  return anyIntersect(targetWindows, planWindows(otherPlan));
}

/**
 * 校验实测时段：
 *  - 必须落在所属已批准/待复核计划的开灯窗内
 *  - 不得与同展品任何未作废实测重叠
 *  - 不得与同展品任何停灯记录相交（停灯与实测互斥，录入或确认都拒绝）
 * 返回 { start, end, windows }（毫秒）
 */
async function validateMeasurementWindow(client, plan, startYmd, startMinute, endYmd, endMinute, excludeMeasId = null) {
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError('只有已批准（或待复核）计划才能登记实测');
  }
  const start = wallToTs(startYmd, startMinute);
  const end = wallToTs(endYmd, endMinute);
  if (!(end > start)) throw new ValidationError('实测时段结束必须晚于开始');

  const windows = planWindows(plan);
  const seg = { start, end };
  if (!windows.some((w) => containsInterval(w, seg))) {
    throw new ValidationError(
      `实测时段 ${tsToWallString(start)} ~ ${tsToWallString(end)} 不在该计划的开灯时段内`
    );
  }
  const overlap = await findOverlappingMeasurement(client, plan.exhibit_id, start, end, excludeMeasId);
  if (overlap) {
    throw new ConflictError(
      `与已登记实测 #${overlap.id}（${tsToWallString(new Date(overlap.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(overlap.end_ts).getTime())}）时间重叠，已拒绝`,
      { overlappingMeasurementId: overlap.id }
    );
  }
  const blackoutClash = await findOverlappingBlackout(client, plan.exhibit_id, start, end);
  if (blackoutClash) {
    throw new ConflictError(
      `实测时段与停灯记录 #${blackoutClash.id}（计划 #${blackoutClash.plan_id}，` +
        `${tsToWallString(new Date(blackoutClash.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(blackoutClash.end_ts).getTime())}）相交，已拒绝；` +
        '停灯时段不可录入实测，停灯记录亦不可修改/删除',
      { overlappingBlackoutId: blackoutClash.id, overlappingBlackoutPlanId: blackoutClash.plan_id }
    );
  }
  const incidentClash = await findOverlappingIncident(client, plan.exhibit_id, start, end);
  if (incidentClash) {
    throw new ConflictError(
      `实测时段与计划外照明事故 #${incidentClash.id}（` +
        `${tsToWallString(new Date(incidentClash.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(incidentClash.end_ts).getTime())}）相交，已拒绝；` +
        '事故已按实际用光计量，事故记录不可修改/删除',
      { overlappingIncidentId: incidentClash.id }
    );
  }
  const sharedClash = await findOverlappingSharedLighting(client, plan.exhibit_id, start, end);
  if (sharedClash) {
    throw new ConflictError(
      `实测时段与共享照明 #${sharedClash.session_id}（展厅「${sharedClash.hall_code}」，` +
        `${tsToWallString(new Date(sharedClash.start_ts).getTime())} ~ ` +
        `${tsToWallString(new Date(sharedClash.end_ts).getTime())}）的归属时段相交，已拒绝；` +
        '共享照明已按实际用光计量，记录不可修改/删除',
      { overlappingSharedLightingId: Number(sharedClash.session_id) }
    );
  }
  return { start, end, windows };
}

/**
 * 实测纠错（由路由在展品锁事务内、已持有展品行锁后调用）：
 * 保管员对一条「已确认」实测发起纠错：
 *  - 原记录必须存在且为 confirmed；draft 不能纠错（可直接删除重录），annulled 不能再次纠错
 *    （应对其当前有效的替代记录发起）。
 *  - 替代记录仍属原计划：替代时段必须正时长且完整落在原计划当前开灯窗内（不校验计划状态，
 *    计划取消/待复核后仍允许对历史实测纠错，窗口以计划现有展期/开灯时段为准）。
 *  - 替代时段不得与同展品「其他未作废实测（含待确认草稿）」或任何停灯记录相交；
 *    原记录自身排除（它随后即被作废）。
 *  - 替代照度必须为正，纠错原因必填。
 * 输入/窗口/原因类错误抛 ValidationError（400）；相交冲突一次性收集后抛 ConflictError（409），
 * 任何失败都不改动数据。
 * 通过后：原记录保留并置 annulled（记 annulled_by/at、replaced_by_id、correction_reason），
 * 插入一条直接 confirmed 的替代记录（记 confirmed_by/at、replaces_measurement_id、correction_reason）。
 * 返回 { plan, original, replacement, startMs, endMs, lux, reason }。
 */
async function correctMeasurement(client, originalId, input, actor) {
  const mRows = await client.query('SELECT * FROM measurements WHERE id = $1 FOR UPDATE', [originalId]);
  const original = mRows.rows[0];
  if (!original) throw new ValidationError('实测记录不存在');
  if (original.status === 'annulled') {
    throw new ValidationError('该实测已作废，不能再次纠错；请对其当前有效的替代记录发起纠错');
  }
  if (original.status === 'draft') {
    throw new ValidationError('只有已确认实测才能纠错；待确认记录可直接删除后重新录入');
  }

  const plan = await getPlan(client, original.plan_id);
  const startMs = wallToTs(input.startDate, input.startMinute);
  const endMs = wallToTs(input.endDate, input.endMinute);
  if (!(endMs > startMs)) throw new ValidationError('替代时段结束必须晚于开始');
  const lux = positiveNumber(input.actualLux, '替代实测照度（lx）', { max: 1000000 });
  const reason = nonEmptyString(input.reason, '纠错原因', 1000);

  const windows = planWindows(plan);
  const seg = { start: startMs, end: endMs };
  if (!windows.some((w) => containsInterval(w, seg))) {
    throw new ValidationError(
      `替代时段 ${tsToWallString(startMs)} ~ ${tsToWallString(endMs)} ` +
        `没有完整落在原计划 #${plan.id} 的开灯窗内`
    );
  }

  // 冲突一次性收集：其他未作废实测（含草稿，排除原记录）与停灯记录
  const { rows: measRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts, status
       FROM measurements
      WHERE exhibit_id = $1 AND id <> $2 AND status <> 'annulled'
        AND start_ts < $4 AND end_ts > $3
      ORDER BY id`,
    [plan.exhibit_id, originalId, new Date(startMs), new Date(endMs)]
  );
  const { rows: blackoutRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts FROM blackouts
      WHERE exhibit_id = $1
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  const { rows: incidentRows } = await client.query(
    `SELECT id, start_ts, end_ts FROM lighting_incidents
      WHERE exhibit_id = $1
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  const { rows: sharedClashRows } = await client.query(
    `SELECT a.id AS allocation_id, a.session_id, a.start_ts, a.end_ts, h.hall_code
       FROM shared_lighting_allocations a
       JOIN shared_lightings s ON s.id = a.session_id
       JOIN halls h ON h.id = s.hall_id
      WHERE a.exhibit_id = $1
        AND a.start_ts < $3 AND a.end_ts > $2
      ORDER BY a.id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  if (measRows.length > 0 || blackoutRows.length > 0 || incidentRows.length > 0 || sharedClashRows.length > 0) {
    const planIds = [...new Set(blackoutRows.map((b) => Number(b.plan_id)))];
    const titleMap = new Map();
    if (planIds.length > 0) {
      const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
      const tRows = await client.query(
        `SELECT id, title FROM plans WHERE id IN (${placeholders})`,
        planIds
      );
      for (const t of tRows.rows) titleMap.set(Number(t.id), t.title);
    }
    const overlappingMeasurements = measRows.map((m) => ({
      id: m.id,
      planId: m.plan_id,
      status: m.status,
      start: tsToWallString(new Date(m.start_ts).getTime()),
      end: tsToWallString(new Date(m.end_ts).getTime()),
    }));
    const overlappingBlackouts = blackoutRows.map((b) => ({
      id: b.id,
      planId: b.plan_id,
      planTitle: titleMap.get(Number(b.plan_id)) || null,
      start: tsToWallString(new Date(b.start_ts).getTime()),
      end: tsToWallString(new Date(b.end_ts).getTime()),
    }));
    const overlappingIncidents = incidentRows.map((x) => ({
      id: x.id,
      start: tsToWallString(new Date(x.start_ts).getTime()),
      end: tsToWallString(new Date(x.end_ts).getTime()),
    }));
    const overlappingSharedLightings = sharedClashRows.map((x) => ({
      sessionId: x.session_id,
      hallCode: x.hall_code,
      start: tsToWallString(new Date(x.start_ts).getTime()),
      end: tsToWallString(new Date(x.end_ts).getTime()),
    }));
    const parts = [];
    for (const m of overlappingMeasurements) {
      parts.push(`与${m.status === 'draft' ? '待确认' : '已确认'}实测 #${m.id}（${m.start} ~ ${m.end}）相交`);
    }
    for (const b of overlappingBlackouts) {
      parts.push(`与停灯记录 #${b.id}（计划「${b.planTitle}」，${b.start} ~ ${b.end}）相交`);
    }
    for (const x of overlappingIncidents) {
      parts.push(`与计划外照明事故 #${x.id}（${x.start} ~ ${x.end}）相交`);
    }
    for (const sh of overlappingSharedLightings) {
      parts.push(`与共享照明 #${sh.sessionId}（展厅「${sh.hallCode}」，${sh.start} ~ ${sh.end}）的归属时段相交`);
    }
    throw new ConflictError(`实测纠错失败：${parts.join('；')}，未保存`, {
      overlappingMeasurements,
      overlappingBlackouts,
      overlappingIncidents,
      overlappingSharedLightings,
    });
  }

  const inserted = await client.query(
    `INSERT INTO measurements
       (plan_id, exhibit_id, start_ts, end_ts, actual_lux, note, status,
        created_by, confirmed_by, confirmed_at, replaces_measurement_id, correction_reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $7, now(), $8, $9)
     RETURNING *`,
    [plan.id, plan.exhibit_id, new Date(startMs), new Date(endMs), lux,
      original.note || null, actor.userId, originalId, reason]
  );
  const replacement = inserted.rows[0];
  await client.query(
    `UPDATE measurements
        SET status = 'annulled', annulled_by = $1, annulled_at = now(),
            replaced_by_id = $2, correction_reason = $3
      WHERE id = $4`,
    [actor.userId, replacement.id, reason, originalId]
  );

  return { plan, original, replacement, startMs, endMs, lux, reason };
}

/**
 * 校验并登记停灯时段（由路由在展品锁事务内调用）：
 *  - 计划必须为已批准或待复核
 *  - 起点须早于终点；结束不得晚于当前时间（只登记已发生时段）
 *  - 时段必须完整落在该计划当前开灯窗内
 *  - 不得与同展品未作废实测（含待确认草稿）相交
 *  - 不得与同展品其他停灯记录相交
 *  - 原因必填
 * 全部失败一次性收集：窗口/时间类错误抛 400；冲突类抛 409 并在 details 中指出全部冲突，不保存。
 * 返回插入的停灯行。
 */
async function registerBlackout(client, { planId, startMs, endMs, reason }, actor) {
  const plan = await getPlan(client, planId);
  if (!ACTIVE_PLAN_STATUSES.includes(plan.status)) {
    throw new ValidationError(
      `只有已批准或待复核计划才能登记停灯（当前状态：${plan.status}）`
    );
  }
  if (!(endMs > startMs)) throw new ValidationError('停灯时段起点须早于终点');
  const nowMs = Date.now();
  if (endMs > nowMs) {
    throw new ValidationError(
      `停灯结束时刻（${tsToWallString(endMs)}）晚于当前时间，只能登记已发生的停灯时段`
    );
  }
  const reasonText = nonEmptyString(reason, '停灯原因', 1000);

  const windows = planWindows(plan);
  const seg = { start: startMs, end: endMs };
  if (!windows.some((w) => containsInterval(w, seg))) {
    throw new ValidationError(
      `停灯时段 ${tsToWallString(startMs)} ~ ${tsToWallString(endMs)} ` +
        '没有完整落在该计划的开灯窗内'
    );
  }

  // 冲突一次性收集：未作废实测（含草稿）与其他停灯记录
  const { rows: measRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts, status
       FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  const { rows: blackoutRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts FROM blackouts
      WHERE exhibit_id = $1
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  const { rows: incidentRows } = await client.query(
    `SELECT id, start_ts, end_ts FROM lighting_incidents
      WHERE exhibit_id = $1
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  const { rows: sharedClashRows } = await client.query(
    `SELECT a.id AS allocation_id, a.session_id, a.start_ts, a.end_ts, h.hall_code
       FROM shared_lighting_allocations a
       JOIN shared_lightings s ON s.id = a.session_id
       JOIN halls h ON h.id = s.hall_id
      WHERE a.exhibit_id = $1
        AND a.start_ts < $3 AND a.end_ts > $2
      ORDER BY a.id`,
    [plan.exhibit_id, new Date(startMs), new Date(endMs)]
  );
  if (measRows.length > 0 || blackoutRows.length > 0 || incidentRows.length > 0 || sharedClashRows.length > 0) {
    // 计划标题单独批量查（避免 JOIN + 时间不等式在个别内存驱动上的实现问题）
    const planIds = [...new Set(blackoutRows.map((b) => Number(b.plan_id)))];
    const titleMap = new Map();
    if (planIds.length > 0) {
      const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
      const tRows = await client.query(
        `SELECT id, title FROM plans WHERE id IN (${placeholders})`,
        planIds
      );
      for (const t of tRows.rows) titleMap.set(Number(t.id), t.title);
    }
    const overlappingMeasurements = measRows.map((m) => ({
      id: m.id,
      planId: m.plan_id,
      status: m.status,
      start: tsToWallString(new Date(m.start_ts).getTime()),
      end: tsToWallString(new Date(m.end_ts).getTime()),
    }));
    const overlappingBlackouts = blackoutRows.map((b) => ({
      id: b.id,
      planId: b.plan_id,
      planTitle: titleMap.get(Number(b.plan_id)) || null,
      start: tsToWallString(new Date(b.start_ts).getTime()),
      end: tsToWallString(new Date(b.end_ts).getTime()),
    }));
    const overlappingIncidents = incidentRows.map((x) => ({
      id: x.id,
      start: tsToWallString(new Date(x.start_ts).getTime()),
      end: tsToWallString(new Date(x.end_ts).getTime()),
    }));
    const parts = [];
    for (const m of overlappingMeasurements) {
      parts.push(`与${m.status === 'draft' ? '待确认' : '已确认'}实测 #${m.id}（${m.start} ~ ${m.end}）相交`);
    }
    for (const b of overlappingBlackouts) {
      parts.push(`与停灯记录 #${b.id}（计划「${b.planTitle}」，${b.start} ~ ${b.end}）相交`);
    }
    for (const x of overlappingIncidents) {
      parts.push(`与计划外照明事故 #${x.id}（${x.start} ~ ${x.end}）相交`);
    }
    const overlappingSharedLightings = sharedClashRows.map((x) => ({
      sessionId: x.session_id,
      hallCode: x.hall_code,
      start: tsToWallString(new Date(x.start_ts).getTime()),
      end: tsToWallString(new Date(x.end_ts).getTime()),
    }));
    for (const sh of overlappingSharedLightings) {
      parts.push(`与共享照明 #${sh.sessionId}（展厅「${sh.hallCode}」，${sh.start} ~ ${sh.end}）的归属时段相交`);
    }
    throw new ConflictError(`停灯登记失败：${parts.join('；')}，未保存`, {
      overlappingMeasurements,
      overlappingBlackouts,
      overlappingIncidents,
      overlappingSharedLightings,
    });
  }

  const inserted = await client.query(
    `INSERT INTO blackouts (plan_id, exhibit_id, start_ts, end_ts, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [planId, plan.exhibit_id, new Date(startMs), new Date(endMs), reasonText, actor.userId]
  );
  return inserted.rows[0];
}

/**
 * 校验并登记计划外照明事故（由路由在展品锁事务内调用）：
 *  - 起点须早于终点；结束不得晚于当前时间（只登记已发生事故）
 *  - 实际照度必须为正、原因必填（路由层先行校验，这里防御性再查一次原因）
 *  - 事故不要求落在任何计划开灯窗内（计划外）；但不得与同展品
 *      · 未作废实测（含待确认草稿）
 *      · 停灯记录
 *      · 其他计划外照明事故
 *    相交。
 * 全部冲突一次性收集：时间/数值/原因类错误抛 400；冲突类抛 409 并在 details 中指出全部冲突，
 * 不保存。事故一经保存永久保留，不可修改/删除。
 * 返回插入的事故行。
 */
async function registerIncident(client, { exhibitId, startMs, endMs, actualLux, reason }, actor) {
  if (!(endMs > startMs)) throw new ValidationError('照明事故起点须早于终点');
  const nowMs = Date.now();
  if (endMs > nowMs) {
    throw new ValidationError(
      `照明事故结束时刻（${tsToWallString(endMs)}）晚于当前时间，只能登记已发生的照明事故`
    );
  }
  const reasonText = nonEmptyString(reason, '事故原因', 1000);

  const { rows: measRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts, status
       FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [exhibitId, new Date(startMs), new Date(endMs)]
  );
  const { rows: blackoutRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts FROM blackouts
      WHERE exhibit_id = $1
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [exhibitId, new Date(startMs), new Date(endMs)]
  );
  const { rows: incidentRows } = await client.query(
    `SELECT id, start_ts, end_ts FROM lighting_incidents
      WHERE exhibit_id = $1
        AND start_ts < $3 AND end_ts > $2
      ORDER BY id`,
    [exhibitId, new Date(startMs), new Date(endMs)]
  );
  const { rows: sharedClashRowsForIncident } = await client.query(
    `SELECT a.id AS allocation_id, a.session_id, a.start_ts, a.end_ts, h.hall_code
       FROM shared_lighting_allocations a
       JOIN shared_lightings s ON s.id = a.session_id
       JOIN halls h ON h.id = s.hall_id
      WHERE a.exhibit_id = $1
        AND a.start_ts < $3 AND a.end_ts > $2
      ORDER BY a.id`,
    [exhibitId, new Date(startMs), new Date(endMs)]
  );
  if (measRows.length > 0 || blackoutRows.length > 0 || incidentRows.length > 0 ||
      sharedClashRowsForIncident.length > 0) {
    const planIds = [...new Set(blackoutRows.map((b) => Number(b.plan_id)))];
    const titleMap = new Map();
    if (planIds.length > 0) {
      const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
      const tRows = await client.query(
        `SELECT id, title FROM plans WHERE id IN (${placeholders})`,
        planIds
      );
      for (const t of tRows.rows) titleMap.set(Number(t.id), t.title);
    }
    const overlappingMeasurements = measRows.map((m) => ({
      id: m.id,
      planId: m.plan_id,
      status: m.status,
      start: tsToWallString(new Date(m.start_ts).getTime()),
      end: tsToWallString(new Date(m.end_ts).getTime()),
    }));
    const overlappingBlackouts = blackoutRows.map((b) => ({
      id: b.id,
      planId: b.plan_id,
      planTitle: titleMap.get(Number(b.plan_id)) || null,
      start: tsToWallString(new Date(b.start_ts).getTime()),
      end: tsToWallString(new Date(b.end_ts).getTime()),
    }));
    const overlappingIncidents = incidentRows.map((x) => ({
      id: x.id,
      start: tsToWallString(new Date(x.start_ts).getTime()),
      end: tsToWallString(new Date(x.end_ts).getTime()),
    }));
    const parts = [];
    for (const m of overlappingMeasurements) {
      parts.push(`与${m.status === 'draft' ? '待确认' : '已确认'}实测 #${m.id}（${m.start} ~ ${m.end}）相交`);
    }
    for (const b of overlappingBlackouts) {
      parts.push(`与停灯记录 #${b.id}（计划「${b.planTitle}」，${b.start} ~ ${b.end}）相交`);
    }
    for (const x of overlappingIncidents) {
      parts.push(`与其他计划外照明事故 #${x.id}（${x.start} ~ ${x.end}）相交`);
    }
    const overlappingSharedLightings = sharedClashRowsForIncident.map((x) => ({
      sessionId: x.session_id,
      hallCode: x.hall_code,
      start: tsToWallString(new Date(x.start_ts).getTime()),
      end: tsToWallString(new Date(x.end_ts).getTime()),
    }));
    for (const sh of overlappingSharedLightings) {
      parts.push(`与共享照明 #${sh.sessionId}（展厅「${sh.hallCode}」，${sh.start} ~ ${sh.end}）的归属时段相交`);
    }
    throw new ConflictError(`计划外照明事故登记失败：${parts.join('；')}，未保存`, {
      overlappingMeasurements,
      overlappingBlackouts,
      overlappingIncidents,
      overlappingSharedLightings,
    });
  }

  const inserted = await client.query(
    `INSERT INTO lighting_incidents (exhibit_id, start_ts, end_ts, actual_lux, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [exhibitId, new Date(startMs), new Date(endMs), actualLux, reasonText, actor.userId]
  );
  return inserted.rows[0];
}

/**
 * 迟到实测超额后，找出需要转为“待复核”的计划：
 * 同展品、已批准、在超额年份尚有估算剂量、且计划首个开灯时刻尚未开始。
 */
function plansToFlag(plans, occupancy, overflowYears, nowMs) {
  const planEstimate = new Map();
  for (const src of occupancy.sources.filter((s) => s.kind === 'plan')) {
    planEstimate.set(src.id, src.yearly);
  }
  const flagged = [];
  for (const plan of plans) {
    if (plan.status !== 'approved') continue;
    const yearly = planEstimate.get(plan.id) || {};
    if (!overflowYears.some((y) => (yearly[String(y)] || 0) > 0)) continue;
    const firstStart = Math.min(...planWindows(plan).map((w) => w.start));
    if (firstStart > nowMs) flagged.push({ plan, firstStart });
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// 实测确认/批次确认共用的超额处理
// ---------------------------------------------------------------------------

/**
 * 按「确认实测生效后的占用」找出超额自然年（沿用确认实测口径）。
 * occupancy 必须是按新实测预演（或实测已入账后重算）得到的占用结果；
 * candidateYears 限定为本次剂量实际影响到的年份（新/旧实测按年剂量年份的并集），
 * 避免把与本次操作无关、本已超限的年份也列入响应。
 */
function overflowInfoFromOccupancy(occupancy, candidateYears) {
  const overflows = [];
  const overflowYears = [];
  for (const year of candidateYears) {
    const info = occupancy.years[String(year)];
    if (!info || info.limit === null) continue;
    if (info.over) {
      overflowYears.push(Number(year));
      overflows.push({
        year: Number(year),
        limit: info.limit,
        projected: info.used,
        excess: Math.round((info.used - info.limit) * 1000) / 1000,
      });
    }
  }
  return { overflows, overflowYears };
}

/**
 * 把超额年份对应的「同展品、已批准、该年仍有估算残余且尚未开始」的计划转待复核，
 * 逐条写审计；返回被转计划的概要（与确认实测响应同构）。
 */
async function flagPlansForOverflow(client, actor, { exhibitId, occupancy, overflowYears, trigger, reason }) {
  const activePlans = await getOccupyingPlans(client, exhibitId);
  const flaggedTargets = plansToFlag(activePlans, occupancy, overflowYears, Date.now());
  const flagged = flaggedTargets.map(({ plan: fp, firstStart }) => ({
    id: fp.id,
    title: fp.title,
    firstStart: tsToWallString(firstStart),
    overflowYears,
  }));
  for (const { plan: fp } of flaggedTargets) {
    await client.query(
      `UPDATE plans
          SET status = 'pending_review',
              review_reason = $2,
              updated_at = now()
        WHERE id = $1`,
      [fp.id, reason(fp.id)]
    );
    await recordAudit(client, actor, 'plan.flag_review', 'plan', fp.id, {
      ...trigger,
      overflowYears,
    });
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// 实测 CSV 导入批次（规则 18）
// ---------------------------------------------------------------------------

/**
 * 实测批次逐行评估（导入预览 / 导入保存 / 确认重核共用同一口径）：
 * 对解析后的行（{row,line,startMs,endMs,lux,note,errors}）在展品当前数据下核对：
 *   - 时段完整落在该计划当前开灯窗内（kind: 'window'）
 *   - 不与同展品未作废实测（含待确认草稿）相交（kind: 'overlap'）
 *   - 不与同展品停灯记录相交（kind: 'overlap'）
 *   - 不与同展品计划外照明事故相交（kind: 'overlap'）
 *   - 批次内部行与行不得相交（kind: 'overlap'，记在后一行上）
 * 解析/取值类错误（kind: 'value'）由 csv.js 先行写入；本函数先把字符串错误规范化。
 * 每行追加 errors: [{kind,message}] 与 conflicts；全部有效的行计算 yearly 并汇总 totalYearly。
 * 返回 { rows, errorRows, totalYearly }；调用方负责计划状态校验与错误状态码归并。
 */
async function evaluateMeasurementBatch(client, plan, rows) {
  const windows = planWindows(plan);
  const exhibitId = plan.exhibit_id;

  // 一次性取出同展品冲突源（避免逐行查询；在展品锁事务内调用时视图一致）
  const { rows: measRows } = await client.query(
    `SELECT id, plan_id, status, start_ts, end_ts FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [exhibitId]
  );
  const { rows: blackoutRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts FROM blackouts
      WHERE exhibit_id = $1
      ORDER BY id`,
    [exhibitId]
  );
  const { rows: incidentRows } = await client.query(
    `SELECT id, start_ts, end_ts FROM lighting_incidents
      WHERE exhibit_id = $1
      ORDER BY id`,
    [exhibitId]
  );
  const { rows: sharedRowsForBatch } = await client.query(
    `SELECT a.id AS allocation_id, a.session_id, a.start_ts, a.end_ts, h.hall_code
       FROM shared_lighting_allocations a
       JOIN shared_lightings s ON s.id = a.session_id
       JOIN halls h ON h.id = s.hall_id
      WHERE a.exhibit_id = $1
      ORDER BY a.id`,
    [exhibitId]
  );
  // 冲突消息中的计划标题（拆简单查询，规避个别内存驱动的 JOIN 缺陷）
  const planIds = [...new Set([
    ...measRows.map((m) => Number(m.plan_id)),
    ...blackoutRows.map((b) => Number(b.plan_id)),
  ])];
  const titleMap = new Map();
  if (planIds.length > 0) {
    const placeholders = planIds.map((_, i) => `$${i + 1}`).join(',');
    const tRows = await client.query(
      `SELECT id, title FROM plans WHERE id IN (${placeholders})`,
      planIds
    );
    for (const t of tRows.rows) titleMap.set(Number(t.id), t.title);
  }

  const meas = measRows.map((m) => ({
    id: m.id,
    planId: Number(m.plan_id),
    status: m.status,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));
  const blacks = blackoutRows.map((b) => ({
    id: b.id,
    planId: Number(b.plan_id),
    start: new Date(b.start_ts).getTime(),
    end: new Date(b.end_ts).getTime(),
  }));
  const incs = incidentRows.map((x) => ({
    id: x.id,
    start: new Date(x.start_ts).getTime(),
    end: new Date(x.end_ts).getTime(),
  }));
  const shareds = sharedRowsForBatch.map((x) => ({
    allocationId: Number(x.allocation_id),
    sessionId: Number(x.session_id),
    hallCode: x.hall_code,
    start: new Date(x.start_ts).getTime(),
    end: new Date(x.end_ts).getTime(),
  }));

  for (const r of rows) {
    // 解析期错误（字符串）规范化为 {kind:'value'}
    r.errors = (r.errors || []).map((e) => (typeof e === 'string' ? { kind: 'value', message: e } : e));
    if (r.startMs === null || r.endMs === null) continue;
    r.start = tsToWallString(r.startMs);
    r.end = tsToWallString(r.endMs);
    const seg = { start: r.startMs, end: r.endMs };
    const conflicts = {
      overlappingRows: [],
      overlappingMeasurements: [],
      overlappingBlackouts: [],
      overlappingIncidents: [],
      overlappingSharedLightings: [],
    };

    if (!windows.some((w) => containsInterval(w, seg))) {
      r.errors.push({
        kind: 'window',
        message: `时段 ${r.start} ~ ${r.end} 没有完整落在计划 #${plan.id} 的开灯窗内`,
      });
    }
    for (const m of meas) {
      if (m.start < seg.end && seg.start < m.end) {
        conflicts.overlappingMeasurements.push({
          id: m.id,
          planId: m.planId,
          status: m.status,
          start: tsToWallString(m.start),
          end: tsToWallString(m.end),
        });
      }
    }
    for (const b of blacks) {
      if (b.start < seg.end && seg.start < b.end) {
        conflicts.overlappingBlackouts.push({
          id: b.id,
          planId: b.planId,
          planTitle: titleMap.get(b.planId) || null,
          start: tsToWallString(b.start),
          end: tsToWallString(b.end),
        });
      }
    }
    for (const x of incs) {
      if (x.start < seg.end && seg.start < x.end) {
        conflicts.overlappingIncidents.push({
          id: x.id,
          start: tsToWallString(x.start),
          end: tsToWallString(x.end),
        });
      }
    }
    for (const sh of shareds) {
      if (sh.start < seg.end && seg.start < sh.end) {
        conflicts.overlappingSharedLightings.push({
          sessionId: sh.sessionId,
          hallCode: sh.hallCode,
          start: tsToWallString(sh.start),
          end: tsToWallString(sh.end),
        });
      }
    }
    for (const c of conflicts.overlappingMeasurements) {
      r.errors.push({
        kind: 'overlap',
        message: `与${c.status === 'draft' ? '待确认' : '已确认'}实测 #${c.id}（${c.start} ~ ${c.end}）相交`,
      });
    }
    for (const c of conflicts.overlappingBlackouts) {
      r.errors.push({
        kind: 'overlap',
        message: `与停灯记录 #${c.id}（计划「${c.planTitle || `#${c.planId}`}」，${c.start} ~ ${c.end}）相交`,
      });
    }
    for (const c of conflicts.overlappingIncidents) {
      r.errors.push({
        kind: 'overlap',
        message: `与计划外照明事故 #${c.id}（${c.start} ~ ${c.end}）相交`,
      });
    }
    for (const c of conflicts.overlappingSharedLightings) {
      r.errors.push({
        kind: 'overlap',
        message: `与共享照明 #${c.sessionId}（展厅「${c.hallCode}」，${c.start} ~ ${c.end}）的归属时段相交`,
      });
    }
    r.conflicts = conflicts;
  }

  // 行间相交：仅在“个体校验全部通过”的行之间检查（已有取值/窗口/相交错误的行不参与，
  // 避免把针对失效行的相交噪音报给有效行）；按开始时刻排序，后行撞前行记在后一行
  // （端点相接不算相交）。
  const timed = rows
    .filter((r) => r.startMs !== null && r.endMs !== null && r.errors.length === 0)
    .sort((a, b) => a.startMs - b.startMs || a.row - b.row);
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      if (timed[j].startMs >= timed[i].endMs) break;
      timed[j].errors.push({
        kind: 'overlap',
        message: `与第 ${timed[i].row} 行（${timed[i].start} ~ ${timed[i].end}）时段相交`,
      });
      timed[j].conflicts.overlappingRows.push(timed[i].row);
    }
  }

  // 有效行按自然年拆分剂量并汇总整批剂量
  const totalYearly = {};
  for (const r of rows) {
    if (r.startMs === null || r.errors.length > 0) continue;
    r.yearly = yearMapToObject(doseByYear([{ start: r.startMs, end: r.endMs }], r.lux));
    addYearDose(totalYearly, r.yearly);
  }
  const errorRows = rows.filter((r) => r.errors.length > 0);
  return { rows, errorRows, totalYearly };
}

// ---------------------------------------------------------------------------
// 计划调整申请
// ---------------------------------------------------------------------------

/**
 * 规范化“新展期 + 每日开灯时段 + 预计照度”输入（创建计划与调整申请共用）。
 * 返回 { startDate, endDate, periodSpecs, periods, estimatedLux }。
 */
function normalizeScheduleInput(body, { withTitle = false } = {}) {
  const out = {};
  if (withTitle) out.title = nonEmptyString(body.title, '计划名称', 200);
  const startDate = assertDate(body.startDate, '开始日期');
  const endDate = assertDate(body.endDate, '结束日期');
  if (endDate < startDate) throw new ValidationError('结束日期不能早于开始日期');
  const rawPeriods = body.periods;
  if (!Array.isArray(rawPeriods) || rawPeriods.some((p) => typeof p !== 'string')) {
    throw new ValidationError('每日开灯时段必须是字符串数组，如 ["09:00-12:00"]');
  }
  const periods = parsePeriods(rawPeriods);
  // 规范为 HH:MM-HH:MM（允许输入 HH:MM:00）
  const periodSpecs = periods.map((p) => {
    const endMin = (p.startMin + p.durationMin) % 1440;
    const fmt = (min) =>
      `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
    return `${fmt(p.startMin)}-${fmt(endMin)}`;
  });
  const estimatedLux = positiveNumber(body.estimatedLux, '预计照度（lx）', { max: 1000000 });

  // 展期最长约 5 年，防止误填导致的巨型计算
  const spanMs =
    Date.UTC(
      Number(endDate.slice(0, 4)),
      Number(endDate.slice(5, 7)) - 1,
      Number(endDate.slice(8, 10))
    ) -
    Date.UTC(
      Number(startDate.slice(0, 4)),
      Number(startDate.slice(5, 7)) - 1,
      Number(startDate.slice(8, 10))
    );
  if (spanMs / 86400000 + 1 > 1860) throw new ValidationError('展期跨度不能超过约 5 年');

  return { ...out, startDate, endDate, periodSpecs, periods, estimatedLux };
}

/** 取某计划当前唯一一份待审调整申请（无则 null）。 */
async function getPendingAdjustment(client, planId) {
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
      WHERE a.plan_id = $1 AND a.status = 'pending'
      ORDER BY a.id DESC
      LIMIT 1`,
    [planId]
  );
  return rows[0] || null;
}

/** 取多份计划各自的待审调整申请，返回 Map<planId, adjustment>。 */
async function getPendingAdjustments(client, planIds) {
  const result = new Map();
  const ids = [...new Set(planIds.filter((id) => id !== null && id !== undefined))];
  if (ids.length === 0) return result;
  // 动态占位符，避免不同驱动对 ANY($) 数组绑定的差异
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await client.query(
    `SELECT a.*, u.display_name AS creator_name, r.display_name AS reviewer_name
       FROM plan_adjustments a
       LEFT JOIN users u ON u.id = a.created_by
       LEFT JOIN users r ON r.id = a.reviewed_by
      WHERE a.status = 'pending' AND a.plan_id IN (${placeholders})
      ORDER BY a.id DESC`,
    ids
  );
  for (const row of rows) {
    if (!result.has(Number(row.plan_id))) result.set(Number(row.plan_id), row);
  }
  return result;
}

/**
 * 计划首个开灯时刻（毫秒）。
 */
function planFirstStart(plan) {
  return Math.min(...planWindows(plan).map((w) => w.start));
}

/** 计划是否“尚未开始”（首个开灯时刻晚于 now）。 */
function planNotStarted(plan, nowMs = Date.now()) {
  return planFirstStart(plan) > nowMs;
}

/** 调整申请的拟改开灯窗（毫秒区间）。 */
function adjustmentWindows(adj) {
  return buildWindows(
    dateYmd(adj.start_date),
    dateYmd(adj.end_date),
    parsePeriods(normalizePeriods(adj.light_periods))
  );
}

/**
 * 调整申请试算（事务内、已持有展品行锁后调用）：
 * 保管员批准时重新核对的全部规则：
 *   1) 计划仍已批准且尚未开始
 *   2) 同展品所有未作废（draft/confirmed）实测都落在新开灯窗内（本计划的实测；
 *      其他计划的窗口与本计划窗口不相交，其实测必然落在新窗外，不属于本计划核对范围）
 *   3) 新窗口不与同展品其他已批准/待复核计划的开灯时刻重叠
 *   4) 按自然年：原计划“估算残余”替换为新窗口“未被已确认实测覆盖部分”的估算剂量后，
 *      任一年不得超过年度上限（未登记上限的年份也算冲突）
 * 返回 { ok, plan, windows, conflicts:{notApproved,notStarted,outsideMeasurements,
 *          overlappingPlans, overflows, missingLimits}, oldResidueYearly, newResidueYearly,
 *          occupiedWithoutPlan, yearlyReport }
 */
async function evaluateAdjustment(client, plan, adjInput, nowMs = Date.now()) {
  const targetWindows = adjustmentWindows(adjInput);
  const conflicts = {
    notApproved: plan.status !== 'approved',
    notStarted: !planNotStarted(plan, nowMs),
    outsideMeasurements: [],
    outsideBlackouts: [],
    overlappingPlans: [],
    overflows: [],
    missingLimits: [],
  };

  // 1) 未作废实测必须完整落在某个新开灯窗内（仅核对本计划的实测）
  const { rows: measRows } = await client.query(
    `SELECT id, start_ts, end_ts, status, actual_lux
       FROM measurements
      WHERE plan_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [plan.id]
  );
  for (const m of measRows) {
    const seg = {
      start: new Date(m.start_ts).getTime(),
      end: new Date(m.end_ts).getTime(),
    };
    if (!targetWindows.some((w) => containsInterval(w, seg))) {
      conflicts.outsideMeasurements.push({
        id: m.id,
        status: m.status,
        lux: Number(m.actual_lux),
        start: tsToWallString(seg.start),
        end: tsToWallString(seg.end),
      });
    }
  }

  // 1b) 已登记停灯记录永久保留，必须同样完整落在某个新开灯窗内（停灯不可改删）
  const ownBlackoutRows = await getBlackoutRows(client, plan.exhibit_id, { planId: plan.id });
  for (const b of ownBlackoutRows) {
    const seg = {
      start: new Date(b.start_ts).getTime(),
      end: new Date(b.end_ts).getTime(),
    };
    if (!targetWindows.some((w) => containsInterval(w, seg))) {
      conflicts.outsideBlackouts.push({
        id: b.id,
        start: tsToWallString(seg.start),
        end: tsToWallString(seg.end),
        reason: b.reason,
      });
    }
  }
  const ownBlackoutAllWindows = ownBlackoutRows.map((b) => ({
    start: new Date(b.start_ts).getTime(),
    end: new Date(b.end_ts).getTime(),
  }));
  // 新窗内的本计划停灯有效区间（停灯与已确认实测业务互斥，防御性再扣实测覆盖）
  const ownBlackoutsInNew = [];
  for (const hole of ownBlackoutAllWindows) {
    for (const part of clipIntervalToWindows(hole, targetWindows)) ownBlackoutsInNew.push(part);
  }

  // 计划外照明事故：与拟改窗相交部分同样以事故实际用光替代估算（窗外部分已单独计量，不释放排期）
  const incidentView = await loadIncidentView(client, plan.exhibit_id);
  const incidentsInNew = clipIntervalToWindowsForPlan(targetWindows, incidentView.windows);
  // 共享照明归属：与拟改窗相交部分同样以共享照明实际用光替代估算
  const sharedView = await loadSharedLightingView(client, plan.exhibit_id);
  const sharedInNew = clipIntervalToWindowsForPlan(targetWindows, sharedView.windows);

  // 2) 与同展品其他已批准/待复核计划的开灯时刻重叠
  const others = await getOccupyingPlans(client, plan.exhibit_id, plan.id);
  for (const other of others) {
    if (planOverlaps(targetWindows, other)) {
      conflicts.overlappingPlans.push({
        id: other.id,
        title: other.title,
        status: other.status,
        startDate: dateYmd(other.start_date),
        endDate: dateYmd(other.end_date),
      });
    }
  }

  // 3) 按自然年替换估算残余后的额度核算
  // 本计划已确认实测覆盖的区间（draft 不计量、仍由估算占位）
  const confirmedMeas = measRows.filter((m) => m.status === 'confirmed');
  const coverers = confirmedMeas
    .map((m) => ({ start: new Date(m.start_ts).getTime(), end: new Date(m.end_ts).getTime() }))
    .filter((mw) => targetWindows.some((w) => intersects(w, mw)));
  // 新残余 = 新窗 − 已确认实测覆盖 − 落在新窗内的本计划停灯 − 与新窗相交的事故部分
  //        − 与新窗相交的共享照明归属部分（统一口径）
  const newRemaining = subtractIntervals(
    targetWindows, [...coverers, ...ownBlackoutsInNew, ...incidentsInNew, ...sharedInNew]
  );
  const newResidueYearly = yearMapToObject(doseByYear(newRemaining, Number(adjInput.estimated_lux)));

  const occupancy = await computeOccupancy(client, plan.exhibit_id, { excludePlanId: plan.id });
  const limits = occupancy.limits;
  const occupiedWithoutPlan = occupancy.used;

  // 原残余按年（与 computeOccupancy 对本计划的口径一致：原窗 − 全展品已确认实测 − 本计划停灯 − 事故窗内部分）
  const oldWindows = planWindows(plan);
  const allConfirmed = await getActiveMeasurements(client, plan.exhibit_id);
  const allMeasWindows = allConfirmed.map((m) => ({
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));
  const ownBlackoutsInOld = [];
  for (const hole of ownBlackoutAllWindows) {
    for (const part of clipIntervalToWindows(hole, oldWindows)) ownBlackoutsInOld.push(part);
  }
  const incidentsInOld = clipIntervalToWindowsForPlan(oldWindows, incidentView.windows);
  const sharedInOld = clipIntervalToWindowsForPlan(oldWindows, sharedView.windows);
  const oldRemaining = subtractIntervals(
    oldWindows,
    [
      ...allMeasWindows.filter((mw) => oldWindows.some((w) => intersects(w, mw))),
      ...ownBlackoutsInOld,
      ...incidentsInOld,
      ...sharedInOld,
    ]
  );
  const oldResidue = yearMapToObject(doseByYear(oldRemaining, Number(plan.estimated_lux)));

  // 4) 合并每个相关年份：上限、不含本计划的占用、原残余、新残余、合计、超额
  const yearsSet = new Set([
    ...Object.keys(limits),
    ...Object.keys(occupiedWithoutPlan),
    ...Object.keys(oldResidue),
    ...Object.keys(newResidueYearly),
  ].map(Number));
  const yearlyReport = {};
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = limits[key] !== undefined && limits[key] !== null ? round3(limits[key]) : null;
    const otherUsed = round3(occupiedWithoutPlan[key] || 0);
    const oldVal = round3(oldResidue[key] || 0);
    const newVal = round3(newResidueYearly[key] || 0);
    const projected = round3(otherUsed + newVal);
    const row = {
      year,
      limit,
      usedByOthers: otherUsed,
      oldResidue: oldVal,
      newResidue: newVal,
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess: null,
    };
    if (limit === null) {
      // 新残余占用了该年却没登记上限 -> 冲突
      if (newVal > 0) conflicts.missingLimits.push(Number(year));
    } else if (projected - limit > 0.005) {
      row.excess = round3(projected - limit);
      conflicts.overflows.push(row);
    }
    yearlyReport[key] = row;
  }

  const ok =
    !conflicts.notApproved &&
    !conflicts.notStarted &&
    conflicts.outsideMeasurements.length === 0 &&
    conflicts.outsideBlackouts.length === 0 &&
    conflicts.overlappingPlans.length === 0 &&
    conflicts.overflows.length === 0 &&
    conflicts.missingLimits.length === 0;

  return {
    ok,
    conflicts,
    windows: targetWindows,
    oldResidueYearly: oldResidue,
    newResidueYearly,
    occupiedWithoutPlan,
    yearlyReport,
  };
}

/**
 * 成对核准试算（事务内、已持有展品行锁后调用）：
 * 同一展品两份待审调整申请（两条不同计划）同时生效的核对：
 *   1) 两条计划都已批准且尚未开始
 *   2) 两条计划各自所有未作废（draft/confirmed）实测都落在各自新开灯窗内
 *   3) 两份拟改新窗彼此不重叠，且都不与同展品其他已批准/待复核计划的开灯时刻重叠
 *      （两条原计划都被替换，故二者不参与“其他计划”判定）
 *   4) 按自然年：两份旧估算残余同时替换为各自新窗“未被已确认实测覆盖部分”的估算量，
 *      任一年不得超过年度上限（未登记上限的年份也算冲突）
 * 组成性校验（同一计划/跨展品/申请已结案）在路由层拒绝，不进入本函数。
 * 返回 { ok, conflicts:{notStarted,notApproved,outsideMeasurements,pairOverlap,
 *        overlappingPlans,overflows,missingLimits}, items, yearlyReport }
 * items: 每份申请各自的 { adjustmentId, planId, title, oldResidueYearly, newResidueYearly }
 */
async function evaluateAdjustmentPair(client, planA, adjA, planB, adjB, nowMs = Date.now()) {
  const pair = [
    { plan: planA, adj: adjA, windows: adjustmentWindows(adjA) },
    { plan: planB, adj: adjB, windows: adjustmentWindows(adjB) },
  ];
  const conflicts = {
    notApproved: [],
    notStarted: [],
    outsideMeasurements: [],
    outsideBlackouts: [],
    pairOverlap: false,
    overlappingPlans: [],
    overflows: [],
    missingLimits: [],
  };

  // 1) 两条计划的状态与开始时刻
  for (const { plan, adj } of pair) {
    if (plan.status !== 'approved') {
      conflicts.notApproved.push({ adjustmentId: adj.id, planId: plan.id, status: plan.status });
    }
    if (!planNotStarted(plan, nowMs)) {
      conflicts.notStarted.push({ adjustmentId: adj.id, planId: plan.id });
    }
  }

  // 2) 各计划未作废实测必须完整落在各自新开灯窗内；同时收集各计划已确认实测
  const measByPlan = new Map();
  const blackoutsByPlan = new Map();
  for (const { plan, adj, windows } of pair) {
    const { rows: measRows } = await client.query(
      `SELECT id, start_ts, end_ts, status, actual_lux
         FROM measurements
        WHERE plan_id = $1 AND status <> 'annulled'
        ORDER BY id`,
      [plan.id]
    );
    measByPlan.set(Number(plan.id), measRows);
    for (const m of measRows) {
      const seg = {
        start: new Date(m.start_ts).getTime(),
        end: new Date(m.end_ts).getTime(),
      };
      if (!windows.some((w) => containsInterval(w, seg))) {
        conflicts.outsideMeasurements.push({
          adjustmentId: adj.id,
          planId: plan.id,
          id: m.id,
          status: m.status,
          lux: Number(m.actual_lux),
          start: tsToWallString(seg.start),
          end: tsToWallString(seg.end),
        });
      }
    }

    // 停灯记录永久保留，同样必须完整落在各自新开灯窗内
    const bRows = await getBlackoutRows(client, plan.exhibit_id, { planId: plan.id });
    blackoutsByPlan.set(Number(plan.id), bRows);
    for (const b of bRows) {
      const seg = {
        start: new Date(b.start_ts).getTime(),
        end: new Date(b.end_ts).getTime(),
      };
      if (!windows.some((w) => containsInterval(w, seg))) {
        conflicts.outsideBlackouts.push({
          adjustmentId: adj.id,
          planId: plan.id,
          id: b.id,
          start: tsToWallString(seg.start),
          end: tsToWallString(seg.end),
          reason: b.reason,
        });
      }
    }
  }

  // 3a) 两份拟改新窗彼此不得重叠
  conflicts.pairOverlap = anyIntersect(pair[0].windows, pair[1].windows);

  // 3b) 新窗不得与同展品其他已批准/待复核计划重叠（排除被替换的两条原计划）
  const others = (await getOccupyingPlans(client, planA.exhibit_id, null))
    .filter((p) => Number(p.id) !== Number(planA.id) && Number(p.id) !== Number(planB.id));
  for (const { plan, adj, windows } of pair) {
    for (const other of others) {
      if (anyIntersect(windows, planWindows(other))) {
        conflicts.overlappingPlans.push({
          adjustmentId: adj.id,
          planId: plan.id,
          other: {
            id: other.id,
            title: other.title,
            status: other.status,
            startDate: dateYmd(other.start_date),
            endDate: dateYmd(other.end_date),
          },
        });
      }
    }
  }

  // 4) 估算残余替换核算（口径与单份 evaluateAdjustment 一致）
  const allConfirmed = await getActiveMeasurements(client, planA.exhibit_id);
  const allMeasWindows = allConfirmed.map((m) => ({
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
  }));
  // 计划外事故：与计划窗相交部分替代估算（两条计划共用同展品事故视图）
  const incidentView = await loadIncidentView(client, planA.exhibit_id);
  // 共享照明归属：同展品同一视图，与事故同口径替代估算
  const sharedView = await loadSharedLightingView(client, planA.exhibit_id);

  const items = [];
  for (const { plan, adj, windows } of pair) {
    // 本计划全部停灯窗（登记时已保证落在原窗内且不与实测相交）
    const ownBlackoutHoles = (blackoutsByPlan.get(Number(plan.id)) || []).map((b) => ({
      start: new Date(b.start_ts).getTime(),
      end: new Date(b.end_ts).getTime(),
    }));
    const clipHoles = (targetWindows) => {
      const out = [];
      for (const hole of ownBlackoutHoles) {
        for (const part of clipIntervalToWindows(hole, targetWindows)) out.push(part);
      }
      return out;
    };

    // 原残余：原窗扣除本展品全部已确认实测覆盖、本计划停灯、事故与共享照明窗内部分（与 computeOccupancy 口径一致）
    const oldWindows = planWindows(plan);
    const oldRemaining = subtractIntervals(
      oldWindows,
      [
        ...allMeasWindows.filter((mw) => oldWindows.some((w) => intersects(w, mw))),
        ...clipHoles(oldWindows),
        ...clipIntervalToWindowsForPlan(oldWindows, incidentView.windows),
        ...clipIntervalToWindowsForPlan(oldWindows, sharedView.windows),
      ]
    );
    const oldResidueYearly = yearMapToObject(doseByYear(oldRemaining, Number(plan.estimated_lux)));

    // 新残余：新窗扣除本计划已确认实测覆盖（draft 不计量、仍由估算占位）、落在新窗内的本计划停灯
    // 与事故窗内部分
    const confirmedOwn = (measByPlan.get(Number(plan.id)) || [])
      .filter((m) => m.status === 'confirmed')
      .map((m) => ({ start: new Date(m.start_ts).getTime(), end: new Date(m.end_ts).getTime() }))
      .filter((mw) => windows.some((w) => intersects(w, mw)));
    const newRemaining = subtractIntervals(
      windows,
      [
        ...confirmedOwn,
        ...clipHoles(windows),
        ...clipIntervalToWindowsForPlan(windows, incidentView.windows),
        ...clipIntervalToWindowsForPlan(windows, sharedView.windows),
      ]
    );
    const newResidueYearly = yearMapToObject(doseByYear(newRemaining, Number(adj.estimated_lux)));

    items.push({
      adjustmentId: adj.id,
      planId: plan.id,
      title: plan.title,
      oldResidueYearly,
      newResidueYearly,
    });
  }

  // 占用基数：当前占用中包含两份旧残余，同时扣除即得“其他占用”
  const occupancy = await computeOccupancy(client, planA.exhibit_id);
  const limits = occupancy.limits;
  const yearsSet = new Set([
    ...Object.keys(limits),
    ...Object.keys(occupancy.used),
    ...items.flatMap((it) => [
      ...Object.keys(it.oldResidueYearly),
      ...Object.keys(it.newResidueYearly),
    ]),
  ].map(Number));

  const yearlyReport = {};
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = limits[key] !== undefined && limits[key] !== null ? round3(limits[key]) : null;
    const oldTotal = round3(items.reduce((s, it) => s + (it.oldResidueYearly[key] || 0), 0));
    const newTotal = round3(items.reduce((s, it) => s + (it.newResidueYearly[key] || 0), 0));
    const usedByOthers = round3((occupancy.used[key] || 0) - oldTotal);
    const projected = round3(usedByOthers + newTotal);
    // 各计划贡献（按年）：旧残余 -> 拟改残余
    const contributions = items.map((it) => ({
      adjustmentId: it.adjustmentId,
      planId: it.planId,
      title: it.title,
      oldResidue: round3(it.oldResidueYearly[key] || 0),
      newResidue: round3(it.newResidueYearly[key] || 0),
    }));
    const row = {
      year,
      limit,
      usedByOthers,
      oldResidueTotal: oldTotal,
      newResidueTotal: newTotal,
      contributions,
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess: null,
    };
    if (limit === null) {
      // 新残余占用了该年却没登记上限 -> 冲突
      if (newTotal > 0) conflicts.missingLimits.push(Number(year));
    } else if (projected - limit > 0.005) {
      row.excess = round3(projected - limit);
      conflicts.overflows.push(row);
    }
    yearlyReport[key] = row;
  }

  const ok =
    conflicts.notApproved.length === 0 &&
    conflicts.notStarted.length === 0 &&
    conflicts.outsideMeasurements.length === 0 &&
    conflicts.outsideBlackouts.length === 0 &&
    !conflicts.pairOverlap &&
    conflicts.overlappingPlans.length === 0 &&
    conflicts.overflows.length === 0 &&
    conflicts.missingLimits.length === 0;

  return { ok, conflicts, items, yearlyReport };
}

/**
 * 给计划行附加：
 *  - notStarted：首个开灯时刻是否尚未到来
 *  - pendingAdjustment：当前待审调整申请（含拟改值试算 preview，可选）
 * plans: 单行或数组；withPreview 时会做完整试算（调用方须在展品事务/只读连接均可）。
 */
async function decoratePlans(client, plansInput, { withPreview = false, nowMs = Date.now() } = {}) {
  const list = Array.isArray(plansInput) ? plansInput : [plansInput];
  if (list.length === 0) return plansInput;
  const pendingMap = await getPendingAdjustments(client, list.map((p) => p.id));
  for (const plan of list) {
    plan.not_started = plan.status === 'approved' && planNotStarted(plan, nowMs);
    plan.notStarted = plan.not_started;
    const adj = pendingMap.get(Number(plan.id));
    if (adj) {
      const base = serializeAdjustment(adj);
      if (withPreview && plan.status === 'approved' && planNotStarted(plan, nowMs)) {
        const evalResult = await evaluateAdjustment(client, plan, adj, nowMs);
        base.preview = {
          ok: evalResult.ok,
          conflicts: evalResult.conflicts,
          oldResidueYearly: evalResult.oldResidueYearly,
          newResidueYearly: evalResult.newResidueYearly,
          yearlyReport: evalResult.yearlyReport,
        };
      }
      plan.pending_adjustment = base;
      plan.pendingAdjustment = base;
    } else {
      plan.pending_adjustment = null;
      plan.pendingAdjustment = null;
    }
  }
  return plansInput;
}

/** 调整申请的对外字段（驼峰）。 */
function serializeAdjustment(a) {
  if (!a) return null;
  return {
    id: a.id,
    planId: a.plan_id,
    exhibitId: a.exhibit_id,
    startDate: dateYmd(a.start_date),
    endDate: dateYmd(a.end_date),
    periods: normalizePeriods(a.light_periods),
    estimatedLux: Number(a.estimated_lux),
    reason: a.reason,
    status: a.status,
    rejectReason: a.reject_reason,
    createdBy: a.created_by,
    creatorName: a.creator_name || null,
    reviewedBy: a.reviewed_by,
    reviewerName: a.reviewer_name || null,
    reviewedAt: a.reviewed_at,
    createdAt: a.created_at,
    planTitle: a.plan_title || null,
    exhibitName: a.exhibit_name || null,
    // 原值（列表/详情联表带出处）
    original: a.original || null,
  };
}

// ---------------------------------------------------------------------------
// 下调年度上限：预演核算
// ---------------------------------------------------------------------------

/**
 * 预演把某展品某自然年上限降到 proposedLimit 后的额度核算（不写库）。
 * 返回内容：
 *  - 该年已确认实测（逐条，含按年剂量）
 *  - 各已批准/待复核计划在该年的估算残余
 *  - 预计合计/剩余/超额量
 *  - 超额时仍在该年有估算残余且尚未开始的已批准计划（flagCandidates）
 *  - fingerprint：当前占用快照指纹（供预演凭证校验“额度或相关占用是否已变化”）
 *
 * 口径与 computeOccupancy 完全一致（已确认实测 + 计划估算残余）。
 * 该年尚未登记上限时返回 400（下调必须针对既有上限；登记新上限请用 limits 接口）。
 */
async function computeLimitPreview(client, exhibitId, year, proposedLimit, { nowMs = Date.now() } = {}) {
  const yearStr = String(year);
  const { rows: limitRows } = await client.query(
    'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1 AND year = $2 FOR UPDATE',
    [exhibitId, year]
  );
  if (limitRows.length === 0) {
    throw new ValidationError(`${year} 年尚未登记年度上限，不能下调；请先登记该年度上限`);
  }
  const currentLimit = round3(Number(limitRows[0].limit_lxh));

  const occupancy = await computeOccupancy(client, exhibitId);
  const used = round3(occupancy.used[yearStr] || 0);
  const excess = used - proposedLimit > 0.005 ? round3(used - proposedLimit) : 0;

  // 该年已确认实测（仅列在该年剂量 > 0 的，避免无关年份噪音）
  const confirmedMeasurements = occupancy.sources
    .filter((s) => s.kind === 'measurement' && (s.yearly[yearStr] || 0) > 0)
    .map((s) => ({
      id: s.id,
      planId: s.planId,
      start: s.start,
      end: s.end,
      lux: s.lux,
      yearDose: round3(s.yearly[yearStr]),
      yearly: s.yearly,
    }));

  // 各已批准/待复核计划在该年的估算残余
  const planById = new Map(occupancy.plans.map((p) => [p.id, p]));
  const planResidues = occupancy.sources
    .filter((s) => s.kind === 'plan' && (s.yearly[yearStr] || 0) > 0)
    .map((s) => {
      const firstStart = Math.min(...planWindows(planById.get(s.id)).map((w) => w.start));
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        startDate: s.startDate,
        endDate: s.endDate,
        periods: normalizePeriods(s.periods),
        lux: s.lux,
        yearResidue: round3(s.yearly[yearStr]),
        firstStart: tsToWallString(firstStart),
        notStarted: s.status === 'approved' && firstStart > nowMs,
      };
    });

  // 超额时：仍在该年有估算残余、且尚未开始的已批准计划（下调成功后将转待复核）
  const flagCandidates = excess > 0
    ? planResidues.filter((p) => p.status === 'approved' && p.notStarted)
    : [];
  // 已开始但仍占用该年残余的计划：不转状态，但剩余超额仍如实显示
  const startedResiduePlans = excess > 0
    ? planResidues.filter((p) => p.status === 'approved' && !p.notStarted)
    : [];

  // 该年各条停灯记录的估算扣减量（与占用口径一致；已取消计划的停灯 deductionActive=false）
  const blackoutDeductions = (occupancy.blackouts || [])
    .filter((b) => (b.yearly[yearStr] || 0) > 0)
    .map((b) => ({
      id: b.id,
      planId: b.planId,
      planTitle: b.planTitle,
      planStatus: b.planStatus,
      start: b.start,
      end: b.end,
      reason: b.reason,
      yearDeduction: round3(b.yearly[yearStr]),
      active: b.deductionActive,
    }));

  // ---- 凭证指纹快照：覆盖上限/未作废实测/占用计划/时刻 ----
  const { rows: allMeasRows } = await client.query(
    `SELECT id, plan_id, start_ts, end_ts, actual_lux, status
       FROM measurements
      WHERE exhibit_id = $1 AND status <> 'annulled'
      ORDER BY id`,
    [exhibitId]
  );
  const fingerprintMeasures = allMeasRows.map((m) => ({
    id: m.id,
    planId: m.plan_id,
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
    status: m.status,
  }));
  const fingerprintPlans = occupancy.plans.map((p) => ({
    id: p.id,
    status: p.status,
    startDate: dateYmd(p.start_date),
    endDate: dateYmd(p.end_date),
    periods: normalizePeriods(p.light_periods),
    lux: Number(p.estimated_lux),
    yearResidue: round3(
      (occupancy.sources.find((s) => s.kind === 'plan' && s.id === p.id) || { yearly: {} })
        .yearly[yearStr] || 0
    ),
  }));
  // 此刻已开始（首个开灯时刻已过）的已批准计划 id：时间相关状态仅体现在这里
  const startedPlanIds = occupancy.plans
    .filter((p) => p.status === 'approved')
    .filter((p) => Math.min(...planWindows(p).map((w) => w.start)) <= nowMs)
    .map((p) => p.id)
    .sort((a, b) => a - b);

  // 停灯记录也属于“相关占用”：新增/变化须使旧预演凭证失效
  const fingerprintBlackouts = (occupancy.blackouts || []).map((b) => ({
    id: b.id,
    planId: b.planId,
    start: b.start,
    end: b.end,
    yearly: b.yearly,
    active: b.deductionActive,
  }));

  // 计划外照明事故始终计入实际用光：新增/变化须使旧预演凭证失效
  const incidentDoses = (occupancy.incidents || [])
    .filter((x) => (x.yearly[yearStr] || 0) > 0)
    .map((x) => ({
      id: x.id,
      start: x.start,
      end: x.end,
      lux: x.actualLux,
      yearDose: round3(x.yearly[yearStr]),
      yearInside: round3(x.yearlyInside[yearStr] || 0),
      yearOutside: round3(x.yearlyOutside[yearStr] || 0),
      insidePlanIds: x.insidePlanIds,
      reason: x.reason,
    }));
  const fingerprintIncidents = (occupancy.incidents || []).map((x) => ({
    id: x.id,
    start: x.start,
    end: x.end,
    lux: x.actualLux,
    yearly: x.yearly,
    yearlyInside: x.yearlyInside,
    yearlyOutside: x.yearlyOutside,
    insidePlanIds: x.insidePlanIds,
  }));

  // 共享照明归属始终计入实际用光：新增/变化同样须使旧预演凭证失效
  const sharedLightingDoses = (occupancy.sharedLightings || [])
    .filter((x) => (x.yearly[yearStr] || 0) > 0)
    .map((x) => ({
      id: x.id,
      hallCode: x.hallCode,
      start: x.start,
      end: x.end,
      lux: x.actualLux,
      yearDose: round3(x.yearly[yearStr]),
      yearInside: round3(x.yearlyInside[yearStr] || 0),
      yearOutside: round3(x.yearlyOutside[yearStr] || 0),
      insidePlanIds: x.insidePlanIds,
      reason: x.reason,
    }));
  const fingerprintSharedLightings = (occupancy.sharedLightings || []).map((x) => ({
    id: x.id,
    hallCode: x.hallCode,
    start: x.start,
    end: x.end,
    lux: x.actualLux,
    yearly: x.yearly,
    yearlyInside: x.yearlyInside,
    yearlyOutside: x.yearlyOutside,
    insidePlanIds: x.insidePlanIds,
  }));

  return {
    exhibitId,
    year,
    currentLimit,
    proposedLimit: round3(proposedLimit),
    used,
    remaining: round3(proposedLimit - used),
    excess,
    over: excess > 0,
    confirmedMeasurements,
    incidents: incidentDoses,
    sharedLightings: sharedLightingDoses,
    planResidues,
    blackoutDeductions,
    flagCandidates,
    startedResiduePlans,
    signature: {
      currentLimit,
      measurements: fingerprintMeasures,
      plans: fingerprintPlans,
      blackouts: fingerprintBlackouts,
      incidents: fingerprintIncidents,
      sharedLightings: fingerprintSharedLightings,
      startedPlanIds,
    },
  };
}

// ---------------------------------------------------------------------------
// 联合核准：多条待批准计划一次试算 / 一次批准
// ---------------------------------------------------------------------------

/** 按 id 批量取计划（动态占位符，兼容内存驱动）。 */
async function getPlansByIds(client, ids) {
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await client.query(
    `SELECT * FROM plans WHERE id IN (${placeholders}) ORDER BY id`,
    ids
  );
  return rows;
}

/**
 * 联合核准试算（事务内、已持有全部涉及展品行锁后调用）：
 * 传入按提交顺序排列的计划行，统一核对：
 *   1) 每条计划仍处于 submitted（待批准；已批准/待复核/驳回/取消都不能进入联合核准）
 *   2) 组内同展品计划的开灯窗彼此不重叠
 *   3) 每条计划的开灯窗不与同展品其他已批准/待复核计划重叠
 *   4) 按现有口径（已确认实测替代估算、本计划停灯扣减）把组内同展品各计划的
 *      年度残余合并到当前占用（不含组内计划），任一自然年超过年度上限即冲突
 *      （该年未登记上限同样冲突）
 * 返回：
 *   { ok, exhibitIds, items, exhibits, conflicts }
 * conflicts: {
 *   notSubmitted: [{planId,status}],
 *   internalOverlaps: [{planId,otherPlanId}],
 *   overlappingPlans: [{planId,other:{id,title,status,startDate,endDate}}],
 *   missingLimits: [{planId,year}],
 *   overflows: [{exhibitId,year,limit,usedByOthers,groupResidue,
 *                project,excess,contributions:[{planId,title,residue}]}]
 * }
 */
async function evaluatePlanBatch(client, orderedPlans, nowMs = Date.now()) {
  void nowMs;
  const conflicts = {
    notSubmitted: [],
    internalOverlaps: [],
    overlappingPlans: [],
    missingLimits: [],
    overflows: [],
  };

  // 1) 状态核对（只有待批准计划可参与联合核准）
  for (const plan of orderedPlans) {
    if (plan.status !== 'submitted') {
      conflicts.notSubmitted.push({ planId: plan.id, status: plan.status });
    }
  }

  const windowsById = new Map();
  for (const plan of orderedPlans) windowsById.set(Number(plan.id), planWindows(plan));

  // 按展品分组（保持组内顺序）
  const byExhibit = new Map();
  for (const plan of orderedPlans) {
    const exId = Number(plan.exhibit_id);
    if (!byExhibit.has(exId)) byExhibit.set(exId, []);
    byExhibit.get(exId).push(plan);
  }

  // 2) 组内同展品开灯窗两两不重叠（端点相接不算重叠，与既有口径一致）
  for (const group of byExhibit.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (anyIntersect(windowsById.get(Number(a.id)), windowsById.get(Number(b.id)))) {
          conflicts.internalOverlaps.push({
            planId: a.id,
            planTitle: a.title,
            otherPlanId: b.id,
            otherPlanTitle: b.title,
          });
        }
      }
    }
  }

  // 每件展品：当前占用（不含组内计划）、上限、已确认实测窗、停灯视图
  const occByExhibit = new Map();
  for (const exId of byExhibit.keys()) {
    const groupIds = new Set(byExhibit.get(exId).map((p) => Number(p.id)));
    const occupancy = await computeOccupancy(client, exId, {
      excludePlanId: null,
    });
    // computeOccupancy 只排除单个 id；组内计划均为 submitted，本就不在占用计划中，
    // 这里再按 id 过滤一次以锁定口径、防御状态差异。
    const occPlans = occupancy.plans.filter((p) => !groupIds.has(Number(p.id)));
    const measurements = await getActiveMeasurements(client, exId);
    const measWindows = measurements.map((m) => ({
      start: new Date(m.start_ts).getTime(),
      end: new Date(m.end_ts).getTime(),
    }));
    const blackoutView = await loadBlackoutView(client, exId, { confirmedRows: measurements });
    const incidentView = await loadIncidentView(client, exId);
    const sharedView = await loadSharedLightingView(client, exId);
    occByExhibit.set(exId, { occupancy, occPlans, measWindows, blackoutView, incidentView, sharedView });
  }

  // 3) 每条计划不与同展品其他已批准/待复核计划重叠
  for (const [exId, group] of byExhibit) {
    const { occPlans } = occByExhibit.get(exId);
    for (const plan of group) {
      for (const other of occPlans) {
        if (anyIntersect(windowsById.get(Number(plan.id)), planWindows(other))) {
          conflicts.overlappingPlans.push({
            planId: plan.id,
            planTitle: plan.title,
            other: {
              id: other.id,
              title: other.title,
              status: other.status,
              startDate: dateYmd(other.start_date),
              endDate: dateYmd(other.end_date),
            },
          });
        }
      }
    }
  }

  // 4) 估算残余合并校验（口径与单条批准/占用查询完全一致）
  const items = [];
  const exhibitsReport = [];
  for (const [exId, group] of byExhibit) {
    const { occupancy, measWindows, blackoutView, incidentView, sharedView } = occByExhibit.get(exId);
    // 不含组内计划的当前占用（组内均为 submitted，occupancy.used 即“原占用”，防御性重算）
    const usedByOthers = {};
    for (const src of occupancy.sources) {
      if (src.kind === 'plan' && group.some((p) => Number(p.id) === Number(src.id))) continue;
      addYearDose(usedByOthers, src.yearly);
    }

    const groupResidueYearly = {};
    const itemEntries = group.map((plan) => {
      const windows = windowsById.get(Number(plan.id));
      const grossYearly = yearMapToObject(doseByYear(windows, Number(plan.estimated_lux)));
      const coverers = measWindows.filter((mw) => windows.some((w) => intersects(w, mw)));
      const blackouts = blackoutView.windowsByPlan.get(Number(plan.id)) || [];
      const incidents = clipIntervalToWindowsForPlan(windows, incidentView.windows);
      const shared = clipIntervalToWindowsForPlan(windows, sharedView.windows);
      const remaining = subtractIntervals(windows, [
        ...coverers, ...blackouts, ...incidents, ...shared,
      ]);
      const residueYearly = yearMapToObject(doseByYear(remaining, Number(plan.estimated_lux)));
      addYearDose(groupResidueYearly, residueYearly);
      return { plan, windows, grossYearly, residueYearly };
    });

    for (const entry of itemEntries) {
      items.push({
        planId: entry.plan.id,
        title: entry.plan.title,
        exhibitId: exId,
        status: entry.plan.status,
        startDate: dateYmd(entry.plan.start_date),
        endDate: dateYmd(entry.plan.end_date),
        periods: normalizePeriods(entry.plan.light_periods),
        lux: Number(entry.plan.estimated_lux),
        grossEstimateYearly: entry.grossYearly,
        residueYearly: entry.residueYearly,
        yearly: buildItemYearly(occupancy.limits, usedByOthers, groupResidueYearly, entry),
      });
    }

    const yearsSet = new Set([
      ...Object.keys(occupancy.limits),
      ...Object.keys(usedByOthers),
      ...Object.keys(groupResidueYearly),
    ].map(Number));
    const yearlyReport = {};
    for (const year of [...yearsSet].sort((a, b) => a - b)) {
      const key = String(year);
      const limit = occupancy.limits[key] !== undefined && occupancy.limits[key] !== null
        ? round3(occupancy.limits[key]) : null;
      const otherUsed = round3(usedByOthers[key] || 0);
      const groupUsed = round3(groupResidueYearly[key] || 0);
      const projected = round3(otherUsed + groupUsed);
      const contributions = itemEntries.map((e) => ({
        planId: e.plan.id,
        title: e.plan.title,
        residue: round3(e.residueYearly[key] || 0),
      })).filter((c) => c.residue > 0);
      const row = {
        year,
        limit,
        usedByOthers: otherUsed,
        groupResidue: groupUsed,
        contributions,
        projected,
        remainingAfter: limit === null ? null : round3(limit - projected),
        excess: null,
      };
      if (limit === null) {
        if (groupUsed > 0) {
          for (const c of contributions) {
            conflicts.missingLimits.push({ planId: c.planId, exhibitId: exId, year });
          }
        }
      } else if (projected - limit > 0.005) {
        row.excess = round3(projected - limit);
        conflicts.overflows.push({
          exhibitId: exId,
          year,
          limit,
          usedByOthers: otherUsed,
          groupResidue: groupUsed,
          projected,
          excess: row.excess,
          contributions,
        });
      }
      yearlyReport[key] = row;
    }
    exhibitsReport.push({ exhibitId: exId, yearlyReport });
  }

  const ok =
    conflicts.notSubmitted.length === 0 &&
    conflicts.internalOverlaps.length === 0 &&
    conflicts.overlappingPlans.length === 0 &&
    conflicts.missingLimits.length === 0 &&
    conflicts.overflows.length === 0;

  return { ok, exhibitIds: [...byExhibit.keys()], items, exhibits: exhibitsReport, conflicts };
}

/** 单条计划视角的按年行：上限 / 原占用 / 本计划新增估算 / 组内合计 / 合并后合计 / 超额。 */
function buildItemYearly(limits, usedByOthers, groupResidueYearly, entry) {
  const yearsSet = new Set([
    ...Object.keys(limits),
    ...Object.keys(usedByOthers),
    ...Object.keys(groupResidueYearly),
    ...Object.keys(entry.residueYearly),
    ...Object.keys(entry.grossYearly),
  ].map(Number));
  const yearly = {};
  for (const year of [...yearsSet].sort((a, b) => a - b)) {
    const key = String(year);
    const limit = limits[key] !== undefined && limits[key] !== null ? round3(limits[key]) : null;
    const otherUsed = round3(usedByOthers[key] || 0);
    const groupUsed = round3(groupResidueYearly[key] || 0);
    const residue = round3(entry.residueYearly[key] || 0);
    const gross = round3(entry.grossYearly[key] || 0);
    const projected = round3(otherUsed + groupUsed);
    yearly[key] = {
      year,
      limit,
      usedByOthers: otherUsed,
      grossEstimate: gross,
      addedResidue: residue,
      groupResidue: groupUsed,
      projected,
      remainingAfter: limit === null ? null : round3(limit - projected),
      excess: limit === null
        ? null
        : (projected - limit > 0.005 ? round3(projected - limit) : null),
      missingLimit: limit === null && residue > 0,
    };
  }
  return yearly;
}

/** 联合核对失败原因（中文，错误信息与页面共用）。 */
function batchConflictMessages(evalResult, planTitleById) {
  const c = evalResult.conflicts;
  const parts = [];
  for (const x of c.notSubmitted) {
    parts.push(`计划 #${x.planId}「${planTitleById.get(x.planId) || ''}」已不是待批准状态（当前：${x.status}）`);
  }
  for (const x of c.internalOverlaps) {
    parts.push(
      `组内计划「${x.planTitle}」(#${x.planId}) 与「${x.otherPlanTitle}」(#${x.otherPlanId}) 的开灯时间彼此重叠`
    );
  }
  for (const x of c.overlappingPlans) {
    parts.push(
      `组内计划「${x.planTitle}」(#${x.planId}) 与同展品${x.other.status === 'pending_review' ? '待复核' : '已批准'}` +
      `计划「${x.other.title}」(#${x.other.id}) 的开灯时间重叠`
    );
  }
  const missingSeen = new Set();
  for (const x of c.missingLimits) {
    const sig = `${x.planId}:${x.year}`;
    if (missingSeen.has(sig)) continue;
    missingSeen.add(sig);
    parts.push(`计划 #${x.planId}「${planTitleById.get(x.planId) || ''}」占用的 ${x.year} 年尚未登记年度额度`);
  }
  for (const o of c.overflows) {
    const contrib = o.contributions.map((ct) => `计划 #${ct.planId} 残余 ${ct.residue}`).join('，');
    parts.push(
      `展品 #${o.exhibitId} ${o.year} 年：上限 ${o.limit}，原占用 ${o.usedByOthers}，` +
        `组内新增残余合计 ${o.groupResidue}（${contrib}），合并后合计 ${o.projected}，超额 ${o.excess} lx·h`
    );
  }
  return parts;
}

module.exports = {
  ACTIVE_PLAN_STATUSES,
  yearsToRanges,
  yearsOfInterval,
  yearsOfIntervals,
  buildRangeClauses,
  lockExhibit,
  getPlan,
  getOccupyingPlans,
  dateYmd,
  planWindows,
  planResidueYearly,
  findOverlappingMeasurement,
  findOverlappingBlackout,
  findOverlappingIncident,
  getBlackoutRows,
  loadBlackoutView,
  getIncidentRows,
  loadIncidentView,
  registerBlackout,
  registerIncident,
  clipIntervalToWindowsForPlan,
  // 展厅驻留 / 共享照明（规则 19）
  getHallByCode,
  getHallById,
  getResidenceRows,
  loadResidenceView,
  getResidencesIntersecting,
  registerResidence,
  getSharedLightingAllocationRows,
  loadSharedLightingView,
  registerSharedLighting,
  findOverlappingSharedLighting,
  findOverlappingSharedLightings,
  planResidueYearlyWithShared,
  computeOccupancy,
  buildOverflows,
  planOverlaps,
  validateMeasurementWindow,
  correctMeasurement,
  plansToFlag,
  overflowInfoFromOccupancy,
  flagPlansForOverflow,
  evaluateMeasurementBatch,
  computeLimitPreview,
  yearOfTs,
  // 调整申请
  normalizeScheduleInput,
  getPendingAdjustment,
  getPendingAdjustments,
  planFirstStart,
  planNotStarted,
  adjustmentWindows,
  evaluateAdjustment,
  evaluateAdjustmentPair,
  decoratePlans,
  serializeAdjustment,
  // 联合核准
  getPlansByIds,
  evaluatePlanBatch,
  batchConflictMessages,
};
