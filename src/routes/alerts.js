'use strict';

/*
 * 年度用光额度分级预警路由。
 *   POST /api/exhibits/:id/quota-thresholds       保管员：按展品 + 自然年设置/修改低、高档阈值
 *                                                 （以当时占用重建基线，不补发事件）
 *   GET  /api/quota-alerts                        登录用户：预警事件历史（可按展品/年/级别/未读过滤）
 *   GET  /api/quota-alerts/unread-count           登录用户：未读事件条数（可按展品过滤）
 *   POST /api/quota-alerts/:id/read               保管员：单条标记已读（不改变预警级别）
 *   POST /api/quota-alerts/read-all               保管员：批量标记已读（exhibitId/year/level 过滤）
 * 展品详情（GET /api/exhibits/:id）附加 quotaThresholds / quotaAlerts / quotaAlertsUnread 字段。
 */

const express = require('express');
const { query, withTransaction } = require('../db');
const { requireAuth, requireRole } = require('../auth');
const { ValidationError } = require('../validation');
const {
  listAlerts,
  countUnread,
  markAlertRead,
  markAllAlertsRead,
  serializeAlertRow,
} = require('../alerts');

const router = express.Router();

router.use(requireAuth);

/** 整数查询参数（非法/缺省返回 null）。 */
function intParam(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

// 预警事件历史：登录用户均可查看（可追溯）
router.get('/quota-alerts', async (req, res, next) => {
  try {
    const exhibitId = intParam(req.query.exhibitId);
    const year = intParam(req.query.year);
    const levelRaw = req.query.level ? String(req.query.level) : null;
    const level = ['low', 'high'].includes(levelRaw) ? levelRaw : null;
    if ((req.query.level !== undefined && !levelRaw) ||
        (levelRaw && !['low', 'high'].includes(levelRaw))) {
      throw new ValidationError('level 只允许 low 或 high');
    }
    const unreadOnly = String(req.query.unreadOnly || '') === '1' ||
      String(req.query.unread || '') === '1';
    const limit = intParam(req.query.limit) || 100;
    const offset = intParam(req.query.offset) || 0;

    const events = await listAlerts({ query }, { exhibitId, year, level, unreadOnly, limit, offset });
    const unread = await countUnread({ query }, exhibitId);
    res.json({ events, unreadCount: unread });
  } catch (err) {
    next(err);
  }
});

// 未读事件条数（登录用户；可按展品过滤，供页面角标）
router.get('/quota-alerts/unread-count', async (req, res, next) => {
  try {
    const exhibitId = intParam(req.query.exhibitId);
    const unread = await countUnread({ query }, exhibitId);
    res.json({ unreadCount: unread });
  } catch (err) {
    next(err);
  }
});

// 批量标记已读（幂等；只改已读标记，不改变预警级别，故不取得任何展品占用锁）
router.post('/quota-alerts/read-all', requireRole('conservator'), async (req, res, next) => {
  try {
    const body = req.body || {};
    const exhibitId = intParam(body.exhibitId);
    const year = intParam(body.year);
    const levelRaw = body.level ? String(body.level) : null;
    if (levelRaw && !['low', 'high'].includes(levelRaw)) {
      throw new ValidationError('level 只允许 low 或 high');
    }
    const updated = await withTransaction((client) =>
      markAllAlertsRead(client, { exhibitId, year, level: levelRaw }, req.sessionUser)
    );
    res.json({ ok: true, updatedCount: updated });
  } catch (err) {
    next(err);
  }
});

// 单条标记已读（保管员；幂等；不改变预警级别）
router.post('/quota-alerts/:id/read', requireRole('conservator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new ValidationError('预警事件 ID 无效');

    const result = await withTransaction(async (client) => {
      const row = await markAlertRead(client, id, req.sessionUser);
      if (!row) throw new ValidationError('预警事件不存在');
      return serializeAlertRow(row);
    });
    res.json({ event: result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
