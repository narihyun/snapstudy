// The agent: TRIAGE → LESSON (read + choose + build) → CHECK (+ one revision) → MERGE → TODAY plan.
// Each step is logged so "What the agent did" can show it.
import { state, save, now, images, uid, loose, pool, shuffle, lang, shotById, DAY } from "./store.js";
import { cropRegions } from "./regions.js";

let onChange = () => {};
export const setOnChange = (fn) => (onChange = fn);

// ---------- AI relay ----------
export async function ai(step, data, shotId) {
  const entry = { id: uid("l"), t: now(), step, shot: shotId || null };
  state.log.push(entry);
  let r, out;
  try {
    r = await fetch("/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step, data }) });
    out = await r.json().catch(() => null);
  } catch { out = null; }
  if (!r || !out || !r.ok || out.error) {
    const msg = out?.error || (r && [404, 405, 501].includes(r.status)
      ? "The AI server (/api/ai) is not running. On your computer, start the app with: node local-server.mjs"
      : "Could not reach the AI. Check your connection and try again.");
    entry.error = msg;
    throw new Error(msg);
  }
  Object.assign(entry, { ms: out.ms, model: out.model, tokens: out.usage?.total_tokens, result: out.result });
  return out.result;
}
export async function aiStatus() {
  try { const r = await fetch("/api/ai"); const j = await r.json(); return j.ready ? "ready" : "nokey"; } catch { return "offline"; }
}
function note(text, shotId) { state.log.push({ id: uid("l"), t: now(), step: "note", shot: shotId || null, text }); }

// ---------- adding screenshots ----------
export const MAX_SHOTS = 150;
export async function addFiles(list) {
  const take = list.slice(0, MAX_SHOTS);
  let added = 0;
  for (const it of take) {
    try {
      const src = it.url || (await readFile(it.file));
      const [full, thumb] = await Promise.all([resize(src, 1600, 0.86), resize(src, 360, 0.66)]);
      const id = uid("s");
      await images.put("full", id, full);
      await images.put("thumb", id, thumb);
      state.shots.unshift({ id, name: it.name, takenAt: it.takenAt || guessDate(it.name, it.file?.lastModified), addedAt: now(), status: "queued" });
      added++;
    } catch { /* unreadable file: skip */ }
  }
  note(`Received ${added} screenshot${added === 1 ? "" : "s"}${list.length > MAX_SHOTS ? ` (took the first ${MAX_SHOTS} of ${list.length})` : ""}.`);
  save(); onChange();
  runAgent();
  return { added, skipped: list.length - added };
}

// ---------- the agent loop ----------
let running = false;
export const isRunning = () => running;
export async function runAgent() {
  if (running || !state.profile) return;
  running = true; onChange();
  try {
    // 1) TRIAGE in batches of 6 small images: keep or set aside.
    for (;;) {
      const batch = state.shots.filter((s) => s.status === "queued").slice(0, 6);
      if (!batch.length) break;
      batch.forEach((s) => (s.status = "triaging")); onChange();
      try {
        const imgs = await Promise.all(batch.map(async (s) => resize(await images.get("full", s.id), 512, 0.7)));
        const res = await ai("triage", { profile: state.profile, images: imgs });
        batch.forEach((s, i) => {
          const v = (res.shots || []).find((x) => x.i === i) || res.shots?.[i] || {};
          s.triage = { languages: v.languages || [], kind: v.kind || "other", keep: !!v.keep, reason: v.reason || "", topic: v.topic || "" };
          s.status = s.triage.keep ? "kept" : "aside";
        });
        const kept = batch.filter((s) => s.status === "kept").length;
        note(`Sorted ${batch.length} screenshots: ${kept} to study, ${batch.length - kept} set aside (no useful ${lang(state.profile.target)}).`);
      } catch (e) {
        batch.forEach((s) => { s.status = "failed"; s.error = e.message; });
        if (/OPENAI_API_KEY|not running/.test(e.message)) throw e;
      }
      save(); onChange();
    }
    // 2) LESSON for every kept screenshot (two at a time).
    const todo = state.shots.filter((s) => s.status === "kept");
    await pool(todo, 2, async (s) => {
      s.status = "reading"; onChange();
      try { await buildLesson(s); }
      catch (e) { s.status = "failed"; s.error = e.message; }
      save(); onChange();
    });
    state.today = null; // the plan for today is out of date now
  } catch (e) {
    state.shots.filter((s) => ["queued", "triaging", "reading", "kept"].includes(s.status)).forEach((s) => { s.status = "failed"; s.error = e.message; });
    note(`Stopped: ${e.message}`);
  } finally {
    running = false; save(); onChange();
  }
}
export function retry(shot) {
  shot.status = shot.triage ? "kept" : "queued"; shot.error = null;
  save(); runAgent();
}
// The learner disagrees with the agent: study a set-aside screenshot anyway.
export function studyAnyway(shot) {
  shot.status = "kept"; shot.manualKeep = true;
  note("Learner moved a set-aside screenshot back to study material.", shot.id);
  save(); runAgent();
}
export function setAside(shot) {
  shot.status = "aside"; shot.manualAside = true;
  shot.triage = { ...(shot.triage || {}), reason: "You set this aside." };
  save(); onChange();
}

// ---------- LESSON: read, choose items, build exercises, check, revise once ----------
export async function buildLesson(shot, focus) {
  const p = state.profile;
  const image = await images.get("full", shot.id);
  const existing = Object.values(state.items).filter((i) => i.language === p.target).map((i) => ({ id: i.id, form: i.form, sense: i.sense }));
  const missed = recentDifficulties().map((d) => `${state.items[d.itemId]?.form} (${d.d})`);
  focus = focus || shot.focus || null;
  const crops = focus?.regions?.length ? await cropRegions(image, focus.regions) : [];
  const data = { profile: p, image: crops.length ? null : image, focus: focus ? { regions: focus.regions || [], forms: focus.forms || [], crops } : null, existing, missed };

  let raw = await ai("lesson", data, shot.id);
  let { lesson, issues } = check(raw, focus);
  if (issues.length) {
    note(`Quality check found ${issues.length} problem${issues.length > 1 ? "s" : ""}; asking the AI to fix them once.`, shot.id);
    try {
      raw = await ai("lesson", { ...data, previous: raw, issues: issues.slice(0, 12) }, shot.id);
      const second = check(raw, focus);
      if (second.lesson.items.length >= lesson.items.length) ({ lesson, issues } = second);
      if (issues.length) note(`Dropped ${issues.length} question${issues.length > 1 ? "s" : ""} that still failed the check.`, shot.id);
    } catch { /* keep the checked first answer */ }
  }
  shot.title = lesson.title || shot.title || shot.name;
  shot.topic = lesson.topic || shot.triage?.topic || "";
  shot.why = lesson.why_saved || "";
  shot.source = lesson.source || "";
  shot.text = lesson.text;
  if (!lesson.items.length) {
    shot.status = "aside";
    shot.triage = { ...(shot.triage || {}), keep: false, reason: lesson.why_saved || "Nothing useful to learn was found here." };
    shot.lesson = null;
    note("Nothing useful to learn after a closer look; set aside.", shot.id);
    return;
  }
  // MERGE: same word seen again in another screenshot → one item with two sources.
  const map = {}, metAgain = [];
  for (const it of lesson.items) {
    const twin = (it.match_id && state.items[it.match_id] && loose(state.items[it.match_id].form) === loose(it.form) && state.items[it.match_id])
      || Object.values(state.items).find((x) => x.language === p.target && loose(x.form) === loose(it.form) && x.shotId !== shot.id);
    if (twin) {
      if (!twin.sources.some((s) => s.shotId === shot.id)) twin.sources.push({ shotId: shot.id, quote: it.quote });
      twin.metAgain = (twin.metAgain || 0) + 1;
      if (twin.dueAt == null || twin.dueAt > now() + DAY) twin.dueAt = now(); // seen again in real life → review it soon
      map[it.id] = twin.id; metAgain.push(twin.form);
    } else {
      const id = uid("w");
      state.items[id] = {
        id, shotId: shot.id, language: p.target, form: it.form, kind: it.kind, quote: it.quote, sense: it.sense,
        explanation: it.explanation, why: it.why, example: it.example, example_meaning: it.example_meaning,
        sources: [{ shotId: shot.id, quote: it.quote }], streak: 0, dueAt: null, studied: false, created: now(),
        stats: { tasks: 0, answers: 0, indep: [0, 0], writing: [0, 0], assisted: 0, cards: 0, skipped: 0, last: null },
        latest: {}, decision: null,
      };
      map[it.id] = id;
    }
  }
  shot.lesson = {
    items: [...new Set(lesson.items.map((i) => map[i.id]))],
    exercises: lesson.exercises.map((e) => ({ ...e, item: map[e.item], id: `${shot.id}-${e.id}` })),
  };
  shot.focus = focus ? { regions: focus.regions || [], forms: focus.forms || [] } : null;
  shot.status = "ready";
  note(`Built a lesson: ${lesson.items.map((i) => i.form).join(", ")} (${shot.lesson.exercises.length} questions).${metAgain.length ? ` Seen before in another screenshot: ${metAgain.join(", ")} → moved up for review.` : ""}`, shot.id);
}

// Deterministic checks before anything reaches the learner.
function check(raw, focus) {
  const issues = [];
  const text = (Array.isArray(raw?.text) ? raw.text : []).map(String).filter(Boolean).slice(0, 80);
  const corpus = loose([...text, ...(focus?.regions || []).map((r) => r.text)].join("\n"));
  const items = [];
  for (const it of (raw?.items || []).slice(0, 4)) {
    if (!it?.form || !it?.quote || !it?.sense) { issues.push(`Item ${it?.id}: missing form, quote or sense.`); continue; }
    if (!loose(it.quote).includes(loose(it.form))) { issues.push(`Item ${it.id} "${it.form}": the quote does not contain the form.`); continue; }
    if (corpus && !corpus.includes(loose(it.quote))) { issues.push(`Item ${it.id} "${it.form}": the quote is not copied exactly from the text.`); continue; }
    if (focus?.forms?.length && !focus.forms.some((f) => loose(f) === loose(it.form))) { issues.push(`Item ${it.id} "${it.form}" was not chosen by the learner.`); continue; }
    items.push({ id: String(it.id || uid("i")), form: String(it.form), kind: ["vocabulary", "phrase", "grammar"].includes(it.kind) ? it.kind : "vocabulary", quote: String(it.quote), sense: String(it.sense), explanation: String(it.explanation || ""), why: String(it.why || ""), example: it.example ? String(it.example) : "", example_meaning: it.example_meaning ? String(it.example_meaning) : "", match_id: it.match_id || null });
  }
  const exercises = [];
  for (const e of raw?.exercises || []) {
    const item = items.find((i) => i.id === e?.item);
    if (!item) continue;
    const problem = exerciseProblem(e, item);
    if (problem) { issues.push(`Exercise ${e.id} (${e.type}) for "${item.form}": ${problem}`); continue; }
    exercises.push({
      id: String(e.id || uid("e")), item: item.id, type: e.type, phase: phaseOf(e.type),
      prompt: String(e.prompt), context: String(e.context || ""), choices: (e.choices || []).map(String).slice(0, 7),
      answer: String(e.answer), alternatives: (e.alternatives || []).map(String).slice(0, 6),
      explanation: String(e.explanation || ""), hint1: safeHint(e.hint1, e), hint2: safeHint(e.hint2, e),
    });
  }
  // Every item gets at least a recall question that cannot be "guessed": meaning → type the word.
  for (const item of items) {
    if (!exercises.some((e) => e.item === item.id && e.phase === "recall")) exercises.push(recallByMeaning(item));
  }
  return { lesson: { title: raw?.title, topic: raw?.topic, why_saved: raw?.why_saved, source: raw?.source, text, items, exercises }, issues };
}
const phaseOf = (t) => (t === "meaning" ? "recognition" : t === "open" ? "application" : t === "reorder" ? "recall" : "recall");
function exerciseProblem(e, item) {
  if (!["meaning", "cloze", "recall", "reorder", "open"].includes(e.type)) return "unknown type.";
  if (!e.prompt || !e.answer) return "missing prompt or answer.";
  const ans = loose(e.answer);
  if (e.type === "meaning") {
    const ch = (e.choices || []).map(loose);
    if (ch.length < 3 || ch.length > 4) return "needs 3-4 choices.";
    if (new Set(ch).size !== ch.length) return "choices repeat.";
    if (ch.filter((c) => c === ans).length !== 1) return "the answer must be exactly one of the choices.";
  }
  if (e.type === "cloze") {
    const ctx = String(e.context || "");
    if ((ctx.match(/_{3,}/g) || []).length !== 1) return "the sentence must have exactly one blank.";
    if (loose(ctx.replace(/_{3,}/, e.answer)) !== loose(item.quote)) return "filling the blank does not give back the original sentence.";
    const rest = loose(ctx.replace(/_{3,}/, "")).replace(/[^\p{L}\p{N}]+/gu, "");
    if (rest.length < 6) return "the sentence around the blank is too short to be a real clue.";
  }
  if (e.type === "cloze" || e.type === "recall") {
    if (hasWord(`${e.prompt} ${e.context}`, e.answer)) return "the answer is visible in the question.";
  }
  if (e.type === "reorder") {
    const toks = (e.choices || []).map(loose);
    if (toks.length < 3 || toks.length > 8) return "reorder needs 3-8 pieces.";
    if ([...toks].sort().join(" ") !== loose(e.answer).split(" ").sort().join(" ")) return "the pieces do not make the answer.";
  }
  return null;
}
// Whole-word match for alphabets; plain match for Japanese, Chinese and Korean.
export function hasWord(text, word) {
  const t = loose(text), w = loose(word);
  if (!w) return false;
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(w)) return t.includes(w);
  return new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(t);
}
function safeHint(h, e) {
  if (!h) return "";
  if (e.type !== "open" && hasWord(h, e.answer)) return ""; // never give the answer away
  return String(h);
}
export function recallByMeaning(item) {
  const blanked = item.quote.replace(new RegExp(item.form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "____");
  const chars = [...item.form.replace(/\s/g, "")];
  return {
    id: `${item.id}-rm`, item: item.id, type: "recall", phase: "recall",
    prompt: `Type the ${lang(state.profile?.target)} word or phrase from your screenshot that means: “${item.sense}”`,
    context: "", choices: [], answer: item.form, alternatives: [], explanation: item.explanation,
    hint1: blanked !== item.quote ? `It appears in your screenshot here: “${blanked}”` : "Think back to where you saw it in your screenshot.",
    hint2: `It starts with “${chars[0]}” and has ${chars.length} letters (spaces not counted).`,
  };
}

export function recentDifficulties() {
  return state.difficulties.filter((d) => now() - d.t < 14 * DAY).slice(-12);
}

// ---------- TODAY: the agent plans what to study now ----------
export function todayFacts() {
  const items = Object.values(state.items).filter((i) => i.language === state.profile?.target);
  const due = items.filter((i) => i.studied && i.dueAt != null && i.dueAt <= now()).map((i) => ({ id: i.id, form: i.form, metAgain: i.metAgain || 0 }));
  const weak = items.filter((i) => i.decision === "practise" || Object.values(i.latest || {}).includes("incorrect")).map((i) => ({ id: i.id, form: i.form }));
  const ready = state.shots.filter((s) => s.status === "ready");
  const fresh = ready.filter((s) => s.lesson.items.some((id) => !state.items[id]?.studied)).map((s) => ({ id: s.id, title: s.title, savedDaysAgo: Math.floor((now() - s.takenAt) / DAY) }));
  const forgotten = ready.filter((s) => now() - s.takenAt > 10 * DAY && (!s.lastOpened || now() - s.lastOpened > 10 * DAY))
    .map((s) => ({ id: s.id, title: s.title, why_saved: s.why, savedDaysAgo: Math.floor((now() - s.takenAt) / DAY) })).slice(0, 5);
  return { due, weak, fresh, forgotten };
}
export async function planToday() {
  const facts = todayFacts();
  if (!facts.due.length && !facts.weak.length && !facts.fresh.length && !facts.forgotten.length) { state.today = null; return; }
  let plan;
  try {
    const r = await ai("today", { profile: state.profile, facts });
    const ok = new Set([...facts.due, ...facts.weak].map((x) => x.id).concat([...facts.fresh, ...facts.forgotten].map((x) => x.id), [""]));
    plan = { greeting: String(r.greeting || ""), tasks: (r.tasks || []).filter((t) => ok.has(t.ref || "")).slice(0, 4) };
    if (!plan.tasks.length) throw new Error("empty");
  } catch { plan = fallbackToday(facts); }
  state.today = { at: now(), ...plan };
  save(); onChange();
}
export function fallbackToday(f = todayFacts()) {
  const tasks = [];
  if (f.due.length) tasks.push({ type: "review", ref: "", title: `Review ${f.due.length} word${f.due.length > 1 ? "s" : ""} that are due`, why: "Recalling them now, just before you forget, makes them stick." });
  if (f.weak.length) tasks.push({ type: "weak", ref: f.weak[0].id, title: `Practise “${f.weak[0].form}” again`, why: "You missed it last time." });
  if (f.forgotten.length) tasks.push({ type: "revisit", ref: f.forgotten[0].id, title: `Revisit “${f.forgotten[0].title}”`, why: `You saved this ${f.forgotten[0].savedDaysAgo} days ago${f.forgotten[0].why_saved ? `: ${f.forgotten[0].why_saved}` : ""}` });
  if (f.fresh.length) tasks.push({ type: "lesson", ref: f.fresh[0].id, title: `Start “${f.fresh[0].title}”`, why: "New material from your screenshots." });
  return { greeting: "Here is what I suggest today.", tasks: tasks.slice(0, 4) };
}

// ---------- files ----------
const readFile = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
export function resize(src, max, q) {
  return new Promise((ok, no) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      ok(c.toDataURL("image/jpeg", q));
    };
    img.onerror = () => no(new Error("This image could not be opened."));
    img.src = src;
  });
}
// Dates in names like "Screenshot 2026-10-07 at 2.15.13 PM" or "Screenshot_20261007-141513".
export function guessDate(name = "", fallback) {
  const m = name.match(/(20\d\d)[-_.]?(\d\d)[-_.]?(\d\d)\D{0,6}?(\d{1,2})[.\-:_]?(\d\d)(?:[.\-:_]?(\d\d))?\s*(AM|PM)?/i);
  if (m) {
    let h = +m[4];
    if (m[7]) { if (/pm/i.test(m[7]) && h < 12) h += 12; if (/am/i.test(m[7]) && h === 12) h = 0; }
    const d = new Date(+m[1], +m[2] - 1, +m[3], h, +m[5], +(m[6] || 0));
    if (!isNaN(d)) return d.getTime();
  }
  return fallback || now();
}
// Accepts files and whole folders dropped from the desktop.
export async function filesFromDrop(dt) {
  const out = [];
  const walk = async (entry) => {
    if (!entry) return;
    if (entry.isFile) { const f = await new Promise((ok) => entry.file(ok, () => ok(null))); if (f && f.type.startsWith("image/")) out.push({ file: f, name: f.name }); }
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do { batch = await new Promise((ok) => reader.readEntries(ok, () => ok([]))); for (const e of batch) await walk(e); } while (batch.length);
    }
  };
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length) { for (const e of entries) await walk(e); }
  else for (const f of dt.files) if (f.type.startsWith("image/")) out.push({ file: f, name: f.name });
  return out;
}
export async function loadSamples() {
  const m = await (await fetch("samples/manifest.json")).json();
  const list = [...m.roll, ...(m.newer || [])];
  return addFiles(shuffle(list).map((x) => ({ url: `samples/${x.file}`, name: x.file, takenAt: new Date(x.takenAt).getTime() })));
}
export { shotById };
