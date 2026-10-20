#!/usr/bin/env node
// Builds the encrypted index.html from data/*.json. Plaintext data never leaves this machine.
"use strict";
const fs = require("fs"), path = require("path");
const { webcrypto } = require("crypto");
const subtle = webcrypto.subtle;
const ROOT = __dirname;
const ITER = 600000;
const PWFILE = process.env.TODO_PAGE_PASSWORD_FILE || path.join(process.env.HOME, ".secrets/todo_page_password");

function readJson(f) { return JSON.parse(fs.readFileSync(path.join(ROOT, "data", f), "utf8")); }
const b64 = (u) => Buffer.from(u).toString("base64");

(async () => {
  const pw = fs.readFileSync(PWFILE, "utf8").replace(/\r?\n$/, "");
  if (!pw) throw new Error("empty password file");
  const daily = readJson("daily.json"), marketing = readJson("marketing.json");
  const dave = fs.existsSync(path.join(ROOT, "data/dave.json")) ? readJson("dave.json") : { meta: {}, tasks: [] };
  const standup = fs.existsSync(path.join(ROOT, "data/standup.json")) ? readJson("standup.json") : { status: "pending" };
  const projects = fs.existsSync(path.join(ROOT, "data/projects.json")) ? readJson("projects.json") : { cards: [] };

  // sanity checks: stable unique ids
  const kebab = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  const dIds = daily.tasks.map((t) => t.task_id), mIds = marketing.projects.flatMap((p) => p.tasks.map((t) => t.id));
  const vIds = dave.tasks.map((t) => t.task_id);
  for (const [name, ids] of [["daily", dIds], ["marketing", mIds], ["dave", vIds]]) {
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
    if (r.src === "daily" && dIdx[r.id]) { const t = dIdx[r.id]; return { src: "daily", id: t.task_id, text: t.action, owner: "Rachel", with: t.collaborators || [], due: t.due_date || "", project: t.project }; }
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
  if (missing.length) console.warn("projects: " + missing.length + " refs not found and dropped: " + missing.join(", "));

  // stable salt so "remember on this device" keeps working across rebuilds (salt is not secret)
  const saltFile = path.join(ROOT, "salt.txt");
  if (!fs.existsSync(saltFile)) fs.writeFileSync(saltFile, b64(webcrypto.getRandomValues(new Uint8Array(16))) + "\n");
  const salt = Buffer.from(fs.readFileSync(saltFile, "utf8").trim(), "base64");
  const iv = webcrypto.getRandomValues(new Uint8Array(12));

  const base = await subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveKey"]);
  const key = await subtle.deriveKey({ name: "PBKDF2", salt, iterations: ITER, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const payload = JSON.stringify({ daily, marketing, dave, standup, projects, built_at: new Date().toISOString() });
  const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(payload));

  const blob = JSON.stringify({ v: 1, iter: ITER, salt: b64(salt), iv: b64(iv), ct: b64(new Uint8Array(ct)) });
  const tpl = fs.readFileSync(path.join(ROOT, "src/template.html"), "utf8");
  if (!tpl.includes("/*__PAYLOAD__*/")) throw new Error("template placeholder missing");
  const html = tpl.replace("/*__PAYLOAD__*/", () => blob);

  // leak guard: no task text, ids, or the password may appear in the output
  const probes = [pw, ...daily.tasks.flatMap((t) => [t.action, t.task_id]), ...dave.tasks.flatMap((t) => [t.action, t.task_id, t.context]), ...marketing.projects.flatMap((p) => [p.why, ...p.tasks.flatMap((t) => [t.t, t.id])]), ...(projects.cards || []).flatMap((c) => [c.title, c.note, ...(c.status || []), ...(c.agenda || []), ...(c.waiting || []).map((w) => w.text)])]
    .filter((s) => typeof s === "string" && s.length >= 12);
  const leaks = probes.filter((s) => html.includes(s));
  if (leaks.length) throw new Error("plaintext leak guard tripped (" + leaks.length + " strings). Not writing index.html.");

  fs.writeFileSync(path.join(ROOT, "index.html"), html);
  const mDone = marketing.projects.flatMap((p) => p.tasks).filter((t) => t.d).length;
  console.log(`Built index.html: daily ${dIds.length} tasks, marketing ${mIds.length} tasks (${mDone} done), dave ${vIds.length} tasks, projects ${(projects.cards || []).length} meetings for ${projects.date || "n/a"}, ${html.length} bytes`);
})().catch((e) => { console.error("BUILD FAILED: " + e.message); process.exit(1); });
