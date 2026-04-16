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
 * @param {number}       params.pchomeOriginal  PCHome 原價（基準）
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
function analyze({ coupangPrice, pchomeOriginal, isEol, isWatchlist = false, targetPrice = null }) {
  if (!coupangPrice || !pchomeOriginal) {
    return { shouldAlert: false, discountPct: null, threshold: null, reason: 'missing_price' };
  }

  const discountPct = coupangPrice / pchomeOriginal;
  const discountStr = formatDiscount(discountPct);
  const alertType   = isWatchlist ? 'A' : 'B';

  // ── 自訂目標價（優先）──────────────────────────────────────
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
  const threshold   = isEol ? THRESHOLD_EOL : THRESHOLD_NORMAL;
  const shouldAlert = discountPct <= threshold;

  return {
    shouldAlert,
    discountPct,
    discountStr,
    threshold,
    reason: shouldAlert
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
