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
  }, 15000);
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
        if (type !== "message" && (type === "AgentError" || type === "error" || type === "AgentEnd")) break;
      }
      if (events.length && events[events.length - 1].includes("AgentError") || events.some((e) => e.startsWith("error "))) break;
      if (events.some((e) => e.startsWith("AgentEnd"))) break;
      if (events.length > 25) break;
    }
  } catch (e) {
    events.push(`READERR ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  console.log(`[${label}] events(${events.length}):\n  ${events.slice(0, 10).join("\n  ")}`);
}

console.log("token length:", token ? token.length : "MISSING");
console.log("profile:", await j("/v2/user/profile"));
console.log("presigned:", await j("/v1/file/presigned-url", {
  method: "POST",
  body: JSON.stringify({ filename: "t.png", content_type: "image/png", purpose: "chat_attachment", file_uid: "dbg" + Date.now() }),
}));
const convRes = JSON.parse((await j("/v1/agnes/conversation", {
  method: "POST",
  body: JSON.stringify({ title: "debug matrix" }),
})).replace(/^\d+ /, ""));
console.log("conversation raw:", JSON.stringify(convRes).slice(0, 500));
let convId = convRes?.data?.id || convRes?.data?.conversation_id || convRes?.id || convRes?.data?.[0]?.id;
console.log("conversation id:", convId);

await stream("A ours+empty ids", {
  conversation_id: convId, query: "hi", agent_type: "video", files: [],
  client_id: "", session_id: "", extra_context: {},
});
await stream("B no ids", {
  conversation_id: convId, query: "hi", agent_type: "video", files: [],
});
await stream("C no ids, no files", {
  conversation_id: convId, query: "hi", agent_type: "video",
});
await stream("D agent_type super", {
  conversation_id: convId, query: "hi", agent_type: "super", files: [],
});
await stream("E no agent_type, mode 10", {
  conversation_id: convId, query: "hi", mode: 10, files: [],
});
await stream("F video + agent_params fast 9:16 5s", {
  conversation_id: convId, query: "hi", agent_type: "video", files: [],
  extra_context: { agent_params: { mode: "fast", ratio: "9:16", duration: 5 } },
});
await stream("G video + agent_params with selected_skills", {
  conversation_id: convId, query: "hi", agent_type: "video", files: [],
  client_id: "", session_id: "",
  extra_context: { agent_params: { mode: "fast", ratio: "9:16", duration: 5 } },
});