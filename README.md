# 🧱 樂高價格監控系統

自動監控 Coupang 台灣站與 PCHome 的樂高商品價格，每日定時執行並透過 Telegram 推播優惠通知。

---

## 目錄

- [系統架構](#系統架構)
- [快速開始](#快速開始)
- [修改追蹤品項](#修改追蹤品項)
- [修改折扣閾值](#修改折扣閾值)
- [設定自動排程](#設定自動排程)
- [常用指令](#常用指令)
- [專案結構](#專案結構)

---

## 系統架構

```
每次執行
  │
  ├─ Step 1  PCHome 爬蟲 → 取得定價 & 特價（快取 40-50 天）
  │
  ├─ Step 1b PCHome 特價分析（門檻寬鬆 0.1折）
  │
  ├─ Step 2  BigGo 爬蟲 → 取得 Coupang 現售價
  │           └─ 查 watchlist 品項 + 廣域搜尋前 30 筆
  │
  ├─ Step 3  Coupang watchlist 折扣分析
  ├─ Step 4  Coupang 廣域掃描分析
  │
  └─ Step 5  發送 Telegram 通知
```

**技術架構：**

| 元件 | 說明 |
|------|------|
| Node.js | 執行環境 |
| Playwright | 爬取 BigGo、PCHome（動態頁面） |
| BigGo | Coupang 價格中介（繞過 Akamai 地區限制） |
| PCHome | 比價基準（定價參考） |
| sql.js (SQLite) | 價格歷史、快取、通知紀錄（免編譯） |
| Telegram Bot | 推播通知 |

---

## 快速開始

### 1. 安裝依賴

```bash
npm install
npx playwright install chromium
```

### 2. 設定 .env

複製範本並填入設定：

```bash
copy .env.example .env
```

`.env` 內容：

```env
NOTIFY_CHANNEL=telegram
TELEGRAM_BOT_TOKEN=你的BotToken
TELEGRAM_CHAT_ID=你的ChatID
HEADLESS=true
DRY_RUN=false
```

> Telegram Bot 申請方式見下方「[設定 Telegram 通知](#telegram-通知設定)」

### 3. 測試通知

```bash
node src/notify/telegram.js
```

### 4. 試跑（不發通知）

```bash
node src/index.js --dry-run
```

### 5. 正式執行

```bash
node src/index.js
```

---

## 修改追蹤品項

編輯 `config/watchlist.json`：

```json
{
  "watchlist": [
    {
      "set_number": "76417",
      "note": "Harry Potter - 古靈閣銀行（絕版）"
    },
    {
      "set_number": "10350",
      "note": "Icons - 都鐸式街角",
      "target_price": 5000
    },
    {
      "set_number": "60404",
      "note": "城市系列（暫停追蹤）",
      "disabled": true
    }
  ]
}
```

| 欄位 | 必填 | 說明 |
|------|------|------|
| `set_number` | ✅ | 樂高套組編號（5-6位數字） |
| `note` | | 備註，方便識別 |
| `target_price` | | 自訂目標價（NT$）。設定後以此為準，不用全域閾值 |
| `disabled` | | 設 `true` 暫停追蹤此品項（保留紀錄） |

### 新增品項

在 `watchlist` 陣列末端加一筆：

```json
{ "set_number": "75192", "note": "星際大戰 - 千年鷹號" }
```

### 移除品項

**建議做法：加 `"disabled": true`**（保留價格歷史）  
直接刪除也可以，但會遺失該品項的歷史紀錄。

---

## 修改折扣閾值

編輯 `config/settings.json`：

```json
{
  "thresholds": {
    "normal_item":        0.64,
    "eol_item":           0.69,
    "pchome_sale_offset": 0.01
  }
}
```

| 參數 | 預設 | 說明 |
|------|------|------|
| `normal_item` | `0.64` | Coupang 非絕版品門檻（6.4折以下通知） |
| `eol_item` | `0.69` | Coupang 絕版品門檻（6.9折以下通知） |
| `pchome_sale_offset` | `0.01` | PCHome 特價多寬鬆 0.1折（非絕版 6.5折 / 絕版 7.0折） |

### 絕版判斷

- 自動判斷：PCHome 搜尋不到該套組號碼 → 視為絕版
- 適用 `eol_item` 閾值（+ `pchome_sale_offset` 用於 PCHome 特價）

### 自訂目標價

在 watchlist 設定 `target_price`，優先於全域閾值：

```json
{ "set_number": "76417", "target_price": 7500 }
```
→ 只要 Coupang 售價 ≤ NT$7,500 就通知

---

## 設定自動排程

### 方法一：執行安裝腳本（推薦）

以**系統管理員**身分執行：

```
scripts\setup-scheduler.bat
```

會自動建立兩個每日任務：
- **早上 10:10** — `LegoMonitor-Morning`
- **下午 16:50** — `LegoMonitor-Afternoon`

### 方法二：手動設定工作排程器

1. 開啟「工作排程器」（搜尋 Task Scheduler）
2. 建立基本工作
3. 觸發程序：每日，時間填 `10:10`
4. 動作：啟動程式
   - 程式：`C:\Users\zzasq\OneDrive\Documents\coupang-lego-monitor\scripts\run.bat`
5. 重複上述步驟建立 `16:50` 的任務

### 手動觸發測試

```bash
schtasks /run /tn "LegoMonitor-Morning"
```

---

## 常用指令

```bash
# 正常執行（發通知 + 寫 DB）
node src/index.js

# 測試模式（只印結果，不通知不寫 DB）
node src/index.js --dry-run

# 除錯模式（存截圖到 screenshots/）
node src/index.js --debug

# 測試 Telegram 通知
node src/notify/telegram.js

# 測試 PCHome 爬蟲（指定套組號）
node src/crawler/pchome.js 76452

# 測試 BigGo 爬蟲（指定套組號）
node src/crawler/biggo.js 10350
```

---

## Telegram 通知設定

1. Telegram 搜尋 **`@BotFather`** → `/newbot` → 取得 Bot Token
2. 對 Bot 傳一則訊息（先加好友）
3. 開啟瀏覽器取得 Chat ID：
   ```
   https://api.telegram.org/bot{你的TOKEN}/getUpdates
   ```
   找 `"chat":{"id":...}` 的數字
4. 填入 `.env`：
   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   ```
5. 測試：`node src/notify/telegram.js`

---

## 警報類型

| 類型 | 圖示 | 說明 |
|------|------|------|
| A | 🔔 | watchlist 品項達到 Coupang 折扣閾值 |
| B | 🔥 | 廣域搜尋發現非 watchlist 品項特價 |
| P | 🏪 | watchlist 品項 PCHome 特價達門檻 |

---

## 專案結構

```
coupang-lego-monitor/
├── config/
│   ├── watchlist.json     ← 追蹤品項清單（常修改）
│   └── settings.json      ← 閾值設定（常修改）
├── src/
│   ├── index.js           ← 主程式
│   ├── crawler/
│   │   ├── biggo.js       ← BigGo → Coupang 價格
│   │   └── pchome.js      ← PCHome 定價 & 特價
│   ├── analyzer/
│   │   └── discount.js    ← 折扣計算邏輯
│   ├── data/
│   │   └── db.js          ← SQLite 操作
│   ├── notify/
│   │   ├── telegram.js    ← Telegram 通知
│   │   ├── line-messaging.js  ← LINE Messaging API（備用）
│   │   └── index.js       ← 通知入口（依 .env 選擇）
│   └── utils/
│       └── logger.js      ← 日誌
├── scripts/
│   ├── run.bat            ← 排程執行腳本
│   └── setup-scheduler.bat ← 排程安裝腳本
├── db/
│   └── prices.db          ← SQLite 資料庫（自動建立）
├── logs/
│   └── run.log            ← 執行日誌（自動建立）
├── .env                   ← 機密設定（不進 git）
├── .env.example           ← 設定範本
└── README.md              ← 本文件
```

---

*最後更新：2026-04 | 用途：個人 LEGO 投資輔助工具*
