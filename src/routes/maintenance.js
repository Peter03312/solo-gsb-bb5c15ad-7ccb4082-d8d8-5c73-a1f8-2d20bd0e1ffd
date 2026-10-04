'use strict';

/*
 * 维护接口（仅保管员）：
 *   POST /api/maintenance/rebuild-usage  全量重建年度占用派生表 annual_usage。
 * 重建按展品逐个在“展品键锁 + 行锁 + 事务”内进行：先删旧派生行，再用线上同一统一剂量口径
 * 逐年写回；任一展品失败整体回滚并返回错误，绝不留下新旧占用混杂的结果。
 * body 可选 { exhibitIds: [..] } 只重建指定展品；不传则重建全部展品。
 */

const express = require('express');
const { query, withKeyLock, withTransaction } = require('../db');
const { requireRole, requireAuth } = require('../auth');
const { rebuildExhibitUsage } = require('../usage');

const router = express.Router();

router.use(requireAuth);

router.post('/rebuild-usage', requireRole('conservator'), async (req, res, next) => {
  try {
    let exhibitIds = null;
    if (req.body && Array.isArray(req.body.exhibitIds)) {
      exhibitIds = req.body.exhibitIds.map(Number);
      if (exhibitIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        return res.status(400).json({ error: 'exhibitIds 必须为正整数数组' });
      }
    }

    let ids;
    if (exhibitIds) {
      ids = [...new Set(exhibitIds)].sort((a, b) => a - b);
      const ph = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await query(
        `SELECT id FROM exhibits WHERE id IN (${ph}) ORDER BY id`, ids);
      if (rows.length !== ids.length) {
        const found = new Set(rows.map((r) => Number(r.id)));
        const missing = ids.filter((id) => !found.has(id));
        return res.status(400).json({ error: `展品不存在：${missing.join('、')}` });
      }
    } else {
      ids = (await query('SELECT id FROM exhibits ORDER BY id')).rows.map((r) => Number(r.id));
    }

    const rebuilt = [];
    // 逐展品加展品键锁 + 事务（与既有业务事务互斥），任一失败即整体报错回滚。
    for (const exhibitId of ids) {
      const result = await withKeyLock(`exhibit:${exhibitId}`, () =>
        withTransaction((client) => rebuildExhibitUsage(client, exhibitId))
      );
      rebuilt.push(result);
    }

    res.json({
      ok: true,
      exhibitCount: rebuilt.length,
      yearCount: rebuilt.reduce((s, r) => s + r.years.length, 0),
      exhibits: rebuilt.map((r) => ({ exhibitId: r.exhibitId, yearCount: r.years.length, years: r.years })),
    });
  } catch (err) {
    next(err);
  }
});

// 未知维护路径 404（而非落到静态页）。
router.use((req, res) => {
  res.status(404).json({ error: `未知维护接口：${req.method} ${req.path}` });
});

module.exports = router;
