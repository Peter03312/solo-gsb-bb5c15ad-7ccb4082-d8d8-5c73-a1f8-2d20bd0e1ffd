'use strict';

/*
 * 年度占用派生结果：统一的“按受影响自然年局部重算”机制。
 *
 * 设计要点：
 *  - 占用口径与历史 computeOccupancy 完全一致（同一套剂量算法、同一 round3 舍入）：
 *      used[year] = Σ 已确认实测
 *                 + Σ 计划外照明事故实际用光
 *                 + Σ 共享照明归属实际用光
 *                 + Σ 已批准/待复核计划“开灯窗 − 已确认实测覆盖 − 本计划停灯
 *                    − 事故窗内部分 − 共享照明窗内部分”的估算残余。
 *  - 年度合计（annual_occupancy）与逐项来源（annual_occupancy_items）是唯一的占用来源，
 *    展品详情、审批/调整/联合核准试算、下调预演、账册封存对照、分级预警都读这里。
 *  - 每次业务变更（计划批准/取消/调整、实测确认/纠错、批次确认、停灯、事故、共享照明、
 *    上限变更引发的转待复核）在“原有展品/展厅锁事务内”调用 recomputeOccupancyYears：
 *    只加载并重算受影响自然年（跨年记录影响到的年份一并给出），在同一事务内
 *    “删除该展品这些年份的旧派生行 → 按最新原始记录重算 → 整批写入”，
 *    因此作废/替换天然是“先撤回旧贡献、再计入新贡献”，对外绝不会出现新旧占用混杂；
 *    事务失败全部回滚（多展品操作的占用结果与预警事件同样随事务回滚）。
 *  - rebuildOccupancyStore 用全部原始记录一次性重建所有展品所有年份：单事务提交，
 *    失败即报错回滚；既有数据可随时据此重建。
 */

const { parsePeriods } = require('./validation');
const config = require('./config');
const {
  buildWindows,
  doseByYear,
  subtractIntervals,
  yearMapToObject,
  intersects,
  clipIntervalToWindows,
  round3,
  tsToWallString,
} = require('./dosing');

const ACTIVE_PLAN_STATUSES = ['approved', 'pending_review'];
const KIND_MEASUREMENT = 'measurement';
const KIND_INCIDENT = 'incident';
const KIND_SHARED = 'sharedLighting';
const KIND_PLAN = 'plan';

/** DATE 值兼容：真实 pg 返回 'YYYY-MM-DD'，pg-mem 可能返回 Date。 */
function dateYmd(v) {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, '0')}-${String(
      v.getUTCDate()
    ).padStart(2, '0')}`;
  }
  return v;
}

/** JSONB 兼容：真实 pg 给数组/对象，pg-mem 可能给字符串。 */
function normalizeJson(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  }
  return value;
}

function planWindows(plan) {
  return buildWindows(
    dateYmd(plan.start_date),
    dateYmd(plan.end_date),
    parsePeriods(normalizeJson(plan.light_periods))
  );
}

/** 计划开灯窗覆盖到的全部自然年。 */
function planWindowYears(plan) {
  const years = new Set();
  for (const w of planWindows(plan)) {
    // splitMinutesByYear 同口径：直接沿窗切年界
    let cur = w.start;
    while (cur < w.end) {
      const y = new Date(cur + config.tzOffsetMs).getUTCFullYear();
      years.add(y);
      const boundary = Date.UTC(y + 1, 0, 1) - config.tzOffsetMs;
      cur = boundary < w.end ? boundary : w.end;
    }
  }
  return [...years].sort((a, b) => a - b);
}

/** 受影响年份的墙上 [起, 止) 毫秒（最小年年初 ~ 最大年年末）。 */
function yearsBounds(years) {
  const min = Math.min(...years);
  const max = Math.max(...years);
  return {
    start: Date.UTC(min, 0, 1) - config.tzOffsetMs,
    end: Date.UTC(max + 1, 0, 1) - config.tzOffsetMs,
  };
}

function inClause(n, offset = 1) {
  return Array.from({ length: n }, (_, i) => `$${offset + i}`).join(',');
}

// ---------------------------------------------------------------------------
// 原始数据加载（年份局部：只取与受影响年份时间窗相交的历史记录）
// ---------------------------------------------------------------------------

/**
 * 加载一件展品重算所需的原始数据。
 * years 为 null 时全量加载（重建用）；否则只加载与这些自然年时间窗相交的记录，
 * 不扫描无关年份的历史。
 */
async function loadBundle(client, exhibitId, years) {
  const statusList = ACTIVE_PLAN_STATUSES.map((s) => `'${s}'`).join(',');
  const { rows: plans } = await client.query(
    `SELECT * FROM plans
      WHERE exhibit_id = $1 AND status IN (${statusList})
      ORDER BY id`,
    [exhibitId]
  );

  // 受影响年份内有开灯窗的计划（计划残余的承担者；停灯也按这些计划加载）
  let scopedPlans = plans;
  if (years !== null) {
    const yearSet = new Set(years);
    scopedPlans = plans.filter((p) => planWindowYears(p).some((y) => yearSet.has(y)));
  }
  const planIds = [...new Set(scopedPlans.map((p) => Number(p.id)))];

  const bounds = years === null ? null : yearsBounds(years);

  // 已确认实测（按时间窗与受影响年份相交）
  let measurements = [];
  if (years === null) {
    const r = await client.query(
      `SELECT m.*, p.status AS plan_status
         FROM measurements m JOIN plans p ON p.id = m.plan_id
        WHERE m.exhibit_id = $1 AND m.status = 'confirmed'
        ORDER BY m.start_ts, m.id`,
      [exhibitId]
    );
    measurements = r.rows;
  } else {
    const r = await client.query(
      `SELECT m.*, p.status AS plan_status
         FROM measurements m JOIN plans p ON p.id = m.plan_id
        WHERE m.exhibit_id = $1 AND m.status = 'confirmed'
          AND m.start_ts < $2 AND m.end_ts > $3
        ORDER BY m.start_ts, m.id`,
      [exhibitId, new Date(bounds.end), new Date(bounds.start)]
    );
    measurements = r.rows;
  }

  // 停灯：只加载受影响计划的记录（停灯永久保留，但仅占用中计划的停灯参与扣减），
  // 再按时间窗与受影响年份相交过滤。
  let blackoutRows = [];
  if (planIds.length > 0) {
    const ph = inClause(planIds.length, 2);
    if (years === null) {
      const sql = `SELECT b.*, p.title AS plan_title, p.status AS plan_status,
                          p.start_date AS plan_start_date, p.end_date AS plan_end_date,
                          p.light_periods AS plan_light_periods, p.estimated_lux AS plan_estimated_lux
                     FROM blackouts b JOIN plans p ON p.id = b.plan_id
                    WHERE b.exhibit_id = $1 AND b.plan_id IN (${ph})
                    ORDER BY b.start_ts, b.id`;
      blackoutRows = (await client.query(sql, [exhibitId, ...planIds])).rows;
    } else {
      // $1=exhibitId，$2..$(n+1)=planIds，随后两个时间参数为 $(n+2)、$(n+3)
      const endParam = planIds.length + 2;
      const sql = `SELECT b.*, p.title AS plan_title, p.status AS plan_status,
                          p.start_date AS plan_start_date, p.end_date AS plan_end_date,
                          p.light_periods AS plan_light_periods, p.estimated_lux AS plan_estimated_lux
                     FROM blackouts b JOIN plans p ON p.id = b.plan_id
                    WHERE b.exhibit_id = $1 AND b.plan_id IN (${ph})
                      AND b.start_ts < $${endParam} AND b.end_ts > $${endParam + 1}
                    ORDER BY b.start_ts, b.id`;
      blackoutRows = (await client.query(sql, [
        exhibitId, ...planIds, new Date(bounds.end), new Date(bounds.start),
      ])).rows;
    }
  }

  // 计划外照明事故（按时间窗相交）
  let incidents = [];
  if (years === null) {
    incidents = (await client.query(
      'SELECT * FROM lighting_incidents WHERE exhibit_id = $1 ORDER BY start_ts, id',
      [exhibitId]
    )).rows;
  } else {
    incidents = (await client.query(
      `SELECT * FROM lighting_incidents
        WHERE exhibit_id = $1 AND start_ts < $2 AND end_ts > $3
        ORDER BY start_ts, id`,
      [exhibitId, new Date(bounds.end), new Date(bounds.start)]
    )).rows;
  }

  // 共享照明归属（按时间窗相交），并带上共享照明主记录
  let allocations = [];
  if (years === null) {
    allocations = (await client.query(
      `SELECT * FROM shared_lighting_allocations
        WHERE exhibit_id = $1 ORDER BY start_ts, id`,
      [exhibitId]
    )).rows;
  } else {
    allocations = (await client.query(
      `SELECT * FROM shared_lighting_allocations
        WHERE exhibit_id = $1 AND start_ts < $2 AND end_ts > $3
        ORDER BY start_ts, id`,
      [exhibitId, new Date(bounds.end), new Date(bounds.start)]
    )).rows;
  }
  const sessionIds = [...new Set(allocations.map((a) => Number(a.session_id)))];
  const sessions = new Map();
  if (sessionIds.length > 0) {
    const ph = inClause(sessionIds.length, 1);
    const { rows } = await client.query(
      `SELECT s.*, h.hall_code FROM shared_lightings s
         JOIN halls h ON h.id = s.hall_id
        WHERE s.id IN (${ph})`,
      sessionIds
    );
    for (const r of rows) sessions.set(Number(r.id), r);
  }

  // 上限（局部重算只取受影响年份；全量取全部）
  let limitRows;
  if (years === null) {
    limitRows = (await client.query(
      'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1',
      [exhibitId]
    )).rows;
  } else {
    const ys = [...new Set(years)].sort((a, b) => a - b);
    const ph = inClause(ys.length, 2);
    limitRows = (await client.query(
      `SELECT year, limit_lxh FROM annual_limits
        WHERE exhibit_id = $1 AND year IN (${ph})`,
      [exhibitId, ...ys]
    )).rows;
  }
  const limits = {};
  for (const r of limitRows) limits[String(r.year)] = Number(r.limit_lxh);

  return {
    exhibitId,
    years: years === null ? null : [...new Set(years)],
    plans,
    scopedPlans,
    measurements,
    blackoutRows,
    incidents,
    allocations,
    sessions,
    limits,
  };
}

// ---------------------------------------------------------------------------
// 纯几何计算：bundle -> 各年合计 + 各来源逐年片段（与历史 computeOccupancy 同口径）
// ---------------------------------------------------------------------------

function clipToPlanWindows(planWinList, holes) {
  const parts = [];
  for (const hole of holes) {
    for (const part of clipIntervalToWindows(hole, planWinList)) parts.push(part);
  }
  return parts.length === 0 ? [] : subtractIntervals(parts, []);
}

/**
 * 按 bundle 计算占用。extraMeasWindows 为预演用的“尚未确认/即将确认”实测窗
 * （确认前预演、批次预览用），与历史 computeOccupancy 的 extraMeasurement(s) 同口径。
 * 返回 { years:Set, totalsByYear:Map, fragments:Map<year, [{sourceKey,kind,id,payload}]> }
 */
function computeBundle(bundle, extraMeasWindows = []) {
  const { scopedPlans, measurements, blackoutRows, incidents, allocations, sessions } = bundle;

  const allMeasWindows = measurements.map((m) => ({
    id: Number(m.id),
    planId: Number(m.plan_id),
    start: new Date(m.start_ts).getTime(),
    end: new Date(m.end_ts).getTime(),
    lux: Number(m.actual_lux),
  }));
  for (const em of extraMeasWindows) {
    allMeasWindows.push({ id: em.id || -1, planId: Number(em.planId), start: em.start, end: em.end, lux: em.lux, extra: true });
  }

  // 各计划开灯窗（仅受影响计划需要参与残余计算）
  const windowsById = new Map();
  for (const p of scopedPlans) windowsById.set(Number(p.id), planWindows(p));

  // 本计划停灯的有效扣减窗：停灯 ∩ 计划窗 − 已确认实测覆盖（与历史 loadBlackoutView
  // 完全同口径：用该展品全部已确认实测做防御性覆盖扣减；业务上停灯与实测互斥）。
  const blackoutWindowsByPlan = new Map();
  for (const b of blackoutRows) {
    const pid = Number(b.plan_id);
    const pWindows = windowsById.get(pid);
    if (!pWindows) continue;
    const seg = { start: new Date(b.start_ts).getTime(), end: new Date(b.end_ts).getTime() };
    const clipped = clipIntervalToWindows(seg, pWindows);
    const eff = subtractIntervals(clipped, allMeasWindows);
    if (!blackoutWindowsByPlan.has(pid)) blackoutWindowsByPlan.set(pid, []);
    blackoutWindowsByPlan.get(pid).push(...eff);
  }

  // 事故时间窗（全额实际用光）
  const incidentWindows = incidents.map((x) => ({
    id: Number(x.id),
    start: new Date(x.start_ts).getTime(),
    end: new Date(x.end_ts).getTime(),
    lux: Number(x.actual_lux),
  }));
  // 共享照明归属时间窗
  const sharedWindows = allocations.map((a) => ({
    id: Number(a.id),
    sessionId: Number(a.session_id),
    start: new Date(a.start_ts).getTime(),
    end: new Date(a.end_ts).getTime(),
    lux: Number(a.actual_lux),
  }));

  const totalsByYear = new Map();
  const ensureTotal = (year) => {
    if (!totalsByYear.has(year)) {
      totalsByYear.set(year, { used: 0, measurement: 0, incident: 0, shared: 0, residue: 0 });
    }
    return totalsByYear.get(year);
  };
  const addTot = (year, field, dose) => {
    const t = ensureTotal(year);
    t[field] = round3(t[field] + dose);
    t.used = round3(t.used + dose);
  };
  const fragments = new Map();
  const addFragment = (year, frag) => {
    if (!fragments.has(year)) fragments.set(year, []);
    fragments.get(year).push(frag);
  };
  const years = new Set();
  const touchYears = (yearly) => {
    for (const y of Object.keys(yearly)) years.add(Number(y));
  };

  // 1) 已确认实测（预演实测同口径计入）
  for (const mw of allMeasWindows) {
    const yearly = yearMapToObject(doseByYear([{ start: mw.start, end: mw.end }], mw.lux));
    touchYears(yearly);
    for (const [y, d] of Object.entries(yearly)) addTot(Number(y), 'measurement', d);
    for (const [yStr, d] of Object.entries(yearly)) {
      addFragment(Number(yStr), {
        sourceKey: `${KIND_MEASUREMENT}:${mw.id}`,
        kind: KIND_MEASUREMENT,
        id: mw.id,
        payload: {
          kind: KIND_MEASUREMENT,
          id: mw.id,
          planId: mw.planId,
          start: tsToWallString(mw.start),
          end: tsToWallString(mw.end),
          lux: mw.lux,
          yearly: { [yStr]: d },
        },
      });
    }
  }

  // 1b) 计划外照明事故：全额实际用光 + 与当前占用计划窗相交部分的窗内/窗外拆分
  for (const x of incidents) {
    const seg = { start: new Date(x.start_ts).getTime(), end: new Date(x.end_ts).getTime() };
    const lux = Number(x.actual_lux);
    const planWinList = [];
    for (const p of scopedPlans) for (const w of windowsById.get(Number(p.id))) planWinList.push(w);
    const insideParts = clipIntervalToWindows(seg, planWinList);
    const outsideParts = subtractIntervals([seg], insideParts);
    const yearly = yearMapToObject(doseByYear([seg], lux));
    const yearlyInside = yearMapToObject(doseByYear(insideParts, lux));
    const yearlyOutside = yearMapToObject(doseByYear(outsideParts, lux));
    const insidePlanIds = [...new Set(
      scopedPlans
        .filter((p) => windowsById.get(Number(p.id)).some((w) => intersects(w, seg)))
        .map((p) => Number(p.id))
    )].sort((a, b) => a - b);
    touchYears(yearly);
    for (const [y, d] of Object.entries(yearly)) addTot(Number(y), 'incident', d);
    for (const [yStr, d] of Object.entries(yearly)) {
      addFragment(Number(yStr), {
        sourceKey: `${KIND_INCIDENT}:${x.id}`,
        kind: KIND_INCIDENT,
        id: Number(x.id),
        payload: {
          kind: KIND_INCIDENT,
          id: Number(x.id),
          start: tsToWallString(seg.start),
          end: tsToWallString(seg.end),
          lux,
          reason: x.reason,
          yearly: { [yStr]: d },
          yearlyInside: { [yStr]: yearlyInside[yStr] || 0 },
          yearlyOutside: { [yStr]: yearlyOutside[yStr] || 0 },
          insidePlanIds,
        },
      });
    }
  }

  // 1c) 共享照明归属：按 session 聚合各归属段，全额实际用光 + 窗内/窗外拆分
  const bySession = new Map();
  for (const a of allocations) {
    const sid = Number(a.session_id);
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(a);
  }
  for (const [sid, allocs] of bySession) {
    const session = sessions.get(sid);
    const lux = session ? Number(session.actual_lux) : Number(allocs[0].actual_lux);
    const segs = allocs
      .map((a) => ({ start: new Date(a.start_ts).getTime(), end: new Date(a.end_ts).getTime() }))
      .sort((a, b) => a.start - b.start);
    const allParts = subtractIntervals(segs, []);
    const sessionStart = Math.min(...segs.map((s) => s.start));
    const sessionEnd = Math.max(...segs.map((s) => s.end));
    const sessionSeg = { start: sessionStart, end: sessionEnd };
    // 共享照明主记录的起止（对展示更友好；与归属并集可能略有驻留空隙，剂量按归属段计）
    const masterSeg = session
      ? { start: new Date(session.start_ts).getTime(), end: new Date(session.end_ts).getTime() }
      : sessionSeg;
    const planWinList = [];
    for (const p of scopedPlans) for (const w of windowsById.get(Number(p.id))) planWinList.push(w);
    const insideParts = clipToPlanWindows(planWinList, segs);
    const outsideParts = subtractIntervals(allParts, insideParts);
    const yearly = yearMapToObject(doseByYear(allParts, lux));
    const yearlyInside = yearMapToObject(doseByYear(insideParts, lux));
    const yearlyOutside = yearMapToObject(doseByYear(outsideParts, lux));
    const insidePlanIds = [...new Set(
      scopedPlans
        .filter((p) => windowsById.get(Number(p.id)).some((w) => segs.some((s) => intersects(w, s))))
        .map((p) => Number(p.id))
    )].sort((a, b) => a - b);
    // 各归属段逐年剂量
    const allocYearly = new Map();
    for (const a of allocs) {
      const aLux = Number(a.actual_lux);
      const aSeg = { start: new Date(a.start_ts).getTime(), end: new Date(a.end_ts).getTime() };
      const ay = yearMapToObject(doseByYear([aSeg], aLux));
      for (const [yStr, d] of Object.entries(ay)) {
        if (!allocYearly.has(yStr)) allocYearly.set(yStr, new Map());
        const map = allocYearly.get(yStr);
        map.set(Number(a.id), {
          id: Number(a.id),
          residenceId: Number(a.residence_id),
          start: tsToWallString(aSeg.start),
          end: tsToWallString(aSeg.end),
          actualLux: aLux,
          yearly: { [yStr]: d },
        });
      }
    }
    touchYears(yearly);
    for (const [y, d] of Object.entries(yearly)) addTot(Number(y), 'shared', d);
    for (const [yStr, d] of Object.entries(yearly)) {
      addFragment(Number(yStr), {
        sourceKey: `${KIND_SHARED}:${sid}`,
        kind: KIND_SHARED,
        id: sid,
        payload: {
          kind: KIND_SHARED,
          id: sid,
          hallCode: session ? session.hall_code : null,
          start: tsToWallString(masterSeg.start),
          end: tsToWallString(masterSeg.end),
          lux,
          reason: session ? session.reason : null,
          yearly: { [yStr]: d },
          yearlyInside: { [yStr]: yearlyInside[yStr] || 0 },
          yearlyOutside: { [yStr]: yearlyOutside[yStr] || 0 },
          insidePlanIds,
          allocations: [...(allocYearly.get(yStr) || new Map()).values()],
        },
      });
    }
  }

  // 2) 计划估算残余：开灯窗 − 已确认（含预演）实测覆盖 − 本计划停灯 − 事故窗内 − 共享窗内
  for (const plan of scopedPlans) {
    const pid = Number(plan.id);
    const windows = windowsById.get(pid);
    const coverers = allMeasWindows.filter((mw) => windows.some((w) => intersects(w, mw)));
    const blacks = blackoutWindowsByPlan.get(pid) || [];
    const incInside = clipToPlanWindows(windows, incidentWindows);
    const sharedInside = clipToPlanWindows(windows, sharedWindows);
    const remaining = subtractIntervals(
      windows, [...coverers, ...blacks, ...incInside, ...sharedInside]
    );
    const yearly = yearMapToObject(doseByYear(remaining, Number(plan.estimated_lux)));
    touchYears(yearly);
    for (const [y, d] of Object.entries(yearly)) addTot(Number(y), 'residue', d);
    for (const [yStr, d] of Object.entries(yearly)) {
      addFragment(Number(yStr), {
        sourceKey: `${KIND_PLAN}:${pid}`,
        kind: KIND_PLAN,
        id: pid,
        payload: {
          kind: KIND_PLAN,
          id: pid,
          title: plan.title,
          status: plan.status,
          startDate: dateYmd(plan.start_date),
          endDate: dateYmd(plan.end_date),
          periods: normalizeJson(plan.light_periods),
          lux: Number(plan.estimated_lux),
          yearly: { [yStr]: d },
        },
      });
    }
  }

  // 只有上限、没有任何占用的年份（局部重算也要保留年度行）
  for (const y of Object.keys(bundle.limits)) years.add(Number(y));

  return { years, totalsByYear, fragments };
}

// ---------------------------------------------------------------------------
// 派生表写入：同事务内“删旧年份行 → 写新年份行”（撤回旧贡献 + 计入新贡献）
// ---------------------------------------------------------------------------

async function writeYears(client, bundle, computed) {
  const exhibitId = bundle.exhibitId;
  const years = [...computed.years].sort((a, b) => a - b);
  if (years.length === 0) return;
  const ph = inClause(years.length, 2);

  await client.query(
    `DELETE FROM annual_occupancy
      WHERE exhibit_id = $1 AND year IN (${ph})`,
    [exhibitId, ...years]
  );
  await client.query(
    `DELETE FROM annual_occupancy_items
      WHERE exhibit_id = $1 AND year IN (${ph})`,
    [exhibitId, ...years]
  );

  for (const year of years) {
    const key = String(year);
    const t = computed.totalsByYear.get(year) || { used: 0, measurement: 0, incident: 0, shared: 0, residue: 0 };
    const limit = bundle.limits[key];
    await client.query(
      `INSERT INTO annual_occupancy
         (exhibit_id, year, used_lxh, measurement_lxh, incident_lxh, shared_lxh, residue_lxh, rebuilt_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [exhibitId, year, round3(t.used), round3(t.measurement), round3(t.incident),
       round3(t.shared), round3(t.residue)]
    );
    void limit;
    const frags = (computed.fragments.get(year) || []).filter((f) => {
      const d = f.payload.yearly[key];
      return d !== undefined && d !== 0;
    });
    // 顺序：实测 -> 事故 -> 共享照明 -> 计划（与历史 sources 一致）
    const rank = { [KIND_MEASUREMENT]: 0, [KIND_INCIDENT]: 1, [KIND_SHARED]: 2, [KIND_PLAN]: 3 };
    frags.sort((a, b) => rank[a.kind] - rank[b.kind] || a.id - b.id);
    for (const f of frags) {
      await client.query(
        `INSERT INTO annual_occupancy_items
           (exhibit_id, year, source_kind, source_id, source_key, year_dose_lxh, payload_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [exhibitId, year, f.kind, f.id, f.sourceKey, round3(f.payload.yearly[key]),
         JSON.stringify(f.payload)]
      );
    }
  }
}

/**
 * 在调用方已持有的事务/锁内，局部重算一件或多件展品的若干受影响自然年。
 *  - years 中给出跨年记录影响到的全部年份；
 *  - 同事务删除旧贡献、写入新贡献；失败随外层事务回滚，不留混杂结果。
 * 返回 Map<exhibitId, { years, totalsByYear, fragments }>。
 */
async function recomputeOccupancyYears(client, exhibitIds, years) {
  const ids = [...new Set((Array.isArray(exhibitIds) ? exhibitIds : [exhibitIds]).map(Number))];
  const ys = [...new Set((Array.isArray(years) ? years : [years]).map(Number))]
    .filter(Number.isInteger);
  const results = new Map();
  for (const exhibitId of ids) {
    const bundle = await loadBundle(client, exhibitId, ys);
    const computed = computeBundle(bundle, []);
    await writeYears(client, bundle, computed);
    results.set(exhibitId, computed);
  }
  return results;
}

// ---------------------------------------------------------------------------
// 读取：从派生表组装占用（唯一来源）
// ---------------------------------------------------------------------------

async function readLimits(client, exhibitId) {
  const { rows } = await client.query(
    'SELECT year, limit_lxh FROM annual_limits WHERE exhibit_id = $1',
    [exhibitId]
  );
  const limits = {};
  for (const r of rows) limits[String(r.year)] = Number(r.limit_lxh);
  return limits;
}

/** 合并同一来源跨自然年的片段。 */
function mergeFragments(perYearRows) {
  const byKey = new Map();
  for (const row of perYearRows) {
    const payload = normalizeJson(row.payload_json);
    const key = row.source_key;
    if (!byKey.has(key)) {
      byKey.set(key, {
        sourceKey: key,
        kind: row.source_kind,
        id: Number(row.source_id),
        payload,
        years: [Number(row.year)],
      });
    } else {
      const entry = byKey.get(key);
      const p = entry.payload;
      p.yearly = p.yearly || {};
      Object.assign(p.yearly, payload.yearly);
      if (payload.yearlyInside) {
        p.yearlyInside = p.yearlyInside || {};
        Object.assign(p.yearlyInside, payload.yearlyInside);
      }
      if (payload.yearlyOutside) {
        p.yearlyOutside = p.yearlyOutside || {};
        Object.assign(p.yearlyOutside, payload.yearlyOutside);
      }
      if (Array.isArray(payload.insidePlanIds)) {
        p.insidePlanIds = [...new Set([...(p.insidePlanIds || []), ...payload.insidePlanIds])]
          .sort((a, b) => a - b);
      }
      if (Array.isArray(payload.allocations)) {
        p.allocations = [...(p.allocations || []), ...payload.allocations];
      }
      entry.years.push(Number(row.year));
    }
  }
  const sources = [];
  for (const entry of byKey.values()) {
    const p = entry.payload;
    // yearly 等按年对象按年份排序
    const sortKeys = (o) => {
      const out = {};
      for (const k of Object.keys(o).sort((a, b) => Number(a) - Number(b))) out[k] = round3(o[k]);
      return out;
    };
    p.yearly = sortKeys(p.yearly || {});
    if (p.yearlyInside) p.yearlyInside = sortKeys(p.yearlyInside);
    if (p.yearlyOutside) p.yearlyOutside = sortKeys(p.yearlyOutside);
    if (Array.isArray(p.allocations)) {
      p.allocations.sort((a, b) =>
        (a.start < b.start ? -1 : a.start > b.start ? 1 : a.id - b.id));
    }
    sources.push(p);
  }
  const rank = { [KIND_MEASUREMENT]: 0, [KIND_INCIDENT]: 1, [KIND_SHARED]: 2, [KIND_PLAN]: 3 };
  sources.sort((a, b) => rank[a.kind] - rank[b.kind] || a.id - b.id);
  return sources;
}

/**
 * 从派生表读取一件展品的占用结果（展品详情、账册、预警、试算共用同一来源与舍入口径）。
 * 返回 { limits, used, years, sources, plans, measurements }。
 */
async function readOccupancy(client, exhibitId) {
  const limits = await readLimits(client, exhibitId);

  const { rows: aggRows } = await client.query(
    `SELECT year, used_lxh, measurement_lxh, incident_lxh, shared_lxh, residue_lxh
       FROM annual_occupancy WHERE exhibit_id = $1 ORDER BY year`,
    [exhibitId]
  );
  const used = {};
  const totals = {};
  for (const r of aggRows) {
    used[String(r.year)] = round3(Number(r.used_lxh));
    totals[String(r.year)] = {
      measurement: round3(Number(r.measurement_lxh)),
      incident: round3(Number(r.incident_lxh)),
      shared: round3(Number(r.shared_lxh)),
      residue: round3(Number(r.residue_lxh)),
    };
  }

  const { rows: itemRows } = await client.query(
    `SELECT year, source_kind, source_id, source_key, payload_json
       FROM annual_occupancy_items WHERE exhibit_id = $1
      ORDER BY year, source_kind, source_id`,
    [exhibitId]
  );
  const sources = mergeFragments(itemRows);

  // 计划来源的易变字段（状态/展期/时段/照度）以当前计划行为准（剂量仍来自派生表），
  // 保证非剂量变更（如待复核原因外的状态流转后未重算年份）也展示最新值。
  const statusList = ACTIVE_PLAN_STATUSES.map((s) => `'${s}'`).join(',');
  const { rows: plans } = await client.query(
    `SELECT * FROM plans WHERE exhibit_id = $1 AND status IN (${statusList}) ORDER BY id`,
    [exhibitId]
  );
  const planById = new Map(plans.map((p) => [Number(p.id), p]));
  for (const s of sources) {
    if (s.kind !== KIND_PLAN) continue;
    const plan = planById.get(s.id);
    if (plan) {
      s.title = plan.title;
      s.status = plan.status;
      s.startDate = dateYmd(plan.start_date);
      s.endDate = dateYmd(plan.end_date);
      s.periods = normalizeJson(plan.light_periods);
      s.lux = Number(plan.estimated_lux);
    }
  }
  // 兼容性：残余被实测/事故/共享照明完全替代（各年剂量皆为 0）的已批准/待复核计划，
  // 历史 computeOccupancy 仍会在 sources 中给出 yearly:{} 条目，这里保持同样形态。
  for (const plan of plans) {
    const pid = Number(plan.id);
    if (sources.some((s) => s.kind === KIND_PLAN && s.id === pid)) continue;
    sources.push({
      kind: KIND_PLAN,
      id: pid,
      title: plan.title,
      status: plan.status,
      startDate: dateYmd(plan.start_date),
      endDate: dateYmd(plan.end_date),
      periods: normalizeJson(plan.light_periods),
      lux: Number(plan.estimated_lux),
      yearly: {},
    });
  }
  const rank0 = { [KIND_MEASUREMENT]: 0, [KIND_INCIDENT]: 1, [KIND_SHARED]: 2, [KIND_PLAN]: 3 };
  sources.sort((a, b) => rank0[a.kind] - rank0[b.kind] || a.id - b.id);

  const { rows: measurements } = await client.query(
    `SELECT m.*, p.status AS plan_status
       FROM measurements m JOIN plans p ON p.id = m.plan_id
      WHERE m.exhibit_id = $1 AND m.status = 'confirmed'
      ORDER BY m.start_ts, m.id`,
    [exhibitId]
  );

  const years = {};
  const allYears = new Set([...Object.keys(limits), ...Object.keys(used)].map(Number));
  for (const year of [...allYears].sort((a, b) => a - b)) {
    const key = String(year);
    const usedVal = round3(used[key] || 0);
    const limitVal = limits[key] !== undefined ? round3(limits[key]) : null;
    years[key] = {
      year,
      limit: limitVal,
      used: usedVal,
      remaining: limitVal === null ? null : round3(limitVal - usedVal),
      over: limitVal === null ? false : usedVal - limitVal > 0.005,
    };
  }

  return { limits, used, years, sources, plans, measurements, totals };
}

/**
 * 试算占用（不写派生表）：在派生表当前占用基础上，
 *  - 排除 excludePlanIds 各计划的估算残余（批准/复核/调整核对把待批/待复核计划自身排除）；
 *  - 并入 extraMeasurements（确认前预演、CSV 批次预览）：实测剂量计入，同时替代其计划残余。
 * 与历史 computeOccupancy(excludePlanId/extraMeasurement(s)) 同口径，只做年份局部几何计算。
 */
async function projectOccupancy(client, exhibitId, { excludePlanIds = [], extraMeasurements = [] } = {}) {
  const base = await readOccupancy(client, exhibitId);
  const used = { ...base.used };

  // 1) 排除计划残余
  for (const pid of excludePlanIds.map(Number)) {
    const { rows } = await client.query(
      `SELECT year, year_dose_lxh FROM annual_occupancy_items
        WHERE exhibit_id = $1 AND source_kind = 'plan' AND source_id = $2`,
      [exhibitId, pid]
    );
    for (const r of rows) {
      const key = String(r.year);
      used[key] = round3((used[key] || 0) - Number(r.year_dose_lxh));
    }
  }

  // 2) 预演实测：剂量计入 + 替代其所属计划残余（年份局部重算这些计划的残余）
  const extras = (Array.isArray(extraMeasurements) ? extraMeasurements : [extraMeasurements])
    .filter(Boolean)
    .map((em) => ({
      id: em.id || -1,
      planId: Number(em.planId),
      start: em.start,
      end: em.end,
      lux: Number(em.lux),
    }));
  if (extras.length > 0) {
    const extraYears = new Set();
    for (const em of extras) {
      const y = yearMapToObject(doseByYear([{ start: em.start, end: em.end }], em.lux));
      for (const k of Object.keys(y)) extraYears.add(Number(k));
    }
    const planIds = [...new Set(extras.map((em) => em.planId))];
    const bundle = await loadBundle(client, exhibitId, [...extraYears]);
    // loadBundle 按年份过滤计划；确保预演实测所属计划在 scopedPlans 中
    for (const pid of planIds) {
      if (!bundle.scopedPlans.some((p) => Number(p.id) === pid)) {
        const p = bundle.plans.find((x) => Number(x.id) === pid);
        if (p) bundle.scopedPlans.push(p);
      }
    }
    const beforeComputed = computeBundle(bundle, []);
    const afterComputed = computeBundle(bundle, extras);
    // 仅对涉及的计划，取其残余差值；实测剂量差值取 after-before 的 measurement 增量
    for (const year of extraYears) {
      const key = String(year);
      const bt = beforeComputed.totalsByYear.get(year);
      const at = afterComputed.totalsByYear.get(year);
      if (!at) continue;
      const delta = round3((at.used || 0) - (bt ? bt.used : 0));
      used[key] = round3((used[key] || 0) + delta);
    }
  }

  const years = {};
  const allYears = new Set([...Object.keys(base.limits), ...Object.keys(used)].map(Number));
  for (const year of [...allYears].sort((a, b) => a - b)) {
    const key = String(year);
    const usedVal = round3(used[key] || 0);
    const limitVal = base.limits[key] !== undefined ? round3(base.limits[key]) : null;
    years[key] = {
      year,
      limit: limitVal,
      used: usedVal,
      remaining: limitVal === null ? null : round3(limitVal - usedVal),
      over: limitVal === null ? false : usedVal - limitVal > 0.005,
    };
  }

  // 排除计划的来源条目也从 sources 中移除（其零剂量占位条目一并排除，与历史 excludePlanId 口径一致）
  const excludeSet = new Set(excludePlanIds.map(Number));
  const sources = base.sources.filter(
    (s) => !(s.kind === KIND_PLAN && excludeSet.has(s.id))
  );

  return {
    limits: base.limits,
    used,
    years,
    sources,
    plans: base.plans,
    measurements: base.measurements,
    totals: base.totals,
  };
}

// ---------------------------------------------------------------------------
// 全量重建
// ---------------------------------------------------------------------------

/**
 * 重建工作单元（须在事务内调用；逐展品加行锁、全量重算并写入两张派生表）。
 * 调用方负责事务提交/回滚：任何失败都会抛错，由外层事务保证不会留下新旧混杂结果。
 * 返回 { exhibits, years } 统计。
 */
async function rebuildOccupancyInTransaction(client) {
  const { rows: exhibitRows } = await client.query(
    'SELECT id FROM exhibits ORDER BY id FOR UPDATE'
  );
  await client.query('TRUNCATE annual_occupancy_items');
  await client.query('TRUNCATE annual_occupancy');

  let yearCount = 0;
  for (const row of exhibitRows) {
    const exhibitId = Number(row.id);
    const bundle = await loadBundle(client, exhibitId, null);
    const computed = computeBundle(bundle, []);
    await writeYears(client, bundle, computed);
    yearCount += computed.years.size;
  }
  return { exhibits: exhibitRows.length, years: yearCount };
}

/**
 * 按全部原始记录重建所有展品的派生占用（独立事务封装）：
 * 单事务提交，失败即报错回滚——绝不返回混杂的新旧占用。
 */
async function rebuildOccupancyStore() {
  const { withTransaction } = require('./db');
  return withTransaction((client) => rebuildOccupancyInTransaction(client));
}

/**
 * 派生结果是否为空（用于启动时判断是否需要为既有原始数据补建）。
 */
async function isStoreEmpty(client) {
  const { rows } = await client.query('SELECT COUNT(*)::bigint AS n FROM annual_occupancy');
  return Number(rows[0].n) === 0;
}

/**
 * 是否存在会产生占用的原始数据（占用计划/已确认实测/事故/共享归属）。
 */
async function hasRawOccupancyData(client) {
  const checks = [
    `SELECT COUNT(*)::bigint AS n FROM plans
      WHERE status IN (${ACTIVE_PLAN_STATUSES.map((s) => `'${s}'`).join(',')})`,
    `SELECT COUNT(*)::bigint AS n FROM measurements WHERE status = 'confirmed'`,
    'SELECT COUNT(*)::bigint AS n FROM lighting_incidents',
    'SELECT COUNT(*)::bigint AS n FROM shared_lighting_allocations',
  ];
  for (const sql of checks) {
    const { rows } = await client.query(sql);
    if (Number(rows[0].n) > 0) return true;
  }
  return false;
}

module.exports = {
  planWindows,
  planWindowYears,
  loadBundle,
  computeBundle,
  recomputeOccupancyYears,
  readOccupancy,
  projectOccupancy,
  rebuildOccupancyStore,
  rebuildOccupancyInTransaction,
  isStoreEmpty,
  hasRawOccupancyData,
};
