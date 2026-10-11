import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { handlers } from "../src/index.js";

const DEFAULT_ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "../.env.local");

export function loadLocalEnv(path = DEFAULT_ENV_PATH, env = process.env) {
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

export function parseLocalArgs(argv) {
  const args = {};
  const query = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--topic") args.topic = argv[++index];
    else if (arg === "--search-depth") args.search_depth = argv[++index];
    else if (arg === "--max-results") args.max_results = Number(argv[++index]);
    else if (arg === "--no-answer") args.include_answer = false;
    else if (arg === "--json") args.json = true;
    else query.push(arg);
  }
  args.query = query.join(" ").trim();
  return args;
}

export async function executeLocal(args, options = {}) {
  loadLocalEnv(options.envPath ?? DEFAULT_ENV_PATH, options.env ?? process.env);
  const search = options.search ?? handlers.webSearch;
  return search(args);
}

function isDirectRun() {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectRun()) {
  const { json, ...args } = parseLocalArgs(process.argv.slice(2));
  if (!args.query) {
    console.error('Usage: node scripts/local.mjs "search query" [--topic general|news|finance] [--max-results 5] [--json]');
    process.exitCode = 1;
  } else {
    const result = await executeLocal(args);
    console.log(json ? JSON.stringify(result, null, 2) : (result.content?.[0]?.text ?? ""));
    if (result.isError) process.exitCode = 1;
  }
}
