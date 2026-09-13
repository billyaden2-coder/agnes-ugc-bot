import fs from "node:fs";
import path from "node:path";
import config from "./config.mjs";
import { TelegramBot } from "./telegram.mjs";
import { buildCaption, runUgc, telegramDownload } from "./agnes-job.mjs";

const chatId = process.env.CHAT_ID;
const fileId = process.env.FILE_ID;
const userText = (process.env.CAPTION || "").trim() || "";
const botToken = process.env.TELEGRAM_BOT_TOKEN || config.telegram.botToken;
const token = process.env.AGNES_TOKEN || config.agnesToken;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  if (!chatId || !fileId || !token) {
    log("Nothing to do (no dispatched job).");
    process.exit(0);
  }
  const bot = new TelegramBot(botToken);
  const mediaDir = path.join(process.cwd(), config.mediaDir || "media");
  fs.mkdirSync(mediaDir, { recursive: true });

  await bot.sendMessage(chatId, "UGC generation started on GitHub. Working on it...");
  const local = path.join(mediaDir, `in-${Date.now()}.jpg`);
  try {
    await telegramDownload(botToken, fileId, local);
    const { dest } = await runUgc(token, [local], userText, { onLog: log });
    const caption = buildCaption(userText, config.hashtags);
    await bot.sendVideo(chatId, dest, { caption });
  } catch (e) {
    log(`worker failed: ${e.message}`);
    try {
      await bot.sendMessage(chatId, `Generation failed: ${e.message.slice(0, 300)}`);
    } catch {}
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});