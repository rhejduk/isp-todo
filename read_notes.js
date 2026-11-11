#!/usr/bin/env node
// Read-only: fetch and decrypt the priority + notes sync stores and print them
// per task. Never writes to textdb.online. See SYNC.md.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;

const ROOT = __dirname;
const SYNC_URL = process.env.TODO_SYNC_URL || "https://textdb.online";
const PWFILE = process.env.TODO_PAGE_PASSWORD_FILE || path.join(process.env.HOME, ".secrets/todo_page_password");
const PKEY = "isp-todo-priority";
const NKEY = "isp-todo-notes";
const PRIOS = ["Urgent", "High", "Medium", "Low"];
const asJson = process.argv.includes("--json");

function readPw() {
  // An explicit TODO_PAGE_PASSWORD_FILE wins so a throwaway test password is not
  // overridden by a live TODO_PAGE_PASSWORD in the environment.
  const file = process.env.TODO_PAGE_PASSWORD_FILE || (process.env.TODO_PAGE_PASSWORD ? null : PWFILE);
  if (file) {
    if (!fs.existsSync(file)) throw new Error("password file not found: " + file);
    const pw = fs.readFileSync(file, "utf8").replace(/\r?\n$/, "");
    if (!pw) throw new Error("empty password file");
    return pw;
  }
  if (process.env.TODO_PAGE_PASSWORD) return process.env.TODO_PAGE_PASSWORD.replace(/\r?\n$/, "");
  throw new Error("No TODO_PAGE_PASSWORD or password file");
}

function loadJson(f) {
  const p = path.join(ROOT, "data", f);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function add(map, id, tab, title) {
  if (!id) return;
  if (!map[id]) map[id] = { id, title: title || id, tabs: [] };
  if (title && (map[id].title === id || map[id].title === map[id].id)) map[id].title = title;
  if (tab && map[id].tabs.indexOf(tab) < 0) map[id].tabs.push(tab);
}

function catalog() {
  const map = {};
  const daily = loadJson("daily.json");
  if (daily && Array.isArray(daily.tasks)) {
    daily.tasks.forEach((t) => add(map, t.task_id, "Daily To Do", t.action));
  }
  const marketing = loadJson("marketing.json");
  if (marketing) {
    (marketing.projects || []).forEach((p) => {
      (p.tasks || []).forEach((t) => add(map, t.id, "Marketing Checklist", (p.name ? p.name + ": " : "") + (t.t || "")));
      (p.deliverables || []).forEach((d) => add(map, d.id, "Marketing Checklist", (p.name ? p.name + " (Stage 4): " : "") + (d.t || "")));
    });
    Object.values(marketing.people || {}).forEach((pv) => {
      (pv.items || []).forEach((x) => add(map, x.id, "Marketing Checklist", x.t || ""));
    });
  }
  const dave = loadJson("dave.json");
  if (dave && Array.isArray(dave.tasks)) {
    dave.tasks.forEach((t) => add(map, t.task_id, "Talk with Dave", t.action));
  }
  const brief = loadJson("daily_brief.json");
  if (brief) {
    (brief.entries || []).forEach((u) => {
      add(map, u.id, "Daily Brief", u.headline);
      (u.subs || []).forEach((s) => add(map, (s.ref && s.ref.id) || s.id, "Daily Brief", s.text || (s.ref && s.ref.id) || s.id));
    });
    (brief.days || []).forEach((day) => {
      (day.meetings || []).forEach((m) => {
        (m.todos || []).forEach((x) => add(map, (x.ref && x.ref.id) || x.id, "Daily Brief", x.text || ""));
        (m.owes || []).forEach((o) => (o.items || []).forEach((x) => add(map, (x.ref && x.ref.id) || x.id, "Daily Brief", (o.who ? o.who + ": " : "") + (x.text || ""))));
      });
    });
  }
  const shipping = loadJson("shipping.json");
  if (shipping) {
    (shipping.cards || []).forEach((c) => {
      (c.todos || []).forEach((t) => add(map, (t.ref && t.ref.id) || t.id, "Shipping", (c.title ? c.title + ": " : "") + (t.text || "")));
    });
  }
  const projects = loadJson("projects.json");
  if (projects) {
    (projects.cards || []).forEach((c) => {
      (c.todo_refs || []).forEach((r) => add(map, r.id, "Projects", r.id));
      (c.extra_todos || []).forEach((t) => add(map, t.id, "Projects", t.text || t.id));
      (c.todos || []).forEach((t) => add(map, t.id, "Projects", t.text || t.id));
    });
  }
  return map;
}

function b64d(s) { return Buffer.from(s, "base64"); }

function fmtEt(ts) {
  if (!ts || !Number.isFinite(+ts)) return "";
  const d = new Date(+ts);
  if (isNaN(d)) return "";
  return d.toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }) + " ET";
}

function noteText(v) {
  if (v == null) return "";
  if (typeof v === "object") return String(v.text || "");
  return String(v);
}
function noteAt(v, ts) {
  if (v && typeof v === "object" && v.at) return +v.at;
  return ts || 0;
}

(async () => {
  const pw = readPw();
  const hmac = (label) => crypto.createHmac("sha256", pw).update(label).digest();
  const id = "isptodo-" + hmac("isp-todo-sync-id-v1").toString("hex").slice(0, 40);
  const rawKey = hmac("isp-todo-sync-enc-v1");
  const key = await subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
  const r = await fetch(SYNC_URL.replace(/\/$/, "") + "/" + id + "?_=" + Date.now(), { cache: "no-store" });
  if (!r.ok) throw new Error("read " + r.status);
  const txt = (await r.text()).trim();
  let doc = { v: 1, s: {} };
  if (txt) {
    const e = JSON.parse(txt);
    if (!e || !e.iv || !e.ct) throw new Error("remote value is not a valid encrypted sync document");
    const pt = await subtle.decrypt({ name: "AES-GCM", iv: b64d(e.iv) }, key, b64d(e.ct));
    doc = JSON.parse(new TextDecoder().decode(pt));
    doc.s = doc.s || {};
  }
  const pri = doc.s[PKEY] || {};
  const notes = doc.s[NKEY] || {};
  const tasks = catalog();
  const ids = new Set([...Object.keys(pri), ...Object.keys(notes)]);
  const rows = [];
  for (const tid of ids) {
    const pPair = pri[tid], nPair = notes[tid];
    const pVal = pPair ? pPair[0] : null;
    const nVal = nPair ? nPair[0] : null;
    if (pVal == null && (nVal == null || noteText(nVal) === "")) continue;
    const prio = PRIOS.indexOf(pVal) >= 0 ? pVal : (pVal == null ? "" : String(pVal));
    const text = noteText(nVal);
    const updated = Math.max(noteAt(nVal, nPair && nPair[1]), (pPair && pPair[1]) || 0);
    const info = tasks[tid] || { id: tid, title: tid, tabs: [] };
    rows.push({
      id: tid,
      title: info.title,
      tabs: info.tabs.length ? info.tabs : ["Not on the current lists"],
      priority: prio,
      notes: text,
      updated,
      updated_et: fmtEt(updated)
    });
  }
  const rank = { Urgent: 0, High: 1, Medium: 2, Low: 3 };
  rows.sort((a, b) => {
    const ta = a.tabs[0] || "", tb = b.tabs[0] || "";
    if (ta !== tb) return ta.localeCompare(tb);
    const ra = a.priority in rank ? rank[a.priority] : 9, rb = b.priority in rank ? rank[b.priority] : 9;
    if (ra !== rb) return ra - rb;
    return (a.title || "").localeCompare(b.title || "");
  });
  if (asJson) {
    console.log(JSON.stringify({ count: rows.length, items: rows }, null, 2));
    return;
  }
  if (!rows.length) {
    console.log("No priorities or notes saved yet.");
    return;
  }
  let last = "";
  for (const r of rows) {
    const tab = r.tabs.join(", ");
    if (tab !== last) { console.log((last ? "\n" : "") + tab); last = tab; }
    const tag = r.priority ? "[" + r.priority + "] " : "";
    console.log("  " + tag + r.title + "  (" + r.id + ")");
    if (r.notes) {
      r.notes.split(/\n/).forEach((line, i) => console.log((i === 0 ? "    Notes: " : "           ") + line));
    }
    if (r.updated_et) console.log("    Updated: " + r.updated_et);
  }
  console.log("\n" + rows.length + " task" + (rows.length === 1 ? "" : "s") + " with a priority or note.");
})().catch((e) => { console.error("read_notes failed: " + e.message); process.exit(1); });
