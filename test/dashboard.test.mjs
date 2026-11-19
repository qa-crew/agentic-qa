import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildState, buildStory } from "../.claude/skills/qa-dashboard/dashboard/read.mjs";
import { inline, renderMarkdown } from "../.claude/skills/qa-dashboard/dashboard/md.mjs";
import { makeProject } from "./helpers/fixture.mjs";

const SERVER = fileURLToPath(new URL("../.claude/skills/qa-dashboard/dashboard/server.mjs", import.meta.url));

test("markdown is escaped, links are filtered", () => {
  const html = renderMarkdown("# Title\n\n<script>x</script> **bold** `a<b`\n\n- one\n  - two\n- three\n\n| A | B |\n|---|---|\n| 1<br>2 | x \\| y |\n\n[ok](https://a.example) [bad](javascript:alert(1)) [rel](../evidence/a.png)\n");
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<code>a&lt;b</code>"));
  assert.ok(html.includes("<ul><li>one<ul><li>two</li></ul></li><li>three</li></ul>"));
  assert.ok(html.includes("<td>1<br>2</td>"));
  assert.ok(html.includes("<td>x | y</td>"));
  assert.ok(html.includes('<a href="https://a.example">ok</a>'));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes('<a href="../evidence/a.png">rel</a>'));
  assert.equal(inline('"quote" & <i>'), "&quot;quote&quot; &amp; &lt;i&gt;");
});

test("buildState reads the suite and the stories", () => {
  const dir = makeProject();
  const s = buildState(dir);
  assert.equal(s.suite.run.target, "https://www.saucedemo.com");
  assert.deepEqual(s.suite.steps.map((x) => x.state), ["done", "done", "running", "pending", "pending"]);
  assert.equal(s.suite.steps[0].durationMs, 90_000);
  assert.deepEqual(s.suite.specs, [".agentic-qa/test-scripts/login.spec.ts"], "story specs are left out of the suite");
  assert.deepEqual(s.suite.testCases.map((t) => [t.path, t.cases]), [[".agentic-qa/test-cases/login.md", 2]]);
  assert.deepEqual(s.suite.results.stats, { passed: 2, failed: 1, skipped: 0, flaky: 0 });
  assert.equal(s.suite.results.failures[0].error, "Expected: locked");
  assert.equal(s.stories.length, 1);
  assert.equal(s.stories[0].key, "SD-1");
  assert.equal(s.stories[0].next, "story-run");
  assert.equal(s.stories[0].stale, false);
  const story = buildStory(dir, "SD-1");
  assert.equal(story.rows.length, 3);
  assert.equal(story.rows[0].html.Steps, "1. Open<br>2. Log in");
  assert.equal(story.rows[1].html.Title, "Locked | user");
  assert.ok(!story.notesHtml.includes("<script>"));
});

test("the views get what they need: activity, failures linked to their test cases, criteria, notes and run history", () => {
  const dir = makeProject();
  const tc = path.join(dir, ".agentic-qa/test-cases/SD-1-login.md");
  fs.appendFileSync(tc, "\n- TC-SD1-N-001: expected the locked-out error; actual: the inventory opens.\n\n## Run History\n| Run | Date | Passed | Failed | Flaky | Skipped | Report |\n|---|---|---|---|---|---|---|\n| r1 | 2026-11-10 | 1 | 1 | 0 | 0 | — |\n| r2 | 2026-11-11 | 2 | 0 | 0 | 0 | — |\n");
  const shot = path.join(dir, ".agentic-qa/reports/test-results/locked/fail.png");
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, "png");
  const report = JSON.parse(fs.readFileSync(path.join(dir, ".agentic-qa/reports/test-results/results.json"), "utf-8"));
  const locked = report.suites[0].suites[0].specs[1].tests[0];
  locked.results[0].attachments = [{ path: shot, contentType: "image/png" }];
  report.suites[0].suites[0].specs.push({ title: "TC-LOGIN-S-002 — b", tests: [{ status: "flaky", results: [{ status: "failed" }, { status: "passed" }] }] });
  fs.writeFileSync(path.join(dir, ".agentic-qa/reports/test-results/results.json"), JSON.stringify(report));

  const s = buildState(dir);
  assert.equal(s.activity[0].step, "qa-engineer", "newest first");
  assert.equal(s.activity[0].event, "start");
  assert.equal(s.activity.at(-1).step, "pipeline");
  const fail = s.suite.results.failures[0];
  assert.equal(fail.tcId, "TC-SD1-N-001");
  assert.equal(fail.testCase.file, ".agentic-qa/test-cases/SD-1-login.md");
  assert.equal(fail.testCase.story, "SD-1");
  assert.equal(fail.testCase.expected, "Error");
  assert.equal(fail.screenshot, ".agentic-qa/reports/test-results/locked/fail.png", "only screenshots inside .agentic-qa/ are linked");
  assert.match(fail.detail, /^Expected: locked\nmore$/);
  assert.equal(s.suite.results.flaky[0].testCase.file, ".agentic-qa/test-cases/login.md", "the full suite's simpler tables count too");
  assert.equal(s.suite.results.flaky[0].retries, 1);
  assert.deepEqual(s.stories[0].runs.map((r) => [r.run, r.failed]), [["r1", 1], ["r2", 0]]);
  assert.equal(s.stories[0].lastRun.run, "r2");

  const story = buildStory(dir, "SD-1");
  assert.deepEqual(story.criteria, [{ id: "AC1", html: "Given a valid user, when they log in, then the inventory shows" }]);
  assert.deepEqual(story.notesByCase, { "TC-SD1-N-001": ["Expected the locked-out error; actual: the inventory opens."] });
});

test("a story step left running by a cut-off session isn't shown as running once a newer run starts", () => {
  const dir = makeProject();
  const log = path.join(dir, ".agentic-qa", "progress.jsonl");
  const add = (step, event, run, ts) =>
    fs.appendFileSync(log, JSON.stringify({ ts, kind: "story", story: "SD-1", step, event, run }) + "\n");
  add("story-design", "start", "S1", "2026-11-12T21:41:50Z");
  add("story-design", "done", "S1", "2026-11-12T21:43:34Z");
  add("story-explore", "start", "S1", "2026-11-12T21:43:35Z");
  const explore = (s) => s.steps.find((x) => x.id === "story-explore");

  let s = buildState(dir).stories[0];
  assert.equal(s.running, "story-explore", "with no newer run, it may still be running");
  assert.equal(explore(s).state, "running");

  add("story-script", "start", "S2", "2026-11-12T22:25:00Z");
  s = buildState(dir).stories[0];
  assert.equal(s.running, "story-script");
  assert.equal(explore(s).state, undefined);
  assert.equal(explore(s).durationMs, undefined);
  assert.equal(explore(s).done, true, "the files still say Explore is done");
  assert.equal(s.steps.find((x) => x.id === "story-design").durationMs, 104_000);
});

function get(port, route, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: route, headers: { Host: host } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body, type: res.headers["content-type"] }));
    }).on("error", reject);
  });
}

function post(port, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, path: route, method: "POST", headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers } }, (res) => {
      let out = "";
      res.on("data", (c) => (out += c));
      res.on("end", () => resolve({ status: res.statusCode, body: out }));
    });
    req.on("error", reject);
    req.end(data);
  });
}

test("the live server reads only .agentic-qa/ and writes only .agentic-qa/ai.json and settings.json", async () => {
  const dir = makeProject();
  const child = spawn(process.execPath, [SERVER, "--dir", dir], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    const link = await new Promise((resolve, reject) => {
      let out = "";
      child.stdout.on("data", (c) => {
        out += c;
        const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)(\/[0-9a-f]+\/)/);
        if (m) resolve({ port: Number(m[1]), base: m[2] });
      });
      child.on("exit", () => reject(new Error("server exited")));
    });
    const { port, base } = link;
    assert.equal((await get(port, base, "evil.example")).status, 403, "Host header is checked");
    assert.equal((await get(port, "/")).status, 404, "nothing without the token");
    const pageRes = await get(port, base);
    assert.equal(pageRes.status, 200);
    assert.ok(pageRes.body.includes("--bg-canvas"), "theme CSS is inlined");
    assert.ok(!pageRes.body.includes("/*THEME_CSS*/"));
    const state = JSON.parse((await get(port, base + "api/state")).body);
    assert.equal(state.stories[0].key, "SD-1");
    const d = JSON.parse((await get(port, base + "api/doc?path=" + encodeURIComponent(".agentic-qa/requirements/requirements.md"))).body);
    assert.equal(d.kind, "md");
    assert.ok(d.html.includes("<h1"));
    assert.equal((await get(port, base + "api/doc?path=" + encodeURIComponent("secret.txt"))).status, 404);
    assert.equal((await get(port, base + "api/doc?path=" + encodeURIComponent(".agentic-qa/../secret.txt"))).status, 404);
    assert.equal((await get(port, base + "raw/.agentic-qa/%2E%2E/secret.txt")).status, 404);
    assert.equal((await get(port, base + "raw/.agentic-qa/snapshots/home.yml")).status, 200);
    assert.equal((await get(port, base + "fonts/../server.mjs")).status, 404);
    assert.equal((await get(port, base + "fonts/ibm-plex-sans-400.woff2")).type, "font/woff2");
    assert.equal((await get(port, base + "api/story?key=NOPE-1")).status, 404);

    // Models: the one write.
    const m = JSON.parse((await get(port, base + "api/models")).body);
    assert.deepEqual(m.roles.map((r) => r.key), ["default", "analyst", "qa-planner", "qa-engineer", "qa-reviewer", "qa-reporter"]);
    assert.deepEqual(m.options, ["sonnet", "opus", "haiku", "fable"]);
    const aiFile = path.join(dir, ".agentic-qa/ai.json");
    assert.equal((await post(port, base + "api/models", { models: { analyst: "opus" } }, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post(port, base + "api/models", { models: { analyst: "opus" } }, { Origin: "" })).status, 403);
    assert.equal((await post(port, base + "api/models", "models=1", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await post(port, base + "api/models", { models: { planner: "opus" } })).status, 400);
    assert.equal((await post(port, base + "api/models", { models: { analyst: "gpt-5" } })).status, 400);
    assert.equal((await post(port, base + "api/models", "x".repeat(5000))).status, 413);
    assert.equal((await post(port, base + "api/models", "{not json")).status, 400);
    assert.equal((await post(port, base + "api/doc", {})).status, 405);
    assert.ok(!fs.existsSync(aiFile), "nothing written by a refused request");
    const saved = await post(port, base + "api/models", { models: { default: "", analyst: "opus", "qa-planner": "haiku" } });
    assert.equal(saved.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(aiFile, "utf-8")), { models: { anthropic: { analyst: "opus", "qa-planner": "haiku" } } });
    assert.equal(JSON.parse(saved.body).resolved.analyst.model, "opus");

    // Settings: the project's default look.
    const settingsFile = path.join(dir, ".agentic-qa/settings.json");
    const before = JSON.parse((await get(port, base + "api/settings")).body);
    assert.equal(before.exists, false);
    assert.equal(before.appearance, null);
    assert.deepEqual(before.builtIn, { theme: "geist", mode: "system" });
    assert.deepEqual(before.options.theme, ["geist", "carbon", "industrial", "corporate"]);
    const look = { theme: "corporate", mode: "dark" };
    assert.equal((await post(port, base + "api/settings", { appearance: look }, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post(port, base + "api/settings", "appearance=1", { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post(port, base + "api/settings", { appearance: { ...look, theme: "slate" } })).status, 400);
    assert.equal((await post(port, base + "api/settings", { appearance: { ...look, mode: "sepia" } })).status, 400);
    assert.equal((await post(port, base + "api/settings", { appearance: { theme: "geist" } })).status, 400, "every setting is required");
    assert.equal((await post(port, base + "api/settings", { appearance: { ...look, colour: "red" } })).status, 400, "unknown keys are refused");
    assert.equal((await post(port, base + "api/settings", { look })).status, 400);
    assert.ok(!fs.existsSync(settingsFile), "nothing written by a refused request");
    fs.writeFileSync(settingsFile, JSON.stringify({ team: "qa" }));
    const ok = await post(port, base + "api/settings", { appearance: look });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.body).appearance, look);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf-8")), { team: "qa", appearance: look }, "other keys in the file are kept");
    assert.ok((await get(port, base)).body.includes('window.__AGENTIC_QA_APPEARANCE__={"theme":"corporate","mode":"dark"}'), "the page boots with the project default");
    // Density was a setting once: a page still open from then may send it, and it's ignored, not saved.
    assert.equal((await post(port, base + "api/settings", { appearance: { ...look, density: "compact" } })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf-8")).appearance, look);
    fs.writeFileSync(settingsFile, "{not json");
    assert.equal((await post(port, base + "api/settings", { appearance: look })).status, 409, "a broken file isn't overwritten");
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), "{not json");
    assert.equal(JSON.parse((await get(port, base + "api/settings")).body).valid, false);
    assert.equal((await get(port, base + "fonts/geist-400.woff2")).type, "font/woff2");
  } finally {
    child.kill();
  }
});

/** A bin folder with a fake `claude` (test/helpers/fake-claude.mjs) and an empty `playwright-cli`, for PATH. */
function fakeBin() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-qa-bin-"));
  const fake = fileURLToPath(new URL("./helpers/fake-claude.mjs", import.meta.url));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "claude.cmd"), `@"${process.execPath}" "${fake}" %*\r\n`);
    fs.writeFileSync(path.join(bin, "playwright-cli.cmd"), "@exit /b 0\r\n");
  } else {
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "playwright-cli"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return bin;
}

function startServer(dir, env = process.env) {
  const child = spawn(process.execPath, [SERVER, "--dir", dir], { stdio: ["ignore", "pipe", "inherit"], env });
  const ready = new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
      const m = out.match(/http:\/\/127\.0\.0\.1:(\d+)(\/[0-9a-f]+\/)/);
      if (m) resolve({ port: Number(m[1]), base: m[2] });
    });
    child.on("exit", () => reject(new Error("server exited")));
  });
  return { child, ready };
}

async function until(fn, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test("the run buttons start each step as a headless claude session, pause between steps and stop", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-qa-run-"));
  const env = { ...process.env, PATH: fakeBin() + path.delimiter + process.env.PATH };
  const { child, ready } = startServer(dir, env);
  try {
    const { port, base } = await ready;
    const state = async () => JSON.parse((await get(port, base + "api/state")).body);
    const idle = (s) => !s.control.job && s;
    const s0 = await state();
    assert.equal(s0.control.available, true, "the fake claude is found on PATH");
    assert.equal(s0.control.job, null);

    // Refused: a wrong origin, an address that isn't http(s), an odd test filter, a step that doesn't exist.
    assert.equal((await post(port, base + "api/run/start", { url: "https://shop.example" }, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post(port, base + "api/run/start", { url: "file:///etc/passwd" })).status, 400);
    assert.equal((await post(port, base + "api/run/start", { url: "https://shop.example", grep: "@smoke; rm -rf /" })).status, 400);
    assert.equal((await post(port, base + "api/run/start", { url: "https://shop.example", mode: "fast" })).status, 400);
    assert.equal((await post(port, base + "api/run/step", { step: "qa-planner" })).status, 409, "no run to continue yet");
    assert.equal((await post(port, base + "api/run/step", { step: "rm" })).status, 400);
    assert.equal((await post(port, base + "api/run/story", { key: "NOPE-1" })).status, 400);
    assert.ok(!fs.existsSync(path.join(dir, ".agentic-qa/progress.jsonl")), "nothing recorded by a refused request");

    // Step by step: the Analyst runs, then the run waits for the QA Planner.
    const started = await post(port, base + "api/run/start", { url: "https://shop.example/login", grep: "@smoke|@regression", headed: true });
    assert.equal(started.status, 200, started.body);
    assert.equal(JSON.parse(started.body).control.job.step, "analyst", "the reply shows the step running");
    let s = await until(async () => idle(await state()), "the Analyst");
    assert.equal(s.suite.run.state, "paused");
    assert.equal(s.suite.run.next, "qa-planner");
    assert.equal(s.suite.run.target, "https://shop.example/login");
    assert.equal(s.suite.run.filter, "@smoke|@regression");
    assert.deepEqual(s.suite.steps.map((x) => x.state), ["done", "pending", "pending", "pending", "pending"]);
    const calls = () => fs.readFileSync(path.join(dir, ".agentic-qa/fake-claude.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const first = calls()[0];
    assert.deepEqual(first.args.slice(0, 3), ["-p", "--agent", "analyst"]);
    assert.ok(first.args.includes("acceptEdits") && first.args.includes("Bash(playwright-cli *)"));
    assert.equal(first.prompt, "Target URL: https://shop.example/login\nheaded", "the task message goes in on stdin");
    // The run panel: typed activity, the tokens the step used, and a feed the page reads from a cursor.
    assert.equal(s.suite.steps[0].tokens, 4700, "input + output + cache read + cache write");
    const feedPath = `.agentic-qa/logs/${s.suite.run.run}/analyst.events.jsonl`;
    assert.equal(s.suite.steps[0].feed, feedPath);
    const feed = JSON.parse((await get(port, base + "api/run/feed?path=" + encodeURIComponent(feedPath))).body);
    assert.deepEqual(feed.events.map((e) => e.kind), ["note", "snap", "write", "agent", "warn", "done"]);
    assert.match(feed.events[2].path, /\.agentic-qa\/notes\.md$/);
    assert.equal(JSON.parse((await get(port, base + "api/run/feed?path=" + encodeURIComponent(feedPath) + "&after=4")).body).events.length, 2, "from a cursor");
    assert.equal((await get(port, base + "api/run/feed?path=" + encodeURIComponent(".agentic-qa/progress.jsonl"))).status, 404, "only events files");
    assert.equal((await get(port, base + "api/run/feed?path=" + encodeURIComponent(".agentic-qa/logs/../../secret.events.jsonl"))).status, 404);
    const log = fs.readFileSync(path.join(dir, `.agentic-qa/logs/${s.suite.run.run}/analyst.log`), "utf-8");
    assert.match(log, /Working as analyst\.\n→ Bash playwright-cli snapshot/);
    assert.equal(JSON.parse((await get(port, base + "api/doc?path=" + encodeURIComponent(`.agentic-qa/logs/${s.suite.run.run}/analyst.log`))).body).kind, "text", "the page can read the log");

    // Continue twice: after the QA Engineer, the slow QA Reviewer is deferred and the QA Reporter is next.
    assert.equal((await post(port, base + "api/run/step", { step: "qa-planner" })).status, 200);
    s = await until(async () => idle(await state()), "the QA Planner");
    assert.equal(s.suite.run.next, "qa-engineer");
    assert.equal(calls()[1].prompt, "Base URL: https://shop.example");
    assert.equal((await post(port, base + "api/run/step", { step: "qa-engineer" })).status, 200);
    s = await until(async () => idle(await state()), "the QA Engineer");
    assert.equal(s.suite.run.next, "qa-reporter");
    assert.equal(s.suite.steps[3].state, "skipped");
    assert.match(s.suite.steps[3].note, /^Deferred/);
    assert.match(calls()[2].prompt, /Test filter: @smoke\|@regression/);

    // The reporter's final message becomes summary_report.md, and the run ends.
    assert.equal((await post(port, base + "api/run/step", { step: "qa-reporter" })).status, 200);
    s = await until(async () => { const x = idle(await state()); return x && x.suite.run.state === "done" && x; }, "the QA Reporter");
    assert.equal(fs.readFileSync(path.join(dir, ".agentic-qa/reports/summary_report.md"), "utf-8"), "# Summary report\n\nStatus: all passed.\n");
    assert.match(calls()[3].prompt, /Run id: .+\nTest filter: @smoke\|@regression\nDon't write summary_report\.md yourself/);
    assert.deepEqual(s.suite.steps.map((x) => x.state), ["done", "done", "done", "skipped", "done"]);

    // A step that writes nothing fails, and the run waits on it: the last run's requirements.md doesn't count.
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal((await post(port, base + "api/run/start", { url: "https://fail.example", mode: "auto" })).status, 200);
    s = await until(async () => idle(await state()), "the failing Analyst");
    assert.equal(s.suite.steps[0].state, "failed");
    assert.match(s.suite.steps[0].note, /exit code 1/);
    assert.equal(s.suite.run.next, "analyst");
    assert.deepEqual(s.suite.steps.slice(1).map((x) => x.state), ["pending", "pending", "pending", "pending"], "steps from the earlier run aren't shown as done");

    // One job at a time; Stop ends it.
    assert.equal((await post(port, base + "api/run/start", { url: "https://slow.example" })).status, 200);
    await until(() => fs.existsSync(path.join(dir, ".agentic-qa/fake-claude.jsonl")) && calls().at(-1).prompt.includes("slow.example"), "the slow Analyst to start");
    assert.equal((await post(port, base + "api/run/start", { url: "https://shop.example" })).status, 409);
    assert.equal((await post(port, base + "api/run/finish", {})).status, 409);
    assert.equal((await post(port, base + "api/run/stop", {})).status, 200);
    s = await until(async () => idle(await state()), "the stop");
    assert.equal(s.suite.steps[0].state, "failed");
    assert.equal(s.suite.steps[0].note, "Stopped from the dashboard");
    assert.equal(s.suite.run.next, "analyst");
    assert.equal((await post(port, base + "api/run/finish", {})).status, 200);
    assert.equal((await state()).suite.run.state, "done");
  } finally {
    child.kill();
  }
});

test("the story page edits test cases, and the reader edits files and opens them in an editor", async () => {
  const dir = makeProject();
  const bin = fakeBin();
  // A no-op `code`, so Open in editor has an editor to start.
  if (process.platform === "win32") fs.writeFileSync(path.join(bin, "code.cmd"), "@exit /b 0\r\n");
  else fs.writeFileSync(path.join(bin, "code"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  delete env.AGENTIC_QA_EDITOR;
  const { child, ready } = startServer(dir, env);
  try {
    const { port, base } = await ready;
    const tcFile = path.join(dir, ".agentic-qa/test-cases/SD-1-login.md");
    const story = async () => JSON.parse((await get(port, base + "api/story?key=SD-1")).body);
    const row = (s, id) => s.rows.find((r) => r.cells.ID === id);
    const baseOf = (r) => Object.fromEntries(["AC", "Title", "Preconditions", "Steps", "Expected", "Tags", "Status"].map((k) => [k, r.cells[k]]));
    const valid = row(await story(), "TC-SD1-S-001");

    // Update: steps are numbered for you; other columns and other rows stay as they were.
    let r = await post(port, base + "api/story/case", { key: "SD-1", action: "update", id: "TC-SD1-S-001", base: baseOf(valid), cells: { Title: "Valid | login", Steps: "Open the page\n2. Log in\n\nSee the inventory", Status: "Updated" } });
    assert.equal(r.status, 200, r.body);
    let s = JSON.parse(r.body).story;
    assert.equal(row(s, "TC-SD1-S-001").cells.Steps, "1. Open the page<br>2. Log in<br>3. See the inventory");
    assert.equal(row(s, "TC-SD1-S-001").cells.Title, "Valid \\| login");
    assert.equal(row(s, "TC-SD1-S-001").cells.Status, "Updated");
    assert.equal(row(s, "TC-SD1-N-001").cells.Status, "Possible defect");
    assert.match(fs.readFileSync(tcFile, "utf-8"), /## Exploration Notes/, "the rest of the file is kept");

    // A stale form (the row changed since it opened) is refused; so are unknown columns and statuses.
    r = await post(port, base + "api/story/case", { key: "SD-1", action: "update", id: "TC-SD1-S-001", base: baseOf(valid), cells: { Title: "Mine" } });
    assert.equal(r.status, 409);
    const fresh = row(await story(), "TC-SD1-S-001");
    assert.equal((await post(port, base + "api/story/case", { key: "SD-1", action: "update", id: "TC-SD1-S-001", base: baseOf(fresh), cells: { "Last Result": "passed" } })).status, 400);
    assert.equal((await post(port, base + "api/story/case", { key: "SD-1", action: "update", id: "TC-SD1-S-001", base: baseOf(fresh), cells: { Status: "Done" } })).status, 400);
    assert.equal((await post(port, base + "api/story/case", { key: "NOPE-1", action: "update", id: "x", cells: {} })).status, 404);
    assert.equal((await post(port, base + "api/story/case", { key: "SD-1", action: "update", id: "TC-SD1-S-001", base: baseOf(fresh), cells: { Title: "x" } }, { Origin: "http://evil.example" })).status, 403);

    // Add: the next free ID of the type; Delete: the row goes and its ID is retired, so it's never reused.
    r = await post(port, base + "api/story/case", { key: "SD-1", action: "add", type: "N", cells: { AC: "AC1", Title: "Wrong password", Steps: "Log in with a wrong password", Expected: "An error", Tags: "@negative @SD-1" } });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).id, "TC-SD1-N-002");
    s = JSON.parse(r.body).story;
    assert.equal(row(s, "TC-SD1-N-002").cells.Status, "Draft");
    assert.equal(row(s, "TC-SD1-N-002").cells["Last Result"], "—");
    r = await post(port, base + "api/story/case", { key: "SD-1", action: "delete", id: "TC-SD1-N-002", base: baseOf(row(s, "TC-SD1-N-002")) });
    assert.equal(r.status, 200, r.body);
    assert.equal(row(JSON.parse(r.body).story, "TC-SD1-N-002"), undefined);
    assert.match(fs.readFileSync(tcFile, "utf-8"), /^retired: TC-SD1-N-002$/m);
    r = await post(port, base + "api/story/case", { key: "SD-1", action: "add", type: "N", cells: { Title: "Again" } });
    assert.equal(JSON.parse(r.body).id, "TC-SD1-N-003", "a retired ID isn't reused");
    assert.equal((await post(port, base + "api/story/case", { key: "SD-1", action: "add", type: "X", cells: { Title: "x" } })).status, 400);

    // Not while one of the story's steps is running.
    fs.appendFileSync(path.join(dir, ".agentic-qa/progress.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "story", story: "SD-1", step: "story-explore", event: "start", run: "S9" }) + "\n");
    const now = row(await story(), "TC-SD1-S-001");
    assert.equal((await post(port, base + "api/story/case", { key: "SD-1", action: "update", id: "TC-SD1-S-001", base: baseOf(now), cells: { Title: "x" } })).status, 409);

    // Files: read for editing, saved with the line endings the file had, refused when stale or out of bounds.
    const req = ".agentic-qa/requirements/requirements.md";
    fs.writeFileSync(path.join(dir, req), "# Requirements\r\n\r\nOld.\r\n");
    let f = JSON.parse((await get(port, base + "api/file?path=" + encodeURIComponent(req))).body);
    assert.equal(f.text, "# Requirements\r\n\r\nOld.\r\n");
    r = await post(port, base + "api/file", { path: req, text: "# Requirements\n\nNew.\n", version: f.version });
    assert.equal(r.status, 200, r.body);
    assert.equal(fs.readFileSync(path.join(dir, req), "utf-8"), "# Requirements\r\n\r\nNew.\r\n");
    assert.equal((await post(port, base + "api/file", { path: req, text: "stale", version: f.version })).status, 409, "an older version can't overwrite");
    f = JSON.parse((await get(port, base + "api/file?path=" + encodeURIComponent(req))).body);
    assert.equal((await post(port, base + "api/file", { path: "secret.txt", text: "x", version: "1" })).status, 404);
    assert.equal((await post(port, base + "api/file", { path: ".agentic-qa/../secret.txt", text: "x", version: "1" })).status, 404);
    assert.equal((await post(port, base + "api/file", { path: ".agentic-qa/reports/test-results/results.json", text: "{}", version: "1" })).status, 404, "only text documents");
    fs.mkdirSync(path.join(dir, ".agentic-qa/logs/R1"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agentic-qa/logs/R1/analyst.log"), "log");
    assert.equal((await post(port, base + "api/file", { path: ".agentic-qa/logs/R1/analyst.md", text: "x", version: "1" })).status, 404);
    assert.equal((await get(port, base + "api/file?path=" + encodeURIComponent(".agentic-qa/logs/R1/analyst.log"))).status, 404, "logs aren't editable");
    assert.equal((await post(port, base + "api/file", { path: ".agentic-qa/new.md", text: "x", version: "1" })).status, 404, "no new files");
    assert.equal((await post(port, base + "api/file", { path: req, text: "x".repeat(7 * 1024 * 1024), version: f.version })).status, 413);
    assert.equal((await post(port, base + "api/file", { path: req, text: "x", version: f.version }, { Origin: "http://evil.example" })).status, 403);
    assert.equal(fs.readFileSync(path.join(dir, "secret.txt"), "utf-8"), "do not serve");

    // Open in editor: only files the page may show, never the logs.
    r = await post(port, base + "api/open", { path: req });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).via, "editor");
    assert.equal((await post(port, base + "api/open", { path: "secret.txt" })).status, 404);
    assert.equal((await post(port, base + "api/open", { path: ".agentic-qa/logs/R1/analyst.log" })).status, 404);
  } finally {
    child.kill();
  }
});

test("--static writes one self-contained snapshot", () => {
  const dir = makeProject();
  const r = spawnSync(process.execPath, [SERVER, "--dir", dir, "--static"], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr);
  const html = fs.readFileSync(path.join(dir, ".agentic-qa/reports/dashboard.html"), "utf-8");
  const m = html.match(/window\.__AGENTIC_QA_STATIC__=(.*?);<\/script>/s);
  assert.ok(m, "data is embedded");
  const data = JSON.parse(m[1]);
  assert.ok(data["api/state"].activity.length, "the Now page's activity is in the snapshot");
  assert.ok(data["api/story?key=SD-1"].criteria);
  assert.equal(data["api/runs"].runs[0].key, "Full suite", "the Runs page is in the snapshot");
  assert.ok(html.includes('href="#now" data-view="now"'), "Now is the first view");
  assert.ok(data["api/doc?path=" + encodeURIComponent(".agentic-qa/test-cases/SD-1-login.md")]);
  assert.equal(data["api/settings"].appearance, null, "the Settings page can show the project default");
  assert.ok(html.includes("window.__AGENTIC_QA_APPEARANCE__={}"));
  assert.ok(!/<\/script>\s*alert/.test(html), "embedded text can't close the script tag");
});

test("the run panel's activity is mapped from claude's stream-json, and a story's line has its counts", async () => {
  const { feedEvents, usageOf } = await import("../.claude/skills/qa-dashboard/dashboard/runner.mjs");
  const kinds = (e) => feedEvents(e).map((x) => x.kind);
  const tool = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
  assert.deepEqual(kinds(tool("Edit", { file_path: "a.ts" })), ["edit"]);
  assert.deepEqual(kinds(tool("Read", { file_path: "a.ts" })), [], "reads are left out");
  assert.deepEqual(feedEvents(tool("Bash", { command: "playwright-cli snapshot --filename=.agentic-qa/snapshots/cart.yml" })), [{ kind: "snap", text: "Captured a page snapshot", path: ".agentic-qa/snapshots/cart.yml" }]);
  assert.deepEqual(kinds(tool("Bash", { command: "npx playwright test --grep @smoke" })), ["task"]);
  assert.deepEqual(kinds({ type: "result", is_error: true, subtype: "error_max_turns" }), ["fail"]);
  assert.equal(usageOf({ usage: { input_tokens: 1, output_tokens: 2 } }).total, 3);
  assert.equal(usageOf({}), undefined);

  const dir = makeProject();
  fs.appendFileSync(path.join(dir, ".agentic-qa/progress.jsonl"), JSON.stringify({ ts: "2026-11-11T11:00:00Z", kind: "usage", run: "S1", story: "SD-1", total: 151000 }) + "\n");
  const s = buildState(dir).stories[0];
  assert.deepEqual(s.acs, { total: 1, covered: 1 });
  assert.equal(s.openQuestions, 0, '"None" isn\'t a question');
  assert.equal(s.tokens, 151000);
  assert.ok(buildState(dir).cases.some((c) => c.id === "TC-SD1-N-001" && c.title === "Locked | user" && c.story === "SD-1"), "the jump box's test cases, as text");
});

test("the Runs page lists every suite and story run, newest first, with steps, time, tokens and result", async () => {
  const { runsHistory } = await import("../.claude/skills/qa-dashboard/dashboard/read.mjs");
  const dir = makeProject();
  const log = path.join(dir, ".agentic-qa/progress.jsonl");
  const add = (e) => fs.appendFileSync(log, JSON.stringify(e) + "\n");
  // Story SD-1: a run that designed, explored and ran its tests, then one that failed in Explore.
  add({ ts: "2026-11-12T09:00:00Z", kind: "story", story: "SD-1", step: "story-design", event: "start", run: "S1" });
  add({ ts: "2026-11-12T09:02:00Z", kind: "story", story: "SD-1", step: "story-design", event: "done", run: "S1" });
  add({ ts: "2026-11-12T09:02:01Z", kind: "story", story: "SD-1", step: "story-run", event: "start", run: "S1" });
  add({ ts: "2026-11-12T09:03:00Z", kind: "story", story: "SD-1", step: "story-run", event: "done", run: "S1" });
  add({ ts: "2026-11-12T09:03:05Z", kind: "usage", run: "D1", story: "SD-1", total: 58000 });
  add({ ts: "2026-11-13T09:00:00Z", kind: "story", story: "SD-1", step: "story-explore", event: "start", run: "S2" });
  add({ ts: "2026-11-13T09:05:00Z", kind: "story", story: "SD-1", step: "story-explore", event: "failed", run: "S2", note: "playwright-cli is missing" });
  add({ ts: "2026-11-11T10:01:40Z", kind: "usage", run: "R1", step: "analyst", total: 93000 });
  // The story's Run History records S1's tests.
  fs.appendFileSync(path.join(dir, ".agentic-qa/test-cases/SD-1-login.md"), "\n## Run History\n| Run | Date | Passed | Failed | Flaky | Skipped | Report |\n|---|---|---|---|---|---|---|\n| S1 | 2026-11-12 | 2 | 1 | 0 | 0 | — |\n");

  const runs = runsHistory(dir);
  assert.deepEqual(runs.map((r) => `${r.key}:${r.run}`), ["SD-1:S2", "SD-1:S1", "Full suite:R1"], "newest first");
  const [failed, s1, suite] = runs;
  assert.deepEqual(failed.result, { kind: "failed", text: "Explore: playwright-cli is missing" });
  assert.equal(failed.ai, true);
  assert.equal(s1.result.kind, "failed", "one test failed in that run");
  assert.equal(s1.result.text, "2 passed · 1 failed");
  assert.equal(s1.tokens, 58000, "a story's dashboard session counts toward the run it overlaps");
  assert.deepEqual(s1.steps.map((x) => x.name), ["Design", "Run"]);
  assert.equal(s1.durationMs, 179_000, "the steps' time (2m + 59s), not the gap between them");
  assert.equal(suite.result.kind, "running", "the QA Engineer is still running");
  assert.equal(suite.tokens, 93000);
  assert.equal(suite.target, "https://www.saucedemo.com");
  assert.deepEqual(suite.steps.map((x) => x.status), ["done", "done", "running"]);
});

test("the manual testing guide records a result, a note and a checked screenshot into the test cases", async () => {
  const dir = makeProject();
  const { child, ready } = startServer(dir);
  try {
    const { port, base } = await ready;
    const tcFile = path.join(dir, ".agentic-qa/test-cases/SD-1-login.md");
    const story = async () => JSON.parse((await get(port, base + "api/story?key=SD-1")).body);
    const cells = (s, id) => s.rows.find((r) => r.cells.ID === id).cells;
    const baseOf = (c) => ({ Title: c.Title, Steps: c.Steps, Expected: c.Expected });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]).toString("base64");
    const c = cells(await story(), "TC-SD1-N-001");
    const send = (body, headers) => post(port, base + "api/story/manual", { key: "SD-1", id: "TC-SD1-N-001", base: baseOf(c), ...body }, headers);

    assert.equal((await send({ outcome: "great" })).status, 400);
    assert.equal((await send({ outcome: "failed", shot: { data: Buffer.from("<svg onload=alert(1)>").toString("base64") } })).status, 400, "only real PNG or JPEG");
    assert.equal((await send({ outcome: "failed" }, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post(port, base + "api/story/manual", { key: "SD-1", id: "TC-SD1-N-001", outcome: "failed", base: { Title: "Something else" } })).status, 409, "the case changed since the card opened");

    const r = await send({ outcome: "failed", note: "Logged in anyway |\nwith locked_out_user", shot: { data: png } });
    assert.equal(r.status, 200, r.body);
    const after = cells(JSON.parse(r.body).story, "TC-SD1-N-001");
    assert.match(after["Last Result"], /^❌ Failed \(manual\) · \d{4}-\d{2}-\d{2} · Logged in anyway \\| with locked_out_user$/);
    const link = after.Evidence.match(/^\[screenshot\]\(\.\.\/evidence\/SD-1\/manual-[\dT-]+\/TC-SD1-N-001\.png\)$/);
    assert.ok(link, after.Evidence);
    const shot = path.join(dir, ".agentic-qa/test-cases", after.Evidence.slice("[screenshot](".length, -1));
    assert.equal(fs.readFileSync(shot).toString("base64"), png, "the screenshot is saved as sent");
    assert.match(fs.readFileSync(tcFile, "utf-8"), /## Exploration Notes/, "the rest of the file is kept");
    assert.ok(!/manual-/.test(JSON.parse(r.body).story.historyHtml ?? ""), "no Run History row for a manual result");

    // Not while one of the story's steps is running.
    fs.appendFileSync(path.join(dir, ".agentic-qa/progress.jsonl"), JSON.stringify({ ts: new Date().toISOString(), kind: "story", story: "SD-1", step: "story-run", event: "start", run: "S9" }) + "\n");
    assert.equal((await send({ outcome: "passed", base: baseOf(after) })).status, 409);
  } finally {
    child.kill();
  }
});

test("Settings → Project saves the app URL; open questions tick off; Redo runs /qa-story with --force", async () => {
  const dir = makeProject();
  const tcFile = path.join(dir, ".agentic-qa/test-cases/SD-1-login.md");
  fs.writeFileSync(tcFile, fs.readFileSync(tcFile, "utf-8").replace("## Open Questions\n- None", "## Open Questions\n- Should a locked user see a support link?\n- Is the password field case-sensitive?"));
  const env = { ...process.env, PATH: fakeBin() + path.delimiter + process.env.PATH };
  const { child, ready } = startServer(dir, env);
  try {
    const { port, base } = await ready;
    const story = async () => JSON.parse((await get(port, base + "api/story?key=SD-1")).body);

    // Open questions: each has an id; a tick goes into the front matter and the open count drops.
    let s = await story();
    assert.equal(s.questions.length, 2);
    assert.equal(s.openQuestions, 2);
    const q = s.questions[1];
    let r = await post(port, base + "api/story/question", { key: "SD-1", id: q.id, answered: true });
    assert.equal(r.status, 200, r.body);
    assert.equal(JSON.parse(r.body).story.openQuestions, 1);
    assert.match(fs.readFileSync(tcFile, "utf-8"), new RegExp(`^answered: ${q.id}$`, "m"));
    assert.equal((await post(port, base + "api/story/question", { key: "SD-1", id: "nope", answered: true })).status, 404);
    assert.equal((await post(port, base + "api/story/question", { key: "SD-1", id: q.id, answered: "yes" })).status, 400);
    r = await post(port, base + "api/story/question", { key: "SD-1", id: q.id, answered: false });
    assert.equal(JSON.parse(r.body).story.openQuestions, 2);

    // Settings → Project: workspace.json's appUrl, which the qa-story skill also reads.
    const wsFile = path.join(dir, ".agentic-qa/workspace.json");
    fs.writeFileSync(wsFile, JSON.stringify({ team: "qa" }));
    assert.equal((await post(port, base + "api/workspace", { appUrl: "javascript:alert(1)" })).status, 400);
    assert.equal((await post(port, base + "api/workspace", { appUrl: "https://shop.example" }, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await post(port, base + "api/workspace", { appUrl: "https://staging.shop.example" })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, "utf-8")), { team: "qa", appUrl: "https://staging.shop.example" }, "other keys are kept");
    assert.equal(JSON.parse((await get(port, base + "api/state")).body).workspace.appUrl, "https://staging.shop.example");
    assert.equal((await post(port, base + "api/workspace", { appUrl: "" })).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, "utf-8")), { team: "qa" }, "an empty address clears it");

    // Redo from the start: the story job's prompt ends with --force.
    assert.equal((await post(port, base + "api/run/story", { key: "SD-1", url: "https://shop.example", force: true })).status, 200);
    await until(() => fs.existsSync(path.join(dir, ".agentic-qa/fake-claude.jsonl")), "the story session");
    const call = fs.readFileSync(path.join(dir, ".agentic-qa/fake-claude.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.equal(call.prompt, "/qa-story SD-1 --url https://shop.example --force");
  } finally {
    child.kill();
  }
});
