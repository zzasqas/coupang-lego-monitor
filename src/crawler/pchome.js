/**
 * PCHome 定價查詢模組（JSON API 版，無需 Playwright）
 *
 * PCHome 搜尋 JSON API：
 *   https://ecshweb.pchome.com.tw/search/v4.3/all/results?q=LEGO+{setNumber}&page=1&sort=rnk/dc
 *
 * 優點：
 *   - 不需要 Playwright / 真實瀏覽器，直接 HTTPS 請求
 *   - 不受機房 IP 反爬限制（API 端點無 Cloudflare 封鎖）
 *   - 回應速度快（~300ms vs Playwright ~3000ms）
 *
 * 回傳：
 *   { found: true,  originalPrice: 7499, salePrice: 5549, name: '...' }
 *   { found: false }  → 找不到，視為絕版
 */

require('dotenv').config();
const https  = require('https');
const logger = require('../utils/logger');

const SEARCH_API = 'https://ecshweb.pchome.com.tw/search/v4.3/all/results';

/** 呼叫 PCHome 搜尋 JSON API */
function fetchSearchJson(setNumber) {
  return new Promise((resolve, reject) => {
    const url = `${SEARCH_API}?q=LEGO+${encodeURIComponent(setNumber)}&page=1&sort=rnk/dc`;
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://24h.pchome.com.tw/',
      },
      timeout: 10000,
    };
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON 解析失敗（HTTP ${res.statusCode}）: ${data.slice(0, 80)}`)); }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('Request timeout')));
  });
}

/**
 * 從搜尋結果挑出「名稱含組號」的商品；找不到回 null（不做任何模糊備援）。
 * 用數字邊界比對，避免 21348 誤命中 213480 之類的子字串。
 * @returns {object|null}
 */
function matchProduct(prods, setNumber) {
  const re = new RegExp(`(^|\\D)${String(setNumber)}(\\D|$)`);
  return prods.find((p) => re.test(p.Name || '')) || null;
}

/**
 * 查詢 PCHome 的定價與現售價
 *
 * @param {string} setNumber   LEGO 組號，e.g. "76452"
 * @param {string} [pchomeId]  (已留作相容，JSON API 版本不使用)
 * @returns {{ found, originalPrice, salePrice, name }}
 */
async function getPchomePrice(setNumber, pchomeId) {
  logger.info(`[PCHome] 查詢 ${setNumber}（JSON API）`);
  try {
    const json  = await fetchSearchJson(setNumber);
    const prods = json.Prods || [];

    if (prods.length === 0) {
      logger.info(`[PCHome] ${setNumber} → 搜尋無結果 → 視為絕版`);
      return { found: false, reason: 'no_results' };
    }

    // 只認「名稱含組號」的商品。PChome 搜尋沒上架的組號時，會回一堆不相干的熱門
    // LEGO（瑪利歐、花束…），若退而抓「第一個 LEGO 商品」會張冠李戴、報出假特價，
    // 故不做 fallback：找不到組號就當絕版（不報 PChome 特價，改走 BrickEconomy/舊價）。
    const match = matchProduct(prods, setNumber);

    if (!match) {
      logger.info(`[PCHome] ${setNumber} → 共 ${prods.length} 筆，無一筆含組號 → 視為絕版`);
      return { found: false, reason: 'no_match', totalProds: prods.length };
    }

    if (!match.Price) {
      logger.info(`[PCHome] ${setNumber} → 商品無售價資料 → 視為絕版`);
      return { found: false, reason: 'no_price' };
    }

    // OriginPrice = 劃線原價（LEGO MSRP）；Price = 現售價
    // 若 OriginPrice 不存在或與 Price 相同 → 沒有在打折，以 Price 為定價
    const hasDiscount = match.OriginPrice && match.OriginPrice > match.Price;
    const originalPrice = hasDiscount ? match.OriginPrice : match.Price;
    const salePrice     = hasDiscount ? match.Price : null;

    logger.info(
      `[PCHome] ${setNumber} → 定價 NT$${originalPrice}` +
      (salePrice ? `（現售 NT$${salePrice}）` : '')
    );

    return {
      found:         true,
      name:          match.Name || '',
      originalPrice,
      salePrice,
    };

  } catch (err) {
    logger.error(`[PCHome] ${setNumber} API 錯誤：${err.message}`);
    return { found: false, reason: 'error' };
  }
}

module.exports = { getPchomePrice, matchProduct };

// 直接執行測試
if (require.main === module) {
  // node pchome.js selftest → 純比對自檢（不連網）
  if (process.argv.includes('selftest')) {
    const assert = require('assert');
    // 21348 未上架：PChome 回一堆不相干熱門 LEGO → 必須配不到（不可亂抓）
    assert.strictEqual(matchProduct([
      { Name: 'LEGO 樂高 超級瑪利歐系列 72046 Game Boy', Price: 1407, OriginPrice: 2199 },
      { Name: 'LEGO 樂高 Ideas 21358 人偶扭蛋機', Price: 4022 },
    ], '21348'), null, '21348 不該配到任何商品');
    // 有組號 → 命中該筆
    assert.strictEqual(matchProduct([
      { Name: 'LEGO 樂高 旋風忍者系列 71856 阿光的變形汽車', Price: 1169 },
    ], '71856').Price, 1169, '71856 應命中');
    // 子字串不可誤命中
    assert.strictEqual(matchProduct([{ Name: 'LEGO 213480 假貨' }], '21348'), null, '21348 不該配到 213480');
    console.log('✅ pchome matchProduct selftest 全過');
    process.exit(0);
  }
  const setNum = process.argv.find((a) => /^\d{4,6}$/.test(a)) || '76452';
  getPchomePrice(setNum).then((r) => {
    console.log('\n結果：', JSON.stringify(r, null, 2));
  });
}
