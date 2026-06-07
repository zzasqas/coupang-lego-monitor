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

    // 比對優先順序：
    // 1. Name 含組號（最精準）
    // 2. 第一筆含 "LEGO" 且 Name 含 "樂高" 或 "LEGO" 的商品（組號未出現在名稱時的備援）
    const sn = String(setNumber);
    let match = prods.find((p) => (p.Name || '').includes(sn));
    if (!match) {
      match = prods.find((p) => {
        const name = (p.Name || '').toUpperCase();
        return name.includes('LEGO') || name.includes('樂高');
      });
    }

    if (!match) {
      logger.info(`[PCHome] ${setNumber} → 共 ${prods.length} 筆，無符合商品 → 視為絕版`);
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

module.exports = { getPchomePrice };

// 直接執行測試
if (require.main === module) {
  const setNum = process.argv.find((a) => /^\d{4,6}$/.test(a)) || '76452';
  getPchomePrice(setNum).then((r) => {
    console.log('\n結果：', JSON.stringify(r, null, 2));
  });
}
