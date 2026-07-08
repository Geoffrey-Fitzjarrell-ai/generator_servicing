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
  { key:"airfilter_battery", name:"Air filter & battery check", interval:50  },
  { key:"oil_filter",        name:"Oil / filter change",        interval:150 },
  { key:"airfilter_clean",   name:"Air filter cleaning",         interval:250 },
  { key:"coolant_lines",     name:"Check coolant lines",         interval:250 },
  { key:"fuel_filter",       name:"Fuel filter change",          interval:250 },
  { key:"drive_belt",        name:"Check drive belt & tension",  interval:500 },
  { key:"clean_radiator",    name:"Clean radiator",              interval:500 },
  { key:"airfilter_500",     name:"Change air filter",           interval:500 },
];
function tasksForTruck(id) {
  return TASKS.filter(t => t.key !== "airfilter_clean" || id === "HD5");
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

// Fires the "task(s) completed" confirmation the moment a completion is
// logged from the dashboard, instead of waiting for the 3-hourly cron sweep
// to pick it up out of pending_completions.json. Requires a SLACK_TOKEN
// secret on this Worker (Settings -> Variables and Secrets) — the same
// bot token used by the GitHub Actions workflow's SLACK_TOKEN repo secret.
function buildCompletionText(userId, truck, tasks, notes) {
  const taskList = (tasks || []).map(t => "• " + t).join("\n");
  const mention = userId ? `<@${userId}> さん、` : "";
  const noteLine = (notes && notes.length) ? `📝 メモ: ${notes.join(" / ")}\n` : "";
  return `げんきくんです！${mention}*${truck}* で以下の作業が完了したことを確認しました🔧✨\n`
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

async function handleSlackMessageEvent(event, env) {
  if (!event || event.type !== "message" || event.subtype || event.bot_id) return;
  const m = HOURS_PATTERN.exec(event.text || "");
  if (!m) return;
  const truck = m[1].toUpperCase();
  const hours = Math.round(parseFloat(m[2]));

  const file = await ghGet("data.json", env.GITHUB_PAT);
  const data = JSON.parse(decodeURIComponent(escape(atob(file.content))));
  const stored = (data[truck] && data[truck].hours) || 0;
  if (hours <= stored) return; // only ever move forward, same rule as the polling job

  if (!data[truck]) {
    data[truck] = { hours: null, intervalStart: 0, overdue: false, technician: "", lastUpdated: null, postedBy: null };
  }
  data[truck].hours = hours;
  data[truck].lastUpdated = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  data[truck].postedBy = { id: event.user || null, name: null };

  await ghPut("data.json", env.GITHUB_PAT, data, file.sha, `Real-time sync: ${truck} ${hours}h`);
}

// ---- Q&A: someone @-mentions the bot with a question in the channel ----

async function loadJson(path, token) {
  const file = await ghGet(path, token);
  return JSON.parse(decodeURIComponent(escape(atob(file.content))));
}

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

function fmtRem(rem) {
  return rem <= 0 ? `overdue by ${Math.abs(Math.round(rem))}h` : `due in ${Math.round(rem)}h`;
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
      const tail = t.rem <= 0 ? `over ${Math.abs(Math.round(t.rem))}h` : `${Math.round(t.rem)}h left`;
      return `${bar(ratio)} ${String(pct).padStart(3)}%  ${t.name} — ${tail}`;
    }).join("\n");
    const fallback = `${truck} @ ${info.hours}h — next: ${list[0].name} (${fmtRem(list[0].rem)})`;
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
      `*${truck}* — ${info.hours}h. Most urgent: ${critical.name} (${fmtRem(critical.rem)}).`,
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
      `*${truck}* — ${info.hours}h${groundedNote}. Most urgent: ${critical.name} (${fmtRem(critical.rem)}).`,
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
      const tail = r.critical.rem <= 0 ? `over ${Math.abs(Math.round(r.critical.rem))}h` : `${Math.round(r.critical.rem)}h left`;
      return `${r.truck.padEnd(5)} ${bar(ratio)} ${String(pct).padStart(3)}%  ${r.critical.name} — ${tail}`;
    };
    if (!flagged.length) {
      return slackPostMessage(env, "Nothing overdue or due soon across the fleet 🎉", { channel, thread_ts });
    }
    const body = flagged.map(rowLine).join("\n");
    const nOver = flagged.filter(r => r.critical.rem <= 0).length;
    return slackPostMessage(env, `Fleet: ${nOver} overdue, ${flagged.length - nOver} due soon`, { channel, thread_ts, blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*Fleet — overdue & due soon (≤25h):*\n\`\`\`${body}\`\`\`` } },
      { type: "context", elements: [{ type: "mrkdwn", text: "▓ = interval elapsed ｜ <https://geoffrey-fitzjarrell-ai.github.io/generator_servicing/|📊 dashboard>" }] },
    ]});
  }

  return slackPostMessage(env, "すみません、わかりませんでした 🙏 Try `@げんきくん help` for things I can answer.", { channel, thread_ts });
}

export default {
  async fetch(request, env) {
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
        try {
          if (slackPayload.event && slackPayload.event.type === "app_mention") {
            await answerMention(slackPayload.event, env);
          } else {
            await handleSlackMessageEvent(slackPayload.event, env);
          }
        } catch (e) {
          console.error("Slack event processing failed", e);
        }
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
        } else {
          delete data[truck].grounded;
          delete data[truck].groundedNote;
        }
        await ghPut("data.json", env.GITHUB_PAT, data, file.sha, (grounded ? "Ground " : "Unground ") + truck);
        return json({ ok: true });
      }

      if (action === "logCompletion") {
        const { truck, technician, hours, tasks, notes } = payload;
        if (!truck || !Array.isArray(tasks) || tasks.length === 0) {
          return json({ error: "Missing truck or tasks" }, 400);
        }
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
        const userId = entry.postedBy && entry.postedBy.id;
        const text = buildCompletionText(userId, entry.truck, entry.tasks, entry.notes);
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

      return json({ error: "Unknown action" }, 400);
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  },
};
