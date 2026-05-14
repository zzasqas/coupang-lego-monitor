/**
 * BigGo 比價爬蟲（主要取 Coupang 台灣價格）
 *
 * 搜尋 URL：https://biggo.com.tw/s/{query}
 * BigGo 為台灣站，無 Akamai 地區封鎖問題。
 *
 * 策略：
 *  - 搜尋 BigGo 取得所有商店的價格列表
 *  - 過濾出 `i=tw_pec_coupang` 的結果
 *  - 從 BigGo redirect URL 解析 Coupang 商品的 itemId，組成直連 URL
 *
 * 兩種模式：
 *  1. searchBySetNumber(page, setNumber) → 找特定 set number 在 Coupang 的最低價
 *  2. searchTopN(page, keyword, n)       → 廣域搜尋取前 N 筆 Coupang 商品
 */

const { chromium } = require('playwright');
const path = require('path');
const logger = require('../utils/logger');

const BIGGO_SEARCH = 'https://biggo.com.tw/s/';
const DEBUG_DIR = path.join(__dirname, '../../screenshots');

/**
 * 展示盒 / 周邊配件 關鍵字清單
 * 搜尋結果若命中以下任一關鍵字，視為非 LEGO 本體商品，直接排除。
 */
const DISPLAY_BOX_KEYWORDS = [
  // 中文
  '展示盒', '展示架', '展示台', '展示座',
  '壓克力', '壓克力盒', '壓克力架',
  '收納盒', '收納架',
  '保護盒', '保護殼',
  '防塵盒', '防塵套', '防塵罩',
  '透明盒', '積木架', '模型架',
  '拼裝盒', '儲物盒',
  // 英文 / 日文
  'display box', 'display case', 'display stand',
  'acrylic case', 'acrylic box',
  'storage box', 'dust cover',
];

function isDisplayBoxProduct(name) {
  const lower = name.toLowerCase();
  return DISPLAY_BOX_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function randomDelay(min = 1000, max = 2500) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function saveScreenshot(page, name) {
  if (!process.argv.includes('--debug')) return;
  const fs = require('fs');
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const file = path.join(DEBUG_DIR, `biggo_${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  logger.debug(`Screenshot: ${file}`);
}

async function createContext() {
  const headless = process.env.HEADLESS !== 'false';
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless });
  } catch {
    browser = await chromium.launch({ headless });
  }
  const context = await browser.newContext({
    locale: 'zh-TW',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  return { browser, context };
}

/**
 * 從 BigGo redirect URL 解析並組成真實 Coupang 商品頁 URL
 *
 * BigGo redirect 格式：
 *   /r/?i=tw_pec_coupang&id={pageKey}&purl={encodedOnelinkUrl}&...
 *
 * purl (Coupang onelink) 含有：
 *   pageKey={productId}  itemId={itemId}  vendorItemId={vendorItemId}
 *
 * 正確 Coupang 商品頁格式：
 *   https://www.tw.coupang.com/products/{pageKey}?itemId={itemId}&vendorItemId={vendorItemId}
 */
function parseCoupangUrl(biggoHref) {
  try {
    const fullUrl = biggoHref.startsWith('http')
      ? biggoHref
      : 'https://biggo.com.tw' + biggoHref;
    const params = new URL(fullUrl).searchParams;

    // purl 是 Coupang onelink URL，裡面有 pageKey / itemId / vendorItemId
    const purlRaw = params.get('purl') || '';
    const purl    = decodeURIComponent(purlRaw);

    let pageKey, itemId, vendorItemId;
    try {
      const purlParams = new URL(purl).searchParams;
      pageKey      = purlParams.get('pageKey') || purlParams.get('ctag') || null;
      itemId       = purlParams.get('itemId')       || null;
      vendorItemId = purlParams.get('vendorItemId') || null;
    } catch (_) {
      // purl 不是完整 URL，用 regex 抓
      pageKey      = (purl.match(/pageKey[=&](\d+)/i)      || purl.match(/ctag[=&](\d+)/i))?.[1];
      itemId       = purl.match(/itemId[=&](\d+)/i)?.[1];
      vendorItemId = purl.match(/vendorItemId[=&](\d+)/i)?.[1];
    }

    if (pageKey && itemId) {
      let url = `https://www.tw.coupang.com/products/${pageKey}?itemId=${itemId}`;
      if (vendorItemId) url += `&vendorItemId=${vendorItemId}`;
      return url;
    }

    // fallback: BigGo id 欄位（= pageKey）
    const id = params.get('id');
    if (id && itemId) return `https://www.tw.coupang.com/products/${id}?itemId=${itemId}`;
    if (id)           return `https://www.tw.coupang.com/products/${id}`;
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * 從 BigGo 搜尋結果頁擷取所有 Coupang 商品
 * @returns {Array<{ name, price, coupangUrl, biggoHref, setNumberHint }>}
 */
async function extractCoupangProducts(page) {
  await page.waitForSelector(
    '[class*="product-content-wrap"], [class*="ProductItem"]',
    { timeout: 10000 }
  ).catch(() => logger.debug('[BigGo] 等待商品卡 selector 逾時'));

  return page.evaluate(() => {
    const results = [];

    const cards = document.querySelectorAll('[class*="product-content-wrap"]');

    for (const card of cards) {
      // 商品標題連結（BigGo redirect）
      const titleLink = card.querySelector('[class*="product-title"] a[href*="/r/"]');
      if (!titleLink) continue;

      const href = titleLink.getAttribute('href') || '';

      // 只要 Coupang 的結果
      if (!href.includes('tw_pec_coupang')) continue;

      const name = titleLink.title || titleLink.textContent.trim();
      if (!name) continue;

      // 價格
      const priceEl = card.querySelector('[class*="product-price"]');
      const priceRaw = priceEl?.textContent?.replace(/[^0-9]/g, '') || '';
      const price = priceRaw ? parseInt(priceRaw, 10) : null;
      if (!price) continue;

      // 解析 Coupang 直連 URL（使用 parseCoupangUrl 統一邏輯）
      const fullHref = href.startsWith('http')
        ? href : 'https://biggo.com.tw' + href;

      // Note: parseCoupangUrl 在 browser context 外定義，此處用內嵌版
      let coupangUrl = null;
      try {
        const params = new URL(fullHref).searchParams;
        const purl = decodeURIComponent(params.get('purl') || '');
        let pageKey, itemId, vendorItemId;
        try {
          const pp = new URL(purl).searchParams;
          pageKey      = pp.get('pageKey') || pp.get('ctag');
          itemId       = pp.get('itemId');
          vendorItemId = pp.get('vendorItemId');
        } catch (_) {
          pageKey      = (purl.match(/pageKey[=&](\d+)/i) || purl.match(/ctag[=&](\d+)/i))?.[1];
          itemId       = purl.match(/itemId[=&](\d+)/i)?.[1];
          vendorItemId = purl.match(/vendorItemId[=&](\d+)/i)?.[1];
        }
        if (pageKey && itemId) {
          coupangUrl = `https://www.tw.coupang.com/products/${pageKey}?itemId=${itemId}`;
          if (vendorItemId) coupangUrl += `&vendorItemId=${vendorItemId}`;
        } else {
          const id = params.get('id');
          if (id && itemId) coupangUrl = `https://www.tw.coupang.com/products/${id}?itemId=${itemId}`;
          else if (id)      coupangUrl = `https://www.tw.coupang.com/products/${id}`;
        }
      } catch (_) { /* skip */ }

      // 從商品名稱嘗試抽取 set number（5~6 位數字）
      const snMatch = name.match(/\b(7\d{4}|[12]\d{4}|[3-6]\d{4})\b/);
      const setNumberHint = snMatch ? snMatch[1] : null;

      results.push({ name, price, coupangUrl, biggoHref: fullHref, setNumberHint });
    }

    return results;
  });
}

/**
 * 搜尋特定 set number，回傳 Coupang 上最低價那筆
 * @param {object} page
 * @param {string} setNumber  e.g. "76452"
 */
async function searchBySetNumber(page, setNumber) {
  const url = BIGGO_SEARCH + encodeURIComponent(`lego ${setNumber}`);
  logger.info(`[BigGo] 搜尋 ${setNumber} → ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(2000, 3000);
    await saveScreenshot(page, `set_${setNumber}`);

    const products = await extractCoupangProducts(page);
    logger.debug(`[BigGo] ${setNumber} → Coupang 結果 ${products.length} 筆`);

    if (products.length === 0) {
      logger.info(`[BigGo] ${setNumber} → Coupang 上找不到`);
      return null;
    }

    // 過濾展示盒 / 周邊配件（非 LEGO 本體）
    const filtered = products.filter((p) => !isDisplayBoxProduct(p.name));
    const excluded = products.length - filtered.length;
    if (excluded > 0) {
      logger.debug(
        `[BigGo] ${setNumber} 過濾非 LEGO 本體（展示盒等）${excluded} 筆：` +
        products.filter((p) => isDisplayBoxProduct(p.name)).map((p) => `「${p.name}」`).join(', ')
      );
    }

    if (filtered.length === 0) {
      logger.info(`[BigGo] ${setNumber} → Coupang 上找不到（全為展示盒）`);
      return null;
    }

    // 優先找名稱中含 set number 的，否則取最低價
    const exact = filtered.find((p) => p.name.includes(setNumber));
    const best  = exact || filtered.reduce((a, b) => a.price < b.price ? a : b);

    logger.info(
      `[BigGo] ${setNumber} → Coupang NT$${best.price}` +
      (best.coupangUrl ? ` | ${best.coupangUrl}` : '')
    );
    return { ...best, matchedSetNumber: setNumber };
  } catch (err) {
    logger.error(`[BigGo] searchBySetNumber ${setNumber} 失敗：${err.message}`);
    return null;
  }
}

/**
 * 廣域搜尋關鍵字，取前 N 筆 Coupang 商品（B 類掃描）
 * @param {object} page
 * @param {string} keyword   e.g. "樂高"
 * @param {number} topN
 */
async function searchTopN(page, keyword, topN = 30) {
  const url = BIGGO_SEARCH + encodeURIComponent(keyword);
  logger.info(`[BigGo] 廣域搜尋 "${keyword}"（取前 ${topN} 筆 Coupang 商品）`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(2000, 3000);
    await saveScreenshot(page, `topN_${keyword}`);

    const products = await extractCoupangProducts(page);
    logger.info(`[BigGo] "${keyword}" → Coupang ${products.length} 筆`);
    return products.slice(0, topN);
  } catch (err) {
    logger.error(`[BigGo] searchTopN "${keyword}" 失敗：${err.message}`);
    return [];
  }
}

/**
 * 完整掃描主入口
 *
 * @param {object} options
 * @param {string[]} options.setNumbers           - Watchlist 組號
 * @param {string[]} options.keywords             - 廣域搜尋關鍵字
 * @param {number}   options.topN                 - 廣域最多取幾筆
 * @param {boolean}  options.verifyWithProductPage - 是否進入 Coupang 商品頁取實際價格
 */
async function runScan({
  setNumbers = [],
  keywords   = ['樂高'],
  topN       = 30,
  verifyWithProductPage = false,
} = {}) {
  const { browser, context } = await createContext();
  const page = await context.newPage();
  const results = { watchlist: {}, topN: [] };

  // 若需要驗證商品頁，共用同一個 browser context 的新分頁
  let productPage = null;
  let fetchProductPrice = null;
  if (verifyWithProductPage) {
    try {
      ({ fetchProductPrice } = require('./coupang-product'));
      productPage = await context.newPage();
      logger.info('[BigGo] 啟用 Coupang 商品頁驗證模式');
    } catch (err) {
      logger.warn(`[BigGo] 無法載入 coupang-product.js，跳過商品頁驗證：${err.message}`);
      verifyWithProductPage = false;
    }
  }

  try {
    // 1. Watchlist 精準查詢
    logger.info(`[BigGo] 開始查詢 ${setNumbers.length} 個 watchlist 品項`);
    for (const sn of setNumbers) {
      const item = await searchBySetNumber(page, sn);
      if (item && verifyWithProductPage && item.coupangUrl && fetchProductPrice) {
        // 進入商品頁取真實價格（第一個商品需 warmup，後續跳過）
        const isFirst = Object.values(results.watchlist).filter(Boolean).length === 0;
        const productData = await fetchProductPrice(productPage, item.coupangUrl, sn, { skipWarmup: !isFirst });
        if (!productData.accessDenied && productData.lowestPrice) {
          const biggoPrice  = item.price;
          const actualPrice = productData.lowestPrice;
          if (biggoPrice !== actualPrice) {
            logger.info(
              `[BigGo→Product] ${sn} 價格差異：` +
              `BigGo NT$${biggoPrice} → 商品頁最低 NT$${actualPrice}` +
              (actualPrice < biggoPrice ? ` ✅ 實際更便宜 NT$${biggoPrice - actualPrice}` : ` ⚠️ 實際更貴`)
            );
          }
          // 以商品頁實際最低價覆蓋 BigGo 價格
          item.priceBiggo      = biggoPrice;        // 保留 BigGo 原始值
          item.price           = actualPrice;        // 使用商品頁最低價
          item.memberPrice     = productData.memberPrice;
          item.couponPrice     = productData.couponPrice;
          item.priceSource     = 'product_page';
        } else {
          item.priceSource = 'biggo';
        }
        await randomDelay(800, 1500);
      } else if (item) {
        item.priceSource = 'biggo';
      }
      results.watchlist[sn] = item;
      await randomDelay(1500, 2500);
    }

    // 2. 廣域搜尋（廣域不做商品頁驗證，避免請求量過大）
    const seen = new Set();
    for (const kw of keywords) {
      const items = await searchTopN(page, kw, topN);
      for (const item of items) {
        const key = item.coupangUrl || item.name;
        if (!seen.has(key)) {
          seen.add(key);
          item.priceSource = 'biggo';
          results.topN.push(item);
        }
      }
      await randomDelay(2000, 3500);
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
      const result = await searchBySetNumber(page, setNum);
      console.log('\n結果：', JSON.stringify(result, null, 2));
    } finally {
      await browser.close();
    }
  })();
}
