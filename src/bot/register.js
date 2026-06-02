/**
 * 註冊 slash 指令到 Discord
 *
 * 用法：node src/bot/register.js
 *
 * 對 DISCORD_GUILD_ID 註冊 → 立即生效（適合單一伺服器）。
 * 若未設 GUILD_ID，則註冊為全域指令（最多約 1 小時才生效）。
 *
 * bot 啟動時也會自動註冊一次，這支 script 用於手動 / 部署前驗證。
 */

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const commands = require('./commands');

async function registerCommands({ silent = false } = {}) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const appId = process.env.DISCORD_APP_ID;
  const guild = process.env.DISCORD_GUILD_ID;

  if (!token || !appId) {
    throw new Error('DISCORD_BOT_TOKEN / DISCORD_APP_ID 未設定');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const route = guild
    ? Routes.applicationGuildCommands(appId, guild)
    : Routes.applicationCommands(appId);

  await rest.put(route, { body: commands });
  if (!silent) {
    console.log(`✅ 已註冊 ${commands.length} 個指令（${guild ? `guild ${guild}` : '全域'}）`);
  }
}

module.exports = { registerCommands };

if (require.main === module) {
  registerCommands().catch((err) => {
    console.error('❌ 註冊失敗：', err.message);
    process.exit(1);
  });
}
