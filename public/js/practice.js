// Practice engine: build a session, check answers, give hints, teach, schedule the next review.
// Rule of thumb: only recall done WITHOUT help moves a review date forward. Help is never hidden.
import { state, save, now, uid, loose, shuffle, DAY, lang } from "./store.js";
import { ai, recallByMeaning, recentDifficulties } from "./agent.js";

export const MODES = {
  mixed: { label: "Guided lesson", description: "The tutor teaches each word first, checks the meaning, asks you to recall it, then has you use it." },
  flashcards: { label: "Flashcards", description: "Think of the meaning, turn the card over, and say whether you remembered." },
  recall: { label: "Recall", description: "Type the missing word or phrase from your screenshot. Hints if you get stuck." },
  writing: { label: "Guided writing", description: "Write a short message with the word. The AI checks it and helps you revise." },
  dialogue: { label: "Mini-dialogue", description: "Write a two-line conversation using what you captured." },
};
export const STYLES = { message: "Send a message", question: "Ask a question", dialogue: "Make a dialogue", personal: "Connect to your life", rewrite: "Adapt the source", plan: "Make a plan" };
const INTERVALS = [3, 7, 14, 30, 60]; // days until the next check after 1, 2, 3… recalls in a row without help
export const DIFFICULTY = { retrieval: "recalling the wording", meaning: "meaning in context", grammar: "sentence structure", "word-order": "word order", "task-fit": "answering the task" };

export function applicationPrompt(item, style) {
  const p = state.profile, f = `“${item.form}”`;
  const task = {
    message: `Write a message using ${f} for your goal: ${p.goal}`,
    question: `Ask a question using ${f} that you could use in everyday life.`,
    dialogue: `Write a two-line conversation. Use ${f} in one of the lines.`,
    personal: `Use ${f} to describe something from your own life.`,
    rewrite: `Change the original sentence to a different person, place or time. Keep ${f}.`,
    plan: `Use ${f} in a plan or invitation for something you would like to do.`,
  }[style];
  const extra = p.level.startsWith("A") ? " Keep it simple: one short sentence is enough." : p.level.startsWith("C") ? " Add detail and pick a tone that fits your reader." : " Make the situation clear.";
  return `${task}${extra} (Write in ${lang(p.target)}.)`;
}

const allExercises = () => state.shots.filter((s) => s.lesson).flatMap((s) => s.lesson.exercises);
const exercisesFor = (itemId) => allExercises().filter((e) => e.item === itemId);
function openFor(item, style) {
  return { id: `${item.id}-open-${style}`, item: item.id, type: "open", phase: "application", prompt: applicationPrompt(item, style), context: "", choices: [], answer: item.example || item.quote, alternatives: [], explanation: item.explanation, hint1: "", hint2: "", style };
}
function pickRecall(item, avoidId) {
  const list = exercisesFor(item.id).filter((e) => e.phase === "recall");
  const pick = list.find((e) => e.id !== avoidId && e.type === "cloze") || list.find((e) => e.id !== avoidId) || list[0];
  return pick || recallByMeaning(item);
}

// ---------- start a session ----------
export function startSession({ mode, itemIds, title, shotId = null, review = false }) {
  const items = itemIds.map((id) => state.items[id]).filter(Boolean);
  const styles = Object.keys(STYLES);
  let queue = [];
  if (mode === "flashcards") queue = items.map((i) => ({ id: `${i.id}-card`, item: i.id, type: "flashcard", phase: "recognition" }));
  else if (mode === "recall") queue = items.map((i) => pickRecall(i, lastExercise(i)));
  else if (mode === "writing") queue = items.map((i, n) => openFor(i, styles[n % styles.length] === "dialogue" ? "message" : styles[n % styles.length]));
  else if (mode === "dialogue") queue = items.map((i) => openFor(i, "dialogue"));
  else if (review) {
    // Due review: recall first, without teaching. Teaching comes after the attempt.
    queue = [...items.map((i) => pickRecall(i, lastExercise(i))), ...items.filter(isWeak).slice(0, 2).map((i, n) => openFor(i, styles[n + 1]))];
  } else {
    // Guided lesson: learn → check meaning (per item), then recall all (a little later = spacing), then use.
    const due = items.filter((i) => i.studied && i.dueAt != null && i.dueAt <= now());
    const rest = items.filter((i) => !due.includes(i));
    queue.push(...due.map((i) => pickRecall(i, lastExercise(i))));
    for (const i of rest) {
      if (!i.studied) queue.push({ id: `${i.id}-learn`, item: i.id, type: "learn", phase: "teach" });
      const m = exercisesFor(i.id).find((e) => e.type === "meaning");
      if (m) queue.push(m);
    }
    queue.push(...rest.map((i) => pickRecall(i)));
    const reorder = rest.flatMap((i) => exercisesFor(i.id).filter((e) => e.type === "reorder")).slice(0, 1);
    queue.push(...reorder.filter((r) => !queue.includes(r)));
    queue.push(...rest.slice(0, 2).map((i, n) => { const own = exercisesFor(i.id).find((e) => e.type === "open"); return own ? { ...own, style: null } : openFor(i, styles[n]); }));
  }
  const s = { id: uid("p"), title, mode, shotId, review, items: items.map((i) => i.id), queue: queue.map((e, n) => ({ ...e, choices: ["meaning", "reorder"].includes(e.type) ? shuffle(e.choices) : e.choices, key: `${n}-${e.id}` })), index: 0, fresh: items.filter((i) => !i.studied).map((i) => i.id), steps: {}, taught: [], started: now(), done: false };
  state.sessions[s.id] = s;
  state.activeSession = s.id;
  save();
  return s;
}
const lastExercise = (item) => item.lastRecall || null;
const isWeak = (i) => i.decision === "practise" || Object.values(i.latest || {}).includes("incorrect");

export const current = (s) => s.queue[s.index] || null;
export function step(s, e) { return (s.steps[e.key] ||= { stage: "attempt", hints: [], attempts: [], revealed: false, help: false, feedback: null }); }

// ---------- actions ----------
export function learnDone(s) {
  const e = current(s), item = state.items[e.item];
  s.taught.push(item.id);
  firstEncounter(item);
  next(s);
}
function firstEncounter(item) {
  if (!item.studied) { item.studied = true; item.dueAt = now() + DAY; } // first meeting → check tomorrow
}

export async function check(s, answer) {
  const e = current(s), st = step(s, e), item = state.items[e.item];
  answer = String(answer || "").trim();
  if (!answer) return;
  let fb;
  if (e.type === "open") {
    try {
      const r = await ai("grade", { profile: state.profile, exercise: { prompt: e.prompt }, item: { form: item.form, sense: item.sense, quote: item.quote }, answer, attempt: st.attempts.length + 1, difficulties: recentDifficulties().map((d) => DIFFICULTY[d.d] || d.d) });
      fb = { outcome: ["correct", "incorrect", "uncertain"].includes(r.outcome) ? r.outcome : "uncertain", method: "ai", explanation: r.explanation || "", diagnosis: r.diagnosis, hint: r.hint, nextHint: r.next_hint, expected: r.better || e.answer };
    } catch {
      fb = { outcome: "uncertain", method: "none", explanation: "The AI check could not finish. Compare your sentence with the example below.", expected: e.answer };
    }
  } else {
    const ok = [e.answer, ...(e.alternatives || [])].some((a) => loose(a) === loose(answer));
    fb = { outcome: ok ? "correct" : "incorrect", method: "objective", explanation: e.explanation, expected: e.answer, diagnosis: ok ? null : e.phase === "recognition" ? "meaning" : e.type === "reorder" ? "word-order" : "retrieval" };
  }
  st.attempts.push({ answer, outcome: fb.outcome, t: now() });
  item.stats.answers++;
  if (st.help) item.stats.assisted++;
  if (fb.outcome === "incorrect" && fb.diagnosis && fb.diagnosis !== "none") {
    state.difficulties.push({ itemId: item.id, d: fb.diagnosis, t: now() });
    state.difficulties = state.difficulties.slice(-50);
  }
  // Wrong and still trying → stay on the question with a hint (up to 5 tries).
  if (fb.outcome === "incorrect" && st.attempts.length < 5 && !st.revealed) {
    st.stage = "revise"; st.help = true; st.last = fb;
    addHint(s, e, st, fb);
  } else finish(s, e, st, fb);
  save();
}
export function hint(s) {
  const e = current(s), st = step(s, e);
  st.help = true;
  addHint(s, e, st, st.last);
  save();
}
function addHint(s, e, st, fb) {
  if (st.hints.length >= 2) return;
  const level = st.hints.length + 1;
  let h = level === 1 ? (fb?.hint || e.hint1) : (fb?.nextHint || e.hint2);
  if (!h) h = genericHint(e, level);
  if (!st.hints.includes(h)) st.hints.push(h);
}
function genericHint(e, level) {
  if (e.type === "open") return level === 1 ? "Read your sentence aloud. Is the target word doing the job it did in your screenshot?" : "Try a shorter sentence with a clear subject and verb.";
  if (e.type === "cloze") return level === 1 ? "Read the words on both sides of the gap. What kind of word fits?" : `The missing part has ${[...e.answer.replace(/\s/g, "")].length} letters (spaces not counted).`;
  if (e.type === "reorder") return level === 1 ? "Find the subject and the verb first." : "Check which words belong together, then read the whole sentence aloud.";
  if (e.type === "recall") return level === 1 ? "Think of the screenshot where you saw it." : `It starts with “${[...e.answer][0]}”.`;
  return level === 1 ? "Read the sentence again. Which meaning fits this situation?" : "Rule out the choice that would change what the sentence is saying.";
}
export function reveal(s) {
  const e = current(s), st = step(s, e);
  st.revealed = true; st.help = true;
  if (e.type === "flashcard") { st.stage = "done"; st.feedback = { outcome: "card" }; s.taught.push(e.item); state.items[e.item].stats.cards++; firstEncounter(state.items[e.item]); save(); return; }
  finish(s, e, st, { outcome: "revealed", method: "shown", explanation: e.explanation, expected: e.answer });
  save();
}
export function skip(s) {
  const e = current(s), st = step(s, e);
  st.stage = "done"; st.feedback = { outcome: "skipped" };
  if (state.items[e.item]) state.items[e.item].stats.skipped++;
  next(s);
}
export function decide(s, decision) {
  const e = current(s), st = step(s, e), item = state.items[e.item];
  st.decision = decision; item.decision = decision;
  save();
}
export function setStyle(s, style) {
  const e = current(s), item = state.items[e.item];
  s.queue[s.index] = { ...e, style, prompt: applicationPrompt(item, style) };
  save();
}
export function next(s) {
  s.index++;
  if (s.index >= s.queue.length) { s.done = true; s.finished = now(); state.lastRecap = s.id; if (state.activeSession === s.id) state.activeSession = null; }
  save();
}

// The question is over: record what really happened and move the review date only when it is earned.
function finish(s, e, st, fb) {
  const item = state.items[e.item];
  st.stage = "done"; st.feedback = fb;
  item.stats.tasks++; item.stats.last = now();
  if (fb.outcome !== "revealed") item.latest = { ...item.latest, [e.phase]: fb.outcome === "correct" ? "correct" : fb.outcome };
  if (e.phase === "recall") item.lastRecall = e.id;
  if (e.type === "open" && fb.method === "ai" && fb.outcome !== "uncertain") {
    item.stats.writing[1]++; if (fb.outcome === "correct") item.stats.writing[0]++;
  }
  if (fb.outcome === "correct" && st.attempts.length === 1) item.decision = null;
  const independent = !st.help && st.attempts.length === 1 && !s.taught.includes(item.id);
  if (e.phase === "recall" && e.type !== "open") {
    if (independent) {
      item.stats.indep[1]++;
      if (fb.outcome === "correct") item.stats.indep[0]++;
    }
    const wasDue = item.studied && item.dueAt != null && item.dueAt <= now();
    if (independent && wasDue) {
      if (fb.outcome === "correct") { item.streak++; item.dueAt = now() + INTERVALS[Math.min(item.streak - 1, 4)] * DAY; fb.schedule = `Remembered without help. Next check in ${INTERVALS[Math.min(item.streak - 1, 4)]} day${item.streak > 1 ? "s" : ""}.`; }
      else { item.streak = 0; item.dueAt = now() + DAY; fb.schedule = "We'll check this again tomorrow."; }
    } else if (!item.studied || s.fresh?.includes(item.id)) { firstEncounter(item); fb.schedule = "First time practising this. We'll check it tomorrow without help."; }
    else if (!independent) fb.schedule = "Practice with help (hints, teaching or several tries). Your next review date stays the same.";
  }
  if (!item.studied) firstEncounter(item);
  s.taught.push(item.id); // after the answer is shown, later recall in this session is not independent
}

// ---------- after the session ----------
export function summary(s) {
  const per = s.items.map((id) => {
    const item = state.items[id];
    const qs = s.queue.filter((e) => e.item === id && s.steps[e.key]);
    const done = qs.map((e) => ({ e, st: s.steps[e.key] }));
    return {
      item,
      independent: done.some(({ e, st }) => e.phase === "recall" && e.type !== "open" && st.feedback?.outcome === "correct" && !st.help && st.attempts.length === 1),
      withHelp: done.some(({ e, st }) => e.phase === "recall" && st.feedback?.outcome === "correct" && (st.help || st.attempts.length > 1)),
      wrote: done.some(({ e, st }) => e.type === "open" && st.feedback?.outcome === "correct"),
      mistakes: done.flatMap(({ e, st }) => st.attempts.filter((a) => a.outcome === "incorrect").map((a) => ({ prompt: e.prompt, answer: a.answer, expected: st.feedback?.expected || e.answer, type: e.type }))),
      unsure: done.some(({ st }) => st.feedback?.outcome === "uncertain" || st.feedback?.outcome === "revealed" || st.decision === "practise" || st.decision === "unsure"),
      card: done.find(({ e }) => e.type === "flashcard")?.st.decision || null,
    };
  }).filter((x) => x.item);
  return {
    items: per,
    independent: per.filter((x) => x.independent).length,
    again: per.filter((x) => x.mistakes.length || x.unsure || x.card === "practise").length,
    answered: Object.values(s.steps).filter((st) => st.feedback && st.feedback.outcome !== "skipped").length,
  };
}

export const STATUS = { "needs-practice": "Needs practice", due: "Review due", new: "Not practised yet", building: "Building familiarity", remembering: "Remembering well" };
export function statusOf(item) {
  if (!item.studied) return { key: "new", reason: "Try this to start your history." };
  const wrong = Object.entries(item.latest || {}).find(([, o]) => o === "incorrect");
  if (wrong || item.decision === "practise" || item.decision === "unsure") return { key: "needs-practice", reason: wrong ? (wrong[0] === "application" ? "Your latest sentence needed a revision." : wrong[0] === "recall" ? "Your latest recall needed another try." : "The meaning check needed another try.") : "You marked this for more practice." };
  if (item.dueAt != null && item.dueAt <= now()) return { key: "due", reason: item.metAgain ? "You saved this word again in another screenshot, so it is up for review now." : "Time to check what you remember." };
  if (item.streak >= 2 && item.stats.indep[0] >= 2) return { key: "remembering", reason: "Recalled without help in at least two spaced reviews." };
  return { key: "building", reason: item.stats.indep[0] ? "Recalled without help once. More spaced reviews will show what sticks." : "Practised. A check without help is still to come." };
}
export const toRevisit = () => Object.values(state.items).filter((i) => i.language === state.profile?.target && ["due", "needs-practice"].includes(statusOf(i).key));
export { shuffle };
