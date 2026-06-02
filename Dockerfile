# Playwright 官方 image：已內建 Chromium + 系統依賴（避免 Nixpacks 缺庫問題）
# ⚠️ 版本「必須」與 package.json 的 playwright 精確版本一致，否則找不到瀏覽器執行檔
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

WORKDIR /app

# 先裝依賴（利用 layer cache）
COPY package*.json ./
RUN npm ci --omit=dev

# 複製其餘程式碼
COPY . .

ENV NODE_ENV=production
ENV TZ=Asia/Taipei
ENV HEADLESS=true

# always-on 進入點：Discord Bot + node-cron 排程
CMD ["node", "src/bot/index.js"]
