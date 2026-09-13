import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import config from "./config.mjs";

const API = config.agnes.apiBase;

function timezone() {
  return config.agnes.timezone || "Asia/Shanghai";
}

function headers(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-User-Language": "en",
    "X-Platform": "1",
    "X-App-Timezone": timezone(),
    "X-Client-Time-Ms": String(Date.now()),
    ...extra,
  };
}

async function request(token, url, { method = "GET", body, raw = false, extraHeaders = {} } = {}) {
  const res = await fetch(API + url, {
    method,
    headers: headers(token, extraHeaders),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 200) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.detail || j.message || "";
    } catch {}
    throw new Error(`HTTP ${res.status} ${url} ${detail}`.trim());
  }
  if (raw) return res;
  const j = await res.json();
  if (j.detail) throw new Error(String(j.detail));
  if (j.code && j.code !== "000000") throw new Error(j.message || j.code);
  return j;
}

export function loadSession() {
  const file = path.join(process.cwd(), "session.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function saveSession(session) {
  fs.writeFileSync(path.join(process.cwd(), "session.json"), JSON.stringify(session, null, 2));
}

export async function validateSession(token) {
  try {
    const j = await request(token, "/v2/user/profile");
    return j.code === "000000";
  } catch {
    return false;
  }
}

export async function refreshToken(token) {
  const j = await request(token, "/v1/user/refresh-token", { method: "POST" });
  return j?.data?.access_token || null;
}

export async function uploadImage(token, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  const contentType = contentTypes[ext] || "image/png";
  const filename = path.basename(filePath);
  const fileUid = String(Date.now()) + crypto.randomBytes(4).toString("hex");

  const pre = await request(token, "/v1/file/presigned-url", {
    method: "POST",
    body: { filename, content_type: contentType, purpose: "chat_attachment", file_uid: fileUid },
  });
  const data = pre.data || {};
  if (!data.upload_url) throw new Error("presigned-url returned no upload_url");

  const buf = fs.readFileSync(filePath);
  const method = (data.method || "PUT").toUpperCase();
  const headers = { "Content-Type": contentType };
  for (const h of data.required_headers || []) {
    if (typeof h === "string" && h.includes(":")) {
      const [k, ...rest] = h.split(":");
      headers[k.trim()] = rest.join(":").trim();
    } else if (typeof h === "object") {
      for (const [k, v] of Object.entries(h)) headers[k] = v;
    }
  }
  const up = await fetch(data.upload_url, { method, headers, body: buf });
  if (!up.ok) throw new Error(`upload to CDN failed: HTTP ${up.status}`);

  const inspect = await request(token, "/v1/file/inspect", {
    method: "POST",
    body: { url: data.public_url, content_type: contentType },
  });
  const finalUrl =
    inspect?.data?.public_url || inspect?.data?.cdn_url || data.public_url || data.file_url;
  if (!finalUrl) throw new Error("inspect returned no file url");
  return finalUrl;
}

export async function createConversation(token, title) {
  const j = await request(token, "/v1/agnes/conversation", {
    method: "POST",
    body: { title: title || "Telegram UGC" },
  });
  const id = j?.data?.id || j?.data?.conversation_id || j?.id;
  if (!id) throw new Error("conversation create returned no id");
  return id;
}

export async function* chatStream(token, payload, { signal } = {}) {
  const res = await request(token, "/v1/agnes/chat/stream", {
    method: "POST",
    body: payload,
    raw: true,
    extraHeaders: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!block.trim()) continue;
        let type = "message";
        let data = null;
        for (const line of block.split("\n")) {
          const i = line.indexOf(": ");
          if (i === -1) continue;
          const k = line.slice(0, i);
          const v = line.slice(i + 2);
          if (k === "event") type = v;
          else if (k === "data") {
            try {
              data = JSON.parse(v);
            } catch {
              data = v;
            }
          }
        }
        if (type !== "message" || data !== null) yield { type, data };
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

export async function conversationRunning(token, conversationId) {
  const j = await request(
    token,
    `/v1/agnes/conversation/running?conversation_id=${encodeURIComponent(conversationId)}`
  );
  return j?.data?.is_running === true;
}

export async function conversationHistory(token, conversationId) {
  const j = await request(token, `/v1/agnes/conversation/history?conversation_id=${encodeURIComponent(conversationId)}`);
  return j?.data;
}

function toArray(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return Object.values(v);
  return [];
}

export function findVideoResult(history) {
  if (!history) return null;
  const messages = toArray(history.messages || history.items || history);
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const artifacts = toArray(msg.artifacts || msg.artifact);
    const withResults = artifacts.length ? artifacts : toArray(msg.results);
    for (const art of withResults) {
      if (!art || typeof art !== "object") continue;
      const kind = art.kind || art.type;
      const results = toArray(art.results);
      const candidates = results.length ? results : kind === "video" ? [art] : [];
      for (const r of candidates) {
        const src = typeof r === "string" ? r : r?.url || r?.file_url || r?.video_url || art?.url;
        if (typeof src === "string" && src.startsWith("http")) {
          return {
            url: src,
            thumbUrl: null,
            title: art?.title || r?.title || r?.filename || art?.filename || "ugc-video",
            mime: r?.mimetype || art?.mimetype || "",
          };
        }
      }
    }
  }
  const box = { res: null };
  (function scan(node) {
    if (!node || typeof node !== "object" || box.res) return;
    if (Array.isArray(node)) {
      node.forEach(scan);
      return;
    }
    if ((node.kind === "video" || node.type === "video") && typeof node.url === "string" && node.url.startsWith("http")) {
      box.res = node;
      return;
    }
    for (const v of Object.values(node)) scan(v);
  })(history);
  if (box.res) {
    return {
      url: box.res.url,
      thumbUrl: null,
      title: box.res.title || box.res.filename || "ugc-video",
      mime: box.res.mimetype || "",
    };
  }
  return null;
}

export async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return dest;
}