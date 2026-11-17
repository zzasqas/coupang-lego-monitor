# 🧱 樂高價格監控系統

監控 Coupang 台灣站與 PCHome 的樂高價格，達到折扣門檻就發 Discord 通知。
本機每天 11:35、GitHub Actions 每天 08:00 / 21:00 各跑一次。沒有資料庫，追蹤清單就是 `config/watchlist.json`。

---

## 目錄

- [流程](#流程)
- [快速開始](#快速開始)
- [修改追蹤品項](#修改追蹤品項)
- [修改折扣門檻](#修改折扣門檻)
- [排程](#排程)
- [常用指令](#常用指令)
- [Discord 通知設定](#discord-通知設定)
- [警報類型](#警報類型)
- [專案結構](#專案結構)

---

## 流程

```
每次執行
  │
  ├─ Step 1  PCHome → 定價 & 特價（找不到 → 視為絕版，改查 BrickEconomy 定價）
  ├─ Step 1b PCHome 特價分析（門檻寬鬆 0.1折）
  ├─ Step 2  BigGo → Coupang 現售價（watchlist 品項 + 廣域搜尋前 30 筆）
  ├─ Step 3  Coupang watchlist 折扣分析
  ├─ Step 4  Coupang 廣域掃描分析
  └─ Step 5  發 Discord 通知（沒警報也發一則摘要）
```

| 元件 | 說明 |
|------|------|
| Node.js + Playwright | 爬 BigGo、PCHome、BrickEconomy |
| BigGo | Coupang 價格中介（繞過 Akamai 地區限制） |
| PCHome | 比價基準（定價參考） |
| Discord Webhook | 推播通知 |

> 沒有資料庫：不存價格歷史，同一個警報每次執行都會再發一次。

---

## 快速開始

```bash
npm install
npx playwright install chromium
copy .env.example .env
```

`.env` 至少填：

```env
NOTIFY_CHANNEL=discord
DISCORD_WEBHOOK_URL=你的 Webhook URL
HEADLESS=true
```

```bash
node src/notify/discord.js      # 測試通知
npm run scan:dry                # 試跑（不發通知）
npm start                       # 正式執行
```

---

## 修改追蹤品項

編輯 `config/watchlist.json`，改完 commit + push，GitHub Actions 下一輪生效；本機下次排程直接讀檔。

```json
{
  "watchlist": [
    { "set_number": "10350", "note": "Icons - 都鐸式街角" },
    { "set_number": "77253", "note": "極速賽車 - Bugatti", "target_price": 450 },
    { "set_number": "60404", "note": "城市系列", "disabled": true }
  ]
}
```

| 欄位 | 必填 | 說明 |
|------|------|------|
| `set_number` | ✅ | 樂高組號 |
| `note` | | 備註 |
| `target_price` | | 自訂目標價（NT$），Coupang 售價 ≤ 這個數字才通知，取代全域門檻 |
| `disabled` | | `true` = 暫停追蹤；刪掉這個欄位就恢復 |
| `is_eol` | | `true` = 強制當絕版品（用 6.9折門檻） |
| `pchome_id` | | 指定 PCHome 商品 ID（搜尋找不到時用） |

> 極速賽車（77xxx）在 Coupang 有常駐折價券，算出來的折扣是假的，要用 `target_price` 擋。

---

## 修改折扣門檻

編輯 `config/settings.json` 的 `thresholds`：

| 參數 | 預設 | 說明 |
|------|------|------|
| `normal_item` | `0.64` | Coupang 非絕版品，6.4折以下通知 |
| `eol_item` | `0.69` | Coupang 絕版品，6.9折以下通知 |
| `pchome_sale_offset` | `0.01` | PCHome 特價門檻再寬鬆 0.1折（6.5折 / 7.0折） |

絕版判斷：PCHome 搜不到該組號 → 視為絕版。

---

## 排程

| 時間（台灣） | 在哪裡跑 | 設定位置 |
|---|---|---|
| 每天 08:00、21:00 | GitHub Actions | `.github/workflows/weekend-monitor.yml`（只跑 `main`） |
| 每天 11:35 | 本機工作排程器 `LegoMonitor-Morning` | `scripts/run.bat`，log 寫到 `logs/run.log` |

重建本機排程（系統管理員）：

```bash
scripts\setup-scheduler.bat
```

手動觸發：

```bash
schtasks /run /tn "LegoMonitor-Morning"
```

---

## 常用指令

```bash
npm start                        # 正常執行（發通知）
npm run scan:dry                 # 只印結果，不通知
npm run debug                    # 存截圖到 screenshots/
node src/notify/discord.js       # 測試 Discord 通知
node src/crawler/pchome.js 76452 # 測試 PCHome 爬蟲
node src/crawler/biggo.js 10350  # 測試 BigGo 爬蟲
```

---

## Discord 通知設定

1. Discord 頻道齒輪 → **整合** → **Webhook** → **新增 Webhook** → **複製 Webhook URL**
2. 填進 `.env` 的 `DISCORD_WEBHOOK_URL`
3. 測試：`node src/notify/discord.js`

GitHub Actions：repo → Settings → Secrets and variables → Actions，新增 `DISCORD_WEBHOOK_URL`。

---

## 警報類型

| 類型 | 圖示 | 說明 |
|------|------|------|
| A | 🔔 | watchlist 品項達到 Coupang 折扣門檻 |
| B | 🔥 | 廣域搜尋發現非 watchlist 品項特價 |
| P | 🏪 | watchlist 品項 PCHome 特價達門檻 |

---

## 專案結構

```
coupang-lego-monitor/
├── .github/workflows/weekend-monitor.yml  ← GitHub Actions 排程
├── config/
│   ├── watchlist.json        ← 追蹤清單
│   └── settings.json         ← 門檻設定
├── src/
│   ├── index.js              ← 主程式
│   ├── analyzer/discount.js  ← 折扣計算
│   ├── crawler/
│   │   ├── biggo.js          ← BigGo → Coupang 價格
│   │   ├── pchome.js         ← PCHome 定價 & 特價
│   │   └── brickeconomy.js   ← 絕版品定價備援
│   ├── notify/
│   │   ├── index.js          ← 依 NOTIFY_CHANNEL 選通知管道
│   │   ├── discord.js        ← 預設
│   │   └── telegram.js / line*.js  ← 備用
│   └── utils/logger.js
├── scripts/
│   ├── run.bat               ← 本機排程執行
│   └── setup-scheduler.bat   ← 建立本機排程
├── logs/run.log              ← 本機執行紀錄（不進 git）
└── .env.example              ← 設定範本
```

---

*最後更新：2026-11-17*
