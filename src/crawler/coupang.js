/**
 * Coupang Taiwan 爬蟲（未登入版）
 *
 * 搜尋 URL：https://www.tw.coupang.com/search?q={query}&channel=user
 *
 * ⚠️  注意：Coupang 搜尋頁由 Akamai WAF 做 IP 地區過濾
 *    → 必須在台灣 IP 環境執行，海外 IP 會收到 Access Denied
 *    → 你的台灣桌機直接執行不受影響
 *
 * 兩種查詢模式：
 *  1. searchBySetNumber(page, setNumber) → 搜尋指定組號，找最匹配商品
 *  2. searchTopN(page, keyword, n)       → 搜尋關鍵字取前 N 筆商品
 */

const { chromium } = require('playwright');
const path = require('path');
const logger = require('../utils/logger');

const BASE_URL    = 'https://www.tw.coupang.com';
const SEARCH_URL  = `${BASE_URL}/search?q=`;
const DEBUG_DIR   = path.join(__dirname, '../../screenshots');

function randomDelay(min = 1500, max = 3500) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function saveScreenshot(page, name) {
  if (!process.argv.includes('--debug')) return;
  const fs = require('fs');
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const file = path.join(DEBUG_DIR, `coupang_${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  logger.debug(`Screenshot: ${file}`);
}

async function createContext() {
  const headless = process.env.HEADLESS !== 'false';
  // 優先用系統 Chrome，Playwright 內建 Chromium 作為 fallback
  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  } catch {
    logger.warn('[Coupang] 找不到系統 Chrome，改用 Playwright 內建 Chromium');
    browser = await chromium.launch({
      headless,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }

  const context = await browser.newContext({
    locale: 'zh-TW',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    extraHTTPHeaders: { 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' },
  });

  // 隱藏自動化特徵
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  return { browser, context };
}

/** 前往搜尋頁，回傳是否成功（true/false） */
async function gotoSearch(page, query) {
  const url = SEARCH_URL + encodeURIComponent(query) + '&channel=user';
  logger.debug(`[Coupang] 搜尋 "${query}" → ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(1800, 2800);

  const title = await page.title();
  const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 50) || '');

  if (title === 'Access Denied' || bodyText.includes('Access Denied')) {
    logger.warn(
      `[Coupang] ⚠️  Access Denied — 你的 IP 不在台灣，或 Akamai 觸發限制。\n` +
      `          請在台灣桌機上執行，或等幾分鐘後重試。`
    );
    return false;
  }

  return true;
}

/**
 * 從搜尋結果頁擷取商品列表
 * Coupang TW 搜尋結果的 DOM 結構（2024-2025）
 */
async function extractProducts(page) {
  // 等待商品卡出現（多種可能的 selector）
  await page.waitForSelector(
    [
      '.search-product',
      '[class*="SearchProduct"]',
      '[class*="search-product"]',
      'li.prod-search-unit',
      '[class*="ProductCard"]',
      'ul.search-result li',
    ].join(', '),
    { timeout: 12000 }
  ).catch(() => logger.debug('[Coupang] 等待商品卡 selector 逾時'));

  return page.evaluate(() => {
    const results = [];

    // 逐一嘗試 selector，取第一個有商品的
    const CARD_SELECTORS = [
      '.search-product',
      'li.prod-search-unit',
      '[class*="SearchProduct"]:not([class*="__"])',  // 避免子元素
      '[class*="search-product-wrap"]',
      '[class*="ProductCard"]:not([class*="__"])',
    ];

    let cards = [];
    for (const sel of CARD_SELECTORS) {
      cards = [...document.querySelectorAll(sel)];
      if (cards.length > 0) break;
    }

    for (const card of cards) {
      // 商品名稱
      const nameEl = card.querySelector(
        '.name, [class*="product-name"], [class*="ProductName"], ' +
        '[class*="prod-name"], [class*="title"], h3, h4'
      );
      const name = nameEl?.textContent?.trim() || '';
      if (!name) continue;

      // 售價（實際支付）
      const priceEl = card.querySelector(
        '.price-value, [class*="sale-price"], [class*="PriceValue"], ' +
        '[class*="final-price"], [class*="discounted"], strong'
      );
      const priceRaw = priceEl?.textContent?.replace(/[^0-9]/g, '') || '';
      const price = priceRaw ? parseInt(priceRaw, 10) : null;

      // 劃線原價
      const origEl = card.querySelector(
        'del, [class*="origin-price"], [class*="before-price"], ' +
        '[class*="list-price"], [class*="original-price"]'
      );
      const origRaw = origEl?.textContent?.replace(/[^0-9]/g, '') || '';
      const originalPrice = origRaw ? parseInt(origRaw, 10) : price;

      // 商品連結
      const linkEl = card.querySelector('a[href]');
      const href = linkEl?.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : 'https://www.tw.coupang.com' + href;

      if (price && price > 0) {
        results.push({ name, price, originalPrice: originalPrice || price, url });
      }
    }

    return results;
  });
}

/** set number 是否出現在商品名稱或 URL 中 */
function matchesSetNumber(item, setNumber) {
  return item.name.includes(setNumber) || item.url.includes(setNumber);
}

/**
 * 搜尋特定 set number，回傳最匹配的一筆
 * @param {object} page  複用的 Playwright page
 * @param {string} setNumber  e.g. "76452"
 * @returns {object|null}
 */
async function searchBySetNumber(page, setNumber) {
  const queries = [`LEGO ${setNumber}`, `樂高 ${setNumber}`, setNumber];

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    const ok = await gotoSearch(page, q);
    if (!ok) return null;   // Access Denied，提前結束

    await saveScreenshot(page, `search_${setNumber}_q${i}`);
    const products = await extractProducts(page);
    logger.debug(`[Coupang] "${q}" → ${products.length} 筆`);

    // 精確比對 set number
    const exact = products.find((p) => matchesSetNumber(p, setNumber));
    if (exact) return { ...exact, matchedSetNumber: setNumber };

    // 第一次查詢有樂高商品但沒精確比對，記錄候選
    if (i === 0 && products.length > 0) {
      const candidate = products.find(
        (p) => p.name.toUpperCase().includes('LEGO') || p.name.includes('樂高')
      );
      if (candidate) {
        logger.debug(`[Coupang] ${setNumber} 無精確比對，記錄候選：${candidate.name}`);
        // 繼續嘗試其他 query，但保留候選
      }
    }

    await randomDelay(800, 1500);
  }

  return null;
}

/**
 * 廣域搜尋關鍵字取前 N 筆（B 類掃描）
 * @param {object} page
 * @param {string} keyword
 * @param {number} topN
 */
async function searchTopN(page, keyword, topN = 30) {
  logger.info(`[Coupang] 廣域搜尋 "${keyword}"（前 ${topN} 筆）`);

  const ok = await gotoSearch(page, keyword);
  if (!ok) return [];

  await saveScreenshot(page, `topN_${keyword}`);
  const products = await extractProducts(page);

  const legoOnly = products.filter(
    (p) => p.name.toUpperCase().includes('LEGO') || p.name.includes('樂高')
  );
  logger.info(`[Coupang] "${keyword}" → ${legoOnly.length} 筆樂高商品`);
  return legoOnly.slice(0, topN);
}

/**
 * 完整掃描（主入口）
 */
async function runScan({ setNumbers = [], keywords = ['樂高'], topN = 30 } = {}) {
  const { browser, context } = await createContext();
  const page = await context.newPage();
  const results = { watchlist: {}, topN: [] };

  try {
    // 1. 先訪問首頁建立 session
    logger.info('[Coupang] 建立 session...');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(1500, 2500);

    // 2. Watchlist 精準查詢
    logger.info(`[Coupang] 開始查詢 ${setNumbers.length} 個 watchlist 品項`);
    for (const sn of setNumbers) {
      logger.info(`[Coupang] 查詢 ${sn}...`);
      results.watchlist[sn] = await searchBySetNumber(page, sn);
      await randomDelay(1500, 3000);
    }

    // 3. 廣域搜尋
    if (keywords.length > 0) {
      logger.info('[Coupang] 廣域掃描...');
      const seen = new Set();
      for (const kw of keywords) {
        const items = await searchTopN(page, kw, topN);
        for (const item of items) {
          if (!seen.has(item.url)) {
            seen.add(item.url);
            results.topN.push(item);
          }
        }
        await randomDelay(2000, 4000);
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

module.exports = { runScan, searchBySetNumber, searchTopN, createContext };

// 直接執行測試
if (require.main === module) {
  const setNum = process.argv.find((a) => /^\d{5,6}$/.test(a)) || '76452';
  (async () => {
    const { browser, context } = await createContext();
    const page = await context.newPage();
    try {
      logger.info(`測試搜尋：${setNum}`);
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await randomDelay(1000, 2000);
      const result = await searchBySetNumber(page, setNum);
      console.log('\n結果：', JSON.stringify(result, null, 2));
    } finally {
      await browser.close();
    }
  })();
}
