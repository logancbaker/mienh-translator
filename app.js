// Mienh Translator (static site). The private data arrives encrypted in
// data.json; it is decrypted here, in the browser, with the shared password.
import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.3.0/+esm";

const $ = (id) => document.getElementById(id);
// Macs use ⌘-click for "add a word"; the hint on the Bible page says so.
if (/Macintosh/.test(navigator.userAgent) && !("ontouchend" in document)) document.documentElement.classList.add("is-mac");
let D = null; // decrypted data
// A personal Compare link (?go=code from the batch email) opens Compare as that speaker.
try {
  const go = new URLSearchParams(location.search).get("go");
  if (go) { sessionStorage.setItem("goCompare", go); history.replaceState(null, "", location.pathname); }
} catch (e) {}

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

let ENC = null, PW = null;
async function tryUnlock(password, remember) {
  if (!ENC) ENC = await (await fetch("data.json", { cache: "no-cache" })).json();
  let data;
  try { data = await decrypt(ENC, password); }
  catch (e) { return false; }
  store("pw", remember ? password : null);
  PW = password;
  init(data);
  return true;
}

// Pick up a newer publish (new corrections, rules, dictionary pages) without a reload:
// checked before every translation and whenever the app comes back to the screen.
let refreshing = null;
// Newer code (not just data) needs a page reload. The version is the ?v= on this script's
// link, and every publish writes the current one, unencrypted, into data.json as "code".
const CODE_VER = new URL(import.meta.url).searchParams.get("v");
let newCode = false, newCodeVer = null;
function reloadForNewCode(thenTranslate) {
  try {
    sessionStorage.setItem("reloadedFor", newCodeVer || "");
    if (thenTranslate) sessionStorage.setItem("autoTranslate", "1");
    if (PW && !load("pw")) sessionStorage.setItem("pwOnce", PW);  // not remembered: carry it over this one reload
  } catch (e) {}
  location.replace(location.pathname + "?r=" + Date.now());  // skip the browser's 10-minute copy of the page
}
async function refreshData(quiet) {
  if (!PW || !ENC) return false;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const fresh = await (await fetch("data.json", { cache: "no-cache" })).json();
      if (fresh.code && fresh.code !== CODE_VER) {  // no ?v= at all: a very old page
        let tried = null;
        try { tried = sessionStorage.getItem("reloadedFor"); } catch (e) {}
        newCode = tried !== fresh.code;  // reload once per publish, never in a loop
        newCodeVer = fresh.code;
      }
      if (fresh.data === ENC.data) return false;
      const data = await decrypt(fresh, PW);
      ENC = fresh;
      loadData(data);
      if ($("panel-bible").hidden) setupBible();  // new chapters show up; don't redraw under a reader
      if ($("panel-gc").hidden) setupGC();
      if (!quiet) toast("Updated with the latest corrections and dictionary");
      return true;
    } catch (e) {
      return false;  // offline or password changed: keep using what's loaded
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) return;
  await refreshData();
  // Back on the page with nothing on screen to lose: load the new code now.
  if (newCode && !busy && $("trResult").hidden) reloadForNewCode(false);
});

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
  loadData(data);
  setupOptions();
  initUI();
  setupBible();
  setupGC();
  setupCompare();
  let go = null;
  try { go = sessionStorage.getItem("goCompare"); sessionStorage.removeItem("goCompare"); } catch (e) {}
  const goWho = go && (D.links || {})[go];
  if (goWho && D.compare && D.compare.length) {
    $("userSel").value = goWho; store("user", goWho); updateUserState();
    showTab("cmp");
  }
  if (location.search.includes("r=")) history.replaceState(null, "", location.pathname);
  let auto = false;
  try { auto = sessionStorage.getItem("autoTranslate") === "1"; sessionStorage.removeItem("autoTranslate"); } catch (e) {}
  if (auto) { showTab("tr"); setTimeout(() => $("goBtn").click(), 200); }  // reloaded for new code mid-request
}
function loadData(data) {
  D = data;
  EN_INDEX = new Map();
  SENT_INDEX = new Map();
  WOTD_POOL = null;
  ENTRIES = data.entries.map(([mien, sense, english, exm, exe, page, book, src, rank, ctx, gospel, match, uses, usesBy]) => ({
    mien, sense, english, exm, exe, page, book: !!book, src, rank: rank ?? (book ? 1 : 2), corr: rank === 0, ctx,
    gospel: !!gospel, match: match || "", uses: uses || 0, usesBy: usesBy || {},
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
}
function initUI() {
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
  updateUserState();
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
    if (score !== null) hits.push([r.rank, score, -r.uses, r.mien.length, r.mien.toLowerCase(), r]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0));
  const sh = SENTS.filter((s) => (dir !== "en" && rx.test(s.nmien)) || (dir !== "mien" && rx.test(s.nen)));
  sh.sort((a, b) => (a.confirmed ? 0 : 1) - (b.confirmed ? 0 : 1) || a.mien.length - b.mien.length);
  return { entries: hits.slice(0, limit).map((h) => h[5]), sentences: sh.slice(0, sentLimit),
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
    // Within each rank, words used in the official texts come first (most used first).
    const found = [...idx].map((i) => ENTRIES[i]).map((r) => [r.rank, glossHit(r.nen, forms) ? 0 : 1, r.uses ? 0 : 1, -r.uses, r.nen.length, r]);
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[4] - b[4]);
    if (found.length) out.set(w, found.slice(0, perWord).map((f) => f[5]));
  }
  return out;
}

function examplesFor(words, perWord = 2, cap = 60) {
  const chosen = [], seen = new Set();
  for (const w of words) {
    const idx = new Set(wordForms(w).flatMap((f) => SENT_INDEX.get(f) || []));
    const cands = [...idx].map((i) => SENTS[i]);
    const gos = (x) => (x.label.includes("Mienh My Gospel") ? 0 : 1);  // the user's gospel wording next
    cands.sort((a, b) => (a.confirmed ? 0 : 1) - (b.confirmed ? 0 : 1) || gos(a) - gos(b) || a.mien.length - b.mien.length);
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
      if (e.gospel) head.append(el("span", "tag gospel", "LDS gospel term"));
      else if (e.corr) head.append(el("span", "tag corr", "fluent speaker"));
      else if (!e.book) head.append(el("span", "tag", "not in the Panh dictionary"));
      if (e.uses && !e.gospel && !e.corr) head.append(usesTag(e));
      li.append(head, el("div", "gloss", e.english));
      if (e.exm) li.append(el("div", "ex", `${e.exm} = ${e.exe}`));
      li.append(el("div", "src", e.book ? `p. ${e.page}` : e.gospel ? `Mienh My Gospel p. ${e.page}`
        : e.corr ? e.src.replace("Correction from ", "") : e.src));
      if (e.gospel && e.ctx) li.append(el("div", "ex", e.ctx));
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

// Gospel terms from the user's Mienh My Gospel guide: what LDS Mienh actually say.
// They come first for anything gospel-related (same logic as webapp/translate.py).
function gospelKeys(english) {
  return english.split(";").map((p) => p.replace(/\([^)]*\)/g, " ").toLowerCase().replace(/\s+/g, " ").trim()
    .replace(/^(the|to|a|an) /, "")).filter((p) => p.length >= 3);
}
const escRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The first letter may be capitalized at the start of a sentence.
const firstCase = (k) => (/^[a-z]/i.test(k) ? `[${k[0].toLowerCase()}${k[0].toUpperCase()}]` + escRx(k.slice(1)) : escRx(k));
const hasPhrase = (k, t) => new RegExp("(?<![\\w'])" + firstCase(k) + "(?:s|es)?(?![\\w'])").test(t);
// A term's `match` list (case-sensitive phrases) overrides matching on its English gloss.
function gospelMatches(text) {
  const plain = text.replace(/’/g, "'").replace(/\s+/g, " "), low = plain.toLowerCase();
  return ENTRIES.filter((r) => {
    if (!r.gospel) return false;
    const exact = r.match.split(";").map((m) => m.trim()).filter(Boolean);
    return exact.length ? exact.some((m) => hasPhrase(m, plain)) : gospelKeys(r.english).some((k) => hasPhrase(k, low));
  });
}

function staticSystem() {
  const verified = SENTS.filter((s) => s.confirmed).map((s) => `- ${s.english} = ${s.mien}`);
  const gospel = ENTRIES.filter((r) => r.gospel).map((r) => `- ${r.english} = ${r.mien}` + (r.ctx ? ` (${r.ctx})` : ""));
  const corr = ENTRIES.filter((r) => r.corr).map((r) => `- ${r.english} = ${r.mien} (${r.src.replace("Correction ", "")}${r.ctx ? `; in: ${r.ctx}` : ""})`);
  return [
    D.instructions,
    "# Gospel terms LDS Mienh members use (from the user's Mienh My Gospel guide; they come first for anything gospel-related)\n\n" + (gospel.join("\n") || "(none yet)"),
    "# Corrections from fluent Mienh speakers (they override the Panh dictionary's word choice)\n\n" + (corr.join("\n") || "(none yet)"),
    "# The user's translation rules\n\n" + D.rules,
    "# Grammar notes\n\n" + D.grammar,
    "# Translations the user has confirmed as correct\n\n" + (verified.join("\n") || "(none yet)"),
  ].join("\n\n");
}

function requestContext(text) {
  const words = contentWords(text);
  const gloss = glossaryFor(words);
  const parts = [];
  const gospel = gospelMatches(text);
  if (gospel.length) {
    parts.push("# REQUIRED: gospel terms in this text, as LDS Mienh members say them (Mienh My Gospel guide). Use these word for word.");
    for (const r of gospel) parts.push(`- "${r.english}" → ${r.mien}`);
    parts.push("");
  }
  const low = text.toLowerCase();
  const must = ENTRIES.filter((r) => r.corr && r.english && low.includes(r.english.toLowerCase()));
  if (must.length) {
    parts.push("# REQUIRED: fluent-speaker corrections for phrases in this exact text. Use these Mienh renderings word for word.");
    for (const r of must) parts.push(`- "${r.english}" → ${r.mien}`);
    parts.push("");
  }
  parts.push("# Dictionary entries for words in this text (English word: Mienh = gloss)");
  const missing = [];
  for (const w of words) {
    const rows = gloss.get(w);
    if (!rows) { missing.push(w); continue; }
    parts.push(`- ${w}: ` + rows.map((r) => `${r.mien} = ${r.english}` + (r.gospel ? " [LDS gospel term]" : r.corr ? " [fluent speaker]" : r.book ? "" : " [fallback source]") +
      (r.uses ? ` [used ${r.uses}× in official texts]` : "")).join("; "));
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

// ---- Estimated translation time ---------------------------------------------------
// Seconds per translation grow a little slower than the word count, so the estimate fits
// seconds = c × words^p (a straight line on a log-log scale) to past runs.
// Starting points: the Usage tab of the corrections Sheet (Opus 5.5, high effort, Nov 12–14 2026).
// Each device then adds its own runs (saved with the cost history), so estimates keep improving.
const SEED_RUNS = [[1358,151],[181,86],[1606,286],[26,15],[1514,219],[4,7],[1565,248],[193,47],[138,45],[59,26],[138,53],[59,28]]
  .map(([words, seconds]) => ({ words, seconds, model: "claude-opus-5-5", effort: "high" }));
function timeRuns() {
  const own = getRuns().filter((r) => r.words > 0 && r.seconds > 0);
  return SEED_RUNS.concat(own);
}
function estimateSeconds(words, model, effort) {
  if (!words) return 0;
  let pts = timeRuns();
  const same = pts.filter((r) => r.model === model && r.effort === effort);
  if (same.length >= 3) pts = same;     // enough runs with these settings: use only those
  const X = pts.map((r) => Math.log(r.words)), Y = pts.map((r) => Math.log(r.seconds));
  const n = X.length, mx = X.reduce((a, b) => a + b, 0) / n, my = Y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0;
  X.forEach((x, i) => { sxy += (x - mx) * (Y[i] - my); sxx += (x - mx) ** 2; });
  const p = sxx ? sxy / sxx : 0.6, c = Math.exp(my - p * mx);
  return c * Math.pow(words, p);
}
function fmtDuration(s) {
  if (s < 15) return "a few seconds";
  if (s < 55) return `about ${Math.round(s / 5) * 5} seconds`;
  if (s < 90) return "about 1 minute";
  return `about ${Math.round(s / 60)} minutes`;
}
function currentEstimate() {
  const words = $("enIn").value.split(/\s+/).filter(Boolean).length;
  const model = D && D.models && D.models[$("modelSel").value] ? $("modelSel").value : (D && D.model);
  const effort = $("effortSel").value === "medium" ? "medium" : "high";
  return { words, seconds: estimateSeconds(words, model, effort) };
}
function updateCount() {
  const n = $("enIn").value.length;
  const { words, seconds } = n ? currentEstimate() : { words: 0, seconds: 0 };
  $("charCount").textContent = n
    ? `${words.toLocaleString()} words · ${n.toLocaleString()} characters · estimated time ${fmtDuration(seconds)}` : "";
}
$("modelSel").addEventListener("change", updateCount);
$("effortSel").addEventListener("change", updateCount);
$("enIn").addEventListener("input", () => { updateCount(); store("draft", $("enIn").value); });

function fail(msg) { $("trError").replaceChildren(el("div", "banner err", msg)); }

// ---- Who is translating (remembered on this device) ------------------------------
// The same name is used for corrections; Sister Hahn can translate but not send corrections.
const NO_CORRECTIONS = ["Sister Hahn"];
let busy = false;
const currentUser = () => $("userSel").value;
function updateUserState() {
  const user = currentUser();
  $("userSel").closest(".user-pick").classList.toggle("need", !user);
  $("needUser").hidden = !!user;
  $("goBtn").disabled = busy || !user;
  $("goBtn").title = user ? "" : "Choose your name first";
  const canCorrect = !!user && !NO_CORRECTIONS.includes(user);
  $("corrBtn").disabled = !canCorrect;
  $("corrBtn").title = !user ? "Choose your name first" : canCorrect ? "" : "Corrections aren't available for this user";
  if (!canCorrect && correcting) setCorrecting(false);
}
$("userSel").value = ["Gauv Meng", "Meix Waah", "Yauz-Seng", "Zanx Jiemh", "Sister Hahn"].includes(load("user")) ? load("user") : "";
$("userSel").onchange = () => { store("user", currentUser() || null); updateUserState(); };

// Each translation is also logged to the "Usage" tab of the Google Sheet.
function logUsage(rec) {
  const cfg = D.corrections || {};
  if (!cfg.url) return;
  const body = JSON.stringify({ token: cfg.token, kind: "usage", ...rec });
  fetch(cfg.url, { method: "POST", body })
    .catch(() => fetch(cfg.url, { method: "POST", mode: "no-cors", body }).catch(() => {}));
}

// ---- Keeping the rules cache warm (user, 2026-11-19) -------------------------------
// Every translation sends the same large rules package (instructions, gospel terms,
// corrections, grammar notes, confirmed sentences) as a cached system prompt. A cache entry
// lives 5 minutes from the start of the last request that used it; reading it costs about
// 5% of the normal price, saving it about 125%. Translations are often far apart, so after a
// translation, while this page stays open on the Translate tab and someone is using it, a
// tiny request (max_tokens: 0: no answer, only a cache read) refreshes the entry about every
// 4 minutes, for up to 30 minutes. The prompt itself is never changed, so quality is the same.
function sharedParams(model, effort, sysText) {
  // Everything that shapes the cached prefix, identical for translations and refreshes.
  return {
    model,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort },
    system: [{ type: "text", text: sysText, cache_control: { type: "ephemeral" } }],
  };
}
const WARM = { every: 235e3, max: 30 * 60e3, idle: 15 * 60e3 };
let warm = null, lastActive = Date.now();
for (const ev of ["pointerdown", "keydown", "scroll", "touchstart"]) {
  addEventListener(ev, () => { lastActive = Date.now(); }, { passive: true });
}
function stopWarm() { if (warm) { clearInterval(warm.timer); warm = null; } }
function startWarm(model, effort, sysText, startedAt) {
  stopWarm();
  warm = { model, effort, sysText, since: startedAt, last: startedAt, busy: false };
  warm.timer = setInterval(warmTick, 20e3);
}
async function warmTick() {
  const w = warm;
  if (!w || w.busy || busy) return;
  const now = Date.now();
  if (now - w.since > WARM.max || now - lastActive > WARM.idle || document.hidden || $("panel-tr").hidden) {
    if (now - w.since > WARM.max || now - lastActive > WARM.idle) stopWarm();
    return;  // tab hidden or on another page: skip this time
  }
  if (now - w.last < WARM.every) return;
  // Only refresh the very same prompt; if new data arrived, a refresh would pay for a new save.
  if (staticSystem() !== w.sysText || !D.apiKey) { stopWarm(); return; }
  w.busy = true;
  w.last = now;
  try {
    const client = new Anthropic({ apiKey: D.apiKey, dangerouslyAllowBrowser: true });
    const msg = await client.beta.messages.create({
      ...sharedParams(w.model, w.effort, w.sysText),
      max_tokens: 0,
      messages: [{ role: "user", content: "." }],
    });
    const u = msg.usage || {}, P = (D.models[w.model] || {}).prices || D.prices;
    const cost = ((u.input_tokens || 0) * P.input + (u.cache_read_input_tokens || 0) * P.cache_read +
      (u.cache_creation_input_tokens || 0) * P.cache_write) / 1e6;
    if ((u.cache_creation_input_tokens || 0) > 0) stopWarm();  // the entry had already expired: don't keep paying for saves
    logUsage({ user: currentUser(), words: 0, paragraphs: 0, model: `${modelName(w.model)} (keep cache warm)`,
      effort: w.effort, inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      outTok: 0, notes: false, notesTok: 0, notesUsd: 0, usd: Number(cost.toFixed(5)), seconds: 0 });
  } catch (e) {
    stopWarm();  // offline, or the API refused: just stop; the next translation works as usual
  } finally {
    if (warm === w) w.busy = false;
  }
}

$("goBtn").onclick = async () => {
  const text = $("enIn").value.trim();
  if (!currentUser()) { $("userSel").focus(); return; }
  if (!text) { $("enIn").focus(); return; }
  $("trError").replaceChildren();
  $("trStatus").textContent = "Checking for updates…";
  await refreshData(true);
  if (newCode) {
    $("trStatus").textContent = "The website was updated. Loading the new version…";
    reloadForNewCode(true);  // the English draft is saved; the translation starts again by itself
    return;
  }
  $("trStatus").textContent = "";
  if (!D.apiKey) { fail("Translation isn't set up yet (no API key). Dictionary lookups still work."); return; }
  if (text.length > D.maxChars) { fail(`That's too long. The limit is ${D.maxChars.toLocaleString()} characters; split it into parts.`); return; }

  const chosenModel = D.models[$("modelSel").value] ? $("modelSel").value : D.model;
  const chosenEffort = $("effortSel").value === "medium" ? "medium" : "high";
  lastModel = chosenModel;
  if (correcting) setCorrecting(false);
  const wantNotes = $("notesChk").checked;
  const nEnglish = text.split(/\s+/).filter(Boolean).length;
  const paras = splitParas(text);
  lastEnglish = paras;
  const toSend = paras.length > 1
    ? "The English is split into numbered paragraphs ([1], [2], …). Translate every paragraph and start each Mienh paragraph with the same number in brackets, one Mienh paragraph per number, so the two stay paired.\n\n" + paras.map((x, i) => `[${i + 1}] ${x}`).join("\n\n")
    : text;
  busy = true;
  $("goBtn").disabled = true;
  $("resetBtn").disabled = true;
  const started = Date.now();
  const est = Math.round(estimateSeconds(nEnglish, chosenModel, chosenEffort));
  const tick = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    $("trStatus").textContent = `Translating… ${s}s` +
      (s <= est ? ` of about ${est}s` : s > 40 ? " (taking a bit longer than usual)" : "");
  }, 1000);
  $("trStatus").textContent = "Translating…";
  $("trDots").hidden = false;
  $("trResult").hidden = false;
  $("notesBox").hidden = true;
  $("meaningBox").hidden = true;
  $("trMeta").textContent = "";
  $("mienOut").value = "";
  $("mienOut").style.height = "";

  try {
    const { context, nWords, nMissing } = requestContext(text);
    const client = new Anthropic({ apiKey: D.apiKey, dangerouslyAllowBrowser: true });
    const sysText = staticSystem();
    stopWarm();  // this request refreshes the cache itself
    const stream = client.beta.messages.stream({
      ...sharedParams(chosenModel, chosenEffort, sysText),
      max_tokens: 64000,
      messages: [{ role: "user", content: [
        { type: "text", text: context },
        { type: "text", text: (wantNotes ? "" : "Skip the notes this time: answer with only the <meaning> and <translation> sections.\n\n") +
          "Translate this English into Iu-Mienh:\n\n" + toSend },
      ] }],
    });
    let soFar = "";
    stream.on("text", (t) => {
      const box = $("mienOut");
      const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
      soFar += t;
      const live = liveTranslation(soFar);
      if (!live && soFar.includes("<meaning>")) $("trStatus").textContent = "Understanding the English first…";
      else if (live && $("trStatus").textContent.startsWith("Understanding")) $("trStatus").textContent = "Translating…";
      box.value = unmark(live);
      if ($("sideChk").checked) renderSide();
      fitMien();
      if (atEnd) box.scrollTop = box.scrollHeight;
    });
    const msg = await stream.finalMessage();
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to translate this text.");
    const out = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    $("mienOut").value = readParas(tag(out, "translation") || out.trim(), paras.length).join("\n\n");
    fitMien();
    renderSide();
    const meaning = tag(out, "meaning");
    const mLines = meaning.split("\n").map((n) => n.replace(/^[-•\s]+/, "").trim()).filter(Boolean);
    $("meaning").replaceChildren(...mLines.map((n) => el("li", null, n)));
    $("meaningBox").hidden = mLines.length === 0;
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
      seconds: Math.round((Date.now() - started) / 1000),
      inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      outTok: u.output_tokens || 0, notes: wantNotes, notesTok, notesUsd });
    logUsage({ user: currentUser(), words: nEnglish, paragraphs: paras.length, model: modelName(chosenModel),
      effort: chosenEffort,
      inTok: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      outTok: u.output_tokens || 0, notes: wantNotes, notesTok, notesUsd: Number(notesUsd.toFixed(5)),
      usd: Number(cost.toFixed(5)), seconds: Math.round((Date.now() - started) / 1000) });
    startWarm(chosenModel, chosenEffort, sysText, started);
    const cacheNote = (u.cache_read_input_tokens || 0) > 0 ? " · rules read from the cache"
      : (u.cache_creation_input_tokens || 0) > 0 ? " · rules saved to the cache" : " · not cached";
    $("trMeta").textContent = `Cost about ${money(cost)} (${modelName(chosenModel)}, ${chosenEffort} effort)${cacheNote}` +
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
    busy = false;
    updateUserState();
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
  lastEnglish = [];
  $("enIn").value = "";
  try { sessionStorage.setItem("startTab", "tr"); } catch (e) {}
  location.reload();
};

// ---- Paragraph pairing, side-by-side view, print and PDF ------------------------
let lastEnglish = [];
function splitParas(t) {
  t = t.replace(/\r\n?/g, "\n").trim();
  let parts = t.split(/\n\s*\n/);
  if (parts.length === 1 && t.includes("\n")) parts = t.split("\n");  // pasted text with single line breaks
  return parts.map((x) => x.trim()).filter(Boolean);
}
// "[1] … [2] …" (or plain paragraphs) -> list of Mienh paragraphs
function readParas(t, n) {
  if (/\[\d+\]/.test(t)) {
    const out = [];
    t.split(/\[(\d+)\]/).forEach((chunk, i, arr) => {
      if (i % 2 === 1) out[Number(chunk) - 1] = (arr[i + 1] || "").trim();
    });
    return Array.from({ length: Math.max(out.length, n) }, (_, i) => out[i] || "");
  }
  return splitParas(t);
}
const unmark = (t) => t.replace(/\s*\[\d+\]\s*/g, "\n\n").trim();

function pairs() {
  const mi = $("mienOut").value.trim() ? $("mienOut").value.split(/\n\s*\n/).map((x) => x.trim()) : [];
  const n = Math.max(mi.length, lastEnglish.length);
  return Array.from({ length: n }, (_, i) => ({ mi: mi[i] || "", en: lastEnglish[i] || "" }));
}
function renderSide() {
  const on = $("sideChk").checked;
  $("sideView").hidden = !on;
  $("mienOut").hidden = on;
  const hint = $("sideHint");
  hint.hidden = true;
  if (!on) { fitMien(); return; }
  const rows = pairs();
  $("sideBody").replaceChildren(...rows.map((r, i) => {
    const tr = el("tr");
    tr.dataset.i = i;
    const mi = el("td", "mi", r.mi), en = el("td", "en", r.en);
    mi.contentEditable = correcting || dictOn ? "false" : "true";
    mi.spellcheck = false;
    mi.dataset.i = i;
    mi.oninput = () => {  // edits here flow back into the Mienh text
      const cells = [...$("sideBody").querySelectorAll("td.mi")].map((c) => c.innerText.trim());
      $("mienOut").value = cells.join("\n\n");
    };
    tr.append(mi, en);
    return tr;
  }));
  const mCount = rows.filter((r) => r.mi).length, eCount = lastEnglish.length;
  if (eCount && mCount && mCount !== eCount) {
    hint.textContent = `Heads up: ${eCount} English paragraphs but ${mCount} Mienh paragraphs, so some rows may not line up.`;
    hint.hidden = false;
  }
}
// On by default; turning it off is remembered on this device.
$("sideChk").checked = load("side") !== "off";
$("sideChk").onchange = () => { store("side", $("sideChk").checked ? null : "off"); renderSide(); };

function today() { return new Date().toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" }); }

// Print and PDF are shared by the Translate tab and the two readers (Scriptures, General
// Conference; 2026-11-19). rows = [{ mi, en, head }]: head rows are section headings.
// side = English beside the Mienh. title / sub (optional) go at the top.
function printRows({ rows, side, title, sub }) {
  const area = $("printArea");
  const head = el("div", "p-head");
  head.append(el("span", null, "Mienh Translator"), el("span", null, today()));
  area.replaceChildren(head);
  if (title) area.append(el("h1", "p-title", title));
  if (sub) area.append(el("div", "p-sub", sub));
  if (side) {
    const t = el("table"), thead = el("thead"), hr = el("tr"), tb = el("tbody");
    hr.append(el("th", null, "Mienh"), el("th", null, "English"));
    thead.append(hr);
    for (const r of rows) {
      const tr = el("tr", r.head ? "h" : null);
      tr.append(el("td", "mi", r.mi), el("td", "en", r.en));
      tb.append(tr);
    }
    t.append(thead, tb);
    area.append(t);
  } else {
    for (const r of rows.filter((x) => x.mi)) area.append(el("p", r.head ? "h" : null, r.mi));
  }
  window.print();
}

// PDF: drawn with jsPDF so both columns stay on the same lines across pages.
let jsPDFLoad = null;
function loadJsPDF() {
  if (!jsPDFLoad) {
    jsPDFLoad = new Promise((ok, bad) => {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
      sc.onload = () => ok(window.jspdf.jsPDF);
      sc.onerror = () => { jsPDFLoad = null; bad(new Error("Couldn't load the PDF maker. Check the connection.")); };
      document.head.append(sc);
    });
  }
  return jsPDFLoad;
}
// jsPDF's built-in fonts only know Latin-1 + a few marks; swap anything else for a close equivalent.
const pdfSafe = (t) => t.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"')
  .replace(/↔/g, "<->").replace(/→/g, "->").replace(/[–—]/g, "-").replace(/…/g, "...")
  .replace(/[^\x09\x0a\x0d\x20-\x7e\xa0-\xff]/g, "");
const fileSafe = (t) => pdfSafe(t).replace(/[\\/:*?"<>|^]+/g, "").replace(/\s+/g, " ").trim().slice(0, 90) || "mienh";

async function pdfRows({ rows, side, title, sub, file, btn, label }) {
  btn.disabled = true; btn.textContent = "Making PDF…";
  try {
    const JsPDF = await loadJsPDF();
    const doc = new JsPDF({ unit: "pt", format: "letter" });
    const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
    const M = 40, top = M + 26, bottom = H - M, gutter = 22, size = 10.5, lh = size * 1.42;
    const colW = side ? (W - 2 * M - gutter) / 2 : W - 2 * M;
    let page = 1, y = top;
    const colHeads = () => {
      if (!side) return;
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(60);
      doc.text("MIENH", M, y + 6); doc.text("ENGLISH", M + colW + gutter, y + 6);
      y += 16;
    };
    const header = () => {
      doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(110);
      doc.text("Mienh Translator", M, M + 6);
      doc.text(`${today()}  ·  page ${page}`, W - M, M + 6, { align: "right" });
      doc.setDrawColor(170); doc.setLineWidth(0.5); doc.line(M, M + 12, W - M, M + 12);
      y = top - 8;
      colHeads();
      doc.setTextColor(0);
    };
    const newPage = () => { doc.addPage(); page += 1; header(); };
    // title block on the first page
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(110);
    doc.text("Mienh Translator", M, M + 6);
    doc.text(`${today()}  ·  page 1`, W - M, M + 6, { align: "right" });
    doc.setDrawColor(170); doc.setLineWidth(0.5); doc.line(M, M + 12, W - M, M + 12);
    y = top - 8;
    if (title) {
      doc.setFont("times", "bold"); doc.setFontSize(17); doc.setTextColor(0);
      for (const line of doc.splitTextToSize(pdfSafe(title), W - 2 * M)) { doc.text(line, M, y + 17); y += 21; }
    }
    if (sub) {
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); doc.setTextColor(90);
      for (const line of doc.splitTextToSize(pdfSafe(sub), W - 2 * M)) { doc.text(line, M, y + 10); y += 13; }
    }
    if (title || sub) y += 10;
    colHeads();
    doc.setTextColor(0);
    for (const r of rows) {
      const font = r.head ? "bold" : "normal";
      doc.setFont("times", font); doc.setFontSize(size);
      const L = doc.splitTextToSize(pdfSafe(r.mi || ""), colW);
      const R = side ? doc.splitTextToSize(pdfSafe(r.en || ""), colW) : [];
      const n = Math.max(L.length, R.length);
      if (!n) continue;
      // start a short paragraph (or a heading and what follows) on a new page rather than split it
      if ((n <= 6 || r.head) && y + (r.head ? n + 3 : n) * lh > bottom) newPage();
      if (r.head) y += lh * 0.3;
      for (let i = 0; i < n; i++) {
        if (y + lh > bottom) newPage();
        doc.setFont("times", font); doc.setFontSize(size); doc.setTextColor(0);
        if (L[i]) doc.text(L[i], M, y + size);
        if (R[i]) { doc.setTextColor(50); doc.text(R[i], M + colW + gutter, y + size); }
        y += lh;
      }
      y += lh * 0.6;
      if (side && !r.head && y < bottom) { doc.setDrawColor(215); doc.line(M, y - lh * 0.3, W - M, y - lh * 0.3); }
    }
    doc.save(`${fileSafe(file)}.pdf`);
  } catch (e) {
    toast(e.message || "Couldn't make the PDF.");
  } finally {
    btn.disabled = false; btn.innerHTML = label;
  }
}
// Word: a real .docx (made with JSZip, loaded from cdnjs on first use): title, source, then a
// two-column table (Mienh | English) or Mienh paragraphs, headings in bold.
let zipLoad = null;
function loadZip() {
  if (!zipLoad) {
    zipLoad = new Promise((ok, bad) => {
      const sc = document.createElement("script");
      sc.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
      sc.onload = () => ok(window.JSZip);
      sc.onerror = () => { zipLoad = null; bad(new Error("Couldn't load the Word maker. Check the connection.")); };
      document.head.append(sc);
    });
  }
  return zipLoad;
}
const xmlEsc = (t) => String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
function wPara(text, { bold = false, size = 22, color = null, after = 120 } = {}) {
  const rPr = `<w:rPr>${bold ? "<w:b/>" : ""}${color ? `<w:color w:val="${color}"/>` : ""}<w:sz w:val="${size}"/></w:rPr>`;
  const runs = String(text || "").split("\n").map((line, i) => `${i ? "<w:r><w:br/></w:r>" : ""}<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r>`).join("");
  return `<w:p><w:pPr><w:spacing w:after="${after}"/></w:pPr>${runs}</w:p>`;
}
async function docxRows({ rows, side, title, sub, file, btn, label }) {
  btn.disabled = true; btn.textContent = "Making Word file…";
  try {
    const JSZip = await loadZip();
    let body = "";
    if (title) body += wPara(title, { bold: true, size: 34, after: 60 });
    body += wPara(sub || `Mienh Translator · ${today()}`, { size: 19, color: "666666", after: 240 });
    if (side) {
      const cell = (t, o) => `<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr>${wPara(t, o)}</w:tc>`;
      const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell("MIENH", { bold: true, size: 18, color: "444444" })}${cell("ENGLISH", { bold: true, size: 18, color: "444444" })}</w:tr>`;
      const trs = rows.map((r) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(r.mi, { bold: r.head })}${cell(r.en, { bold: r.head, color: "333333" })}</w:tr>`).join("");
      const b = (n) => `<w:${n} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`;
      body += `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblBorders>${b("top")}${b("bottom")}${b("insideH")}${b("insideV")}</w:tblBorders>`
        + `<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`
        + `<w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>${head}${trs}</w:tbl>${wPara("")}`;
    } else {
      body += rows.filter((r) => r.mi).map((r) => wPara(r.mi, { bold: r.head, after: 160 })).join("");
    }
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}`
      + `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr>`
      + `<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault>`
      + `<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`;
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
      + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
      + `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
      + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
    zip.file("word/document.xml", docXml);
    zip.file("word/styles.xml", styles);
    const blob = await zip.generateAsync({ type: "blob", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${fileSafe(file)}.docx`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  } catch (e) {
    toast(e.message || "Couldn't make the Word file.");
  } finally {
    btn.disabled = false; btn.innerHTML = label;
  }
}

// One "Export ▾" menu on each page that has a translation (Translate, Scriptures, General
// Conference; user, 2026-11-19): Print, PDF or Word document. make() returns what is on screen.
const EXPORT_LABEL = 'Export <span aria-hidden="true">▾</span>';
function setupExport(pre, make) {
  const btn = $(`${pre}Export`), menu = $(`${pre}ExportMenu`);
  const show = (on) => {
    menu.hidden = !on; btn.setAttribute("aria-expanded", String(on));
    if (on) menu.classList.toggle("right", btn.getBoundingClientRect().left + 200 > innerWidth);  // keep it on screen
  };
  btn.onclick = (e) => { e.stopPropagation(); show(menu.hidden); if (!menu.hidden) menu.querySelector("button").focus(); };
  menu.addEventListener("click", (e) => {
    const it = e.target.closest("button[data-fmt]");
    if (!it) return;
    show(false);
    const d = make();
    if (!d || !d.rows.some((r) => r.mi)) { toast("Nothing to export yet."); return; }
    if (it.dataset.fmt === "print") { closeWord(); printRows(d); }
    else if (it.dataset.fmt === "pdf") pdfRows({ ...d, btn, label: EXPORT_LABEL });
    else docxRows({ ...d, btn, label: EXPORT_LABEL });
  });
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll("button")], i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { items[(i + 1) % items.length].focus(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { items[(i - 1 + items.length) % items.length].focus(); e.preventDefault(); }
    else if (e.key === "Escape") { show(false); btn.focus(); }
  });
  document.addEventListener("click", (e) => { if (!menu.hidden && !e.target.closest(`#${pre}ExportMenu`)) show(false); });
}
setupExport("tr", () => ({ rows: pairs(), side: $("sideChk").checked,
  file: `mienh-translation-${new Date().toISOString().slice(0, 10)}` }));

// ---- Corrections from fluent speakers -------------------------------------------
// Highlight words in the translation, type the correction, pick your name, send.
// Corrections go to the user's private Google Sheet; a daily task reviews them.
let correcting = false, lastModel = "", corrRange = null, corrInfo = null, dictOn = false;

function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

// Corrections go one way only: highlight English, type how it should be said in Mienh.
// That needs the side-by-side view, so correcting turns it on.
function setCorrecting(on) {
  if (on && dictOn) setDict(false);
  if (on && !$("sideChk").checked) {
    $("sideChk").checked = true;
    store("side", null);
    renderSide();
  }
  correcting = on;
  $("corrBtn").setAttribute("aria-pressed", String(on));
  $("corrBtn").textContent = on ? "Done" : "✎ Suggest a correction";
  $("resultCard").classList.toggle("correcting", on);
  $("corrBanner").hidden = !on;
  $("corrBanner").innerHTML = "Highlight the <b>English</b> words (press and hold on a phone), then tap the <b>Send correction</b> bubble. Tap <b>Done</b> when finished."
    + '<button type="button" class="how-link" id="howBtn">▶ Show me how</button>';
  if (on) $("howBtn").onclick = openHow;
  $("sideBody").querySelectorAll("td.mi").forEach((td) => { td.contentEditable = on || dictOn ? "false" : "true"; });
  if (!on) { closePop(); hideBubble(); }
}
$("corrBtn").onclick = () => {
  if (!correcting && (!$("mienOut").value.trim() || $("corrBtn").disabled)) return;
  setCorrecting(!correcting);
};
$("sideChk").addEventListener("change", () => {
  if (correcting && !$("sideChk").checked) setCorrecting(false);
  if (dictOn && !$("sideChk").checked) setDict(false);
});

// ---- Dictionary mode: highlight translated words to see what they mean ----------
// Works on the side-by-side view (turned on automatically), Mienh or English.
function setDict(on) {
  if (on && correcting) setCorrecting(false);
  if (on && !$("sideChk").checked) {
    $("sideChk").checked = true;
    store("side", null);
    renderSide();
  }
  dictOn = on;
  $("dictChk").checked = on;
  $("resultCard").classList.toggle("dict-mode", on);
  $("dictBanner").hidden = !on;
  $("sideBody").querySelectorAll("td.mi").forEach((td) => { td.contentEditable = on || correcting ? "false" : "true"; });
  if (!on) closeDict();
}
$("dictChk").onchange = () => setDict($("dictChk").checked);

function dictSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (!text || text.length > 120) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const cell = node && node.closest("#sideBody td");
  if (!cell || !cell.contains(range.endContainer)) return null;
  return { text, range: range.cloneRange(), english: cell.matches("td.en") };
}

const dictClean = (t) => t.replace(/[.,;:!?"“”()\[\]]/g, " ").replace(/\s+/g, " ").trim();
function dictRow(e) {
  const row = el("div", "dict-row");
  row.append(el("b", "", e.mien));
  if (e.sense) row.append(" ", el("span", "sense", `[${e.sense}]`));
  row.append(` — ${e.english}`);
  if (e.gospel) row.append(" ", el("span", "tag gospel", "LDS gospel term"));
  else if (e.corr) row.append(" ", el("span", "tag corr", "fluent speaker"));
  const src = e.book ? `Panh dictionary p. ${e.page}` : e.gospel ? `Mienh My Gospel p. ${e.page}`
    : e.corr ? e.src.replace("Correction from ", "Correction from ") : e.src;
  row.append(el("span", "dict-src", src));
  if (e.exm) row.append(el("div", "dict-ex", `${e.exm} = ${e.exe}`));
  return row;
}
// Exact matches for the highlighted word first (the whole headword, or a gloss that is
// exactly the English), then the rest in the usual order of authority.
function bestFirst(r, q, dirn, n) {
  const nq = norm(q).trim();
  const exact = (e) => (dirn === "mien" ? e.nmien === nq : glossHit(e.nen, wordForms(nq)));
  const sorted = [...r.entries.filter(exact), ...r.entries.filter((e) => !exact(e))];
  return { ...r, entries: sorted.slice(0, n) };
}
let dictQuery = null;
function renderDict(info) {
  const q = dictClean(info.text), dirn = info.english ? "en" : "mien";
  dictQuery = { q, dirn };
  $("dictQ").textContent = info.text;
  const body = $("dictBody");
  body.replaceChildren();
  const r = bestFirst(search(q, dirn, 60, 1), q, dirn, 5);
  if (r.entries.length) {
    r.entries.forEach((e) => body.append(dictRow(e)));
    if (r.totalEntries > r.entries.length) body.append(el("div", "dict-none", `+ ${r.totalEntries - r.entries.length} more in the Dictionary tab`));
  }
  // A phrase with no entry of its own: show each word.
  const words = [...new Set(q.split(" ").filter((w) => w.length > 1))];
  if (!r.entries.length && words.length > 1) {
    body.append(el("div", "dict-sub", "Word by word"));
    for (const w of words.slice(0, 8)) {
      const h = bestFirst(search(w, dirn, 60, 0), w, dirn, 1).entries[0];
      body.append(h ? dictRow(h) : el("div", "dict-none", `${w}: not found`));
    }
  } else if (!r.entries.length) {
    body.append(el("div", "dict-none", "Not found in the dictionary."));
  }
  if (r.sentences.length) {
    const s = r.sentences[0];
    body.append(el("div", "dict-sub", "Example"), el("div", "dict-ex", `${s.mien} = ${s.english}`));
  }
}
function showDict() {
  if (!dictOn || pointerDown) return;
  const info = dictSelection();
  if (!info) return;
  renderDict(info);
  const pop = $("dictPop");
  pop.hidden = false;
  pop.style.animation = "none"; void pop.offsetWidth; pop.style.animation = "";
  placePop(info.range.getBoundingClientRect(), pop);
}
function closeDict() { $("dictPop").hidden = true; }
$("dictClose").onclick = closeDict;
$("dictOpen").onclick = () => {
  if (!dictQuery) return;
  closeDict();
  showTab("dict");
  $("q").value = dictQuery.q;
  document.querySelector(`.seg [data-dir="${dictQuery.dirn}"]`)?.click();
  runSearch();
};
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("dictPop").hidden) closeDict(); });
let dictTimer = null;
document.addEventListener("pointerdown", (e) => {  // starting a new selection closes the old box
  if (dictOn && !e.target.closest("#dictPop") && !$("dictPop").hidden) closeDict();
});
document.addEventListener("pointerup", (e) => {
  if (!dictOn || e.target.closest("#dictPop")) return;
  setTimeout(showDict, 30);
});
document.addEventListener("selectionchange", () => {  // phones: wait for the selection to settle
  if (!dictOn) return;
  clearTimeout(dictTimer);
  dictTimer = setTimeout(showDict, 500);
});

// ---- "?" tutorial for dictionary mode --------------------------------------------
let dictHowRun = 0;
function openDictHow() { $("dictHowModal").hidden = false; playDictHow(); }
function closeDictHow() { $("dictHowModal").hidden = true; dictHowRun++; }
$("dictHowBtn").onclick = openDictHow;
$("dictHowClose").onclick = $("dictHowDone").onclick = closeDictHow;
$("dictHowReplay").onclick = () => playDictHow();
$("dictHowModal").addEventListener("click", (e) => { if (e.target === $("dictHowModal")) closeDictHow(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("dictHowModal").hidden) closeDictHow(); });
async function playDictHow() {
  const run = ++dictHowRun;
  const wait = (ms) => new Promise((res, rej) => setTimeout(() => (run === dictHowRun ? res() : rej("stop")), ms));
  const stage = $("dictHowStage"), cur = $("dhCursor"), sw = $("dhSwitch"), pop = $("dhPop");
  const word = $("dhMi").querySelector(".w");
  const steps = [...$("dictHowSteps").children];
  const step = (n) => steps.forEach((li, i) => li.classList.toggle("on", i === n));
  const pos = (node, fx = 0.5, fy = 0.6) => {
    const s = stage.getBoundingClientRect(), r = node.getBoundingClientRect();
    return [r.left - s.left + r.width * fx, r.top - s.top + r.height * fy];
  };
  const move = async (xy, ms = 750) => { cur.style.transitionDuration = `${ms}ms`; cur.style.transform = `translate(${xy[0]}px, ${xy[1]}px)`; await wait(ms + 60); };
  const click = async () => { cur.classList.remove("click"); void cur.offsetWidth; cur.classList.add("click"); await wait(260); };
  try {
    for (;;) {
      sw.classList.remove("on"); word.classList.remove("sel"); pop.hidden = true;
      step(0);
      cur.style.transitionDuration = "0ms";
      cur.style.transform = `translate(${stage.clientWidth * 0.6}px, ${stage.clientHeight - 40}px)`;
      await wait(600);
      await move(pos(sw.querySelector(".switch")));
      await click(); sw.classList.add("on");
      await wait(600);
      step(1);
      await move(pos(word, 0, 0.6));
      await move(pos(word, 1, 0.6), 500);
      word.classList.add("sel");
      await wait(350);
      step(2);
      pop.hidden = false;
      await move([stage.clientWidth * 0.82, stage.clientHeight - 30], 600);
      await wait(2600);
      step(3);
      await move(pos(pop.querySelector(".corr-sel"), 1.4, 0.5), 600);
      await wait(1200);
      pop.hidden = true; word.classList.remove("sel");
      await wait(1200);
    }
  } catch (e) { /* stopped or replayed */ }
}

function selectionInfo() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().replace(/\s+/g, " ").trim();
  if (!text) return null;
  const range = sel.getRangeAt(0);
  const node = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  if (!$("sideBody").contains(node)) return null;
  const cell = node.closest("td.en");  // only English can be highlighted
  if (!cell || !cell.contains(range.endContainer)) return null;
  const isEnglish = true;
  const row = cell.closest("tr");
  const i = Number(row.dataset.i || 0);
  const pr = pairs()[i] || { mi: "", en: "" };
  return { text, range: range.cloneRange(), english: isEnglish, context_mien: pr.mi, context_english: pr.en };
}

function openPop(info) {
  corrInfo = info;
  corrRange = info.range;
  const pop = $("corrPop");
  $("corrKind").textContent = info.english ? "Say it in Mienh" : "Correct the Mienh";
  $("corrSel").textContent = info.text;
  $("corrLabel").textContent = info.english ? "How should this be said in Mienh?" : "What does this mean in English?";
  $("corrText").spellcheck = !info.english;
  $("corrText").value = "";
  $("corrBetter").value = "";
  $("corrBetterWrap").hidden = info.english;
  $("corrWho").textContent = currentUser();
  $("corrMsg").textContent = ""; $("corrMsg").className = "corr-msg";
  pop.hidden = false;
  placePop(info.range.getBoundingClientRect());
  setTimeout(() => $("corrText").focus({ preventScroll: true }), 30);
}

// Put the box below, above, right or left of the selection, wherever it fits.
function placePop(r, pop = $("corrPop")) {
  pop.classList.remove("sheet");
  if (window.innerWidth < 600) { pop.classList.add("sheet"); return; }
  const w = pop.offsetWidth, h = pop.offsetHeight, gap = 10, vw = window.innerWidth, vh = window.innerHeight;
  const sx = window.scrollX, sy = window.scrollY;
  let top, left;
  if (r.bottom + gap + h <= vh) { top = r.bottom + gap; left = r.left; }
  else if (r.top - gap - h >= 0) { top = r.top - gap - h; left = r.left; }
  else if (r.right + gap + w <= vw) { left = r.right + gap; top = Math.max(gap, Math.min(r.top, vh - h - gap)); }
  else if (r.left - gap - w >= 0) { left = r.left - gap - w; top = Math.max(gap, Math.min(r.top, vh - h - gap)); }
  else { pop.classList.add("sheet"); return; }
  left = Math.max(gap, Math.min(left, vw - w - gap));
  pop.style.left = `${left + sx}px`;
  pop.style.top = `${top + sy}px`;
}

function closePop() { $("corrPop").hidden = true; corrInfo = null; corrRange = null; }
$("corrClose").onclick = $("corrCancel").onclick = closePop;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("corrPop").hidden) closePop(); });

// Once a selection is let go, a small "Send correction" bubble appears above it;
// the correction box opens only when that bubble is clicked.
let selTimer = null, pointerDown = false, pendingSel = null, touchy = false;
function hideBubble() { $("corrBubble").hidden = true; pendingSel = null; }
function showBubble() {
  if (!correcting || !$("corrPop").hidden || pointerDown) return;
  const info = selectionInfo();
  if (!info) { hideBubble(); return; }
  pendingSel = info;
  const b = $("corrBubble"), rects = info.range.getClientRects();
  const first = rects[0] || info.range.getBoundingClientRect();
  b.hidden = false;
  b.style.animation = "none"; void b.offsetWidth; b.style.animation = "";
  const w = b.offsetWidth, h = b.offsetHeight, gap = 9;
  let top = first.top - h - gap, below = false;
  // On phones the system's copy/paste menu sits above the selection, so go below it.
  if (top < 8 || touchy) { top = (rects[rects.length - 1] || first).bottom + gap + (touchy ? 14 : 0); below = true; }
  const mid = first.left + (rects.length > 1 ? first.width / 2 : info.range.getBoundingClientRect().width / 2);
  const left = Math.max(8, Math.min(mid - w / 2, window.innerWidth - w - 8));
  b.classList.toggle("below", below);
  b.style.left = `${left + window.scrollX}px`;
  b.style.top = `${top + window.scrollY}px`;
}
document.addEventListener("pointerdown", (e) => {
  if (e.target.closest("#corrBubble")) return;
  touchy = e.pointerType === "touch";
  pointerDown = true;
  if (correcting) hideBubble();
});
document.addEventListener("pointerup", (e) => {
  pointerDown = false;
  if (e.target.closest("#corrBubble, #corrPop")) return;
  setTimeout(showBubble, 30);
});
document.addEventListener("pointercancel", () => { pointerDown = false; });
document.addEventListener("selectionchange", () => {  // phones: selection handles move without pointer events
  if (!correcting || !$("corrPop").hidden) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { hideBubble(); return; }
  clearTimeout(selTimer);
  if (!pointerDown) { $("corrBubble").hidden = true; selTimer = setTimeout(showBubble, 500); }
});
$("corrBubble").addEventListener("mousedown", (e) => e.preventDefault());  // keep the selection
$("corrBubble").onclick = () => {
  const info = pendingSel || selectionInfo();
  hideBubble();
  if (info) openPop(info);
};
window.addEventListener("resize", () => { if (!$("corrBubble").hidden) showBubble(); });

// ---- "Show me how": an animated walk-through of sending a correction ----------
let howRun = 0;
function openHow() {
  $("howModal").hidden = false;
  playHow();
}
function closeHow() { $("howModal").hidden = true; howRun++; }
$("howClose").onclick = $("howDone").onclick = closeHow;
$("howReplay").onclick = () => playHow();
$("howModal").addEventListener("click", (e) => { if (e.target === $("howModal")) closeHow(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("howModal").hidden) closeHow(); });

async function playHow() {
  const run = ++howRun;
  const wait = (ms) => new Promise((res, rej) => setTimeout(() => (run === howRun ? res() : rej("stop")), ms));
  const stage = $("howStage"), cur = $("howCursor"), bub = $("howBubble"), dlg = $("howDialog");
  const words = [...$("howEn").querySelectorAll("span")], targets = words.filter((w) => w.classList.contains("w"));
  const steps = [...$("howSteps").children];
  const step = (n) => steps.forEach((li, i) => li.classList.toggle("on", i === n));
  const pos = (node, fx = 0.5, fy = 0.6) => {
    const s = stage.getBoundingClientRect(), r = node.getBoundingClientRect();
    return [r.left - s.left + r.width * fx, r.top - s.top + r.height * fy];
  };
  const move = async (xy, ms = 750) => { cur.style.transitionDuration = `${ms}ms`; cur.style.transform = `translate(${xy[0]}px, ${xy[1]}px)`; await wait(ms + 60); };
  const click = async () => { cur.classList.remove("click"); void cur.offsetWidth; cur.classList.add("click"); await wait(260); };
  try {
    for (;;) {
      words.forEach((w) => w.classList.remove("sel"));
      bub.hidden = true; dlg.hidden = true; $("howToast").hidden = true; $("howTyped").textContent = "";
      $("howSend").classList.remove("press"); bub.classList.remove("press");
      step(0);
      cur.style.transitionDuration = "0ms";
      cur.style.transform = `translate(${stage.clientWidth * 0.55}px, ${stage.clientHeight - 40}px)`;
      await wait(700);
      // 1. drag across "ten years old,"
      await move(pos(targets[0], 0, 0.6));
      for (const w of targets) {
        await move(pos(w, 1, 0.6), 380);
        w.classList.add("sel");
      }
      await wait(400);
      // 2. bubble appears above the selection; click it
      step(1);
      bub.hidden = false;
      const s = stage.getBoundingClientRect(), a = targets[0].getBoundingClientRect(), z = targets[targets.length - 1].getBoundingClientRect();
      const mid = (a.left + z.right) / 2 - s.left;
      bub.style.left = `${Math.max(6, Math.min(mid - bub.offsetWidth / 2, stage.clientWidth - bub.offsetWidth - 6))}px`;
      bub.style.top = `${a.top - s.top - bub.offsetHeight - 9}px`;
      await wait(900);
      await move(pos(bub, 0.5, 0.55), 650);
      bub.classList.add("press"); await click(); await wait(150);
      // 3. dialog opens; type the Mienh
      bub.hidden = true;
      dlg.hidden = false;
      step(2);
      await move(pos($("howTyped").parentElement, 0.15, 0.6), 600);
      await wait(300);
      for (const ch of "duqv ziepc hnyangx") { $("howTyped").textContent += ch; await wait(85); }
      await wait(700);
      // 4. press Send
      step(3);
      await move(pos($("howSend")), 650);
      $("howSend").classList.add("press"); await click(); await wait(200);
      dlg.hidden = true;
      words.forEach((w) => w.classList.remove("sel"));
      $("howToast").hidden = false;
      await wait(2600);
    }
  } catch (e) { /* stopped or replayed */ }
}

$("corrPop").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("corrMsg");
  const cfg = D.corrections || {};
  if (!cfg.url) { msg.textContent = "Corrections aren't connected yet. Ask Logan to finish the setup."; msg.className = "corr-msg err"; return; }
  const text = $("corrText").value.trim(), who = currentUser();
  if (!text) { msg.textContent = "Please type the correction."; msg.className = "corr-msg err"; $("corrText").focus(); return; }
  if (!who || NO_CORRECTIONS.includes(who)) { msg.textContent = "Choose your name in the User box first."; msg.className = "corr-msg err"; return; }
  const info = corrInfo, range = corrRange;
  const payload = {
    token: cfg.token, who,
    direction: info.english ? "english-to-mienh" : "mienh-to-english",
    selected: info.text, correction: text, better_mien: info.english ? "" : $("corrBetter").value.trim(),
    context_mien: info.context_mien, context_english: info.context_english, model: lastModel,
  };
  $("corrSend").disabled = true; msg.textContent = "Sending…"; msg.className = "corr-msg";
  try {
    let ok = false;
    try {
      const res = await fetch(cfg.url, { method: "POST", body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (data.ok === false) throw new Error(data.error || "not accepted");
      ok = true;
    } catch (err) {
      if (err instanceof TypeError) {  // the reply couldn't be read; send without reading it
        await fetch(cfg.url, { method: "POST", mode: "no-cors", body: JSON.stringify(payload) });
        ok = true;
      } else throw err;
    }
    if (ok) {
      try { const m = document.createElement("mark"); m.className = "sent"; range.surroundContents(m); } catch (x) {}
      window.getSelection().removeAllRanges();
      closePop();
      toast(who === "Zanx Jiemh" ? "Thanks! Sent for Yauz-Seng to review." : "Thanks! Your correction was sent.");
    }
  } catch (err) {
    msg.textContent = `Couldn't send it (${err.message}). Check the connection and try again.`;
    msg.className = "corr-msg err";
  } finally {
    $("corrSend").disabled = false;
  }
});

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
// ---- Bible reader ---------------------------------------------------------------
// Chapters of the user's Mienh Bible, each verse paired with the KJV (data.bible, built
// from dictionary/bible_sentences.csv). Every word can be tapped to look it up.
let bibleBook = 0, bibleChap = 0;
const bibleBooks = () => (D && D.bible) || [];
// Volumes in order (Old Testament, New Testament, Book of Mormon…), only those with chapters.
const bibleVols = () => [...new Set(bibleBooks().map((b) => b.vol || "Bible"))];
function fillVolumes() {
  $("bibleVol").replaceChildren(...bibleVols().map((v) => { const o = el("option", null, v); o.value = v; return o; }));
}
// The book list shows only the chosen volume's books (option values stay global indexes).
function fillBooks() {
  const books = bibleBooks(), cur = books[bibleBook], vol = cur ? (cur.vol || "Bible") : bibleVols()[0];
  $("bibleVol").value = vol;
  $("bibleBook").replaceChildren(...books.map((b, i) => [b, i]).filter(([b]) => (b.vol || "Bible") === vol).map(([b, i]) => {
    const o = el("option", null, b.mien && b.mien !== b.en ? `${b.mien} (${b.en})` : b.en);
    o.value = i;
    return o;
  }));
  $("bibleBook").value = bibleBook;
}
function setupBible() {
  const books = bibleBooks();
  fillVolumes();
  const saved = (load("bibleAt") || "").split("|");
  const bi = books.findIndex((b) => b.en === saved[0]);
  if (bi >= 0) { bibleBook = bi; bibleChap = Math.max(0, books[bi].chapters.findIndex((c) => String(c.n) === saved[1])); }
  bibleBook = Math.min(bibleBook, Math.max(0, books.length - 1));
  $("bibleSide").checked = load("bibleSide") !== "0";
  renderBible();
}
function fillChapters() {
  const b = bibleBooks()[bibleBook];
  $("bibleChap").replaceChildren(...(b ? b.chapters : []).map((c, i) => { const o = el("option", null, String(c.n)); o.value = i; return o; }));
  $("bibleChap").value = bibleChap;
}
// Split text into tappable words, keeping spaces and punctuation as plain text.
function wordsInto(parent, text, lang) {
  for (const part of text.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) { parent.append(part); continue; }
    const m = part.match(/^([^\p{L}\p{N}^']*)([\p{L}\p{N}^'’\-]*[\p{L}\p{N}])?(.*)$/u);
    if (!m || !m[2]) { parent.append(part); continue; }
    if (m[1]) parent.append(m[1]);
    const w = el("span", "w", m[2]);
    w.dataset.lang = lang;
    parent.append(w);
    if (m[3]) parent.append(m[3]);
  }
}
function renderBible() {
  const books = bibleBooks(), out = $("bibleOut");
  out.replaceChildren();
  out.classList.toggle("single", !$("bibleSide").checked);
  fillBooks();
  fillChapters();
  const b = books[bibleBook], c = b && b.chapters[bibleChap];
  if (!c) { $("bibleTitle").textContent = ""; out.append(el("div", "bible-empty", "No scripture chapters yet.")); $("bibleNavBottom").hidden = true; return; }
  store("bibleAt", `${b.en}|${c.n}`);
  $("bibleTitle").replaceChildren(`${b.mien} ${c.n}`,
    el("small", null, `${b.en !== b.mien ? `${b.en} ${c.n} · ` : ""}${b.src || "Mienh Bible"}, with the ${b.eng || "King James Version"} beside it`));
  let lastHead = null;
  for (const [n, mien, en, head] of c.verses) {
    if (head && head !== lastHead) { out.append(el("div", "bhead", head)); lastHead = head; }
    const row = el("div", "bverse"), m = el("div", "bmien"), e = el("div", "ben");
    m.append(el("span", "vn", n ? String(n) : "Title"));
    e.append(el("span", "vn", n ? String(n) : "Title"));
    wordsInto(m, mien, "mien");
    wordsInto(e, en, "en");
    row.append(m, e);
    out.append(row);
  }
  const first = bibleBook === 0 && bibleChap === 0;
  const last = bibleBook === books.length - 1 && bibleChap === b.chapters.length - 1;
  for (const id of ["biblePrev", "biblePrev2"]) $(id).disabled = first;
  for (const id of ["bibleNext", "bibleNext2"]) $(id).disabled = last;
  $("bibleNavBottom").hidden = false;
}
function stepChapter(d) {
  const books = bibleBooks();
  let bi = bibleBook, ci = bibleChap + d;
  if (ci < 0) { bi -= 1; if (bi < 0) return; ci = books[bi].chapters.length - 1; }
  else if (ci >= books[bi].chapters.length) { bi += 1; if (bi >= books.length) return; ci = 0; }
  bibleBook = bi; bibleChap = ci;
  closeWord();
  renderBible();
  $("bibleTitle").scrollIntoView({ block: "start", behavior: "smooth" });
}
$("bibleVol").onchange = () => {
  const i = bibleBooks().findIndex((b) => (b.vol || "Bible") === $("bibleVol").value);
  if (i >= 0) { bibleBook = i; bibleChap = 0; closeWord(); renderBible(); }
};
$("bibleBook").onchange = () => { bibleBook = +$("bibleBook").value; bibleChap = 0; closeWord(); renderBible(); };
$("bibleChap").onchange = () => { bibleChap = +$("bibleChap").value; closeWord(); renderBible(); };
$("biblePrev").onclick = $("biblePrev2").onclick = () => stepChapter(-1);
$("bibleNext").onclick = $("bibleNext2").onclick = () => stepChapter(1);
$("bibleSide").onchange = () => { store("bibleSide", $("bibleSide").checked ? "1" : "0"); $("bibleOut").classList.toggle("single", !$("bibleSide").checked); };

// ---- General Conference talks ------------------------------------------------------
// Talks translated in translations/*.md (data.conference, newest conference first). Pick a
// conference (month and year), then a talk ("Speaker - Title"). Same reading view as the
// Scriptures tab: English beside the Mienh, every word can be tapped.
let gcIdx = 0;
const gcTalks = () => (D && D.conference) || [];
const gcLabel = (t) => `${t.speaker} - ${t.title}`;
function fillGcConfs() {
  const talks = gcTalks(), confs = [...new Set(talks.map((t) => t.conf))];
  $("gcConf").replaceChildren(...confs.map((c) => {
    const o = el("option", null, talks.find((t) => t.conf === c).confLabel); o.value = c; return o;
  }));
}
function fillGcTalks() {
  const talks = gcTalks(), cur = talks[gcIdx];
  if (!cur) { $("gcTalk").replaceChildren(); return; }
  $("gcConf").value = cur.conf;
  $("gcTalk").replaceChildren(...talks.map((t, i) => [t, i]).filter(([t]) => t.conf === cur.conf).map(([t, i]) => {
    const o = el("option", null, gcLabel(t)); o.value = i; return o;
  }));
  $("gcTalk").value = gcIdx;
}
function setupGC() {
  const talks = gcTalks();
  $("tab-gc").hidden = !talks.length;
  fillGcConfs();
  const i = talks.findIndex((t) => t.id === load("gcAt"));
  gcIdx = i >= 0 ? i : Math.min(gcIdx, Math.max(0, talks.length - 1));
  $("gcSide").checked = load("gcSide") !== "0";
  renderGC();
}
function renderGC() {
  const talks = gcTalks(), out = $("gcOut"), t = talks[gcIdx];
  out.replaceChildren();
  out.classList.toggle("single", !$("gcSide").checked);
  fillGcTalks();
  if (!t) { $("gcTitle").textContent = ""; out.append(el("div", "bible-empty", "No talks yet.")); $("gcNavBottom").hidden = true; return; }
  store("gcAt", t.id);
  $("gcTitle").replaceChildren(t.mien || t.title, el("small", null, `${gcLabel(t)} · ${t.confLabel} General Conference`));
  for (const [en, mien, isHead] of t.paras) {
    if (isHead) {
      const row = el("div", "bverse bsec"), m = el("div", "bmien bhead"), e = el("div", "ben bhead en");
      wordsInto(m, mien, "mien"); wordsInto(e, en, "en");
      row.append(m, e); out.append(row); continue;
    }
    const row = el("div", "bverse"), m = el("div", "bmien"), e = el("div", "ben");
    wordsInto(m, mien, "mien");
    wordsInto(e, en, "en");
    row.append(m, e);
    out.append(row);
  }
  for (const id of ["gcPrev", "gcPrev2"]) $(id).disabled = gcIdx === 0;
  for (const id of ["gcNext", "gcNext2"]) $(id).disabled = gcIdx === talks.length - 1;
  $("gcNavBottom").hidden = false;
}
function stepTalk(d) {
  const i = gcIdx + d;
  if (i < 0 || i >= gcTalks().length) return;
  gcIdx = i; closeWord(); renderGC();
  $("gcTitle").scrollIntoView({ block: "start", behavior: "smooth" });
}
$("gcConf").onchange = () => {
  const i = gcTalks().findIndex((t) => t.conf === $("gcConf").value);
  if (i >= 0) { gcIdx = i; closeWord(); renderGC(); }
};
$("gcTalk").onchange = () => { gcIdx = +$("gcTalk").value; closeWord(); renderGC(); };
$("gcPrev").onclick = $("gcPrev2").onclick = () => stepTalk(-1);
$("gcNext").onclick = $("gcNext2").onclick = () => stepTalk(1);
$("gcSide").onchange = () => { store("gcSide", $("gcSide").checked ? "1" : "0"); $("gcOut").classList.toggle("single", !$("gcSide").checked); };

// ---- Print and PDF for the readers --------------------------------------------------
// What is on screen: the chapter or talk, with or without the English (the checkbox).
function bibleDoc() {
  const b = bibleBooks()[bibleBook], c = b && b.chapters[bibleChap];
  if (!c) return null;
  const side = $("bibleSide").checked, rows = [];
  let lastHead = null;
  for (const [n, mien, en, head] of c.verses) {
    if (head && head !== lastHead) { rows.push({ mi: head, en: "", head: true }); lastHead = head; }
    const num = n ? String(n) : "Title";
    rows.push({ mi: `${num}  ${mien}`, en: `${num}  ${en}` });
  }
  return { rows, side, title: `${b.mien} ${c.n}`,
    sub: `${b.en !== b.mien ? `${b.en} ${c.n} · ` : ""}${b.src || "Mienh Bible"}${side ? `, with the ${b.eng || "King James Version"}` : ""}`,
    file: `${b.en} ${c.n} - Mienh` };
}
function gcDoc() {
  const t = gcTalks()[gcIdx];
  if (!t) return null;
  return { rows: t.paras.map(([en, mien, h]) => ({ mi: mien, en, head: !!h })), side: $("gcSide").checked,
    title: t.mien || t.title, sub: `${gcLabel(t)} · ${t.confLabel} General Conference`,
    file: `${t.confLabel} - ${t.speaker} - ${t.title} - Mienh` };
}
setupExport("bible", bibleDoc);
setupExport("gc", gcDoc);

// ---- Search boxes (Scriptures and General Conference) ------------------------------
// Type part of a name; matching books / talks appear under the box. Arrow keys and Enter
// (or a tap) open one, so the dropdowns aren't needed.
const findNorm = (x) => norm(String(x)).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
function setupFind(input, list, search, open) {
  let items = [], at = -1;
  const close = () => { list.hidden = true; list.replaceChildren(); items = []; at = -1; input.setAttribute("aria-expanded", "false"); };
  const mark = () => list.querySelectorAll("li").forEach((li, i) => li.setAttribute("aria-selected", String(i === at)));
  const pick = (it) => { close(); input.value = ""; input.blur(); open(it); };
  input.addEventListener("input", () => {
    const q = findNorm(input.value);
    if (!q) return close();
    items = search(q).slice(0, 12); at = items.length ? 0 : -1;
    list.replaceChildren(...(items.length ? items : [null]).map((it, i) => {
      const li = el("li", it ? null : "none", it ? it.label : "Nothing found");
      if (it) {
        li.setAttribute("role", "option");
        if (it.sub) li.append(el("small", null, it.sub));
        li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(it); });
      }
      return li;
    }));
    list.hidden = false; input.setAttribute("aria-expanded", "true"); mark();
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden || !items.length) { if (e.key === "Escape") close(); return; }
    if (e.key === "ArrowDown") { at = (at + 1) % items.length; mark(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { at = (at - 1 + items.length) % items.length; mark(); e.preventDefault(); }
    else if (e.key === "Enter") { if (at >= 0) pick(items[at]); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => setTimeout(close, 150));
}
// Scriptures: a book name (English or Mienh, any part of it), optionally followed by a
// chapter number: "john 4", "moroni", "Yo^han 4", "1 ne".
setupFind($("bibleFind"), $("bibleFindList"), (q) => {
  const m = q.match(/^(.*?)\s*(\d+)$/), books = bibleBooks();
  const tries = m && m[1] ? [[m[1], +m[2]], [q, null]] : [[q, null]];
  for (const [name, ch] of tries) {
    const hits = [];
    books.forEach((b, bi) => {
      const en = findNorm(b.en), mi = findNorm(b.mien);
      const starts = en.startsWith(name) || mi.startsWith(name);
      if (!starts && !en.includes(name) && !mi.includes(name)) return;
      const named = b.mien && b.mien !== b.en ? `${b.mien} (${b.en})` : b.en;
      if (ch !== null) {
        const ci = b.chapters.findIndex((c) => c.n === ch);
        if (ci >= 0) hits.push({ rank: starts ? 0 : 1, label: `${named} ${ch}`, sub: b.vol, bi, ci });
      } else {
        hits.push({ rank: starts ? 0 : 1, label: named, sub: `${b.vol} · ${b.chapters.length} chapter${b.chapters.length === 1 ? "" : "s"}`, bi, ci: 0 });
      }
    });
    if (hits.length) return hits.sort((a, b) => a.rank - b.rank);
  }
  return [];
}, (it) => { bibleBook = it.bi; bibleChap = it.ci; closeWord(); renderBible(); });
// General Conference: every word typed must appear in the speaker, title (English or
// Mienh) or conference ("April 2014", "2014-04").
setupFind($("gcFind"), $("gcFindList"), (q) => {
  const words = q.split(" ");
  return gcTalks().map((t, i) => [t, i]).filter(([t]) => {
    const hay = findNorm(`${t.speaker} ${t.title} ${t.mien} ${t.confLabel} ${t.conf}`);
    return words.every((w) => hay.includes(w));
  }).map(([t, i]) => ({ label: gcLabel(t), sub: t.confLabel, i }));
}, (it) => { gcIdx = it.i; closeWord(); renderGC(); });

// Tap a word: show its dictionary entries. For Mienh, also try two- and three-word
// phrases around it (many entries are compounds, e.g. "Singx Lingh", "baeqv-fingx").
// ⌘-click (Mac) or Ctrl-click / Shift-click adds more words from the same verse, to look up
// a phrase; on a phone, "+ Next word" / "+ Word before" in the panel do the same.
let wordSel = [], wordQuery = "", wordDir = "mien";
const cleanWord = (s) => norm(s.textContent).replace(/[^\p{L}\p{N}^' ]/gu, "").trim();
function phraseEntries(spans, i) {
  const words = spans.map(cleanWord);
  const found = [], seen = new Set();
  for (const len of [3, 2]) {
    for (let start = i - len + 1; start <= i; start++) {
      if (start < 0 || start + len > words.length) continue;
      const p = words.slice(start, start + len).join(" ");
      for (const r of ENTRIES) if (r.nmien === p && !seen.has(r)) { seen.add(r); found.push(r); }
    }
  }
  return found;
}
// "Common" tag: how often a word appears in the official texts (Mienh My Gospel, the
// Mienh Bible, the Book of Mormon reader, confirmed translations).
function usesTag(e) {
  const t = el("span", "tag common", `common · ${e.uses}×`);
  t.title = "Used in official texts: " + Object.entries(e.usesBy).map(([k, v]) => `${k} ${v}×`).join(", ");
  return t;
}
function entryItem(e) {
  const li = el("li");
  li.append(el("span", "mien", e.mien), el("span", "gloss", e.english));
  if (e.uses && !e.gospel && !e.corr) li.append(" ", usesTag(e));
  li.append(el("div", "src", e.book ? `Panh dictionary p. ${e.page}` : e.gospel ? "Mienh My Gospel (LDS gospel term)" : e.corr ? "Fluent speaker correction" : e.src));
  return li;
}
function lookupWords(dirW, text, max) {
  const r = search(text, dirW, max, 0);
  const exact = r.entries.filter((e) => (dirW === "mien" ? e.nmien === norm(text) : true));
  return [...exact, ...r.entries].filter((e, k, a) => a.indexOf(e) === k).slice(0, max);
}
function setWordSel(spans) {
  wordSel.forEach((s) => s.classList.remove("on"));
  const all = spans.length ? [...spans[0].parentElement.querySelectorAll(".w")] : [];
  wordSel = [...new Set(spans)].sort((x, y) => all.indexOf(x) - all.indexOf(y));
  wordSel.forEach((s) => s.classList.add("on"));
  if (!wordSel.length) { closeWord(); return; }
  showWordSel();
}
function showWordSel() {
  const first = wordSel[0], lang = first.dataset.lang;
  wordDir = lang === "mien" ? "mien" : "en";
  const raw = wordSel.map((s) => s.textContent).join(" ");
  wordQuery = raw.replace(/[’]/g, "'").replace(/[^\p{L}\p{N}^' \-]/gu, "").trim();
  const body = $("wordSheetBody");
  body.replaceChildren();
  let list;
  if (wordSel.length === 1) {
    const spans = [...first.parentElement.querySelectorAll(".w")];
    const around = lang === "mien" ? phraseEntries(spans, spans.indexOf(first)) : [];
    list = [...around, ...lookupWords(wordDir, wordQuery, 8)].filter((e, k, a) => a.indexOf(e) === k).slice(0, 8);
    if (!list.length) body.append(el("div", "none", "Not in the dictionary."));
    else { const ul = el("ul"); list.forEach((e) => ul.append(entryItem(e))); body.append(ul); }
  } else {
    // The whole phrase first; then each word on its own, so nothing is lost when the
    // phrase isn't an entry.
    list = lookupWords(wordDir, wordQuery, 6);
    body.append(el("div", "group", "Whole phrase"));
    if (!list.length) body.append(el("div", "none", "No entry for the whole phrase."));
    else { const ul = el("ul"); list.forEach((e) => ul.append(entryItem(e))); body.append(ul); }
    for (const s of wordSel) {
      const w = s.textContent.replace(/[’]/g, "'");
      const one = lookupWords(wordDir, w, 3);
      body.append(el("div", "group", w));
      if (!one.length) body.append(el("div", "none", "Not in the dictionary."));
      else { const ul = el("ul"); one.forEach((e) => ul.append(entryItem(e))); body.append(ul); }
    }
  }
  $("wordSheetTitle").textContent = raw;
  const all = [...first.parentElement.querySelectorAll(".w")];
  const lo = all.indexOf(wordSel[0]), hi = all.indexOf(wordSel[wordSel.length - 1]);
  $("wordPrev").disabled = lo <= 0;
  $("wordNext").disabled = hi >= all.length - 1;
  $("wordSheet").hidden = false;
}
function growSel(d) {
  if (!wordSel.length) return;
  const all = [...wordSel[0].parentElement.querySelectorAll(".w")];
  const i = d > 0 ? all.indexOf(wordSel[wordSel.length - 1]) + 1 : all.indexOf(wordSel[0]) - 1;
  if (all[i]) setWordSel([...wordSel, all[i]]);
}
function closeWord() { $("wordSheet").hidden = true; wordSel.forEach((s) => s.classList.remove("on")); wordSel = []; }
function wordClick(e, w) {
  const adding = e.metaKey || e.ctrlKey || e.shiftKey;
  if (adding && wordSel.length && wordSel[0].parentElement === w.parentElement) {
    // Toggle this word in the selection (same verse and language only).
    setWordSel(wordSel.includes(w) ? wordSel.filter((s) => s !== w) : [...wordSel, w]);
  } else {
    setWordSel([w]);
  }
}
for (const out of [$("bibleOut"), $("gcOut")]) {
  out.addEventListener("click", (e) => {
    const w = e.target.closest(".w");
    if (!w) return;
    if (e.shiftKey) e.preventDefault();
    wordClick(e, w);
  });
  // On a Mac, Ctrl-click opens the context menu instead of clicking: treat it as "add".
  out.addEventListener("contextmenu", (e) => {
    const w = e.target.closest(".w");
    if (!w || !e.ctrlKey) return;
    e.preventDefault();
    wordClick(e, w);
  });
  // Shift-click would otherwise select text across the page.
  out.addEventListener("mousedown", (e) => { if (e.shiftKey && e.target.closest(".w")) e.preventDefault(); });
}
$("wordNext").onclick = () => growSel(1);
$("wordPrev").onclick = () => growSel(-1);
$("wordSheetClose").onclick = closeWord;
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("wordSheet").hidden) closeWord(); });
$("wordSheetMore").onclick = () => {
  const q = wordQuery, d = wordDir;
  closeWord();
  showTab("dict");
  dir = d;
  document.querySelectorAll(".seg button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.dir === dir)));
  $("q").value = q;
  runSearch();
};


// ---- Compare: fluent speakers pick the better of 2-3 Mienh versions -------------
// Batches come from training/batch_*.json (built into the encrypted data). Answers go to
// the "Compare" tab of the corrections Sheet; this device remembers what each user answered.
const CMP_USERS = ["Gauv Meng", "Meix Waah", "Yauz-Seng", "Zanx Jiemh"];
let cmpBatch = null, cmpIdx = 0, cmpChoice = null, cmpOrder = [], cmpReady = null, cmpEditing = null;
const cmpKey = (who, id) => `cmp:${who}:${id}`;
function cmpAnswered(who, id) { try { return JSON.parse(load(cmpKey(who, id)) || "null"); } catch (e) { return null; } }
function cmpHash(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function cmpShuffle(list, seed) {  // the same order every time for this user and sentence
  const a = list.slice(); let x = seed || 1;
  for (let i = a.length - 1; i > 0; i--) { x = (Math.imul(x, 1103515245) + 12345) >>> 0; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function setupCompare() {
  const batches = D.compare || [];
  $("tab-cmp").hidden = !batches.length;
  if (!batches.length) return;
  $("cmpBatch").hidden = true;  // each speaker sees only their own newest batch
  $("cmpUser").value = $("userSel").value;
  cmpPickBatch();
}
// The newest batch meant for this speaker (a batch with no "for" list is for everyone).
function cmpPickBatch() {
  const batches = D.compare || [], who = cmpWho();
  const mine = batches.filter((b) => !(b.for || []).length || (b.for || []).includes(who));
  cmpBatch = mine.length ? mine[mine.length - 1] : batches[batches.length - 1];
  cmpIdx = cmpFirstOpen();
}
function cmpWho() { return $("cmpUser").value; }
function cmpFirstOpen() {
  const who = cmpWho(); if (!cmpBatch) return 0;
  const i = cmpBatch.items.findIndex((it) => !cmpAnswered(who, it.id));
  return i < 0 ? cmpBatch.items.length : i;
}
// Is the Sheet's script new enough to save answers? (an older one would refuse them)
async function cmpCheckReady() {
  const cfg = D.corrections || {};
  if (!cfg.url) return false;
  if (cmpReady !== null) return cmpReady;
  try {
    const r = await (await fetch(cfg.url)).json();
    cmpReady = /compare/.test(r.service || "");
  } catch (e) { cmpReady = true; }  // can't tell from here; try sending
  return cmpReady;
}
// Answers already in the Sheet (from any device) for this speaker and batch.
const cmpSynced = new Set();
async function cmpSync(who) {
  const cfg = D.corrections || {}, key = `${who}|${cmpBatch.batch}`;
  if (!cfg.url || !CMP_USERS.includes(who) || cmpSynced.has(key)) return;
  cmpSynced.add(key);
  try {
    const res = await fetch(cfg.url, { method: "POST",
      body: JSON.stringify({ token: cfg.token, kind: "progress", who, batch: cmpBatch.batch }) });
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.items)) return;
    let added = 0;
    for (const a of data.items) {
      if (!cmpAnswered(who, a.item)) { store(cmpKey(who, a.item), JSON.stringify({ choice: a.choice, own: a.own || "", comment: a.comment || "" })); added++; }
    }
    if (added && cmpWho() === who) { cmpIdx = cmpFirstOpen(); renderCompare(); }
  } catch (e) { /* offline or older script: this device's memory still works */ }
}
function cmpComplete(who) { return !!cmpBatch && !!who && cmpBatch.items.every((it) => cmpAnswered(who, it.id)); }
function renderCompare() {
  if (!cmpBatch) return;
  const who = cmpWho(), items = cmpBatch.items, n = items.length;
  const done = items.filter((it) => cmpAnswered(who, it.id)).length;
  if (who) cmpSync(who);
  $("cmpFill").style.width = `${Math.round(100 * done / n)}%`;
  const num = who && (cmpBatch.nums || {})[who];  // each speaker's own batch count
  $("cmpCount").textContent = (num ? `Batch ${num} · ` : "") + (done === n ? "✓ Completed" : `${done} of ${n} answered`);
  $("cmpCount").classList.toggle("done", done === n);
  $("tab-cmp").textContent = cmpComplete(who) ? "Translation Training ✓" : "Translation Training";
  const note = $("cmpNote"); note.replaceChildren();
  if (!who) note.append(el("div", "banner err", "Choose your name in the User box first."));
  else if (!CMP_USERS.includes(who)) note.append(el("div", "banner err", "Only the fluent speakers on the list can answer these."));
  else cmpCheckReady().then((ok) => {
    if (!ok) note.replaceChildren(el("div", "banner err", "Answers can't be saved yet: Yauz-Seng needs to finish the setup."));
  });
  const finished = cmpIdx >= n;
  $("cmpItem").hidden = finished; $("cmpDone").hidden = !finished;
  if (finished) return;
  const it = items[cmpIdx], prev = cmpAnswered(who, it.id);
  $("cmpNum").replaceChildren(document.createTextNode(`Sentence ${cmpIdx + 1} of ${n}`));
  if (prev) $("cmpNum").append(el("span", "cmp-answered", "✓ answered"));
  $("cmpEn").textContent = it.english;
  cmpOrder = cmpShuffle(it.versions.map((v) => v.v), cmpHash(`${who}|${it.id}`));
  cmpChoice = prev ? prev.choice : null;
  const opts = $("cmpOpts"); opts.replaceChildren();
  cmpOrder.forEach((v, i) => {
    const ver = it.versions.find((x) => x.v === v);
    const b = el("button", "cmp-opt", ver.mien);
    b.type = "button"; b.setAttribute("role", "radio"); b.dataset.n = i + 1; b.dataset.v = v;
    opts.append(b);
  });
  const alts = el("div", "cmp-alts");
  for (const [v, label] of [["all", "They all sound fine"], ["none", "None is right"]]) {
    const b = el("button", "cmp-opt alt", label); b.type = "button"; b.setAttribute("role", "radio"); b.dataset.n = "·"; b.dataset.v = v;
    alts.append(b);
  }
  opts.append(alts);
  opts.querySelectorAll(".cmp-opt").forEach((b) => { b.onclick = () => cmpPick(b.dataset.v); });
  $("cmpOwn").value = prev ? prev.own || "" : "";
  $("cmpWhy").value = prev ? prev.comment || "" : "";
  $("cmpMsg").textContent = ""; $("cmpMsg").className = "corr-msg";
  $("cmpPrev").disabled = cmpIdx === 0;
  cmpPick(cmpChoice, true);
  // Nothing on the card can be used until a speaker is chosen.
  const locked = !CMP_USERS.includes(who);
  $("cmpItem").classList.toggle("locked", locked);
  $("cmpItem").querySelectorAll("button, textarea, input").forEach((n) => { if (locked) n.disabled = true; });
  // An answered sentence is read-only (so going Back can't send it again) until "Change my answer".
  const sealed = !locked && !!prev && cmpEditing !== it.id;
  const editing = !locked && !!prev && cmpEditing === it.id;
  $("cmpItem").classList.toggle("sealed", sealed);
  if (!locked) {
    opts.querySelectorAll("button").forEach((n) => { n.disabled = sealed; });
    $("cmpOwn").disabled = sealed; $("cmpWhy").disabled = sealed;
    $("cmpSkip").disabled = false;
  }
  $("cmpEdit").hidden = !prev || locked;
  $("cmpEdit").disabled = locked;
  $("cmpEdit").textContent = editing ? "Cancel" : "✎ Change my answer";
  $("cmpSend").hidden = sealed;
  $("cmpSend").textContent = editing ? "Save my change →" : "Send & next →";
  $("cmpSkip").textContent = prev ? "Next →" : "Skip";
  if (sealed) $("cmpSkip").className = "btn"; else $("cmpSkip").className = "btn secondary";
}
function cmpPick(v, quiet) {
  if (!quiet && !CMP_USERS.includes(cmpWho())) return;
  cmpChoice = v;
  $("cmpOpts").querySelectorAll(".cmp-opt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === v)));
  const more = $("cmpMore");
  more.hidden = !v;
  more.classList.toggle("need", v === "none");
  $("cmpOwnLabel").textContent = v === "none" ? "How would you say it? (needed when none is right)"
    : v ? "Would you say it differently? (optional)" : "";
  $("cmpSend").disabled = !v || !CMP_USERS.includes(cmpWho());
  if (v && !quiet && v === "none") $("cmpOwn").focus();
}
async function cmpSend() {
  const who = cmpWho(), it = cmpBatch.items[cmpIdx], cfg = D.corrections || {};
  if (cmpAnswered(who, it.id) && cmpEditing !== it.id) return;  // already sent; "Change my answer" first
  const own = $("cmpOwn").value.trim(), comment = $("cmpWhy").value.trim(), msg = $("cmpMsg");
  if (!CMP_USERS.includes(who)) { msg.textContent = "Choose your name in the User box first."; msg.className = "corr-msg err"; return; }
  if (cmpChoice === "none" && !own) { msg.textContent = "Please type how you would say it."; msg.className = "corr-msg err"; $("cmpOwn").focus(); return; }
  if (!(await cmpCheckReady())) { msg.textContent = "Answers can't be saved yet: Yauz-Seng needs to finish the setup."; msg.className = "corr-msg err"; return; }
  const chosen = it.versions.find((x) => x.v === cmpChoice);
  const payload = {
    token: cfg.token, kind: "compare", who, batch: cmpBatch.batch, item: it.id, english: it.english,
    choice: cmpChoice, chosen_mien: chosen ? chosen.mien : "", own, comment,
    shown: cmpOrder.join(","), versions: it.versions.map((x) => `${x.v}: ${x.mien}`).join("\n"),
  };
  $("cmpSend").disabled = true; msg.textContent = "Sending…"; msg.className = "corr-msg";
  try {
    try {
      const res = await fetch(cfg.url, { method: "POST", body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (data.ok === false) throw new Error(data.error || "not accepted");
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;  // the reply couldn't be read; send without reading it
      await fetch(cfg.url, { method: "POST", mode: "no-cors", body: JSON.stringify(payload) });
    }
    store(cmpKey(who, it.id), JSON.stringify({ choice: cmpChoice, own, comment }));
    const wasEdit = cmpEditing === it.id;
    cmpEditing = null;
    if (who === "Zanx Jiemh") toast("Thanks! Sent for Yauz-Seng to review.");
    else if (wasEdit) toast("Your change is saved.");
    cmpIdx = wasEdit ? Math.min(cmpIdx + 1, cmpBatch.items.length) : cmpNextOpen(cmpIdx);
    renderCompare();
    if (!$("cmpDone").hidden && !wasEdit) celebrate();
    $("panel-cmp").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (err) {
    msg.textContent = `Couldn't send it (${err.message}). Check the connection and try again.`;
    msg.className = "corr-msg err";
    $("cmpSend").disabled = false;
  }
}
function cmpNextOpen(from) {
  const who = cmpWho(), items = cmpBatch.items;
  for (let i = from + 1; i < items.length; i++) if (!cmpAnswered(who, items[i].id)) return i;
  const first = cmpFirstOpen();
  return first < items.length ? first : items.length;
}
$("cmpSend").onclick = cmpSend;
$("cmpEdit").onclick = () => {
  const it = cmpBatch.items[cmpIdx];
  cmpEditing = cmpEditing === it.id ? null : it.id;
  renderCompare();
};
$("cmpSkip").onclick = () => { cmpEditing = null; cmpIdx = Math.min(cmpIdx + 1, cmpBatch.items.length); if (cmpIdx >= cmpBatch.items.length) cmpIdx = cmpFirstOpen(); renderCompare(); };
$("cmpPrev").onclick = () => { cmpEditing = null; if (cmpIdx > 0) { cmpIdx--; renderCompare(); } };
$("cmpReview").onclick = () => { cmpIdx = 0; $("cmpItem").hidden = false; $("cmpDone").hidden = true; renderCompare(); };
$("cmpUser").onchange = () => {
  $("userSel").value = cmpWho(); store("user", cmpWho() || null); updateUserState();
  cmpPickBatch(); renderCompare();
};

const tabs = { home: [$("tab-home"), $("panel-home")], dict: [$("tab-dict"), $("panel-dict")], tr: [$("tab-tr"), $("panel-tr")],
  bible: [$("tab-bible"), $("panel-bible")], gc: [$("tab-gc"), $("panel-gc")], cmp: [$("tab-cmp"), $("panel-cmp")] };
function showTab(name) {
  for (const [k, [btn, panel]] of Object.entries(tabs)) {
    const on = k === name, was = !panel.hidden;
    btn.setAttribute("aria-selected", String(on));
    panel.hidden = !on;
    if (on) $("menuLabel").textContent = btn.textContent.replace(/\s*✓$/, "");
    if (on) {  // on a narrow screen the tab bar scrolls: keep the chosen tab in view
      const nav = btn.parentElement, l = btn.offsetLeft, r = l + btn.offsetWidth;
      if (l < nav.scrollLeft) nav.scrollLeft = l - 8;
      else if (r > nav.scrollLeft + nav.clientWidth) nav.scrollLeft = r - nav.clientWidth + 8;
    }
    if (on && !was) {
      // replay the slide-in for this page's cards
      panel.querySelectorAll(".rise").forEach((n) => { n.style.animation = "none"; void n.offsetWidth; n.style.animation = ""; });
    }
  }
  if (name === "tr") { showTotal(); if (!$("trResult").hidden) fitMien(); }
  if (name !== "bible" && name !== "gc") closeWord();
  if (name === "cmp") { $("cmpUser").value = $("userSel").value; cmpPickBatch(); renderCompare(); }
}
// Phone menu (user, 2026-11-19): on a phone the tabs fold into a ☰ menu in the header; the
// button shows the page you're on. On wider screens the menu button is hidden by the CSS.
function setMenu(open) {
  if (open) {  // drop the menu just under the header
    const h = $("menuBtn").closest("header");
    $("tabsNav").style.top = `${h.offsetTop + h.offsetHeight + 2}px`;
  }
  $("tabsNav").classList.toggle("open", open);
  $("menuBtn").setAttribute("aria-expanded", String(open));
  $("menuBtn").setAttribute("aria-label", open ? "Close the menu" : "Open the menu");
}
$("menuBtn").onclick = (e) => { e.stopPropagation(); setMenu(!$("tabsNav").classList.contains("open")); };
$("tabsNav").addEventListener("click", (e) => { if (e.target.closest("button")) setMenu(false); });
document.addEventListener("click", (e) => {
  if ($("tabsNav").classList.contains("open") && !e.target.closest("#tabsNav, #menuBtn")) setMenu(false);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("tabsNav").classList.contains("open")) { setMenu(false); $("menuBtn").focus(); } });
$("tab-home").onclick = () => showTab("home");
$("tab-dict").onclick = () => { showTab("dict"); $("q").focus(); };
$("tab-tr").onclick = () => { showTab("tr"); $("enIn").focus(); };
$("tab-bible").onclick = () => showTab("bible");
$("tab-gc").onclick = () => showTab("gc");
$("tab-cmp").onclick = () => showTab("cmp");

// ---- Install as an app (Android / desktop Chrome) ------------------------------
// The service worker makes the site installable; Chrome then offers a real app
// install (own icon, full screen) instead of a browser shortcut.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installEvent = e;
  $("installBtn").hidden = false;
});
$("installBtn").onclick = async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null;
  $("installBtn").hidden = true;
};
window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; });

(async () => {
  let once = null;
  try { once = sessionStorage.getItem("pwOnce"); sessionStorage.removeItem("pwOnce"); } catch (e) {}
  if (once) {
    try { if (await tryUnlock(once, false)) return; } catch (e) {}
  }
  const saved = load("pw");
  if (saved) {
    try { if (await tryUnlock(saved, true)) return; } catch (e) {}
    store("pw", null);
  }
  $("loading").hidden = true;
  $("unlock").hidden = false;
  $("pw").focus();
})();
