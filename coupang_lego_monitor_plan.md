# 🧱 Coupang 樂高自動化監控系統
## 完整規劃文件 v1.0

---

## 📌 專案概述

自動化監控 Coupang 台灣站的樂高商品，每日執行兩次，
依據三種情境發送 LINE 通知：
- **A 類**：個人關注清單內商品出現折扣
- **B 類**：任何樂高商品出現超級優惠
- **C 類**：近絕版商品出現特價

---

## 🗂️ 建議資料夾結構

```
coupang-lego-monitor/
│
├── README.md                  ← 本文件
├── package.json
├── .env                       ← 帳密、LINE Token（不上傳 git）
├── .gitignore
│
├── config/
│   ├── watchlist.json         ← 個人關注清單
│   └── settings.json          ← 閾值設定（折扣率等）
│
├── src/
│   ├── index.js               ← 主入口（排程控制）
│   ├── crawler/
│   │   ├── coupang.js         ← Coupang 爬蟲核心
│   │   └── search.js          ← 搜尋矩陣邏輯
│   ├── data/
│   │   ├── db.js              ← SQLite 操作
│   │   └── brickset.js        ← Brickset API（EOL 資訊）
│   ├── analyzer/
│   │   └── discount.js        ← 折扣分析、分類邏輯
│   └── notify/
│       └── line.js            ← LINE Notify 推送
│
├── db/
│   └── prices.db              ← SQLite 資料庫（自動產生）
│
└── logs/
    └── run.log                ← 執行紀錄
```

---

## ⚙️ 技術選型

| 項目 | 選擇 | 理由 |
|------|------|------|
| 語言 | Node.js | 你已有 Playwright 腳本經驗 |
| 爬蟲 | Playwright | 可模擬登入、處理動態頁面、帶入 Cookie |
| 資料庫 | SQLite（better-sqlite3） | 零設定、本機跑、適合個人專案 |
| 通知 | LINE Notify | 免費、手機即時收到 |
| 排程 | Windows 工作排程器 | 不需額外軟體，桌機常開即可 |
| EOL 資訊 | Brickset API | 免費帳號可查停產狀態 |
| 參考售價 | BrickEconomy（爬取） | 取得台灣市場均價 |

---

## 🔑 環境變數（.env）

```env
# Coupang 帳號
COUPANG_EMAIL=你的信箱
COUPANG_PASSWORD=你的密碼

# LINE Notify Token（從 notify.line.me 取得）
LINE_NOTIFY_TOKEN=你的Token

# Brickset API Key（免費申請）
BRICKSET_API_KEY=你的Key

# 執行設定
HEADLESS=true          # 爬蟲是否隱藏瀏覽器（正式跑設 true）
DRY_RUN=false          # true=只分析不發通知（測試用）
```

---

## 📋 關注清單格式（config/watchlist.json）

```json
{
  "watchlist": [
    {
      "set_number": "76417",
      "name": "古靈閣銀行 Gringotts",
      "msrp_tw": 9999,
      "target_price": 7500,
      "priority": "high",
      "tags": ["harry_potter", "invest"],
      "coupang_url": "",
      "note": "主力持倉，跌破75折通知"
    },
    {
      "set_number": "76428",
      "name": "海格小屋 Hagrid's Hut",
      "msrp_tw": 3999,
      "target_price": 3000,
      "priority": "high",
      "tags": ["harry_potter", "invest"],
      "coupang_url": "",
      "note": ""
    },
    {
      "set_number": "76422",
      "name": "衛斯理家 Weasleys'",
      "msrp_tw": 4999,
      "target_price": 3800,
      "priority": "medium",
      "tags": ["harry_potter", "invest"],
      "coupang_url": "",
      "note": ""
    },
    {
      "set_number": "10316",
      "name": "瑞文戴爾 Rivendell",
      "msrp_tw": 19999,
      "target_price": 15000,
      "priority": "medium",
      "tags": ["lotr", "invest", "near_eol"],
      "coupang_url": "",
      "note": "接近停產，特價立刻通知"
    }
  ]
}
```

---

## 🚨 警報觸發條件（config/settings.json）

```json
{
  "alerts": {
    "A_watchlist": {
      "description": "關注清單商品出現優惠",
      "discount_threshold": 0.85,
      "note": "低於台灣 MSRP 85折即通知"
    },
    "B_super_deal": {
      "description": "任何樂高超級特價",
      "discount_threshold": 0.75,
      "or_below_market_pct": 0.10,
      "note": "低於75折，或低於BrickEconomy均價10%"
    },
    "C_eol_deal": {
      "description": "近絕版商品特價",
      "discount_threshold": 0.88,
      "require_eol": true,
      "note": "EOL商品低於88折即通知"
    }
  },
  "search": {
    "keywords": [
      "樂高", "LEGO",
      "76417", "76428", "76422", "10316"
    ],
    "category_ids": [],
    "max_pages_per_keyword": 3
  },
  "schedule": {
    "runs_per_day": 2,
    "times": ["08:00", "20:00"]
  }
}
```

---

## 🗄️ 資料庫 Schema（SQLite）

```sql
-- 商品基本資料
CREATE TABLE products (
  set_number    TEXT PRIMARY KEY,
  name          TEXT,
  msrp_tw       INTEGER,
  is_eol        BOOLEAN DEFAULT 0,
  eol_checked_at DATETIME,
  coupang_url   TEXT,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 每次爬蟲紀錄的價格快照
CREATE TABLE price_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  set_number    TEXT,
  price         INTEGER,         -- 實際售價
  original_price INTEGER,        -- 劃線原價
  discount_pct  REAL,            -- 折扣率 (0~1)
  supplier      TEXT,            -- 供應商名稱（若可取得）
  scraped_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (set_number) REFERENCES products(set_number)
);

-- 已發出的通知紀錄（避免重複通知）
CREATE TABLE notifications_sent (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  set_number    TEXT,
  alert_type    TEXT,            -- A / B / C
  price         INTEGER,
  sent_at       DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🕷️ 爬蟲流程（src/crawler/coupang.js）

```
1. 啟動 Playwright（Chromium）
2. 載入上次儲存的 Cookie（避免重複登入）
3. 若 Cookie 失效 → 自動重新登入
4. 儲存新 Cookie 供下次使用
5. 依據 watchlist 逐一查詢：
   a. 嘗試直接用 Set Number 搜尋
   b. 若無結果 → 嘗試「樂高 + Set Number」
   c. 若仍無結果 → 嘗試 coupang_url 直連
6. 擷取：售價、劃線原價、商品名稱、供應商（若有）
7. 寫入 price_history
```

---

## 🔍 搜尋矩陣（探索未知商品）

針對非 watchlist 商品，以關鍵字矩陣搜尋：

```
關鍵字組合：
  ["樂高 哈利波特", "樂高 星際大戰", "樂高 城市",
   "LEGO 76xxx", "LEGO Creator", "LEGO Technic"]

每組關鍵字：
  → 爬取前 3 頁
  → 過濾非樂高商品
  → 計算折扣率
  → 超過 B 類閾值 → 加入候選通知
```

---

## 📲 LINE 通知格式

### A 類範例
```
🧱【關注商品特價】
商品：古靈閣銀行 #76417
現價：NT$7,200（原價 $9,999）
折扣：72折（低於你設定的75折目標）
🔗 前往 Coupang
```

### B 類範例
```
🔥【超級特價】
商品：樂高 城市警察局 #60316
現價：NT$1,490（原價 $2,499）
折扣：59折（BrickEconomy均價 $2,100，低23%）
🔗 前往 Coupang
```

### C 類範例
```
⏳【絕版特價警報】
商品：瑞文戴爾 #10316（Brickset 標記已停產）
現價：NT$16,500（原價 $19,999）
折扣：82折
🔗 前往 Coupang
```

---

## 🪟 Windows 工作排程器設定

### 步驟
1. 開啟「工作排程器」（Task Scheduler）
2. 建立基本工作
3. 觸發程序：每日 08:00 + 每日 20:00（建兩個）
4. 動作：啟動程式
   - 程式：`node`
   - 引數：`C:\你的路徑\coupang-lego-monitor\src\index.js`
   - 起始位置：`C:\你的路徑\coupang-lego-monitor`
5. 勾選：「不論使用者是否登入都要執行」

### 替代：用 npm script + bat 檔
```bat
@echo off
cd /d C:\你的路徑\coupang-lego-monitor
node src/index.js >> logs\run.log 2>&1
```

---

## ⚠️ 已知限制與對策

| 限制 | 說明 | 對策 |
|------|------|------|
| 分眾折扣 | 需登入才看得到個人化優惠 | 用自己帳號登入 Playwright |
| 行為觸發折扣 | 加購物車才出現的特價無法自動觸發 | 腳本模擬瀏覽（不保證有效） |
| 反爬蟲偵測 | Coupang 有 bot 偵測機制 | 加隨機延遲、使用真實 User-Agent |
| 搜尋不完整 | 部分商品搜不到 | 直接用 URL 或商品編號查詢 |
| BrickEconomy 無 API | 需爬取頁面 | 謹慎使用，加間隔避免封鎖 |

---

## 📅 建議開發順序

```
Week 1
  ✅ 建立資料夾結構、初始化 package.json
  ✅ 設定 .env、watchlist.json
  ✅ 完成 Coupang 登入 + 單一商品查詢腳本
  ✅ 寫入 SQLite 價格紀錄

Week 2
  ✅ 加入折扣分析邏輯（A/B/C 分類）
  ✅ 整合 LINE Notify
  ✅ 設定 Windows 工作排程器
  ✅ 完整跑一次測試

Week 3
  ✅ 加入 Brickset API（EOL 判斷）
  ✅ 加入搜尋矩陣（探索未知商品）
  ✅ 加入「避免重複通知」邏輯

Week 4（選做）
  🔶 BrickEconomy 比價
  🔶 本地簡易價格趨勢查詢（CLI）
  🔶 Docker 化（若想移至雲端）
```

---

## 🚀 Claude Code 使用建議

在 Claude Code 開啟此資料夾後，可以：

```
推薦的 Claude Code 指令方式：

「幫我寫 src/crawler/coupang.js，
  功能是登入 Coupang 並查詢指定 set_number 的商品價格」

「幫我完成 src/data/db.js，
  需要 initDB、savePrice、getLastPrice 三個函式」

「幫我寫 src/notify/line.js，
  傳入商品資料和警報類型，送出 LINE Notify」
```

Claude Code 可以直接在你的 Windows 桌機上執行這些腳本測試，
不需要額外部署環境。

---

## 📦 初始化指令（在 Claude Code 終端執行）

```bash
# 建立專案
mkdir coupang-lego-monitor
cd coupang-lego-monitor
npm init -y

# 安裝依賴
npm install playwright better-sqlite3 dotenv node-fetch axios
npx playwright install chromium

# 建立資料夾
mkdir -p src/crawler src/data src/analyzer src/notify config db logs

# 建立 .gitignore
echo ".env\ndb/\nlogs/\nnode_modules/" > .gitignore
```

---

*最後更新：2026-04 | 作者：Aron @ 台電林口 | 用途：個人 LEGO 投資輔助*
