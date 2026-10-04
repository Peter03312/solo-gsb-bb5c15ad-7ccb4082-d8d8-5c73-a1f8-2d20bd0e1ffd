'use strict';

/*
 * 展品年度用光额度的可追溯分级预警。
 *
 * 保管员按“展品 + 自然年”设置低、高两档阈值（年度上限占比百分比，0 < 低 < 高 ≤ 100）：
 *   - 未登记年度上限的年份：页面/接口显示“无上限”，不触发任何事件（级别恒为 none）；
 *   - 首次设置或修改阈值：以“当时占用”重建基线（baseline），不补发历史事件；
 *   - 此后所有在“相应展品锁事务”内改变占用/上限的操作（计划批准/取消/调整、上限变更、
 *     实测确认/纠错、停灯、事故、展厅共享照明入账、批次确认）完成后调用 recomputeAlerts：
 *     占用“向上跨过”某档才各留一条事件（边沿触发）；回落不写事件，再次向上跨越可重触发；
 *     跨年各自然年独立判定；超上限仍显示真实占用与最高（高）级别；
 *   - 多展品操作整体回滚时，事件行在同一事务内，随业务数据一并回滚；
 *   - 保管员可把历史事件标记已读；已读只改标记，不改变当前预警级别。
 *
 * 级别口径（pct = used / limit × 100）：
 *   limit == null             -> 'none'（无上限，不触发）
 *   pct >= high_pct（含 >100）-> 'high'
 *   pct >= low_pct            -> 'low'
 *   其他                       -> 'none'
 */

const { ValidationError } = require('./validation');
const { recordAudit } = require('./audit');
const { computeOccupancy, lockExhibit } = require('./service');
const { round3 } = require('./dosing');

const LEVEL_RANK = { none: 0, low: 1, high: 2 };
const PCT_EPS = 1e-6;

/** 计算某年级别；limit 为 null（未登记上限）时恒为 none（“无上限”，不触发）。 */
function levelOf({ used, limit, lowPct, highPct }) {
  if (limit === null || limit === undefined) return 'none';
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  if (pct + PCT_EPS >= highPct) return 'high';
  if (pct + PCT_EPS >= lowPct) return 'low';
  return 'none';
}

/** 校验阈值设置入参：年份 1900-2999，百分比为有限数，0 < low < high <= 100。返回 { year, lowPct, highPct }。 */
function parseThresholdInput(body) {
  const year = Number(body && body.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new ValidationError('年份必须是 1900-2999 之间的整数');
  }
  const lowPct = Number(body && body.lowPct);
  const highPct = Number(body && body.highPct);
  if (!Number.isFinite(lowPct) || !Number.isFinite(highPct)) {
    throw new ValidationError('低档、高档阈值都必须是数字（年度上限占比 %）');
  }
  if (!(lowPct > 0) || lowPct >= 100) {
    throw new ValidationError('低档阈值必须满足 0 < 低档 < 100（年度上限占比 %）');
  }
  if (!(highPct > 0) || highPct > 100) {
    throw new ValidationError('高档阈值必须满足 0 < 高档 ≤ 100（年度上限占比 %）');
  }
  if (!(lowPct < highPct)) {
    throw new ValidationError('低档阈值必须严格小于高档阈值（0 < 低档 < 高档 ≤ 100）');
  }
  return { year, lowPct: round3(lowPct), highPct: round3(highPct) };
}

async function getThresholdRows(client, exhibitId) {
  const { rows } = await client.query(
    `SELECT * FROM annual_quota_thresholds WHERE exhibit_id = $1 ORDER BY year`,
    [exhibitId]
  );
  return rows;
}

/**
 * 设置/修改阈值（必须在已持有展品行锁的事务内调用）：
 * 以当时占用重建基线，不补发事件；写审计（阈值设置/修改）。
 * 返回插入/更新后的阈值行 + 当前阈值视图列表。
 */
async function upsertThreshold(client, exhibitId, input, actor) {
  await lockExhibit(client, exhibitId);
  const { year, lowPct, highPct } = parseThresholdInput(input);
  const occupancy = await computeOccupancy(client, exhibitId);
  const info = occupancy.years[String(year)];
  const used = info ? round3(info.used) : 0;
  const limit = info && info.limit !== null && info.limit !== undefined ? info.limit : null;
  const baselineLevel = levelOf({ used, limit, lowPct, highPct });

  // 阈值基线同样以派生占用表为准：确保该年 annual_usage 行存在（按年局部重算，重建基线不补发事件）。
  const { refreshUsageYears } = require('./usage');
  await refreshUsageYears(client, exhibitId, [year]);

  const { rows: prevRows } = await client.query(
    'SELECT id, low_pct, high_pct FROM annual_quota_thresholds WHERE exhibit_id = $1 AND year = $2',
    [exhibitId, year]
  );
  const previous = prevRows[0] || null;

  let row;
  if (previous) {
    const updated = await client.query(
      `UPDATE annual_quota_thresholds
          SET low_pct = $3, high_pct = $4,
              baseline_used_lxh = $5, baseline_level = $6,
              last_used_lxh = $5, last_level = $6,
              updated_by = $7, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [previous.id, exhibitId, lowPct, highPct, used, baselineLevel, actor.userId]
    );
    row = updated.rows[0];
  } else {
    const inserted = await client.query(
      `INSERT INTO annual_quota_thresholds
         (exhibit_id, year, low_pct, high_pct,
          baseline_used_lxh, baseline_level, last_used_lxh, last_level,
          created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $6, $7, $7)
       RETURNING *`,
      [exhibitId, year, lowPct, highPct, used, baselineLevel, actor.userId]
    );
    row = inserted.rows[0];
  }

  await recordAudit(
    client,
    actor,
    previous ? 'quota_threshold.update' : 'quota_threshold.create',
    'annual_quota_threshold',
    row.id,
    {
      exhibitId,
      year,
      lowPct,
      highPct,
      previous: previous
        ? { lowPct: Number(previous.low_pct), highPct: Number(previous.high_pct) }
        : null,
      baselineUsed: used,
      baselineLevel,
      hasLimit: limit !== null,
    }
  );

  return { row, rebased: { used, level: baselineLevel, hasLimit: limit !== null, limit } };
}

/**
 * 在展品锁事务内重算该展品全部已设置阈值年份的预警边沿。
 * 必须在所有业务改动（计划/上限/实测/停灯/事故/共享照明…）写入之后、事务提交之前调用：
 *   - 重新按统一剂量口径计算占用；
 *   - 对每个阈值年份，级别相对“上次记录级别”向上跨越时写事件（跨两级则 low、high 各一条）；
 *   - 同级/回落只更新 last_used_lxh/last_level，不写事件；
 *   - 无上限年份级别恒 none（占用照常记录，待上限登记后的下一次重算才可能向上跨档）。
 * 多展品事务应在按展品 id 升序持有的锁内逐展品调用本函数。
 *
 * options:
 *   occupancy  已在同事务内算好的占用（避免重复计算）；省略则自行计算；
 *   years      仅重算这些“受影响自然年”的阈值（按年局部重算）；省略则重算全部阈值年份；
 *   actor      事件 created_by（触发操作的操作者）；
 *   trigger    { type, detail } 触发来源（写入事件审计快照）。
 * 返回 { events: [对外事件对象…] }（不含已读标记查询）。
 */
async function recomputeAlerts(client, exhibitId, {
  occupancy = null,
  years = null,
  actor = null,
  trigger = null,
} = {}) {
  const occ = occupancy || (await computeOccupancy(client, exhibitId, years ? { years } : {}));
  const allRows = await getThresholdRows(client, exhibitId);
  const yearFilter = years ? new Set(years.map(Number)) : null;
  const rows = yearFilter ? allRows.filter((r) => yearFilter.has(Number(r.year))) : allRows;
  const created = [];

  for (const row of rows) {
    const year = Number(row.year);
    const yearStr = String(year);
    const lowPct = Number(row.low_pct);
    const highPct = Number(row.high_pct);
    const info = occ.years[yearStr];
    const used = info ? round3(info.used) : 0;
    const limit = info && info.limit !== null && info.limit !== undefined ? round3(info.limit) : null;
    const newLevel = levelOf({ used, limit, lowPct, highPct });
    const prevLevel = row.last_level || 'none';
    const prevUsed = round3(Number(row.last_used_lxh || 0));
    const usedPct = limit ? round3((used / limit) * 100) : 0;

    const crossings = [];
    if (LEVEL_RANK[newLevel] > LEVEL_RANK[prevLevel]) {
      for (const lvl of ['low', 'high']) {
        if (LEVEL_RANK[lvl] > LEVEL_RANK[prevLevel] && LEVEL_RANK[lvl] <= LEVEL_RANK[newLevel]) {
          crossings.push(lvl);
        }
      }
    }

    for (const lvl of crossings) {
      const ins = await client.query(
        `INSERT INTO annual_quota_alerts
           (exhibit_id, year, threshold_id, level, trigger_type,
            limit_lxh, used_lxh, low_pct, high_pct, used_pct,
            previous_used_lxh, previous_level, trigger_detail, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)
         RETURNING *`,
        [
          exhibitId,
          year,
          row.id,
          lvl,
          (trigger && trigger.type) || 'recompute',
          limit,
          used,
          lowPct,
          highPct,
          // 事件快照里的占比：跨高档但占用已超 100% 时仍记录真实占比
          usedPct,
          prevUsed,
          prevLevel,
          JSON.stringify((trigger && trigger.detail) || {}),
          actor ? actor.userId : null,
        ]
      );
      created.push(ins.rows[0]);
    }

    // 最近状态随占用重算刷新（边沿判定依据）；不触碰 updated_at（仅阈值配置变更才更新它）
    await client.query(
      `UPDATE annual_quota_thresholds
          SET last_used_lxh = $3, last_level = $4
        WHERE id = $1 AND exhibit_id = $2`,
      [row.id, exhibitId, used, newLevel]
    );
  }

  return { events: created.map(serializeAlertRow) };
}

/** 阈值行 -> 对外对象（附当前级别/占比由 buildThresholdView 组装，这里只做基础字段）。 */
function serializeThresholdRow(row, info) {
  const lowPct = Number(row.low_pct);
  const highPct = Number(row.high_pct);
  const used = info ? round3(info.used) : round3(Number(row.last_used_lxh || 0));
  const limit = info && info.limit !== null && info.limit !== undefined ? round3(info.limit) : null;
  const level = info
    ? levelOf({ used: info.used, limit: info.limit, lowPct, highPct })
    : (row.last_level || 'none');
  return {
    id: Number(row.id),
    exhibitId: Number(row.exhibit_id),
    year: Number(row.year),
    lowPct,
    highPct,
    hasLimit: limit !== null,
    limit: limit,
    used,
    usedPct: limit ? round3((used / limit) * 100) : null,
    level,
    baselineUsed: round3(Number(row.baseline_used_lxh || 0)),
    baselineLevel: row.baseline_level || 'none',
    updatedAt: row.updated_at,
  };
}

/**
 * 组装某展品的阈值当前视图（按年）。occ 为可选的已计算占用。
 * 未设置阈值的年份不出现在列表中；未登记上限的年份 hasLimit=false、level='none'（“无上限”）。
 */
async function buildThresholdView(client, exhibitId, occ = null) {
  const occupancy = occ || (await computeOccupancy(client, exhibitId));
  const rows = await getThresholdRows(client, exhibitId);
  return rows.map((row) => serializeThresholdRow(row, occupancy.years[String(row.year)]));
}

/**
 * 以派生占用表 annual_usage + 年上限组装阈值视图（展品列表等批量读取场景用，
 * 与 buildThresholdView 同一级别/舍入口径，不做全量历史重算）。
 * usageByYear/limitsByYear 为 { [year]: Number|row }；
 * 阈值年份在两表中都缺失时 used=0、limit=null（“无上限”，级别 none）。
 */
function buildThresholdViewFromUsage(rows, { usageByYear = {}, limitsByYear = {} } = {}) {
  return rows.map((row) => {
    const year = Number(row.year);
    const key = String(year);
    const limitRaw = limitsByYear[key];
    const limit = limitRaw === null || limitRaw === undefined
      ? null
      : round3(typeof limitRaw === 'object' ? Number(limitRaw.limit_lxh) : Number(limitRaw));
    const usageRaw = usageByYear[key];
    const used = usageRaw === null || usageRaw === undefined
      ? 0
      : round3(typeof usageRaw === 'object' ? Number(usageRaw.used_lxh) : Number(usageRaw));
    return serializeThresholdRow(row, { year, limit, used });
  });
}

/** 事件行 -> 对外对象（驼峰）。 */
function serializeAlertRow(row) {
  return {
    id: Number(row.id),
    exhibitId: Number(row.exhibit_id),
    year: Number(row.year),
    thresholdId: Number(row.threshold_id),
    level: row.level,
    triggerType: row.trigger_type,
    limit: row.limit_lxh !== null && row.limit_lxh !== undefined ? Number(row.limit_lxh) : null,
    used: Number(row.used_lxh),
    lowPct: Number(row.low_pct),
    highPct: Number(row.high_pct),
    usedPct: Number(row.used_pct),
    previousUsed: Number(row.previous_used_lxh),
    previousLevel: row.previous_level,
    triggerDetail: row.trigger_detail || {},
    createdBy: row.created_by != null ? Number(row.created_by) : null,
    createdAt: row.created_at,
    readBy: row.read_by != null ? Number(row.read_by) : null,
    readAt: row.read_at || null,
  };
}

/**
 * 查询预警事件（登录可读）。
 * filters: { exhibitId, year, level, unreadOnly, includeRead=true, limit, offset }
 */
async function listAlerts(client, filters = {}) {
  const exhibitId =
    Number.isInteger(filters.exhibitId) ? filters.exhibitId : null;
  const year = Number.isInteger(filters.year) ? filters.year : null;
  const level = ['low', 'high'].includes(filters.level) ? filters.level : null;
  const unreadOnly = !!filters.unreadOnly;
  const lim = Math.min(Math.max(Number(filters.limit) || 100, 1), 1000);
  const off = Math.max(Number(filters.offset) || 0, 0);

  const { rows } = await client.query(
    `SELECT * FROM annual_quota_alerts
      WHERE ($1::bigint IS NULL OR exhibit_id = $1)
        AND ($2::int IS NULL OR year = $2)
        AND ($3::text IS NULL OR level = $3)
        AND ($4 = FALSE OR read_at IS NULL)
      ORDER BY id DESC
      LIMIT $5 OFFSET $6`,
    [exhibitId, year, level, unreadOnly, lim, off]
  );
  return rows.map(serializeAlertRow);
}

async function countUnread(client, exhibitId = null) {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM annual_quota_alerts
      WHERE ($1::bigint IS NULL OR exhibit_id = $1) AND read_at IS NULL`,
    [Number.isInteger(exhibitId) ? exhibitId : null]
  );
  return rows[0].n;
}

async function getAlert(client, alertId) {
  const { rows } = await client.query('SELECT * FROM annual_quota_alerts WHERE id = $1', [alertId]);
  return rows[0] || null;
}

/** 保管员把一条事件标记已读（幂等；不改级别/占用快照）。返回更新后的行（或 null）。 */
async function markAlertRead(client, alertId, actor) {
  const { rows } = await client.query(
    `UPDATE annual_quota_alerts
        SET read_at = COALESCE(read_at, now()), read_by = COALESCE(read_by, $2)
      WHERE id = $1
      RETURNING *`,
    [alertId, actor.userId]
  );
  return rows[0] || null;
}

/** 保管员批量标记已读（幂等）。filters 同 listAlerts 子集：exhibitId/year/level。返回标记条数。 */
async function markAllAlertsRead(client, filters, actor) {
  const exhibitId = Number.isInteger(filters.exhibitId) ? filters.exhibitId : null;
  const year = Number.isInteger(filters.year) ? filters.year : null;
  const level = ['low', 'high'].includes(filters.level) ? filters.level : null;
  const { rows } = await client.query(
    `UPDATE annual_quota_alerts
        SET read_at = COALESCE(read_at, now()), read_by = COALESCE(read_by, $4)
      WHERE read_at IS NULL
        AND ($1::bigint IS NULL OR exhibit_id = $1)
        AND ($2::int IS NULL OR year = $2)
        AND ($3::text IS NULL OR level = $3)
      RETURNING id`,
    [exhibitId, year, level, actor.userId]
  );
  return rows.length;
}

module.exports = {
  levelOf,
  parseThresholdInput,
  upsertThreshold,
  recomputeAlerts,
  buildThresholdView,
  buildThresholdViewFromUsage,
  serializeThresholdRow,
  serializeAlertRow,
  listAlerts,
  countUnread,
  getAlert,
  markAlertRead,
  markAllAlertsRead,
};
