/**
 * Coupang 樂高監控系統 - 主入口
 *
 * 執行流程：
 * 1. 讀取 watchlist
 * 2. 對每個品項取得 PCHome 定價與特價（找不到 → BrickEconomy）
 * 3. 用 BigGo 搜尋各品項的 Coupang 現售價
 * 4. 分析折扣 → 發 Discord 通知
 *    - Coupang 警報：非絕版 6.4折 / 絕版 6.9折
 *    - PCHome 特價：門檻各寬鬆 0.1折（6.5折 / 7.0折）
 * 5. 廣域搜尋前30筆樂高商品並同步分析
 *
 * 用法：
 *   node src/index.js              → 正常執行
 *   node src/index.js --debug      → 開啟截圖 + 詳細 log
 *   node src/index.js --dry-run    → 不發通知，只印結果
 */

require('dotenv').config();
const logger  = require('./utils/logger');
const { getPchomePrice }          = require('./crawler/pchome');
const { getSetPrice: getBrickEconomyPrice } = require('./crawler/brickeconomy');
const { runScan: runBiggoScan }   = require('./crawler/biggo');
const { analyze, formatDiscount } = require('./analyzer/discount');
const notify  = require('./notify/index');

const settings        = require('../config/settings.json');

const OFFSET_PCHOME  = settings.thresholds.pchome_sale_offset ?? 0.01;   // +0.1折

// ── 輔助 ──────────────────────────────────────────────────────────────────────

/** 取 PCHome 定價 & 特價；PCHome 找不到（多半是絕版）→ BrickEconomy 定價 */
async function ensurePchomePrice(setNumber, pchomeId) {
  const result = await getPchomePrice(setNumber, pchomeId);
  let originalPrice = result.originalPrice || null;
  let priceSource   = 'pchome';
  if (!result.found) {
    logger.info(`[BrickEconomy] ${setNumber} PCHome 找不到，查 BrickEconomy...`);
    const beResult = await getBrickEconomyPrice(setNumber);
    if (beResult.found && beResult.retailPriceTWD) {
      originalPrice = beResult.retailPriceTWD;
      priceSource   = 'brickeconomy';
      logger.info(`[BrickEconomy] ${setNumber} 採用 NT$${originalPrice}（USD $${beResult.retailPriceUSD} × 33）`);
    }
  }
  return {
    originalPrice,
    salePrice:  result.salePrice || null,
    isEol:      !result.found,
    priceSource,
  };
}

/** 印出警報到 console */
function printAlert(item, analysis) {
  const eolTag  = item.isEol ? '【絕版品】' : '';
  const srcTag  = item.source === 'pchome' ? 'PCHome特價' :
                  analysis.alertType === 'A' ? '關注品項'  : '廣域掃描';
  const icon    = item.source === 'pchome'  ? '🏪' :
                  analysis.alertType === 'A' ? '🔔'        : '🔥';
  console.log(`\n${icon} ${eolTag}[${srcTag}] 折扣警報`);
  console.log(`  商品：${item.name || item.setNumber}`);
  if (item.setNumber) console.log(`  組號：#${item.setNumber}`);
  if (item.source === 'pchome') {
    console.log(`  PCHome 現售：NT$${item.coupangPrice?.toLocaleString()}（定價 NT$${item.pchomeOriginal?.toLocaleString()}）`);
    console.log(`  折扣：${analysis.discountStr}（${analysis.reason}）`);
    console.log(`  🔗 https://24h.pchome.com.tw/search/?q=LEGO+${item.setNumber}`);
  } else {
    console.log(`  Coupang 現售：NT$${item.coupangPrice?.toLocaleString()}（PCHome 定價 NT$${item.pchomeOriginal?.toLocaleString()}）`);
    console.log(`  折扣：${analysis.discountStr}（${analysis.reason}）`);
    if (item.coupangUrl) console.log(`  🔗 ${item.coupangUrl}`);
  }
}

// ── 主程式 ────────────────────────────────────────────────────────────────────

async function runScan({ dryRun = false } = {}) {
  logger.info('====== 樂高價格監控開始 ======');
  logger.info(`Log 路徑：${logger.logFile}`);
  logger.info(`模式：${dryRun ? 'DRY RUN（不通知）' : '正常執行'}`);

  const watchlistItems = (require('../config/watchlist.json').watchlist || [])
    .filter(w => !w.disabled)
    .map(w => ({
      set_number:   String(w.set_number),
      note:         w.note         || '',
      is_eol:       !!w.is_eol,
      target_price: w.target_price || null,
      pchome_id:    w.pchome_id   || null,
    }));
  logger.info(`[Watchlist] 從 watchlist.json 讀取 ${watchlistItems.length} 個品項`);
  const setNumbers = watchlistItems.map(w => w.set_number);

  // ── Step 1: PCHome 定價 & 特價 ─────────────────────────────────────────────
  logger.info(`\n[Step 1] 取得 ${setNumbers.length} 個品項的 PCHome 定價...`);
  const pchomePrices = {};
  const manualEolSet = new Set(watchlistItems.filter(w => w.is_eol).map(w => w.set_number));

  for (const w of watchlistItems) {
    const sn = w.set_number;
    const p = await ensurePchomePrice(sn, w.pchome_id || null);
    // 手動絕版標註（watchlist.is_eol）→ 強制走絕版邏輯（閾值放寬）
    if (manualEolSet.has(sn)) p.isEol = true;
    pchomePrices[sn] = p;

    if (p.isEol) {
      const srcTag = p.priceSource === 'brickeconomy' ? '（BrickEconomy）' : '';
      const priceTag = p.originalPrice ? `，參考定價 NT$${p.originalPrice}${srcTag}` : '，無參考定價';
      logger.info(`  ${sn} → ⚠️  絕版${priceTag}，Coupang 閾值 ${(settings.thresholds.eol_item * 10).toFixed(1)}折`);
    } else {
      const saleTag = p.salePrice && p.salePrice !== p.originalPrice
        ? `，特價 NT$${p.salePrice}`
        : '';
      logger.info(`  ${sn} → 定價 NT$${p.originalPrice}${saleTag}，閾值 ${(settings.thresholds.normal_item * 10).toFixed(1)}折`);
    }
  }

  // ── Step 1b: PCHome 特價分析 ──────────────────────────────────────────────
  logger.info('\n[Step 1b] 分析 PCHome 特價...');
  const alerts = [];

  for (const w of watchlistItems) {
    const sn = w.set_number;
    const p  = pchomePrices[sn];
    if (!p.originalPrice || !p.salePrice) continue;
    if (p.salePrice >= p.originalPrice)   continue;  // 沒有打折

    const threshold = (p.isEol
      ? settings.thresholds.eol_item
      : settings.thresholds.normal_item) + OFFSET_PCHOME;

    const discountPct = p.salePrice / p.originalPrice;
    const discountStr = formatDiscount(discountPct);

    if (discountPct <= threshold) {
      const analysis = {
        shouldAlert:  true,
        discountPct,
        discountStr,
        threshold,
        reason:     `PCHome 特價 ${discountStr}（門檻 ${(threshold * 10).toFixed(1)}折）`,
        alertType:  'P',
      };
      const item = {
        setNumber:      sn,
        name:           w.note || sn,
        coupangPrice:   p.salePrice,
        pchomeOriginal: p.originalPrice,
        isEol:          p.isEol,
        source:         'pchome',
      };
      logger.info(`  ${sn} | PCHome NT$${p.salePrice} / NT$${p.originalPrice} | ${discountStr} | ⚠️  PCHome 特價警報`);
      alerts.push({ item, analysis });
    } else {
      logger.info(`  ${sn} | PCHome NT$${p.salePrice} / NT$${p.originalPrice} | ${discountStr} | 正常`);
    }
  }

  // ── Step 2: BigGo 取 Coupang 售價 ─────────────────────────────────────────
  const verifyProductPage = process.env.VERIFY_COUPANG === 'true'
    || settings.coupang.verify_product_page === true;

  logger.info(
    `\n[Step 2] 透過 BigGo 取得 Coupang 售價` +
    (verifyProductPage ? '（啟用商品頁二次驗證）' : '（僅 BigGo 快取價）') + '...'
  );
  const scanResult = await runBiggoScan({
    setNumbers,
    keywords:             settings.coupang.search_keywords,
    topN:                 settings.coupang.search_top_n,
    verifyWithProductPage: verifyProductPage,
  });

  // ── Step 3: 分析 Watchlist（Coupang）────────────────────────────────────────
  logger.info('\n[Step 3] 分析 Coupang watchlist 品項...');

  for (const w of watchlistItems) {
    const sn          = w.set_number;
    const coupangItem = scanResult.watchlist[sn];
    const pInfo       = pchomePrices[sn];

    if (!coupangItem) {
      logger.warn(`  ${sn} → Coupang 未找到`);
      continue;
    }

    const refPrice = pInfo.originalPrice || coupangItem.originalPrice;
    if (!refPrice) {
      logger.warn(`  ${sn} → 無法取得參考定價，跳過`);
      continue;
    }

    const analysis = analyze({
      coupangPrice:   coupangItem.price,
      pchomeOriginal: refPrice,
      pchomeSale:     pInfo.salePrice || null,
      isEol:          pInfo.isEol,
      isWatchlist:    true,
      targetPrice:    w.target_price || null,
    });

    logger.info(
      `  ${sn} | Coupang NT$${coupangItem.price} / NT$${refPrice} | ` +
      `${analysis.discountStr} | ${analysis.shouldAlert ? '⚠️  警報' : '正常'}`
    );

    if (analysis.shouldAlert) {
      alerts.push({
        item: {
          setNumber:      sn,
          name:           coupangItem.name,
          coupangPrice:   coupangItem.price,
          pchomeOriginal: refPrice,
          pchomeSale:     pInfo.salePrice || null,
          isEol:          pInfo.isEol,
          coupangUrl:     coupangItem.coupangUrl,
          source:         'coupang',
        },
        analysis,
      });
    }
  }

  // ── Step 4: 廣域掃描（Coupang）───────────────────────────────────────────────
  logger.info('\n[Step 4] 分析廣域掃描結果...');
  for (const product of scanResult.topN) {
    const snMatch = (product.name + (product.coupangUrl || '')).match(/\b(7\d{4}|[12]\d{4})\b/);
    const sn = snMatch ? snMatch[1] : null;
    if (sn && setNumbers.includes(sn)) continue;

    const refPrice = product.originalPrice;
    if (!refPrice || refPrice <= product.price) continue;

    const analysis = analyze({
      coupangPrice:   product.price,
      pchomeOriginal: refPrice,
      isEol:          false,
      isWatchlist:    false,
    });

    if (analysis.shouldAlert) {
      alerts.push({
        item: {
          setNumber:      sn,
          name:           product.name,
          coupangPrice:   product.price,
          pchomeOriginal: refPrice,
          isEol:          false,
          coupangUrl:     product.coupangUrl,
          source:         'coupang',
        },
        analysis,
      });
    }
  }

  // ── Step 5: 輸出 + 通知 ───────────────────────────────────────────────────
  logger.info(`\n[Step 5] 警報總數：${alerts.length} 筆`);

  if (alerts.length === 0) {
    logger.info('目前無符合閾值的優惠。');
    if (!dryRun) await notify.sendDailySummary(setNumbers.length, 0);
  } else {
    for (const { item, analysis } of alerts) {
      printAlert(item, analysis);
      // ponytail: 無去重，同一警報每次掃描都會發；要去重得存「上次通知」狀態
      if (!dryRun) await notify.sendAlert(item, analysis);
    }
    if (!dryRun) logger.info('');
  }

  logger.info('====== 執行完畢 ======\n');
  return { alertCount: alerts.length, scanned: setNumbers.length };
}

module.exports = { runScan };

// 直接執行時：跑一次掃描（工作排程器 / GitHub Actions / 手動）
if (require.main === module) {
  runScan({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error(`主程式錯誤：${err?.message ?? String(err)}`);
      if (err?.stack) logger.error(err.stack);
      process.exit(1);
    });
}
