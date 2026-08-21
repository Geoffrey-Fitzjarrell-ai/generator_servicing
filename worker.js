// Cloudflare Worker — secure proxy for the generator_servicing dashboard.
// Holds the GitHub PAT as a server-side secret; the public dashboard never sees it.
//
// SETUP:
// 1. Go to https://dash.cloudflare.com -> Workers & Pages -> Create -> Create Worker
// 2. Give it any name (e.g. "generator-fleet-proxy"), deploy the default template
// 3. Click "Edit code", delete everything, paste this whole file in, click "Deploy"
// 4. Go to Settings -> Variables and Secrets -> Add:
//      GITHUB_PAT     = your github_pat_... token   (encrypt it / mark as Secret)
//      SHARED_SECRET  = any random string you make up (e.g. a long password)
//      SLACK_TOKEN    = the bot's xoxb-... token (same one used by the GitHub
//                       Actions SLACK_TOKEN repo secret) — enables sending the
//                       "task(s) completed" Slack message immediately when
//                       logged, instead of waiting for the 3-hourly cron sweep
// 5. Copy the worker's URL (looks like https://generator-fleet-proxy.<you>.workers.dev)
// 6. Give that URL + the SHARED_SECRET you chose back to Claude to wire into index.html

const OWNER = "Geoffrey-Fitzjarrell-ai";
const REPO  = "generator_servicing";

// Mirrors the TASKS table in index.html — kept in sync manually since this
// Worker doesn't share a module with the dashboard. If you add/change a task
// there, update it here too or "next due" answers will drift.
const TASKS = [
  { key:"airfilter_battery", name:"Air filter / Battery check", interval:50,  type:"service" },
  { key:"battery_box",       name:"Battery Box check",         interval:50,  type:"service" },
  { key:"oil_filter",        name:"Oil / filter change",        interval:150, type:"replace" },
  { key:"spark_arrestor",        name:"Clean spark arrestor",        interval:150, type:"service" },
  { key:"airfilter_clean",   name:"Air filter cleaning",         interval:250, type:"service" },
  { key:"coolant_lines",     name:"Check coolant lines",         interval:250, type:"service" },
  { key:"fuel_filter",       name:"Fuel filter change",          interval:500, type:"replace" },
  { key:"drive_belt",        name:"Check drive belt & tension",  interval:500, type:"service" },
  { key:"clean_radiator",    name:"Clean radiator",              interval:500, type:"service" },
  { key:"airfilter_500",     name:"Change air filter",           interval:400, type:"replace" },
];
function tasksForTruck(id) {
  return TASKS.filter(t => t.key !== "airfilter_clean" || id === "HD5");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Auth-Key",
  "Content-Type": "application/json",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: CORS });
}

async function ghGet(path, token) {
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "User-Agent": "generator-fleet-proxy",
    },
  });
  if (!r.ok) throw new Error("GitHub GET " + path + " failed: " + r.status);
  return r.json();
}

async function ghPut(path, token, contentObj, sha, message, retriesLeft = 2) {
  const body = {
    message,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(contentObj, null, 2)))),
  };
  if (sha) body.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/vnd.github+json",
      "User-Agent": "generator-fleet-proxy",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (r.ok) return r.json();

  // 409 = sha conflict (someone else wrote this file since we fetched it).
  // Refetch, and re-run the caller's mutation against the fresh content rather
  // than failing outright — a stale sha here is exactly the kind of thing that
  // can silently drop a completion write while an unrelated pending-notification
  // write succeeds. If the caller didn't give us a way to redo the mutation,
  // we still retry the identical payload against the new sha as a best effort.
  if (r.status === 409 && retriesLeft > 0) {
    const fresh = await ghGet(path, token);
    return ghPut(path, token, contentObj, fresh.sha, message, retriesLeft - 1);
  }
  throw new Error("GitHub PUT " + path + " failed: " + r.status + " " + (await r.text()));
}

// Read-modify-write for the shared engineer work board. Unlike ghPut's blind
// 409 retry (which re-sends the stale content it was handed), this refetches
// and RE-APPLIES the mutation against fresh content, so two people editing
// different items at the same time don't clobber each other.
async function mutateWork(env, mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let file = null;
    try { file = await ghGet("engineer_work.json", env.GITHUB_PAT); } catch (e) { file = null; }
    const doc = file ? JSON.parse(decodeURIComponent(escape(atob(file.content)))) : { items: [] };
    if (!Array.isArray(doc.items)) doc.items = [];
    mutate(doc);
    doc._meta = Object.assign({}, doc._meta, { updated: new Date().toISOString().slice(0, 10) });
    try {
      await ghPut("engineer_work.json", env.GITHUB_PAT, doc, file ? file.sha : undefined, message, 0);
      return doc;
    } catch (e) {
      if (String(e).indexOf(" 409") !== -1 && attempt < 2) continue; // conflict → refetch + reapply
      throw e;
    }
  }
}

// Whitelist + length-cap an incoming work item so a bad client can't bloat the repo.
function cleanWorkItem(it) {
  const s = (v, n) => String(v == null ? "" : v).slice(0, n);
  const date = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? v : "";
  const time = (v) => /^\d{2}:\d{2}$/.test(String(v || "")) ? v : "";
  return {
    id: s(it.id, 40) || ("w_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)),
    title: s(it.title, 200),
    engineer: s(it.engineer, 80),
    asset: s(it.asset, 60),
    category: s(it.category, 24),
    status: s(it.status, 24),
    start: date(it.start),
    end: date(it.end),
    allDay: it.allDay !== false,
    startTime: time(it.startTime),
    endTime: time(it.endTime),
    notes: s(it.notes, 600),
    jiraKey: s(it.jiraKey, 40),
    jiraUrl: s(it.jiraUrl, 200),
  };
}

// Per-truck freeform memos (not tied to a service event). Same read-modify-write
// + 409-refetch pattern as the work board.
async function mutateNotes(env, mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let file = null;
    try { file = await ghGet("notes.json", env.GITHUB_PAT); } catch (e) { file = null; }
    const doc = file ? JSON.parse(decodeURIComponent(escape(atob(file.content)))) : { items: [] };
    if (!Array.isArray(doc.items)) doc.items = [];
    mutate(doc);
    doc._meta = Object.assign({}, doc._meta, { updated: new Date().toISOString().slice(0, 10) });
    try {
      await ghPut("notes.json", env.GITHUB_PAT, doc, file ? file.sha : undefined, message, 0);
      return doc;
    } catch (e) {
      if (String(e).indexOf(" 409") !== -1 && attempt < 2) continue;
      throw e;
    }
  }
}
// ── Change-request inbox persistence (change_requests.json) ──
// Same 409-refetch/last-write-wins pattern as notes. { items:[pending], resolved:[history] }
async function mutateRequests(env, mutate, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let file = null;
    try { file = await ghGet("change_requests.json", env.GITHUB_PAT); } catch (e) { file = null; }
    const doc = file ? JSON.parse(decodeURIComponent(escape(atob(file.content)))) : { items: [], resolved: [] };
    if (!Array.isArray(doc.items)) doc.items = [];
    if (!Array.isArray(doc.resolved)) doc.resolved = [];
    mutate(doc);
    doc._meta = Object.assign({}, doc._meta, { updated: new Date().toISOString().slice(0, 10) });
    try {
      await ghPut("change_requests.json", env.GITHUB_PAT, doc, file ? file.sha : undefined, message, 0);
      return doc;
    } catch (e) {
      if (String(e).indexOf(" 409") !== -1 && attempt < 2) continue;
      throw e;
    }
  }
}
function cleanNote(n) {
  const s = (v, k) => String(v == null ? "" : v).slice(0, k);
  return {
    id: s(n.id, 40) || ("n_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6)),
    truck: s(n.truck, 12),
    text: s(n.text, 1000),
    author: s(n.author, 80),
    ts: s(n.ts, 30) || new Date().toISOString(),
  };
}

// ── Edit / revert a logged service ───────────────────────────────────────────
// Reverting can't just delete: service_logs holds each task's "last done at Xh"
// (drives the gauges), so after removing/editing a history entry we roll every
// affected task back to the newest REMAINING history entry that still contains it.
function recomputeLast(histTruck, key) {
  let best = null;
  for (const e of (histTruck || [])) {
    if ((e.tasks || []).some(t => t.key === key)) best = best === null ? e.hours : Math.max(best, e.hours);
  }
  return best;
}
function findServiceEntry(arr, index, sig) {
  const keysOf = e => JSON.stringify((e.tasks || []).map(t => t.key).sort());
  const sigKeys = JSON.stringify((sig && sig.keys ? sig.keys.slice() : []).sort());
  const match = e => e && e.date === sig.date && Number(e.hours) === Number(sig.hours) && keysOf(e) === sigKeys;
  if (Number.isInteger(index) && index >= 0 && index < arr.length && match(arr[index])) return index;
  for (let i = 0; i < arr.length; i++) if (match(arr[i])) return i;
  return -1;
}
async function mutateServices(env, truck, keys, apply, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const hf = await ghGet("service_history.json", env.GITHUB_PAT);
    const lf = await ghGet("service_logs.json", env.GITHUB_PAT);
    const hist = JSON.parse(decodeURIComponent(escape(atob(hf.content))));
    const logs = JSON.parse(decodeURIComponent(escape(atob(lf.content))));
    apply(hist, logs);
    if (!logs[truck]) logs[truck] = {};
    for (const k of keys) {
      const v = recomputeLast(hist[truck], k);
      if (v === null) delete logs[truck][k]; else logs[truck][k] = v;
    }
    try {
      await ghPut("service_history.json", env.GITHUB_PAT, hist, hf.sha, message + " (history)");
      await ghPut("service_logs.json", env.GITHUB_PAT, logs, lf.sha, message + " (logs)");
      return { hist: hist[truck] || [], logs: logs[truck] || {} };
    } catch (e) {
      if (String(e).indexOf(" 409") !== -1 && attempt < 2) continue;
      throw e;
    }
  }
}

async function verifySlackSignature(request, rawBody, signingSecret) {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const signature = request.headers.get("X-Slack-Signature");
  if (!timestamp || !signature) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 60 * 5) return false; // reject replays older than 5 min
  const baseString = `v0:${timestamp}:${rawBody}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
  const computed = "v0=" + Array.from(new Uint8Array(sigBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
  return computed === signature;
}

const SLACK_CHANNEL = "C08L1TWLU14";

// Known field technicians who log completions on the dashboard. The
// dashboard's technician field is free text (index.html "Technician name"
// input), so this is a best-effort, exact-match (case-insensitive) lookup —
// deliberately NOT fuzzy. Root cause of the wrong-mention bug: the
// completion notifier used to mention `postedBy` (whoever last posted the
// truck's HOURS in Slack — a driver, often unrelated to who serviced it)
// instead of the technician who actually did the work, because the
// technician's name wasn't even being sent to this endpoint. An unmapped
// name now just prints as plain bold text (no @mention) rather than ever
// guessing at — and pinging — the wrong person.
const TECHNICIAN_SLACK_IDS = {
  "geoff fitzjarrell": "U07RU3LH24F",
  "masakiyo":           "U0BBE3JUHUY",
  "masakiyo kato":      "U0BBE3JUHUY",
  "jake albano":        "U0779MALYKY",
  "thapa biliv":        "U0AFM5Z1GUA",
  "reon zeniya":        "U0AV3PG35JM",
};

function technicianMention(name) {
  if (!name) return null;
  return TECHNICIAN_SLACK_IDS[name.trim().toLowerCase()] || null;
}

// Fires the "task(s) completed" confirmation the moment a completion is
// logged from the dashboard, instead of waiting for the 3-hourly cron sweep
// to pick it up out of pending_completions.json. Requires a SLACK_TOKEN
// secret on this Worker (Settings -> Variables and Secrets) — the same
// bot token used by the GitHub Actions workflow's SLACK_TOKEN repo secret.
function buildCompletionText(technicianName, truck, tasks, notes) {
  const taskList = (tasks || []).map(t => "• " + t).join("\n");
  const id = technicianMention(technicianName);
  const who = id ? `<@${id}> さん、` : (technicianName ? `*${technicianName}* さん、` : "");
  const noteLine = (notes && notes.length) ? `📝 メモ: ${notes.join(" / ")}\n` : "";
  return `げんきくんです！${who}*${truck}* で以下の作業が完了したことを確認しました🔧✨\n`
       + `${taskList}\n`
       + noteLine
       + `担当してくれた技術者さん、いつも素晴らしい仕事をありがとうございます、お疲れ様でした！`;
}

async function slackPostMessage(env, text, opts = {}) {
  if (!env.SLACK_TOKEN) return { ok: false, error: "no_slack_token_secret" };
  try {
    const body = { channel: opts.channel || SLACK_CHANNEL, text };
    if (opts.thread_ts) body.thread_ts = opts.thread_ts;
    if (opts.blocks) body.blocks = opts.blocks;
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.SLACK_TOKEN,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    return r.json();
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Unicode progress bar — renders identically in Slack's monospace code spans.
function bar(ratio, width = 10) {
  const filled = Math.min(width, Math.max(0, Math.round(Math.min(ratio, 1) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

const HOURS_PATTERN = /(HD\d+)\s+Generator hours:\s*(\d+(?:\.\d+)?)\s*h?/i;
const CORR_PATTERN  = /(HD\d+)\s*(?:correction|修正)\s*[:：]\s*(\d+(?:\.\d+)?)\s*h?/i;
const ADMIN_IDS     = ["U07RU3LH24F", "U07P40V9SKH"]; // Geoff, TakaY
const CHANNEL_JP    = "C08L1TWLU14";
const BUFFER_HOURS  = 2; // clock skew / rounding allowance, same as the cron
// Absolute backstop: no legitimate single reading grows by more than this,
// regardless of how long since the last post. Catches typos (11474 for 1474)
// and cross-truck posts even when lastUpdated is missing/unparseable/stale,
// where the elapsed-time check below can't run or has gone toothless.
const MAX_ABS_JUMP  = 48;

function b64json(file) {
  return JSON.parse(decodeURIComponent(escape(atob(file.content))));
}

async function slackUserName(env, userId) {
  if (!userId) return null;
  try {
    const r = await fetch("https://slack.com/api/users.info?user=" + encodeURIComponent(userId), {
      headers: { "Authorization": "Bearer " + env.SLACK_TOKEN },
    });
    const j = await r.json();
    if (j.ok) {
      const p = (j.user && j.user.profile) || {};
      return p.display_name || p.real_name || null;
    }
  } catch (e) { /* missing users:read scope etc. — name stays null */ }
  return null;
}

// Record a reply ts in bot_state.json so the 3-hourly cron never re-processes
// (or re-replies to) a message the Worker already handled. Refetch-and-merge
// on conflict instead of blind-retrying a stale payload — a cron ledger commit
// can land at any moment, and clobbering it would cause duplicate replies.
async function recordHandled(env, rts, verdict) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let state = { handled: {} };
      let sha;
      try {
        const f = await ghGet("bot_state.json", env.GITHUB_PAT);
        state = b64json(f);
        sha = f.sha;
      } catch (e) { /* first run — file may not exist yet */ }
      if (!state.handled) state.handled = {};
      state.handled[rts] = verdict;
      const cutoff = Date.now() / 1000 - 48 * 3600; // prune like the cron does
      for (const k of Object.keys(state.handled)) {
        if (parseFloat(k) < cutoff) delete state.handled[k];
      }
      await ghPut("bot_state.json", env.GITHUB_PAT, state, sha,
                  `chore: bot reply ledger (worker) ${verdict} ${rts}`, 0);
      return true;
    } catch (e) { /* 409 or transient — loop refetches fresh state */ }
  }
  console.error("recordHandled failed for", rts, "— cron backstop will handle the reply");
  return false;
}

// Write validated hours to data.json. Refetches and re-applies on conflict so a
// concurrent write to another truck is never clobbered. `force` bypasses the
// only-move-forward floor (admin corrections).
async function writeHours(env, truck, hours, userId, userName, commitMsg, force) {
  // Never ingest or resurrect a decommissioned truck, regardless of caller
  // (real-time, confirm, admin correction). Single choke point for all writers.
  if (DECOMMISSIONED.has(truck)) return { wrote: false, prev: null, decommissioned: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await ghGet("data.json", env.GITHUB_PAT);
    const data = b64json(file);
    const prev = (data[truck] && data[truck].hours);
    if (!force && hours <= (prev || 0)) return { wrote: false, prev };
    if (!data[truck]) {
      data[truck] = { hours: null, intervalStart: 0, overdue: false,
                      technician: "", lastUpdated: null, postedBy: null };
    }
    data[truck].hours = hours;
    data[truck].lastUpdated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    data[truck].postedBy = { id: userId || null, name: userName || null };
    try {
      await ghPut("data.json", env.GITHUB_PAT, data, file.sha, commitMsg, 0);
      return { wrote: true, prev };
    } catch (e) { /* 409 — refetch and re-apply */ }
  }
  throw new Error("data.json write failed after retries");
}

// Mirror the cron's daily-runtime bookkeeping (dashboard bar chart + the
// trailing averages behind predicted due dates). Same schema and UTC-date
// convention; refetch-merge on conflict.
//
// A generator physically cannot log more than 24h in one calendar day, so every
// per-day value is clamped to 24 at the point of assignment. Any value that would
// exceed 24 is a writer artifact (a duplicate/typo reading, or a same-day
// accumulation piling on top of a gap-spread), not real runtime — clamping stops
// the nightly consistency check from ever catching a self-inflicted >24h day.
// daily_hours is a display/plausibility series only; data.json cumulative stays
// authoritative and untouched.
async function bumpDailyHours(env, truck, delta) {
  if (!delta || delta <= 0) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let daily = {};
      let sha;
      try {
        const f = await ghGet("daily_hours.json", env.GITHUB_PAT);
        daily = b64json(f);
        sha = f.sha;
      } catch (e) { /* file may not exist yet */ }
      const today = new Date().toISOString().slice(0, 10);
      if (!daily[truck]) daily[truck] = [];
      const entries = daily[truck];
      const last = entries.length ? entries[entries.length - 1].date : null;
      const gapDays = last ? Math.round((Date.parse(today) - Date.parse(last)) / 86400000) : 0;
      if (entries.length && last === today) {
        const summed = entries[entries.length - 1].hours + delta;
        if (summed > 24) console.warn(`bumpDailyHours: ${truck} ${today} clamped ${summed.toFixed(1)}->24`);
        entries[entries.length - 1].hours = Math.round(Math.min(24, summed) * 10) / 10;
      } else if (gapDays > 1) {
        // Reading arrived after a multi-day gap: the delta accumulated over the
        // whole gap, not today. Spread it at the true daily average so no single
        // bar shows an impossible >24h day (HD15 2026-07-10 incident: +32h over a
        // 3-day gap was booked on one date and tripped the nightly check).
        const per = Math.min(24, delta / gapDays);
        const n = Math.min(gapDays, 14);            // window keeps 14 entries anyway
        const total = Math.round(per * n * 10) / 10;
        let acc = 0;
        for (let i = n - 1; i >= 0; i--) {
          const d = new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10);
          const raw = i === 0 ? (total - acc) : per;
          const h = Math.round(Math.min(24, raw) * 10) / 10;
          entries.push({ date: d, hours: h });
          acc = Math.round((acc + h) * 10) / 10;
        }
      } else {
        entries.push({ date: today, hours: Math.round(Math.min(24, delta) * 10) / 10 });
      }
      daily[truck] = entries.slice(-14);
      await ghPut("daily_hours.json", env.GITHUB_PAT, daily, sha,
                  `chore: track daily hours (worker) ${truck} +${delta}h`, 0);
      return;
    } catch (e) { /* 409 or transient — loop refetches */ }
  }
  console.error("bumpDailyHours failed for", truck, "+" + delta);
}

// HD5 (US truck) always gets English replies, everyone else stays in
// げんきくん's Japanese persona — the bot now serves two audiences in one
// channel-agnostic pipeline.
function isEnglishTruck(truck) {
  return truck === "HD5";
}

// Load/save the pending-confirmation ledger. Separate from `handled` because
// a pending entry isn't a verdict yet — it's a question waiting on a reply.
// Keyed by truck (only one truck needs this today) rather than by ts, since
// the lookup at confirm-time is "does HD5 have anything pending", not
// "does this specific reply resolve something".
async function loadPending(env) {
  try {
    const f = await ghGet("bot_state.json", env.GITHUB_PAT);
    const state = b64json(f);
    return { pending: state.pending || {}, sha: f.sha, state };
  } catch (e) {
    return { pending: {}, sha: undefined, state: { handled: {} } };
  }
}

async function savePending(env, truck, entry) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { state, sha } = await loadPending(env);
    if (!state.pending) state.pending = {};
    if (entry === null) delete state.pending[truck];
    else state.pending[truck] = entry;
    try {
      await ghPut("bot_state.json", env.GITHUB_PAT, state, sha,
                  `chore: pending confirmation ${entry ? "set" : "clear"} ${truck}`, 0);
      return true;
    } catch (e) { /* 409 — loop refetches */ }
  }
  console.error("savePending failed for", truck);
  return false;
}

let _botUserIdCache = null;
async function getBotUserId(env) {
  if (_botUserIdCache) return _botUserIdCache;
  try {
    const r = await fetch("https://slack.com/api/auth.test", {
      headers: { "Authorization": "Bearer " + env.SLACK_TOKEN },
    });
    const j = await r.json();
    if (j.ok) { _botUserIdCache = j.user_id; return j.user_id; }
  } catch (e) { /* fall through */ }
  return null;
}

const WELCOME_TEXT =
  "👋 Hi, I'm the generator hours tracking bot for the HD fleet.\n\n" +
  "*How to log hours:* post `HDXX Generator hours: NNNh` — e.g. `HD5 Generator hours: 1650h` " +
  "— and I'll record it and reply to confirm. A meter photo attached to the same message is fine.\n\n" +
  "*Corrections:* `HDXX correction: NNNh` (bypasses the normal checks — for fixing typos or a " +
  "meter reset).\n\n" +
  "*Ask me things* — mention me with:\n" +
  "• `HDXX hours` — current hours + status\n" +
  "• `HDXX next` — what's due next, most urgent first\n" +
  "• `overdue` / `fleet status` — what's overdue or due soon across the fleet\n\n" +
  "Dashboard: https://geoffrey-fitzjarrell-ai.github.io/generator_servicing/\n" +
  "Nothing else needs to be set up on your end — this posts automatically the moment I'm added " +
  "to a channel.";

// Fires once, automatically, the moment this bot is invited into any channel —
// so whichever channel ends up hosting HD5's posts, no one has to remember to
// ask for a how-to. member_joined_channel fires for every join, not just the
// bot's own, so this checks the joining user against the bot's own ID first.
async function handleMemberJoined(event, env) {
  const botId = await getBotUserId(env);
  if (!botId || event.user !== botId) return; // some other member joined — not our cue
  await slackPostMessage(env, WELCOME_TEXT, { channel: event.channel });
}

// Real-time ingest of "HDXX Generator hours: XXXXh" posts. Mirrors the cron's
// validation exactly (wrong-thread, below-floor, impossible-jump, admin
// auto-correction) and replies in-thread immediately, then ledgers the ts so
// the cron skips it. History: the first version of this handler wrote
// data.json with no reply and no ledger entry, which made the cron's
// "value already on record" dedupe swallow every ack (and let bad readings
// sync live unvalidated) — the 2026-07-08/09 missing-confirmation bug.
async function handleSlackMessageEvent(event, env) {
  if (!event || event.type !== "message" || event.bot_id) return;
  // Drivers usually attach a meter photo, which gives the message
  // subtype "file_share" — that's a real post, not noise. Every other
  // subtype (message_changed, message_deleted, channel_join, ...) is
  // skipped. This filter is why the Worker missed HD9's and HD8's
  // photo-attached posts on 2026-07-09 while catching the plain ones.
  if (event.subtype && event.subtype !== "file_share") return;
  const text    = (event.text || "").trim();
  const channel = event.channel;
  const userId  = event.user || null;
  const isAdmin = ADMIN_IDS.includes(userId);

  // ── Confirmation replies for a pending HD5 (long-gap) reading ──
  // Only checked on threaded replies that aren't themselves a fresh hours
  // post — a plain "confirm" from the original poster or an admin, in the
  // same thread the prompt was posted in, finalizes the pending value.
  if (event.thread_ts && !HOURS_PATTERN.test(text) && /^(confirm|yes|correct|OK)\b/i.test(text)) {
    const { pending } = await loadPending(env);
    const p = pending["HD5"];
    if (p && p.thread_ts === event.thread_ts && (userId === p.user_id || isAdmin)) {
      const name = await slackUserName(env, userId);
      const res = await writeHours(env, "HD5", p.hours, p.user_id, name,
                                   `Real-time sync (confirmed after long gap): HD5 ${p.hours}h`, true);
      await bumpDailyHours(env, "HD5", Math.max(0, p.hours - (p.prev || 0)));
      await slackPostMessage(env,
        `✅ HD5 confirmed at ${p.hours}h — recorded. Thanks!`,
        { channel, thread_ts: event.thread_ts });
      await recordHandled(env, event.ts, "confirmed");
      await savePending(env, "HD5", null);
      return;
    }
    // Not a match for any pending HD5 confirmation — fall through; it's
    // just an ordinary message that happens to start with "confirm".
  }

  // Corrections stay cron-only: exactly one code path may move hours backwards.
  if (CORR_PATTERN.test(text)) return;

  const m = HOURS_PATTERN.exec(text);
  if (!m) return;
  const truck   = m[1].toUpperCase();
  const hours   = Math.round(parseFloat(m[2]));
  const rts     = event.ts;
  const thread  = event.thread_ts || event.ts;
  const en      = isEnglishTruck(truck);
  const mention = userId ? (en ? `<@${userId}> ` : `<@${userId}> さん、`) : "";

  // Decommissioned trucks (e.g. HD18): don't ingest or resurrect in data.json.
  // Mirrors the cron + @mention guards, which this live path was missing —
  // that gap let HD18 back into data.json on 2026-08-06.
  if (DECOMMISSIONED.has(truck)) {
    await slackPostMessage(env,
      en ? `*${truck}* has been decommissioned and is no longer tracked.`
         : `*${truck}* は退役済みのため、現在は追跡していません。`,
      { channel, thread_ts: thread });
    await recordHandled(env, rts, "ignored_decommissioned");
    return;
  }

  const rejectHint = (t) => en
    ? `\nIf ${t}'s value needs correcting, post "${t} correction: <correct value>h".`
    : `\n※値の修正が必要な場合は「${t} 修正: 正しい値h」の形式で投稿してください。`;

  async function reject(reason_en, reason_jp) {
    const msg = en
      ? `Hi ${mention}I checked *${truck}*'s hours post but couldn't record it 🙅\n${reason_en}\n` +
        `Please double-check the value and re-post.`
      : `げんきくんです！${mention}*${truck}* の稼働時間の投稿を確認しましたが、` +
        `反映できませんでした🙅\n${reason_jp}\n` +
        `お手数ですが、正しい値をご確認の上、再投稿をお願いします🙏`;
    await slackPostMessage(env, msg, { channel, thread_ts: thread });
    await recordHandled(env, rts, "rejected");
  }

  // ── Wrong-thread check: hours for HDXX posted inside HDYY's thread ──
  if (event.thread_ts && event.thread_ts !== event.ts) {
    try {
      const r = await fetch("https://slack.com/api/conversations.replies?" +
        new URLSearchParams({ channel, ts: event.thread_ts, limit: "1" }), {
        headers: { "Authorization": "Bearer " + env.SLACK_TOKEN },
      });
      const j = await r.json();
      const parentText = (j.ok && j.messages && j.messages[0] && j.messages[0].text) || "";
      const tm = parentText.match(/HD\d+/i);
      if (tm && tm[0].toUpperCase() !== truck) {
        const expected = tm[0].toUpperCase();
        await reject(
          `This post is in *${expected}*'s thread, but the hours are for *${truck}*. ` +
          `Possibly the wrong truck name was typed.`,
          `この投稿は *${expected}* のスレッド内にありますが、` +
          `内容は *${truck}* の稼働時間になっています。` +
          `トラック名の入力間違いの可能性があります。`);
        return;
      }
    } catch (e) { /* can't fetch parent — fall through, cron backstops this check */ }
  }

  // ── Load current record for floor / jump validation ──
  let stored = null, lastDtMs = NaN;
  try {
    const data = b64json(await ghGet("data.json", env.GITHUB_PAT));
    const entry = data[truck] || {};
    stored = (entry.hours != null) ? entry.hours : null;
    lastDtMs = Date.parse(entry.lastUpdated || "");
  } catch (e) { /* unreadable — treat as no record; cron will reconcile */ }

  if (stored !== null && hours === stored) {
    // True duplicate (Worker can't have written it yet — we haven't). Silent.
    await recordHandled(env, rts, "accepted");
    return;
  }

  const adminCorrect = async () => {
    const name = await slackUserName(env, userId);
    const res = await writeHours(env, truck, hours, userId, name,
                                 `Real-time sync (admin correction): ${truck} ${hours}h`, true);
    const msg = en
      ? `Corrected *${truck}*'s hours 🔧\n${res.prev != null ? res.prev : "—"}h → *${hours}h*\nThanks for the update!`
      : `げんきくんです！*${truck}* の稼働時間を修正しました🔧\n` +
        `${res.prev != null ? res.prev : "—"}h → *${hours}h*\nご報告ありがとうございます！`;
    await slackPostMessage(env, msg, { channel, thread_ts: thread });
    await recordHandled(env, rts, "corrected");
  };

  if (stored !== null && hours < stored) {
    if (isAdmin) return adminCorrect(); // same auto-correct path the cron gives admins
    await reject(
      `Posted: ${hours}h / On record: ${stored}h\nThe posted value is lower than what's on record — ` +
      `could be a stale reading or the wrong truck.`,
      `投稿値: ${hours}h ／ 現在の記録値: ${stored}h\n` +
      `記録されている値より低いため、古い読み取りやトラック名の` +
      `入力間違いの可能性があります。`
    );
    return;
  }

  // ── Absolute jump ceiling (runs even if lastUpdated is missing/stale) ──
  // HD5 (en) is exempt: long transit gaps make big-but-real jumps routine, so
  // it falls through to the confirm-prompt in the elapsed check below instead.
  if (stored !== null && !en && (hours - stored) > MAX_ABS_JUMP) {
    if (isAdmin) return adminCorrect();
    const delta = hours - stored;
    await reject(
      `Posted: ${hours}h / on record: ${stored}h (+${delta}h). That's a larger jump ` +
      `than a generator can accumulate between readings — likely a typo or the wrong truck.`,
      `投稿値: ${hours}h ／ 現在の記録値: ${stored}h（増加量: ${delta}h）\n` +
      `1回の読み取りとしては増加量が大きすぎます。入力間違い、または` +
      `別トラックの数値の可能性があります。`
    );
    return;
  }

  // Elapsed-time guard: HD5 (en) ONLY. JP trucks post readings in bursts, often
  // hours after the meter was physically read, so the gap between posts understates
  // real runtime and this check throws false rejections. JP trucks are already
  // protected by the monotonic floor + the MAX_ABS_JUMP ceiling above, which makes
  // this guard redundant and harmful for them — so skip it entirely.
  if (en && stored !== null && !isNaN(lastDtMs)) {
    const elapsedH = (Date.now() - lastDtMs) / 3600e3;
    const delta = hours - stored;
    if (delta > elapsedH + BUFFER_HOURS) {
      if (isAdmin) return adminCorrect();

      // HD5 gets leniency here specifically, not at the floor check: long
      // gaps between posts (different channel, different cadence, possible
      // transit downtime) make a big-but-plausible jump routine rather than
      // suspicious, so ask the poster to confirm instead of bouncing it.
      if (en) {
        await savePending(env, truck, {
          hours, user_id: userId, ts: rts, thread_ts: thread, prev: stored,
        });
        await slackPostMessage(env,
          `Hi ${mention}HD5 posted at ${hours}h — that's ${delta}h more than the last reading ` +
          `(${stored}h), over about ${elapsedH.toFixed(1)}h since the last post. It's been a ` +
          `while, so I just want to confirm before recording it.\n` +
          `Reply "confirm" in this thread to accept ${hours}h, or repost the correct value.`,
          { channel, thread_ts: thread });
        await recordHandled(env, rts, "pending_confirm");
        return;
      }

      await reject(
        null,
        `投稿値: ${hours}h ／ 現在の記録値: ${stored}h（増加量: ${delta}h）\n` +
        `前回の更新から経過した時間は約${elapsedH.toFixed(1)}時間のため、` +
        `増加量が経過時間を超えており、発電機の稼働時間としては` +
        `あり得ません。トラック名や数値の入力間違いの可能性があります。`
      );
      return;
    }
  }

  // ── Valid reading: write, ack, ledger ──
  const name = await slackUserName(env, userId);
  const res = await writeHours(env, truck, hours, userId, name,
                               `Real-time sync: ${truck} ${hours}h`, false);
  if (res.wrote) {
    await bumpDailyHours(env, truck, hours - (res.prev || 0));
    const msg = en
      ? `✅ *${truck}* ${hours}h — recorded. Thanks!`
      : `✅ *${truck}* ${hours}h、記録しました！ありがとうございます🙏`;
    await slackPostMessage(env, msg, { channel, thread_ts: thread });
    await recordHandled(env, rts, "accepted");
  }
  // res.wrote === false → a higher value landed between validation and write;
  // leave un-ledgered so the cron applies its own verdict on this reply.
}

// ---- Q&A: someone @-mentions the bot with a question in the channel ----

async function loadJson(path, token) {
  const file = await ghGet(path, token);
  return JSON.parse(decodeURIComponent(escape(atob(file.content))));
}

// Trucks pulled from the lineup. Ingest must never re-create these in data.json
// (both writeHours and the cron auto-create unknown truck_ids), and status/help
// queries about them get a short "no longer tracked" note instead of failing.
const DECOMMISSIONED = new Set(["HD18"]);

function extractTruckId(text) {
  const m = text.match(/hd\s?-?\s?(\d{1,2})/i);
  return m ? "HD" + m[1] : null;
}

function nextDueList(truck, hoursNow, logs) {
  const truckLogs = (logs && logs[truck]) || {};
  return tasksForTruck(truck).map(t => {
    const last = truckLogs[t.key];
    const dueAt = (last != null ? last : 0) + t.interval;
    const rem = dueAt - hoursNow;
    return { ...t, last: last != null ? last : null, dueAt, rem };
  }).sort((a, b) => a.rem - b.rem);
}

// Checks & cleanings never read as "overdue" — only replacements (oil, fuel
// filter, air filter change) do. Mirrors the severity split in index.html.
function isReplace(task){ return task && task.type === "replace"; }
function fmtRem(rem, task) {
  if (rem > 0) return `due in ${Math.round(rem)}h`;
  return isReplace(task)
    ? `overdue by ${Math.abs(Math.round(rem))}h`
    : `check/clean due (${Math.abs(Math.round(rem))}h past)`;
}
// Short tail used in the monospace list rows.
function remTail(t) {
  if (t.rem > 0) return `${Math.round(t.rem)}h left`;
  return isReplace(t) ? `over ${Math.abs(Math.round(t.rem))}h` : `due ${Math.abs(Math.round(t.rem))}h`;
}

const HELP_TEXT =
  "げんきくんです！こんな質問に答えられます (You can ask me things like):\n" +
  "• `@げんきくん HD9 hours` — current hours + status\n" +
  "• `@げんきくん HD9 next` / `what's due on HD9` — upcoming tasks, most urgent first\n" +
  "• `@げんきくん overdue` / `fleet status` — which trucks are overdue or due soon\n" +
  "• `@げんきくん grounded` — which trucks are grounded and why\n" +
  "• `@げんきくん HD9 tickets` — open Jira tickets for a truck\n" +
  "Dashboard: https://geoffrey-fitzjarrell-ai.github.io/generator_servicing/";

async function answerMention(event, env) {
  const rawText = (event.text || "").replace(/<@[^>]+>\s*/g, "").trim();
  const text = rawText.toLowerCase();
  const channel = event.channel;
  const thread_ts = event.thread_ts || event.ts;
  const truck = extractTruckId(text);

  if (truck && DECOMMISSIONED.has(truck)) {
    // Removed from the lineup — don't ingest, don't resurrect in data.json.
    return slackPostMessage(env,
      `*${truck}* has been decommissioned and is no longer tracked.`,
      { channel, thread_ts });
  }

  if (!rawText || /help|使い方|what can you/.test(text)) {
    return slackPostMessage(env, HELP_TEXT, { channel, thread_ts });
  }

  const [data, logs] = await Promise.all([
    loadJson("data.json", env.GITHUB_PAT),
    loadJson("service_logs.json", env.GITHUB_PAT),
  ]);

  if (truck && /ticket|jira/.test(text)) {
    let tickets = {};
    try { tickets = await loadJson("tickets.json", env.GITHUB_PAT); } catch (e) { /* optional file */ }
    const list = tickets[truck] || [];
    const reply = list.length
      ? `*${truck}* open tickets:\n` + list.map(t => `• ${t.key} — ${t.summary} (${t.status})`).join("\n")
      : `No open tickets found for *${truck}*.`;
    return slackPostMessage(env, reply, { channel, thread_ts });
  }

  if (truck && /next|due|service|filter|oil|when|schedule/.test(text)) {
    const info = data[truck];
    if (!info || info.hours == null) {
      return slackPostMessage(env, `No hours on file for *${truck}* yet.`, { channel, thread_ts });
    }
    if (info.grounded) {
      return slackPostMessage(env, `*${truck}* is grounded (${info.groundedNote || "under repair"}) — maintenance schedule is paused.`, { channel, thread_ts });
    }
    const list = nextDueList(truck, info.hours, logs).slice(0, 4);
    const rows = list.map(t => {
      const ratio = (t.interval - t.rem) / t.interval;
      const pct = Math.min(Math.round(ratio * 100), 999);
      const tail = remTail(t);
      return `${bar(ratio)} ${String(pct).padStart(3)}%  ${t.name} — ${tail}`;
    }).join("\n");
    const fallback = `${truck} @ ${info.hours}h — next: ${list[0].name} (${fmtRem(list[0].rem, list[0])})`;
    return slackPostMessage(env, fallback, { channel, thread_ts, blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${truck}* @ *${info.hours}h* — upcoming maintenance:\n\`\`\`${rows}\`\`\`` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "▓ = interval elapsed ｜ <https://geoffrey-fitzjarrell-ai.github.io/generator_servicing/|📊 dashboard>" }] },
    ]});
  }

  if (truck && /hours|status|update/.test(text)) {
    const info = data[truck];
    if (!info || info.hours == null) {
      return slackPostMessage(env, `No hours on file for *${truck}* yet.`, { channel, thread_ts });
    }
    if (info.grounded) {
      return slackPostMessage(env, `*${truck}* — ${info.hours}h, grounded (${info.groundedNote || "under repair"}).`, { channel, thread_ts });
    }
    const critical = nextDueList(truck, info.hours, logs)[0];
    return slackPostMessage(env,
      `*${truck}* — ${info.hours}h. Most urgent: ${critical.name} (${fmtRem(critical.rem, critical)}).`,
      { channel, thread_ts });
  }

  if (truck) {
    // Truck mentioned but no recognized keyword — give the same status summary.
    const info = data[truck];
    if (!info || info.hours == null) {
      return slackPostMessage(env, `No hours on file for *${truck}* yet.`, { channel, thread_ts });
    }
    const critical = nextDueList(truck, info.hours, logs)[0];
    const groundedNote = info.grounded ? ` — grounded (${info.groundedNote || "under repair"})` : "";
    return slackPostMessage(env,
      `*${truck}* — ${info.hours}h${groundedNote}. Most urgent: ${critical.name} (${fmtRem(critical.rem, critical)}).`,
      { channel, thread_ts });
  }

  if (/grounded|down|repair/.test(text)) {
    const grounded = Object.keys(data).filter(t => data[t] && data[t].grounded);
    const reply = grounded.length
      ? "Grounded:\n" + grounded.map(t => `• ${t} — ${data[t].groundedNote || "under repair"}`).join("\n")
      : "No trucks are currently grounded.";
    return slackPostMessage(env, reply, { channel, thread_ts });
  }

  if (/overdue|due soon|fleet|status|summary/.test(text)) {
    const rows = Object.keys(data)
      .filter(t => data[t] && data[t].hours != null && !data[t].grounded)
      .map(t => ({ truck: t, hours: data[t].hours, critical: nextDueList(t, data[t].hours, logs)[0] }))
      .sort((a, b) => a.critical.rem - b.critical.rem);
    const flagged = rows.filter(r => r.critical.rem <= 25);
    const rowLine = r => {
      const ratio = (r.critical.interval - r.critical.rem) / r.critical.interval;
      const pct = Math.min(Math.round(ratio * 100), 999);
      const tail = remTail(r.critical);
      return `${r.truck.padEnd(5)} ${bar(ratio)} ${String(pct).padStart(3)}%  ${r.critical.name} — ${tail}`;
    };
    if (!flagged.length) {
      return slackPostMessage(env, "Nothing overdue or due soon across the fleet 🎉", { channel, thread_ts });
    }
    const body = flagged.map(rowLine).join("\n");
    const nOver = flagged.filter(r => r.critical.rem <= 0 && isReplace(r.critical)).length;
    const nCheck = flagged.filter(r => r.critical.rem <= 0 && !isReplace(r.critical)).length;
    const nSoon = flagged.length - nOver - nCheck;
    const summary = `Fleet: ${nOver} overdue` + (nCheck ? `, ${nCheck} check/clean due` : "") + `, ${nSoon} due soon`;
    return slackPostMessage(env, summary, { channel, thread_ts, blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Fleet — overdue & due soon (≤25h):*\n\`\`\`${body}\`\`\`` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "▓ = interval elapsed ｜ <https://geoffrey-fitzjarrell-ai.github.io/generator_servicing/|📊 dashboard>" }] },
    ]});
  }

  return slackPostMessage(env, "すみません、わかりませんでした 🙏 Try `@げんきくん help` for things I can answer.", { channel, thread_ts });
}

export default {
  async fetch(request, env, ctx) {
    // Drift check: GET /version returns the commit this Worker was built from,
    // injected at deploy time. Compare against the repo HEAD to confirm the
    // live Worker matches source. No auth — it exposes nothing sensitive.
    if (request.method === "GET" && new URL(request.url).pathname === "/version") {
      return json({ build: env.BUILD_SHA || "unknown", repo: `${OWNER}/${REPO}` });
    }
    // Real-time read of the shared engineer work board. Bypasses the raw CDN
    // (which lags ~5 min) by reading through the GitHub API with no-store, so
    // edits from one engineer show up on everyone else's board on next poll.
    if (request.method === "GET" && new URL(request.url).pathname === "/work") {
      let doc = { items: [] };
      try {
        const file = await ghGet("engineer_work.json", env.GITHUB_PAT);
        doc = JSON.parse(decodeURIComponent(escape(atob(file.content))));
      } catch (e) { /* file missing / transient — serve empty board */ }
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: Object.assign({}, CORS, { "Cache-Control": "no-store" }),
      });
    }
    // Real-time read of per-truck memos.
    if (request.method === "GET" && new URL(request.url).pathname === "/notes") {
      let doc = { items: [] };
      try {
        const file = await ghGet("notes.json", env.GITHUB_PAT);
        doc = JSON.parse(decodeURIComponent(escape(atob(file.content))));
      } catch (e) { /* file missing / transient — serve empty */ }
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: Object.assign({}, CORS, { "Cache-Control": "no-store" }),
      });
    }
    // Real-time read of the change-request inbox (fleet-admin approval queue).
    if (request.method === "GET" && new URL(request.url).pathname === "/requests") {
      let doc = { items: [], resolved: [] };
      try {
        const file = await ghGet("change_requests.json", env.GITHUB_PAT);
        doc = JSON.parse(decodeURIComponent(escape(atob(file.content))));
      } catch (e) { /* file missing / transient — serve empty inbox */ }
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: Object.assign({}, CORS, { "Cache-Control": "no-store" }),
      });
    }
    // ── iCalendar feed of the Engineers board (subscribe from Google Calendar) ──
    //   GET /calendar.ics                → every engineer's items
    //   GET /calendar.ics?engineer=Masakiyo  → just that person's items
    //   GET /calendar.ics?hide_done=1    → drop completed items
    if (request.method === "GET" && new URL(request.url).pathname === "/calendar.ics") {
      const q = new URL(request.url).searchParams;
      const who = (q.get("engineer") || "").trim().toLowerCase();
      const hideDone = q.get("hide_done") === "1";
      let items = [];
      try {
        const file = await ghGet("engineer_work.json", env.GITHUB_PAT);
        const doc = JSON.parse(decodeURIComponent(escape(atob(file.content))));
        items = Array.isArray(doc.items) ? doc.items : [];
      } catch (e) { /* transient — serve an empty but valid calendar */ }
      if (who) items = items.filter(i => String(i.engineer || "").toLowerCase().indexOf(who) >= 0);
      if (hideDone) items = items.filter(i => i.status !== "done");

      const esc = s => String(s == null ? "" : s)
        .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
      const compact = d => String(d).replace(/-/g, "");
      const plusDay = d => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10).replace(/-/g, ""); };
      const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
      const first = n => String(n || "").split(/[\s(]/)[0];
      const jst = (dateStr, hh, mm) => new Date(dateStr + "T" + String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0") + ":00+09:00")
        .toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

      const lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0",
        "PRODID:-//Applied Intuition//Japan VOPS Engineers//EN",
        "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
        "X-WR-CALNAME:" + esc("Japan VOPS — Engineers" + (who ? " (" + (items[0] ? first(items[0].engineer) : q.get("engineer")) + ")" : "")),
        "X-WR-TIMEZONE:Asia/Tokyo",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H",
      ];
      for (const i of items) {
        if (!i.start) continue;
        const end = i.end || i.start;
        const title = (who ? "" : "[" + first(i.engineer) + "] ") + (i.title || "Task") + (i.asset ? " — " + i.asset : "");
        const descParts = [];
        if (i.engineer) descParts.push("Engineer: " + i.engineer);
        if (i.status) descParts.push("Status: " + i.status);
        if (i.category) descParts.push("Category: " + i.category);
        if (i.notes) descParts.push("\n" + i.notes);
        if (i.jiraUrl) descParts.push("\n" + i.jiraUrl);
        // allDay checkbox off → a timed block on the day(s) it's attached to,
        // using the task's own start/end time when set, else an 08:00–18:00 JST
        // default. allDay on → all-day event.
        const st = /^\d{2}:\d{2}$/.test(i.startTime || "") ? i.startTime : "08:00";
        const et = /^\d{2}:\d{2}$/.test(i.endTime || "") ? i.endTime : "18:00";
        const timeLines = (i.allDay === false)
          ? ["DTSTART:" + jst(i.start, +st.slice(0, 2), +st.slice(3, 5)),
             "DTEND:" + jst(end, +et.slice(0, 2), +et.slice(3, 5))]
          : ["DTSTART;VALUE=DATE:" + compact(i.start), "DTEND;VALUE=DATE:" + plusDay(end)];
        lines.push(
          "BEGIN:VEVENT",
          "UID:" + esc(i.id || (i.title + "-" + i.start)) + "@generator-fleet",
          "DTSTAMP:" + stamp,
          timeLines[0], timeLines[1],
          "SUMMARY:" + esc(title),
          "DESCRIPTION:" + esc(descParts.join("\n")),
          "CATEGORIES:" + esc(i.engineer || ""),
          "STATUS:" + (i.status === "planned" ? "TENTATIVE" : "CONFIRMED"),
          "TRANSP:TRANSPARENT",
          "END:VEVENT"
        );
      }
      lines.push("END:VCALENDAR");
      return new Response(lines.join("\r\n") + "\r\n", {
        status: 200,
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'inline; filename="japan-vops-engineers.ics"',
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=900",
        },
      });
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const rawBody = await request.text();

    // Slack Events API — identified by Slack's signature header, verified via HMAC
    // instead of the dashboard's shared-secret scheme.
    if (request.headers.has("X-Slack-Signature")) {
      const valid = await verifySlackSignature(request, rawBody, env.SLACK_SIGNING_SECRET);
      if (!valid) return new Response("invalid signature", { status: 401 });

      let slackPayload;
      try { slackPayload = JSON.parse(rawBody); } catch (e) { return new Response("bad json", { status: 400 }); }

      if (slackPayload.type === "url_verification") {
        return new Response(slackPayload.challenge, { headers: { "Content-Type": "text/plain" } });
      }

      // Slack retries delivery if it doesn't get a 200 within ~3s. Our answers
      // involve a couple of GitHub reads plus a Slack post, so an occasional
      // retry is expected — without this guard a slow-but-successful first
      // attempt would get a duplicate reply posted on top of it.
      if (request.headers.get("X-Slack-Retry-Num")) {
        return new Response("ok", { status: 200 });
      }

      if (slackPayload.type === "event_callback") {
        const work = (async () => {
          try {
            const evtType = slackPayload.event && slackPayload.event.type;
            if (evtType === "app_mention") {
              await answerMention(slackPayload.event, env);
            } else if (evtType === "member_joined_channel") {
              await handleMemberJoined(slackPayload.event, env);
            } else {
              await handleSlackMessageEvent(slackPayload.event, env);
            }
          } catch (e) {
            console.error("Slack event processing failed", e);
          }
        })();
        // Ack Slack within its ~3s window and keep working in the background —
        // the validated ingest path (parent fetch + data + ledger + reply) can
        // exceed 3s, and a slow ack triggers duplicate retry deliveries.
        if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
      }

      return new Response("ok", { status: 200 }); // Slack just wants a fast 200
    }

    if (request.headers.get("X-Auth-Key") !== env.SHARED_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    let payload;
    try { payload = JSON.parse(rawBody); } catch (e) { return json({ error: "Bad JSON" }, 400); }

    const { action } = payload;

    try {
      // ── DAPS: teammate requests an official handshake assessment ──
      // Sends Geoff a DM with a Block Kit card + link button. Uses the same
      // bot token as everything else. Note: DMing a user via chat.postMessage
      // may require the im:write scope depending on workspace config — if
      // Slack returns channel_not_found / missing_scope, that's the fix.
      if (action === "dapRequest") {
        const GEOFF_UID = "U07RU3LH24F";
        const name = String(payload.name || "").slice(0, 60).trim();
        const msg  = String(payload.message || "").slice(0, 200).trim();
        if (!name) return json({ error: "Missing name" }, 400);
        const blocks = [
          { type: "header", text: { type: "plain_text", text: "🤝 DAP ASSESSMENT REQUEST", emoji: true } },
          { type: "section", text: { type: "mrkdwn",
            text: `*${name}* is formally requesting an official dap evaluation.` +
                  (msg ? `\n> _"${msg}"_` : "") } },
          { type: "context", elements: [{ type: "mrkdwn",
            text: "Five disciplines: GRIP 握力 · SNAP 音 · SYNC 呼吸 · STYLE 型 · CLUTCH 安定感 ｜ commissioner's decision is final" }] },
          { type: "actions", elements: [
            { type: "button",
              text: { type: "plain_text", text: "📋 Open DAPS Rankings", emoji: true },
              url: payload.dashboardUrl || "https://geoffrey-fitzjarrell-ai.github.io/generator_servicing/daps.html",
              style: "primary" },
          ]},
        ];
        const result = await slackPostMessage(env, `🤝 ${name} is requesting a dap assessment`, {
          channel: GEOFF_UID, blocks,
        });
        if (!result.ok) return json({ ok: false, slackError: result.error }, 502);
        return json({ ok: true });
      }

      if (action === "setGrounded") {
        const { truck, grounded, note } = payload;
        if (!truck) return json({ error: "Missing truck" }, 400);
        const file = await ghGet("data.json", env.GITHUB_PAT);
        const data = JSON.parse(decodeURIComponent(escape(atob(file.content))));
        if (!data[truck]) return json({ error: "Unknown truck " + truck }, 400);
        if (grounded) {
          data[truck].grounded = true;
          data[truck].groundedNote = note || "Under repair";
          data[truck].groundedSource = "manual";
        } else {
          delete data[truck].grounded;
          delete data[truck].groundedNote;
          delete data[truck].groundedSource;
        }
        await ghPut("data.json", env.GITHUB_PAT, data, file.sha, (grounded ? "Ground " : "Unground ") + truck);
        return json({ ok: true });
      }

      if (action === "logCompletion") {
        const { truck, technician, hours, tasks, notes, laborHours, travelHours, jobType } = payload;
        if (!truck || !Array.isArray(tasks) || tasks.length === 0) {
          return json({ error: "Missing truck or tasks" }, 400);
        }
        // Optional job-duration metrics (tablet prompt). Absent/invalid => null,
        // so older clients that don't send them keep working unchanged.
        const _dur = v => { const n = Number(v); return (Number.isFinite(n) && n >= 0 && n < 1000) ? n : null; };
        const _labor  = _dur(laborHours);
        const _travel = _dur(travelHours);
        const _jobType = jobType ? String(jobType).slice(0, 40) : null;
        // Notes are free text destined for a JSON file rendered in the UI —
        // cap length and count so a bad client can't bloat the repo.
        const noteList = (Array.isArray(notes) ? notes : [])
          .map(n => String(n).slice(0, 300)).filter(Boolean).slice(0, 5);

        // Update service_logs.json — bumps each task's "last done at" hour count.
        const logsFile = await ghGet("service_logs.json", env.GITHUB_PAT);
        const logs = JSON.parse(decodeURIComponent(escape(atob(logsFile.content))));
        if (!logs[truck]) logs[truck] = {};
        for (const t of tasks) logs[truck][t.key] = hours;
        await ghPut(
          "service_logs.json", env.GITHUB_PAT, logs, logsFile.sha,
          truck + ": log " + tasks.map(t => t.key).join(", ") + " at " + hours + "h"
        );

        // Append a dated record to service_history.json.
        const histFile = await ghGet("service_history.json", env.GITHUB_PAT);
        const hist = JSON.parse(decodeURIComponent(escape(atob(histFile.content))));
        if (!hist[truck]) hist[truck] = [];
        hist[truck].push({
          date: new Date().toISOString().slice(0, 10),
          hours,
          technician: technician || "",
          tasks: tasks.map(t => ({ key: t.key, label: t.label })),
          notes: noteList,
          laborHours: _labor,     // wrench time for this job (null = not captured)
          travelHours: _travel,   // round-trip travel to/from TRC (null = not captured)
          jobType: _jobType,      // optional free-form label
        });
        await ghPut(
          "service_history.json", env.GITHUB_PAT, hist, histFile.sha,
          truck + ": service history entry (" + (technician || "unattributed") + ")"
        );

        return json({ ok: true });
      }

      if (action === "logPending") {
        const { entry } = payload;
        if (!entry || !entry.truck) return json({ error: "Missing entry" }, 400);

        // Notify right now instead of waiting for the 3-hourly cron sweep.
        // If this fails (Slack hiccup, missing SLACK_TOKEN secret, etc.),
        // entry.notified stays false and the cron job's fallback path will
        // still send it within a few hours — same safety-net principle as
        // the log write itself.
        const text = buildCompletionText(entry.technician, entry.truck, entry.tasks, entry.notes);
        const slackResult = await slackPostMessage(env, text);
        entry.notified = !!slackResult.ok;
        if (!slackResult.ok) {
          console.error("Immediate Slack notify failed for " + entry.truck, slackResult);
        }

        let existing = [], sha = null;
        try {
          const file = await ghGet("pending_completions.json", env.GITHUB_PAT);
          sha = file.sha;
          existing = JSON.parse(decodeURIComponent(escape(atob(file.content))));
        } catch (e) { /* file may not exist yet */ }
        existing.push(entry);
        await ghPut("pending_completions.json", env.GITHUB_PAT, existing, sha, "Log: " + entry.truck);
        return json({ ok: true, notified: entry.notified });
      }

      // ── Shared engineer work board: upsert / delete / replace an item ──
      if (action === "logWork") {
        const op = payload.op || "upsert";
        let doc;
        if (op === "delete") {
          const id = String(payload.id || "");
          if (!id) return json({ error: "Missing id" }, 400);
          doc = await mutateWork(env, d => { d.items = d.items.filter(x => x.id !== id); },
            "Engineer work: delete " + id);
        } else if (op === "replace") {
          const arr = Array.isArray(payload.items) ? payload.items : null;
          if (!arr) return json({ error: "Missing items" }, 400);
          if (arr.length > 500) return json({ error: "Too many items (max 500)" }, 400);
          const cleaned = arr.map(cleanWorkItem).filter(x => x.title && x.start);
          doc = await mutateWork(env, d => { d.items = cleaned; },
            "Engineer work: replace (" + cleaned.length + " items)");
        } else if (op === "addEngineer") {
          const name = String(payload.name || "").trim().slice(0, 80);
          if (!name) return json({ error: "Missing name" }, 400);
          doc = await mutateWork(env, d => {
            if (!Array.isArray(d.engineers)) d.engineers = [];
            if (!d.engineers.some(n => String(n).toLowerCase() === name.toLowerCase())) d.engineers.push(name);
            if (d.engineers.length > 100) d.engineers = d.engineers.slice(0, 100);
          }, "Engineer roster: add " + name);
        } else {
          const it = cleanWorkItem(payload.item || {});
          if (!it.title || !it.start) return json({ error: "Missing title/start" }, 400);
          if (!it.end) it.end = it.start;
          doc = await mutateWork(env, d => { d.items = [...d.items.filter(x => x.id !== it.id), it]; },
            "Engineer work: upsert " + it.id);
        }
        return json({ ok: true, items: doc.items, engineers: doc.engineers || [] });
      }

      // ── Per-truck memos: upsert / delete ──
      // ── View-only change requests → in-app admin approval inbox ──
      // These are engineer-calendar asks (someone wants engineers to work on
      // something). They must NEVER post to #japan-vops-driver-support — that
      // channel is for generator-specific driver traffic only. They land in
      // change_requests.json and surface as a "Request inbound" inbox on the
      // Engineers tab, approved behind the fleet admin's master password.
      if (action === "requestChange") {
        const text = String(payload.text || "").slice(0, 800).trim();
        const who = String(payload.who || "someone").slice(0, 80);
        const ctx = String(payload.context || "").slice(0, 200);
        if (!text) return json({ error: "Missing text" }, 400);
        const item = {
          id: "cr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6),
          who, context: ctx, text, ts: new Date().toISOString(), status: "pending",
        };
        const doc = await mutateRequests(env, d => {
          d.items.push(item);
          if (d.items.length > 200) d.items = d.items.slice(-200);
        }, "Change request from " + who);
        return json({ ok: true, queued: true, pending: doc.items.length });
      }
      // Fleet admin approves/dismisses a queued request (gated client-side by the
      // master password, same trust model as every other mutation here).
      if (action === "resolveRequest") {
        const id = String(payload.id || "");
        const resolution = payload.resolution === "approve" ? "approve" : "dismiss";
        const by = String(payload.by || "admin").slice(0, 80);
        if (!id) return json({ error: "Missing id" }, 400);
        const doc = await mutateRequests(env, d => {
          const hit = d.items.find(x => x.id === id);
          d.items = d.items.filter(x => x.id !== id);
          if (hit) {
            if (!Array.isArray(d.resolved)) d.resolved = [];
            d.resolved.unshift(Object.assign({}, hit, { status: resolution, by, resolvedTs: new Date().toISOString() }));
            if (d.resolved.length > 50) d.resolved = d.resolved.slice(0, 50);
          }
        }, "Change request " + resolution + ": " + id + " by " + by);
        return json({ ok: true, items: doc.items });
      }

      if (action === "logNote") {
        const op = payload.op || "upsert";
        let doc;
        if (op === "delete") {
          const id = String(payload.id || "");
          if (!id) return json({ error: "Missing id" }, 400);
          doc = await mutateNotes(env, d => { d.items = d.items.filter(x => x.id !== id); },
            "Notes: delete " + id);
        } else {
          const n = cleanNote(payload.note || {});
          if (!n.text || !n.truck) return json({ error: "Missing truck/text" }, 400);
          doc = await mutateNotes(env, d => { d.items = [...d.items.filter(x => x.id !== n.id), n]; },
            "Notes: " + n.truck + " " + n.id);
        }
        return json({ ok: true, items: doc.items });
      }

      // ── Correct a single day's runtime in daily_hours.json ──
      // Self-service fix for a missed/implausible daily value — no hand-editing
      // JSON, no PAT on the client. Validates 0–24 (a generator can't run more
      // than 24h in a calendar day) and uses the same 409-refetch pattern as the
      // rest. The authoritative cumulative (data.json) is untouched; this only
      // fixes the per-day display/plausibility series the nightly check reads.
      // Payload: { action:"correctDaily", truck:"HD6", date:"2026-07-23", hours:18 }
      if (action === "correctDaily") {
        const truck = String(payload.truck || "").toUpperCase();
        const date  = String(payload.date || "");
        const hours = Number(payload.hours);
        if (!/^HD\d+$/.test(truck))            return json({ error: "Bad truck" }, 400);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ error: "Bad date (YYYY-MM-DD)" }, 400);
        if (!Number.isFinite(hours) || hours < 0 || hours > 24)
          return json({ error: "Hours must be between 0 and 24" }, 400);
        const rounded = Math.round(hours * 10) / 10;
        for (let attempt = 0; attempt < 3; attempt++) {
          let daily = {}, sha;
          try {
            const f = await ghGet("daily_hours.json", env.GITHUB_PAT);
            daily = b64json(f); sha = f.sha;
          } catch (e) { return json({ error: "daily_hours.json unreadable" }, 502); }
          const arr = daily[truck] || (daily[truck] = []);
          const row = arr.find(e => e.date === date);
          if (row) {
            row.hours = rounded;
          } else {
            arr.push({ date, hours: rounded });
            arr.sort((a, b) => (a.date < b.date ? -1 : 1));
          }
          try {
            await ghPut("daily_hours.json", env.GITHUB_PAT, daily, sha,
                        `fix: daily correction ${truck} ${date} -> ${rounded}h`, 0);
            return json({ ok: true, truck, date, hours: rounded });
          } catch (e) { /* 409 → refetch + reapply */ }
        }
        return json({ error: "write conflict after retries" }, 502);
      }

      // ── Edit / revert a logged service ──
      if (action === "revertService") {
        const { truck, index, sig } = payload;
        if (!truck || !sig) return json({ error: "Missing truck/sig" }, 400);
        const keys = Array.isArray(sig.keys) ? sig.keys : [];
        const res = await mutateServices(env, truck, keys, (hist) => {
          const arr = hist[truck] || [];
          const idx = findServiceEntry(arr, index, sig);
          let removed = null;
          if (idx >= 0) { removed = arr[idx]; arr.splice(idx, 1); }
          const labels = removed ? (removed.tasks || []).map(t => t.label || t.key).join(", ")
                                 : (Array.isArray(sig.keys) ? sig.keys.join(", ") : "");
          const d = (sig.date || (removed && removed.date) || "?");
          const h = (sig.hours != null ? sig.hours : (removed && removed.hours));
          arr.push({ audit: true, action: "reverted", date: new Date().toISOString().slice(0, 10),
            ts: new Date().toISOString(), hours: null, technician: "", tasks: [], notes: [],
            summary: "Reverted service \u2014 " + d + " \u00b7 " + (h != null ? h + "h" : "?") + " \u00b7 " + (labels || "(no tasks)") });
          hist[truck] = arr;
        }, truck + ": revert service " + (sig.date || "") + " " + (sig.hours || "") + "h");
        return json({ ok: true, hist: res.hist, logs: res.logs });
      }

      if (action === "editService") {
        const { truck, index, sig, entry } = payload;
        if (!truck || !entry) return json({ error: "Missing truck/entry" }, 400);
        const clean = {
          date: String(entry.date || "").slice(0, 10),
          hours: Number(entry.hours) || 0,
          technician: String(entry.technician || "").slice(0, 80),
          tasks: (Array.isArray(entry.tasks) ? entry.tasks : []).slice(0, 20)
            .map(t => ({ key: String(t.key || "").slice(0, 40), label: String(t.label || "").slice(0, 80) }))
            .filter(t => t.key),
          notes: (Array.isArray(entry.notes) ? entry.notes : []).map(n => String(n).slice(0, 300)).filter(Boolean).slice(0, 5),
        };
        const oldKeys = (sig && sig.keys) ? sig.keys : [];
        const newKeys = clean.tasks.map(t => t.key);
        const keys = Array.from(new Set([...oldKeys, ...newKeys]));
        const res = await mutateServices(env, truck, keys, (hist) => {
          const arr = hist[truck] || [];
          const idx = findServiceEntry(arr, index, sig);
          let old = null;
          if (idx >= 0) { old = arr[idx]; arr[idx] = clean; } else arr.push(clean);
          arr.push({ audit: true, action: "edited", date: new Date().toISOString().slice(0, 10),
            ts: new Date().toISOString(), hours: null, technician: "", tasks: [], notes: [],
            summary: "Edited service \u2014 now " + clean.date + " \u00b7 " + clean.hours + "h"
              + (old ? (" (was " + old.date + " \u00b7 " + old.hours + "h)") : "") });
          hist[truck] = arr;
        }, truck + ": edit service " + clean.date + " " + clean.hours + "h");
        return json({ ok: true, hist: res.hist, logs: res.logs });
      }

      return json({ error: "Unknown action" }, 400);
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  },
};
