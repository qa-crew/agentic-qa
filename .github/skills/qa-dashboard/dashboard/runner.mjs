// Runs Agentic QA's agents from the dashboard's buttons, one job at a time, each as a headless Claude Code session
// (`claude -p`) in the project root:
//   - a full-suite step: `claude -p --agent <step>`, with the same task message the qa-pipeline skill gives it. The
//     server plays the skill's part: it writes the progress lines, checks the step's output on disk, saves the
//     reporter's report and either pauses for the user's review or (automatic mode) starts the next step;
//   - a story: `claude -p "/qa-story <KEY>"`, which runs the story's next steps up to its next review pause.
// The prompt goes in on stdin and every argument is a fixed value, so nothing the user types reaches a command line.
// Each session's output is summarized in .agentic-qa/logs/<run>/<step or KEY>.log for the dashboard to show.
import * as fs from "node:fs";
import * as path from "node:path";
import { execFile, spawn } from "node:child_process";
import { MODEL_ALIASES, MODEL_ROLES, readAiSettings, resolveRoleModels } from "../../qa-story/scripts/qa-files.mjs";
import { aiStatus, chosenProvider, notReady, PROVIDER_LABEL } from "./ai.mjs";
import { SUITE_STEPS, readProgress, storyKeys } from "./read.mjs";

const STEP_IDS = SUITE_STEPS.map((s) => s.id);
const IS_WIN = process.platform === "win32";

// What a headless session may do without asking: the agents' file tools, subagents and skills (the story workflow),
// and the shell commands the agents run. Anything else is refused (claude -p can't ask), and the log says so.
const ALLOWED_TOOLS = [
  "Read", "Write", "Edit", "Glob", "Grep", "Agent", "Task", "Skill",
  "Bash(playwright-cli *)", "Bash(npx playwright *)", "Bash(npx --no-install playwright *)", "Bash(k6 *)", "Bash(mkdir *)",
];

/** Test filters the dashboard offers; a custom one must look like "@tag" or "@a|@b". */
const GREP_RE = /^@[\w-]+(\|@[\w-]+)*$/;

/** The full path of a command on PATH (with PATHEXT on Windows), or undefined. Nothing is run. */
export function findOnPath(name) {
  const exts = IS_WIN ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const raw of (process.env.PATH || "").split(path.delimiter)) {
    const dir = raw.replace(/^"|"$/g, "");
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext.toLowerCase());
      try { if (fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return undefined;
}

/**
 * The node script behind a Windows npm shim (copilot.cmd → node_modules\@github\copilot\npm-loader.js), or undefined.
 * Running it with node directly skips cmd.exe, so an argument can hold anything (a task message, quotes, newlines).
 */
export function nodeShimTarget(file) {
  if (!IS_WIN || !file || !/\.cmd$/i.test(file)) return undefined;
  let text;
  try { text = fs.readFileSync(file, "utf-8"); } catch { return undefined; }
  const m = text.match(/"%dp0%\\([^"%]+\.[cm]?js)"/i);
  if (!m) return undefined;
  const target = path.join(path.dirname(file), m[1]);
  return fs.existsSync(target) ? target : undefined;
}

/**
 * Starts a command. A Windows npm shim runs its node script directly; another .cmd/.bat runs through cmd.exe with every
 * argument quoted (they must be fixed values then).
 */
export function startProcess(file, args, cwd, stdio = ["pipe", "pipe", "pipe"]) {
  const shim = nodeShimTarget(file);
  if (shim) return spawn(process.execPath, [shim, ...args], { cwd, windowsHide: true, stdio });
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const quote = (a) => {
      if (/["%^\r\n]/.test(a)) throw new Error(`Can't pass ${JSON.stringify(a)} to ${path.basename(file)}.`);
      return `"${a}"`;
    };
    const line = [file, ...args].map(quote).join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], { cwd, windowsVerbatimArguments: true, windowsHide: true, stdio });
  }
  return spawn(file, args, { cwd, detached: !IS_WIN, windowsHide: true, stdio });
}

function killTree(child) {
  if (IS_WIN) execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
  else {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  }
}

/** A run id: the current UTC time as YYYY-MM-DDTHH-MM-SS, like the skills use. */
function newRunId() {
  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}

/** One line for the log from a stream-json event, or "". */
function logLine(e) {
  if (e.type === "assistant") {
    return (e.message?.content ?? []).map((c) => {
      if (c.type === "text" && c.text?.trim()) return c.text.trim();
      if (c.type === "tool_use") {
        const i = c.input ?? {};
        const what = i.command ?? i.file_path ?? i.pattern ?? i.description ?? i.skill ?? i.subagent_type ?? "";
        return `→ ${c.name}${what ? " " + String(what).replace(/\s+/g, " ").slice(0, 240) : ""}`;
      }
      return "";
    }).filter(Boolean).join("\n");
  }
  if (e.type === "user") {
    const refused = (e.message?.content ?? []).filter((c) => c.type === "tool_result" && c.is_error);
    return refused.map((c) => `  ! ${String(Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join(" ") : c.content ?? "").replace(/\s+/g, " ").slice(0, 240)}`).join("\n");
  }
  if (e.type === "result") {
    const secs = e.duration_ms ? ` in ${Math.round(e.duration_ms / 1000)}s` : "";
    return `■ Session ended${secs}${e.is_error ? ` with an error (${e.subtype})` : ""}.`;
  }
  return "";
}

/**
 * The run panel's activity (as in AIQA) from one stream-json event: [{ kind, text, path? }], kind one of
 * write · edit · agent · snap · task · note · warn · done · fail. Reads, globs and greps are left out as noise.
 */
export function feedEvents(e) {
  const out = [];
  const clip = (s, n = 280) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  if (e.type === "assistant") {
    for (const c of e.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) out.push({ kind: "note", text: clip(c.text, 400) });
      if (c.type !== "tool_use") continue;
      const i = c.input ?? {};
      if (c.name === "Write") out.push({ kind: "write", text: "Wrote a file", path: i.file_path });
      else if (c.name === "Edit" || c.name === "MultiEdit" || c.name === "NotebookEdit") out.push({ kind: "edit", text: "Edited a file", path: i.file_path ?? i.notebook_path });
      else if (c.name === "Task" || c.name === "Agent") out.push({ kind: "agent", text: clip(i.description || `Started the ${i.subagent_type ?? ""} agent`) });
      else if (c.name === "Skill") out.push({ kind: "agent", text: `Ran the ${clip(i.skill ?? i.command ?? "")} skill` });
      else if (c.name === "Bash") {
        const cmd = String(i.command ?? "");
        const snap = cmd.match(/playwright-cli\b.*\bsnapshot\b(?:.*--filename[= ]"?([^\s"]+))?/);
        if (snap) out.push({ kind: "snap", text: "Captured a page snapshot", path: snap[1] });
        else out.push({ kind: "task", text: clip(cmd, 240) });
      }
    }
  } else if (e.type === "user") {
    for (const c of e.message?.content ?? []) {
      if (c.type !== "tool_result" || !c.is_error) continue;
      out.push({ kind: "warn", text: clip(Array.isArray(c.content) ? c.content.map((x) => x.text ?? "").join(" ") : c.content) });
    }
  } else if (e.type === "result") {
    out.push({ kind: e.is_error ? "fail" : "done", text: e.is_error ? `The session ended with an error (${e.subtype})` : "The session finished" });
  }
  return out;
}

// The same allowances on GitHub Copilot's CLI: file writes, the agents' shell commands, and (per run) the app's site.
const COPILOT_ALLOW = [
  "--allow-tool=write", "--allow-tool=shell(playwright-cli:*)", "--allow-tool=shell(npx playwright:*)",
  "--allow-tool=shell(npx --no-install playwright:*)", "--allow-tool=shell(k6:*)", "--allow-tool=shell(mkdir:*)",
];

/** The run panel's activity from one Copilot CLI JSONL event (`copilot -p … --output-format json`). */
export function copilotFeed(e) {
  const d = e?.data ?? {};
  const clip = (s, n = 280) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  if (e.type === "tool.execution_start") {
    const t = String(d.toolName ?? ""), a = d.arguments ?? {};
    if (/^(create|write)$/i.test(t)) return [{ kind: "write", text: "Wrote a file", path: a.path ?? a.file_path }];
    if (/edit|str_replace|apply_patch/i.test(t)) return [{ kind: "edit", text: "Edited a file", path: a.path ?? a.file_path }];
    if (/^(task|agent|delegate|subagent)/i.test(t)) return [{ kind: "agent", text: clip(a.description ?? a.prompt ?? `Started ${t}`) }];
    if (/shell|bash|powershell|pwsh/i.test(t)) {
      const cmd = String(a.command ?? "");
      const snap = cmd.match(/playwright-cli\b.*\bsnapshot\b(?:.*--filename[= ]"?([^\s"]+))?/);
      return [snap ? { kind: "snap", text: "Captured a page snapshot", path: snap[1] } : { kind: "task", text: clip(cmd, 240) }];
    }
    return [];
  }
  if (e.type === "tool.execution_complete" && d.success === false) return [{ kind: "warn", text: clip(d.error?.message ?? "A tool failed") }];
  if (e.type === "assistant.message" && String(d.content ?? "").trim()) return [{ kind: "note", text: clip(d.content, 400) }];
  if (e.type === "result") return [{ kind: e.exitCode ? "fail" : "done", text: e.exitCode ? `The session ended with exit code ${e.exitCode}` : "The session finished" }];
  return [];
}

/** Token use from a stream-json result event: { total, input, output, cacheRead, cacheWrite, costUsd }, or undefined. */
export function usageOf(e) {
  const u = e?.usage;
  if (!u) return undefined;
  const n = (v) => Number(v) || 0;
  const t = { input: n(u.input_tokens), output: n(u.output_tokens), cacheRead: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens) };
  return { total: t.input + t.output + t.cacheRead + t.cacheWrite, ...t, costUsd: Number(e.total_cost_usd) || undefined };
}

export function createRunner(root, here) {
  const dataDir = path.join(root, ".agentic-qa");
  const progressFile = path.join(dataDir, "progress.jsonl");
  const has = (rel) => fs.existsSync(path.join(root, rel));
  // Written since `since` (ms), so a file an earlier run left behind doesn't count. 1s of slack for coarse file times.
  const fresh = (rel, since) => { try { return fs.statSync(path.join(root, rel)).mtimeMs >= since - 1000; } catch { return false; } };
  const anyFile = (rel, re, since) => { try { return fs.readdirSync(path.join(root, rel)).some((f) => re.test(f) && fresh(`${rel}/${f}`, since)); } catch { return false; } };
  // Whether a step did its job, from the files on disk (never from what the agent says), as the qa-pipeline skill checks.
  const DONE_WHEN = {
    analyst: (t) => fresh(".agentic-qa/requirements/requirements.md", t) && anyFile(".agentic-qa/snapshots", /\.yml$/, 0),
    "qa-planner": (t) => fresh(".agentic-qa/test-plan/test_plan.md", t),
    "qa-engineer": (t) => anyFile(".agentic-qa/test-scripts", /\.spec\.ts$/, t),
    "qa-reviewer": (t) => fresh(".agentic-qa/reports/review_report.md", t),
    "qa-reporter": (t) => fresh(".agentic-qa/reports/summary_report.md", t),
  };
  const MISSING = {
    analyst: ".agentic-qa/requirements/requirements.md or the snapshots",
    "qa-planner": ".agentic-qa/test-plan/test_plan.md",
    "qa-engineer": "a spec in .agentic-qa/test-scripts/",
    "qa-reviewer": ".agentic-qa/reports/review_report.md",
    "qa-reporter": ".agentic-qa/reports/summary_report.md",
  };

  // Installed as the agentic-qa plugin (Claude Code keeps plugins under a "plugins" folder), the agents and skills
  // carry its prefix. Copied into a project or ~/.claude, they don't.
  const pluginRoot = path.resolve(here, "../../../..");
  let plugin = false;
  try { plugin = fs.existsSync(path.join(pluginRoot, ".claude-plugin", "plugin.json")) && fs.realpathSync(pluginRoot).split(path.sep).includes("plugins"); } catch {}
  const prefix = plugin ? "agentic-qa:" : "";

  let job = null;
  let cli = { at: 0, claude: undefined };
  function claudePath() {
    if (Date.now() - cli.at > 10_000) cli = { at: Date.now(), claude: findOnPath("claude") };
    return cli.claude;
  }

  function record(entry) {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = { ts: new Date().toISOString(), kind: "suite", ...entry, source: "dashboard" };
    fs.appendFileSync(progressFile, JSON.stringify(line) + "\n", "utf-8");
  }

  /** The last full-suite run: its start line and all its lines. */
  function lastRun() {
    const events = readProgress(root).filter((e) => e.kind === "suite");
    const start = events.filter((e) => e.step === "pipeline" && e.event === "start").at(-1);
    return start ? { start, events: events.filter((e) => e.run === start.run) } : undefined;
  }
  function stepEvents(run) {
    const last = {};
    for (const e of run.events) if (e.step !== "pipeline") last[e.step] = e.event;
    return last;
  }

  function taskMessage(step, s) {
    const base = new URL(s.target).origin;
    const filter = s.filter && s.filter !== "none" ? s.filter : "none";
    switch (step) {
      case "analyst":
        return [`Target URL: ${s.target}`, s.snapshots === "refresh" ? "Mode: refresh" : "", s.requirements ? `Existing requirements: ${s.requirements}` : "", s.headed ? "headed" : ""].filter(Boolean).join("\n");
      case "qa-planner":
        return `Base URL: ${base}`;
      case "qa-engineer":
        return [`Base URL: ${base}`, `Test filter: ${filter}`, /@performance/.test(filter) ? "Performance scale: 10 users, 2 minutes" : "", s.config === "keep" ? "Keep config" : ""].filter(Boolean).join("\n");
      case "qa-reviewer":
        return "Review the generated suite.";
      default:
        return [`Base URL: ${base}`, `Run id: ${s.run}`, `Test filter: ${filter}`, "Don't write summary_report.md yourself: end with the whole report as your final message."].join("\n");
    }
  }

  /** Starts one headless session; onEnd(code, finalText) when it exits. */
  /**
   * Starts one headless session on the run's AI; onEnd(code, finalText, stopped) when it exits.
   *   Claude:  claude -p <args> --output-format stream-json …   (the prompt on stdin)
   *   Copilot: copilot -p <prompt> <args> --output-format json … (the prompt as an argument; an npm shim runs via node)
   */
  function launch(spec, onEnd) {
    const copilot = spec.provider === "copilot-sdk";
    const bin = copilot ? findOnPath("copilot") : claudePath();
    if (!bin) throw Object.assign(new Error(copilot ? "The GitHub Copilot CLI (copilot) isn't on this computer's PATH." : "The Claude Code CLI (claude) isn't on this computer's PATH, so the dashboard can't start agents."), { status: 409 });
    if (copilot && IS_WIN && /\.(cmd|bat)$/i.test(bin) && !nodeShimTarget(bin)) {
      throw Object.assign(new Error(`Couldn't find the program behind ${path.basename(bin)}, so the task message can't be passed to it safely. Reinstall it with: npm install -g @github/copilot`), { status: 409 });
    }
    const logRel = `.agentic-qa/logs/${spec.run}/${spec.logName}.log`;
    fs.mkdirSync(path.dirname(path.join(root, logRel)), { recursive: true });
    const log = fs.createWriteStream(path.join(root, logRel), { flags: "a" });
    log.write(`${spec.label}, started ${new Date().toLocaleString()} on ${copilot ? "GitHub Copilot" : "Claude Code"}\n${spec.args.includes("--model") ? `Model: ${spec.args[spec.args.indexOf("--model") + 1]}\n` : ""}\n`);
    const args = copilot
      ? ["-p", spec.prompt, ...spec.args, "--output-format", "json", "--no-ask-user", "--no-auto-update", "--no-color", ...COPILOT_ALLOW, ...(spec.allowUrl ? [`--allow-url=${spec.allowUrl}`] : [])]
      : ["-p", ...spec.args, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits", "--allowedTools", ...ALLOWED_TOOLS];
    const child = startProcess(bin, args, root);
    // The run panel's feed: one JSON line per event, beside the log. Counts and tokens are kept for status().
    const eventsRel = logRel.replace(/\.log$/, ".events.jsonl");
    const events = fs.createWriteStream(path.join(root, eventsRel), { flags: "a" });
    const me = { ...spec.info, label: spec.label, log: logRel, events: eventsRel, startedAt: new Date().toISOString(), child, stopping: false, silent: false, files: new Set(), snaps: 0, tokens: undefined };
    job = me;
    let finalText = "";
    let usage;
    let outTokens = 0;
    let buf = "";
    const feed = (ev) => {
      if (ev.kind === "write" || ev.kind === "edit") { if (ev.path) me.files.add(ev.path); }
      if (ev.kind === "snap") me.snaps++;
      events.write(JSON.stringify({ at: new Date().toISOString(), ...ev }) + "\n");
    };
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) {
        let e;
        try { e = JSON.parse(l); } catch { if (l.trim()) log.write(l + "\n"); continue; }
        if (copilot) {
          // Copilot reports output tokens per message and premium requests at the end; its last message is the answer.
          if (e.type === "assistant.message") {
            if (String(e.data?.content ?? "").trim()) finalText = e.data.content;
            outTokens += Number(e.data?.outputTokens) || 0;
            me.tokens = outTokens || undefined;
          }
          if (e.type === "result") usage = { total: outTokens, output: outTokens, premiumRequests: Number(e.usage?.premiumRequests) || 0, provider: "copilot-sdk" };
          const evs = copilotFeed(e);
          for (const ev of evs) { feed(ev); log.write(`${ev.kind === "note" ? "" : `→ ${ev.kind.toUpperCase()} `}${ev.text}${ev.path ? ` ${ev.path}` : ""}\n`); }
          continue;
        }
        if (e.type === "result") {
          if (typeof e.result === "string") finalText = e.result;
          usage = usageOf(e);
          me.tokens = usage?.total;
        }
        const text = logLine(e);
        if (text) log.write(text + "\n");
        for (const ev of feedEvents(e)) feed(ev);
      }
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (c) => log.write(c));
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      log.end(`\n${me.stopping ? "Stopped from the dashboard." : `Exit code ${code}.`}\n`);
      if (me.stopping) feed({ kind: "fail", text: "Stopped from the dashboard" });
      events.end();
      // What the session cost, for the step cards, the story line and the Runs page.
      if (usage) {
        try {
          fs.appendFileSync(progressFile, JSON.stringify({ ts: new Date().toISOString(), kind: "usage", run: spec.run, step: spec.info.step, story: spec.info.key, ...usage, source: "dashboard" }) + "\n", "utf-8");
        } catch {}
      }
      if (job === me) job = null;
      if (me.silent) return;
      try { onEnd(code, finalText, me.stopping); } catch (err) { console.error(err); }
    };
    child.on("error", (err) => { log.write(`Couldn't start ${copilot ? "copilot" : "claude"}: ${err.message}\n`); end(-1); });
    child.on("close", (code) => end(code));
    child.stdin.on("error", () => {});
    child.stdin.end(copilot ? "" : spec.prompt);
  }

  function runStep(run, step) {
    const s = run.start;
    const provider = s.provider === "copilot-sdk" ? "copilot-sdk" : "anthropic";
    // This run's pick for the step (the start form), else the saved pick (Settings → AI), else the AI's default.
    const model = s.models?.[step] || resolveRoleModels(root, {}, provider)[step]?.model;
    record({ step, event: "start", run: s.run, provider, model: model || undefined });
    try {
      launchStep(s, step, model, provider);
    } catch (err) {
      record({ step, event: "failed", run: s.run, note: err.message });
      record({ step: "pipeline", event: "paused", run: s.run, next: step });
      throw err;
    }
  }

  function launchStep(s, step, model, provider) {
    const since = Date.now();
    const copilot = provider === "copilot-sdk";
    launch({
      run: s.run,
      logName: step,
      provider,
      // Copilot shell commands that name a URL need it allowed: the run's site.
      allowUrl: copilot ? new URL(s.target).origin : undefined,
      label: `${SUITE_STEPS.find((x) => x.id === step).name} (full suite, run ${s.run})`,
      // Copilot reads the agent from .github/agents/<step>.agent.md; a plugin's agents carry its prefix on Claude only.
      args: ["--agent", (copilot ? "" : prefix) + step, ...(model ? ["--model", model] : [])],
      prompt: taskMessage(step, s),
      info: { kind: "suite", run: s.run, step },
    }, (code, finalText, stopped) => {
      if (stopped) {
        record({ step, event: "failed", run: s.run, note: "Stopped from the dashboard" });
        record({ step: "pipeline", event: "paused", run: s.run, next: step });
        return;
      }
      // The reporter ends with its report instead of writing it (a subagent's write to summary*.md is refused).
      if (step === "qa-reporter" && !DONE_WHEN[step](since) && finalText.trim()) {
        const out = path.join(root, ".agentic-qa/reports/summary_report.md");
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, finalText.trim() + "\n", "utf-8");
      }
      if (DONE_WHEN[step](since)) {
        record({ step, event: "done", run: s.run });
        advance();
      } else {
        record({ step, event: "failed", run: s.run, note: code ? `The agent stopped with exit code ${code}` : `It didn't write ${MISSING[step]}` });
        record({ step: "pipeline", event: "paused", run: s.run, next: step });
      }
    });
  }

  /** After a step is done: the next step not yet done (the reviewer is deferred step by step), or the end of the run. */
  function advance() {
    const run = lastRun();
    if (!run) return;
    const s = run.start;
    const last = stepEvents(run);
    let next;
    for (const id of STEP_IDS) {
      if (last[id] === "done" || last[id] === "skipped") continue;
      if (id === "qa-reviewer" && s.mode !== "auto" && !last[id]) {
        record({ step: id, event: "skipped", run: s.run, note: "Deferred: it's the slow step. Run it when you have time" });
        continue;
      }
      next = id;
      break;
    }
    if (!next) record({ step: "pipeline", event: "done", run: s.run });
    else if (s.mode === "auto") {
      try { runStep(run, next); } catch {}
    } else record({ step: "pipeline", event: "paused", run: s.run, next });
  }

  function busy() {
    if (job) return `${job.label} is running. Wait for it, or stop it first.`;
    return undefined;
  }
  const fail = (status, error) => ({ status, error });

  /**
   * Before every run: the AI it runs on is installed and signed in (claude auth status, or Copilot's sign-in and plan),
   * and playwright-cli is there when the step explores the app. Resolves { provider } or { status, error }.
   */
  async function preflight(needsBrowser, provider) {
    const st = await aiStatus();
    const p = provider ?? chosenProvider(st, readAiSettings(root).provider);
    const why = notReady(st, p);
    if (why) return fail(409, `${why} Change it in Settings → AI.`);
    if (needsBrowser && !findOnPath("playwright-cli")) return fail(409, "playwright-cli isn't installed, so the Analyst can't explore the app. Run the qa-setup skill, or: npm install -g @playwright/cli@latest");
    return { provider: p };
  }

  /** This run's model picks ({ analyst: "opus", … }): known roles; a Claude alias or a Copilot model id; "" = the default. */
  function runModels(raw, provider) {
    if (raw === undefined || raw === null) return { models: {} };
    if (typeof raw !== "object" || Array.isArray(raw)) return { error: "Send the models as { <role>: <model> }." };
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!MODEL_ROLES.includes(k)) return { error: `Unknown role "${k}".` };
      if (typeof v !== "string") return { error: `The model for ${k} must be text.` };
      if (!v) continue;
      const ok = provider === "copilot-sdk" ? /^[\w.:/@[\]-]{1,120}$/.test(v) : MODEL_ALIASES.includes(v);
      if (!ok) return { error: `"${v}" isn't a ${PROVIDER_LABEL[provider]} model the dashboard can start an agent with.` };
      out[k] = v;
    }
    return { models: out };
  }

  /** POST api/run/start { url, grep, mode, headed, config, models, snapshots: "reuse" | "refresh" | "fresh" } */
  async function start(body) {
    const b = body && typeof body === "object" ? body : {};
    const url = typeof b.url === "string" ? b.url.trim() : "";
    let parsed;
    try { parsed = new URL(url); } catch {}
    if (!parsed || !/^https?:$/.test(parsed.protocol) || /\s/.test(url) || url.length > 2048) return fail(400, "Enter the app's address, starting with http:// or https://.");
    const grep = b.grep === undefined ? "@smoke" : b.grep;
    if (typeof grep !== "string" || !(grep === "all" || (grep.length <= 200 && GREP_RE.test(grep)))) return fail(400, 'The tests to run must be "all" or tags such as @smoke or @smoke|@regression.');
    if (b.mode !== undefined && b.mode !== "step" && b.mode !== "auto") return fail(400, 'The mode must be "step" or "auto".');
    if (b.headed !== undefined && typeof b.headed !== "boolean") return fail(400, "headed must be true or false.");
    if (b.config !== undefined && b.config !== "keep" && b.config !== "overwrite") return fail(400, 'config must be "keep" or "overwrite".');
    // The snapshots and requirements a teammate committed: reuse them (no Analyst), refresh them, or explore again.
    const snapMode = b.snapshots ?? "fresh";
    if (!["reuse", "refresh", "fresh"].includes(snapMode)) return fail(400, 'snapshots must be "reuse", "refresh" or "fresh".');
    const snapCount = (() => { try { return fs.readdirSync(path.join(dataDir, "snapshots")).filter((x) => x.endsWith(".yml")).length; } catch { return 0; } })();
    if (snapMode !== "fresh" && (!snapCount || !has(".agentic-qa/requirements/requirements.md"))) return fail(400, "There are no snapshots and requirements to reuse yet. Explore the app from scratch.");
    if (busy()) return fail(409, busy());
    const pre = await preflight(snapMode !== "reuse");
    if (pre.error) return pre;
    const picks = runModels(b.models, pre.provider);
    if (picks.error) return fail(400, picks.error);
    if (busy()) return fail(409, busy());
    for (const d of ["snapshots", "requirements", "test-plan", "test-cases", "test-scripts/pages", "reports/test-results"]) fs.mkdirSync(path.join(dataDir, d), { recursive: true });
    // An existing requirements document dropped next to requirements.md is merged in, as the qa-pipeline skill does.
    const dropped = fs.readdirSync(path.join(dataDir, "requirements")).filter((f) => /\.md$/i.test(f) && f !== "requirements.md");
    const run = newRunId();
    const config = has("playwright.config.ts") ? (b.config ?? "keep") : undefined;
    record({ step: "pipeline", event: "start", run, target: url, filter: grep, mode: b.mode ?? "step", headed: b.headed || undefined, config, requirements: dropped.length === 1 ? `.agentic-qa/requirements/${dropped[0]}` : undefined, provider: pre.provider, models: Object.keys(picks.models).length ? picks.models : undefined, snapshots: snapMode });
    if (snapMode === "reuse") record({ step: "analyst", event: "skipped", run, note: `Reused the committed requirements and ${snapCount} snapshot${snapCount === 1 ? "" : "s"}` });
    try { runStep(lastRun(), snapMode === "reuse" ? "qa-planner" : "analyst"); } catch (err) { return fail(err.status ?? 500, err.message); }
    return { status: 200 };
  }

  /** POST api/run/step { step }: run one step of the last run (the next one, again, or the deferred reviewer). */
  async function step(body) {
    const id = body && typeof body === "object" ? body.step : undefined;
    if (!STEP_IDS.includes(id)) return fail(400, `Unknown step. Steps: ${STEP_IDS.join(", ")}.`);
    const run = lastRun();
    if (!run || !run.start.target) return fail(409, "There's no full-suite run to continue. Start one with the app's address.");
    if (busy()) return fail(409, busy());
    // A run keeps the AI it started on.
    const pre = await preflight(id === "analyst", run.start.provider === "copilot-sdk" ? "copilot-sdk" : "anthropic");
    if (pre.error) return pre;
    if (busy()) return fail(409, busy());
    const ended = run.events.filter((e) => e.step === "pipeline" && e.event !== "start").at(-1);
    if (ended && ended.event !== "resume") record({ step: "pipeline", event: "resume", run: run.start.run });
    try { runStep(run, id); } catch (err) { return fail(err.status ?? 500, err.message); }
    return { status: 200 };
  }

  /** POST api/run/stop {}: stop the running job; a step left "running" by a session that's gone is marked stopped. */
  function stop() {
    if (job) {
      job.stopping = true;
      killTree(job.child);
      return { status: 200 };
    }
    const run = lastRun();
    const last = run ? stepEvents(run) : {};
    const stale = STEP_IDS.find((id) => last[id] === "start");
    if (!stale) return fail(409, "Nothing is running.");
    record({ step: stale, event: "failed", run: run.start.run, note: "Marked as stopped from the dashboard" });
    record({ step: "pipeline", event: "paused", run: run.start.run, next: stale });
    return { status: 200 };
  }

  /** POST api/run/finish {}: end the last run without running its remaining steps. */
  function finish() {
    const why = busy();
    if (why) return fail(409, why);
    const run = lastRun();
    if (!run) return fail(409, "There's no full-suite run.");
    record({ step: "pipeline", event: "done", run: run.start.run, note: "Ended from the dashboard" });
    return { status: 200 };
  }

  /** POST api/run/story { key, url?, force?, models? }: run the story's next steps with the qa-story skill, up to its next review. */
  async function story(body) {
    const b = body && typeof body === "object" ? body : {};
    if (typeof b.key !== "string" || !storyKeys(root).includes(b.key)) return fail(400, "Unknown story.");
    let url = "";
    if (b.url !== undefined && b.url !== "") {
      let parsed;
      try { parsed = new URL(String(b.url).trim()); } catch {}
      if (!parsed || !/^https?:$/.test(parsed.protocol) || /\s/.test(String(b.url).trim())) return fail(400, "Enter the app's address, starting with http:// or https://.");
      url = String(b.url).trim();
    }
    if (busy()) return fail(409, busy());
    const pre = await preflight(false);
    if (pre.error) return pre;
    const picks = runModels(b.models, pre.provider);
    if (picks.error) return fail(400, picks.error);
    if (busy()) return fail(409, busy());
    // The skill takes a model per role for this run: --model-<role> <model>.
    const flags = Object.entries(picks.models).map(([role, m]) => ` --model-${role} ${m}`).join("");
    const run = newRunId();
    try {
      launch({
        run,
        logName: b.key,
        label: `Story ${b.key}`,
        provider: pre.provider,
        allowUrl: pre.provider === "copilot-sdk" && url ? new URL(url).origin : undefined,
        args: [],
        // force: redo the story from the start (Design again; it keeps the case IDs and a person's edits).
        prompt: `/${pre.provider === "copilot-sdk" ? "" : prefix}qa-story ${b.key}${url ? ` --url ${url}` : ""}${b.force === true ? " --force" : ""}${flags}`,
        info: { kind: "story", run, key: b.key },
      }, () => {});
    } catch (err) {
      return fail(err.status ?? 500, err.message);
    }
    return { status: 200 };
  }

  function status() {
    return {
      available: !!claudePath() || !!findOnPath("copilot"),
      job: job ? {
        kind: job.kind, run: job.run, step: job.step, key: job.key, label: job.label, log: job.log, events: job.events, startedAt: job.startedAt,
        // Changes while it runs; the page reads it for the run panel without redrawing the view.
        live: { files: job.files.size, snaps: job.snaps, tokens: job.tokens ?? null },
      } : null,
    };
  }

  /** The server is stopping: stop the job too, and record it, since its exit may not arrive in time. */
  function shutdown() {
    if (!job) return;
    const j = job;
    job = null;
    j.stopping = j.silent = true;
    killTree(j.child);
    if (j.kind === "suite") {
      record({ step: j.step, event: "failed", run: j.run, note: "Stopped: the dashboard was closed" });
      record({ step: "pipeline", event: "paused", run: j.run, next: j.step });
    }
  }

  return { status, start, step, stop, finish, story, shutdown };
}
