/**
 * Coupang TW 商品頁直接讀取價格
 *
 * 流程：
 *  BigGo redirect URL → Playwright 跟隨跳轉至真實商品頁 → 讀取實際售價
 *
 * 可取得：
 *  - regularPrice  : 一般售價
 *  - memberPrice   : 會員專屬價（Rocket Club）
 *  - couponPrice   : 優惠券適用價
 *  - lowestPrice   : 上述取最低
 *
 * 用法（獨立測試）：
 *   node src/crawler/coupang-product.js 71848
 *   node src/crawler/coupang-product.js https://www.tw.coupang.com/products/...
 */

require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const logger = require('../utils/logger');

const DEBUG_DIR = path.join(__dirname, '../../screenshots');

function randomDelay(min = 1200, max = 2500) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

async function saveScreenshot(page, name) {
  const fs = require('fs');
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const file = path.join(DEBUG_DIR, `coupang_product_${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  logger.info(`Screenshot saved: ${file}`);
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
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });
  return { browser, context };
}

/**
 * 用文字走訪器掃描整個頁面，找出所有看起來像價格的元素
 * 回傳 [{ text, tag, className }]
 */
async function scanAllPrices(page) {
  return page.evaluate(() => {
    const results = [];
    const seen = new Set();
    const allEls = document.querySelectorAll('*');

    for (const el of allEls) {
      // 只看葉節點（沒有子 Element，只有文字）
      if (el.children.length > 0) continue;

      const text = el.textContent?.trim() || '';
      // 符合 NT$1,234 或純數字 4+ 位
      if (!/NT\$[\d,]+|\b\d{4,}\b/.test(text)) continue;
      if (text.length > 30) continue;  // 排除長段落

      const key = `${el.className}|${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        text,
        tag: el.tagName,
        className: (el.className || '').slice(0, 120),
        id: el.id || '',
      });
    }
    return results;
  });
}

/**
 * 從掃描結果中，依關鍵字優先序取出最可能的價格
 */
function pickPrice(priceElements, keywords) {
  for (const kw of keywords) {
    const el = priceElements.find((e) =>
      e.className.toLowerCase().includes(kw) ||
      e.id.toLowerCase().includes(kw)
    );
    if (el) {
      const num = parseInt(el.text.replace(/[^0-9]/g, ''), 10);
      if (num > 0) return { price: num, source: el.className };
    }
  }
  return null;
}

/**
 * 主函式：造訪 Coupang 商品頁，回傳價格資訊
 *
 * @param {object} page          Playwright page
 * @param {string} navigateUrl   要訪問的 URL（可以是 BigGo redirect URL 或 Coupang 直連）
 * @param {string} [label]       log 標籤
 */
/**
 * 建立 Coupang session（先訪問首頁讓 Akamai cookie 生效）
 * 每個 context 只需呼叫一次
 */
async function warmupCoupang(page) {
  logger.info('[CoupangProduct] 建立 Coupang session（訪問首頁）...');
  await page.goto('https://www.tw.coupang.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await randomDelay(2000, 3000);
  const title = await page.title();
  logger.info(`[CoupangProduct] 首頁 title：${title}`);
}

async function fetchProductPrice(page, navigateUrl, label = '', { skipWarmup = false } = {}) {
  const tag = label ? `[${label}]` : '';
  logger.info(`[CoupangProduct]${tag} 導向：${navigateUrl.slice(0, 80)}...`);

  try {
    // 第一次訪問 Coupang 前先進首頁建立 session
    if (!skipWarmup) {
      await warmupCoupang(page);
    }

    await page.goto(navigateUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 等待 React render 完成
    await randomDelay(3000, 4500);

    const finalUrl = page.url();
    logger.info(`[CoupangProduct]${tag} 最終 URL：${finalUrl.slice(0, 100)}`);

    // 偵測封鎖
    const bodySnippet = await page.evaluate(() =>
      document.body?.innerText?.slice(0, 120) || ''
    );
    if (bodySnippet.includes('Access Denied') || (await page.title()) === 'Access Denied') {
      logger.warn(`[CoupangProduct]${tag} ⚠️  Access Denied`);
      return { url: finalUrl, accessDenied: true, lowestPrice: null,
               regularPrice: null, memberPrice: null, couponPrice: null, name: null };
    }

    // 截圖（一律存，方便確認）
    await saveScreenshot(page, label || 'item');

    // 商品名稱
    const name = await page.evaluate(() => {
      const el = document.querySelector([
        'h1.prod-buy-header__title',
        '[class*="prod-name"] h1',
        '[class*="product-title"] h1',
        'h2[class*="name"]',
        'h1',
      ].join(', '));
      return el?.textContent?.trim() || null;
    });

    // 掃描所有價格元素
    const priceElements = await scanAllPrices(page);
    logger.info(`[CoupangProduct]${tag} 找到 ${priceElements.length} 個價格元素`);

    // 印出所有找到的元素（供分析 selector）
    if (priceElements.length > 0) {
      logger.info(`[CoupangProduct]${tag} ── 價格元素列表 ──`);
      priceElements.forEach((e, i) =>
        logger.info(`  [${i}] "${e.text}"  tag=${e.tag}  class="${e.className}"`)
      );
    }

    // 依優先序抓各類價格
    const regularResult = pickPrice(priceElements, [
      'sale-price', 'saleprice', 'final-price', 'finalprice',
      'prod-price-value', 'price-value', 'pricevalue',
    ]);
    const memberResult = pickPrice(priceElements, [
      'member', 'club', 'rocket-club', 'rocketclub', 'subscriber',
    ]);
    const couponResult = pickPrice(priceElements, [
      'coupon', 'coupang-price', 'coupon-price',
    ]);

    const regularPrice = regularResult?.price || null;
    const memberPrice  = memberResult?.price  || null;
    const couponPrice  = couponResult?.price  || null;

    const candidates = [regularPrice, memberPrice, couponPrice].filter((p) => p && p > 0);
    const lowestPrice = candidates.length ? Math.min(...candidates) : null;

    logger.info(
      `[CoupangProduct]${tag} ` +
      `一般：${regularPrice ? 'NT$' + regularPrice : '-'}  ` +
      `會員：${memberPrice  ? 'NT$' + memberPrice  : '-'}  ` +
      `券後：${couponPrice  ? 'NT$' + couponPrice  : '-'}  ` +
      `→ 最低：${lowestPrice ? 'NT$' + lowestPrice : '(無法取得)'}`
    );

    return {
      url: finalUrl, name, regularPrice, memberPrice, couponPrice,
      lowestPrice, accessDenied: false, priceElements,
    };

  } catch (err) {
    logger.error(`[CoupangProduct]${tag} 錯誤：${err?.message ?? String(err)}`);
    return { url: navigateUrl, name: null, regularPrice: null, memberPrice: null,
             couponPrice: null, lowestPrice: null, accessDenied: false };
  }
}

module.exports = { fetchProductPrice, warmupCoupang, createContext };

// ── 獨立測試 ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const arg = process.argv[2] || '71848';
  const isUrl = arg.startsWith('http');

  (async () => {
    const { browser, context } = await createContext();
    const page = await context.newPage();

    try {
      if (isUrl) {
        // 直接測試指定 URL
        const result = await fetchProductPrice(page, arg, 'TEST', { skipWarmup: false });
        console.log('\n=== 結果 ===');
        console.log(JSON.stringify({ ...result, priceElements: undefined }, null, 2));

      } else {
        // 透過 BigGo 取得 URL 再訪問商品頁
        const { searchBySetNumber, createContext: biggoContext } = require('./biggo');
        logger.info(`先透過 BigGo 取得 ${arg} 的 Coupang 資訊...`);

        const { browser: bgBrowser, context: bgCtx } = await biggoContext();
        const bgPage = await bgCtx.newPage();
        let biggoResult;
        try {
          biggoResult = await searchBySetNumber(bgPage, arg);
        } finally {
          await bgBrowser.close();
        }

        if (!biggoResult) {
          logger.warn(`BigGo 找不到 ${arg}`);
          return;
        }

        console.log(`\nBigGo 價格：NT$${biggoResult.price}`);
        console.log(`Coupang URL：${biggoResult.coupangUrl}`);

        // 直接用 coupangUrl（已含正確 pageKey/itemId/vendorItemId）
        const navUrl = biggoResult.coupangUrl;
        if (!navUrl) {
          logger.warn('無法取得 Coupang URL，結束');
          return;
        }
        const result = await fetchProductPrice(page, navUrl, arg);

        console.log('\n=== 商品頁實際價格 ===');
        console.log(JSON.stringify({ ...result, priceElements: undefined }, null, 2));

        if (biggoResult.price && result.lowestPrice) {
          const diff = biggoResult.price - result.lowestPrice;
          console.log(`\n差異：BigGo NT$${biggoResult.price} vs 商品頁 NT$${result.lowestPrice}`);
          console.log(diff > 0
            ? `→ 實際比 BigGo 便宜 NT$${diff}`
            : diff < 0
              ? `→ 實際比 BigGo 貴 NT$${Math.abs(diff)}`
              : `→ 兩者相同`
          );
        } else if (!result.lowestPrice) {
          console.log('\n⚠️  Selector 尚未對應，請查看上方價格元素列表，把正確的 class 回報給我調整');
        }
      }
    } finally {
      await browser.close();
    }
  })();
}
