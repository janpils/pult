// Pult: připomínky (komentáře ke snímku nebo položce, kresby, verdikty), fronta změn odolná proti
// výpadku sítě a odeslání revize Claudovi.
import { $, $$, S, store, api, clientId, uid, esc, icon, emit, on, toast, ago, plural, initials, fmtTC, confirmBox } from "./core.js";
import { vid, item, isVideo, fps, curFrame, seekFrame, pause, drawMarks, media } from "./player.js";
import * as Dict from "./dictate.js";
import { renderOverlay, releaseOverlay, clearAt } from "./draw.js";

// ---------- fronta změn (přežije výpadek Wi-Fi i zavření okna) ----------
// Každá karta má svou frontu; fronty zavřených karet (30 s bez zápisu) převezme a dopošle jiná.
const QKEY = "queue." + clientId;
function loadQueue() {
  const mine = store.get(QKEY, null);
  let q = (mine && mine.items) || [];
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith("pult.queue.") || k === "pult." + QKEY) continue;
      const v = JSON.parse(localStorage.getItem(k) || "{}");
      if (!v.at || Date.now() - v.at > 30000) { q = q.concat(v.items || []); localStorage.removeItem(k); }
    }
    const old = store.get("queue", null); // fronta ze starší verze (společná pro všechny karty)
    if (Array.isArray(old)) { q = q.concat(old); localStorage.removeItem("pult.queue"); }
  } catch {}
  return q;
}
let queue = loadQueue();
let flushing = null, codeAsked = false;
const persist = () => store.set(QKEY, { at: Date.now(), items: queue.slice(-2000) });

export function op(body, { localDone = false } = {}) {
  if (!S.batch) return;
  body = { ...body, from: clientId };
  if (!localDone) applyLocal(body);
  queue.push({ batch: S.batch.id, body });
  persist();
  emit("notes");
  flush();
}
export function flush() {
  if (!flushing) flushing = run().finally(() => { flushing = null; setNet(); });
  return flushing;
}
async function run() {
  while (queue.length) {
    const q = queue[0];
    try {
      const r = await api("POST", `/api/notes/${encodeURIComponent(q.batch)}`, q.body);
      queue.shift(); persist();
      if (S.batch && q.batch === S.batch.id && r.change) applyChange(r.change, true);
    } catch (e) {
      if (e.status === 401) { askCode(); break; } // nový přístupový kód: nic nezahazovat, po přihlášení se dopošle
      if (e.status >= 400 && e.status < 500 && ![403, 408, 429].includes(e.status)) { queue.shift(); persist(); toast("Změnu se nepodařilo uložit: " + e.message, { error: true }); }
      else break;
    }
  }
}
export const pendingCount = () => queue.length;
export function askCode() {
  if (codeAsked) return;
  codeAsked = true;
  toast("Pult chce přístupový kód (nejspíš se změnil). Rozpracované kresby jsou uložené.", { action: "Zadat kód", ms: 60000, onAction: () => { location.href = "/"; } });
}
setInterval(() => { if (queue.length) flush(); }, 3000);

export function setNet() {
  const n = $("#net");
  n.className = "net " + (!S.online ? "" : queue.length ? "wait" : "on");
  n.title = !S.online ? "Bez spojení se serverem Pultu" : queue.length ? `Ukládám ${queue.length}…` : "Připojeno, vše uloženo";
}

// Snímek připomínek ze serveru. Starší snímek (nižší rev) nepřepíše novější stav a změny, které ještě
// čekají ve frontě, se na něj znovu použijí, ať nic nezmizí (výpadek Wi-Fi, obnovení stránky).
export function setNotes(notes, bid, force = false) {
  if (!force && S.batch && S.batch.id === bid && (notes.rev || 0) < (S.rev || 0)) return false;
  S.notes = notes; S.rev = notes.rev || 0;
  for (const q of queue) if (q.batch === bid) applyLocal(q.body);
  return true;
}
function applyLocal(b) {
  const nt = S.notes;
  if (b.op === "stroke.add") for (const s of b.strokes || []) nt.strokes[s.id] = s;
  else if (b.op === "stroke.del") for (const id of b.ids || []) delete nt.strokes[id];
  else if (b.op === "comment.set" && b.comment) nt.comments[b.comment.id] = { at: new Date().toISOString(), resolved: false, ...(nt.comments[b.comment.id] || {}), ...b.comment };
  else if (b.op === "comment.del") delete nt.comments[b.id];
  else if (b.op === "verdict") { if (b.v) nt.verdicts[b.n] = { v: b.v, by: b.by, at: new Date().toISOString() }; else delete nt.verdicts[b.n]; }
}

// změna od serveru (moje potvrzená nebo cizí)
export function applyChange(c, own) {
  const nt = S.notes;
  if (c.rev) S.rev = Math.max(S.rev || 0, c.rev);
  if (c.op === "stroke.add") for (const s of c.strokes || []) { if (!own || nt.strokes[s.id]) nt.strokes[s.id] = s; }
  else if (c.op === "stroke.del") for (const id of c.ids || []) delete nt.strokes[id];
  else if (c.op === "comment.set" && c.comment) { if (!own || nt.comments[c.comment.id]) nt.comments[c.comment.id] = { ...(nt.comments[c.comment.id] || {}), ...c.comment }; }
  else if (c.op === "comment.del") delete nt.comments[c.id];
  else if (c.op === "verdict") { if (c.verdict) nt.verdicts[c.n] = c.verdict; else if (c.verdict === null) delete nt.verdicts[c.n]; }
  if (!own) emit("notes");
}
function change(body) { op(body); }

// ---------- panel ----------
const scopeBtns = $$("#notesScope button");
export function setScope(s) { S.scope = s; store.set("scope", s); scopeBtns.forEach((b) => b.classList.toggle("on", b.dataset.scope === s)); render(); }
scopeBtns.forEach((b) => (b.onclick = () => setScope(b.dataset.scope)));

function entries() {
  const out = [];
  const groups = new Map();
  for (const s of Object.values(S.notes.strokes)) {
    const k = `${s.n}:${s.frame}`;
    const g = groups.get(k) || { type: "d", n: s.n, frame: s.frame, count: 0, authors: new Map(), at: "" };
    g.count++; g.authors.set(s.by || "?", s.byc); if ((s.at || "") > g.at) g.at = s.at || "";
    groups.set(k, g);
  }
  out.push(...groups.values());
  for (const c of Object.values(S.notes.comments)) out.push({ type: "c", ...c });
  return out.sort((a, b) => a.n - b.n || (a.frame == null ? -1 : a.frame) - (b.frame == null ? -1 : b.frame) ||
    (a.type === b.type ? 0 : a.type === "d" ? -1 : 1) || String(a.at).localeCompare(String(b.at)));
}

export function render() {
  const list = $("#noteList");
  if (!S.batch) { list.innerHTML = ""; summary(); return; }
  const all = entries();
  const shown = S.scope === "item" ? all.filter((e) => e.n === S.n) : all;
  const it = item(), cf = isVideo() ? curFrame() : 0;
  $("#notesCount").textContent = all.length ? String(all.length) : "";
  const badge = $("#notesBadge"); badge.hidden = !all.length; badge.textContent = all.length;
  if (!shown.length) {
    list.innerHTML = `<div class="nempty">${icon("chat")}${S.scope === "item" ? "K téhle položce zatím nic." : "Zatím žádné připomínky."}<br>Kresli přímo do obrazu, nebo napiš komentář dole.</div>`;
    summary();
    return;
  }
  let html = "", lastN = null;
  const names = new Map(S.batch.items.map((x) => [x.n, x]));
  // pořadí, v jakém komentáře vznikaly (u každé položky zvlášť): video se pouští víckrát, seznam je ale podle času ve videu
  const order = new Map(), per = new Map();
  for (const c of Object.values(S.notes.comments).sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id)))) {
    per.set(c.n, (per.get(c.n) || 0) + 1); order.set(c.id, per.get(c.n));
  }
  for (const e of shown) {
    if (S.scope === "all" && e.n !== lastN) {
      const x = names.get(e.n);
      html += `<div class="ngroup">#${String(e.n).padStart(2, "0")} <span>${esc(x ? x.name : "")}</span></div>`;
      lastN = e.n;
    }
    const x = names.get(e.n);
    const f = x && x.kind === "video" && e.frame != null ? fmtTC((e.frame + 0.5) / (x.fps || 30), x.fps || 30) : null;
    const cur = e.n === S.n && (e.frame == null ? false : e.frame === cf) && it && (it.kind !== "video" || vid.paused);
    if (e.type === "d") {
      const who = [...e.authors.keys()].join(", ");
      const col = [...e.authors.values()][0];
      html += `<div class="note${cur ? " cur" : ""}" data-n="${e.n}" data-frame="${e.frame}" data-kind="d">
        <span class="av" style="--c:${esc(col || "#666")}">${esc(initials(who))}</span>
        <div><div class="who"><b>${esc(who || "Kresba")}</b>${f ? `<span class="at">${f}</span>` : ""}<span class="ago">${esc(ago(e.at))}</span></div>
        <div class="kd">${icon("pen")}${plural(e.count, "tah", "tahy", "tahů")}</div></div>
        <div class="acts"><button data-act="del-d" title="Smazat kresbu na tomto snímku">${icon("trash")}</button></div></div>`;
    } else {
      const mine = e.by === S.me.name;
      html += `<div class="note${cur ? " cur" : ""}${e.resolved ? " resolved" : ""}" data-n="${e.n}" data-frame="${e.frame == null ? "" : e.frame}" data-id="${esc(e.id)}" data-kind="c">
        <span class="ord" title="Pořadí, v jakém připomínka vznikla">${order.get(e.id) || ""}</span>
        <span class="av" style="--c:${esc(e.byc || "#666")}">${esc(initials(e.by))}</span>
        <div><div class="who"><b>${esc(e.by || "?")}</b>${f ? `<span class="at">${f}</span>` : ""}${e.src === "dict" ? `<span class="dict" title="Nadiktováno mikrofonem">${icon("mic")}</span>` : ""}<span class="ago">${esc(ago(e.at))}${e.edited ? " · upraveno" : ""}</span></div>
        ${e.text ? `<div class="txt">${esc(e.text)}</div>` : ""}${attHtml(e.att)}</div>
        <div class="acts"><button data-act="resolve" title="${e.resolved ? "Znovu otevřít" : "Vyřešeno"}">${icon("check")}</button>${mine ? `<button data-act="edit" title="Upravit">${icon("pen")}</button>` : ""}<button data-act="del-c" title="Smazat">${icon("trash")}</button></div></div>`;
    }
  }
  list.innerHTML = html;
  summary();
}
on("notes", () => { render(); drawMarks(); emit("strip"); updateVerdict(); });
on("notes-local", () => { render(); drawMarks(); emit("strip"); });
let frameTimer = 0;
on("frame", () => { if (vid.paused || !isVideo()) { clearTimeout(frameTimer); frameTimer = setTimeout(() => { highlight(); updateAnchor(); }, 60); } });

function highlight() {
  const cf = isVideo() ? curFrame() : 0;
  $$("#noteList .note").forEach((el) => el.classList.toggle("cur", +el.dataset.n === S.n && el.dataset.frame !== "" && +el.dataset.frame === cf && (vid.paused || !isVideo())));
}

$("#noteList").addEventListener("click", async (e) => {
  const el = e.target.closest(".note");
  if (!el) return;
  const n = +el.dataset.n, frame = el.dataset.frame === "" ? null : +el.dataset.frame;
  const act = e.target.closest("[data-act]") && e.target.closest("[data-act]").dataset.act;
  if (act === "resolve") { const c = S.notes.comments[el.dataset.id]; if (c) change({ op: "comment.set", comment: { id: c.id, resolved: !c.resolved } }); return; }
  if (act === "del-c") { change({ op: "comment.del", id: el.dataset.id }); toast("Komentář smazán", { ms: 2000 }); return; }
  if (act === "edit") return editComment(el);
  if (act === "att") { const c = S.notes.comments[el.dataset.id], a = c && c.att && c.att[+e.target.closest("[data-act]").dataset.i]; if (a) viewAtt(a); return; }
  if (act === "del-d") { clearAt(n, frame); return; }
  if (el.querySelector("textarea")) return;
  emit("goto", { n, frame });
});

function attHtml(att) {
  if (!att || !att.length) return "";
  return `<div class="atts">${att.map((a, i) => {
    const inner = a.kind === "image" && /\.(jpe?g|png|gif|webp|avif)$/i.test(a.path) ? `<img loading="lazy" src="${media(a.path)}" alt="">`
      : a.kind === "video" ? `<video muted preload="metadata" src="${media(a.path)}#t=0.1"></video><span class="play">${icon("play")}</span>` : icon("image");
    return `<button data-act="att" data-i="${i}" title="${esc(a.name)}">${inner}</button>`;
  }).join("")}</div>`;
}
function viewAtt(a) {
  const box = document.createElement("div");
  box.className = "att-view";
  box.innerHTML = (a.kind === "video" ? `<video src="${media(a.path)}" controls autoplay playsinline></video>` : `<img src="${media(a.path)}" alt="">`)
    + `<button class="ib x" title="Zavřít (Esc)">${icon("x")}</button>`;
  const close = () => { box.remove(); removeEventListener("keydown", onKey, true); };
  const onKey = (ev) => { if (ev.key === "Escape") { ev.stopPropagation(); ev.preventDefault(); close(); } };
  box.onclick = (ev) => { if (ev.target === box || ev.target.closest(".x")) close(); };
  addEventListener("keydown", onKey, true);
  document.body.appendChild(box);
}

function editComment(el) {
  const c = S.notes.comments[el.dataset.id];
  if (!c) return;
  let box = el.querySelector(".txt");
  if (!box) { box = document.createElement("div"); box.className = "txt"; el.querySelector(".who").after(box); }
  box.innerHTML = `<textarea rows="3"></textarea>`;
  const ta = box.querySelector("textarea");
  ta.value = c.text; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  const save = () => { const t = ta.value.trim(); if ((t || (c.att && c.att.length)) && t !== c.text) change({ op: "comment.set", comment: { id: c.id, text: t } }); else render(); };
  ta.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); save(); } if (ev.key === "Escape") render(); };
  ta.onblur = save;
}

// ---------- psaní komentáře ----------
const input = $("#commentInput");
S.anchorWhole = false;
export function updateAnchor() {
  const it = item(), b = $("#anchorBtn");
  if (!it || it.state !== "ready") { b.innerHTML = ""; return; }
  if (it.kind !== "video") b.innerHTML = "Komentář k obrázku";
  else if (S.anchorWhole) b.innerHTML = `Komentář k celému videu ${icon("chev-d")}`;
  else b.innerHTML = `Komentář ke snímku <b>${fmtTC((curFrame() + 0.5) / fps(), fps())}</b>`;
}
$("#anchorBtn").onclick = () => { if (isVideo()) { S.anchorWhole = !S.anchorWhole; updateAnchor(); } };
input.addEventListener("focus", () => { if (isVideo() && !vid.paused) pause(); });
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(160, input.scrollHeight) + "px"; });
input.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  if (e.key === "Escape") input.blur();
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
});
$("#sendBtn").onclick = send;
export function focusComposer() {
  // hned, ať se další stisknuté klávesy píšou do komentáře a nespouštějí zkratky
  if (input.offsetParent) return input.focus();
  emit("show-notes");
  input.focus();
  requestAnimationFrame(() => input.focus());
}
// ---------- přílohy (přetažení na panel, ⌘V, sponka) ----------
const pend = [];  // {id, file, name, kind, url, path, progress, error, promise}
const ATT_OK = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|mp4|mov|m4v|webm|mkv|avi)$/i;
function fileName(f) {
  if (f.name && f.name !== "image.png" && ATT_OK.test(f.name)) return f.name;
  const ext = (f.type.split("/")[1] || "png").replace("quicktime", "mov").replace("jpeg", "jpg");
  return `schranka_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.${ext}`;
}
export function addAttachments(files) {
  if (!S.batch || !item()) return;
  const ok = [...files].filter((f) => /^(image|video)\//.test(f.type) || ATT_OK.test(f.name || ""));
  if (!ok.length) return toast("Přiložit jde jen obrázek nebo video.");
  for (const f of ok) {
    const a = { id: uid(), file: f, name: fileName(f), kind: /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name || "") ? "video" : "image", progress: 0 };
    try { a.url = URL.createObjectURL(f); } catch {}
    a.promise = uploadAtt(S.batch.id, a);
    pend.push(a);
  }
  renderPending();
  focusComposer();
}
function uploadAtt(bid, a) {
  return new Promise((res) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/upload/${encodeURIComponent(bid)}?att=1&name=${encodeURIComponent(a.name)}`);
    xhr.upload.onprogress = (e) => { a.progress = e.total ? e.loaded / e.total : 0; renderPending(); };
    xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status < 300 && j.path) { a.path = j.path; a.progress = 1; } else { a.error = j.error || String(xhr.status); toast("Přílohu se nepodařilo nahrát: " + a.error, { error: true }); }
      renderPending(); res(); };
    xhr.onerror = () => { a.error = "spojení přerušeno"; renderPending(); res(); };
    xhr.send(a.file);
  });
}
function renderPending() {
  const box = $("#attPending");
  box.hidden = !pend.length;
  box.innerHTML = pend.map((a) => `<div class="att-chip${a.error ? " err" : ""}" data-id="${a.id}" title="${esc(a.name)}">`
    + (a.url && a.kind === "image" && !/\.(heic|heif|tiff?|bmp)$/i.test(a.name) ? `<img src="${a.url}" alt="">` : a.url && a.kind === "video" ? `<video muted src="${a.url}#t=0.1"></video>` : `<span class="nm">${esc(a.name)}</span>`)
    + `<button class="x" title="Odebrat">${icon("x")}</button>`
    + (a.path || a.error ? "" : `<span class="up"><i style="width:${Math.round(a.progress * 100)}%"></i></span>`) + `</div>`).join("");
}
$("#attPending").addEventListener("click", (e) => {
  const x = e.target.closest(".x"), chip = e.target.closest(".att-chip");
  if (!x || !chip) return;
  const i = pend.findIndex((a) => a.id === chip.dataset.id);
  if (i >= 0) { const [a] = pend.splice(i, 1); if (a.url) URL.revokeObjectURL(a.url); }
  renderPending();
});
function clearPending() { for (const a of pend) if (a.url) setTimeout(() => URL.revokeObjectURL(a.url), 60000); pend.length = 0; renderPending(); }
on("batch-left", clearPending);
on("attach-files", addAttachments);
$("#attachBtn").onclick = () => $("#attInput").click();
$("#attInput").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addAttachments(f); };
// ⌘V obrázku nebo videa (snímek obrazovky, soubor z Finderu) do komentáře; text se vloží normálně
document.addEventListener("paste", (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length || !S.batch) return;
  const t = e.target, tag = t && t.tagName;
  if ((tag === "INPUT" || tag === "TEXTAREA") && t !== input) return;
  if (document.querySelector("dialog[open]")) return;
  e.preventDefault();
  addAttachments(files);
});

let sending = false;
async function send() {
  const text = input.value.trim(), it = item();
  if ((!text && !pend.length) || !it || sending) return;
  if (!S.me.name) { emit("need-name"); return; }
  const frame = it.kind === "video" && !S.anchorWhole ? curFrame() : null;
  const n = S.n, bid = S.batch.id;
  let att = [];
  if (pend.length) {
    sending = true; $("#sendBtn").disabled = true;
    try { await Promise.all(pend.map((a) => a.promise)); } finally { sending = false; $("#sendBtn").disabled = false; }
    if (!S.batch || S.batch.id !== bid) return;
    att = pend.filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, kind: a.kind }));
    if (!text && !att.length) return toast("Přílohy se nenahrály, zkus to znovu.", { error: true });
    clearPending();
  }
  change({ op: "comment.set", comment: { id: uid(), n, frame, text, by: S.me.name, byc: S.me.color, ...(att.length ? { att } : {}) } });
  input.value = ""; input.style.height = "auto";
  S.anchorWhole = false; updateAnchor();
}

// ---------- verdikty ----------
export function updateVerdict() {
  const v = S.batch && S.notes.verdicts[S.n];
  $$("#verdict .vbtn").forEach((b) => b.classList.toggle("on", !!v && v.v === b.dataset.v));
  $("#verdict").hidden = !item();
}
export function setVerdict(val) {
  if (!item()) return;
  const cur = S.notes.verdicts[S.n];
  const v = cur && cur.v === val ? null : val;
  change({ op: "verdict", n: S.n, v, by: S.me.name });
  updateVerdict();
  if (v) toast(v === "ok" ? `#${String(S.n).padStart(2, "0")} schváleno` : `#${String(S.n).padStart(2, "0")} zamítnuto`, { ms: 1400 });
}
$$("#verdict .vbtn").forEach((b) => (b.onclick = () => setVerdict(b.dataset.v)));

// ---------- souhrn a odeslání revize ----------
function counts() {
  const frames = new Set(Object.values(S.notes.strokes).map((s) => `${s.n}:${s.frame}`));
  const vs = Object.values(S.notes.verdicts);
  return { d: frames.size, c: Object.keys(S.notes.comments).length, ok: vs.filter((v) => v.v === "ok").length, no: vs.filter((v) => v.v === "no").length };
}
export function summary() {
  const el = $("#submitSummary"), btn = $("#submitBtn");
  if (!S.batch) { el.textContent = ""; btn.disabled = true; return; }
  const c = counts(), parts = [];
  if (c.d) parts.push(plural(c.d, "kresba", "kresby", "kreseb"));
  if (c.c) parts.push(plural(c.c, "komentář", "komentáře", "komentářů"));
  if (c.ok) parts.push(`✓ ${c.ok}`);
  if (c.no) parts.push(`✕ ${c.no}`);
  const last = (S.batch.submissions || []).slice(-1)[0];
  const en = document.documentElement.lang === "en";
  const sent = S.batch.status === "done" && last ? `${en ? "Sent" : "Odesláno"} ${ago(last.at)}${last.by ? " (" + last.by + ")" : ""}. ` : "";
  el.textContent = sent + (parts.length ? parts.join(" · ") : en ? "No notes: sending approves the batch." : "Bez připomínek: odesláním dávku schválíš.");
  el.setAttribute("data-noi18n", "");
  btn.disabled = false;
  btn.textContent = S.batch.status === "done" ? "Odeslat znovu" : "Odeslat revizi";
}

export async function submit() {
  if (!S.batch) return;
  const btn = $("#submitBtn");
  if (btn.dataset.busy) return;
  if (Dict.busy()) {
    btn.dataset.busy = "1"; btn.textContent = "Dokončuji přepis diktátu…"; btn.disabled = true;
    const ok = await Dict.flush();
    delete btn.dataset.busy; btn.disabled = false; summary();
    if (!ok) return toast("Přepis diktátu ještě neskončil. Zkus odeslat za chvilku.", { error: true });
  }
  await flush();
  if (queue.length) return toast("Server Pultu teď není dostupný. Všechno je uložené, zkus to za chvilku.", { error: true });
  const b = S.batch, keys = new Set();
  try { const r = await api("GET", `/api/batch/${encodeURIComponent(b.id)}`); setNotes(r.notes, b.id, true); } // obrázky z úplného stavu (i kresby kolegů)
  catch (e) { return toast("Server Pultu teď není dostupný: " + e.message, { error: true }); }
  for (const s of Object.values(S.notes.strokes)) keys.add(`${s.n}:${s.frame}`);
  for (const c of Object.values(S.notes.comments)) { const it = b.items.find((x) => x.n === c.n); if (it && (c.frame != null || it.kind === "image")) keys.add(`${c.n}:${c.frame == null ? 0 : c.frame}`); }
  const overlays = {};
  btn.dataset.busy = "1"; btn.textContent = "Odesílám…"; btn.disabled = true;
  try {
    for (const k of keys) {
      const [n, f] = k.split(":").map(Number), it = b.items.find((x) => x.n === n);
      if (!it || it.state !== "ready") continue;
      const by = [...new Set([...Object.values(S.notes.strokes), ...Object.values(S.notes.comments)].filter((x) => x.n === n && (x.frame == null ? 0 : x.frame) === f).map((x) => x.by).filter(Boolean))];
      const label = `#${String(n).padStart(2, "0")}` + (it.kind === "video" ? ` · ${fmtTC((f + 0.5) / (it.fps || 30), it.fps || 30)} · snímek ${f}` : "") + (by.length ? ` · ${by.join(", ")}` : "");
      overlays[k] = renderOverlay(it, f, label);
    }
    releaseOverlay();
    const r = await api("POST", `/api/batch/${encodeURIComponent(b.id)}/submit`, { overlays, by: S.me.name, from: clientId });
    const what = r.notes ? plural(r.notes, "připomínka", "připomínky", "připomínek") : "bez připomínek";
    const waiting = (S.batches.find((x) => x.id === b.id) || {}).waiting;
    toast(waiting ? `Revize odeslána Claudovi do chatu, který dávku poslal (${what}).`
      : `Revize uložená (${what}). Claude ji uvidí, až mu napíšeš „koukni na pult“.`,
      { action: "Vrátit", ms: waiting ? 10000 : 14000, onAction: () => unsubmit(b.id, r.name) });
    emit("submitted", { batch: b.id });
  } catch (e) {
    toast("Odeslání selhalo: " + e.message, { error: true });
  } finally {
    releaseOverlay();
    delete btn.dataset.busy; btn.disabled = false; summary();
  }
}
async function unsubmit(bid, name) {
  try {
    const r = await api("POST", `/api/batch/${encodeURIComponent(bid)}/unsubmit`, { name, from: clientId });
    if (!r.ok) return toast("Tuhle revizi už Claude zpracoval, vrátit nejde.");
    emit("open-batch", { id: bid });
    toast("Vráceno, dávka je zase otevřená.", { ms: 2500 });
  } catch (e) { toast("Vrácení selhalo: " + e.message, { error: true }); }
}
$("#submitBtn").onclick = submit;
// Odeslat i se schovaným panelem připomínek: malé tlačítko v liště položky zrcadlí to velké
$("#submitMini").onclick = submit;
{
  const big = $("#submitBtn"), mini = $("#submitMini"), lbl = $("span", mini);
  const sync = () => { mini.disabled = big.disabled; lbl.textContent = big.textContent; mini.title = big.title; };
  new MutationObserver(sync).observe(big, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["disabled", "title"] });
  sync();
}
