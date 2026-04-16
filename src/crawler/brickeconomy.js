/**
 * BrickEconomy 爬蟲 — 取 LEGO 官方零售價（USD）
 *
 * 用途：PCHome 找不到的絕版品，從 BrickEconomy 抓 MSRP 作為定價參考
 * 換算：USD × settings.brickeconomy.usd_to_twd_rate（預設 33）
 *
 * BrickEconomy 有 Cloudflare 防護，需要 Playwright 真實瀏覽器。
 *
 * 用法（獨立測試）：
 *   node src/crawler/brickeconomy.js 76428
 */

require('dotenv').config();
const { chromium } = require('playwright');
const logger = require('../utils/logger');

const BASE_URL = 'https://www.brickeconomy.com/set';

function randomDelay(min = 1500, max = 3000) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function createContext() {
  const headless = process.env.HEADLESS !== 'false';
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch {
    browser = await chromium.launch({ headless });
  }
  const context = await browser.newContext({
    locale: 'en-US',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return { browser, context };
}

/**
 * 從頁面 HTML 解析零售價（USD）
 * BrickEconomy 商品頁有 "Retail price" 欄位，格式 $XX.XX
 */
async function parseRetailPrice(page) {
  return page.evaluate(() => {
    // 策略 1：找 col 配對 "Retail price" → 右側金額
    const rows = document.querySelectorAll('.row, tr');
    for (const row of rows) {
      const text = row.textContent || '';
      if (/retail\s*price/i.test(text)) {
        const match = text.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
        if (match) {
          const val = parseFloat(match[1].replace(/,/g, ''));
          if (val > 0) return val;
        }
      }
    }

    // 策略 2：直接全文掃描 "Retail price" 附近的 $XX
    const bodyText = document.body?.innerText || '';
    const section = bodyText.match(/retail\s*price[\s\S]{0,100}?\$\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (section) {
      const val = parseFloat(section[1].replace(/,/g, ''));
      if (val > 0) return val;
    }

    return null;
  });
}

/**
 * 查詢指定 set number 的 BrickEconomy 零售價
 *
 * @param {string} setNumber
 * @param {object} [existingPage]  可傳入已有的 Playwright page 複用（避免重複開 browser）
 * @returns {{ found, retailPriceUSD, retailPriceTWD, url }}
 */
async function getSetPrice(setNumber, existingPage = null) {
  const settings = require('../../config/settings.json');
  const rate     = settings.brickeconomy?.usd_to_twd_rate ?? 33;
  const url      = `${BASE_URL}/${setNumber}-1/`;

  logger.info(`[BrickEconomy] 查詢 ${setNumber} → ${url}`);

  const ownBrowser = !existingPage;
  let browser, page;

  try {
    if (existingPage) {
      page = existingPage;
    } else {
      const ctx = await createContext();
      browser = ctx.browser;
      page    = await ctx.context.newPage();
    }

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(1500, 2500);

    // 偵測 Cloudflare challenge（標題通常是 "Just a moment..."）
    const title = await page.title();
    if (title.toLowerCase().includes('just a moment') || title.toLowerCase().includes('attention required')) {
      logger.warn(`[BrickEconomy] ${setNumber} 遇到 Cloudflare，等待 5 秒...`);
      await randomDelay(5000, 7000);
    }

    // 偵測 404
    const h1 = await page.evaluate(() => document.querySelector('h1')?.textContent?.trim() || '');
    if (h1.toLowerCase().includes('not found') || h1.toLowerCase().includes('404')) {
      logger.warn(`[BrickEconomy] ${setNumber} 頁面不存在`);
      return { found: false, retailPriceUSD: null, retailPriceTWD: null, url };
    }

    const usd = await parseRetailPrice(page);

    if (!usd) {
      logger.warn(`[BrickEconomy] ${setNumber} 找到頁面但無法解析零售價（可能 Cloudflare 擋住）`);
      return { found: false, retailPriceUSD: null, retailPriceTWD: null, url };
    }

    const twd = Math.round(usd * rate);
    logger.info(`[BrickEconomy] ${setNumber} → USD $${usd} × ${rate} = NT$${twd}`);
    return { found: true, retailPriceUSD: usd, retailPriceTWD: twd, url };

  } catch (err) {
    logger.warn(`[BrickEconomy] ${setNumber} 失敗：${err?.message ?? String(err)}`);
    return { found: false, retailPriceUSD: null, retailPriceTWD: null, url };
  } finally {
    if (ownBrowser && browser) await browser.close();
  }
}

module.exports = { getSetPrice, createContext };

// ── 獨立測試 ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const sn = process.argv[2] || '76428';
  getSetPrice(sn).then((r) => {
    console.log('\n結果：');
    console.log(JSON.stringify(r, null, 2));
  });
}
