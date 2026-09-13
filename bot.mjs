import fs from "node:fs";
import path from "node:path";
import config from "./config.mjs";
import { TelegramBot } from "./telegram.mjs";
import { ensureLogin } from "./agnes-auth.mjs";
import { validateSession } from "./agnes-api.mjs";
import { buildCaption, runUgc } from "./agnes-job.mjs";

const cfg = config;
const bot = new TelegramBot(cfg.telegram.botToken);
const mediaDir = path.join(process.cwd(), cfg.mediaDir || "media");
let session = null;
let busy = false;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function ensureAgnesSession() {
  if (session && (await validateSession(session.token))) return session;
  session = await ensureLogin({ onMessage: log });
  return session;
}

function pickLargestPhoto(msg) {
  const arr = msg.photo;
  if (!arr?.length) return null;
  let best = arr[0];
  for (const p of arr) if (p.file_size && p.file_size > (best.file_size || 0)) best = p;
  return best;
}

async function handlePhoto(msg) {
  const chatId = msg.chat.id;
  const userText = (msg.caption || "").trim() || "";
  const best = pickLargestPhoto(msg);
  if (!best) {
    await bot.sendMessage(chatId, "No image found in this message.");
    return;
  }
  await bot.sendMessage(chatId, "Got it. Kicking off Agnes UGC video generation...");
  const local = path.join(mediaDir, `in-${Date.now()}.jpg`);
  await bot.downloadFile(best.file_id, local);
  try {
    const session = await ensureAgnesSession();
    await bot.sendChatAction(chatId, "upload_video");
    const { dest } = await runUgc(session.token, [local], userText, { onLog: log });
    const caption = buildCaption(userText, cfg.hashtags);
    await bot.sendVideo(chatId, dest, { caption });
    await bot.sendMessage(chatId, `Done. Post it anywhere you like.`);
    log(`sent video to chat ${chatId}`);
  } catch (e) {
    log(`job failed: ${e.message}`);
    await bot.sendMessage(chatId, `Generation failed: ${e.message}`);
  } finally {
    try {
      fs.unlinkSync(local);
    } catch {}
  }
}

async function handleMessage(msg) {
  if (!msg) return;
  const text = (msg.text || "").trim();
  if (text === "/start" || text === "/help") {
    await bot.sendMessage(
      msg.chat.id,
      "Send me a product image (optionally with a caption describing the style) and I will generate a ready-to-post UGC vertical video and return it here."
    );
    return;
  }
  if (text === "/status") {
    await bot.sendMessage(msg.chat.id, busy ? "Busy generating (one job at a time)." : "Idle and ready.");
    return;
  }
  if (msg.photo?.length) {
    if (busy) {
      await bot.sendMessage(msg.chat.id, "Still working on the previous image. Wait for the result first.");
      return;
    }
    busy = true;
    try {
      await handlePhoto(msg);
    } finally {
      busy = false;
    }
  }
}

async function main() {
  const once = process.argv.includes("--once");
  if (!cfg.telegram.botToken) {
    console.error('No Telegram bot token. Edit config.json and set telegram.botToken.');
    process.exit(1);
  }
  fs.mkdirSync(mediaDir, { recursive: true });
  log("ensuring Agnes login...");
  session = await ensureAgnesSession();
  log(once ? "Agnes session ready. Polling once..." : "Agnes session ready. Polling Telegram...");
  const run = async () => {
    let updates = [];
    try {
      updates = await bot.getUpdates({ timeout: once ? 1 : 30 });
    } catch (e) {
      log(`getUpdates error: ${e.message}`);
      return;
    }
    for (const u of updates) {
      try {
        await handleMessage(u.message);
      } catch (e) {
        log(`handler error: ${e.message}`);
      }
    }
  };
  if (once) {
    await run();
    log("once mode done.");
    process.exit(0);
  }
  for (;;) {
    await run();
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});