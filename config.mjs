import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadConfig() {
  const file = path.join(here, "config.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const example = path.join(here, "config.example.json");
  if (fs.existsSync(example)) {
    fs.copyFileSync(example, file);
    console.log("Created config.json from example. Fill in botToken and re-run.");
  }
  const cfg = JSON.parse(fs.readFileSync(example, "utf8"));
  cfg._fresh = true;
  return cfg;
}

export function applyEnvOverrides(cfg) {
  if (process.env.TELEGRAM_BOT_TOKEN) {
    cfg.telegram = { ...cfg.telegram, botToken: process.env.TELEGRAM_BOT_TOKEN };
  }
  if (process.env.AGNES_TOKEN) {
    cfg.agnesToken = process.env.AGNES_TOKEN;
  }
  return cfg;
}

const cfg = applyEnvOverrides(loadConfig());
export default cfg;