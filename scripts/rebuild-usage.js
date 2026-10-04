'use strict';

/*
 * 派生占用表 annual_usage 的全量重建脚本（既有数据可重建派生结果）。
 *
 *   node scripts/rebuild-usage.js
 *
 * - 按展品逐个在“展品键锁 + 行锁 + 事务”内重建该展品全部相关自然年的 annual_usage：
 *   先删除该展品旧的派生行，再用与线上完全相同的统一剂量口径（computeOccupancy 按年计算）
 *   逐行写入；同时把分级预警阈值行的 last_used_lxh / last_level 同步为最新值
 *   （仅同步边沿判定基线，不补发任何历史事件）。
 * - 任一步骤失败：该展品事务回滚并报错退出，绝不返回/保留新旧占用混杂的状态。
 * - 幂等：可重复执行；默认重建全部展品，可传展品 id 作为参数只重建指定展品：
 *     node scripts/rebuild-usage.js 3 5
 */

const { pool, withKeyLock, withTransaction } = require('../src/db');
const { initializeDatabase } = require('../src/init');
const { rebuildExhibitUsage } = require('../src/usage');

async function rebuildExhibit(exhibitId) {
  return withKeyLock(`exhibit:${exhibitId}`, () =>
    withTransaction((client) => rebuildExhibitUsage(client, exhibitId))
  );
}

async function main() {
  const argIds = process.argv.slice(2).map(Number).filter(Number.isInteger);
  await initializeDatabase();

  let exhibitIds;
  if (argIds.length > 0) {
    exhibitIds = argIds;
  } else {
    const { rows } = await pool.query('SELECT id FROM exhibits ORDER BY id');
    exhibitIds = rows.map((r) => Number(r.id));
  }

  let totalYears = 0;
  for (const exhibitId of exhibitIds) {
    const { years } = await rebuildExhibit(exhibitId);
    totalYears += years.length;
    console.log(`[rebuild-usage] 展品 #${exhibitId}：重建 ${years.length} 个自然年（${years.join(', ') || '无'}）`);
  }
  console.log(`[rebuild-usage] 完成：${exhibitIds.length} 件展品，${totalYears} 个年度占用行`);
  await pool.end();
}

main().catch((err) => {
  console.error('[rebuild-usage] 重建失败（已回滚，未改动既有源数据）:', err);
  process.exit(1);
});
