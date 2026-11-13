#!/usr/bin/env node
// Agentic QA dashboard: a view of a project's .aiqa/ folder. No dependencies.
//   node server.mjs [--dir <project root>] [--port <n>] [--open]   serve it live on 127.0.0.1
//   node server.mjs --static [<out.html>]                          write a snapshot (default .aiqa/reports/dashboard.html)
// The server binds to 127.0.0.1 only, uses a random URL token and checks the Host header. It only reads files inside
// .aiqa/ (plus the root playwright.config.ts), and the only thing it ever writes is .aiqa/ai.json, from the Models
// page (POST api/models: same-origin, JSON, known roles and model names only).
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildState, buildStory, storyKeys } from "./read.mjs";
import { MODEL_ALIASES, MODEL_KEYS, readAiSettings, resolveRoleModels, writeClaudeModels } from "../../qa-story/scripts/aiqa-files.mjs";
import { renderMarkdown } from "./md.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const root = path.resolve(typeof flag("dir") === "string" ? flag("dir") : process.cwd());
const aiqaDir = path.join(root, ".aiqa");
const posix = (p) => p.replace(/\\/g, "/");

const FONT_FILES = new Set(fs.readdirSync(path.join(HERE, "fonts")).filter((f) => f.endsWith(".woff2")));
const MAX_DOC = 2 * 1024 * 1024;

/** A project-relative path the dashboard may read, resolved, or undefined. */
function allowedPath(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return undefined;
  const abs = path.resolve(root, rel);
  let real;
  try { real = fs.realpathSync(abs); } catch { return undefined; }
  let realAiqa;
  try { realAiqa = fs.realpathSync(aiqaDir); } catch { return undefined; }
  if (real === path.join(fs.realpathSync(root), "playwright.config.ts")) return real;
  return real.startsWith(realAiqa + path.sep) ? real : undefined;
}

function doc(rel) {
  const abs = allowedPath(rel);
  if (!abs) return { error: "Not found" };
  const st = fs.statSync(abs);
  if (!st.isFile()) return { error: "Not a file" };
  if (st.size > MAX_DOC) return { path: rel, size: st.size, mtime: st.mtime.toISOString(), kind: "large" };
  const text = fs.readFileSync(abs, "utf-8");
  const base = { path: posix(rel), size: st.size, mtime: st.mtime.toISOString() };
  return /\.md$/i.test(abs) ? { ...base, kind: "md", html: renderMarkdown(text) } : { ...base, kind: "text", text };
}

const ROLE_INFO = {
  default: { name: "Default", uses: "Every role without its own pick" },
  analyst: { name: "Analyst", uses: "Full suite step 1, and the story Explore step" },
  "qa-planner": { name: "QA Planner", uses: "Full suite step 2, and the story Design step" },
  "qa-engineer": { name: "QA Engineer", uses: "Full suite step 3, and the story Automate step" },
  "qa-reviewer": { name: "QA Reviewer", uses: "Full suite step 4" },
  "qa-reporter": { name: "QA Reporter", uses: "Full suite step 5" },
};

function modelsView() {
  const saved = readAiSettings(root).models?.anthropic ?? {};
  return {
    file: ".aiqa/ai.json",
    exists: fs.existsSync(path.join(aiqaDir, "ai.json")),
    options: MODEL_ALIASES,
    roles: MODEL_KEYS.map((key) => ({ key, ...ROLE_INFO[key], saved: saved[key] ?? "" })),
    resolved: resolveRoleModels(root),
  };
}

/** Validates a Models page save: known roles only; a model alias, "" (session model), or the value already saved. */
function saveModels(body) {
  const picks = body && typeof body === "object" ? body.models : undefined;
  if (!picks || typeof picks !== "object" || Array.isArray(picks)) return { status: 400, error: "Send { models: { <role>: <model> } }." };
  const saved = readAiSettings(root).models?.anthropic ?? {};
  const next = {};
  for (const [key, value] of Object.entries(picks)) {
    if (!MODEL_KEYS.includes(key)) return { status: 400, error: `Unknown role "${key}".` };
    if (typeof value !== "string") return { status: 400, error: `The model for ${key} must be text.` };
    if (value && !MODEL_ALIASES.includes(value) && value !== saved[key]) return { status: 400, error: `Unknown model "${value}" for ${key}.` };
    if (value) next[key] = value;
  }
  writeClaudeModels(root, next);
  return { status: 200 };
}

/** The request body as text, or undefined when it's over the limit (the rest is drained so the reply still arrives). */
function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size <= limit) chunks.push(c);
    });
    req.on("end", () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function page(staticData) {
  const read = (f) => fs.readFileSync(path.join(HERE, f), "utf-8");
  let html = read("page.html")
    .replace("<!--THEME_BOOT-->", () => read("theme-boot.html").trim())
    .replace("/*THEME_CSS*/", () => read("theme.css"))
    .replace("<!--THEME_MENU-->", () => read("theme-menu.html").trim());
  const data = staticData ? `<script>window.__AIQA_STATIC__=${JSON.stringify(staticData).replace(/</g, "\\u003c")};</script>` : "";
  return html.replace("<!--STATIC_DATA-->", () => data);
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".webm": "video/webm",
  ".zip": "application/zip", ".woff2": "font/woff2", ".md": "text/plain; charset=utf-8", ".yml": "text/plain; charset=utf-8",
  ".ts": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".xml": "text/plain; charset=utf-8",
};

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function writeStatic() {
  const out = path.resolve(root, typeof flag("static") === "string" ? flag("static") : ".aiqa/reports/dashboard.html");
  const state = buildState(root);
  const data = { "api/state": state, "api/models": modelsView() };
  const docs = new Set([
    ...state.suite.documents.map((d) => d.path),
    ...state.suite.testCases.map((t) => t.path),
    ...state.suite.snapshots,
    ...state.suite.specs,
    ...state.suite.pageObjects,
  ]);
  if (state.suite.config.exists) docs.add("playwright.config.ts");
  for (const key of storyKeys(root)) {
    const s = buildStory(root, key);
    data[`api/story?key=${encodeURIComponent(key)}`] = s;
    for (const p of [s.files.story, s.files.testCases, s.files.spec, ...s.snapshots]) docs.add(p);
  }
  for (const p of docs) {
    const d = doc(p);
    if (!d.error) data[`api/doc?path=${encodeURIComponent(p)}`] = d;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, page(data), "utf-8");
  console.log(`Wrote ${posix(path.relative(root, out))}`);
}

function serve() {
  const token = randomBytes(12).toString("hex");
  const base = `/${token}/`;
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (req.method === "POST" && url.pathname === `${base}api/models`) {
      // The one write: same-origin JSON only, so another page in the browser can't post here.
      const origin = req.headers.origin ?? "";
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "Wrong origin." });
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "Send JSON." });
      let body;
      try {
        const text = await readBody(req);
        if (text === undefined) return send(res, 413, { error: "That's too large." });
        body = JSON.parse(text);
      } catch {
        return send(res, 400, { error: "Send a JSON body." });
      }
      try {
        const r = saveModels(body);
        return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, modelsView());
      } catch (err) {
        return send(res, 500, { error: String(err?.message ?? err) });
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Only the Models page can save, and only .aiqa/ai.json." });
    if (url.pathname === `/${token}`) { res.writeHead(302, { Location: base }); return res.end(); }
    if (!url.pathname.startsWith(base)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const route = decodeURIComponent(url.pathname.slice(base.length));
    try {
      if (route === "") return send(res, 200, page(), "text/html; charset=utf-8");
      if (route === "api/state") return send(res, 200, buildState(root));
      if (route === "api/models") return send(res, 200, modelsView());
      if (route === "api/story") {
        const key = url.searchParams.get("key") ?? "";
        return storyKeys(root).includes(key) ? send(res, 200, buildStory(root, key)) : send(res, 404, { error: `No story ${key}` });
      }
      if (route === "api/doc") {
        const d = doc(url.searchParams.get("path") ?? "");
        return send(res, d.error ? 404 : 200, d);
      }
      if (route.startsWith("fonts/")) {
        const name = route.slice("fonts/".length);
        if (!FONT_FILES.has(name)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
        res.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" });
        return res.end(fs.readFileSync(path.join(HERE, "fonts", name)));
      }
      if (route.startsWith("raw/")) {
        const abs = allowedPath(route.slice("raw/".length));
        if (!abs || !fs.statSync(abs).isFile()) return send(res, 404, "Not found", "text/plain; charset=utf-8");
        return send(res, 200, fs.readFileSync(abs), TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream");
      }
      return send(res, 404, "Not found", "text/plain; charset=utf-8");
    } catch (err) {
      return send(res, 500, { error: String(err?.message ?? err) });
    }
  });
  const wanted = Number(flag("port")) || 0;
  server.listen(wanted, "127.0.0.1", () => {
    port = server.address().port;
    const link = `http://127.0.0.1:${port}${base}`;
    console.log(`Agentic QA dashboard for ${root}`);
    console.log(`  ${link}`);
    console.log("  It only reads .aiqa/, except the Models page, which saves .aiqa/ai.json. Press Ctrl+C to stop.");
    if (flag("open")) {
      const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : process.platform === "darwin" ? ["open", [link]] : ["xdg-open", [link]];
      execFile(cmd, cmdArgs, () => {});
    }
  });
}

if (flag("static")) writeStatic();
else serve();
