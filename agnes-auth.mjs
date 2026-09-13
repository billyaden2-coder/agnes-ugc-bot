import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import config from "./config.mjs";
import { saveSession, validateSession } from "./agnes-api.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.join(here, "profile");
const SESSION_FILE = path.join(here, "session.json");

export async function readStoredSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function captureFromPage(page) {
  const raw = await page.evaluate(() => ({
    token: localStorage.getItem("token"),
    userinfo: localStorage.getItem("userinfo"),
    rememberMe: localStorage.getItem("rememberMe"),
  }));
  if (!raw.token) return null;
  let userinfo = null;
  try {
    userinfo = JSON.parse(raw.userinfo);
  } catch {}
  const id = Array.isArray(userinfo) ? userinfo[0]?.id : userinfo?.id;
  return { token: raw.token, userinfo, userId: id, capturedAt: Date.now() };
}

export async function loginFromBrowser({ timeoutMs = 240000, onMessage } = {}) {
  const log = onMessage || ((m) => console.log(m));
  log("Opening browser for Agnes login (you will sign in manually).");
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(config.agnes.siteUrl, { waitUntil: "domcontentloaded" });

  const started = Date.now();
  let session = null;
  while (Date.now() - started < timeoutMs) {
    session = await captureFromPage(page);
    if (session && session.token) break;
    await page.waitForTimeout(1200);
  }
  if (!session) {
    await ctx.close();
    throw new Error("Login timed out - no token detected");
  }
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  saveSession(session);
  await ctx.close();
  return session;
}

export async function ensureLogin({ onMessage, interactive = true } = {}) {
  const log = onMessage || ((m) => console.log(m));
  if (process.env.AGNES_TOKEN) {
    saveSession({ token: process.env.AGNES_TOKEN.trim(), capturedAt: Date.now(), source: "env" });
    return { token: process.env.AGNES_TOKEN.trim(), capturedAt: Date.now(), source: "env" };
  }
  const existing = await readStoredSession();
  if (existing?.token) {
    try {
      const ok = await validateSession(existing.token);
      if (ok) {
        log("Existing Agnes session is valid.");
        return existing;
      }
      log("Stored token expired, attempting refresh...");
      const refreshed = await refreshSession(existing);
      if (refreshed) return refreshed;
    } catch (e) {
      log(`Session check failed: ${e.message}`);
    }
  }
  if (!interactive) {
    throw new Error("No valid Agnes session (run: node agnes-auth.mjs)");
  }
  return loginFromBrowser({ onMessage });
}

async function refreshSession(session) {
  try {
    const { refreshToken } = await import("./agnes-api.mjs");
    const token = await refreshToken(session.token);
    if (token) {
      const updated = { ...session, token };
      saveSession(updated);
      return updated;
    }
  } catch {}
  return null;
}

export function saveTokenFromCli(token) {
  saveSession({ token, capturedAt: Date.now(), source: "manual" });
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
  (async () => {
    const manual = process.argv[2];
    if (manual) {
      saveTokenFromCli(manual.trim());
      console.log("Token saved. Bot is ready to run.");
      return;
    }
    await ensureLogin()
      .then(() => console.log("Session saved. Bot is ready to run."))
      .catch((e) => console.error("Login failed:", e.message));
  })().then(() => process.exit(0));
}