/**
 * 折扣分析模組
 *
 * 閾值（config/settings.json）：
 *   非絕版品：≤ 6.4折（64%）以下才通知
 *   絕版品  ：≤ 6.9折（69%）以下才通知
 *
 * 若 watchlist 品項有設定 target_price，優先用自訂價格判斷
 *
 * 警報類型：
 *   A = watchlist 品項
 *   B = 廣域搜尋品項
 */

const settings = require('../../config/settings.json');

const THRESHOLD_NORMAL = settings.thresholds.normal_item;  // 0.64
const THRESHOLD_EOL    = settings.thresholds.eol_item;     // 0.69

/**
 * @param {object} params
 * @param {number}       params.coupangPrice    Coupang 實際售價
 * @param {number}       params.pchomeOriginal  PCHome 原價/定價（折扣基準）
 * @param {number|null}  params.pchomeSale      PCHome 現售價（若比 Coupang 低，代表在 PChome 買更划算 → 不報）
 * @param {boolean}      params.isEol           是否為絕版
 * @param {boolean}      params.isWatchlist     是否為 watchlist 品項
 * @param {number|null}  params.targetPrice     自訂目標價（可選）
 *
 * @returns {{
 *   shouldAlert: boolean,
 *   discountPct: number,
 *   discountStr: string,   // e.g. "6.4折"
 *   threshold: number,
 *   reason: string,
 *   alertType: 'A'|'B'
 * }}
 */
function analyze({ coupangPrice, pchomeOriginal, pchomeSale = null, isEol, isWatchlist = false, targetPrice = null }) {
  if (!coupangPrice || !pchomeOriginal) {
    return { shouldAlert: false, discountPct: null, threshold: null, reason: 'missing_price' };
  }

  const discountPct = coupangPrice / pchomeOriginal;
  const discountStr = formatDiscount(discountPct);
  const alertType   = isWatchlist ? 'A' : 'B';

  // PChome 是否現在賣得比 Coupang 更便宜（有有效特價、且低於定價、且低於 Coupang）
  const pchomeBeatsCoupang =
    pchomeSale != null && pchomeSale < pchomeOriginal && pchomeSale < coupangPrice;

  // ── 自訂目標價（優先；使用者明確指定，不被 PChome 現售擋下）──────────
  if (isWatchlist && targetPrice != null) {
    const shouldAlert = coupangPrice <= targetPrice;
    return {
      shouldAlert,
      discountPct,
      discountStr,
      threshold: targetPrice / pchomeOriginal,
      reason: shouldAlert
        ? `低於自訂目標價 NT$${targetPrice.toLocaleString()}`
        : `未達自訂目標價（目標 NT$${targetPrice.toLocaleString()}）`,
      alertType,
    };
  }

  // ── 全域閾值 ───────────────────────────────────────────────
  const threshold       = isEol ? THRESHOLD_EOL : THRESHOLD_NORMAL;
  const meetsThreshold  = discountPct <= threshold;

  // 達到折扣門檻，但 PChome 現售更低 → 在 Coupang 買不划算，不報
  if (meetsThreshold && pchomeBeatsCoupang) {
    return {
      shouldAlert: false,
      discountPct,
      discountStr,
      threshold,
      reason: `Coupang ${discountStr}，但 PChome 現售更低（NT$${pchomeSale.toLocaleString()}）→ 不划算`,
      alertType,
    };
  }

  return {
    shouldAlert: meetsThreshold,
    discountPct,
    discountStr,
    threshold,
    reason: meetsThreshold
      ? (isEol ? `絕版品低於 ${(THRESHOLD_EOL * 10).toFixed(1)}折` : `低於 ${(THRESHOLD_NORMAL * 10).toFixed(1)}折`)
      : `${discountStr}（閾值 ${(threshold * 10).toFixed(1)}折，未達標準）`,
    alertType,
  };
}

/** 0.64 → "6.4折" */
function formatDiscount(pct) {
  return `${(pct * 10).toFixed(1)}折`;
}

module.exports = { analyze, formatDiscount };
