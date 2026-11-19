#!/usr/bin/env node
// Agentic QA dashboard: a view of a project's .agentic-qa/ folder. No dependencies.
//   node server.mjs [--dir <project root>] [--port <n>] [--open]   serve it live on 127.0.0.1
//   node server.mjs --static [<out.html>]                          write a snapshot (default .agentic-qa/reports/dashboard.html)
// The server binds to 127.0.0.1 only, uses a random URL token and checks the Host header. It only reads files inside
// .agentic-qa/ (plus the root playwright.config.ts). Every write is a same-origin JSON request with known values only:
//   - .agentic-qa/ai.json from the Models page (POST api/models: known roles and model names);
//   - .agentic-qa/settings.json from the Settings page (POST api/settings: the project's default theme and mode);
//   - the run buttons (POST api/run/start|step|stop|finish|story): runner.mjs starts the agents as headless Claude Code
//     sessions, one at a time, and records their progress in .agentic-qa/progress.jsonl and .agentic-qa/logs/;
//   - a story's test cases (POST api/story/case, cases.mjs): update, add or delete a row of its test-case table;
//   - a manual result from the testing guide (POST api/story/manual): Last Result and Evidence, and a checked PNG/JPEG
//     screenshot in .agentic-qa/evidence/<KEY>/manual-<stamp>/;
//   - a file's text (POST api/file): only an existing .md, .ts, .yml or .txt file in .agentic-qa/ (not logs/) or the
//     root playwright.config.ts, and only if it hasn't changed since it was opened;
//   - a story's open question ticked as answered (POST api/story/question), in its front matter;
//   - the project's app URL (POST api/workspace), in .agentic-qa/workspace.json;
//   - POST api/open opens such a file in VS Code (or $AGENTIC_QA_EDITOR) or the computer's default app.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildState, buildStory, readWorkspace, runsHistory, storyKeys } from "./read.mjs";
import { MODEL_ALIASES, MODEL_KEYS, readAiSettings, resolveRoleModels, writeClaudeModels } from "../../qa-story/scripts/qa-files.mjs";
import { renderMarkdown } from "./md.mjs";
import { createRunner, findOnPath, startProcess } from "./runner.mjs";
import { answerQuestion, editCase, recordManual } from "./cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : true;
};
const root = path.resolve(typeof flag("dir") === "string" ? flag("dir") : process.cwd());
const dataDir = path.join(root, ".agentic-qa");
const posix = (p) => p.replace(/\\/g, "/");

const FONT_FILES = new Set(fs.readdirSync(path.join(HERE, "fonts")).filter((f) => f.endsWith(".woff2")));
const MAX_DOC = 2 * 1024 * 1024;

/** A project-relative path the dashboard may read, resolved, or undefined. */
function allowedPath(rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) return undefined;
  const abs = path.resolve(root, rel);
  let real;
  try { real = fs.realpathSync(abs); } catch { return undefined; }
  let realData;
  try { realData = fs.realpathSync(dataDir); } catch { return undefined; }
  if (real === path.join(fs.realpathSync(root), "playwright.config.ts")) return real;
  return real.startsWith(realData + path.sep) ? real : undefined;
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

/** A file the page may open in an editor: playwright.config.ts or anything in .agentic-qa/ except the run logs. */
function openablePath(rel) {
  const abs = allowedPath(rel);
  if (!abs) return undefined;
  const relReal = posix(path.relative(fs.realpathSync(root), abs));
  if (relReal.startsWith(".agentic-qa/logs/")) return undefined;
  try { if (!fs.statSync(abs).isFile()) return undefined; } catch { return undefined; }
  return { abs, rel: relReal };
}
/** A file the page may edit as text: an existing Markdown, TypeScript, YAML or text file it may open. */
function editablePath(rel) {
  const f = openablePath(rel);
  return f && /\.(md|ts|ya?ml|txt)$/i.test(f.rel) ? f : undefined;
}

/** GET api/file?path=: the text to edit, and its version (the file's modified time) for the save to check. */
function fileForEdit(rel) {
  const f = editablePath(rel);
  if (!f) return { status: 404, error: "This file can't be edited here." };
  const st = fs.statSync(f.abs);
  if (st.size > MAX_DOC) return { status: 413, error: "This file is too large to edit here. Open it in your editor." };
  return { status: 200, body: { path: f.rel, text: fs.readFileSync(f.abs, "utf-8"), size: st.size, mtime: st.mtime.toISOString(), version: String(st.mtimeMs) } };
}

/** POST api/file { path, text, version }: save an edit, unless the file changed since it was opened. */
function saveFile(body) {
  const b = body && typeof body === "object" ? body : {};
  const f = editablePath(b.path);
  if (!f) return { status: 404, error: "This file can't be edited here." };
  if (typeof b.text !== "string") return { status: 400, error: "Send the file's text." };
  if (Buffer.byteLength(b.text) > MAX_DOC) return { status: 413, error: "That's too large to save here." };
  const st = fs.statSync(f.abs);
  if (String(st.mtimeMs) !== String(b.version)) return { status: 409, error: `${f.rel} changed on disk since you opened it (an agent may have written it). Copy your changes, then reload and edit again.` };
  const old = fs.readFileSync(f.abs, "utf-8");
  const text = old.includes("\r\n") ? b.text.replace(/\r?\n/g, "\r\n") : b.text.replace(/\r\n/g, "\n");
  fs.writeFileSync(f.abs, text, "utf-8");
  const now = fs.statSync(f.abs);
  return { status: 200, body: { path: f.rel, size: now.size, mtime: now.mtime.toISOString(), version: String(now.mtimeMs) } };
}

/** POST api/open { path }: open the file in VS Code (or $AGENTIC_QA_EDITOR), else with the computer's default app. */
function openFile(body) {
  const f = openablePath(body && typeof body === "object" ? body.path : undefined);
  if (!f) return { status: 404, error: "This file can't be opened from here." };
  const editor = findOnPath(process.env.AGENTIC_QA_EDITOR || "code");
  if (editor) {
    try {
      const child = startProcess(editor, ["-g", f.abs], root, "ignore");
      child.on("error", () => {});
      child.unref();
      return { status: 200, body: { via: "editor", path: f.rel } };
    } catch {}
  }
  const [cmd, cmdArgs] = process.platform === "win32" ? ["explorer.exe", [f.abs]] : process.platform === "darwin" ? ["open", [f.abs]] : ["xdg-open", [f.abs]];
  execFile(cmd, cmdArgs, { windowsHide: true }, () => {});
  return { status: 200, body: { via: "default", path: f.rel } };
}

/** POST api/story/question: tick a story's open question as answered (or untick it). */
function saveQuestion(body) {
  const key = body && typeof body === "object" ? body.key : undefined;
  if (typeof key !== "string" || !storyKeys(root).includes(key)) return { status: 404, error: "Unknown story." };
  const r = answerQuestion(root, key, body);
  return r.error ? r : { status: 200, body: { story: buildStory(root, key) } };
}

/** Settings → Project: .agentic-qa/workspace.json, whose appUrl the qa-story skill also reads. */
const workspaceFile = path.join(dataDir, "workspace.json");
function workspaceView() {
  const w = readWorkspace(root);
  return { file: ".agentic-qa/workspace.json", exists: fs.existsSync(workspaceFile), appUrl: typeof w.appUrl === "string" ? w.appUrl : "" };
}
/** POST api/workspace { appUrl }: an http(s) address, or "" to clear it. Other keys in the file are kept. */
function saveWorkspace(body) {
  const a = body && typeof body === "object" ? body.appUrl : undefined;
  if (typeof a !== "string") return { status: 400, error: "Send { appUrl }." };
  const url = a.trim();
  if (url) {
    let u;
    try { u = new URL(url); } catch {}
    if (!u || !/^https?:$/.test(u.protocol) || /\s/.test(url) || url.length > 2048) return { status: 400, error: "The app's address must start with http:// or https://." };
  }
  let file = {};
  if (fs.existsSync(workspaceFile)) {
    try { file = JSON.parse(fs.readFileSync(workspaceFile, "utf-8")); } catch { return { status: 409, error: ".agentic-qa/workspace.json isn't valid JSON. Fix or delete it, then save again." }; }
    if (!file || typeof file !== "object" || Array.isArray(file)) return { status: 409, error: ".agentic-qa/workspace.json isn't a JSON object. Fix or delete it, then save again." };
  }
  if (url) file.appUrl = url; else delete file.appUrl;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(workspaceFile, JSON.stringify(file, null, 2) + "\n", "utf-8");
  return { status: 200 };
}

/** POST api/story/manual: a manual result from the testing guide, unless one of the story's steps is running. */
function saveManual(body) {
  const key = body && typeof body === "object" ? body.key : undefined;
  if (typeof key !== "string" || !storyKeys(root).includes(key)) return { status: 404, error: "Unknown story." };
  const job = runner.status().job;
  if ((job && job.kind === "story" && job.key === key) || buildStory(root, key).running) return { status: 409, error: `A step of ${key} is running and may change its test cases. Record the result when it has finished.` };
  const r = recordManual(root, key, body);
  return r.error ? r : { status: 200, body: { id: r.id, story: buildStory(root, key) } };
}

/** POST api/story/case: edit a story's test cases, unless one of its steps is running and may write the file. */
function saveCase(body) {
  const key = body && typeof body === "object" ? body.key : undefined;
  if (typeof key !== "string" || !storyKeys(root).includes(key)) return { status: 404, error: "Unknown story." };
  const job = runner.status().job;
  if ((job && job.kind === "story" && job.key === key) || buildStory(root, key).running) return { status: 409, error: `A step of ${key} is running and may change its test cases. Edit them when it has finished.` };
  const r = editCase(root, key, body);
  return r.error ? r : { status: 200, body: { id: r.id, story: buildStory(root, key) } };
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
    file: ".agentic-qa/ai.json",
    exists: fs.existsSync(path.join(dataDir, "ai.json")),
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

const APPEARANCE = {
  theme: ["geist", "carbon", "industrial", "corporate"],
  mode: ["light", "dark", "system"],
};
const BUILT_IN_APPEARANCE = { theme: "geist", mode: "system" };
const settingsFile = path.join(dataDir, "settings.json");

/** .agentic-qa/settings.json as an object: {} when it isn't there, undefined when it isn't a JSON object. */
function readSettingsFile() {
  if (!fs.existsSync(settingsFile)) return {};
  try {
    const j = JSON.parse(fs.readFileSync(settingsFile, "utf-8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : undefined;
  } catch {
    return undefined;
  }
}

/** The project's saved default look, known values only, or null. */
function projectAppearance() {
  const a = readSettingsFile()?.appearance;
  if (!a || typeof a !== "object") return null;
  const out = {};
  for (const [key, values] of Object.entries(APPEARANCE)) if (values.includes(a[key])) out[key] = a[key];
  return Object.keys(out).length ? out : null;
}

function settingsView() {
  return {
    file: ".agentic-qa/settings.json",
    exists: fs.existsSync(settingsFile),
    valid: readSettingsFile() !== undefined,
    appearance: projectAppearance(),
    options: APPEARANCE,
    builtIn: BUILT_IN_APPEARANCE,
  };
}

/** Validates a Settings page save: { appearance: { theme, mode } }, each a known value. Other keys in the file are kept. */
function saveSettings(body) {
  const a = body && typeof body === "object" ? body.appearance : undefined;
  if (!a || typeof a !== "object" || Array.isArray(a)) return { status: 400, error: "Send { appearance: { theme, mode } }." };
  // "density" was a setting once; a page still open from then may send it, and it's ignored.
  for (const key of Object.keys(a)) if (!(key in APPEARANCE) && key !== "density") return { status: 400, error: `Unknown setting "${key}".` };
  const next = {};
  for (const [key, values] of Object.entries(APPEARANCE)) {
    if (!values.includes(a[key])) return { status: 400, error: `The ${key} must be one of: ${values.join(", ")}.` };
    next[key] = a[key];
  }
  const file = readSettingsFile();
  if (file === undefined) return { status: 409, error: ".agentic-qa/settings.json isn't a JSON object. Fix or delete it, then save again." };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ ...file, appearance: next }, null, 2) + "\n", "utf-8");
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
    .replace("<!--THEME_BOOT-->", () => `<script>window.__AGENTIC_QA_APPEARANCE__=${JSON.stringify(projectAppearance() ?? {}).replace(/</g, "\\u003c")};</script>` + read("theme-boot.html").trim())
    .replace("/*THEME_CSS*/", () => read("theme.css"))
    .replace("<!--THEME_MENU-->", () => read("theme-menu.html").trim());
  const data = staticData ? `<script>window.__AGENTIC_QA_STATIC__=${JSON.stringify(staticData).replace(/</g, "\\u003c")};</script>` : "";
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

let runner;
const runView = () => ({ ...buildState(root), control: runner.status() });
const WRITES = {
  "api/models": { save: saveModels, view: modelsView },
  "api/settings": { save: saveSettings, view: settingsView },
  "api/run/start": { save: (b) => runner.start(b), view: runView },
  "api/run/step": { save: (b) => runner.step(b), view: runView },
  "api/run/stop": { save: () => runner.stop(), view: runView },
  "api/run/finish": { save: () => runner.finish(), view: runView },
  "api/run/story": { save: (b) => runner.story(b), view: runView },
  "api/story/case": { save: saveCase, limit: 64 * 1024 },
  "api/story/question": { save: saveQuestion },
  "api/workspace": { save: saveWorkspace, view: workspaceView },
  // A pasted screenshot (5 MB at most) as base64.
  "api/story/manual": { save: saveManual, limit: 8 * 1024 * 1024 },
  "api/file": { save: saveFile, limit: 3 * MAX_DOC },
  "api/open": { save: openFile },
};

function writeStatic() {
  const out = path.resolve(root, typeof flag("static") === "string" ? flag("static") : ".agentic-qa/reports/dashboard.html");
  const state = buildState(root);
  const data = { "api/state": state, "api/models": modelsView(), "api/settings": settingsView(), "api/runs": { runs: runsHistory(root) }, "api/workspace": workspaceView() };
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
  runner = createRunner(root, HERE);
  const token = randomBytes(12).toString("hex");
  const base = `/${token}/`;
  let port = 0;
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
    const url = new URL(req.url ?? "/", `http://${host}`);
    const write = req.method === "POST" ? WRITES[url.pathname.slice(base.length)] : undefined;
    if (write && url.pathname.startsWith(base)) {
      // The writes: same-origin JSON only, so another page in the browser can't post here.
      const origin = req.headers.origin ?? "";
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return send(res, 403, { error: "Wrong origin." });
      if (!/^application\/json(;|$)/i.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "Send JSON." });
      let body;
      try {
        const text = await readBody(req, write.limit);
        if (text === undefined) return send(res, 413, { error: "That's too large." });
        body = JSON.parse(text);
      } catch {
        return send(res, 400, { error: "Send a JSON body." });
      }
      try {
        const r = write.save(body);
        return r.error ? send(res, r.status, { error: r.error }) : send(res, 200, r.body ?? write.view());
      } catch (err) {
        return send(res, 500, { error: String(err?.message ?? err) });
      }
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Only the Models and Settings pages, the run buttons and the editors can change anything." });
    if (url.pathname === `/${token}`) { res.writeHead(302, { Location: base }); return res.end(); }
    if (!url.pathname.startsWith(base)) return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const route = decodeURIComponent(url.pathname.slice(base.length));
    try {
      if (route === "") return send(res, 200, page(), "text/html; charset=utf-8");
      if (route === "api/state") return send(res, 200, runView());
      if (route === "api/run/feed") {
        // The run panel's activity: one events file in .agentic-qa/logs/, from line `after` on (the last 300 at most).
        const rel = url.searchParams.get("path") ?? "";
        if (!/^\.agentic-qa\/logs\/[\w-]+\/[\w-]+\.events\.jsonl$/.test(rel)) return send(res, 404, { error: "No such feed." });
        let lines = [];
        try { lines = fs.readFileSync(path.join(root, rel), "utf-8").split(/\r?\n/).filter(Boolean); } catch {}
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        const from = Math.max(after, lines.length - 300);
        const events = lines.slice(from).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
        return send(res, 200, { events, total: lines.length, from });
      }
      if (route === "api/file") {
        const f = fileForEdit(url.searchParams.get("path") ?? "");
        return send(res, f.status, f.error ? { error: f.error } : f.body);
      }
      if (route === "api/models") return send(res, 200, modelsView());
      if (route === "api/runs") return send(res, 200, { runs: runsHistory(root) });
      if (route === "api/workspace") return send(res, 200, workspaceView());
      if (route === "api/settings") return send(res, 200, settingsView());
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
    console.log("  Start a full-suite run from the page, or follow one started in the chat. Press Ctrl+C to stop (it stops a step the page started, too).");
    if (flag("open")) {
      const [cmd, cmdArgs] = process.platform === "win32" ? ["cmd", ["/c", "start", "", link]] : process.platform === "darwin" ? ["open", [link]] : ["xdg-open", [link]];
      execFile(cmd, cmdArgs, () => {});
    }
  });
}

if (flag("static")) writeStatic();
else {
  serve();
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { runner?.shutdown(); process.exit(0); });
}
