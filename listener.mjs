import config from "./config.mjs";

const cfg = config;
const token = cfg.telegram.botToken;
const api = `https://api.telegram.org/bot${token}`;
let offset = 0;

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

function checkSetup() {
  const missing = [];
  if (!token) missing.push("telegram.botToken");
  const g = cfg.github || {};
  if (!g.owner) missing.push("github.owner");
  if (!g.repo) missing.push("github.repo");
  if (!g.pat) missing.push("github.pat");
  if (missing.length) {
    console.error(`Missing config: ${missing.join(", ")}. Edit config.json.`);
    process.exit(1);
  }
}

async function tg(method, params) {
  const res = await fetch(`${api}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return res.json();
}

async function getUpdates({ timeout = 25 } = {}) {
  const j = await tg("getUpdates", {
    offset,
    timeout,
    allowed_updates: ["message"],
  });
  if (!j.ok) {
    const msg = `${j.description || JSON.stringify(j).slice(0, 200)}`;
    if (msg.includes("terminated by other getUpdates")) {
      log("Another bot process is running. Stop it first.");
      process.exit(1);
    }
    throw new Error(msg);
  }
  const updates = j.result || [];
  if (updates.length) offset = updates[updates.length - 1].update_id + 1;
  return updates;
}

function pickLargestPhoto(msg) {
  const arr = msg.photo;
  if (!arr?.length) return null;
  let best = arr[0];
  for (const p of arr) if (p.file_size && p.file_size > (best.file_size || 0)) best = p;
  return best;
}

async function fireGitHub(chatId, fileId, caption) {
  const url = `https://api.github.com/repos/${encodeURIComponent(cfg.github.owner)}/${encodeURIComponent(cfg.github.repo)}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.github.pat}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agnes-listener",
    },
    body: JSON.stringify({
      event_type: "agnes-job",
      client_payload: { chat_id: Number(chatId), file_id: fileId, caption: caption || "" },
    }),
  });
  if (res.status === 204) return true;
  const body = (await res.text()).slice(0, 300);
  throw new Error(`GitHub dispatch HTTP ${res.status}: ${body}`);
}

async function handleMessage(msg) {
  if (!msg) return;
  const text = (msg.text || "").trim();
  if (text === "/start" || text === "/help") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "Send me a product image (optionally with a caption) and I will queue it for UGC video generation on GitHub.",
    });
    return;
  }
  if (text === "/status") {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: cfg.github.owner && cfg.github.repo
        ? `Listening. New images go to ${cfg.github.owner}/${cfg.github.repo} instantly.`
        : "Configured, but GitHub settings are missing.",
    });
    return;
  }
  const best = pickLargestPhoto(msg);
  if (!best) return;
  log(`image received from chat ${msg.chat.id}, dispatching to GitHub...`);
  try {
    await fireGitHub(msg.chat.id, best.file_id, (msg.caption || "").trim() || "");
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: "Image received. UGC generation started on GitHub; I'll deliver the video here when it's done (usually a few minutes).",
    });
    log("dispatch OK");
  } catch (e) {
    log(`dispatch failed: ${e.message}`);
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `Could not start generation: ${e.message.slice(0, 300)}`,
    });
  }
}

async function main() {
  checkSetup();
  log("Agnes listener running. Send an image to the bot and it fires GitHub instantly.");
  for (;;) {
    let updates = [];
    try {
      updates = await getUpdates();
    } catch (e) {
      if (e.message.includes("401")) log(`Telegram error: check telegram.botToken in config.json`);
      else log(`getUpdates error: ${e.message}`);
      continue;
    }
    for (const u of updates) {
      try {
        await handleMessage(u.message);
      } catch (e) {
        log(`handler error: ${e.message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});