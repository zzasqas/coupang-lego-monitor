/**
 * 註冊 slash 指令到 Discord
 *
 * 用法：node src/bot/register.js
 *
 * 策略（雙重註冊，最穩）：
 *  - 全域指令（applicationCommands）：所有伺服器 + 私訊都能用，且不需 guild 授權，
 *    不會出現 Missing Access；缺點是「第一次」最多約 1 小時才同步。
 *  - 伺服器指令（applicationGuildCommands，若有設 DISCORD_GUILD_ID）：立即生效，
 *    適合自己的伺服器即時測試。若該指令因授權問題失敗，不影響全域註冊。
 *
 * bot 啟動時也會自動呼叫一次；這支 script 用於手動 / 部署前驗證。
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
  const log  = (msg) => { if (!silent) console.log(msg); };

  // 1) 全域註冊（一定會成功，DM + 所有伺服器可用；首次最多 ~1 小時同步）
  let globalOk = false;
  try {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    globalOk = true;
    log(`✅ 全域指令已註冊 ${commands.length} 個（首次同步最多約 1 小時）`);
  } catch (err) {
    log(`⚠️  全域指令註冊失敗：${err.message}`);
  }

  // 2) 伺服器註冊（立即生效；失敗不致命）
  let guildOk = false;
  if (guild) {
    try {
      await rest.put(Routes.applicationGuildCommands(appId, guild), { body: commands });
      guildOk = true;
      log(`✅ 伺服器指令已註冊（guild ${guild}，立即生效）`);
    } catch (err) {
      log(`⚠️  伺服器指令註冊失敗（guild ${guild}）：${err.message}` +
          `（多半是 bot 未以 applications.commands 授權重新邀請；全域指令仍可用）`);
    }
  } else {
    log('（未設 DISCORD_GUILD_ID，略過伺服器即時註冊，僅用全域）');
  }

  if (!globalOk && !guildOk) {
    throw new Error('全域與伺服器指令都註冊失敗');
  }
  return { globalOk, guildOk };
}

module.exports = { registerCommands };

if (require.main === module) {
  registerCommands().catch((err) => {
    console.error('❌ 註冊失敗：', err.message);
    process.exit(1);
  });
}
