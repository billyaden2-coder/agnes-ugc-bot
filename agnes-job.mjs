import fs from "node:fs";
import path from "node:path";
import config from "./config.mjs";
import {
  uploadImage,
  createConversation,
  chatStream,
  conversationRunning,
  conversationHistory,
  findVideoResult,
  downloadFile,
} from "./agnes-api.mjs";

const TERMINAL_TYPES = new Set([
  "AgentEnd",
  "AgentError",
  "AgentCancelled",
  "InsufficientCredits",
  "HumanReview",
  "error",
]);

export function buildCaption(userText, hashtags = "") {
  if (userText) return `${userText}\n\n${hashtags}`.trim();
  return hashtags.trim();
}

export async function telegramDownload(botToken, fileId, dest) {
  const getRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  const j = await getRes.json();
  if (!j.ok) throw new Error(`telegram getFile failed: ${JSON.stringify(j).slice(0, 200)}`);
  if (!j.result?.file_path) throw new Error("telegram getFile: no file_path");
  const fileRes = await fetch(`https://api.telegram.org/file/bot${botToken}/${j.result.file_path}`);
  if (!fileRes.ok) throw new Error(`telegram file download: HTTP ${fileRes.status}`);
  const buf = Buffer.from(await fileRes.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
}

export async function runUgc(token, imageFiles, userText, { onLog = () => {} } = {}) {
  onLog(`uploading ${imageFiles.length} image(s) to Agnes...`);
  const fileUrls = [];
  for (const f of imageFiles) {
    const url = await uploadImage(token, f);
    fileUrls.push(url);
  }

  onLog("image uploaded; creating conversation...");
  const conversationId = await createConversation(token, "Telegram UGC");

  const files = fileUrls.map((url, i) => ({
    mime_type: "image/png",
    url,
    filename: path.basename(imageFiles[i]) || `image-${i}.png`,
  }));

  const query = userText
    ? `${config.agnes.defaultPrompt}\n\nAdditional instructions: ${userText}`
    : config.agnes.defaultPrompt;
  const payload = {
    conversation_id: conversationId,
    query,
    agent_type: config.agnes.agentType || "video",
    files,
    extra_context: {},
  };

  onLog(`streaming to Agnes (conv ${conversationId})...`);
  let terminal = null;
  let lastDetail = "";
  for await (const ev of chatStream(token, payload)) {
    const data = ev.data;
    const evType = ev.type;
    const detail = data && typeof data === "object" ? JSON.stringify(data).slice(0, 300) : String(data);
    onLog(`  event ${evType}: ${detail}`);
    if (evType === "AgentProgress" || evType === "progress") {
      const desc = data?.description || data?.agent_vertical || "";
      if (desc) onLog(`  progress: ${desc}`);
    } else if (TERMINAL_TYPES.has(evType)) {
      terminal = evType;
      lastDetail = detail;
      break;
    }
  }
  if (terminal === "AgentError" || terminal === "error") {
    throw new Error(`Agnes reported an error during generation (${lastDetail})`);
  }
  if (terminal === "InsufficientCredits") {
    throw new Error("Agnes: insufficient credits on your account");
  }
  if (terminal === "HumanReview") {
    throw new Error("Agnes: job requires manual review (HumanReview)");
  }

  onLog("waiting for generation to finish...");
  const maxAttempts = config.maxPollAttempts || 120;
  for (let i = 0; i < maxAttempts; i++) {
    const running = await conversationRunning(token, conversationId);
    if (!running) break;
    await new Promise((r) => setTimeout(r, config.pollIntervalMs || 5000));
  }

  let history = await conversationHistory(token, conversationId);
  let video = findVideoResult(history);
  if (!video && history) {
    await new Promise((r) => setTimeout(r, 5000));
    history = await conversationHistory(token, conversationId);
    video = findVideoResult(history);
  }
  if (!video) throw new Error("No video produced by Agnes");

  onLog(`downloading video from ${video.url.slice(0, 80)}...`);
  const dest = path.join(config.mediaDir || "media", `ugc-${conversationId.slice(-8)}-${Date.now()}.mp4`);
  await downloadFile(video.url, dest);
  return { dest, video };
}