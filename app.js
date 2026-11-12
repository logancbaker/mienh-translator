// Mienh Translator (static site). The private data arrives encrypted in
// data.json; it is decrypted here, in the browser, with the shared password.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";

const $ = (id) => document.getElementById(id);
let D = null; // decrypted data

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function store(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

// ---- Unlock ------------------------------------------------------------------
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decrypt(enc, password) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: b64(enc.salt), iterations: enc.iter },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const gz = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, key, b64(enc.data));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

let ENC = null;
async function tryUnlock(password, remember) {
  if (!ENC) ENC = await (await fetch("data.json", { cache: "no-cache" })).json();
  let data;
  try { data = await decrypt(ENC, password); }
  catch (e) { return false; }
  store("pw", remember ? password : null);
  init(data);
  return true;
}

$("unlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("unlockBtn").disabled = true;
  $("unlockBtn").textContent = "Opening…";
  $("unlockErr").hidden = true;
  let ok = false;
  try { ok = await tryUnlock($("pw").value, $("remember").checked); }
  catch (err) { $("unlockErr").textContent = "Couldn't load the data. Check the connection and try again."; $("unlockErr").hidden = false; }
  if (!ok && $("unlockErr").hidden) { $("unlockErr").textContent = "That password didn't work."; $("unlockErr").hidden = false; }
  if (!ok) { const f = $("unlock"); f.classList.remove("rise", "shake"); void f.offsetWidth; f.classList.add("shake"); }
  $("unlockBtn").disabled = false;
  $("unlockBtn").textContent = "Open";
});

$("pwToggle").onclick = () => {
  const show = $("pw").type === "password";
  $("pw").type = show ? "text" : "password";
  $("pwToggle").textContent = show ? "Hide" : "Show";
  $("pwToggle").setAttribute("aria-pressed", String(show));
  $("pwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
  $("pw").focus();
};

$("lockBtn").onclick = () => { store("pw", null); location.reload(); };

// ---- Data and search (same rules as scripts/lookup.py and webapp/data.py) ------
const norm = (s) => (s || "").toLowerCase().replace(/’/g, "'").replace(/-/g, " ");
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRe = (t) => new RegExp("(?<![\\w'])" + esc(norm(t)) + "(?![\\w'])");
const tokens = (s) => s.split(/[^a-z0-9']+/).filter(Boolean);

let ENTRIES = [], SENTS = [], EN_INDEX = new Map(), SENT_INDEX = new Map(), STOP = new Set();

function index(map, i, text) {
  for (const t of new Set(tokens(text))) {
    let a = map.get(t);
    if (!a) map.set(t, (a = []));
    a.push(i);
  }
}

function init(data) {
  D = data;
  ENTRIES = data.entries.map(([mien, sense, english, exm, exe, page, book, src]) => ({
    mien, sense, english, exm, exe, page, book: !!book, src,
    nmien: norm(mien).replace(/!+$/, "").trim(), nen: norm(english),
  }));
  SENTS = data.sentences.map(([mien, english, label, ref]) => ({
    mien, english, label, ref, nmien: norm(mien), nen: norm(english),
    confirmed: label.startsWith("Confirmed"),
  }));
  ENTRIES.forEach((r, i) => index(EN_INDEX, i, r.nen));
  SENTS.forEach((s, i) => index(SENT_INDEX, i, s.nen));
  STOP = new Set(data.stopwords);
  $("built").textContent = `Data updated ${data.built}`;
  setupOptions();
  $("loading").hidden = true;
  $("unlock").hidden = true;
  $("app").hidden = false;
  try {
    const d = load("draft");
    if (d) { $("enIn").value = d; updateCount(); }
  } catch (e) {}
  let start = null;
  try { start = sessionStorage.getItem("startTab"); sessionStorage.removeItem("startTab"); } catch (e) {}
  setupHome();
  showTab(start === "tr" ? "tr" : "home");
}

function glossHit(nen, forms) {
  const plain = nen.replace(/\([^)]*\)/g, " ");
  const parts = new Set(plain.split(/[;,]/).map((p) => p.trim().replace(/^[ .]+|[ .]+$/g, "")));
  return forms.some((f) => parts.has(f) || parts.has("to " + f) || parts.has("a " + f) ||
    parts.has("an " + f) || parts.has("the " + f));
}

function search(q, dir, limit = 80, sentLimit = 20) {
  const rx = wordRe(q), nq = norm(q).trim();
  const hits = [];
  for (const r of ENTRIES) {
    let score = null;
    if (dir !== "en") {
      if (r.nmien === nq) score = 0;
      else if (rx.test(r.nmien)) score = 2;
    }
    if (dir !== "mien" && score === null && rx.test(r.nen)) score = glossHit(r.nen, [nq]) ? 1 : 3;
    if (score !== null) hits.push([r.book ? 0 : 1, score, r.mien.length, r.mien.toLowerCase(), r]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
  const sh = SENTS.filter((s) => (dir !== "en" && rx.test(s.nmien)) || (dir !== "mien" && rx.test(s.nen)));
  sh.sort((a, b) => (a.confirmed ? 0 : 1) - (b.confirmed ? 0 : 1) || a.mien.length - b.mien.length);
  return { entries: hits.slice(0, limit).map((h) => h[4]), sentences: sh.slice(0, sentLimit),
    totalEntries: hits.length, totalSentences: sh.length };
}

function wordForms(w) {
  const forms = new Set([w]);
  for (const [suf, rep] of [["ies", "y"], ["es", ""], ["s", ""], ["ed", ""], ["ed", "e"], ["ing", ""], ["ing", "e"], ["ly", ""]]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) forms.add(w.slice(0, -suf.length) + rep);
  }
  return [...forms].sort();
}

function glossaryFor(words, perWord = 6) {
  const out = new Map();
  for (const w of words) {
    const forms = wordForms(w);
    const idx = new Set(forms.flatMap((f) => EN_INDEX.get(f) || []));
    const found = [...idx].map((i) => ENTRIES[i]).map((r) => [r.book ? 0 : 1, glossHit(r.nen, forms) ? 0 : 1, r.nen.length, r]);
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    if (found.length) out.set(w, found.slice(0, perWord).map((f) => f[3]));
  }
  return out;
}

function examplesFor(words, perWord = 2, cap = 60) {
  const chosen = [], seen = new Set();
  for (const w of words) {
    const idx = new Set(wordForms(w).flatMap((f) => SENT_INDEX.get(f) || []));
    const cands = [...idx].map((i) => SENTS[i]);
    cands.sort((a, b) => (a.confirmed ? 0 : 1) - (b.confirmed ? 0 : 1) || a.mien.length - b.mien.length);
    let n = 0;
    for (const s of cands) {
      if (seen.has(s.mien) || s.mien.length > 400) continue;
      seen.add(s.mien);
      chosen.push(s);
      if (++n >= perWord) break;
    }
    if (chosen.length >= cap) break;
  }
  return chosen;
}

// ---- Dictionary page ---------------------------------------------------------
let dir = "both";
document.querySelectorAll(".seg button").forEach((b) => {
  b.onclick = () => {
    dir = b.dataset.dir;
    document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    runSearch();
  };
});
let timer;
$("q").addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(runSearch, 200); });
$("searchForm").addEventListener("submit", (e) => { e.preventDefault(); runSearch(); });

function runSearch() {
  const q = $("q").value.trim().slice(0, 100);
  const out = $("dictOut");
  out.replaceChildren();
  if (!q) { $("dictMeta").textContent = ""; return; }
  const r = search(q, dir);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $("dictMeta").textContent = r.totalEntries || r.totalSentences
    ? plural(r.totalEntries, "dictionary entry", "dictionary entries") +
      (r.totalEntries > r.entries.length ? ` (showing ${r.entries.length})` : "") +
      " · " + plural(r.totalSentences, "example sentence", "example sentences") +
      (r.totalSentences > r.sentences.length ? ` (showing ${r.sentences.length})` : "")
    : "";
  if (!r.entries.length && !r.sentences.length) { out.append(emptyState(q)); return; }
  if (r.entries.length) {
    const card = el("div", "card list"), ul = el("ul", "results entries");
    for (const e of r.entries) {
      const li = el("li"), head = el("div");
      head.append(el("span", "mien", e.mien));
      if (e.sense) head.append(el("span", "sense", `[${e.sense}]`));
      if (!e.book) head.append(el("span", "tag", "not in the book"));
      li.append(head, el("div", "gloss", e.english));
      if (e.exm) li.append(el("div", "ex", `${e.exm} = ${e.exe}`));
      li.append(el("div", "src", e.book ? `p. ${e.page}` : e.src));
      li.lastChild.title = e.book ? `Panh dictionary, page ${e.page}` : e.src;
      if (e.exm) li.append(li.querySelector(".ex"));
      ul.append(li);
    }
    card.append(ul);
    stagger(ul);
    out.append(el("h2", "section", "Dictionary"), card);
  }
  if (r.sentences.length) {
    const card = el("div", "card list"), ul = el("ul", "results pairs");
    for (const s of r.sentences) {
      const li = el("li", "pair");
      li.append(el("div", "gloss", s.mien), el("div", "en", s.english),
        el("div", "src", s.ref ? `${s.label} · ${s.ref}` : s.label));
      ul.append(li);
    }
    card.append(ul);
    stagger(ul);
    out.append(el("h2", "section", "Example sentences"), card);
  }
}

// ---- Translate page (same prompt as webapp/translate.py) -----------------------
function contentWords(text, cap = 400) {
  const seen = new Set(), out = [];
  for (const m of text.matchAll(/[A-Za-z][A-Za-z'’-]*/g)) {
    let w = m[0].toLowerCase().replace(/’/g, "'").replace(/^['-]+|['-]+$/g, "");
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= cap) break;
  }
  return out;
}

function staticSystem() {
  const verified = SENTS.filter((s) => s.confirmed).map((s) => `- ${s.english} = ${s.mien}`);
  return [
    D.instructions,
    "# The user's translation rules\n\n" + D.rules,
    "# Grammar notes\n\n" + D.grammar,
    "# Translations the user has confirmed as correct\n\n" + (verified.join("\n") || "(none yet)"),
  ].join("\n\n");
}

function requestContext(text) {
  const words = contentWords(text);
  const gloss = glossaryFor(words);
  const parts = ["# Dictionary entries for words in this text (English word: Mienh = gloss)"];
  const missing = [];
  for (const w of words) {
    const rows = gloss.get(w);
    if (!rows) { missing.push(w); continue; }
    parts.push(`- ${w}: ` + rows.map((r) => `${r.mien} = ${r.english}` + (r.book ? "" : " [fallback source]")).join("; "));
  }
  if (missing.length) parts.push("\nNot in the dictionary (describe or keep as a name): " + missing.join(", "));
  const ex = examplesFor(words);
  if (ex.length) {
    parts.push("\n# Example sentence pairs that use some of these words");
    for (const s of ex) parts.push(`- ${s.english} = ${s.mien} (${s.label})`);
  }
  return { context: parts.join("\n"), nWords: words.length, nMissing: missing.length };
}

const tag = (text, name) => {
  const m = text.match(new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`));
  return m ? m[1].trim() : "";
};
// While streaming: the part after <translation>, before </translation> if it has arrived.
function liveTranslation(text) {
  const i = text.indexOf("<translation>");
  if (i < 0) return "";
  const rest = text.slice(i + "<translation>".length);
  const j = rest.indexOf("</translation>");
  return (j < 0 ? rest : rest.slice(0, j)).replace(/^\s+/, "");
}

function updateCount() {
  const n = $("enIn").value.length;
  $("charCount").textContent = n ? `${n.toLocaleString()} characters` : "";
}
$("enIn").addEventListener("input", () => { updateCount(); store("draft", $("enIn").value); });

function fail(msg) { $("trError").replaceChildren(el("div", "banner err", msg)); }

$("goBtn").onclick = async () => {
  const text = $("enIn").value.trim();
  if (!text) { $("enIn").focus(); return; }
  $("trError").replaceChildren();
  if (!D.apiKey) { fail("Translation isn't set up yet (no API key). Dictionary lookups still work."); return; }
  if (text.length > D.maxChars) { fail(`That's too long. The limit is ${D.maxChars.toLocaleString()} characters; split it into parts.`); return; }

  const chosenModel = D.models[$("modelSel").value] ? $("modelSel").value : D.model;
  const chosenEffort = $("effortSel").value === "medium" ? "medium" : "high";
  const wantNotes = $("notesChk").checked;
  const nEnglish = text.split(/\s+/).filter(Boolean).length;
  $("goBtn").disabled = true;
  $("resetBtn").disabled = true;
  const started = Date.now();
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    $("trStatus").textContent = `Translating… ${s}s` + (s > 40 ? " (long texts take a few minutes)" : "");
  }, 1000);
  $("trStatus").textContent = "Translating…";
  $("trDots").hidden = false;
  $("trResult").hidden = false;
  $("notesBox").hidden = true;
  $("trMeta").textContent = "";
  $("mienOut").value = "";
  $("mienOut").style.height = "";

  try {
    const { context, nWords, nMissing } = requestContext(text);
    const client = new Anthropic({ apiKey: D.apiKey, dangerouslyAllowBrowser: true });
    const stream = client.beta.messages.stream({
      model: chosenModel,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: chosenEffort },
      system: [{ type: "text", text: staticSystem(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [
        { type: "text", text: context },
        { type: "text", text: (wantNotes ? "" : "Skip the notes this time: answer with only the <translation> section.\n\n") +
          "Translate this English into Iu-Mienh:\n\n" + text },
      ] }],
    });
    let soFar = "";
    stream.on("text", (t) => {
      const box = $("mienOut");
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      soFar += t;
      box.value = liveTranslation(soFar);
      fitMien();
      if (atEnd) box.scrollTop = box.scrollHeight;
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to translate this text.");
    const out = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    $("mienOut").value = tag(out, "translation") || out.trim();
    fitMien();
    const notesText = wantNotes ? tag(out, "notes") : "";
    const notes = notesText.split("\n").map((n) => n.replace(/^[-•\s]+/, "").trim()).filter(Boolean);
    $("notes").replaceChildren(...notes.map((n) => el("li", null, n)));
    $("notesBox").hidden = notes.length === 0;
    const u = msg.usage, P = (D.models[chosenModel] || {}).prices || D.prices;
    const cost = ((u.input_tokens || 0) * P.input + (u.output_tokens || 0) * P.output +
      (u.cache_read_input_tokens || 0) * P.cache_read + (u.cache_creation_input_tokens || 0) * P.cache_write) / 1e6;
    // The notes' share of the cost: their text, at about 4 characters a token, at the output price.
    const notesTok = wantNotes ? Math.round(notesText.length / 4) : 0;
    const notesUsd = (notesTok * P.output) / 1e6;
    addRun({ t: new Date().toISOString(), usd: cost, model: chosenModel, effort: chosenEffort, words: nEnglish,
      inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      outTok: u.output_tokens || 0, notes: wantNotes, notesTok, notesUsd });
    $("trMeta").textContent = `Cost about ${money(cost)} (${modelName(chosenModel)}, ${chosenEffort} effort)` +
      (wantNotes ? ` · notes ≈ ${notesTok} tokens (${money(notesUsd)})` : "") +
      ` · ${nWords} words looked up, ${nMissing} not in the dictionary` +
      (msg.stop_reason === "max_tokens" ? " · The answer was cut off: try a shorter text." : "");
    $("trStatus").textContent = "Done!";
    celebrate();
  } catch (e) {
    $("trStatus").textContent = "";
    const status = e && e.status;
    fail(status === 401 ? "The API key was rejected. It may have been revoked."
      : status === 429 ? "Too many requests right now. Try again in a minute."
      : status ? `Claude API error (${status}). Try again.`
      : (e && e.message) || "Something went wrong. Try again.");
    if (!$("mienOut").value) $("trResult").hidden = true;
  } finally {
    clearInterval(tick);
    $("trDots").hidden = true;
    $("goBtn").disabled = false;
    $("resetBtn").disabled = false;
  }
};

// ---- Model / effort choice and running cost total (kept on this device) ------
function setupOptions() {
  const sel = $("modelSel");
  sel.replaceChildren(...Object.entries(D.models).map(([id, m]) => {
    const o = el("option", null, m.label); o.value = id; return o;
  }));
  const m = load("model"), e = load("effort");
  sel.value = m && D.models[m] ? m : D.model;
  $("effortSel").value = e === "medium" ? "medium" : "high";
  sel.onchange = () => store("model", sel.value);
  $("effortSel").onchange = () => store("effort", $("effortSel").value);
  $("notesChk").checked = load("notes") !== "off";
  $("notesChk").onchange = () => store("notes", $("notesChk").checked ? null : "off");
  showTotal();
}
// Each translation on this device: {t, usd, model, effort, words, inTok, outTok, notesTok, notes}
function getRuns() {
  try {
    const h = JSON.parse(load("costHistory"));
    if (Array.isArray(h)) return h;
  } catch (e) {}
  try {  // the older one-number total becomes a single grey "earlier" bar
    const t = JSON.parse(load("costTotal"));
    if (t && t.n) return [{ t: t.since || null, usd: t.usd, n: t.n }];
  } catch (e) {}
  return [];
}
function addRun(run) {
  const h = getRuns();
  h.push(run);
  store("costHistory", JSON.stringify(h));
  store("costTotal", null);
  showTotal(true);
}
const money = (x) => (x < 0.01 && x > 0 ? `$${x.toFixed(3)}` : `$${x.toFixed(2)}`);
const modelName = (id) => (id && id.includes("sonnet") ? "Sonnet 5.5" : id ? "Opus 5.5" : "");
function runDetails(r, i) {
  const when = r.t ? new Date(r.t) : null;
  const date = when && !isNaN(when) ? when.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
  if (r.n) return [`<b>${money(r.usd)}</b> · ${r.n} earlier translations`, "Recorded before per-translation details were kept."];
  if (!r.words && r.words !== 0) return [`<b>${money(r.usd)}</b> · translation ${i + 1}`, date || "Earlier translation"];
  const lines = [
    `<b>${money(r.usd)}</b> · translation ${i + 1}${date ? ` · ${date}` : ""}`,
    `${r.words.toLocaleString()} English words · ${modelName(r.model)}, ${r.effort} effort`,
    `Tokens: ${(r.inTok || 0).toLocaleString()} in · ${(r.outTok || 0).toLocaleString()} out`,
  ];
  lines.push(r.notes === false ? "Words to check: off"
    : `Words to check: about ${(r.notesTok || 0).toLocaleString()} tokens (${money(r.notesUsd || 0)})`);
  return lines;
}
function showTotal(bump) {
  const h = getRuns();
  const total = h.reduce((a, x) => a + x.usd, 0);
  const n = h.reduce((a, x) => a + (x.n || 1), 0);
  $("spendTotal").textContent = money(total);
  const since = h.length && h[0].t ? new Date(h[0].t) : null;
  $("spendSub").textContent = n
    ? `Running total for ${n} translation${n === 1 ? "" : "s"}${since && !isNaN(since) ? ` since ${since.toLocaleDateString([], { month: "short", day: "numeric" })}` : ""} · about ${money(total / n)} each`
    : "No translations yet. Your first one will show up here.";
  $("spendReset").hidden = !n;
  if (bump) { const t = $("spendTotal"); t.classList.remove("bump"); void t.offsetWidth; t.classList.add("bump"); }
  drawBars(h);
}
function drawBars(h) {
  const box = $("spendBars"), tip = $("spendTip");
  tip.hidden = true;
  box.replaceChildren();
  if (!h.length) { $("spendMax").textContent = ""; box.append(el("div", "none", "Each translation will appear here as a bar.")); return; }
  const max = Math.max(...h.map((r) => r.usd), 0.01);
  $("spendMax").textContent = `tallest ${money(max)}`;
  const show = (bar, r, i) => {
    box.querySelectorAll(".bar.on").forEach((b) => b.classList.remove("on"));
    bar.classList.add("on");
    tip.innerHTML = runDetails(r, i).join("<br>");
    tip.hidden = false;
  };
  h.forEach((r, i) => {
    const bar = el("div", "bar" + (r.n ? " old" : r.model && r.model.includes("sonnet") ? " sonnet" : ""));
    bar.style.height = `${Math.max(3, (r.usd / max) * 100)}%`;
    bar.style.setProperty("--i", i);
    bar.tabIndex = 0;
    bar.setAttribute("aria-label", runDetails(r, i).join(". ").replace(/<[^>]+>/g, ""));
    bar.onmouseenter = bar.onfocus = bar.onclick = () => show(bar, r, i);
    box.append(bar);
  });
  box.onmouseleave = () => { tip.hidden = true; box.querySelectorAll(".bar.on").forEach((b) => b.classList.remove("on")); };
  box.scrollLeft = box.scrollWidth;
  if (!document.getElementById("spendLegend")) {
    const lg = el("div", "legend");
    lg.id = "spendLegend";
    lg.innerHTML = '<span><i style="background:linear-gradient(var(--red),var(--pink))"></i>Opus 5.5</span><span><i style="background:linear-gradient(var(--indigo),#5b6fd0)"></i>Sonnet 5.5</span>';
    box.after(lg);
  }
}
$("spendReset").onclick = () => {
  if (confirm("Set this device's spending total back to $0.00?")) {
    store("costHistory", null); store("costTotal", null); showTotal();
  }
};

// ---- Fun bits -----------------------------------------------------------------
const calm = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function stagger(ul) {
  [...ul.children].forEach((li, i) => { li.classList.add("rise"); li.style.setProperty("--i", i); });
}

function emptyState(q) {
  const box = el("div", "empty pop");
  box.append(el("span", "big", "🔍"), el("div", null, `No match for “${q}”. Check the tone letter, or try one of these:`));
  const chips = el("div", "chips");
  for (const w of ["hnyouv", "wuom", "happy", "water", "Tin-Hungh", "mother"]) {
    const c = el("button", "chip", w);
    c.type = "button";
    c.onclick = () => { $("q").value = w; runSearch(); };
    chips.append(c);
  }
  box.append(chips);
  return box;
}

function celebrate() {
  if (calm()) return;
  const card = $("resultCard"), burst = el("div", "burst");
  const colors = ["var(--red)", "var(--gold)", "var(--green)", "var(--pink)", "var(--indigo)"];
  for (let i = 0; i < 16; i++) {
    const b = el("i");
    const a = (Math.PI * 2 * i) / 16 + Math.random() * 0.4, d = 40 + Math.random() * 50;
    b.style.background = colors[i % colors.length];
    b.style.setProperty("--x", `${Math.cos(a) * d}px`);
    b.style.setProperty("--y", `${Math.sin(a) * d}px`);
    b.style.setProperty("--r", `${Math.random() * 360}deg`);
    burst.append(b);
  }
  card.append(burst);
  setTimeout(() => burst.remove(), 1000);
}

function countUp(node, to) {
  if (calm()) { node.textContent = to.toLocaleString(); return; }
  const t0 = performance.now(), dur = 1100;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    node.textContent = Math.round(to * e).toLocaleString();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Word of the day: the same word all day for everyone, or a random one on request.
let WOTD_POOL = null;
function wotdPool() {
  if (!WOTD_POOL) {
    WOTD_POOL = ENTRIES.filter((e) => e.book && e.mien.length <= 18 && /^[a-z' -]+$/i.test(e.mien) &&
      e.english.length >= 4 && e.english.length <= 70 && !/literally|abbreviation|contraction|prefix|suffix|name|^\(/i.test(e.english));
  }
  return WOTD_POOL;
}
function showWord(e) {
  const body = $("wotdBody");
  const word = el("div", "wotd-word", e.mien);
  const gloss = el("div", "wotd-gloss", e.english);
  const parts = [word, gloss];
  if (e.exm) parts.push(el("div", "wotd-ex", `${e.exm} = ${e.exe}`));
  const look = el("button", "chip", "Look it up →");
  look.type = "button";
  look.style.marginTop = "10px";
  look.onclick = () => { showTab("dict"); $("q").value = e.mien; document.querySelector('.seg [data-dir="both"]').click(); };
  parts.push(look);
  const box = el("div", "pop");
  box.append(...parts);
  body.replaceChildren(box);
}
function setupHome() {
  // Words of the title arrive one by one, in embroidery colors.
  const t = $("heroTitle"), words = t.textContent.trim().split(/\s+/);
  t.replaceChildren(...words.flatMap((w, i) => {
    const sp = el("span", "w", w); sp.style.setProperty("--i", i);
    return i ? [document.createTextNode(" "), sp] : [sp];
  }));
  countUp($("statWords"), ENTRIES.filter((e) => e.book).length);
  countUp($("statSents"), SENTS.length);
  const pool = wotdPool();
  if (pool.length) {
    const day = new Date().toISOString().slice(0, 10);
    let h = 0; for (const c of day) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    showWord(pool[h % pool.length]);
  }
  $("wotdNext").onclick = () => { const p = wotdPool(); if (p.length) showWord(p[Math.floor(Math.random() * p.length)]); };
  $("goDict").onclick = () => { showTab("dict"); $("q").focus(); };
  $("goTr").onclick = () => { showTab("tr"); $("enIn").focus(); };
  $("brandBtn").onclick = () => showTab("home");
}

// Reset: forget the English draft and reload the page, which clears the
// translation, notes and messages too. The password and tab stay remembered.
$("resetBtn").onclick = () => {
  store("draft", null);
  $("enIn").value = "";
  try { sessionStorage.setItem("startTab", "tr"); } catch (e) {}
  location.reload();
};

// The Mienh box grows to fit its text, so long translations spill down the page.
function fitMien() {
  const t = $("mienOut");
  const cap = parseFloat(getComputedStyle(t).maxHeight) || Infinity;
  const need = Math.min(t.scrollHeight + 2, cap);
  if (need > t.offsetHeight) t.style.height = `${need}px`;
}
$("mienOut").addEventListener("input", fitMien);
window.addEventListener("resize", () => { if (!$("trResult").hidden) fitMien(); });

$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText($("mienOut").value); $("copyBtn").textContent = "Copied"; }
  catch (e) { $("mienOut").select(); }
  setTimeout(() => ($("copyBtn").textContent = "Copy"), 1500);
};

// ---- Tabs and start ----------------------------------------------------------
const tabs = { home: [$("tab-home"), $("panel-home")], dict: [$("tab-dict"), $("panel-dict")], tr: [$("tab-tr"), $("panel-tr")] };
function showTab(name) {
  for (const [k, [btn, panel]] of Object.entries(tabs)) {
    const on = k === name, was = !panel.hidden;
    btn.setAttribute("aria-selected", String(on));
    panel.hidden = !on;
    if (on && !was) {
      // replay the slide-in for this page's cards
      panel.querySelectorAll(".rise").forEach((n) => { n.style.animation = "none"; void n.offsetWidth; n.style.animation = ""; });
    }
  }
  if (name === "tr") { showTotal(); if (!$("trResult").hidden) fitMien(); }
}
$("tab-home").onclick = () => showTab("home");
$("tab-dict").onclick = () => { showTab("dict"); $("q").focus(); };
$("tab-tr").onclick = () => { showTab("tr"); $("enIn").focus(); };

(async () => {
  const saved = load("pw");
  if (saved) {
    try { if (await tryUnlock(saved, true)) return; } catch (e) {}
    store("pw", null);
  }
  $("loading").hidden = true;
  $("unlock").hidden = false;
  $("pw").focus();
})();
