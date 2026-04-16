/**
 * SQLite 資料庫操作（使用 sql.js WASM，不需要 Visual Studio 編譯）
 *
 * 注意：sql.js 初始化是非同步的，必須先呼叫 initDb() 才能使用其他函式
 */

const fs = require('fs');
const path = require('path');

const DB_DIR  = path.join(__dirname, '../../db');
const DB_PATH = path.join(DB_DIR, 'prices.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

let db = null;

async function initDb() {
  if (db) return db;

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`PRAGMA journal_mode = WAL;`);
  createSchema();
  migrate();
  save();   // 確保檔案存在
  return db;
}

function save() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function createSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      set_number   TEXT PRIMARY KEY,
      name         TEXT,
      note         TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      updated_at   TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS pchome_prices (
      set_number     TEXT PRIMARY KEY,
      original_price INTEGER,
      sale_price     INTEGER,
      is_eol         INTEGER DEFAULT 0,
      checked_at     TEXT DEFAULT (datetime('now')),
      expires_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      set_number     TEXT,
      product_name   TEXT,
      coupang_url    TEXT,
      price          INTEGER,
      original_price INTEGER,
      discount_pct   REAL,
      scraped_at     TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alerts_sent (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      set_number   TEXT,
      alert_type   TEXT,
      price        INTEGER,
      discount_pct REAL,
      sent_at      TEXT DEFAULT (datetime('now'))
    );
  `);
}

/** 資料庫 migration（新增欄位時向後相容舊 DB 檔案） */
function migrate() {
  const migrations = [
    `ALTER TABLE pchome_prices ADD COLUMN sale_price INTEGER`,
    `ALTER TABLE pchome_prices ADD COLUMN sale_price_expires_at TEXT`,
    `ALTER TABLE pchome_prices ADD COLUMN price_source TEXT DEFAULT 'pchome'`,
    `ALTER TABLE price_history ADD COLUMN price_source TEXT DEFAULT 'biggo'`,
  ];
  for (const sql of migrations) {
    try { db.run(sql); } catch (_) { /* 欄位已存在，忽略 */ }
  }
}

// ── 輔助：把 sql.js 的欄位/值陣列轉為物件陣列 ──────────────────────────────

function toRows(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const obj = {};
    columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

function queryOne(sql, params = []) {
  const rows = toRows(db.exec(sql, params));
  return rows[0] || null;
}

function queryAll(sql, params = []) {
  return toRows(db.exec(sql, params));
}

// ── Products ──────────────────────────────────────────────────────────────────

function upsertProduct(setNumber, name, note = '') {
  db.run(`
    INSERT INTO products (set_number, name, note, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(set_number) DO UPDATE SET
      name       = COALESCE(excluded.name, name),
      note       = COALESCE(excluded.note, note),
      updated_at = datetime('now')
  `, [setNumber, name || null, note || null]);
  save();
}

// ── PCHome 快取 ───────────────────────────────────────────────────────────────

function getPchomePrice(setNumber) {
  const row = queryOne(
    `SELECT * FROM pchome_prices WHERE set_number = ?`,
    [setNumber]
  );
  if (!row) return null;

  const now     = new Date();
  const expires = new Date(row.expires_at);
  if (now > expires) return null;   // 快取過期

  return row;
}

/** 取得上次記錄（不管是否過期），用於 EOL 時保留舊定價 */
function getLastPchomeRecord(setNumber) {
  return queryOne(
    `SELECT * FROM pchome_prices WHERE set_number = ?`,
    [setNumber]
  );
}

function savePchomePrice(setNumber, originalPrice, isEol, salePrice = null, priceSource = 'pchome') {
  const settings = require('../../config/settings.json');

  let expiresAt;
  if (priceSource === 'brickeconomy' || priceSource === 'pchome_last') {
    // BrickEconomy MSRP 或 PCHome 最後已知定價 → 永久保留（快取到 2099 年）
    expiresAt = '2099-12-31T00:00:00.000Z';
  } else {
    // 原價 TTL：40-50 天（絕版判斷同步）
    const cacheCfg = settings.pchome_cache_days || { min: 40, max: 50 };
    const days     = cacheCfg.min + Math.floor(Math.random() * (cacheCfg.max - cacheCfg.min + 1));
    expiresAt      = new Date(Date.now() + days * 86400 * 1000).toISOString();
  }

  // 特價 TTL：2-3 天（各品項隨機，加快偵測特賣）
  const saleCfg              = settings.pchome_sale_cache_days || { min: 2, max: 3 };
  const saleDays             = saleCfg.min + Math.floor(Math.random() * (saleCfg.max - saleCfg.min + 1));
  const salePriceExpiresAt   = new Date(Date.now() + saleDays * 86400 * 1000).toISOString();

  db.run(`
    INSERT INTO pchome_prices
      (set_number, original_price, sale_price, is_eol, checked_at, expires_at, sale_price_expires_at, price_source)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?)
    ON CONFLICT(set_number) DO UPDATE SET
      original_price        = excluded.original_price,
      sale_price            = excluded.sale_price,
      is_eol                = excluded.is_eol,
      checked_at            = datetime('now'),
      expires_at            = excluded.expires_at,
      sale_price_expires_at = excluded.sale_price_expires_at,
      price_source          = excluded.price_source
  `, [setNumber, originalPrice || null, salePrice || null, isEol ? 1 : 0, expiresAt, salePriceExpiresAt, priceSource]);
  save();
}

/**
 * 只更新特價與其 TTL（原價快取仍有效時使用）
 */
function updateSalePriceCache(setNumber, salePrice) {
  const settings = require('../../config/settings.json');

  const saleCfg            = settings.pchome_sale_cache_days || { min: 2, max: 3 };
  const saleDays           = saleCfg.min + Math.floor(Math.random() * (saleCfg.max - saleCfg.min + 1));
  const salePriceExpiresAt = new Date(Date.now() + saleDays * 86400 * 1000).toISOString();

  db.run(`
    UPDATE pchome_prices
    SET sale_price = ?, sale_price_expires_at = ?, checked_at = datetime('now')
    WHERE set_number = ?
  `, [salePrice || null, salePriceExpiresAt, setNumber]);
  save();
}

// ── 價格歷史 ──────────────────────────────────────────────────────────────────

function savePrice({ setNumber, productName, coupangUrl, price, originalPrice, discountPct }) {
  db.run(`
    INSERT INTO price_history
      (set_number, product_name, coupang_url, price, original_price, discount_pct)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [setNumber, productName, coupangUrl, price, originalPrice, discountPct]);
  save();
}

function getLastPrice(setNumber) {
  return queryOne(
    `SELECT * FROM price_history
     WHERE set_number = ?
     ORDER BY scraped_at DESC LIMIT 1`,
    [setNumber]
  );
}

// ── 價格統計 ──────────────────────────────────────────────────────────────────

/**
 * 回傳某品項的價格統計資訊
 * @param {string} setNumber
 * @returns {{
 *   currentPrice: number|null,
 *   currentUrl: string|null,
 *   allTimeLow: number|null,
 *   allTimeLowDate: string|null,
 *   allTimeHigh: number|null,
 *   low30d: number|null,
 *   high30d: number|null,
 *   avg30d: number|null,
 *   prevWeekPrice: number|null,
 *   dataPoints: number
 * }}
 */
function getPriceStats(setNumber) {
  // 最新一筆（current price）
  const latest = queryOne(
    `SELECT price, coupang_url, scraped_at FROM price_history
     WHERE set_number = ?
     ORDER BY scraped_at DESC LIMIT 1`,
    [setNumber]
  );

  // 全時間高低
  const allTime = queryOne(
    `SELECT MIN(price) AS low, MAX(price) AS high FROM price_history WHERE set_number = ?`,
    [setNumber]
  );

  // 全時間低點的日期
  const allTimeLowRow = latest ? queryOne(
    `SELECT price, scraped_at FROM price_history
     WHERE set_number = ? AND price = (SELECT MIN(price) FROM price_history WHERE set_number = ?)
     ORDER BY scraped_at ASC LIMIT 1`,
    [setNumber, setNumber]
  ) : null;

  // 30 天高低均
  const stats30d = queryOne(
    `SELECT MIN(price) AS low, MAX(price) AS high, AVG(price) AS avg
     FROM price_history
     WHERE set_number = ? AND scraped_at >= datetime('now', '-30 days')`,
    [setNumber]
  );

  // 上週同期價格：7-14 天前最近一筆
  const prevWeekRow = queryOne(
    `SELECT price FROM price_history
     WHERE set_number = ?
       AND scraped_at >= datetime('now', '-14 days')
       AND scraped_at <  datetime('now', '-7 days')
     ORDER BY scraped_at DESC LIMIT 1`,
    [setNumber]
  );

  // 資料點數量
  const countRow = queryOne(
    `SELECT COUNT(*) AS cnt FROM price_history WHERE set_number = ?`,
    [setNumber]
  );

  return {
    currentPrice:    latest?.price    ?? null,
    currentUrl:      latest?.coupang_url ?? null,
    allTimeLow:      allTime?.low     ?? null,
    allTimeLowDate:  allTimeLowRow?.scraped_at?.slice(0, 10) ?? null,
    allTimeHigh:     allTime?.high    ?? null,
    low30d:          stats30d?.low    ?? null,
    high30d:         stats30d?.high   ?? null,
    avg30d:          stats30d?.avg    != null ? Math.round(stats30d.avg) : null,
    prevWeekPrice:   prevWeekRow?.price ?? null,
    dataPoints:      countRow?.cnt    ?? 0,
  };
}

// ── 通知紀錄 ──────────────────────────────────────────────────────────────────

/** 過去 7 天發送的警報總數 */
function getWeekAlertCount() {
  const row = queryOne(
    `SELECT COUNT(*) AS cnt FROM alerts_sent WHERE sent_at >= datetime('now', '-7 days')`
  );
  return row?.cnt ?? 0;
}

function wasAlertSentRecently(setNumber, alertType, hours = 24) {
  const row = queryOne(`
    SELECT 1 FROM alerts_sent
    WHERE set_number = ? AND alert_type = ?
      AND sent_at > datetime('now', ? || ' hours')
  `, [setNumber, alertType, `-${hours}`]);
  return !!row;
}

function saveAlertSent(setNumber, alertType, price, discountPct) {
  db.run(`
    INSERT INTO alerts_sent (set_number, alert_type, price, discount_pct)
    VALUES (?, ?, ?, ?)
  `, [setNumber, alertType, price, discountPct]);
  save();
}

module.exports = {
  initDb,
  upsertProduct,
  getPchomePrice,
  getLastPchomeRecord,
  savePchomePrice,
  updateSalePriceCache,
  savePrice,
  getLastPrice,
  getPriceStats,
  getWeekAlertCount,
  wasAlertSentRecently,
  saveAlertSent,
};

// 直接執行時：初始化 DB
if (require.main === module) {
  initDb().then(() => {
    console.log('DB initialized at:', DB_PATH);
    console.log('Schema ready.');
  });
}
