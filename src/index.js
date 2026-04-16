/**
 * Coupang 樂高監控系統 - 主入口
 *
 * 執行流程：
 * 1. 讀取 watchlist
 * 2. 對每個品項取得 PCHome 定價與特價（快取 40-50 天）
 * 3. 用 BigGo 搜尋各品項的 Coupang 現售價
 * 4. 分析折扣 → 發 Telegram 通知
 *    - Coupang 警報：非絕版 6.4折 / 絕版 6.9折
 *    - PCHome 特價：門檻各寬鬆 0.1折（6.5折 / 7.0折）
 * 5. 廣域搜尋前30筆樂高商品並同步分析
 *
 * 用法：
 *   node src/index.js              → 正常執行
 *   node src/index.js --debug      → 開啟截圖 + 詳細 log
 *   node src/index.js --dry-run    → 不寫 DB / 不發通知，只印結果
 */

require('dotenv').config();
const logger  = require('./utils/logger');
const db      = require('./data/db');
const { getPchomePrice }          = require('./crawler/pchome');
const { getSetPrice: getBrickEconomyPrice } = require('./crawler/brickeconomy');
const { runScan }                 = require('./crawler/biggo');
const { analyze, formatDiscount } = require('./analyzer/discount');
const notify  = require('./notify/index');
const { sendWeeklyReport }        = require('./reporter/weekly');

const watchlistConfig = require('../config/watchlist.json');
const settings        = require('../config/settings.json');

const DRY_RUN        = process.argv.includes('--dry-run');
const OFFSET_PCHOME  = settings.thresholds.pchome_sale_offset ?? 0.01;   // +0.1折

// ── 輔助 ──────────────────────────────────────────────────────────────────────

/**
 * 取 PCHome 定價 & 特價（雙快取策略）
 *
 * 快取分開計時：
 *  - 原價 / 絕版判斷：40-50 天（expires_at）；BrickEconomy 來源永不過期（2099年）
 *  - 特價：          2-3  天（sale_price_expires_at）
 *
 * 四種情況：
 *  1. 兩者都有效 → 直接回傳快取，不爬網頁
 *  2. 原價有效、特價過期 → 只重抓特價（BrickEconomy 來源跳過，沒有特價）
 *  3. 原價過期（含全新品項）→ 全部重抓，兩個 TTL 一起更新
 */
async function ensurePchomePrice(setNumber) {
  const cached = db.getPchomePrice(setNumber);
  const now    = new Date();

  const originalExpired = !cached || now > new Date(cached.expires_at);
  const saleExpired     = !cached
    || !cached.sale_price_expires_at
    || now > new Date(cached.sale_price_expires_at);

  // ── 情況 1：全部快取有效 ──────────────────────────────────────────────────
  if (!originalExpired && !saleExpired) {
    logger.debug(`[Cache] ${setNumber} 快取全部有效（原價到期：${cached.expires_at?.slice(0,10)}，特價到期：${cached.sale_price_expires_at?.slice(0,10)}）`);
    return {
      originalPrice: cached.original_price,
      salePrice:     cached.sale_price,
      isEol:         !!cached.is_eol,
    };
  }

  // ── 情況 2：原價有效、只有特價過期 ──────────────────────────────────────
  if (!originalExpired && saleExpired) {
    // BrickEconomy 來源 = 絕版品，PCHome 本來就找不到，不需要重抓特價
    if (cached.price_source === 'brickeconomy') {
      logger.debug(`[Cache] ${setNumber} BrickEconomy 定價永久有效，跳過特價重抓`);
      return {
        originalPrice: cached.original_price,
        salePrice:     null,
        isEol:         true,
        priceSource:   'brickeconomy',
      };
    }
    logger.debug(`[Cache] ${setNumber} 特價快取過期，重抓特價（原價沿用快取）`);
    const result = await getPchomePrice(setNumber);
    if (!DRY_RUN) {
      db.updateSalePriceCache(setNumber, result.salePrice || null);
    }
    return {
      originalPrice: cached.original_price,
      salePrice:     result.salePrice || null,
      isEol:         !!cached.is_eol,
    };
  }

  // ── 情況 3：原價也過期（或首次查詢）→ 全部重抓 ──────────────────────────
  logger.debug(`[Cache] ${setNumber} 快取全部過期，重抓全部`);
  const result = await getPchomePrice(setNumber);

  let originalPrice = result.originalPrice || null;
  let priceSource   = 'pchome';

  // PCHome 這次找不到（絕版或下架）
  if (!result.found) {
    // 優先：DB 裡有沒有上次查到的舊定價（最準確）
    const lastRecord = db.getLastPchomeRecord(setNumber);
    if (lastRecord?.original_price) {
      originalPrice = lastRecord.original_price;
      priceSource   = 'pchome_last';   // 標記為「PCHome 最後已知定價」
      logger.info(`[Cache] ${setNumber} PCHome 找不到，沿用上次定價 NT$${originalPrice}`);
    } else {
      // 完全沒有舊記錄 → 查 BrickEconomy
      logger.info(`[BrickEconomy] ${setNumber} 無歷史定價，查 BrickEconomy...`);
      const beResult = await getBrickEconomyPrice(setNumber);
      if (beResult.found && beResult.retailPriceTWD) {
        originalPrice = beResult.retailPriceTWD;
        priceSource   = 'brickeconomy';
        logger.info(`[BrickEconomy] ${setNumber} 採用 NT$${originalPrice}（USD $${beResult.retailPriceUSD} × 33）`);
      }
    }
  }

  if (!DRY_RUN) {
    db.savePchomePrice(
      setNumber,
      originalPrice,
      !result.found,
      result.salePrice || null,
      priceSource,
    );
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

async function main() {
  logger.info('====== 樂高價格監控開始 ======');
  logger.info(`Log 路徑：${logger.logFile}`);
  logger.info(`模式：${DRY_RUN ? 'DRY RUN（不寫 DB / 不通知）' : '正常執行'}`);

  await db.initDb();

  const watchlistItems = watchlistConfig.watchlist.filter(w => !w.disabled);
  const setNumbers     = watchlistItems.map(w => w.set_number);

  // ── Step 1: PCHome 定價 & 特價 ─────────────────────────────────────────────
  logger.info(`\n[Step 1] 取得 ${setNumbers.length} 個品項的 PCHome 定價（原價快取 40-50天 / 特價快取 2-3天）...`);
  const pchomePrices = {};

  for (const sn of setNumbers) {
    const p = await ensurePchomePrice(sn);
    pchomePrices[sn] = p;

    if (p.isEol) {
      const srcTag = p.priceSource === 'brickeconomy' ? '（BrickEconomy）'
                   : p.priceSource === 'pchome_last'  ? '（PCHome 最後紀錄）'
                   : '';
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
  const scanResult = await runScan({
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
      isEol:          pInfo.isEol,
      isWatchlist:    true,
      targetPrice:    w.target_price || null,
    });

    logger.info(
      `  ${sn} | Coupang NT$${coupangItem.price} / NT$${refPrice} | ` +
      `${analysis.discountStr} | ${analysis.shouldAlert ? '⚠️  警報' : '正常'}`
    );

    if (!DRY_RUN) {
      db.upsertProduct(sn, coupangItem.name, w.note || '');
      db.savePrice({
        setNumber:     sn,
        productName:   coupangItem.name,
        coupangUrl:    coupangItem.coupangUrl    || null,
        price:         coupangItem.price,
        originalPrice: coupangItem.originalPrice ?? null,
        discountPct:   analysis.discountPct,
      });
    }

    if (analysis.shouldAlert) {
      alerts.push({
        item: {
          setNumber:      sn,
          name:           coupangItem.name,
          coupangPrice:   coupangItem.price,
          pchomeOriginal: refPrice,
          isEol:          pInfo.isEol,
          coupangUrl:     coupangItem.coupangUrl,
          source:         'coupang',
          stats:          db.getPriceStats(sn),
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
    if (!DRY_RUN) await notify.sendDailySummary(setNumbers.length, 0);
  } else {
    for (const { item, analysis } of alerts) {
      printAlert(item, analysis);
      if (!DRY_RUN) {
        const key = `${item.setNumber || item.name}_${analysis.alertType}`;
        if (!db.wasAlertSentRecently(item.setNumber || item.name, analysis.alertType)) {
          await notify.sendAlert(item, analysis);
          db.saveAlertSent(item.setNumber || item.name, analysis.alertType, item.coupangPrice, analysis.discountPct);
        } else {
          logger.info(`  [通知] ${item.setNumber} 24小時內已通知過，跳過`);
        }
      }
    }
    if (!DRY_RUN) logger.info('');
  }

  // ── Step 6: 每週報告（週二發送）────────────────────────────────────────────
  const isWeeklyReportDay = new Date().getDay() === (settings.weekly_report?.day_of_week ?? 2);
  if (isWeeklyReportDay && !DRY_RUN) {
    logger.info('\n[Step 6] 今天是週報日，產生並發送週報...');
    await sendWeeklyReport(watchlistItems, pchomePrices, scanResult.watchlist, db);
  }

  logger.info('====== 執行完畢 ======\n');
}

main().catch((err) => {
  logger.error(`主程式錯誤：${err?.message ?? String(err)}`);
  if (err?.stack) logger.error(err.stack);
  process.exit(1);
});
