// Which AI this computer can run the agents on: Claude Code and/or GitHub Copilot, signed in or not, and the plan.
// Nothing here sends a prompt:
//   - Claude:  `claude auth status --json` (signed in, and the plan, e.g. "pro");
//   - Copilot: ~/.copilot/config.json (signed in), and `gh api copilot_internal/user` for the plan and what's left
//              this month (an endpoint GitHub doesn't document, so it's best effort).
// Only the fields below leave this module: never an email address, a login, an organization or a token.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { findOnPath, nodeShimTarget } from "./runner.mjs";

export const PROVIDERS = ["anthropic", "copilot-sdk"];
export const PROVIDER_LABEL = { anthropic: "Claude Code", "copilot-sdk": "GitHub Copilot" };
/** Copilot model ids offered in the pickers; any other id can be typed. Copilot checks it when a step starts. */
export const COPILOT_MODELS = ["gpt-4.1", "gpt-5", "gpt-5-mini", "claude-sonnet-4.5", "claude-haiku-4.5", "gemini-2.5-pro"];

const TIMEOUT = 15_000;

/** Runs a CLI with fixed arguments and no shell; a Windows npm shim runs through node. Resolves { code, stdout }. */
function run(file, args, env) {
  return new Promise((resolve) => {
    const shim = nodeShimTarget(file);
    let cmd = file, argv = args, opts = { timeout: TIMEOUT, windowsHide: true, env: env ?? process.env, maxBuffer: 4 * 1024 * 1024 };
    if (shim) [cmd, argv] = [process.execPath, [shim, ...args]];
    else if (process.platform === "win32" && /\.(cmd|bat)$/i.test(file)) {
      // Node won't run a .cmd without a shell; these arguments are fixed words, so quoting them for cmd.exe is safe.
      cmd = process.env.ComSpec || "cmd.exe";
      argv = ["/d", "/s", "/c", `"${[file, ...args].map((a) => `"${a}"`).join(" ")}"`];
      opts = { ...opts, windowsVerbatimArguments: true };
    }
    try {
      execFile(cmd, argv, opts, (err, stdout) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout ?? ""), error: err && !stdout ? err : undefined });
      });
    } catch (err) {
      resolve({ code: 1, stdout: "", error: err });
    }
  });
}

const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1);

async function claudeStatus() {
  const st = { provider: "anthropic", label: PROVIDER_LABEL.anthropic, installed: false, signedIn: false, problems: [] };
  const bin = findOnPath("claude");
  if (!bin) return { ...st, fix: "Install Claude Code (claude.com/claude-code), then sign in with `claude auth login`." };
  st.installed = true;
  const r = await run(bin, ["auth", "status", "--json"]);
  let j;
  try { j = JSON.parse(r.stdout); } catch {}
  if (!j) return { ...st, problems: ["`claude auth status` didn't answer."], fix: "Run `claude auth status` to see why, then Check again." };
  st.signedIn = j.loggedIn === true;
  if (!st.signedIn) return { ...st, fix: "Sign in: run `claude auth login`, then Check again." };
  const sub = String(j.subscriptionType ?? j.planTier ?? "").toLowerCase();
  st.plan = sub ? `Claude ${titleCase(sub)}` : j.authMethod === "claude.ai" ? "Claude" : "Anthropic API";
  st.via = j.authMethod === "claude.ai" ? "claude.ai account" : j.apiProvider && j.apiProvider !== "firstParty" ? String(j.apiProvider) : "API key";
  return st;
}

/** ~/.copilot/config.json, which has // comment lines. */
function copilotConfig() {
  try {
    const text = fs.readFileSync(path.join(process.env.COPILOT_HOME || path.join(os.homedir(), ".copilot"), "config.json"), "utf-8");
    return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    return undefined;
  }
}

function copilotPlanLabel(sku, plan) {
  const s = `${sku ?? ""} ${plan ?? ""}`.toLowerCase();
  if (/free/.test(s)) return "Copilot Free";
  if (/pro_?plus|pro\+|proplus/.test(s)) return "Copilot Pro+";
  if (/enterprise/.test(s)) return "Copilot Enterprise";
  if (/business/.test(s)) return "Copilot Business";
  if (/pro|individual|monthly|yearly/.test(s)) return "Copilot Pro";
  return "GitHub Copilot";
}

async function copilotStatus() {
  const st = { provider: "copilot-sdk", label: PROVIDER_LABEL["copilot-sdk"], installed: false, signedIn: false, problems: [] };
  const bin = findOnPath("copilot");
  if (!bin) return { ...st, fix: "Install the GitHub Copilot CLI: `npm install -g @github/copilot`, then run `copilot login`." };
  st.installed = true;
  const users = copilotConfig()?.loggedInUsers;
  st.signedIn = Array.isArray(users) && users.length > 0;
  if (!st.signedIn) return { ...st, fix: "Sign in: run `copilot login`, then Check again." };
  st.plan = "GitHub Copilot";
  // On Windows the Copilot CLI runs shell commands with PowerShell 7; without it an agent can't run playwright-cli.
  if (process.platform === "win32" && !findOnPath("pwsh")) {
    st.problems.push("On Windows, Copilot runs shell commands with PowerShell 7 (pwsh), which isn't installed. Install it: winget install Microsoft.PowerShell");
  }
  const gh = findOnPath("gh");
  if (!gh) return st;
  const r = await run(gh, ["api", "copilot_internal/user"]);
  let j;
  try { j = JSON.parse(r.stdout); } catch {}
  if (!j || typeof j !== "object") return st;
  st.plan = copilotPlanLabel(j.access_type_sku, j.copilot_plan);
  if (j.cli_enabled === false) st.problems.push("The Copilot CLI is turned off for this account or its organization.");
  const q = j.quota_snapshots ?? {};
  const left = (k) => (q[k] && !q[k].unlimited && Number.isFinite(Number(q[k].remaining)) ? Number(q[k].remaining) : undefined);
  st.quota = {
    chat: q.chat?.unlimited ? "unlimited" : left("chat"),
    premium: q.premium_interactions?.unlimited ? "unlimited" : left("premium_interactions"),
    resets: typeof j.quota_reset_date === "string" ? j.quota_reset_date : undefined,
  };
  if (st.quota.chat === 0 && !st.quota.premium) st.problems.push("No Copilot requests are left this month.");
  return st;
}

let cache = null;
/** Both providers' status, checked at most once a minute unless fresh is asked for. */
export async function aiStatus({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < 60_000) return cache.value;
  const [claude, copilot] = await Promise.all([claudeStatus(), copilotStatus()]);
  const value = { checkedAt: new Date().toISOString(), anthropic: claude, "copilot-sdk": copilot };
  cache = { at: Date.now(), value };
  return value;
}

/** The last status without waiting (for the page's state): refreshed in the background when it's over a minute old. */
export function cachedStatus() {
  if (!cache || Date.now() - cache.at > 60_000) aiStatus().catch(() => {});
  return cache?.value;
}

/** The page's one-line summary of the AI the steps run on: { provider, label, plan, ready, why, quota }. */
export function aiSummary(status, saved) {
  if (!status) return null;
  const provider = chosenProvider(status, saved);
  const s = status[provider];
  const why = notReady(status, provider);
  return { provider, label: s.label, plan: s.plan, ready: !why, why, quota: s.quota };
}

/** Whether a provider can run steps now: "" when ready, else what to do (for a 409 and the start form). */
export function notReady(status, provider) {
  const s = status?.[provider];
  if (!s) return "Unknown AI provider.";
  if (!s.installed || !s.signedIn) return `${s.label} isn't ${s.installed ? "signed in" : "installed"}. ${s.fix ?? ""}`.trim();
  const blocking = s.problems.filter((p) => /turned off|No Copilot requests|PowerShell 7/.test(p));
  if (blocking.length) return `${s.label} can't run the agents yet: ${blocking.join(" ")}`;
  return "";
}

/** The provider the steps run on: the saved pick when it's ready, else the first one ready (Claude first). */
export function chosenProvider(status, saved) {
  if (PROVIDERS.includes(saved) && !notReady(status, saved)) return saved;
  return PROVIDERS.find((p) => !notReady(status, p)) ?? (PROVIDERS.includes(saved) ? saved : "anthropic");
}

export { run as runCli };
