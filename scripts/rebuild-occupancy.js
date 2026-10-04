#!/usr/bin/env node
'use strict';

/*
 * 一次性重建年度占用派生结果（annual_occupancy / annual_occupancy_items）。
 *
 * 用途：
 *  - 升级到“按受影响自然年局部重算”机制后，为既有原始数据重建派生占用；
 *  - 派生结果被怀疑不一致时，随时用本脚本按全部原始记录重建。
 *
 * 保证：整个重建在单个数据库事务内完成（先清空两张派生表，再逐展品加展品行锁、
 * 全量重算写入）；任一步骤失败即回滚并以非零码退出，绝不返回/残留新旧混杂的占用。
 * 业务运行期间也可执行——重建经展品行锁与各业务事务串行，得到的是一致快照。
 *
 * 用法：
 *   npm run rebuild:occupancy
 *   node scripts/rebuild-occupancy.js
 */

const { initializeDatabase } = require('../src/init');
const { pool } = require('../src/db');
const store = require('../src/occupancy-store');

async function main() {
  console.log('[rebuild] 等待数据库就绪并确保表结构...');
  await initializeDatabase();

  console.log('[rebuild] 开始在单事务内按全部原始记录重建年度占用派生结果...');
  const t0 = Date.now();
  try {
    const result = await store.rebuildOccupancyStore();
    console.log(
      `[rebuild] 完成：重建 ${result.exhibits} 件展品、${result.years} 个展品-年度，` +
      `耗时 ${Date.now() - t0} ms`
    );
  } catch (err) {
    console.error('[rebuild] 重建失败，派生结果保持上一次一致状态（事务已回滚）:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('[rebuild] 致命错误:', err);
  process.exit(1);
});
