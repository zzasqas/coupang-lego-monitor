/**
 * PCHome 定價爬蟲
 *
 * 搜尋：https://24h.pchome.com.tw/search/?q=LEGO+{setNumber}
 * 抓取：
 *   - 商品名（h3.c-prodInfoV2__title）
 *   - 原價/定價（.c-prodInfoV2__salePrice .c-prodInfoV2__priceValue--xs）
 *     → 若無劃線原價，fallback 到現售價
 *   - 找不到商品 → is_eol = true
 *
 * 回傳：
 *   { found: true,  originalPrice: 3749, salePrice: 2549, name: '...' }
 *   { found: false }  → 視為絕版
 */

const { chromium } = require('playwright');
const path = require('path');
const logger = require('../utils/logger');

const PCHOME_SEARCH = 'https://24h.pchome.com.tw/search/?q=LEGO+';
const DEBUG_DIR = path.join(__dirname, '../../screenshots');

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function saveScreenshot(page, name) {
  if (!process.argv.includes('--debug')) return;
  const fs = require('fs');
  if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
  const file = path.join(DEBUG_DIR, `pchome_${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  logger.debug(`Screenshot: ${file}`);
}

/**
 * @param {string} setNumber  e.g. "76452"
 * @returns {{ found: boolean, originalPrice?: number, salePrice?: number, name?: string }}
 */
async function getPchomePrice(setNumber) {
  const headless = process.env.HEADLESS !== 'false';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    locale: 'zh-TW',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    const url = PCHOME_SEARCH + encodeURIComponent(setNumber);
    logger.info(`[PCHome] 查詢 ${setNumber} → ${url}`);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(2500);

    // 等待商品卡出現
    await page.waitForSelector('.c-prodInfoV2', { timeout: 10000 })
      .catch(() => logger.debug(`[PCHome] ${setNumber} 等待商品卡逾時`));

    await saveScreenshot(page, setNumber);

    const result = await page.evaluate((sn) => {
      const cards = [...document.querySelectorAll('.c-prodInfoV2')];
      if (cards.length === 0) return { found: false, reason: 'no_cards' };

      for (const card of cards) {
        // 商品名稱
        const nameEl = card.querySelector(
          'h3[data-regression="store_prodName"], .c-prodInfoV2__title, h3, h4'
        );
        const name = nameEl?.textContent?.trim() || '';

        // 圖片 alt（也含商品名）
        const imgAlt = card.querySelector('img')?.alt || '';

        // 必須包含 set number
        const combined = name + imgAlt;
        if (!combined.includes(sn)) continue;

        // 原價（劃線定價）: .c-prodInfoV2__salePrice 內的 --xs 價格
        const origEl = card.querySelector(
          '.c-prodInfoV2__salePrice .c-prodInfoV2__priceValue--xs'
        );
        const origRaw = origEl?.textContent?.replace(/[^0-9]/g, '') || '';
        const originalPrice = origRaw ? parseInt(origRaw, 10) : null;

        // 現售價: --m 規格的價格
        const priceEl = card.querySelector(
          '.c-prodInfoV2__priceValue--m, [data-regression="store_prodPrice"] [class*="priceValue"]'
        );
        const priceRaw = priceEl?.textContent?.replace(/[^0-9]/g, '') || '';
        const salePrice = priceRaw ? parseInt(priceRaw, 10) : null;

        // 參考基準：優先用劃線原價，沒有就用售價
        const refPrice = originalPrice || salePrice;
        if (!refPrice) continue;

        return {
          found: true,
          name: name || imgAlt,
          originalPrice: refPrice,   // 這是我們的「基準定價」
          salePrice,
        };
      }

      // 有卡片但沒有符合 set number 的商品
      return { found: false, reason: 'no_match', totalCards: cards.length };
    }, setNumber);

    if (result.found) {
      logger.info(
        `[PCHome] ${setNumber} → 定價 NT$${result.originalPrice}` +
        (result.salePrice && result.salePrice !== result.originalPrice
          ? `（現售 NT$${result.salePrice}）`
          : '')
      );
    } else {
      logger.info(`[PCHome] ${setNumber} → 找不到（reason: ${result.reason}）→ 視為絕版`);
    }

    return result;
  } catch (err) {
    logger.error(`[PCHome] ${setNumber} 錯誤：${err.message}`);
    return { found: false, reason: 'error' };
  } finally {
    await browser.close();
  }
}

module.exports = { getPchomePrice };

// 直接執行測試
if (require.main === module) {
  const setNum = process.argv.find((a) => /^\d{5,6}$/.test(a)) || '76452';
  getPchomePrice(setNum).then((r) => {
    console.log('\n結果：', JSON.stringify(r, null, 2));
  });
}
