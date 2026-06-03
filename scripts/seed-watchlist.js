/**
 * 把 config/watchlist.json 匯入 PostgreSQL 的 watchlist 表
 *
 * 用法：node scripts/seed-watchlist.js
 *
 * 採 ON CONFLICT DO NOTHING：已存在的品項不覆蓋（bot 改過的不會被蓋掉）。
 * watchlist.json 自此降級為「初始種子 / 離線備份」，執行時來源改為 DB。
 */

require('dotenv').config();
const { Pool } = require('pg');
const watchlistConfig = require('../config/watchlist.json');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL 未設定');
    process.exit(1);
  }
  const items = (watchlistConfig.watchlist || []).filter((w) => w && w.set_number);
  if (items.length === 0) {
    console.log('watchlist.json 沒有可匯入的品項');
    return;
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });

  let inserted = 0;
  try {
    for (const w of items) {
      const { rowCount } = await pool.query(
        `INSERT INTO watchlist (set_number, note, target_price, disabled, pchome_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT(set_number) DO NOTHING`,
        [
          String(w.set_number),
          w.note || null,
          w.target_price ?? null,
          w.disabled === true,
          w.pchome_id || null,
        ]
      );
      if (rowCount > 0) inserted++;
    }
    console.log(`✅ 匯入完成：新增 ${inserted} 筆 / 共 ${items.length} 筆（已存在的略過）`);
  } catch (err) {
    console.error('❌ 匯入失敗：', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
