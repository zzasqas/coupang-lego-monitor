/**
 * PostgreSQL 資料庫操作（node-postgres / pg）
 *
 * 取代原本的 sql.js（WASM SQLite 本機檔案），改用 Railway PostgreSQL 持久化。
 *
 * 注意：
 *  - 所有查詢函式皆為 async（pg 是 Promise 介面），呼叫端需 await
 *  - 連線字串來自 process.env.DATABASE_URL（Railway 自動注入）
 *  - 建表請執行 `node scripts/migrate.js`；匯入 watchlist 執行 `node scripts/seed-watchlist.js`
 */

require('dotenv').config();
const { Pool } = require('pg');
const logger   = require('../utils/logger');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL 未設定，無法連線 PostgreSQL');
  }
  pool = new Pool({
    connectionString,
    // Railway 內部網路通常不需要 SSL；若用外部 proxy 連線需要時可設 PGSSL=true
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    max: 5,
  });
  pool.on('error', (err) => logger.error(`[DB] Pool 錯誤：${err.message}`));
  return pool;
}

/** 測試連線（schema 由 scripts/migrate.js 建立） */
async function initDb() {
  const p = getPool();
  await p.query('SELECT 1');
  return p;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function queryOne(text, params = []) {
  const { rows } = await query(text, params);
  return rows[0] || null;
}

async function queryAll(text, params = []) {
  const { rows } = await query(text, params);
  return rows;
}

// ── Products ──────────────────────────────────────────────────────────────────

async function upsertProduct(setNumber, name, note = '') {
  await query(`
    INSERT INTO products (set_number, name, note, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT(set_number) DO UPDATE SET
      name       = COALESCE(EXCLUDED.name, products.name),
      note       = COALESCE(EXCLUDED.note, products.note),
      updated_at = now()
  `, [setNumber, name || null, note || null]);
}

// ── PCHome 快取 ───────────────────────────────────────────────────────────────

/** 取得未過期的 PCHome 快取（過期回 null） */
async function getPchomePrice(setNumber) {
  const row = await queryOne(
    `SELECT * FROM pchome_prices WHERE set_number = $1`,
    [setNumber]
  );
  if (!row) return null;

  const now = new Date();
  if (row.expires_at && now > new Date(row.expires_at)) return null;
  return row;
}

/** 取得上次記錄（不管是否過期），用於 EOL 時保留舊定價 */
async function getLastPchomeRecord(setNumber) {
  return queryOne(
    `SELECT * FROM pchome_prices WHERE set_number = $1`,
    [setNumber]
  );
}

async function savePchomePrice(setNumber, originalPrice, isEol, salePrice = null, priceSource = 'pchome') {
  const settings = require('../../config/settings.json');

  let expiresAt;
  if (priceSource === 'brickeconomy' || priceSource === 'pchome_last') {
    // BrickEconomy MSRP 或 PCHome 最後已知定價 → 永久保留
    expiresAt = '2099-12-31T00:00:00.000Z';
  } else {
    const cacheCfg = settings.pchome_cache_days || { min: 40, max: 50 };
    const days     = cacheCfg.min + Math.floor(Math.random() * (cacheCfg.max - cacheCfg.min + 1));
    expiresAt      = new Date(Date.now() + days * 86400 * 1000).toISOString();
  }

  const saleCfg            = settings.pchome_sale_cache_days || { min: 2, max: 3 };
  const saleDays           = saleCfg.min + Math.floor(Math.random() * (saleCfg.max - saleCfg.min + 1));
  const salePriceExpiresAt = new Date(Date.now() + saleDays * 86400 * 1000).toISOString();

  await query(`
    INSERT INTO pchome_prices
      (set_number, original_price, sale_price, is_eol, checked_at, expires_at, sale_price_expires_at, price_source)
    VALUES ($1, $2, $3, $4, now(), $5, $6, $7)
    ON CONFLICT(set_number) DO UPDATE SET
      original_price        = EXCLUDED.original_price,
      sale_price            = EXCLUDED.sale_price,
      is_eol                = EXCLUDED.is_eol,
      checked_at            = now(),
      expires_at            = EXCLUDED.expires_at,
      sale_price_expires_at = EXCLUDED.sale_price_expires_at,
      price_source          = EXCLUDED.price_source
  `, [setNumber, originalPrice || null, salePrice || null, isEol ? 1 : 0, expiresAt, salePriceExpiresAt, priceSource]);
}

/** 只更新特價與其 TTL（原價快取仍有效時使用） */
async function updateSalePriceCache(setNumber, salePrice) {
  const settings = require('../../config/settings.json');

  const saleCfg            = settings.pchome_sale_cache_days || { min: 2, max: 3 };
  const saleDays           = saleCfg.min + Math.floor(Math.random() * (saleCfg.max - saleCfg.min + 1));
  const salePriceExpiresAt = new Date(Date.now() + saleDays * 86400 * 1000).toISOString();

  await query(`
    UPDATE pchome_prices
    SET sale_price = $1, sale_price_expires_at = $2, checked_at = now()
    WHERE set_number = $3
  `, [salePrice || null, salePriceExpiresAt, setNumber]);
}

// ── 價格歷史 ──────────────────────────────────────────────────────────────────

async function savePrice({ setNumber, productName, coupangUrl, price, originalPrice, discountPct }) {
  await query(`
    INSERT INTO price_history
      (set_number, product_name, coupang_url, price, original_price, discount_pct)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [setNumber, productName, coupangUrl, price, originalPrice, discountPct]);
}

async function getLastPrice(setNumber) {
  return queryOne(
    `SELECT * FROM price_history
     WHERE set_number = $1
     ORDER BY scraped_at DESC LIMIT 1`,
    [setNumber]
  );
}

// ── 價格統計 ──────────────────────────────────────────────────────────────────

/**
 * 回傳某品項的價格統計資訊
 * @returns {Promise<{currentPrice,currentUrl,allTimeLow,allTimeLowDate,allTimeHigh,low30d,high30d,avg30d,prevWeekPrice,dataPoints}>}
 */
async function getPriceStats(setNumber) {
  const latest = await queryOne(
    `SELECT price, coupang_url, scraped_at FROM price_history
     WHERE set_number = $1
     ORDER BY scraped_at DESC LIMIT 1`,
    [setNumber]
  );

  const allTime = await queryOne(
    `SELECT MIN(price) AS low, MAX(price) AS high FROM price_history WHERE set_number = $1`,
    [setNumber]
  );

  const allTimeLowRow = latest ? await queryOne(
    `SELECT price, scraped_at FROM price_history
     WHERE set_number = $1 AND price = (SELECT MIN(price) FROM price_history WHERE set_number = $1)
     ORDER BY scraped_at ASC LIMIT 1`,
    [setNumber]
  ) : null;

  const stats30d = await queryOne(
    `SELECT MIN(price) AS low, MAX(price) AS high, AVG(price) AS avg
     FROM price_history
     WHERE set_number = $1 AND scraped_at >= now() - interval '30 days'`,
    [setNumber]
  );

  const prevWeekRow = await queryOne(
    `SELECT price FROM price_history
     WHERE set_number = $1
       AND scraped_at >= now() - interval '14 days'
       AND scraped_at <  now() - interval '7 days'
     ORDER BY scraped_at DESC LIMIT 1`,
    [setNumber]
  );

  const countRow = await queryOne(
    `SELECT COUNT(*) AS cnt FROM price_history WHERE set_number = $1`,
    [setNumber]
  );

  const num = (v) => (v == null ? null : Number(v));

  return {
    currentPrice:    num(latest?.price),
    currentUrl:      latest?.coupang_url ?? null,
    allTimeLow:      num(allTime?.low),
    allTimeLowDate:  allTimeLowRow?.scraped_at
                       ? new Date(allTimeLowRow.scraped_at).toISOString().slice(0, 10)
                       : null,
    allTimeHigh:     num(allTime?.high),
    low30d:          num(stats30d?.low),
    high30d:         num(stats30d?.high),
    avg30d:          stats30d?.avg != null ? Math.round(Number(stats30d.avg)) : null,
    prevWeekPrice:   num(prevWeekRow?.price),
    dataPoints:      Number(countRow?.cnt ?? 0),
  };
}

/** 批次取每個組號「最新一筆」Coupang 價（給 /lego list 顯示用，不現抓） */
async function getLatestPrices(setNumbers) {
  if (!setNumbers || setNumbers.length === 0) return {};
  const rows = await queryAll(`
    SELECT DISTINCT ON (set_number) set_number, price, coupang_url, scraped_at
    FROM price_history
    WHERE set_number = ANY($1)
    ORDER BY set_number, scraped_at DESC
  `, [setNumbers]);
  const map = {};
  for (const r of rows) {
    map[r.set_number] = {
      price:      r.price != null ? Number(r.price) : null,
      coupangUrl: r.coupang_url || null,
      scrapedAt:  r.scraped_at || null,
    };
  }
  return map;
}

/** 批次取每個組號的 PCHome 參考定價 / 特價 / 絕版（不過濾過期，給清單顯示用） */
async function getPchomeRefs(setNumbers) {
  if (!setNumbers || setNumbers.length === 0) return {};
  const rows = await queryAll(`
    SELECT set_number, original_price, sale_price, is_eol
    FROM pchome_prices
    WHERE set_number = ANY($1)
  `, [setNumbers]);
  const map = {};
  for (const r of rows) {
    map[r.set_number] = {
      originalPrice: r.original_price != null ? Number(r.original_price) : null,
      salePrice:     r.sale_price != null ? Number(r.sale_price) : null,
      isEol:         !!r.is_eol,
    };
  }
  return map;
}

// ── 通知紀錄 ──────────────────────────────────────────────────────────────────

/** 過去 7 天發送的警報總數 */
async function getWeekAlertCount() {
  const row = await queryOne(
    `SELECT COUNT(*) AS cnt FROM alerts_sent WHERE sent_at >= now() - interval '7 days'`
  );
  return Number(row?.cnt ?? 0);
}

async function wasAlertSentRecently(setNumber, alertType, hours = 24) {
  const row = await queryOne(`
    SELECT 1 FROM alerts_sent
    WHERE set_number = $1 AND alert_type = $2
      AND sent_at > now() - ($3 || ' hours')::interval
  `, [setNumber, alertType, String(hours)]);
  return !!row;
}

async function saveAlertSent(setNumber, alertType, price, discountPct) {
  await query(`
    INSERT INTO alerts_sent (set_number, alert_type, price, discount_pct)
    VALUES ($1, $2, $3, $4)
  `, [setNumber, alertType, price, discountPct]);
}

// ── Watchlist（搬進 DB，供 Discord Bot 即時增減） ──────────────────────────────

/** 取得 watchlist；預設只回未停用的，依組號數字排序 */
async function getWatchlist({ includeDisabled = false } = {}) {
  const rows = await queryAll(
    `SELECT set_number, note, target_price, disabled, is_eol, pchome_id
     FROM watchlist
     ${includeDisabled ? '' : 'WHERE disabled = false'}
     ORDER BY set_number ASC`
  );
  return rows.map((r) => ({
    set_number:   r.set_number,
    note:         r.note || '',
    target_price: r.target_price != null ? Number(r.target_price) : null,
    disabled:     !!r.disabled,
    is_eol:       !!r.is_eol,
    pchome_id:    r.pchome_id || null,
  }));
}

/** 新增追蹤品項；已存在則更新 note（回傳 'inserted' | 'updated'） */
async function addWatchItem(setNumber, note = '') {
  const { rowCount } = await query(
    `INSERT INTO watchlist (set_number, note)
     VALUES ($1, $2)
     ON CONFLICT(set_number) DO UPDATE SET
       note = COALESCE(NULLIF(EXCLUDED.note, ''), watchlist.note),
       disabled = false,
       updated_at = now()`,
    [setNumber, note || null]
  );
  return rowCount > 0 ? 'ok' : 'noop';
}

/** 永久移除（回傳是否真的有刪到） */
async function removeWatchItem(setNumber) {
  const { rowCount } = await query(
    `DELETE FROM watchlist WHERE set_number = $1`,
    [setNumber]
  );
  return rowCount > 0;
}

/** 停用 / 啟用追蹤（回傳是否有更新到） */
async function setWatchDisabled(setNumber, disabled) {
  const { rowCount } = await query(
    `UPDATE watchlist SET disabled = $2, updated_at = now() WHERE set_number = $1`,
    [setNumber, !!disabled]
  );
  return rowCount > 0;
}

/** 設定 / 清除目標價（price 傳 null 表示清除）；回傳是否有更新到 */
async function setTargetPrice(setNumber, price) {
  const { rowCount } = await query(
    `UPDATE watchlist SET target_price = $2, updated_at = now() WHERE set_number = $1`,
    [setNumber, price ?? null]
  );
  return rowCount > 0;
}

/** 手動標註 / 取消絕版；回傳是否有更新到 */
async function setEol(setNumber, isEol) {
  const { rowCount } = await query(
    `UPDATE watchlist SET is_eol = $2, updated_at = now() WHERE set_number = $1`,
    [setNumber, !!isEol]
  );
  return rowCount > 0;
}

/** 用種子檔回填「空白 note」（不覆蓋 bot 已改過的 note）；回傳是否有更新到 */
async function backfillEmptyNote(setNumber, note) {
  if (!note) return false;
  const { rowCount } = await query(
    `UPDATE watchlist SET note = $2, updated_at = now()
     WHERE set_number = $1 AND (note IS NULL OR note = '')`,
    [setNumber, note]
  );
  return rowCount > 0;
}

/** 單筆查詢（含已停用） */
async function getWatchItem(setNumber) {
  const row = await queryOne(
    `SELECT set_number, note, target_price, disabled, is_eol FROM watchlist WHERE set_number = $1`,
    [setNumber]
  );
  if (!row) return null;
  return {
    set_number:   row.set_number,
    note:         row.note || '',
    target_price: row.target_price != null ? Number(row.target_price) : null,
    disabled:     !!row.disabled,
    is_eol:       !!row.is_eol,
  };
}

module.exports = {
  initDb,
  query,
  upsertProduct,
  getPchomePrice,
  getLastPchomeRecord,
  savePchomePrice,
  updateSalePriceCache,
  savePrice,
  getLastPrice,
  getLatestPrices,
  getPchomeRefs,
  getPriceStats,
  getWeekAlertCount,
  wasAlertSentRecently,
  saveAlertSent,
  // watchlist
  getWatchlist,
  addWatchItem,
  removeWatchItem,
  setWatchDisabled,
  setTargetPrice,
  setEol,
  backfillEmptyNote,
  getWatchItem,
};

// 直接執行時：測試連線
if (require.main === module) {
  initDb()
    .then(() => { console.log('PostgreSQL 連線成功 ✅'); return pool.end(); })
    .catch((err) => { console.error('連線失敗：', err.message); process.exit(1); });
}
