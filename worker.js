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
// 5. Copy the worker's URL (looks like https://generator-fleet-proxy.<you>.workers.dev)
// 6. Give that URL + the SHARED_SECRET you chose back to Claude to wire into index.html

const OWNER = "Geoffrey-Fitzjarrell-ai";
const REPO  = "generator_servicing";

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

async function ghPut(path, token, contentObj, sha, message) {
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
  if (!r.ok) throw new Error("GitHub PUT " + path + " failed: " + r.status + " " + (await r.text()));
  return r.json();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

    if (request.headers.get("X-Auth-Key") !== env.SHARED_SECRET) {
      return json({ error: "Unauthorized" }, 401);
    }

    let payload;
    try { payload = await request.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }

    const { action } = payload;

    try {
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
        const { truck, technician, hours, tasks } = payload;
        if (!truck || !Array.isArray(tasks) || tasks.length === 0) {
          return json({ error: "Missing truck or tasks" }, 400);
        }

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
          notes: [],
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
        let existing = [], sha = null;
        try {
          const file = await ghGet("pending_completions.json", env.GITHUB_PAT);
          sha = file.sha;
          existing = JSON.parse(decodeURIComponent(escape(atob(file.content))));
        } catch (e) { /* file may not exist yet */ }
        existing.push(entry);
        await ghPut("pending_completions.json", env.GITHUB_PAT, existing, sha, "Log: " + entry.truck);
        return json({ ok: true });
      }

      return json({ error: "Unknown action" }, 400);
    } catch (e) {
      return json({ error: String(e) }, 502);
    }
  },
};
