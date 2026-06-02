# Playwright 官方 image：已內建 Chromium + 系統依賴（避免 Nixpacks 缺庫問題）
# 版本需與 package.json 的 playwright 版本對齊
FROM mcr.microsoft.com/playwright:v1.44.0-jammy

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
