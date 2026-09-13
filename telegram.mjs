export class TelegramBot {
  constructor(token) {
    this.token = token;
    this.api = `https://api.telegram.org/bot${token}`;
    this.offset = 0;
  }

  async call(method, params = {}, opts = {}) {
    const res = await fetch(`${this.api}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: opts.signal,
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`${method}: ${JSON.stringify(j).slice(0, 300)}`);
    return j.result;
  }

  async sendMessage(chatId, text) {
    return this.call("sendMessage", { chat_id: chatId, text });
  }

  async sendChatAction(chatId, action = "upload_video") {
    return this.call("sendChatAction", { chat_id: chatId, action });
  }

  async sendVideo(chatId, filePath, { caption, filename } = {}) {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    const fd = await import("node:fs");
    form.append(
      "video",
      new Blob([fd.readFileSync(filePath)], { type: "video/mp4" }),
      filename || requireName(filePath)
    );
    if (caption) form.append("caption", caption);
    if (caption && caption.length > 0) form.append("parse_mode", "HTML");
    const res = await fetch(`${this.api}/sendVideo`, {
      method: "POST",
      body: form,
    });
    const j = await res.json();
    if (!j.ok) throw new Error(`sendVideo: ${JSON.stringify(j).slice(0, 300)}`);
    return j.result;
  }

  async getFile(fileId) {
    return this.call("getFile", { file_id: fileId });
  }

  async downloadFile(fileId, dest) {
    const info = await this.getFile(fileId);
    if (!info.file_path) throw new Error("no file_path for media");
    const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${info.file_path}`);
    if (!res.ok) throw new Error(`telegram file download: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const fs = await import("node:fs");
    const pathMod = await import("node:path");
    fs.mkdirSync(pathMod.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return dest;
  }

  async getUpdates({ timeout = 30, limit = 10 } = {}) {
    const res = this.call(
      "getUpdates",
      { offset: this.offset, timeout, limit, allowed_updates: ["message"] },
      { signal: AbortSignal.timeout((timeout + 15) * 1000) }
    );
    const updates = await res;
    if (updates?.length) {
      this.offset = updates[updates.length - 1].update_id + 1;
    }
    return updates || [];
  }
}

function requireName(filePath) {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1];
}