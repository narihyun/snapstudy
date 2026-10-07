// SnapStudy UI: Library (add + sort screenshots), Practice (tutor), Progress (what is sticking).
import { state, save, now, images, esc, lang, LANGS, TARGETS, LEVELS, DAY, fmtDate, ago, shotById, replaceState, blank, loose } from "./store.js";
import { addFiles, runAgent, isRunning, retry, studyAnyway, setAside, buildLesson, setOnChange, filesFromDrop, loadSamples, aiStatus, planToday, fallbackToday, todayFacts, MAX_SHOTS } from "./agent.js";
import * as P from "./practice.js";
import { regionEditor, findTextBoxes, regionListHTML, readAreas } from "./regions.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
let view = ["library", "practice", "progress"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "library";
let libTab = "study", filters = { q: "", topic: "", due: false }, progFilter = { q: "", status: "all" };
let showRecap = false, aiState = "unknown", busy = "";

// ---------- top level ----------
function render() {
  $$("nav button").forEach((b) => { const on = b.dataset.view === view; b.classList.toggle("active", on); b.toggleAttribute("aria-current", on); });
  const p = state.profile;
  $("#profileChip").textContent = p ? `${lang(p.target)} · ${p.level}` : "Set up";
  const v = $("#view");
  const y = window.scrollY;
  // Keep the cursor in a search box when the screen refreshes.
  const a = document.activeElement, key = a?.dataset?.filter ? `[data-filter="${a.dataset.filter}"]` : a?.dataset?.pfilter ? `[data-pfilter="${a.dataset.pfilter}"]` : null, pos = a?.selectionStart;
  v.innerHTML = view === "library" ? libraryHTML() : view === "practice" ? practiceHTML() : progressHTML();
  hydrate(v);
  if (key) { const b = $(key); if (b) { b.focus(); if (pos != null && b.setSelectionRange) b.setSelectionRange(pos, pos); } }
  if (y && view !== "practice") window.scrollTo(0, y);
}
// Background agent work refreshes the screen, but never while the learner is answering a question.
setOnChange(() => { const s = state.sessions[state.activeSession]; if (view !== "practice" || !s || s.done) render(); });
function go(next) {
  view = next; showRecap = false; history.replaceState(null, "", `#${next}`); render(); window.scrollTo(0, 0);
  const s = state.sessions[state.activeSession];
  if (next === "practice" && state.profile && aiState === "ready" && !isRunning() && (!state.today || now() - state.today.at > 6 * 3600000)
    && state.shots.some((x) => x.status === "ready") && (!s || s.done)) planToday().then(render);
}
function banner(msg) { $("#bannerText").textContent = msg; $("#banner").hidden = !msg; }
$("#bannerClose").onclick = () => banner("");
const working = (msg) => (msg ? `<div class="working" role="status"><span class="spinner"></span>${esc(msg)}</div>` : "");
async function withBusy(msg, fn) { busy = msg; render(); try { await fn(); } catch (e) { banner(e.message); } finally { busy = ""; render(); } }

// Images come from IndexedDB after the HTML is in place.
function hydrate(root) {
  $$("img[data-thumb]", root).forEach(async (img) => { const src = await images.get("thumb", img.dataset.thumb); if (src) img.src = src; });
  $$("img[data-full]", root).forEach(async (img) => { const src = await images.get("full", img.dataset.full); if (src) img.src = src; });
}

// ---------- LIBRARY ----------
const ICON_IMG = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 5h6"/><path d="M19 2v6"/><path d="M21 11.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7.5"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/><circle cx="9" cy="9" r="2"/></svg>`;
const counts = () => {
  const c = { ready: 0, aside: 0, failed: 0, working: 0, total: state.shots.length };
  for (const s of state.shots) {
    if (s.status === "ready") c.ready++; else if (s.status === "aside") c.aside++; else if (s.status === "failed") c.failed++; else c.working++;
  }
  return c;
};
function libraryHTML() {
  const c = counts();
  return `
  <div class="view-heading"><h1 tabindex="-1">Library</h1><button class="primary" data-act="pick">+ Add screenshots</button></div>
  ${!state.shots.length ? introHTML() : ""}
  <div class="upload-dropzone" id="dropzone">${ICON_IMG}
    <p><strong>Drop screenshots or a whole folder here</strong><span>Up to ${MAX_SHOTS} at a time · PNG, JPG or WebP · the agent sorts them for you</span></p>
    <div class="row-actions tight"><button data-act="pick">Choose files</button><button data-act="folder">Choose a folder</button></div>
  </div>
  ${agentPanelHTML(c)}
  ${state.shots.length ? `
  <div class="tabs" role="tablist">
    ${tab("study", `Study material`, c.ready)}${tab("aside", "Set aside", c.aside)}${c.failed ? tab("failed", "Needs attention", c.failed) : ""}${c.working ? tab("working", "In progress", c.working) : ""}
  </div>
  ${libTab === "study" ? studyListHTML() : libTab === "aside" ? asideListHTML() : libTab === "failed" ? failedListHTML() : workingListHTML()}` : ""}`;
}
const tab = (key, label, n) => `<button role="tab" data-act="tab" data-tab="${key}" aria-selected="${libTab === key}" class="${libTab === key ? "active" : ""}">${label} <span class="count">${n}</span></button>`;
function introHTML() {
  return `<section class="intro">
    <h2>Your screenshots, turned into lessons.</h2>
    <p>You save screenshots of words, chats, subtitles and articles, then never look at them again. Drop them here. The SnapStudy agent does the rest:</p>
    <ol class="intro-steps">
      <li><strong>Sorts</strong><span>Keeps screenshots with ${esc(lang(state.profile?.target || "en"))} worth studying and sets the rest aside, with a reason.</span></li>
      <li><strong>Reads and remembers why</strong><span>Reads each one, guesses why you saved it and where it came from.</span></li>
      <li><strong>Teaches</strong><span>Picks up to four things at your level, explains them, then checks you: meaning, recall, then your own sentence.</span></li>
      <li><strong>Brings it back</strong><span>Plans what to review each day, before you forget, and notices when a word shows up again.</span></li>
    </ol>
    <div class="row-actions"><button class="primary" data-act="samples">Try with 23 sample screenshots</button><button data-act="pick">Use my own screenshots</button></div>
  </section>`;
}
function agentPanelHTML(c) {
  const live = state.shots.filter((s) => ["triaging", "reading"].includes(s.status));
  const sorted = state.shots.filter((s) => s.triage).length;
  if (!state.log.length && !c.working) return "";
  const pct = c.total ? Math.round(((c.ready + c.aside + c.failed) / c.total) * 100) : 0;
  return `<section class="upload-queue agent-panel" aria-live="polite">
    <div class="upload-heading"><div>
      <h2>${isRunning() || c.working ? `<span class="spinner"></span> The agent is working` : "Agent is idle"}</h2>
      <p>${sorted} of ${c.total} sorted · ${c.ready} lesson${c.ready === 1 ? "" : "s"} ready · ${c.aside} set aside${c.failed ? ` · ${c.failed} need attention` : ""}</p>
    </div>${c.working ? `<div class="bar" aria-hidden="true"><i style="width:${pct}%"></i></div>` : ""}</div>
    ${live.length ? `<ul>${live.slice(0, 4).map((s) => `<li class="upload-item"><div class="upload-file"><strong>${esc(s.name)}</strong><p>${s.status === "triaging" ? "Checking the language…" : "Reading it and building a lesson…"}</p></div></li>`).join("")}</ul>` : ""}
    ${state.log.length ? `<details class="agent-log"><summary>What the agent did</summary><ol>${state.log.slice(-40).reverse().map(logLine).join("")}</ol></details>` : ""}
  </section>`;
}
function logLine(l) {
  const s = l.shot ? shotById(l.shot) : null;
  const where = s ? ` <span class="muted">· ${esc(s.title || s.name)}</span>` : "";
  const time = new Date(l.t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  if (l.step === "note") return `<li><span class="muted">${time}</span> ${esc(l.text)}${where}</li>`;
  const label = { triage: "Sorted a batch of screenshots", lesson: "Read a screenshot and drafted a lesson", grade: "Checked a written answer", today: "Planned today's study" }[l.step] || l.step;
  return `<li><span class="muted">${time}</span> ${label}${where}${l.error ? ` <span class="bad">· failed: ${esc(l.error)}</span>` : l.ms ? ` <span class="muted">· ${(l.ms / 1000).toFixed(1)}s${l.tokens ? `, ${l.tokens} tokens` : ""}</span>` : ""}</li>`;
}
function studyListHTML() {
  const ready = state.shots.filter((s) => s.status === "ready");
  if (!ready.length) return `<div class="empty-state">${ICON_IMG}<h2>No lessons yet</h2><p>${counts().working ? "The agent is still working. Lessons appear here as they are ready." : "Add screenshots with the language you are learning."}</p></div>`;
  const topics = [...new Set(ready.map((s) => s.topic).filter(Boolean))].sort();
  const q = loose(filters.q);
  const shown = ready.filter((s) => {
    const items = s.lesson.items.map((id) => state.items[id]).filter(Boolean);
    if (filters.topic && s.topic !== filters.topic) return false;
    if (filters.due && !items.some((i) => ["due", "needs-practice"].includes(P.statusOf(i).key))) return false;
    return !q || loose([s.title, s.why, s.topic, ...(s.text || []), ...items.map((i) => `${i.form} ${i.sense}`)].join(" ")).includes(q);
  }).sort((a, b) => b.takenAt - a.takenAt);
  return `<section class="library-tools" aria-label="Find screenshots">
      <label class="library-search">Search<input type="search" data-filter="q" value="${esc(filters.q)}" placeholder="Search titles, text, words"></label>
      <div class="library-filters">
        <label>Topic<select data-filter="topic"><option value="">All topics</option>${topics.map((t) => `<option ${t === filters.topic ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>
        <label class="due-filter"><input type="checkbox" data-filter="due" ${filters.due ? "checked" : ""}> To revisit</label>
      </div>
      <div class="filter-summary"><p role="status">${shown.length} of ${ready.length} screenshots</p>${filters.q || filters.topic || filters.due ? `<button class="text-button" data-act="clearFilters">Clear filters</button>` : ""}</div>
    </section>
    ${shown.length ? `<div class="capture-list">${shown.map(rowHTML).join("")}</div>` : `<div class="empty-state"><h2>No matching screenshots</h2><button data-act="clearFilters">Show all</button></div>`}`;
}
function rowHTML(s) {
  const items = s.lesson.items.map((id) => state.items[id]).filter(Boolean);
  return `<article class="capture-row">
    <button class="thumbnail" data-act="source" data-id="${s.id}" aria-label="View source: ${esc(s.title)}"><img alt="" data-thumb="${s.id}"></button>
    <div class="capture-body">
      <div class="metadata">Saved ${fmtDate(s.takenAt)} · ${ago(s.takenAt)}${s.topic ? `<span>${esc(s.topic)}</span>` : ""}${s.focus?.regions?.length ? `<span>${s.focus.regions.length} area${s.focus.regions.length > 1 ? "s" : ""} chosen</span>` : ""}</div>
      <h2>${esc(s.title || s.name)}</h2>
      ${s.why ? `<p class="why"><span class="muted">Why you saved it:</span> ${esc(s.why)}</p>` : ""}
      <div class="item-forms">${items.map((i) => `<span class="chip ${P.statusOf(i).key}" title="${esc(P.STATUS[P.statusOf(i).key])}" lang="${i.language}">${esc(i.form)}${i.sources.length > 1 ? `<small> · seen ${i.sources.length}×</small>` : ""}</span>`).join("")}</div>
      <div class="row-actions">
        <button class="text-button" data-act="regions" data-id="${s.id}">Choose text</button>
        <button class="text-button" data-act="source" data-id="${s.id}">View source</button>
        <button class="text-button" data-act="setAside" data-id="${s.id}">Set aside</button>
        <button class="primary" data-act="practise" data-id="${s.id}">Practise</button>
      </div>
    </div></article>`;
}
function asideListHTML() {
  const list = state.shots.filter((s) => s.status === "aside");
  if (!list.length) return `<div class="empty-state"><h2>Nothing set aside</h2><p>Screenshots without useful ${esc(lang(state.profile?.target))} land here, so they don't clutter your lessons.</p></div>`;
  return `<p class="muted tab-lead">The agent set these aside because they don't have useful ${esc(lang(state.profile?.target))} for you. Disagree? Choose “Study anyway”.</p>
    <div class="capture-list">${list.map((s) => `<article class="capture-row compact">
      <button class="thumbnail small" data-act="source" data-id="${s.id}" aria-label="View ${esc(s.name)}"><img alt="" data-thumb="${s.id}"></button>
      <div class="capture-body">
        <div class="metadata">Saved ${fmtDate(s.takenAt)}${s.triage?.languages?.length ? `<span>Languages: ${esc(s.triage.languages.map(lang).join(", "))}</span>` : ""}</div>
        <h2>${esc(s.title || s.name)}</h2>
        <p class="muted">${esc(s.triage?.reason || "")}</p>
        <div class="row-actions"><button data-act="studyAnyway" data-id="${s.id}">Study anyway</button></div>
      </div></article>`).join("")}</div>`;
}
function failedListHTML() {
  return `<div class="capture-list">${state.shots.filter((s) => s.status === "failed").map((s) => `<article class="capture-row compact">
    <div class="thumbnail small"><img alt="" data-thumb="${s.id}"></div>
    <div class="capture-body"><h2>${esc(s.name)}</h2><p class="bad">${esc(s.error || "Something went wrong.")}</p>
    <div class="row-actions"><button data-act="retry" data-id="${s.id}">Try again</button><button class="text-button" data-act="setAside" data-id="${s.id}">Set aside</button></div></div></article>`).join("")}
    <div class="row-actions"><button data-act="retryAll">Try all again</button></div></div>`;
}
function workingListHTML() {
  const label = { queued: "Waiting to be sorted", triaging: "Checking the language…", kept: "Kept · waiting for a closer read", reading: "Reading and building a lesson…" };
  return `<div class="capture-list">${state.shots.filter((s) => label[s.status]).map((s) => `<article class="capture-row compact">
    <div class="thumbnail small"><img alt="" data-thumb="${s.id}"></div>
    <div class="capture-body"><h2>${esc(s.name)}</h2><p class="muted">${["triaging", "reading"].includes(s.status) ? '<span class="spinner inline"></span> ' : ""}${label[s.status]}</p></div></article>`).join("")}</div>`;
}

// ---------- PRACTICE ----------
function practiceHTML() {
  const s = state.activeSession && state.sessions[state.activeSession];
  if (s && !s.done) return sessionHTML(s);
  if (showRecap && state.lastRecap && state.sessions[state.lastRecap]) return recapHTML(state.sessions[state.lastRecap]);
  const ready = state.shots.filter((x) => x.status === "ready");
  const revisit = P.toRevisit();
  const plan = state.today || (ready.length ? fallbackToday() : null);
  return `<div class="view-heading"><h1 tabindex="-1">Practice</h1></div>
  ${working(busy)}
  ${plan?.tasks?.length ? `<section class="today-card">
      <span class="eyebrow">Your study agent · today</span>
      <h2>${esc(plan.greeting || "Here is what I suggest today.")}</h2>
      <ol>${plan.tasks.map((t, n) => `<li><div><strong>${esc(t.title)}</strong><span>${esc(t.why)}</span></div><button class="${n ? "" : "primary"}" data-act="task" data-type="${esc(t.type)}" data-ref="${esc(t.ref || "")}">Start</button></li>`).join("")}</ol>
      <small>${state.today ? "Planned by the AI from your screenshots, mistakes and review dates." : "Planned from your review dates and mistakes."}</small>
    </section>` : ""}
  <div class="practice-start">
    ${state.lastRecap && state.sessions[state.lastRecap] ? `<button data-act="recap">View last recap</button>` : ""}
    ${revisit.length ? `<button class="primary" data-act="reviewAll">Review ${revisit.length} word${revisit.length > 1 ? "s" : ""} to revisit</button>` : ""}
    ${ready.length ? `<div class="practice-list">${ready.map((x) => {
      const items = x.lesson.items.map((id) => state.items[id]).filter(Boolean);
      const st = items.map((i) => P.statusOf(i).key);
      const note = st.some((k) => k === "due" || k === "needs-practice") ? "Ready for review" : st.every((k) => k === "new") ? "Not practised yet" : (() => { const d = Math.min(...items.filter((i) => i.dueAt).map((i) => i.dueAt)); return isFinite(d) ? `Next review ${fmtDate(d)}` : "Practised"; })();
      return `<button data-act="practise" data-id="${x.id}"><span>${esc(x.title)}<small>${esc(items.map((i) => i.form).join(" · "))} — ${note}</small></span><span>Practise</span></button>`;
    }).join("")}</div>` : `<div class="empty-state">${ICON_IMG}<h2>No practice yet</h2><p>Add screenshots in the Library. The agent turns them into lessons.</p><button data-act="goLibrary">Open library</button></div>`}
  </div>`;
}
const markForm = (text, form) => {
  const i = String(text).toLocaleLowerCase().indexOf(String(form).toLocaleLowerCase());
  return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + form.length))}</mark>${esc(text.slice(i + form.length))}`;
};
const blankify = (t) => esc(t).replace(/_{3,}/, '<span class="blank" aria-label="blank">　　　　</span>');
function teachHTML(item, title = "Meaning & use") {
  const shot = shotById(item.shotId);
  return `<section class="teaching" aria-label="Meaning and use">
    <h3>${esc(title)}</h3>
    <p class="teach-sense"><strong lang="${item.language}">${esc(item.form)}</strong> — ${esc(item.sense)}</p>
    ${item.explanation ? `<p>${esc(item.explanation)}</p>` : ""}
    <p class="source-example"><span class="eyebrow">In your screenshot${shot ? ` “${esc(shot.title)}”` : ""}</span><span lang="${item.language}">${markForm(item.quote, item.form)}</span></p>
    ${item.example ? `<p><span class="eyebrow">Another example</span><span lang="${item.language}">${markForm(item.example, item.form)}</span>${item.example_meaning ? `<br><span class="muted">${esc(item.example_meaning)}</span>` : ""}</p>` : ""}
    ${item.sources.length > 1 ? `<p class="muted">You saved this in ${item.sources.length} different screenshots.</p>` : ""}
  </section>`;
}
const PHASE_LABEL = { learn: "New for you", meaning: "Meaning in context", cloze: "Recall", recall: "Recall", reorder: "Put it in order", open: "Use it yourself", flashcard: "Flashcard" };
function sessionHTML(s) {
  const e = P.current(s), st = P.step(s, e), item = state.items[e.item];
  // A word saved in several screenshots: show the one this lesson came from.
  const src = item?.sources.find((x) => x.shotId === s.shotId) || { shotId: item?.shotId, quote: item?.quote };
  const shot = shotById(src.shotId);
  const done = st.stage === "done";
  const pct = Math.round((s.index / s.queue.length) * 100);
  let body = "";
  if (e.type === "learn") {
    body = `<div class="learn-card">
      <p class="practice-purpose">Read this first. Then I'll check whether it stuck.</p>
      <span class="eyebrow">${esc(item.kind)}${shot ? ` · from “${esc(shot.title)}”` : ""}</span>
      <h2 class="learn-form" lang="${item.language}">${esc(item.form)}</h2>
      <p class="learn-sense">${esc(item.sense)}</p>
      ${item.explanation ? `<p>${esc(item.explanation)}</p>` : ""}
      <div class="question-context"><span class="eyebrow">In your screenshot</span><p lang="${item.language}">${markForm(src.quote, item.form)}</p></div>
      ${item.sources.length > 1 ? `<p class="muted small">You saved this word in ${item.sources.length} screenshots, so it keeps coming up for you.</p>` : ""}
      ${shot?.why ? `<p class="muted small">You saved it because: ${esc(shot.why)}</p>` : ""}
      ${item.example ? `<div class="example"><span class="eyebrow">Another example</span><p lang="${item.language}">${markForm(item.example, item.form)}</p>${item.example_meaning ? `<p class="muted">${esc(item.example_meaning)}</p>` : ""}</div>` : ""}
      ${item.why ? `<p class="why-pick"><strong>Why this one:</strong> ${esc(item.why)}</p>` : ""}
      <div class="question-actions"><button class="primary" data-act="learned">Got it — check me</button></div>
    </div>`;
  } else if (e.type === "flashcard") {
    body = `<section class="flashcard-study" aria-label="Flashcard">
      <p class="muted">Think of the meaning before you turn the card over.</p>
      <h2 class="flashcard-word" lang="${item.language}">${esc(item.form)}</h2>
      ${!done ? `<div class="row-actions center"><button class="primary" data-act="reveal">Turn card over</button><button class="text-button" data-act="skip">Skip for now</button></div>`
      : `<div class="flashcard-back">${teachHTML(item)}
          <p class="muted">Your own rating. It does not count as a checked answer.</p>
          ${!st.decision ? `<div class="row-actions"><button data-act="decide" data-d="practise">Still learning</button><button data-act="decide" data-d="confident">I remembered</button></div>` : `<p role="status">${st.decision === "confident" ? "Remembered · your rating" : "Marked for more practice"}</p>`}
          <button class="primary" data-act="next">Next</button></div>`}
    </section>`;
  } else {
    const showContext = e.context && (e.type !== "open");
    body = `
      ${s.taught.includes(item.id) || !e.phase || e.phase !== "recall" ? "" : `<p class="practice-purpose">Start with what you remember. Hints are here if you need them.</p>`}
      ${showContext ? `<div class="question-context"><span class="eyebrow">${e.type === "cloze" ? "From your screenshot" : "In your screenshot"}</span><p lang="${item.language}">${e.type === "cloze" ? blankify(e.context) : markForm(e.context, item.form)}</p></div>` : ""}
      <h2 class="prompt">${esc(e.prompt)}</h2>
      ${e.type === "open" && !st.attempts.length && !done ? `<label class="task-choice">Pick another writing task<select data-act="style"><option value="">Current task</option>${Object.entries(P.STYLES).map(([k, v]) => `<option value="${k}" ${e.style === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : ""}
      <form id="answerForm" autocomplete="off">
        ${answerInputHTML(e, st, done)}
        ${!done ? `<div class="question-actions"><button class="primary" ${busy ? "disabled" : ""}>${st.stage === "revise" ? "Check again" : "Check"}</button>${st.help ? `<small>Practice with help · kept apart from recall without help</small>` : ""}</div>` : ""}
      </form>
      ${working(busy)}
      ${!done ? coachingHTML(e, st) : feedbackHTML(e, st, item)}`;
  }
  return `<div class="view-heading"><h1 tabindex="-1">${esc(s.title)}</h1><span class="muted">${s.index + 1} of ${s.queue.length}</span></div>
  <div class="practice-card">
    <div class="session-bar" aria-hidden="true"><i style="width:${pct}%"></i></div>
    <div class="question-top"><span>${PHASE_LABEL[e.type] || ""}</span><span class="row-actions tight">${shot ? `<button class="text-button" data-act="qsource">View source</button>` : ""}<button class="text-button" data-act="exit">Save & exit</button></span></div>
    ${body}
  </div>`;
}
function answerInputHTML(e, st, done) {
  const last = st.attempts.at(-1)?.answer || "";
  const dis = done || busy ? "disabled" : "";
  if (e.type === "meaning") return `<fieldset class="choices" ${dis}><legend class="sr-only">Choose an answer</legend>${e.choices.map((c) => `<label class="${last === c ? "chosen" : ""}${done && loose(c) === loose(e.answer) ? " right" : ""}"><input type="radio" name="ans" value="${esc(c)}" ${last === c ? "checked" : ""}><span>${esc(c)}</span></label>`).join("")}</fieldset>`;
  if (e.type === "reorder") return `<div class="reorder"><div class="assembled" id="assembled" aria-live="polite">${esc(last) || '<span class="muted">Tap the words in order.</span>'}</div>
    <input type="hidden" name="ans" value="${esc(last)}"><div class="tokens">${e.choices.map((w, n) => `<button type="button" data-tok="${n}" ${dis}>${esc(w)}</button>`).join("")}<button type="button" class="icon-button" data-tok="reset" aria-label="Start again" ${dis}>↺</button></div></div>`;
  if (e.type === "open") return `<label class="answer-field">Your answer<textarea name="ans" rows="3" maxlength="1500" ${dis} placeholder="Write in ${esc(lang(state.profile.target))}" lang="${state.profile.target}">${esc(last)}</textarea></label>`;
  return `<label class="answer-field">Your answer<input name="ans" value="${esc(last)}" maxlength="200" ${dis} placeholder="Word or phrase" lang="${state.profile.target}" autocapitalize="off" spellcheck="false"></label>`;
}
function coachingHTML(e, st) {
  if (st.stage === "attempt") return `<div class="row-actions helpers"><button class="text-button" data-act="hint">Give me a hint</button><button class="text-button" data-act="reveal">Show the answer</button><button class="text-button" data-act="skip">Skip for now</button></div>`;
  const fb = st.last || {};
  return `<section class="coaching-panel incorrect" aria-live="polite">
    <h3>${fb.method === "ai" ? "The AI suggests a revision" : "Not quite — try again"}</h3>
    <p class="muted">You wrote: “${esc(st.attempts.at(-1)?.answer)}”. Your first try is saved. Use the hint and edit your answer.</p>
    ${fb.method === "ai" && fb.explanation ? `<p>${esc(fb.explanation)}</p>` : ""}
    ${st.hints.map((h, n) => `<p><strong>Hint ${n + 1}:</strong> ${esc(h)}</p>`).join("")}
    <div class="row-actions">${st.hints.length < 2 ? `<button data-act="hint">Give me another hint</button>` : ""}<button class="text-button" data-act="reveal">Show the answer and explanation</button><button class="text-button" data-act="skip">Skip</button></div>
  </section>`;
}
function feedbackHTML(e, st, item) {
  const fb = st.feedback || {};
  if (fb.outcome === "skipped") return "";
  const first = st.attempts.length === 1 && !st.help;
  const head = { correct: first ? "Correct!" : "Correct, with help", incorrect: "Let's look at it together", revealed: "Here is the answer", uncertain: "Not checked automatically" }[fb.outcome];
  const basis = fb.method === "objective" ? "Checked against the answer from your lesson." : fb.method === "ai" ? "Checked by AI. It can make mistakes; compare with your source if unsure." : fb.method === "shown" ? "You asked to see the answer, so this counts as practice with help." : "Compare it yourself with the example below.";
  return `<div class="feedback ${fb.outcome}" tabindex="-1" id="feedback" aria-live="polite">
    <strong>${head}</strong>
    <p class="feedback-basis">${basis}</p>
    ${e.type === "open" ? (fb.expected ? `<p><span class="muted">${fb.method === "ai" ? "A natural version of your answer: " : "One possible answer: "}</span><span lang="${item.language}">${esc(fb.expected)}</span></p>` : "") : `<p><span class="muted">Answer: </span><strong lang="${item.language}">${esc(fb.expected)}</strong></p>`}
    ${fb.explanation && (e.type !== "open" || fb.method !== "ai") ? `<p>${esc(fb.explanation)}</p>` : fb.method === "ai" && fb.explanation ? `<p>${esc(fb.explanation)}</p>` : ""}
    ${fb.schedule ? `<p class="schedule-note">${esc(fb.schedule)}</p>` : ""}
    <details class="learning-memory" ${fb.outcome !== "correct" ? "open" : ""}><summary>Meaning, use & source</summary>${teachHTML(item)}</details>
    ${["uncertain", "revealed", "incorrect"].includes(fb.outcome) && !st.decision ? `<div class="self-review"><p>How do you feel about it? (optional)</p><div class="row-actions"><button data-act="decide" data-d="practise">I need more practice</button><button data-act="decide" data-d="confident">I get it now</button></div></div>` : st.decision ? `<p class="muted">Saved: ${st.decision === "confident" ? "you get it now" : "more practice"}.</p>` : ""}
    <button class="primary" data-act="next">Next</button>
  </div>`;
}
function recapHTML(s) {
  const sum = P.summary(s);
  return `<div class="view-heading"><h1 tabindex="-1">Practice</h1></div>
  <div class="practice-card recap">
    <span class="eyebrow">Session complete · ${esc(s.title)}</span><h2>Your recap</h2>
    <p class="muted">${sum.answered} task${sum.answered === 1 ? "" : "s"} done. Answers with help are kept apart from recall without help.</p>
    ${s.mode !== "flashcards" ? `<div class="recap-counts"><div><strong>${sum.independent}</strong><span>recalled without help</span></div><div><strong>${sum.again}</strong><span>to practise again</span></div><div><strong>${sum.items.length}</strong><span>words in this session</span></div></div>` : `<p class="recap-key">Card ratings are your own. Try Recall another day to check without help.</p>`}
    <div class="row-actions">${sum.again ? `<button class="primary" data-act="again" data-ids="${sum.items.filter((x) => x.mistakes.length || x.unsure || x.card === "practise").map((x) => x.item.id).join(",")}">Practise these again</button>` : ""}<button data-act="closeRecap">Back to practice</button><button class="text-button" data-act="goProgress">See progress</button></div>
    <div class="recap-items">${sum.items.map((x) => {
      const due = x.item.dueAt;
      return `<section class="recap-item"><h3 lang="${x.item.language}">${esc(x.item.form)} <span class="muted small">— ${esc(x.item.sense)}</span></h3>
        ${x.independent ? `<p class="recall-success">Recalled on the first try, without help.</p>` : ""}
        ${x.withHelp ? `<p>Recalled with help. Try again without help at your next review.</p>` : ""}
        ${x.wrote ? `<p class="recall-success">Your own sentence was accepted by the AI check.</p>` : ""}
        ${x.card ? `<p>${x.card === "confident" ? "You said you remembered this card." : "You marked this card for more practice."}</p>` : ""}
        ${x.mistakes.slice(0, 3).map((m) => `<div class="recap-mistake"><strong>Learn from this</strong><span class="muted">You wrote:</span> ${esc(m.answer)}<br><span class="muted">${m.type === "open" ? "A natural version: " : "Answer: "}</span>${esc(m.expected)}</div>`).join("")}
        <details><summary>Meaning, use & source</summary>${teachHTML(x.item)}</details>
        <p class="review-date">${due ? (due <= now() ? "Review due now." : `Next check without help: ${fmtDate(due)}`) : "No review date yet."}</p>
      </section>`;
    }).join("")}</div>
  </div>`;
}

// ---------- PROGRESS ----------
function progressHTML() {
  const items = Object.values(state.items).filter((i) => i.language === state.profile?.target);
  const st = (i) => P.statusOf(i);
  const revisit = P.toRevisit();
  if (!items.length) return `<div class="view-heading"><div><h1 tabindex="-1">Your progress</h1><p class="muted">See what is sticking and what to revisit.</p></div></div>
    <div class="empty-state">${ICON_IMG}<h2>Your words grow here</h2><p>Make a lesson from a screenshot. Your words, results and review dates appear here.</p><button class="primary" data-act="goLibrary">Open library</button></div>`;
  const order = { "needs-practice": 0, due: 1, new: 2, building: 3, remembering: 4 };
  const q = loose(progFilter.q);
  const shown = items.filter((i) => (progFilter.status === "all" || (progFilter.status === "review" ? ["due", "needs-practice"].includes(st(i).key) : st(i).key === progFilter.status)) && (!q || loose(`${i.form} ${i.sense}`).includes(q)))
    .sort((a, b) => order[st(a).key] - order[st(b).key] || a.form.localeCompare(b.form));
  const tasks = items.reduce((n, i) => n + i.stats.tasks, 0);
  return `<section class="progress-page">
    <div class="view-heading"><div><h1 tabindex="-1">Your progress</h1><p class="muted">${esc(lang(state.profile.target))} · see what is sticking and what to revisit.</p></div></div>
    <div class="progress-metrics">
      <div><strong>${items.length}</strong><span>Words & phrases</span></div>
      <div><strong>${tasks}</strong><span>Practice tasks</span></div>
      <div><strong>${items.filter((i) => st(i).key === "remembering").length}</strong><span>Remembering well</span></div>
      <button data-act="progFilter" data-status="${progFilter.status === "review" ? "all" : "review"}" class="${progFilter.status === "review" ? "selected" : ""}"><strong>${revisit.length}</strong><span>To revisit</span></button>
    </div>
    <section class="batch-review"><div><h2>Revisit your words together</h2><p>One session for words that are due or that you missed, from all your screenshots. Recall comes first, without hints, then the tutor teaches.</p></div>
      <div class="batch-start"><button class="primary" data-act="reviewAll" ${revisit.length ? "" : "disabled"}>Practise all to revisit (${revisit.length})</button><span>${revisit.length ? "Save & exit any time." : "Nothing is due right now."}</span></div></section>
    <details class="progress-key"><summary>What do these mean?</summary><p>A review date moves forward only when you recall a word without help (no hints, no answer shown, first try). Then the gap grows: 3, 7, 14, 30, 60 days. A mistake brings it back the next day. “Remembering well” means at least two such reviews in a row. It is not a claim of permanent mastery.</p></details>
    <div class="progress-filters">
      <label>Find a word<input type="search" data-pfilter="q" value="${esc(progFilter.q)}" placeholder="Search words or meanings"></label>
      <label>Show<select data-pfilter="status"><option value="all">All words</option><option value="review" ${progFilter.status === "review" ? "selected" : ""}>To revisit</option>${Object.entries(P.STATUS).map(([k, v]) => `<option value="${k}" ${progFilter.status === k ? "selected" : ""}>${v}</option>`).join("")}</select></label>
    </div>
    <p class="progress-result-count" role="status">${shown.length} word${shown.length === 1 ? "" : "s"}</p>
    <div class="progress-words">${shown.map((i) => {
      const s = st(i);
      return `<article class="progress-word">
        <div class="progress-word-heading"><div><h2 lang="${i.language}">${esc(i.form)}</h2><p>${esc(i.sense)}</p></div><span class="progress-status ${s.key}">${P.STATUS[s.key]}</span></div>
        <p class="progress-reason">${esc(s.reason)}</p>
        <dl class="word-statistics"><div><dt>Practice tasks</dt><dd>${i.stats.tasks}</dd></div><div><dt>Recall without help</dt><dd>${i.stats.indep[1] ? `${i.stats.indep[0]} / ${i.stats.indep[1]} correct` : "Not checked yet"}</dd></div><div><dt>AI writing checks</dt><dd>${i.stats.writing[1] ? `${i.stats.writing[0]} / ${i.stats.writing[1]} accepted` : "Not yet"}</dd></div></dl>
        <div class="progress-review-row"><p><strong>${i.studied ? (i.dueAt <= now() ? "Review due" : "Next check without help") : "First practice"}</strong><span>${i.studied ? fmtDate(i.dueAt) : "Whenever you are ready"}</span></p>
          <span class="row-actions tight"><button class="text-button" data-act="source" data-id="${i.shotId}">View source</button><button class="${["due", "needs-practice"].includes(s.key) ? "primary" : ""}" data-act="practiseWord" data-id="${i.id}">Practise</button></span></div>
      </article>`;
    }).join("")}</div>
  </section>`;
}

// ---------- dialogs ----------
const openDialog = (id) => { const d = $(id); if (!d.open) d.showModal(); return d; };
$$("dialog").forEach((d) => d.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) { if (d.id === "settingsDialog" && !state.profile) return; d.close(); } }));
$("#settingsDialog").addEventListener("cancel", (e) => { if (!state.profile) e.preventDefault(); });

function openSettings() {
  const p = state.profile || { target: "en", level: "B1", explain: "en", goal: "" };
  $("#sTarget").innerHTML = TARGETS.map((c) => `<option value="${c}" ${c === p.target ? "selected" : ""}>${LANGS[c]}</option>`).join("");
  $("#sLevel").innerHTML = Object.entries(LEVELS).map(([k, v]) => `<option value="${k}" ${k === p.level ? "selected" : ""}>${k} · ${v}</option>`).join("");
  $("#sExplain").innerHTML = Object.entries(LANGS).map(([c, n]) => `<option value="${c}" ${c === p.explain ? "selected" : ""}>${n}</option>`).join("");
  $("#sGoal").value = p.goal || "";
  $("#settingsLead").textContent = state.profile ? "The agent uses these to decide which screenshots matter, what to teach you, and how to explain it." : "Welcome! Tell the agent what you are learning. It uses this to sort your screenshots and to teach at your level.";
  $("#dataTools").hidden = !state.profile;
  $("#clockNote").textContent = state.clockOffset ? `Demo clock is ${Math.round(state.clockOffset / DAY)} days ahead.` : "";
  const note = $("#sNote");
  note.hidden = aiState === "ready" || aiState === "unknown";
  note.textContent = aiNote();
  openDialog("#settingsDialog");
}
$("#settingsForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const before = state.profile;
  const p = { target: $("#sTarget").value, level: $("#sLevel").value, explain: $("#sExplain").value, goal: $("#sGoal").value.trim() || "everyday conversation" };
  state.profile = p;
  if (before && before.target !== p.target) {
    // New study language: sort everything again, except what the learner decided by hand.
    for (const s of state.shots) if (!s.manualAside && !s.manualKeep && s.status !== "ready") { s.status = "queued"; s.triage = null; }
    for (const s of state.shots) if (s.status === "ready" && !s.lesson.items.some((id) => state.items[id]?.language === p.target)) { s.status = "queued"; s.triage = null; }
    state.today = null;
  }
  save(); $("#settingsDialog").close(); render();
  runAgent();
});
$("#exportBtn").onclick = async () => {
  const imgs = {};
  for (const s of state.shots) imgs[s.id] = { full: await images.get("full", s.id), thumb: await images.get("thumb", s.id) };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify({ state, images: imgs })], { type: "application/json" }));
  a.download = `snapstudy-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click();
};
$("#importInput").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    await images.clear();
    for (const [id, v] of Object.entries(data.images || {})) { if (v.full) await images.put("full", id, v.full); if (v.thumb) await images.put("thumb", id, v.thumb); }
    replaceState(data.state || data);
    $("#settingsDialog").close(); render();
  } catch { banner("That file is not a SnapStudy backup."); }
};
$("#jumpBtn").onclick = () => { state.clockOffset = (state.clockOffset || 0) + 3 * DAY; state.today = null; save(); $("#clockNote").textContent = `Demo clock is ${Math.round(state.clockOffset / DAY)} days ahead.`; render(); };
$("#resetBtn").onclick = async () => {
  if (!confirm("Delete all screenshots, lessons and progress in this browser?")) return;
  await images.clear(); replaceState({ ...blank(), profile: state.profile }); $("#settingsDialog").close(); go("library");
};

function openModes(shot) {
  shot.lastOpened = now(); save();
  const items = shot.lesson.items.map((id) => state.items[id]).filter(Boolean);
  $("#modeBody").innerHTML = `
    <p class="activity-scope">${esc(shot.title)} · <strong lang="${state.profile.target}">${esc(items.map((i) => i.form).join(" · "))}</strong></p>
    <div class="activity-grid">${Object.entries(P.MODES).map(([k, m]) => `<button data-mode="${k}"><span class="activity-name">${m.label}${k === "mixed" ? " <small>recommended</small>" : ""}</span><span class="activity-description">${m.description}</span><span class="activity-count">${k === "flashcards" ? `${items.length} card${items.length > 1 ? "s" : ""}` : `${items.length} word${items.length > 1 ? "s" : ""}`}</span></button>`).join("")}</div>
    <button class="text-button" data-regions>Choose different text from this screenshot</button>`;
  const d = openDialog("#modeDialog");
  $$("[data-mode]", d).forEach((b) => (b.onclick = () => { d.close(); begin({ mode: b.dataset.mode, itemIds: shot.lesson.items, title: shot.title, shotId: shot.id }); }));
  $("[data-regions]", d).onclick = () => { d.close(); openRegions(shot); };
}
function begin(opts) { P.startSession(opts); showRecap = false; go("practice"); }

async function openRegions(shot) {
  const full = await images.get("full", shot.id);
  if (!full) return banner("The original image is not in this browser any more.");
  const start = shot.focus?.regions || [];
  $("#regionBody").innerHTML = `
    <p class="muted">Drag a box over the part you want to learn from. Draw several if you like. Mark the most important one with “Focus on this area”. The agent then builds a new lesson from only these parts.</p>
    <div class="review-grid">
      <div class="source-image" id="rgImage"></div>
      <div><div class="row-actions tight"><button type="button" id="rgAuto">Find text boxes automatically</button><button type="button" class="text-button" id="rgClear">Clear all areas</button></div>
        <p class="muted small" id="rgStatus" role="status"></p>
        <div class="region-list" id="rgList"></div></div>
    </div>
    <label class="forms-field">Words or phrases you want to learn <span class="muted">(optional, up to 4, one per line)</span><textarea id="rgForms" rows="3" maxlength="400" placeholder="Leave empty and the agent will choose">${esc((shot.focus?.forms || []).join("\n"))}</textarea></label>
    <div class="dialog-actions"><button type="button" data-close>Cancel</button><button type="button" class="primary" id="rgGo">Make a new lesson</button></div>`;
  const d = openDialog("#regionDialog");
  const list = $("#rgList", d);
  const sync = (regions) => {
    list.innerHTML = regionListHTML(regions);
    $$(".region-editor", list).forEach((el) => {
      $("[data-text]", el).oninput = (e) => editor.update(el.dataset.id, { text: e.target.value });
      $("[data-focus]", el).onchange = (e) => editor.update(el.dataset.id, { focus: e.target.checked });
      $("[data-remove]", el).onclick = () => editor.remove(el.dataset.id);
    });
  };
  const editor = regionEditor($("#rgImage", d), full, start, sync);
  sync(start);
  $("#rgClear", d).onclick = () => { editor.set([]); $("#rgStatus", d).textContent = ""; };
  const auto = async () => {
    const msg = $("#rgStatus", d), btn = $("#rgAuto", d); btn.disabled = true;
    try {
      const found = await findTextBoxes(full, (t) => (msg.textContent = t));
      if (!found.length) { msg.textContent = "No text boxes found. Drag a box over the text yourself; its text will appear here."; return; }
      // Boxes come from the text reader; the AI then re-reads each box more accurately (if connected).
      const ai = aiState === "ready";
      editor.set([...editor.get(), ...found.map((r) => ({ ...r, reading: ai }))]);
      msg.textContent = `Found ${found.length} text area${found.length > 1 ? "s" : ""}. Remove the ones you don't need (✕).`;
      if (ai) {
        const texts = await readAreas(full, found);
        found.forEach((r, i) => editor.update(r.id, { reading: false, ...(texts[i].text ? { text: texts[i].text, how: texts[i].how } : {}) }));
        sync(editor.get());
      }
    } catch { msg.textContent = "The automatic text reader could not load. Drag boxes yourself; their text will appear here."; }
    finally { btn.disabled = false; }
  };
  $("#rgAuto", d).onclick = auto;
  if (!start.length) auto(); // like Recollect: show the text boxes right away
  $("#rgGo", d).onclick = async () => {
    const forms = $("#rgForms", d).value.split("\n").map((x) => x.trim()).filter(Boolean);
    if (forms.length > 4) { $("#rgStatus", d).textContent = "Choose up to four words or phrases."; return; }
    const regions = editor.get();
    if (regions.some((r) => r.reading)) { $("#rgStatus", d).textContent = "Still reading the text in your areas. One moment…"; return; }
    d.close();
    shot.status = "reading"; render();
    await withBusy("Building a new lesson from the parts you chose…", async () => {
      try { await buildLesson(shot, { regions, forms }); }
      catch (e) { shot.status = "failed"; shot.error = e.message; throw e; }
      finally { save(); }
    });
    if (shot.status === "ready") openModes(shot);
  };
}

async function openSource(shotId, item) {
  const shot = shotById(shotId); if (!shot) return;
  shot.lastOpened = now(); save();
  const regions = shot.focus?.regions || [];
  const items = (shot.lesson?.items || []).map((id) => state.items[id]).filter(Boolean);
  $("#sourceTitle").textContent = shot.title || shot.name;
  $("#sourceBody").innerHTML = `
    <div class="metadata">Saved ${fmtDate(shot.takenAt)} · ${ago(shot.takenAt)}${shot.source ? `<span>${esc(shot.source)}</span>` : ""}</div>
    ${shot.why ? `<p class="why"><span class="muted">Why you probably saved it:</span> ${esc(shot.why)}</p>` : ""}
    ${shot.status === "aside" ? `<p class="muted">Set aside: ${esc(shot.triage?.reason || "")}</p>` : ""}
    ${item ? `<div class="source-text"><span class="eyebrow">Text used for this question</span><p lang="${item.language}">${markForm(item.quote, item.form)}</p></div>` : ""}
    <div class="source-image"><div class="image-regions"><img alt="Original screenshot" data-full="${shot.id}">${regions.map((r, n) => `<span class="source-highlight" style="left:${r.bbox.x * 100}%;top:${r.bbox.y * 100}%;width:${r.bbox.w * 100}%;height:${r.bbox.h * 100}%"><b>${n + 1}</b></span>`).join("")}</div></div>
    ${!item && items.length ? items.map((i) => teachHTML(i, "From this screenshot")).join("") : ""}
    ${shot.text?.length && !item ? `<details class="source-text"><summary>All text the agent read</summary><p lang="${state.profile?.target}">${esc(shot.text.join("\n"))}</p></details>` : ""}`;
  hydrate($("#sourceBody"));
  openDialog("#sourceDialog");
}

// ---------- events ----------
$$("[data-view]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); go(b.dataset.view); }));
$("#settingsBtn").onclick = openSettings;
$("#profileChip").onclick = openSettings;
$("#files").onchange = (e) => { const f = [...e.target.files].filter((x) => x.type.startsWith("image/")).map((file) => ({ file, name: file.name })); e.target.value = ""; take(f); };
$("#folder").onchange = (e) => { const f = [...e.target.files].filter((x) => x.type.startsWith("image/")).map((file) => ({ file, name: file.name })); e.target.value = ""; take(f); };
async function take(list) {
  if (!state.profile) return openSettings();
  if (!list.length) return banner("No images found.");
  libTab = "working"; view = "library";
  const r = await addFiles(list);
  if (list.length > MAX_SHOTS) banner(`Took the first ${MAX_SHOTS} of ${list.length} screenshots.`);
  else if (r.skipped) banner(`${r.skipped} file${r.skipped > 1 ? "s" : ""} could not be opened.`);
  render();
}

$("#view").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-act], [data-tok]");
  if (!t) return;
  if (t.dataset.tok != null) return tokenClick(t);
  const id = t.dataset.id, act = t.dataset.act;
  const s = state.activeSession && state.sessions[state.activeSession];
  switch (act) {
    case "pick": return state.profile ? $("#files").click() : openSettings();
    case "folder": return state.profile ? $("#folder").click() : openSettings();
    case "samples": if (!state.profile) return openSettings(); libTab = "working"; await loadSamples(); return render();
    case "tab": libTab = t.dataset.tab; return render();
    case "clearFilters": filters = { q: "", topic: "", due: false }; return render();
    case "source": return openSource(id);
    case "regions": return openRegions(shotById(id));
    case "practise": return openModes(shotById(id));
    case "studyAnyway": studyAnyway(shotById(id)); libTab = "working"; return render();
    case "setAside": setAside(shotById(id)); return render();
    case "retry": retry(shotById(id)); return render();
    case "retryAll": state.shots.filter((x) => x.status === "failed").forEach((x) => { x.status = x.triage ? "kept" : "queued"; x.error = null; }); save(); runAgent(); return render();
    case "goLibrary": return go("library");
    case "goProgress": return go("progress");
    case "recap": showRecap = true; return render();
    case "closeRecap": showRecap = false; return render();
    case "reviewAll": { const ids = P.toRevisit().map((i) => i.id).slice(0, 12); if (ids.length) begin({ mode: "mixed", itemIds: ids, title: "Review", review: true }); return; }
    case "practiseWord": { const i = state.items[id]; return begin({ mode: "mixed", itemIds: [id], title: i.form, shotId: i.shotId, review: i.studied }); }
    case "again": return begin({ mode: "mixed", itemIds: t.dataset.ids.split(","), title: "Practise again", review: true });
    case "task": return runTask(t.dataset.type, t.dataset.ref);
    case "progFilter": progFilter.status = t.dataset.status; return render();
    // session
    case "exit": state.activeSession = null; save(); return render();
    case "qsource": { const e2 = P.current(s); const it = state.items[e2.item]; return openSource(it.shotId, it); }
    case "learned": P.learnDone(s); return renderFocus();
    case "hint": P.hint(s); return render();
    case "reveal": P.reveal(s); return renderFocus("#feedback");
    case "skip": P.skip(s); return renderFocus();
    case "decide": P.decide(s, t.dataset.d); return render();
    case "next": P.next(s); if (s.done) showRecap = true; return renderFocus();
  }
});
$("#view").addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.filter) { filters[t.dataset.filter] = t.type === "checkbox" ? t.checked : t.value; return render(); }
  if (t.dataset.pfilter === "status") { progFilter.status = t.value; return render(); }
  if (t.dataset.act === "style" && t.value) { P.setStyle(state.sessions[state.activeSession], t.value); return render(); }
});
$("#view").addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.filter === "q" || t.dataset.pfilter === "q") {
    if (t.dataset.filter) filters.q = t.value; else progFilter.q = t.value;
    render();
  }
});
$("#view").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = state.sessions[state.activeSession]; if (!s || busy) return;
  const ans = new FormData(e.target).get("ans");
  if (!ans || !String(ans).trim()) return;
  const isOpen = P.current(s).type === "open";
  if (isOpen) { busy = "The AI tutor is reading your answer…"; render(); }
  try { await P.check(s, ans); } catch (err) { banner(err.message); }
  busy = ""; renderFocus(P.step(s, P.current(s)).stage === "done" ? "#feedback" : ".coaching-panel");
});
function tokenClick(b) {
  const form = $("#answerForm"), input = $("input[name=ans]", form), out = $("#assembled");
  if (b.dataset.tok === "reset") { input.value = ""; out.innerHTML = '<span class="muted">Tap the words in order.</span>'; $$("[data-tok]", form).forEach((x) => (x.disabled = false)); return; }
  input.value = `${input.value} ${b.textContent}`.trim(); out.textContent = input.value; b.disabled = true;
}
function renderFocus(sel) {
  render();
  const el = (sel && $(sel)) || $("#answerForm input:not([type=hidden]), #answerForm textarea") || $("h1");
  el?.focus?.({ preventScroll: !!sel && sel !== "#feedback" });
  if (!sel) window.scrollTo(0, 0);
}
function runTask(type, ref) {
  if (type === "review") { const ids = P.toRevisit().map((i) => i.id).slice(0, 12); if (ids.length) return begin({ mode: "mixed", itemIds: ids, title: "Today's review", review: true }); }
  if (type === "weak" && state.items[ref]) return begin({ mode: "mixed", itemIds: [ref], title: state.items[ref].form, review: true });
  const shot = shotById(ref);
  if (type === "revisit" && shot) return openSource(shot.id);
  if (shot?.lesson) return openModes(shot);
  const anyNew = state.shots.find((x) => x.status === "ready" && x.lesson.items.some((id) => !state.items[id]?.studied));
  if (anyNew) return openModes(anyNew);
}

// Drag and drop anywhere on the page, including whole folders.
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { dragDepth++; $("#dragShade").hidden = false; } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dragShade").hidden = true; } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", async (e) => {
  e.preventDefault(); dragDepth = 0; $("#dragShade").hidden = true;
  if (document.querySelector("dialog[open]")) return;
  take(await filesFromDrop(e.dataTransfer));
});

// ---------- start ----------
function aiNote() {
  return aiState === "nokey" ? "The AI is not connected yet: the server has no OPENAI_API_KEY. Add it in Netlify (Site configuration → Environment variables) or in the .env file, then restart."
    : aiState === "offline" ? "The AI server is not running. Open the app through Netlify, or on your computer run: node local-server.mjs" : "";
}
async function boot() {
  if (location.protocol === "file:") banner("Open SnapStudy through a web server: run “node local-server.mjs” and go to http://localhost:8888");
  render();
  if (!state.profile) openSettings();
  aiState = await aiStatus();
  if (aiState !== "ready") banner(aiNote());
  if (state.shots.some((s) => ["queued", "kept"].includes(s.status))) runAgent();
}
boot();
