import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
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
    assert.deepEqual(before.builtIn, { theme: "geist", mode: "system", density: "comfortable" });
    assert.deepEqual(before.options.theme, ["geist", "carbon", "industrial", "corporate"]);
    const look = { theme: "corporate", mode: "dark", density: "compact" };
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
    assert.ok((await get(port, base)).body.includes('window.__AGENTIC_QA_APPEARANCE__={"theme":"corporate","mode":"dark","density":"compact"}'), "the page boots with the project default");
    fs.writeFileSync(settingsFile, "{not json");
    assert.equal((await post(port, base + "api/settings", { appearance: look })).status, 409, "a broken file isn't overwritten");
    assert.equal(fs.readFileSync(settingsFile, "utf-8"), "{not json");
    assert.equal(JSON.parse((await get(port, base + "api/settings")).body).valid, false);
    assert.equal((await get(port, base + "fonts/geist-400.woff2")).type, "font/woff2");
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
  assert.ok(html.includes('href="#now" data-view="now"'), "Now is the first view");
  assert.ok(data["api/doc?path=" + encodeURIComponent(".agentic-qa/test-cases/SD-1-login.md")]);
  assert.equal(data["api/settings"].appearance, null, "the Settings page can show the project default");
  assert.ok(html.includes("window.__AGENTIC_QA_APPEARANCE__={}"));
  assert.ok(!/<\/script>\s*alert/.test(html), "embedded text can't close the script tag");
});
