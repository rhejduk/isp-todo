#!/usr/bin/env node
// Builds the encrypted index.html from data/*.json. Plaintext data never leaves this machine.
"use strict";
const fs = require("fs"), path = require("path");
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;
const ROOT = __dirname;
const ITER = 600000;
const PWFILE = process.env.TODO_PAGE_PASSWORD_FILE || path.join(process.env.HOME, ".secrets/todo_page_password");
// Checkmark sync (see SYNC.md). Bucket id and encryption key are derived from the page password and only ever
// ship inside the encrypted payload. TODO_BUILD_OUT / TODO_SYNC_URL exist for tests only.
const SYNC_URL = process.env.TODO_SYNC_URL || "https://textdb.online";
const OUT = process.env.TODO_BUILD_OUT || path.join(ROOT, "index.html");
const BACKUP = path.join(ROOT, "data/sync_backup.json");

function readJson(f) { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8")); }
const b64 = (u) => Buffer.from(u).toString("base64");

(async () => {
  const pw = fs.readFileSync(PWFILE, "utf8").replace(/\r?\n$/, "");
  if (!pw) throw new Error("empty password file");
  const daily = readJson("daily.json"), marketing = readJson("marketing.json");
  const dave = fs.existsSync(path.join(ROOT, "data/dave.json")) ? readJson("dave.json") : { meta: {}, tasks: [] };
  const standup = fs.existsSync(path.join(ROOT, "data/standup.json")) ? readJson("standup.json") : { status: "pending" };
  const projects = fs.existsSync(path.join(ROOT, "data/projects.json")) ? readJson("projects.json") : { cards: [] };
  // Daily Brief tab (see DAILY_BRIEF.md): incoming news, newest first, ids start with upd-
  const brief = fs.existsSync(path.join(ROOT, "data/daily_brief.json")) ? readJson("daily_brief.json") : { meta: {}, entries: [] };
  brief.entries = (brief.entries || []).slice().sort((a, b) => new Date(b.at) - new Date(a.at));
  // Shipping tab (see SHIPPING_TAB.md): one card per shipment, to dos are Daily refs or ship- items
  const shipping = fs.existsSync(path.join(ROOT, "data/shipping.json")) ? readJson("shipping.json") : { meta: {}, cards: [], partners: [] };

  // sanity checks: stable unique ids
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const dIds = daily.tasks.map((t) => t.task_id), mIds = marketing.projects.flatMap((p) => p.tasks.map((t) => t.id));
  const vIds = dave.tasks.map((t) => t.task_id);
  // Stage 4 checklist deliverables (see STAGE4_DELIVERABLES.md): ids must stay stable so ticks survive refreshes
  const sIds = marketing.projects.flatMap((p) => (p.deliverables || []).map((d) => d.id));
  if (sIds.some((i) => !/^s4-/.test(i))) throw new Error("stage4: deliverable ids must start with s4-");
  const bIds = brief.entries.map((u) => u.id);
  if (bIds.some((i) => !/^upd-/.test(i))) throw new Error("brief: entry ids must start with upd-");
  for (const u of brief.entries) {
    if (!u.at || isNaN(new Date(u.at))) throw new Error("brief: bad or missing at on " + u.id);
    if (!u.headline || !u.project) throw new Error("brief: headline and project are required on " + u.id);
    if ((u.bullets || []).length > 4) throw new Error("brief: more than 4 bullets on " + u.id);
  }
  for (const [name, ids] of [["daily", dIds], ["marketing", mIds], ["dave", vIds], ["stage4", sIds], ["brief", bIds]]) {
    if (new Set(ids).size !== ids.length) throw new Error(name + ": duplicate task ids");
    const bad = ids.filter((i) => !kebab.test(i));
    if (bad.length) throw new Error(name + ": non kebab-case ids: " + bad.join(", "));
  }

  // Projects tab: resolve todo_refs / waiting refs against the live daily, marketing and dave lists at build time
  const dIdx = Object.fromEntries(daily.tasks.map((t) => [t.task_id, t]));
  const mIdx = {}; marketing.projects.forEach((p) => p.tasks.forEach((t) => { mIdx[t.id] = { t, p } }));
  const vIdx = Object.fromEntries(dave.tasks.map((t) => [t.task_id, t]));
  const missing = [];
  function resolve(r) {
    if (r.src === "daily" && dIdx[r.id]) { const t = dIdx[r.id]; return { src: "daily", id: t.task_id, text: t.action, owner: "Rachel", with: t.collaborators || [], due: t.due_date || "", project: t.project, urgent: !!t.urgent, links: (t.links || []).filter((l) => l && l.label && /^https?:\/\//.test(l.url || "")) }; }
    if (r.src === "marketing" && mIdx[r.id]) { const { t, p } = mIdx[r.id]; return { src: "marketing", id: t.id, text: t.t, owner: t.o || "PMs", with: t.w ? [t.w] : [], due: "", project: p.name, done: !!t.d }; }
    if (r.src === "dave" && vIdx[r.id]) { const t = vIdx[r.id]; return { src: "dave", id: t.task_id, text: t.action, owner: "Rachel", with: ["Dave"], due: t.due_date || "", project: t.project }; }
    missing.push(r.src + ":" + r.id); return null;
  }
  const pIds = (projects.cards || []).map((c) => c.id);
  if (new Set(pIds).size !== pIds.length) throw new Error("projects: duplicate card ids");
  const pBad = pIds.filter((i) => !kebab.test(i));
  if (pBad.length) throw new Error("projects: non kebab-case card ids: " + pBad.join(", "));
  (projects.cards || []).forEach((c) => {
    c.todos = (c.todo_refs || []).map(resolve).filter(Boolean).concat(c.extra_todos || []);
    (c.waiting || []).forEach((w) => { if (w.ref) { const r = resolve(w.ref); if (r) w.ref = { src: r.src, id: r.id }; else delete w.ref; } });
    delete c.todo_refs;
  });
  // Daily Brief sub items: ref = an existing Daily or Marketing to do (same id, same tick); else a brief only item
  // whose id is the entry id + "-aN". Resolved here so the page shows the live to do text.
  const allTodo = new Set([...dIds, ...mIds]), briefSubIds = [];
  for (const u of brief.entries) {
    const seen = new Set();
    u.subs = (u.subs || []).map((s) => {
      if (s.ref) {
        if (!["daily", "marketing"].includes(s.ref.src)) throw new Error("brief: sub ref src must be daily or marketing on " + u.id);
        const r = resolve(s.ref); if (!r) return null;
        if (seen.has(r.id)) throw new Error("brief: duplicate sub " + r.id + " on " + u.id); seen.add(r.id);
        return { src: r.src, id: r.id, text: r.text, done: !!r.done, links: r.links || [] };
      }
      if (!s.id || !s.id.startsWith(u.id + "-a") || !/-a[0-9]+$/.test(s.id)) throw new Error("brief: brief only sub ids must be <entry id>-aN on " + u.id);
      if (allTodo.has(s.id)) throw new Error("brief: sub id collides with a to do id: " + s.id);
      if (!s.text) throw new Error("brief: sub " + s.id + " needs text");
      briefSubIds.push(s.id); return { src: "brief", id: s.id, text: s.text };
    }).filter(Boolean);
  }
  const bAll = bIds.concat(briefSubIds);
  if (new Set(bAll).size !== bAll.length) throw new Error("brief: duplicate entry or sub ids");
  const bBad = bAll.filter((i) => !kebab.test(i)); if (bBad.length) throw new Error("brief: non kebab-case ids: " + bBad.join(", "));
  // Daily Brief day groups (tools/build_brief.py): meetings by project for two weekdays. Refs resolve to live to do
  // text and tick in their own tab's key; brief only items are bm- (mine) or bw- (who owes what) and tick in BKEY.
  brief.days = (brief.days || []).map((day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date || "")) throw new Error("brief: day needs a YYYY-MM-DD date");
    day.meetings = (day.meetings || []).map((m) => {
      if (!m.id || !kebab.test(m.id)) throw new Error("brief: bad meeting id " + m.id + " on " + day.date);
      const item = (x, pre, where) => {
        if (x.ref) { const r = resolve(x.ref); return r ? { src: r.src, id: r.id, text: r.text, done: !!r.done, owner: r.owner, shared: !!x.shared, urgent: !!r.urgent, links: r.links || [] } : null; }
        if (!x.id || !x.id.startsWith(pre + "-") || !kebab.test(x.id)) throw new Error("brief: " + where + " ids must be " + pre + "-<kebab> on " + m.id);
        if (!x.text) throw new Error("brief: " + x.id + " needs text");
        return { src: "brief", id: x.id, text: x.text, link: x.link || "", since: x.since || "" };
      };
      m.todos = (m.todos || []).map((x) => item(x, "bm", "my to do")).filter(Boolean);
      m.owes = (m.owes || []).map((o) => {
        if (!o.who || /@/.test(o.who)) throw new Error("brief: owes need a name (not an email) on " + m.id);
        return { who: o.who, items: (o.items || []).map((x) => item(x, "bw", "owed item")).filter(Boolean) };
      }).filter((o) => o.items.length);
      return m;
    });
    return day;
  });
  // Shipping: resolve Daily/Marketing refs to live text (same id, same tick); ship only items need ship- ids
  const shipIds = [], shipCardIds = (shipping.cards || []).map((c) => c.id), shipStages = (shipping.meta || {}).stages || [];
  if (new Set(shipCardIds).size !== shipCardIds.length) throw new Error("shipping: duplicate card ids");
  if (shipCardIds.some((i) => !kebab.test(i))) throw new Error("shipping: non kebab-case card ids");
  for (const c of shipping.cards || []) {
    if (!c.project || !c.title) throw new Error("shipping: project and title are required on " + c.id);
    if (c.stage != null && !shipStages.includes(c.stage)) throw new Error("shipping: unknown stage " + c.stage + " on " + c.id);
    c.todos = (c.todos || []).map((t) => {
      if (t.ref) {
        if (!["daily", "marketing"].includes(t.ref.src)) throw new Error("shipping: ref src must be daily or marketing on " + c.id);
        const r = resolve(t.ref); if (!r) return null;
        return { src: r.src, id: r.id, text: r.text, due: r.due || t.due || "", flag: t.flag || "", done: !!r.done };
      }
      if (!t.id || !/^ship-/.test(t.id) || !kebab.test(t.id)) throw new Error("shipping: ship only to do ids must be ship-<kebab> on " + c.id);
      if (allTodo.has(t.id)) throw new Error("shipping: id collides with a to do id: " + t.id);
      if (!t.text) throw new Error("shipping: " + t.id + " needs text");
      shipIds.push(t.id); return { src: "ship", id: t.id, text: t.text, due: t.due || "", flag: t.flag || "" };
    }).filter(Boolean);
  }
  if (new Set(shipIds).size !== shipIds.length) throw new Error("shipping: duplicate to do ids");
  if (missing.length) console.warn("projects: " + missing.length + " refs not found and dropped: " + missing.join(", "));

  // stable salt so "remember on this device" keeps working across rebuilds (salt is not secret)
  const saltFile = path.join(ROOT, "salt.txt");
  if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, b64(webcrypto.getRandomValues(new Uint8Array(16))) + "\n");
  const salt = Buffer.from(fs.readFileSync(saltFile, "utf8").trim(), "base64");
  const iv = webcrypto.getRandomValues(new Uint8Array(12));

  const base = await subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const hmac = (label) => require("crypto").createHmac("sha256", pw).update(label).digest();
  const sync = { u: SYNC_URL, id: "isptodo-" + hmac("isp-todo-sync-id-v1").toString("hex").slice(0, 40), k: b64(hmac("isp-todo-sync-enc-v1")) };
  const payload = JSON.stringify({ daily, marketing, dave, standup, projects, brief, shipping, sync, built_at: new Date().toISOString() });
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(payload));

  const blob = JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) });
  const tpl = fs.readFileSync(path.join(ROOT, "src/template.html"), "utf8");
  if (!tpl.includes("/*__PAYLOAD__*/")) throw new Error("template placeholder missing");
  const html = tpl.replace("/*__PAYLOAD__*/", () => blob);

  // leak guard: no task text, ids, or the password may appear in the output
  const probes = [pw, sync.id, sync.k, sync.id.slice(8), ...daily.tasks.flatMap((t) => [t.action, t.task_id]), ...dave.tasks.flatMap((t) => [t.action, t.task_id, t.context]), ...marketing.projects.flatMap((p) => [p.why, ...p.tasks.flatMap((t) => [t.t, t.id]), ...(p.deliverables || []).flatMap((d) => [d.t, d.note, d.id])]), ...(projects.cards || []).flatMap((c) => [c.title, c.note, ...(c.status || []), ...(c.agenda || []), ...(c.waiting || []).map((w) => w.text)]), ...brief.entries.flatMap((u) => [u.id, u.headline, u.next_step, ...(u.bullets || []), ...u.subs.flatMap((x) => [x.id, x.text])]), ...brief.days.flatMap((d) => d.meetings.flatMap((m) => [m.title, m.summary, m.note, ...(m.agenda || []).map((a) => a.text), ...m.todos.flatMap((x) => [x.id, x.text]), ...m.owes.flatMap((o) => o.items.flatMap((x) => [x.id, x.text]))])), ...(shipping.cards || []).flatMap((c) => [c.title, ...(c.summary || []), ...c.todos.flatMap((t) => [t.id, t.text]), ...(c.waiting || []).map((w) => w.text)])]
    .filter((s) => typeof s === "string" && s.length >= 12);
  const leaks = probes.filter((s) => html.includes(s));
  if (leaks.length) throw new Error("plaintext leak guard tripped (" + leaks.length + " strings). Not writing index.html.");

  if (!tpl.includes("renderBrief(data.brief)") || !tpl.includes('"isp-todo-brief-ticks"')) throw new Error("template is missing the Daily Brief tab or its sync key (see DAILY_BRIEF.md)");
  if (!tpl.includes("renderShipping(data.shipping)") || !tpl.includes('"isp-todo-ship-ticks"')) throw new Error("template is missing the Shipping tab or its sync key (see SHIPPING_TAB.md)");
  if (!tpl.includes("Sync.start(data.sync)")) throw new Error("template is missing the checkmark sync code (see SYNC.md)");
  fs.writeFileSync(OUT, html);
  const mDone = marketing.projects.flatMap((p) => p.tasks).filter((t) => t.d).length;
  console.log(`Built index.html: daily ${dIds.length} tasks, marketing ${mIds.length} tasks (${mDone} done), stage4 ${sIds.length} deliverables (${marketing.projects.filter((p) => (p.deliverables || []).length).length} brands), dave ${vIds.length} tasks, projects ${(projects.cards || []).length} meetings for ${projects.date || "n/a"}, brief ${bIds.length} updates (${brief.entries.reduce((n, u) => n + u.subs.filter((x) => x.src !== "brief").length, 0)} linked sub items, ${briefSubIds.length} brief only; days ${brief.days.map((d) => d.date + ":" + d.meetings.length).join(" ") || "none"}), shipping ${shipCardIds.length} cards (${shipIds.length} ship only to dos), ${html.length} bytes`);
  if (!process.env.TODO_BUILD_OUT && !process.env.TODO_SYNC_NO_BACKUP) await syncBackup(sync);
})().catch((e) => { console.error("BUILD FAILED: " + e.message); process.exit(1); });

// Keep an encrypted copy of the synced checkmarks in data/ (gitignored). If the remote copy is ever gone
// (textdb deletes keys untouched for 30 days), put the last copy back. Never fatal.
async function syncBackup(sync) {
  try {
    const ctl = AbortSignal.timeout(10000);
    const r = await fetch(sync.u + "/" + sync.id + "?_=" + Date.now(), { signal: ctl, cache: "no-store" });
    if (!r.ok) throw new Error("read " + r.status);
    const txt = (await r.text()).trim();
    if (txt) { fs.writeFileSync(BACKUP, JSON.stringify({ id: sync.id, saved_at: new Date().toISOString(), value: txt })); console.log("Sync: remote checkmarks backed up (" + txt.length + " chars, encrypted)."); return; }
    const b = fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, "utf8")) : null;
    if (!b || b.id !== sync.id || !b.value) { console.log("Sync: remote store is empty, nothing to back up yet."); return; }
    const body = new URLSearchParams({ key: sync.id, value: b.value });
    const w = await fetch(sync.u + "/update", { method: "POST", body, signal: AbortSignal.timeout(10000) });
    const j = await w.json();
    console.log(j && j.status === 1 ? "Sync: remote store was empty, restored backup from " + b.saved_at + "." : "Sync: restore refused.");
  } catch (e) { console.warn("Sync: backup skipped (" + e.message + ")."); }
}
