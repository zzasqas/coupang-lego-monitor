/**
 * 建立 / 升級 PostgreSQL schema
 *
 * 用法：node scripts/migrate.js
 * 需要環境變數 DATABASE_URL。
 *
 * 冪等：可重複執行（全部 IF NOT EXISTS / ADD COLUMN 容錯）。
 */

require('dotenv').config();
const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  set_number   TEXT PRIMARY KEY,
  name         TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pchome_prices (
  set_number            TEXT PRIMARY KEY,
  original_price        INTEGER,
  sale_price            INTEGER,
  is_eol                INTEGER DEFAULT 0,
  checked_at            TIMESTAMPTZ DEFAULT now(),
  expires_at            TIMESTAMPTZ,
  sale_price_expires_at TIMESTAMPTZ,
  price_source          TEXT DEFAULT 'pchome'
);

CREATE TABLE IF NOT EXISTS price_history (
  id             BIGSERIAL PRIMARY KEY,
  set_number     TEXT,
  product_name   TEXT,
  coupang_url    TEXT,
  price          INTEGER,
  original_price INTEGER,
  discount_pct   REAL,
  price_source   TEXT DEFAULT 'biggo',
  scraped_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_history_set ON price_history (set_number, scraped_at DESC);

CREATE TABLE IF NOT EXISTS alerts_sent (
  id           BIGSERIAL PRIMARY KEY,
  set_number   TEXT,
  alert_type   TEXT,
  price        INTEGER,
  discount_pct REAL,
  sent_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_alerts_sent_set ON alerts_sent (set_number, alert_type, sent_at DESC);

CREATE TABLE IF NOT EXISTS watchlist (
  set_number   TEXT PRIMARY KEY,
  note         TEXT,
  target_price INTEGER,
  disabled     BOOLEAN DEFAULT false,
  added_at     TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('❌ DATABASE_URL 未設定');
    process.exit(1);
  }
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await pool.query(SCHEMA);
    console.log('✅ Schema 建立 / 升級完成');
  } catch (err) {
    console.error('❌ Migration 失敗：', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
