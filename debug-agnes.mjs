import config from "./config.mjs";

const token = process.env.AGENES_TOKEN || config.agnesToken;
const API = config.agnes.apiBase;

function h(extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-User-Language": "en",
    "X-Platform": "1",
    "X-App-Timezone": "Asia/Shanghai",
    "X-Client-Time-Ms": String(Date.now()),
    ...extra,
  };
}

async function j(path, opts = {}) {
  try {
    const r = await fetch(API + path, { ...opts, headers: h(opts.headers || {}) });
    const txt = await r.text();
    return `${r.status} ${txt.slice(0, 1200)}`;
  } catch (e) {
    return `ERR ${e.message}`;
  }
}

async function newConv() {
  const raw = await j("/v1/agnes/conversation", {
    method: "POST",
    body: JSON.stringify({ title: "dbg " + Date.now() }),
  });
  const obj = JSON.parse(raw.replace(/^\d+ /, ""));
  return obj?.data?.id || obj?.data?.conversation_id || obj?.id;
}

async function stream(label, payload) {
  const res = await fetch(API + "/v1/agnes/chat/stream", {
    method: "POST",
    headers: h({ Accept: "text/event-stream", "Cache-Control": "no-cache" }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.log(`[${label}] HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events = [];
  const timer = setTimeout(() => {
    try {
      reader.cancel();
    } catch {}
  }, 12000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
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
        events.push(`${type} ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 240)}`);
        if (type === "AgentError" || type === "AgentEnd" || events.length > 20) {
          try {
            reader.cancel();
          } catch {}
        }
      }
      if (events.length && (events[events.length - 1].includes("AgentError") || events[events.length - 1].includes("AgentEnd"))) break;
    }
  } catch (e) {
    events.push(`READERR ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  console.log(`[${label}] events(${events.length}):\n  ${events.slice(0, 8).join("\n  ")}`);
}

console.log("token length:", token ? token.length : "MISSING");
console.log("profile:", await j("/v2/user/profile"));

const variants = [
  ["V1 video+params 9:16 fast", { agent_type: "video", extra_context: { agent_params: { mode: "fast", ratio: "9:16", duration: 5 } } }],
  ["V2 video+params 16:9 quality", { agent_type: "video", extra_context: { agent_params: { mode: "quality", ratio: "16:9", duration: 30 } } }],
  ["V3 video+params no files", { agent_type: "video", extra_context: { agent_params: { mode: "fast", ratio: "9:16", duration: 5 } } }],
];

for (const [label, fields] of variants) {
  const convId = await newConv();
  console.log("conv:", convId);
  await stream(label, {
    conversation_id: convId,
    query: label.includes("files") ? "look at the image" : "hi",
    files: label.includes("no files") ? undefined : [],
    ...fields,
  });
}