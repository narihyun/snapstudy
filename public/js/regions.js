// Choose parts of a screenshot: drag boxes yourself, or let the browser find text boxes (Tesseract OCR, as in Recollect).
// Every area shows the text inside it. Text is read by the AI when it is connected, otherwise by Tesseract.
// The chosen parts are cut out and sent to the agent, which builds the lesson from them only.
import { esc, uid, state } from "./store.js";
import { ai } from "./agent.js";

const OCR_CODES = { en: "eng", es: "spa", fr: "fra", de: "deu", it: "ita", ja: "jpn", ko: "kor", zh: "chi_sim", ru: "rus", pt: "por" };

export function regionEditor(root, imageUrl, start = [], onChange = () => {}) {
  let regions = start.map((r) => ({ ...r }));
  root.innerHTML = `<div class="image-regions draw" id="rgCanvas"><img alt="Your screenshot" src="${imageUrl}" draggable="false"></div>`;
  const canvas = root.querySelector("#rgCanvas");
  let drag = null;

  const draw = () => {
    canvas.querySelectorAll(".region-box").forEach((b) => b.remove());
    regions.forEach((r, n) => {
      const b = document.createElement("div");
      b.className = `region-box selected${r.focus ? " focus" : ""}`;
      Object.assign(b.style, { left: `${r.bbox.x * 100}%`, top: `${r.bbox.y * 100}%`, width: `${r.bbox.w * 100}%`, height: `${r.bbox.h * 100}%` });
      b.innerHTML = `<span>${n + 1}</span><button type="button" aria-label="Remove area ${n + 1}">✕</button>`;
      b.querySelector("button").onclick = (e) => { e.stopPropagation(); regions = regions.filter((x) => x !== r); draw(); onChange(regions); };
      b.onpointerdown = (e) => e.stopPropagation();
      b.onclick = () => { const el = document.querySelector(`.region-editor[data-id="${r.id}"]`); el?.scrollIntoView({ block: "nearest", behavior: "smooth" }); el?.querySelector("textarea")?.focus(); };
      canvas.appendChild(b);
    });
  };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };
  canvas.onpointerdown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const ghost = document.createElement("div"); ghost.className = "region-box drawing"; canvas.appendChild(ghost);
    drag = { p: pos(e), ghost };
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const b = box(drag.p, pos(e));
    Object.assign(drag.ghost.style, { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` });
  };
  canvas.onpointerup = (e) => {
    if (!drag) return;
    const b = box(drag.p, pos(e)); drag.ghost.remove(); drag = null;
    if (b.w > 0.02 && b.h > 0.012) {
      const r = { id: uid("r"), bbox: b, text: "", focus: false, reading: true, by: "you" };
      regions.push(r); draw(); onChange(regions);
      readAreas(imageUrl, [r]).then(([t]) => { api.update(r.id, { text: t.text, how: t.how, reading: false }); onChange(regions); });
    }
  };
  draw();
  const api = {
    get: () => regions,
    set: (r) => { regions = r; draw(); onChange(regions); },
    remove: (id) => { regions = regions.filter((r) => r.id !== id); draw(); onChange(regions); },
    update: (id, change) => { regions = regions.map((r) => (r.id === id ? { ...r, ...change } : r)); draw(); },
  };
  return api;
}
const box = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });

// ---------- reading the text inside areas ----------
// 1) the AI (best for Japanese, Chinese, Korean and dark screens), 2) Tesseract in the browser if the AI is not available.
export async function readAreas(imageUrl, regions) {
  const crops = await cropRegions(imageUrl, regions, regions.length);
  const out = regions.map(() => ({ text: "", how: "" }));
  for (let i = 0; i < crops.length; i += 6) {
    try {
      const r = await ai("read", { profile: state.profile, crops: crops.slice(i, i + 6) });
      (r.texts || []).forEach((t, k) => { if (out[i + k] && String(t || "").trim()) out[i + k] = { text: String(t).trim(), how: "ai" }; });
    } catch { /* fall back to Tesseract below */ }
  }
  for (let i = 0; i < regions.length; i++) {
    if (out[i].text) continue;
    try { out[i] = { text: await ocrText(crops[i]), how: "ocr" }; } catch { out[i] = { text: "", how: "none" }; }
    if (!out[i].text) out[i].how = "none";
  }
  return out;
}

// Tesseract.js (version 6, same as Recollect) loads from a CDN the first time it is needed.
let tesseract;
function loadTesseract() {
  return (tesseract ||= new Promise((ok, no) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@6/dist/tesseract.min.js";
    s.onload = () => (window.Tesseract ? ok(window.Tesseract) : no(new Error("OCR did not load")));
    s.onerror = () => { tesseract = null; no(new Error("OCR could not load")); };
    document.head.appendChild(s);
  }));
}
// One reader per language set, kept for the whole visit.
let workerP = null, workerLangs = "", report = () => {};
async function getWorker(status) {
  if (status) report = status;
  const p = state.profile || {};
  const langs = [...new Set([p.target, p.explain, "en"].map((c) => OCR_CODES[c]).filter(Boolean))].join("+");
  if (workerP && workerLangs === langs) return workerP;
  const T = await loadTesseract();
  workerLangs = langs;
  workerP = T.createWorker(langs, 1, {
    logger: (m) => report(m.status === "recognizing text" ? `Finding text… ${Math.round(m.progress * 100)}%` : "Loading the text reader (the first time takes a little while)…"),
  }).catch((e) => { workerP = null; throw e; });
  return workerP;
}

// Make text easier to read: grey, bigger, and dark screens turned light.
async function prepare(src, minWidth = 1600) {
  const img = await loadImage(src);
  const k = Math.min(3, Math.max(1, minWidth / img.width));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, c.width, c.height);
  const d = g.getImageData(0, 0, c.width, c.height), px = d.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const dark = sum / (px.length / 4) < 110;
  for (let i = 0; i < px.length; i += 4) {
    let y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (dark) y = 255 - y;
    px[i] = px[i + 1] = px[i + 2] = y;
  }
  g.putImageData(d, 0, 0);
  return { canvas: c, scale: k, w: img.width, h: img.height };
}
const useful = (t) => /[\p{L}\p{N}]{2,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t);
const tidy = (t) => String(t || "").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim()
  // Tesseract puts spaces between Japanese and Chinese characters.
  .replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]) (?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, "");

export async function findTextBoxes(imageUrl, status = () => {}) {
  const worker = await getWorker(status);
  const { canvas, scale, w, h } = await prepare(imageUrl);
  let found = [];
  // Try the normal page layout first, then "scattered text" (good for app screens and cards).
  for (const psm of ["3", "11"]) {
    if (psm === "11") status("Trying another layout…");
    await worker.setParameters({ tessedit_pageseg_mode: psm });
    const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
    const paras = (data.blocks || []).flatMap((b) => b.paragraphs || []);
    const cand = paras
      .map((p) => ({ text: tidy(p.text), conf: p.confidence, b: p.bbox }))
      .filter((p) => p.text && useful(p.text) && p.conf > 40 && !(p.text.replace(/[^\p{L}]/gu, "").length <= 3 && p.conf < 75) && !/^(\d{1,2}:\d{2}|home|menu|search|share|like|follow|back|next|close|settings)$/i.test(p.text));
    // Keep boxes from the first pass; add boxes from the second pass that cover new places.
    for (const c of cand) if (!found.some((f) => overlap(f.b, c.b) > 0.4)) found.push(c);
  }
  found.sort((a, b) => a.b.y0 - b.b.y0 || a.b.x0 - b.b.x0);
  return found.slice(0, 40).map((p) => ({
    id: uid("r"), text: p.text, focus: false, by: "auto", how: "ocr", ocr: Math.round(p.conf),
    bbox: { x: p.b.x0 / scale / w, y: p.b.y0 / scale / h, w: (p.b.x1 - p.b.x0) / scale / w, h: (p.b.y1 - p.b.y0) / scale / h },
  }));
}
// Share of the smaller box that the two boxes have in common.
function overlap(a, b) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
}
async function ocrText(crop) {
  const worker = await getWorker();
  const { canvas } = await prepare(crop, 1000);
  await worker.setParameters({ tessedit_pageseg_mode: "6" });
  const { data } = await worker.recognize(canvas);
  return tidy(data.text);
}

// Cut the chosen areas out of the full image (a little margin around each).
const loadImage = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
export async function cropRegions(imageUrl, regions, limit = 5) {
  const img = await loadImage(imageUrl);
  return regions.slice(0, limit).map((r) => {
    const m = 0.008;
    const x = Math.max(0, r.bbox.x - m) * img.width, y = Math.max(0, r.bbox.y - m) * img.height;
    const w = Math.min(img.width - x, (r.bbox.w + 2 * m) * img.width), h = Math.min(img.height - y, (r.bbox.h + 2 * m) * img.height);
    const k = Math.min(2, 1400 / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = "high";
    g.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.9);
  });
}
export const regionListHTML = (regions) => regions.length
  ? regions.map((r, n) => `<section class="region-editor${r.focus ? " is-focus" : ""}" data-id="${r.id}">
      <div class="region-select"><strong>Area ${n + 1}</strong><span>${r.reading ? '<span class="spinner inline"></span> reading the text…' : r.how === "ai" ? "text read by AI" : r.how === "ocr" ? `text read automatically${r.ocr != null ? ` · ${r.ocr}% sure` : ""}` : r.how === "none" ? "could not read · please type it" : r.by === "auto" ? "found automatically" : "drawn by you"}</span></div>
      <label class="correction-label">Text in this area <span class="muted">(fix it if it is wrong)</span><textarea rows="${Math.min(6, Math.max(2, (r.text || "").split("\n").length))}" data-text ${r.reading ? "disabled" : ""} placeholder="${r.reading ? "Reading…" : "Type what this area says."}">${esc(r.text)}</textarea></label>
      <div class="region-row"><label class="interest"><input type="checkbox" data-focus ${r.focus ? "checked" : ""}> Focus on this area</label><button type="button" class="text-button" data-remove>Remove</button></div>
    </section>`).join("")
  : `<p class="muted region-empty">No areas yet. Drag a box over the part of the screenshot you want to learn from, or press “Find text boxes automatically”. You can have several areas.</p>`;
