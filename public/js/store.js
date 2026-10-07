// Everything the learner has is saved in THIS browser: no account, no login.
// Small data (settings, lessons, progress) → localStorage. Images → IndexedDB.
// "Download backup" / "Load backup" in Settings moves it to another browser.

export const LANGS = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  ja: "Japanese", ko: "Korean", zh: "Chinese", ru: "Russian", pt: "Portuguese",
};
export const TARGETS = ["en", "es", "fr", "de", "it", "ja", "ko", "zh"];
export const LEVELS = { A1: "Beginner", A2: "Elementary", B1: "Intermediate", B2: "Upper intermediate", C1: "Advanced", C2: "Proficient" };
export const DAY = 86400000;
const KEY = "snapstudy-v4";

export const blank = () => ({
  version: 4,
  profile: null,          // {target, level, explain, goal}
  clockOffset: 0,         // demo: "move time forward"
  shots: [],              // screenshots and what the agent learned about them
  items: {},              // words, phrases, grammar the learner studies (shared across screenshots)
  sessions: {},           // practice sessions
  activeSession: null,
  lastRecap: null,
  difficulties: [],       // {itemId, d, t} recent difficulties found by the tutor
  today: null,            // agent's plan for today
  log: [],                // every agent step, for "What the agent did"
});

export let state = load();
export const now = () => Date.now() + (state.clockOffset || 0);
export const replaceState = (s) => { state = { ...blank(), ...s }; save(); };

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) {
      // Work cut off by a reload goes back into the queue.
      for (const x of s.shots || []) if (["triaging", "reading"].includes(x.status)) x.status = x.triage ? "kept" : "queued";
      return { ...blank(), ...s };
    }
  } catch {}
  return blank();
}
export function save() {
  const slim = { ...state, log: state.log.slice(-80) };
  try { localStorage.setItem(KEY, JSON.stringify(slim)); return true; }
  catch {
    try { localStorage.setItem(KEY, JSON.stringify({ ...slim, log: [] })); return true; } catch { return false; }
  }
}

// IndexedDB for images: "full" (for the AI and the source view) and "thumb" (library list).
export const images = (() => {
  let dbp;
  const open = () => (dbp ||= new Promise((ok, no) => {
    const r = indexedDB.open("snapstudy4", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("full"); r.result.createObjectStore("thumb"); };
    r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error);
  }));
  const mem = { full: {}, thumb: {} };
  return {
    async put(store, k, v) {
      mem[store][k] = v;
      try { const db = await open(); await new Promise((ok) => { const t = db.transaction(store, "readwrite"); t.objectStore(store).put(v, k); t.oncomplete = ok; t.onerror = ok; }); } catch {}
    },
    async get(store, k) {
      if (mem[store][k]) return mem[store][k];
      try {
        const db = await open();
        const v = await new Promise((ok) => { const r = db.transaction(store).objectStore(store).get(k); r.onsuccess = () => ok(r.result); r.onerror = () => ok(null); });
        if (v) mem[store][k] = v;
        return v;
      } catch { return null; }
    },
    async del(k) { delete mem.full[k]; delete mem.thumb[k]; try { const db = await open(); const t = db.transaction(["full", "thumb"], "readwrite"); t.objectStore("full").delete(k); t.objectStore("thumb").delete(k); } catch {} },
    async clear() { mem.full = {}; mem.thumb = {}; try { const db = await open(); const t = db.transaction(["full", "thumb"], "readwrite"); t.objectStore("full").clear(); t.objectStore("thumb").clear(); } catch {} },
  };
})();

// ---------- small helpers ----------
export const uid = (p) => p + Math.random().toString(36).slice(2, 9);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const shotById = (id) => state.shots.find((s) => s.id === id);
export const lang = (code) => LANGS[code] || code;
export const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
export const ago = (t) => { const d = Math.floor((now() - t) / DAY); return d <= 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };
// Compare answers loosely: case, apostrophe style, spaces, final punctuation, Japanese OCR spaces.
export const loose = (s) => String(s ?? "").normalize("NFKC").toLocaleLowerCase()
  .replace(/[’‘`]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim()
  .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "")
  .replace(/[.!?。！？,，、]+$/u, "").trim();
export const shuffle = (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
export const chunk = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
export async function pool(list, n, fn) {
  const q = [...list];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => { while (q.length) await fn(q.shift()); }));
}
