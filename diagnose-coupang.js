/**
 * Coupang 搜尋頁 HTML 結構診斷工具
 * 執行：node diagnose-coupang.js
 * 目的：找出正確的商品卡 selector，並截圖確認
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

(async () => {
  console.log('啟動瀏覽器（會開啟視窗）...');

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    browser = await chromium.launch({ headless: false });
  }

  const context = await browser.newContext({
    locale: 'zh-TW',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  // 先去首頁
  console.log('訪問首頁...');
  await page.goto('https://www.tw.coupang.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // 直接去搜尋頁
  console.log('搜尋 10350...');
  await page.goto('https://www.tw.coupang.com/search?q=10350&channel=user', {
    waitUntil: 'domcontentloaded', timeout: 30000
  });
  await page.waitForTimeout(4000);

  console.log('Title:', await page.title());
  console.log('URL:', page.url());

  // 截圖
  const screenshotFile = path.join(SCREENSHOT_DIR, 'coupang_10350_diagnosis.png');
  await page.screenshot({ path: screenshotFile, fullPage: false });
  console.log('截圖儲存：', screenshotFile);

  // 診斷商品卡結構
  const diagnosis = await page.evaluate(() => {
    const CARD_SELECTORS = [
      '.search-product', 'li.prod-search-unit', '[class*="SearchProduct"]',
      '[class*="search-product-wrap"]', '[class*="ProductCard"]',
      'ul.search-result li', 'article', 'li[class*="Product"]'
    ];

    const found = {};
    for (const sel of CARD_SELECTORS) {
      const count = document.querySelectorAll(sel).length;
      if (count > 0) found[sel] = count;
    }

    // 抓第一個有「10350」或「LEGO」的元素
    const bodyText = document.body.innerText.slice(0, 200);
    const allClasses = [...new Set(
      [...document.querySelectorAll('[class]')]
        .map(e => e.className.split(/\s+/)[0])
        .filter(c => c && c.length > 3)
    )].slice(0, 30);

    // 找含「10350」的元素
    const withSetNum = [...document.querySelectorAll('*')]
      .filter(e => e.childElementCount === 0 && e.textContent.includes('10350'))
      .slice(0, 5)
      .map(e => ({ tag: e.tagName, class: e.className.slice(0, 60), text: e.textContent.trim().slice(0, 80) }));

    return { found, bodyPreview: bodyText, allClasses, withSetNum };
  });

  console.log('\n=== 診斷結果 ===');
  console.log('找到的商品卡 selector：', JSON.stringify(diagnosis.found, null, 2));
  console.log('\n頁面文字預覽：', diagnosis.bodyPreview);
  console.log('\n含 10350 的元素：', JSON.stringify(diagnosis.withSetNum, null, 2));
  console.log('\n頂層 class 列表：', diagnosis.allClasses.join(', '));

  // 如果有找到商品卡，抓第一個的完整 HTML
  if (Object.keys(diagnosis.found).length > 0) {
    const firstSel = Object.keys(diagnosis.found)[0];
    const sampleHtml = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.outerHTML.slice(0, 1500) : 'not found';
    }, firstSel);
    console.log(`\n第一個商品卡 (${firstSel}) HTML：\n`, sampleHtml);
    fs.writeFileSync(path.join(SCREENSHOT_DIR, 'coupang_card_sample.html'), sampleHtml);
    console.log('HTML 儲存至 screenshots/coupang_card_sample.html');
  }

  await browser.close();
  console.log('\n診斷完成！');
})();
