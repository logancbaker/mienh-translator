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
  $("unlockBtn").disabled = false;
  $("unlockBtn").textContent = "Open";
});

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
  $("loading").hidden = true;
  $("unlock").hidden = true;
  $("app").hidden = false;
  try {
    const d = load("draft");
    if (d) { $("enIn").value = d; updateCount(); }
  } catch (e) {}
  showTab(load("tab") === "tr" ? "tr" : "dict");
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
  if (!r.entries.length && !r.sentences.length) { out.append(el("div", "empty", `Nothing found for “${q}”.`)); return; }
  if (r.entries.length) {
    const card = el("div", "card"), ul = el("ul", "results");
    for (const e of r.entries) {
      const li = el("li"), head = el("div");
      head.append(el("span", "mien", e.mien));
      if (e.sense) head.append(el("span", "sense", `[${e.sense}]`));
      if (!e.book) head.append(el("span", "tag", "not in the book"));
      li.append(head, el("div", "gloss", e.english));
      if (e.exm) li.append(el("div", "ex", `${e.exm} = ${e.exe}`));
      li.append(el("div", "src", e.book ? `Panh dictionary, p. ${e.page}` : e.src));
      ul.append(li);
    }
    card.append(ul);
    out.append(el("h2", "section", "Dictionary"), card);
  }
  if (r.sentences.length) {
    const card = el("div", "card"), ul = el("ul", "results");
    for (const s of r.sentences) {
      const li = el("li", "pair");
      li.append(el("div", "gloss", s.mien), el("div", "en", s.english),
        el("div", "src", s.ref ? `${s.label} · ${s.ref}` : s.label));
      ul.append(li);
    }
    card.append(ul);
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

  $("goBtn").disabled = true;
  $("clearBtn").disabled = true;
  const started = Date.now();
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    $("trStatus").textContent = `Translating… ${s}s` + (s > 40 ? " (long texts take a few minutes)" : "");
  }, 1000);
  $("trStatus").textContent = "Translating…";
  $("trResult").hidden = false;
  $("notesBox").hidden = true;
  $("trMeta").textContent = "";
  $("mienOut").value = "";

  try {
    const { context, nWords, nMissing } = requestContext(text);
    const client = new Anthropic({ apiKey: D.apiKey, dangerouslyAllowBrowser: true });
    const stream = client.beta.messages.stream({
      model: D.model,
      max_tokens: 64000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high" },
      system: [{ type: "text", text: staticSystem(), cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [
        { type: "text", text: context },
        { type: "text", text: "Translate this English into Iu-Mienh:\n\n" + text },
      ] }],
    });
    let soFar = "";
    stream.on("text", (t) => { soFar += t; $("mienOut").value = liveTranslation(soFar); });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to translate this text.");
    const out = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    $("mienOut").value = tag(out, "translation") || out.trim();
    const notes = tag(out, "notes").split("\n").map((n) => n.replace(/^[-•\s]+/, "").trim()).filter(Boolean);
    $("notes").replaceChildren(...notes.map((n) => el("li", null, n)));
    $("notesBox").hidden = notes.length === 0;
    const u = msg.usage, P = D.prices;
    const cost = ((u.input_tokens || 0) * P.input + (u.output_tokens || 0) * P.output +
      (u.cache_read_input_tokens || 0) * P.cache_read + (u.cache_creation_input_tokens || 0) * P.cache_write) / 1e6;
    $("trMeta").textContent = `Cost about $${cost.toFixed(2)} · ${nWords} words looked up, ${nMissing} not in the dictionary` +
      (msg.stop_reason === "max_tokens" ? " · The answer was cut off: try a shorter text." : "");
    $("trStatus").textContent = "Done.";
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
    $("goBtn").disabled = false;
    $("clearBtn").disabled = false;
  }
};

// Clear the English, the translation, notes and messages.
$("clearBtn").onclick = () => {
  $("enIn").value = "";
  store("draft", null);
  updateCount();
  $("mienOut").value = "";
  $("notes").replaceChildren();
  $("notesBox").hidden = true;
  $("trMeta").textContent = "";
  $("trStatus").textContent = "";
  $("trError").replaceChildren();
  $("trResult").hidden = true;
  $("enIn").focus();
};

$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText($("mienOut").value); $("copyBtn").textContent = "Copied"; }
  catch (e) { $("mienOut").select(); }
  setTimeout(() => ($("copyBtn").textContent = "Copy"), 1500);
};

// ---- Tabs and start ----------------------------------------------------------
const tabs = { dict: [$("tab-dict"), $("panel-dict")], tr: [$("tab-tr"), $("panel-tr")] };
function showTab(name) {
  for (const [k, [btn, panel]] of Object.entries(tabs)) {
    btn.setAttribute("aria-selected", String(k === name));
    panel.hidden = k !== name;
  }
  store("tab", name);
}
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
