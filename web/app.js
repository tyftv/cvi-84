import { CVI, DISPLAY, MENUS, SLIDERS, texel } from './cvi-engine.js';
import { FACTORY, presetState } from './presets.js';
import { Renderer, LOOK_DEFAULTS } from './gl.js';
import { Automation } from './automation.js';
import { probePlayable, convertToMp4, VIDEO_ACCEPT, looksLikeVideo } from './convert.js';
import { drawDemo } from './demo.js';

const N = 256; // thumbnails only; the live field store size is gridW x gridH
const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ================================================================ state
let gridW = 256, gridH = 256;
let engine = new CVI(gridW, gridH);
const settings = { detail: 0, smooth: 0 };
const DETAIL = [256, 360, 480]; // short side of the field store: original CVI, fine, extra fine
let looks = clone(LOOK_DEFAULTS);
let auto = new Automation();
let fieldRate = 50;
let playing = false, recArm = false, loop = false;
let startSnap = null;
let current = { kind: 'factory', n: 59 }, presetTouched = false;
let uiDirty = true;
const src = { v1: null, v2: null };
const undoStack = [];

const screenEl = $('screen'), outCanvas = $('out'), overlay = $('overlay'), octx = overlay.getContext('2d');
let renderer;
try { renderer = new Renderer(outCanvas, N); }
catch (e) { document.body.innerHTML = `<p class="err" style="padding:20px">This browser can't run CVI-84 (${esc(e.message)}). Use a current Chrome or Edge.</p>`; throw e; }

const mkSampler = (w = N, h = w) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; return x; };
let samp1 = mkSampler(gridW, gridH), samp2 = mkSampler(gridW, gridH);
// field-store grid follows the source's aspect ratio (square pixels); detail sets the short side
function gridFor(w, h, level) { const s = DETAIL[level] || 256; return w >= h ? [Math.round(s * w / h), s] : [s, Math.round(s * h / w)]; }
function rebuildGrid() {
  const [w, h] = gridFor(...srcDims(), settings.detail);
  if (w === gridW && h === gridH) return false;
  const P0 = { ...engine.P };
  gridW = w; gridH = h;
  engine = new CVI(w, h); engine.P = P0;
  engine.g = { hpan: P0.hpan, vpan: P0.vpan, stretch: P0.stretch, zoom: P0.zoom };
  samp1 = mkSampler(w, h); samp2 = mkSampler(w, h);
  startSnap = null; undoStack.length = 0;
  window.__cvi && (window.__cvi.engine = engine);
  uiDirty = true;
  return true;
}

function makeDemo() { const c = document.createElement('canvas'); c.width = 640; c.height = 480; return c; }
const demo = makeDemo();

// ================================================================ audio (music modes)
async function analyseAudio(file) {
  try {
    const ab = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await file.arrayBuffer());
    const sr = ab.sampleRate, ch = ab.numberOfChannels, len = ab.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) { const d = ab.getChannelData(c); for (let i = 0; i < len; i++) mono[i] += d[i] / ch; }
    const hop = Math.round(sr / 100), n = Math.ceil(len / hop);
    const b = new Float32Array(n), m = new Float32Array(n), t = new Float32Array(n);
    const a1 = 1 - Math.exp(-2 * Math.PI * 150 / sr), a2 = 1 - Math.exp(-2 * Math.PI * 2500 / sr);
    let l1 = 0, l2 = 0;
    for (let k = 0; k < n; k++) {
      let sb = 0, sm = 0, st = 0; const e = Math.min(len, (k + 1) * hop);
      for (let i = k * hop; i < e; i++) { const x = mono[i]; l1 += a1 * (x - l1); l2 += a2 * (x - l2); sb += l1 * l1; sm += (l2 - l1) ** 2; st += (x - l2) ** 2; }
      const c = e - k * hop || 1; b[k] = Math.sqrt(sb / c); m[k] = Math.sqrt(sm / c); t[k] = Math.sqrt(st / c);
    }
    const norm = (arr) => { const s = Array.from(arr).sort((p, q) => p - q); const ref = s[Math.floor(s.length * 0.97)] || 1; for (let i = 0; i < arr.length; i++) arr[i] = Math.min(1, arr[i] / (ref || 1)); };
    norm(b); norm(m); norm(t);
    return { b, m, t };
  } catch { return null; }
}
function audioAt(f) {
  const env = src.v1 && src.v1.env;
  if (!env) { const beat = (f / fieldRate) * 2, ph = beat - Math.floor(beat); return { b: Math.exp(-ph * 6), m: 0.4 + 0.3 * Math.sin(f / fieldRate * 3.1), t: 0.3 + 0.3 * Math.sin(f / fieldRate * 7.3) }; }
  const i = Math.min(env.b.length - 1, Math.floor(f / fieldRate * 100));
  return { b: env.b[i] || 0, m: env.m[i] || 0, t: env.t[i] || 0 };
}

// ================================================================ sources
const v1Source = () => (src.v1 && src.v1.el.readyState >= 2 ? src.v1.el : demo);
const v2Source = () => (src.v2 && src.v2.el.readyState >= 2 ? src.v2.el : null);
function grabInputs() {
  samp1.drawImage(v1Source(), 0, 0, gridW, gridH);
  const out = { v1: samp1.getImageData(0, 0, gridW, gridH).data, v2: null };
  const s2 = v2Source();
  if (s2) { samp2.drawImage(s2, 0, 0, gridW, gridH); out.v2 = samp2.getImageData(0, 0, gridW, gridH).data; }
  return out;
}
// the source's picture size (from metadata, so it's right even mid-seek)
function srcDims() { const e = src.v1 && src.v1.el; return e && e.videoWidth ? [e.videoWidth, e.videoHeight] : [640, 480]; }
function fitPreview() {
  let [w, h] = srcDims();
  if (h > 720) { w = Math.round(w * 720 / h); h = 720; }
  w -= w % 2; h -= h % 2;
  renderer.resize(w, h); overlay.width = w; overlay.height = h;
  aspect = w / h; layoutScreen();
}
// keep the viewer at the video's shape, as large as the stage allows
let aspect = 4 / 3;
function layoutScreen() {
  const st = screenEl.parentElement, cs = getComputedStyle(st);
  const aw = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let ah = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (window.innerWidth <= 860) ah = aw / aspect; // stacked layout: width decides
  let w = aw, hh = w / aspect;
  if (hh > ah) { hh = ah; w = hh * aspect; }
  screenEl.style.width = Math.max(100, Math.floor(w)) + 'px'; screenEl.style.height = Math.max(75, Math.floor(hh)) + 'px';
}
new ResizeObserver(layoutScreen).observe(screenEl.parentElement);
function setBusy(msg, p) {
  const b = $('busy');
  if (msg == null) { b.hidden = true; return; }
  b.hidden = false; $('busyMsg').textContent = msg; $('busyBar').style.width = `${Math.round((p || 0) * 100)}%`;
}
async function importVideo(which, file) {
  if (!file) return;
  if (!looksLikeVideo(file)) { toast(`${file.name} doesn't look like a video file`); return; }
  try {
    setBusy('Checking ' + file.name + '…', 0);
    if (!(await probePlayable(file))) {
      file = await convertToMp4(file, (msg, p) => setBusy(`${msg} ${p ? Math.round(p * 100) + '%' : ''}`, p));
    }
    await loadVideo(which, file);
  } catch (e) { toast(e.message || 'That file could not be opened'); }
  finally { setBusy(null); }
}
async function loadVideo(which, file) {
  const el = document.createElement('video');
  el.src = URL.createObjectURL(file); el.playsInline = true; el.preload = 'auto';
  if (which === 'v2') el.muted = true;
  await new Promise((res, rej) => { el.onloadeddata = res; el.onerror = () => rej(new Error('That file could not be decoded by this browser.')); });
  if (src[which]) { src[which].el.pause(); URL.revokeObjectURL(src[which].el.src); }
  src[which] = { el, file, env: null, name: file.name };
  if (which === 'v1') {
    pause(); el.currentTime = 0;
    el.onended = () => { if (loop) { home(); play(); } else pause(); };
    $('srcName').textContent = file.name;
    $('drop').hidden = true;
    startSnap = null;
    if (!rebuildGrid()) { engine.store.fill(0); engine.stencil.fill(0); engine.cascade.fill(0); }
    engine.field = 0;
    if (!presetTouched) applyFactory(76, false);
    fitPreview();
    analyseAudio(file).then((env) => { if (src.v1 && src.v1.file === file) src.v1.env = env; });
    toast('Loaded ' + file.name);
  } else { el.loop = true; el.play().catch(() => {}); toast('Video 2: ' + file.name); }
  uiDirty = true;
}
for (const id of ['fileV1', 'fileV2']) $(id).accept = VIDEO_ACCEPT;
$('btnImport').onclick = () => $('fileV1').click();
$('btnImportV2').onclick = () => $('fileV2').click();
$('fileV1').onchange = (e) => { importVideo('v1', e.target.files[0]); e.target.value = ''; };
$('fileV2').onchange = (e) => { importVideo('v2', e.target.files[0]); e.target.value = ''; };
screenEl.addEventListener('dragover', (e) => { e.preventDefault(); screenEl.classList.add('dragging'); });
screenEl.addEventListener('dragleave', () => screenEl.classList.remove('dragging'));
screenEl.addEventListener('drop', (e) => { e.preventDefault(); screenEl.classList.remove('dragging'); const f = [...e.dataTransfer.files].find(looksLikeVideo); if (f) importVideo('v1', f); else toast('Drop a video file'); });

// ================================================================ actions (everything flows through here so it can be recorded)
const recording = () => recArm && playing;
function act(a) {
  const prev = a.k === 'set' ? engine.P[a.p] : undefined;
  engine.dispatch(a);
  if (recording()) { if (a.k === 'set') auto.recordValue(a.p, engine.field, a.v, prev); else auto.recordEvent(engine.field, a); }
  uiDirty = true;
}
const setParam = (p, v) => act({ k: 'set', p, v });
const press = (b) => act({ k: 'press', b });
function setLook(look, key, v) {
  const prev = looks[look][key];
  looks[look][key] = v;
  if (recording()) auto.recordValue(`look.${look}.${key}`, engine.field, v, prev);
  uiDirty = true;
}
function applyLane(lane, v, eng = engine, lk = looks) {
  if (lane.startsWith('look.')) { const [, l, k] = lane.split('.'); if (lk[l]) lk[l][k] = v; return; }
  if (eng.P[lane] !== v) eng.dispatch({ k: 'set', p: lane, v });
}
function applyAutomation(f, eng = engine, lk = looks, au = auto) {
  for (const [lane, v] of au.valuesAt(f)) applyLane(lane, v, eng, lk);
  for (const a of au.eventsAt(f)) { eng.dispatch(a); if (eng === engine && a.k === 'preset' && a.ref) current = a.ref; }
}
// undo for painting and fills (while not recording)
function pushUndo() { if (recording()) return; undoStack.push({ store: engine.store.slice(), stencil: engine.stencil.slice() }); if (undoStack.length > 30) undoStack.shift(); }
function undo() { const u = undoStack.pop(); if (!u) { toast('Nothing to undo'); return; } engine.store.set(u.store); engine.stencil.set(u.stencil); toast('Undone'); }

// ================================================================ effects library
const CATS = [
  ['Color', [25, 26, 27, 28, 29, 44, 46, 48, 49, 74]],
  ['Trails', [59, 60, 61, 62, 63, 66, 70, 71, 72, 73, 57, 58]],
  ['Mirror', [31, 32, 33, 64, 65, 67, 68]],
  ['Pixel', [30, 36, 37, 75]],
  ['Freeze', [38, 39, 43, 47, 52]],
  ['Key', [69, 20, 22, 24, 53, 55, 8, 9, 17, 56, 79, 80, 98, 99]],
  ['Shatter', [40, 41, 42, 45, 54]],
  ['Scan & wipe', [34, 35, 51, 3, 13, 14]],
  ['Paint', [0, 1, 2, 4, 5, 6, 7, 10, 11, 12, 15, 16, 18, 19, 21, 23, 50]],
  ['Two videos', [85, 86, 87, 88, 84, 89, 90, 91, 92, 93]],
  ['Music', [81, 82, 83]],
  ['Utility', [76, 77, 78, 94, 95, 97]],
];
let fxCat = 'All', fxQuery = '';
const mine = () => { try { return JSON.parse(localStorage.getItem('cvi84.mine') || '[]'); } catch { return []; } };
const saveMine = (m) => { try { localStorage.setItem('cvi84.mine', JSON.stringify(m)); } catch { toast('This browser blocked saving.'); } };
const thumbs = new Map(); // key -> canvas
function fxEntries() {
  let list;
  if (fxCat === 'Mine') list = mine().map((m, i) => ({ key: 'm' + i, kind: 'mine', i, name: m.name, num: '★' }));
  else {
    const nums = fxCat === 'All' ? CATS.flatMap((c) => c[1]) : (CATS.find((c) => c[0] === fxCat) || [, []])[1];
    list = nums.map((n) => ({ key: 'f' + n, kind: 'factory', n, name: FACTORY[n][0], num: String(n).padStart(2, '0') }));
  }
  const q = fxQuery.trim().toLowerCase();
  return q ? list.filter((e) => e.name.toLowerCase().includes(q) || e.num.includes(q)) : list;
}
function buildChips() {
  const all = ['All', ...CATS.map((c) => c[0]), 'Mine'];
  $('fxChips').innerHTML = all.map((c) => `<button type="button" class="chip${c === fxCat ? ' on' : ''}" data-cat="${c}">${c}</button>`).join('');
  $('mineRow').hidden = fxCat !== 'Mine';
}
function buildFxList() {
  const list = fxEntries();
  const host = $('fxList');
  host.innerHTML = '';
  if (!list.length) { host.innerHTML = `<p class="desc" style="grid-column:1/-1;padding:4px">${fxCat === 'Mine' ? 'Dial in a look, name it above and save it.' : 'No effects match.'}</p>`; return; }
  for (const e of list) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'card'; b.dataset.key = e.key;
    let c = thumbs.get(e.key);
    if (!c) { c = document.createElement('canvas'); c.width = 128; c.height = 96; thumbs.set(e.key, c); queueThumb(e); }
    b.appendChild(c);
    b.insertAdjacentHTML('beforeend', `<span><b>${e.num}</b>${esc(e.name)}</span>`);
    b.onclick = () => (e.kind === 'mine' ? applyMine(e.i) : applyFactory(e.n));
    host.appendChild(b);
  }
  markCurrentCard();
}
function markCurrentCard() {
  const key = current.kind === 'mine' ? 'm' + current.i : 'f' + current.n;
  for (const b of $('fxList').children) if (b.classList) b.classList.toggle('on', b.dataset.key === key);
}
$('fxChips').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; fxCat = b.dataset.cat; buildChips(); buildFxList(); };
$('fxSearch').oninput = (e) => { fxQuery = e.target.value; buildFxList(); };
$('mineSave').onclick = () => {
  const name = $('mineName').value.trim() || `My look ${mine().length + 1}`;
  const m = mine(); m.push({ name, p: { ...engine.P }, looks: clone(looks) }); saveMine(m);
  $('mineName').value = ''; thumbs.delete('m' + (m.length - 1)); buildFxList(); toast('Saved ' + name);
};
function applyFactory(n, touched = true) {
  const st = presetState(n); if (!st) return;
  pushUndo();
  current = { kind: 'factory', n }; if (touched) presetTouched = true;
  act({ k: 'preset', n, ref: current, state: { p: st.p, enter: st.enter } });
  toast(`${String(n).padStart(2, '0')} ${st.name}`);
  markCurrentCard();
}
function applyMine(i) {
  const m = mine()[i]; if (!m) return;
  current = { kind: 'mine', i }; presetTouched = true;
  act({ k: 'preset', ref: current, state: { p: m.p, enter: [] } });
  if (m.looks) for (const k in m.looks) for (const kk in m.looks[k]) setLook(k, kk, m.looks[k][kk]);
  toast(m.name); markCurrentCard();
}
// live thumbnails, rendered in a worker so the editor stays smooth
let thumbWorker = null;
function queueThumb(e) {
  if (!thumbWorker) {
    try {
      thumbWorker = new Worker(new URL('./thumbs-worker.js', import.meta.url), { type: 'module' });
      thumbWorker.onmessage = ({ data }) => {
        const c = thumbs.get(data.key); if (!c) return;
        const tmp = new OffscreenCanvas(N, N); tmp.getContext('2d').putImageData(new ImageData(data.data, N, N), 0, 0);
        const g = c.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(tmp, 0, 0, 128, 96);
      };
    } catch { thumbWorker = false; }
  }
  if (!thumbWorker) return;
  const st = e.kind === 'mine' ? { p: (mine()[e.i] || {}).p || {}, enter: [] } : (({ p, enter }) => ({ p, enter }))(presetState(e.n));
  thumbWorker.postMessage({ key: e.key, state: st });
}

// ================================================================ transport
const duration = () => (src.v1 ? src.v1.el.duration || 0 : 0);
const curTime = () => (src.v1 ? src.v1.el.currentTime : 0);
function syncFieldToTime(t) { engine.field = Math.floor(t * fieldRate + 1e-6); auto.seekEvents(engine.field); for (const [lane, v] of auto.valuesAt(engine.field)) applyLane(lane, v); uiDirty = true; }
function takeStartSnapshot() { engine.field = 0; startSnap = engine.snapshot(true); startSnap.field = 0; startSnap.looks = clone(looks); startSnap.current = { ...current }; }
function exportBase() { if (startSnap && !auto.isEmpty()) return startSnap; const s = engine.snapshot(true); s.looks = clone(looks); return s; }
function play() {
  if (!src.v1) { toast('Import a video to use the timeline'); return; }
  const t = curTime();
  if (t < 1 / fieldRate) takeStartSnapshot();
  syncFieldToTime(t);
  playing = true;
  src.v1.el.play().catch((e) => { playing = false; toast(e.message); });
  if (src.v2) src.v2.el.play().catch(() => {});
  src.v1.el.requestVideoFrameCallback(onVideoFrame);
  uiDirty = true;
}
function pause() { playing = false; auto.releaseAll(); if (src.v1) src.v1.el.pause(); uiDirty = true; }
function seek(t) { if (!src.v1) return; t = Math.max(0, Math.min(duration() || 0, t)); src.v1.el.currentTime = t; syncFieldToTime(t); }
function home() {
  seek(0);
  if (startSnap) {
    const full = !auto.isEmpty();
    engine.restore({ ...startSnap, P: full ? startSnap.P : null });
    if (full) { looks = clone(startSnap.looks); current = { ...startSnap.current }; }
    syncFieldToTime(0);
  }
}
$('btnPlay').onclick = () => (playing ? pause() : play());
$('btnHome').onclick = home;
$('btnLoop').onclick = () => { loop = !loop; uiDirty = true; };
$('btnRec').onclick = () => { recArm = !recArm; if (!recArm) auto.releaseAll(); uiDirty = true; toast(recArm ? 'Recording armed: press play' : 'Recording off'); };
$('btnFreeze').onclick = () => press('freeze');
$('btnClearAuto').onclick = () => { auto.clear(); uiDirty = true; toast('Automation cleared'); };

function advanceTo(t, inputs) {
  const target = Math.floor(t * fieldRate + 1e-6);
  if (target < engine.field - 2) syncFieldToTime(t);
  let steps = 0;
  while (engine.field <= target) {
    if (steps++ > 6) { engine.field = target; auto.seekEvents(target); }
    applyAutomation(engine.field);
    engine.step(inputs, audioAt(engine.field));
  }
}
function onVideoFrame(now, meta) {
  if (!playing) return;
  advanceTo(meta.mediaTime, grabInputs());
  draw(); uiDirty = true;
  src.v1.el.requestVideoFrameCallback(onVideoFrame);
}
let lastTick = performance.now(), freeAcc = 0, demoT = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  if (!playing) {
    if (!src.v1) { demoT += dt; drawDemo(demo, demoT); }
    freeAcc += dt * fieldRate;
    if (freeAcc >= 1) {
      const inputs = grabInputs();
      let n = Math.min(4, Math.floor(freeAcc)); freeAcc -= Math.floor(freeAcc);
      while (n--) engine.step(inputs, audioAt(engine.field));
      if (src.v1) engine.field = Math.floor(curTime() * fieldRate);
    }
    draw();
  }
  if (uiDirty) { uiDirty = false; syncUI(); }
  drawOverlay(); drawTimeline();
  requestAnimationFrame(tick);
}
function draw() {
  const ana = engine.P.anaSrc && v2Source() ? v2Source() : v1Source();
  if (renderer.w === 0) fitPreview();
  renderer.uploadAnalog(ana); renderer.uploadView(engine.view, gridW, gridH);
  renderer.render(looks, engine.field, engine.P.blanking);
}

// ================================================================ tools + pad
const ICON = {
  pointer: '<path d="M5 3l14 8-6 2-2 6z"/>',
  brush: '<path d="M18 3l3 3-9 9-3-3zM9 12c-3 0-5 2-5 5 0 1-1 2-2 2 2 2 7 2 9-1 1-2 1-4-2-6z"/>',
  dots: '<circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="9" r="1.6"/><circle cx="17" cy="14" r="1.6"/><circle cx="9" cy="17" r="1.6"/>',
  line: '<path d="M4 20L20 4"/>',
  rays: '<path d="M4 20L20 4M4 20l16-6M4 20l6-16M4 20l16 2M4 20L2 4"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
  fill: '<path d="M5 11l7-7 7 7-7 7zM19 15s2 3 2 4a2 2 0 01-4 0c0-1 2-4 2-4z"/>',
  cut: '<rect x="4" y="4" width="10" height="10" stroke-dasharray="2 2"/><rect x="10" y="10" width="10" height="10"/>',
  copy: '<path d="M4 4h10v4M4 4v10h4"/><rect x="9" y="9" width="11" height="11" rx="1"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>',
  pick: '<path d="M14 4l6 6-2 2-6-6zM12 8l-7 7v4h4l7-7"/>',
};
const TOOLS = [
  ['pointer', 'Select (V) — no painting', null, 'v'], 'sep',
  ['brush', 'Brush (B)', 0, 'b'], ['dots', 'Dots', 1], ['line', 'Line (L)', 2, 'l'], ['rays', 'Rays', 6],
  ['rect', 'Rectangle (R)', 5, 'r'], ['circle', 'Circle (C)', 3, 'c'], ['ellipse', 'Ellipse', 4], ['fill', 'Fill area (G)', 8, 'g'],
  ['cut', 'Cut & paste: drag a box, then click to paste', 7], ['copy', 'Copy live video into the masked area', 9], 'sep',
  ['text', 'Text (T): click to place', 'text', 't'], ['pick', 'Eyedropper (I): pick a colour from the picture', 'pick', 'i'],
];
function buildTools() {
  const host = $('tools');
  host.innerHTML = TOOLS.map((t) => (t === 'sep' ? '<span class="sep"></span>' : `<button type="button" class="tool" data-tool="${t[0]}" title="${t[1]}" aria-label="${t[1]}"><svg viewBox="0 0 24 24">${ICON[t[0]]}</svg></button>`)).join('')
    + '<span class="sep"></span><span class="desc" style="margin:0 6px 0 0">Paint on</span><div class="target" id="paintTarget"><button type="button" data-t="c">Picture</button><button type="button" data-t="m">Mask</button><button type="button" data-t="b">Both</button></div>'
    + '<button type="button" class="tool" id="btnUndo" title="Undo paint (Ctrl+Z)" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/></svg></button><span class="toolhint" id="toolHint"></span>';
  host.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]'); if (b) { selectTool(b.dataset.tool); return; }
    const t = e.target.closest('[data-t]');
    if (t) { const v = t.dataset.t; setParam('drawColour', v !== 'm' ? 1 : 0); setParam('drawStencil', v !== 'c' ? 1 : 0); if (v !== 'c' && !engine.P.useStencil) toast('Turn on Mask in the inspector to see mask painting'); }
  });
  $('btnUndo').onclick = undo;
}
let prevTool = 'pointer';
function currentTool() {
  if (engine.titleArmed) return 'text';
  if (engine.pickArmed) return 'pick';
  if (!engine.P.drawLock) return 'pointer';
  const t = TOOLS.find((t) => t !== 'sep' && t[2] === engine.P.paintMethod);
  return t ? t[0] : 'brush';
}
function selectTool(id) {
  const t = TOOLS.find((x) => x !== 'sep' && x[0] === id); if (!t) return;
  const cur = currentTool();
  if (cur === 'text' && id !== 'text') engine.titleArmed = false;
  if (cur === 'pick' && id !== 'pick') engine.pickArmed = false;
  if (id === 'pointer') { setParam('drawLock', 0); }
  else if (id === 'text') { if (!engine.titleArmed) press('title'); }
  else if (id === 'pick') { prevTool = cur; press('pick'); }
  else { setParam('paintMethod', t[2]); setParam('drawLock', 1); }
  uiDirty = true;
}
let padDown = false, hover = null, pickKeyArmed = false;
const padPos = (e) => { const r = screenEl.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
screenEl.addEventListener('pointerdown', (e) => {
  const p = padPos(e);
  if (pickKeyArmed) { pickKeyArmed = false; pickKeyAt(p); return; }
  const wasPick = engine.pickArmed;
  if (engine.P.drawLock || engine.titleArmed) pushUndo();
  padDown = true; screenEl.setPointerCapture(e.pointerId);
  act({ k: 'pad', ph: 'down', x: p.x, y: p.y, draw: !!engine.P.drawLock });
  if (wasPick) { toast('Colour picked'); if (prevTool !== 'pick') selectTool(prevTool); }
});
screenEl.addEventListener('pointermove', (e) => { hover = padPos(e); if (padDown) act({ k: 'pad', ph: 'move', x: hover.x, y: hover.y, draw: !!engine.P.drawLock }); });
const padUp = (e) => { if (!padDown) return; padDown = false; const p = padPos(e); act({ k: 'pad', ph: 'up', x: p.x, y: p.y, draw: !!engine.P.drawLock }); };
screenEl.addEventListener('pointerup', padUp); screenEl.addEventListener('pointercancel', padUp);
screenEl.addEventListener('pointerleave', () => { hover = null; });
function pickKeyAt(p) {
  const inp = grabInputs()[engine.P.keySrc ? 'v2' : 'v1'] || grabInputs().v1, i = ((Math.floor(p.y * gridH) * gridW) + Math.floor(p.x * gridW)) * 4;
  const r = inp[i] / 255, g = inp[i + 1] / 255, b = inp[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  setParam('keyHue', Math.round(h)); setParam('keyMode', 0);
  toast(`Key colour set (${Math.round(h)}°)`);
}
function drawOverlay() {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  const o = engine.overlay;
  octx.strokeStyle = '#fff'; octx.lineWidth = Math.max(1, h / 300); octx.setLineDash([6, 4]);
  if (o) {
    const x0 = o.x0 * w, y0 = o.y0 * h, x1 = o.x1 * w, y1 = o.y1 * h;
    octx.beginPath();
    if (o.m === 2) { octx.moveTo(x0, y0); octx.lineTo(x1, y1); }
    else if (o.m === 3) octx.arc(x0, y0, Math.hypot(x1 - x0, y1 - y0), 0, 7);
    else if (o.m === 4) octx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, 7);
    else octx.rect(x0, y0, x1 - x0, y1 - y0);
    octx.stroke();
  }
  octx.setLineDash([]);
  const tool = currentTool();
  if (hover && (tool !== 'pointer' || pickKeyArmed)) {
    const cx = (Math.floor(hover.x * gridW) + 0.5) / gridW * w, cy = (Math.floor(hover.y * gridH) + 0.5) / gridH * h;
    if (tool === 'text') { octx.fillStyle = '#fff9'; octx.font = `${Math.round(h / 26)}px Geist, sans-serif`; octx.fillText((engine.P.title || '').split('\n')[0], cx, cy + h / 40); }
    const br = [1, 2, 3, 4, 6, 9, 13, 2, 3, 5, 6, 2, 6, 6, 6, 13][engine.P.brush] / gridW * w;
    octx.strokeStyle = tool === 'pick' || pickKeyArmed ? '#ffb02e' : '#fff';
    octx.beginPath();
    if (tool === 'brush' || tool === 'dots') octx.arc(cx, cy, Math.max(3, br), 0, 7);
    octx.moveTo(cx - 8, cy); octx.lineTo(cx + 8, cy); octx.moveTo(cx, cy - 8); octx.lineTo(cx, cy + 8);
    octx.stroke();
  }
}

// ================================================================ inspector
// builders return elements; `bind` registers a function syncUI calls to refresh the control
const binds = [];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const P = () => engine.P;
let uid = 0;
function section(title, open, desc) {
  const s = h(`<section class="sec${open ? '' : ' closed'}"><header><h3>${title}</h3><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></header><div class="body">${desc ? `<p class="desc" style="margin:0">${desc}</p>` : ''}</div></section>`);
  s.querySelector('header').onclick = () => s.classList.toggle('closed');
  $('insp').appendChild(s);
  return s.querySelector('.body');
}
// slider over an engine param (0..255) or a look param
function slider(host, { p, look, label, min = 0, max = 255, step = 1, fmt, cls = '', reset, show }) {
  const id = 'c' + uid++;
  const el = h(`<label class="field"><span title="Double-click to reset">${label}</span><input type="range" id="${id}" class="${cls}" min="${min}" max="${max}" step="${step}"><output></output></label>`);
  const inp = el.querySelector('input'), out = el.querySelector('output'), lab = el.querySelector('span');
  const lane = look ? `look.${look[0]}.${look[1]}` : p;
  const get = () => (look ? looks[look[0]][look[1]] : P()[p]);
  const set = (v) => (look ? setLook(look[0], look[1], v) : setParam(p, v));
  inp.addEventListener('input', () => set(+inp.value));
  const rel = () => auto.release(lane);
  inp.addEventListener('change', rel); inp.addEventListener('pointerup', rel); inp.addEventListener('keyup', rel);
  lab.addEventListener('dblclick', () => { if (reset !== undefined) { set(reset); rel(); } });
  binds.push(() => {
    const v = get();
    if (document.activeElement !== inp) inp.value = v;
    out.textContent = fmt ? fmt(v) : (+v).toFixed(step < 1 ? 2 : 0);
    lab.classList.toggle('dot', auto.lanes.has(lane));
    if (show) el.hidden = !show();
  });
  host.appendChild(el); return el;
}
function seg(host, { p, look, label, opts, show, onPick }) {
  const el = h(`<div class="field" style="grid-template-columns:${label ? '96px ' : ''}minmax(0,1fr)">${label ? `<span>${label}</span>` : ''}<div class="seg">${opts.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join('')}</div></div>`);
  const get = () => (look ? looks[look[0]][look[1]] : P()[p]);
  el.querySelector('.seg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const v = isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v;
    if (look) { setLook(look[0], look[1], v); auto.release(`look.${look[0]}.${look[1]}`); } else { setParam(p, v); auto.release(p); }
    if (onPick) onPick(v);
  };
  binds.push(() => { const v = get(); for (const b of el.querySelectorAll('button')) b.classList.toggle('on', String(+v) === b.dataset.v || String(v) === b.dataset.v); if (show) el.hidden = !show(); });
  host.appendChild(el); return el;
}
function select(host, { p, look, label, opts, show, groups }) {
  const id = 'c' + uid++;
  const optHTML = groups
    ? groups.map(([g, items]) => `<optgroup label="${g}">${items.map((i) => `<option value="${opts[i][0]}">${esc(opts[i][1])}</option>`).join('')}</optgroup>`).join('')
    : opts.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  const el = h(`<label class="field"${label ? '' : ' style="grid-template-columns:minmax(0,1fr)"'}>${label ? `<span>${label}</span>` : ''}<select id="${id}">${optHTML}</select></label>`);
  const s = el.querySelector('select');
  const get = () => (look ? looks[look[0]][look[1]] : P()[p]);
  s.onchange = () => { const v = +s.value; if (look) { setLook(look[0], look[1], v); auto.release(`look.${look[0]}.${look[1]}`); } else { setParam(p, v); auto.release(p); } };
  binds.push(() => { if (document.activeElement !== s) s.value = String(get()); if (show) el.hidden = !show(); });
  host.appendChild(el); return el;
}
function toggle(host, { p, look, label, show, hint }) {
  const el = h(`<div class="row"><label>${label}${hint ? ` <span class="desc">${hint}</span>` : ''}</label><button type="button" class="switch" role="switch" aria-label="${esc(label)}"></button></div>`);
  const sw = el.querySelector('.switch');
  const get = () => (look ? looks[look[0]][look[1]] : P()[p]);
  sw.onclick = () => { const v = get() ? 0 : 1; if (look) { setLook(look[0], look[1], v); auto.release(`look.${look[0]}.${look[1]}`); } else { setParam(p, v); auto.release(p); } };
  binds.push(() => { sw.setAttribute('aria-checked', get() ? 'true' : 'false'); if (show) el.hidden = !show(); });
  host.appendChild(el); return el;
}
function buttons(host, items, cols = 3) {
  const el = h(`<div class="grid-btns" style="grid-template-columns:repeat(${cols},1fr)">${items.map((it, i) => `<button type="button" class="gbtn${it.stop ? ' stop' : ''}" data-i="${i}" title="${esc(it.title || it.label)}">${it.label}</button>`).join('')}</div>`);
  el.onclick = (e) => { const b = e.target.closest('button'); if (b) items[+b.dataset.i].run(); uiDirty = true; };
  binds.push(() => items.forEach((it, i) => { if (it.on) el.children[i].classList.toggle('on', !!it.on()); }));
  host.appendChild(el); return el;
}
const sub = (host, text) => host.appendChild(h(`<div class="sub">${text}</div>`));
const note = (host, text, show) => { const el = host.appendChild(h(`<p class="desc">${text}</p>`)); if (show) binds.push(() => { el.hidden = !show(); }); return el; };
const pct = (v) => Math.round(v / 2.55) + '%';
const bipf = (v) => { const x = Math.round((v - 128) / 1.27); return (x > 0 ? '+' : '') + x; };
const deg = (v) => Math.round(v / 255 * 360) + '°';

// friendly names for the 20 display routings, keeping the manual's name in brackets
const MODES = [
  [1, 'Canvas only', 'Paint'], [2, 'Canvas + live in mask', 'Paint/Analog'], [3, 'Canvas + CVI video in mask (records)', 'Paint/Digital'],
  [4, 'Trail: subject leaves copies', 'Trail'], [5, 'CVI video + live in mask', 'Dig./Analog'], [6, 'Paint colour into mask', 'Colour'],
  [7, 'Frame buffer (freeze, pixelate, feedback)', 'Store'], [8, 'Colour splash + live', 'Col./Analog'], [9, 'Catch-up: delayed copy behind live', 'Store/Analog'],
  [10, 'Colour trail', 'Colour trail'], [11, 'Grab outside mask, live inside', 'Acquire'], [12, 'Ghost: frozen + live double exposure', 'Ghost'],
  [13, 'Canvas with CVI video holes', 'Protect'], [14, 'Live + double exposure', 'Mix'], [15, 'CVI video, clean video in mask', 'Live combo'],
  [16, 'Canvas with colour crawl', 'Crawl'], [17, 'Colour crawl + live in mask', 'Crawl/Analog'], [18, 'Trail with colour crawl', 'Trail crawl'],
  [19, 'Feedback loop in mask', 'Cascade'], [20, 'Feedback loop, live in mask', 'Cas./Analog'],
];
const MODE_DESC = {
  1: 'Shows the canvas (the frame buffer) everywhere. Paint, freeze and fills show up here.',
  2: 'Canvas outside the mask, untouched live video inside it. Paint a mask to cut windows to the live picture.',
  3: 'Canvas outside the mask; inside it the CVI video shows and is recorded into the canvas. Sweep the mask away for slow-scan freezes.',
  4: 'With a chroma key mask, the keyed subject plays live and leaves frozen copies of itself behind.',
  5: 'Digitised CVI video everywhere (pixelated, colourized). Inside the mask, clean live video.',
  6: 'Floods the masked area of the canvas with the current colour.',
  7: 'The frame buffer refreshed from the CVI video inside the mask. Combine with pixelate, auto-scroll or mirrors for feedback effects.',
  8: 'Colour fills the canvas everywhere the freeze grabs; live video in the mask.',
  9: 'Live in the mask, a delayed (strobed) copy behind it. Set Freeze to Strobe for the catch-up effect.',
  10: 'The keyed subject plays live and leaves a trail of colour.',
  11: 'Outside the mask the canvas grabs the picture, inside it live video shows.',
  12: 'Inside the mask, a 50/50 double exposure of the frozen canvas and live video.',
  13: 'Canvas protected from updates, with CVI video showing through the mask.',
  14: 'Live outside, double exposure inside, both recording.',
  15: 'Non-destructive: CVI video outside the mask, clean video inside. The base for partial colourize.',
  16: 'The canvas with its colours crawling along painted lines.',
  17: 'Crawling canvas outside the mask, live video inside.',
  18: 'A trail whose colours pulse and crawl.',
  19: 'Inside the mask, the CVI\'s own output fed back in, like cascading a second CVI.',
  20: 'Feedback loop outside the mask, live video inside.',
};

function buildInspector() {
  $('insp').innerHTML = '';
  // ---- Mode
  let b = section('Mode', true);
  select(b, { p: 'display', opts: MODES.map(([v, t, o]) => [v, `${t}  (${o})`]), groups: [['Live video', [5, 15, 14, 12]], ['Trails & catch-up', [4, 10, 18, 9, 11]], ['Canvas & paint', [1, 2, 3, 6, 7, 8, 13]], ['Colour crawl', [16, 17]], ['Feedback', [19, 20]]].map(([g, ids]) => [g, ids.map((d) => d - 1)]) });
  const md = note(b, ''); binds.push(() => { md.textContent = MODE_DESC[P().display] || ''; });

  // ---- Pixels
  b = section('Pixels', true);
  const dt = h(`<div class="field" style="grid-template-columns:88px minmax(0,1fr)"><span>Pixel detail</span><div class="seg"><button type="button" data-v="0">Original</button><button type="button" data-v="1">Fine</button><button type="button" data-v="2">Extra fine</button></div></div>`);
  dt.querySelector('.seg').onclick = (e) => { const x = e.target.closest('button'); if (!x) return; settings.detail = +x.dataset.v; rebuildGrid(); toast(`Pixel grid ${gridW} × ${gridH}`); };
  const sm = h(`<div class="row"><label>Smooth pixels <span class="desc">soft blocks instead of squares</span></label><button type="button" class="switch" role="switch" aria-label="Smooth pixels"></button></div>`);
  sm.querySelector('.switch').onclick = () => { settings.smooth = settings.smooth ? 0 : 1; renderer.setSmooth(settings.smooth); uiDirty = true; };
  binds.push(() => { dt.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.v === settings.detail)); sm.querySelector('.switch').setAttribute('aria-checked', settings.smooth ? 'true' : 'false'); });
  b.appendChild(dt); b.appendChild(sm);
  const gi = note(b, ''); binds.push(() => { gi.textContent = `Field store ${gridW} × ${gridH} pixels, shaped to your video. Original is the real CVI resolution; finer grids look cleaner but work your computer harder (export is never affected).`; });

  // ---- Color
  b = section('Color', true);
  toggle(b, { p: 'colourize', label: 'Colorize' });
  select(b, { p: 'colourizeType', label: 'Style', opts: [[0, 'Tint (add colour)'], [1, 'Translucent film'], [2, 'Shade (subtract)'], [3, 'Range (clamp to colour)'], [4, 'Solarize'], [5, 'Monochrome / sepia'], [6, 'Posterize contours'], [7, 'Spectrum false colour']] });
  slider(b, { p: 'hue', label: 'Hue', cls: 'hue', fmt: deg, reset: 0 });
  slider(b, { p: 'sat', label: 'Saturation', fmt: pct, reset: 200 });
  slider(b, { p: 'val', label: 'Brightness', fmt: pct, reset: 255 });
  slider(b, { p: 'depth', label: 'Intensity', cls: 'bip', fmt: bipf, reset: 128 });
  note(b, 'Intensity is bipolar: right of centre is the positive effect, left of centre the negative. Centre is off. It also sets strength for paint blends.');
  sub(b, 'Colour comes from');
  seg(b, { p: 'colourizeCtl', opts: [[0, 'Sliders'], [1, 'Hold'], [2, 'Music'], [3, 'Random']] });
  slider(b, { p: 'rate1', label: 'Speed', fmt: pct, reset: 128 });
  note(b, '"Hold" keeps the picture colourized after you switch Colorize off. "Music" maps bass/mid/treble to red/green/blue.', () => P().colourizeCtl > 0);

  // ---- Freeze
  b = section('Freeze & strobe', true);
  seg(b, { p: 'freezeMode', opts: [[0, 'Live'], [1, 'Strobe'], [2, 'Burst'], [3, 'Single'], [4, 'Music']] });
  slider(b, { p: 'rate2', label: 'Rate', fmt: pct, reset: 128 });
  note(b, 'Freeze modes control when the canvas grabs the picture. Live grabs every field; Strobe and Burst grab at the Rate; Single grabs once each time you press Freeze; Music grabs on bass hits. The Freeze button (F) holds the picture. Rate also drives Flicker and Smooth moves.');

  // ---- Transform
  b = section('Transform', false);
  slider(b, { p: 'zoom', label: 'Pixelate', fmt: (v) => '×' + (1 + Math.pow(v / 255, 1.6) * 15).toFixed(1), reset: 0 });
  slider(b, { p: 'stretch', label: 'Stretch', cls: 'bip', fmt: bipf, reset: 128 });
  const panLabel = (axis) => () => (P().slide ? `Scroll ${axis}` : (axis === 'X' ? P().vmirror : P().hmirror) ? `Mirror line ${axis}` : `Position ${axis}`);
  const sx = slider(b, { p: 'hpan', label: 'Position X', cls: 'bip', fmt: bipf, reset: 128 });
  const sy = slider(b, { p: 'vpan', label: 'Position Y', cls: 'bip', fmt: bipf, reset: 128 });
  binds.push(() => { sx.querySelector('span').firstChild.textContent = panLabel('X')(); sy.querySelector('span').firstChild.textContent = panLabel('Y')(); });
  toggle(b, { p: 'vmirror', label: 'Mirror left / right' });
  toggle(b, { p: 'hmirror', label: 'Mirror top / bottom' });
  toggle(b, { p: 'slide', label: 'Auto-scroll', hint: 'position becomes speed' });
  toggle(b, { p: 'glide', label: 'Smooth moves', hint: 'speed = Rate' });
  toggle(b, { p: 'hwipe', label: 'Split screen ↔', hint: 'at Position X' });
  toggle(b, { p: 'vwipe', label: 'Split screen ↕', hint: 'at Position Y' });
  note(b, 'Pixelate and stretch change the CVI\'s pixel size on live video; on the canvas they zoom. Mirrors work on the canvas (frame buffer).');

  // ---- Mask
  b = section('Mask', false, 'The CVI\'s stencil: splits the picture into inside / outside so each can show something different (see Mode).');
  toggle(b, { p: 'useStencil', label: 'Use mask' });
  select(b, { p: 'stencilSource', label: 'Mask from', opts: [[0, 'Painted mask'], [2, 'Chroma key'], [1, 'Video 2 brightness'], [3, 'Painted mask ∩ key']] });
  toggle(b, { p: 'invertStencil', label: 'Invert' });
  toggle(b, { p: 'shatter', label: 'Flicker', hint: 'invert at Rate' });
  toggle(b, { p: 'stencilShow', label: 'Highlight painted mask' });
  const keyed = () => P().stencilSource === 2 || P().stencilSource === 3;
  const ks = sub(b, 'Key'); binds.push(() => { ks.hidden = P().stencilSource === 0; });
  seg(b, { p: 'keyMode', label: 'Key on', opts: [[0, 'Colour'], [1, 'Brightness']], show: keyed });
  const kc = h(`<label class="field"><span>Key colour</span><input type="color"><button type="button" class="gbtn" style="grid-column:auto">Pick</button></label>`);
  kc.style.gridTemplateColumns = '96px minmax(0,1fr) auto';
  const kci = kc.querySelector('input');
  kci.oninput = () => { const [r, g, bb] = [1, 3, 5].map((i) => parseInt(kci.value.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb), d = mx - mn; let hh = 0; if (d) { hh = mx === r ? ((g - bb) / d) % 6 : mx === g ? (bb - r) / d + 2 : (r - g) / d + 4; hh = (hh * 60 + 360) % 360; } setParam('keyHue', Math.round(hh)); };
  kc.querySelector('button').onclick = (e) => { e.preventDefault(); pickKeyArmed = true; toast('Click the backdrop colour in the picture'); };
  binds.push(() => { kc.hidden = !(keyed() && P().keyMode === 0); if (document.activeElement !== kci) { const c = hsvHex(P().keyHue / 360, 0.85, 0.85); kci.value = c; } });
  b.appendChild(kc);
  slider(b, { p: 'keyTol', label: 'Tolerance', fmt: pct, reset: 70, show: () => keyed() && P().keyMode === 0 });
  slider(b, { p: 'keySat', label: 'Min saturation', fmt: pct, reset: 60, show: () => keyed() && P().keyMode === 0 });
  slider(b, { p: 'keyLuma', label: 'Threshold', fmt: pct, reset: 128, show: () => (keyed() && P().keyMode === 1) || P().stencilSource === 1 });
  toggle(b, { p: 'keyInvert', label: 'Invert key', show: () => P().stencilSource !== 0 });
  note(b, 'Chroma key is blue by default, like the original. The keyed subject is "inside" the mask.', keyed);
  sub(b, 'Mask tools');
  seg(b, { p: 'stencilErase', label: 'Tools will', opts: [[0, 'Add'], [1, 'Erase']] });
  const sw = (i) => () => { pushUndo(); setParam('stencilWipe', i); press('wipeStencil'); };
  buttons(b, [
    { label: 'Clear mask', run: () => { pushUndo(); act({ k: 'stencilFill', v: 0 }); } },
    { label: 'Fill mask', run: () => { pushUndo(); act({ k: 'stencilFill', v: 1 }); } },
    { label: 'Texture', title: 'Mask from the selected texture (Paint section)', run: sw(1) },
    { label: 'Sweep →', title: 'One column per field, the slow-scan wipe', run: sw(2) },
    { label: 'Sweep ↓', run: sw(3) },
    { label: 'Invert sweep', run: sw(4) },
    { label: 'Find edges', title: 'Outline edges in the canvas', run: sw(5) },
    { label: 'Find colour', title: 'Mask the colour last picked with the eyedropper', run: sw(6) },
    { label: 'Boil', title: 'Random dots until Stop', run: sw(7) },
    { label: 'Window', title: 'Rectangle from Position, Pixelate (size) and Stretch', run: sw(8) },
    { label: 'Stop', stop: true, run: () => press('stop') },
  ]);

  // ---- Paint
  b = section('Paint & brush', false, 'Pick a tool above the viewer, then drag on the picture. Paint lands on the canvas, so use a Canvas mode (or Paint effects) to see it.');
  const pc = h(`<div class="paintcol"><div class="chipcol"></div><div style="display:grid;gap:6px"><input type="color" aria-label="Paint colour"></div></div>`);
  const pci = pc.querySelector('input'), chip = pc.querySelector('.chipcol');
  pci.oninput = () => { const [r, g, bb] = [1, 3, 5].map((i) => parseInt(pci.value.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, bb), mn = Math.min(r, g, bb), d = mx - mn; let hh = 0; if (d) { hh = mx === r ? ((g - bb) / d) % 6 : mx === g ? (bb - r) / d + 2 : (r - g) / d + 4; hh = ((hh / 6) + 1) % 1; } setParam('hue', Math.round(hh * 255)); setParam('sat', Math.round((mx ? d / mx : 0) * 255)); setParam('val', Math.round(mx * 255)); };
  binds.push(() => { const c = hsvHex(P().hue / 255, P().sat / 255, P().val / 255); chip.style.background = c; if (document.activeElement !== pci) pci.value = c; });
  b.appendChild(pc);
  note(b, 'Paint colour and the Color section share the same Hue / Saturation / Brightness, just like the original console.');
  seg(b, { p: 'colourCtl', label: 'Colour', opts: [[0, 'Fixed'], [1, 'Music'], [2, 'Cycle'], [3, 'Random B&W']] });
  sub(b, 'Brush');
  const br = h(`<div class="brushes">${MENUS.brush.map((n, i) => `<button type="button" data-i="${i}" title="${n}"><canvas width="32" height="32"></canvas></button>`).join('')}</div>`);
  br.querySelectorAll('canvas').forEach((c, i) => drawBrushIcon(c, i));
  br.onclick = (e) => { const x = e.target.closest('button'); if (x) setParam('brush', +x.dataset.i); };
  binds.push(() => br.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', P().brush === i)));
  b.appendChild(br);
  select(b, { p: 'paintType', label: 'Style', opts: MENUS.paintType.map((n, i) => [i, ['Solid', 'Spatter', 'Mottled', 'Fade left→right', 'Fade top→bottom', 'Rainbow by position'][i]]) });
  select(b, { p: 'colourType', label: 'Blend', opts: [[0, 'Normal (opaque)'], [1, 'Tint (add)'], [2, 'Watercolour'], [3, 'Shade'], [4, 'Range (clamp)'], [5, 'Solarize'], [6, 'Monochrome'], [7, 'Posterize'], [8, 'Spectrum']] });
  select(b, { p: 'symmetry', label: 'Symmetry', opts: MENUS.symmetry.map((n, i) => [i, ['Off', 'Mirror ↔', 'Mirror ↕', 'Flip only', '4-way', 'Diagonal', 'Kaleidoscope (8)', 'Rotate 90° (4)', 'Spin 180°'][i]]) });
  toggle(b, { p: 'useTexture', label: 'Paint through texture' });
  const tx = h(`<div class="swatches">${MENUS.texture.map((n, i) => `<button type="button" data-i="${i}" title="${n}"><img alt="${n}" src="${textureURL(i)}"></button>`).join('')}</div>`);
  tx.onclick = (e) => { const x = e.target.closest('button'); if (x) setParam('texture', +x.dataset.i); };
  binds.push(() => tx.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', P().texture === i)));
  b.appendChild(tx);
  toggle(b, { p: 'drawUnder', label: 'Respect mask', hint: "don't paint inside" });
  toggle(b, { p: 'dejag', label: 'Smooth edges' });

  // ---- Fill
  b = section('Fill canvas', false, 'The CVI\'s colour wipes. Uses the paint colour, blend and texture.');
  const cw = (i) => () => { pushUndo(); setParam('colourWipe', i); press('wipeColour'); };
  buttons(b, [
    { label: 'White', run: cw(0) }, { label: 'Solid colour', run: cw(1) }, { label: 'Texture', run: cw(2) },
    { label: 'Sweep →', title: 'Moving the colour while it runs makes bands', run: cw(3) }, { label: 'Sweep ↓', run: cw(4) }, { label: 'Recolour all', title: 'Run the whole canvas through the current blend', run: cw(5) },
    { label: 'Colour tunnel', title: 'Rings radiate from the centre until Stop. Position moves the centre, Pixelate sets ring width', run: cw(6) }, { label: 'Disintegrate', title: 'Random dots until Stop', run: cw(7) },
    { label: 'Stop', stop: true, run: () => press('stop') },
    { label: 'Clear canvas', run: () => { pushUndo(); act({ k: 'storeFill', c: [0, 0, 0] }); } },
    { label: 'Colour bars', run: () => { pushUndo(); act({ k: 'pattern', v: 'bars' }); } },
    { label: 'Test pattern', run: () => { pushUndo(); act({ k: 'pattern', v: 'test' }); } },
  ]);

  // ---- Text
  b = section('Text', false);
  const ta = h(`<textarea rows="2" maxlength="160" aria-label="Text"></textarea>`);
  ta.oninput = () => setParam('title', ta.value.toUpperCase());
  binds.push(() => { if (document.activeElement !== ta) ta.value = P().title; });
  b.appendChild(ta);
  seg(b, { p: 'titleSize', label: 'Size', opts: [1, 2, 3, 4, 5].map((s) => [s, String(s)]) });
  select(b, { p: 'titleFormat', label: 'Style', opts: MENUS.titleFormat.map((n, i) => [i, n]) });
  buttons(b, [{ label: 'Place text on picture', run: () => selectTool('text'), on: () => engine.titleArmed }], 1);
  note(b, 'Uses the CVI\'s 5×7 character set (capitals, numbers, punctuation) and the paint colour. Click the picture to stamp; Esc stops.');

  // ---- Inputs
  b = section('Inputs & output', false);
  seg(b, { p: 'digSrc', label: 'CVI video', opts: [[0, 'Video 1'], [1, 'Video 2']] });
  seg(b, { p: 'anaSrc', label: 'Clean video', opts: [[0, 'Video 1'], [1, 'Video 2']] });
  seg(b, { p: 'keySrc', label: 'Key from', opts: [[0, 'Video 1'], [1, 'Video 2']] });
  toggle(b, { p: 'blanking', label: 'Hardware borders', hint: 'extended blanking' });
  const fr = h(`<div class="field" style="grid-template-columns:96px minmax(0,1fr)"><span>Field clock</span><div class="seg"><button type="button" data-v="50">50 Hz PAL</button><button type="button" data-v="60">60 Hz NTSC</button></div></div>`);
  fr.querySelector('.seg').onclick = (e) => { const x = e.target.closest('button'); if (!x) return; fieldRate = +x.dataset.v; syncFieldToTime(curTime()); toast(`Field clock ${fieldRate} Hz`); };
  binds.push(() => fr.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.v === fieldRate)));
  b.appendChild(fr);
  note(b, 'Video 2 (import it from the top bar) feeds two-input effects: keys, wipes, flips and double exposures. The field clock sets how fast rates, strobes and sweeps run: the original CVI was PAL, 50 fields a second.');

  // ---- Looks
  b = section('Looks', true, 'Applied after the CVI in this order: Black & white → Halftone → VHS → CRT.');
  for (const k of ['bw', 'halftone', 'vhs', 'crt']) {
    const spec = LOOK_UI[k];
    const head = h(`<div class="row" style="margin-top:4px"><label style="font-weight:600">${spec.title}</label><button type="button" class="switch" role="switch" aria-label="${spec.title}"></button></div>`);
    const swb = head.querySelector('.switch');
    const box = h('<div style="display:grid;gap:8px;padding-left:2px"></div>');
    swb.onclick = () => { setLook(k, 'on', looks[k].on ? 0 : 1); auto.release(`look.${k}.on`); };
    binds.push(() => { swb.setAttribute('aria-checked', looks[k].on ? 'true' : 'false'); box.hidden = !looks[k].on; });
    b.appendChild(head); b.appendChild(box);
    for (const [key, label, a, bb, step] of spec.ctl) {
      if (a === 'sel') { if (bb.length <= 4) seg(box, { look: [k, key], label, opts: bb.map((o, i) => [i, o]) }); else select(box, { look: [k, key], label, opts: bb.map((o, i) => [i, o]) }); }
      else if (a === 'col') {
        const el = h(`<label class="field"><span>${label}</span><input type="color"></label>`);
        const ci = el.querySelector('input');
        ci.oninput = () => setLook(k, key, [1, 3, 5].map((i) => parseInt(ci.value.slice(i, i + 2), 16) / 255));
        binds.push(() => { if (document.activeElement !== ci) ci.value = '#' + looks[k][key].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''); });
        box.appendChild(el);
      } else slider(box, { look: [k, key], label, min: a, max: bb, step, reset: LOOK_DEFAULTS[k][key] });
    }
  }
}
const LOOK_UI = {
  bw: { title: 'Black & white', ctl: [
    ['mode', 'Filter', 'sel', ['Neutral', 'Red', 'Green', 'Blue']], ['contrast', 'Contrast', 0.4, 2.5, 0.01], ['bright', 'Brightness', -0.5, 0.5, 0.01], ['gamma', 'Gamma', 0.4, 2.2, 0.01],
    ['grain', 'Grain', 0, 0.6, 0.01], ['grainSize', 'Grain size', 1, 5, 0.1], ['tintAmt', 'Toning', 0, 1, 0.01], ['tintHue', 'Tone hue', 0, 1, 0.005], ['vignette', 'Vignette', 0, 1, 0.01]] },
  halftone: { title: 'Halftone', ctl: [
    ['style', 'Screen', 'sel', ['Mono', 'CMYK', 'Colour']], ['shape', 'Dot', 'sel', ['Round', 'Lines', 'Squares']], ['cell', 'Dot size', 3, 32, 0.5], ['angle', 'Angle', 0, 90, 1],
    ['contrast', 'Contrast', 0.4, 2.5, 0.01], ['ink', 'Ink', 'col'], ['paper', 'Paper', 'col'], ['mixAmt', 'Mix', 0, 1, 0.01]] },
  vhs: { title: 'VHS', ctl: [
    ['chromaBlur', 'Colour blur', 0.3, 8, 0.1], ['chromaShift', 'Colour shift', 0, 6, 0.1], ['bleed', 'Colour bleed', 0, 1, 0.01], ['sat', 'Saturation', 0, 2, 0.01],
    ['soft', 'Softness', 0.3, 3, 0.05], ['sharpen', 'Edge ringing', 0, 2, 0.01], ['noise', 'Snow', 0, 1, 0.01], ['tracking', 'Tracking', 0, 1, 0.01],
    ['jitter', 'Jitter', 0, 1, 0.01], ['headSwitch', 'Head switch', 0, 1, 0.01], ['dropouts', 'Dropouts', 0, 1, 0.01], ['wear', 'Tape wear', 0, 1, 0.01]] },
  crt: { title: 'CRT', ctl: [
    ['maskType', 'Mask', 'sel', ['None', 'Grille', 'Shadow', 'Slot']], ['curv', 'Curvature', 0, 1.5, 0.01], ['scan', 'Scanlines', 0, 1, 0.01], ['lines', 'Line count', 120, 1080, 2],
    ['maskAmt', 'Mask strength', 0, 1, 0.01], ['bloom', 'Glow', 0, 1.5, 0.01], ['converge', 'Convergence', 0, 4, 0.05], ['persist', 'Persistence', 0, 0.9, 0.01],
    ['vignette', 'Vignette', 0, 1, 0.01], ['bright', 'Brightness', 0.5, 2, 0.01], ['flicker', 'Flicker', 0, 1, 0.01], ['cornerR', 'Corners', 0, 0.2, 0.005], ['interlace', 'Interlace', 'sel', ['Off', 'On']]] },
};
function hsvHex(hh, s, v) {
  const f = (n) => { const k = (n + hh * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
}
function textureURL(i) {
  const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'); const im = x.createImageData(32, 32);
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) { const v = texel(i, z, y) ? 230 : 30; const o = (y * 32 + z) * 4; im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255; }
  x.putImageData(im, 0, 0); return c.toDataURL();
}
function drawBrushIcon(c, i) {
  const g = c.getContext('2d'); g.fillStyle = '#e8e8ec';
  const t = new CVI(32); // borrow the engine's brush table by stamping into a tiny store
  t.P.brush = i; t.P.colourType = 0; t.P.dejag = 0; t.P.hue = 0; t.P.sat = 0; t.P.val = 255; t.buildMaps(); t.stamp(16, 16);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (t.store[(y * 32 + x) * 3]) g.fillRect(x, y, 1, 1);
}

// ================================================================ sync
function syncUI() {
  for (const f of binds) f();
  const tool = currentTool();
  for (const b of document.querySelectorAll('.tool[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  const tgt = engine.P.drawColour && engine.P.drawStencil ? 'b' : engine.P.drawStencil ? 'm' : 'c';
  for (const b of document.querySelectorAll('#paintTarget button')) b.classList.toggle('on', b.dataset.t === tgt);
  const hints = { pointer: '', text: 'Click to place text', pick: 'Click to pick a colour', fill: 'Fills the area bounded by the painted mask', cut: 'Drag a box, then click to paste', copy: 'Click: copies live video into the masked area' };
  $('toolHint').textContent = hints[tool] ?? (tool === 'brush' || tool === 'dots' ? 'Drag to paint' : 'Drag to draw');
  screenEl.classList.toggle('painting', tool !== 'pointer' || pickKeyArmed);
  const single = engine.P.freezeMode === 3 || engine.P.freezeMode === 5;
  $('btnFreeze').textContent = single ? 'Grab frame' : 'Freeze';
  $('btnFreeze').classList.toggle('on', !single && !!engine.P.freeze);
  $('btnRec').classList.toggle('on', recArm); $('btnRec').classList.toggle('live', recording());
  $('btnLoop').classList.toggle('on', loop);
  $('playIcon').innerHTML = playing ? '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>' : '<path d="M4 2l10 6-10 6z"/>';
  $('tlNote').textContent = recording() ? 'Recording: every change is being written to the timeline.' : recArm ? 'Armed. Press play to start recording.' : 'Press Record, then play. Everything you change is written to the timeline and replayed on export.';
}
let toastTimer;
function toast(m) { const t = $('toast'); t.textContent = m; t.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = 0; }, 2200); }

// ================================================================ timeline
const tl = $('timeline'), tctx = tl.getContext('2d');
const LABEL_W = 150, RULER_H = 20, ROW_H = 18;
const PARAM_LABELS = { hue: 'Hue', sat: 'Saturation', val: 'Brightness', depth: 'Intensity', rate1: 'Random speed', rate2: 'Rate', hpan: 'Position X', vpan: 'Position Y', stretch: 'Stretch', zoom: 'Pixelate', display: 'Mode', colourize: 'Colorize', colourizeType: 'Colour style', freezeMode: 'Freeze mode', freeze: 'Freeze', useStencil: 'Mask on', invertStencil: 'Invert mask', stencilSource: 'Mask from' };
function laneList() { const l = [...auto.lanes.keys()]; if (auto.events.length) l.push('#events'); return l; }
function laneLabel(l) {
  if (l === '#events') return 'Effects / paint / buttons';
  if (l.startsWith('look.')) { const [, k, key] = l.split('.'); const c = LOOK_UI[k].ctl.find((x) => x[0] === key); return `${LOOK_UI[k].title}: ${key === 'on' ? 'on/off' : c ? c[1] : key}`; }
  return PARAM_LABELS[l] || l.replace(/([A-Z])/g, ' $1').toLowerCase();
}
function drawTimeline() {
  const lanes = laneList();
  const cssH = Math.max(96, RULER_H + 6 + lanes.length * ROW_H + 6);
  const dpr = window.devicePixelRatio || 1, cssW = tl.clientWidth;
  if (tl.width !== Math.round(cssW * dpr) || tl.height !== Math.round(cssH * dpr)) { tl.style.height = Math.min(cssH, 240) + 'px'; tl.width = Math.round(cssW * dpr); tl.height = Math.round(Math.min(cssH, 240) * dpr); }
  const H = tl.height / dpr;
  const g = tctx; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#0e0f11'; g.fillRect(0, 0, cssW, H);
  const dur = duration(), W = cssW - LABEL_W - 10;
  const X = (t) => LABEL_W + (dur ? t / dur : 0) * W;
  g.font = '12px Geist, system-ui, sans-serif'; g.textBaseline = 'middle';
  g.fillStyle = '#18191d'; g.fillRect(0, 0, cssW, RULER_H);
  if (dur) {
    const step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => (W / dur) * s > 56) || 600;
    g.fillStyle = '#6c6e78';
    for (let t = 0; t <= dur + 1e-6; t += step) { const x = X(t); g.fillRect(x, RULER_H - 5, 1, 5); g.fillText(step < 1 ? `${fmtShort(t)}.${Math.round((t % 1) * 10)}` : fmtShort(t), x + 3, RULER_H / 2); }
  } else { g.fillStyle = '#6c6e78'; g.fillText('Import a video to record automation against it', LABEL_W, RULER_H / 2); }
  lanes.forEach((lane, i) => {
    const y = RULER_H + 6 + i * ROW_H; if (y > H) return;
    g.fillStyle = i % 2 ? '#131417' : '#16171a'; g.fillRect(0, y, cssW, ROW_H);
    g.fillStyle = '#c9cad1'; g.fillText(laneLabel(lane).slice(0, 22), 8, y + ROW_H / 2);
    g.fillStyle = '#ff8a80'; g.fillText('×', LABEL_W - 16, y + ROW_H / 2);
    if (!dur) return;
    if (lane === '#events') { g.fillStyle = '#4f7bff'; for (const e of auto.events) g.fillRect(X(e.f / fieldRate), y + 4, 2, ROW_H - 8); return; }
    const pts = auto.lanes.get(lane);
    const val = (v) => (Array.isArray(v) ? v[0] : +v);
    const nums = pts.map((p) => val(p.v)).filter((v) => !isNaN(v));
    const lo = Math.min(0, ...nums), hi = Math.max(1, ...nums);
    const Y = (v) => y + ROW_H - 3 - ((val(v) - lo) / (hi - lo || 1)) * (ROW_H - 6);
    g.strokeStyle = '#ffb02e'; g.lineWidth = 1.5; g.beginPath();
    pts.forEach((p, j) => { const x = X(p.f / fieldRate); if (j === 0) g.moveTo(LABEL_W, Y(p.v)); g.lineTo(x, j ? Y(pts[j - 1].v) : Y(p.v)); g.lineTo(x, Y(p.v)); });
    g.lineTo(LABEL_W + W, Y(pts[pts.length - 1].v)); g.stroke();
  });
  if (dur) { const x = X(curTime()); g.fillStyle = recording() ? '#ff453a' : '#fff'; g.fillRect(x - 1, 0, 2, H); }
  const t = curTime();
  $('tc').innerHTML = `${fmtShort(t)}<small>.${String(Math.floor((t % 1) * 100)).padStart(2, '0')}</small>${dur ? ` <small>/ ${fmtShort(dur)}</small>` : ''}`;
}
const fmtShort = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let scrubbing = false;
const tlTime = (e) => { const r = tl.getBoundingClientRect(); return ((e.clientX - r.left - LABEL_W) / (r.width - LABEL_W - 10)) * duration(); };
tl.addEventListener('pointerdown', (e) => {
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < LABEL_W) { const i = Math.floor((y - RULER_H - 6) / ROW_H), lanes = laneList(); if (i >= 0 && i < lanes.length && x > LABEL_W - 26) { auto.clearLane(lanes[i]); uiDirty = true; } return; }
  scrubbing = true; tl.setPointerCapture(e.pointerId); seek(tlTime(e));
});
tl.addEventListener('pointermove', (e) => { if (scrubbing) seek(tlTime(e)); });
tl.addEventListener('pointerup', () => { scrubbing = false; });

// ================================================================ keyboard
let presetKeys = null;
window.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input:not([type=range]), textarea, select')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (presetKeys !== null && /^[0-9]$/.test(k)) { presetKeys += k; if (presetKeys.length === 2) { applyFactory(+presetKeys); presetKeys = null; } e.preventDefault(); return; }
  const tool = TOOLS.find((t) => t !== 'sep' && t[3] === k);
  if (tool) { selectTool(tool[0]); return; }
  switch (k) {
    case ' ': e.preventDefault(); playing ? pause() : play(); break;
    case 'f': press('freeze'); break;
    case 'escape': press('stop'); pickKeyArmed = false; selectTool('pointer'); break;
    case 'p': presetKeys = ''; toast('Type a two-digit effect number'); break;
    case 'home': home(); break;
    case 'arrowleft': seek(curTime() - (e.shiftKey ? 5 : 1)); break;
    case 'arrowright': seek(curTime() + (e.shiftKey ? 5 : 1)); break;
    case '[': setParam('brush', Math.max(0, engine.P.brush - 1)); break;
    case ']': setParam('brush', Math.min(15, engine.P.brush + 1)); break;
  }
});

// ================================================================ project files
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
$('btnSave').onclick = () => {
  const snap = exportBase();
  const proj = { app: 'CVI-84', version: 3, fieldRate, current, settings: { ...settings }, grid: [gridW, gridH], params: engine.P, looks, automation: auto.toJSON(),
    start: { store: b64(snap.store), stencil: b64(snap.stencil), rng: snap.rng, params: snap.P, looks: snap.looks, current: snap.current || current } };
  download(new Blob([JSON.stringify(proj)], { type: 'application/json' }), (src.v1 ? src.v1.name.replace(/\.[^.]+$/, '') : 'cvi-84') + '.cvi84.json');
  toast('Project saved');
};
$('btnOpen').onclick = () => $('fileProj').click();
$('fileProj').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (p.app !== 'CVI-84') throw new Error('Not a CVI-84 project file');
    fieldRate = p.fieldRate || 50;
    if (p.settings) { Object.assign(settings, p.settings); renderer.setSmooth(settings.smooth); rebuildGrid(); }
    engine.P = { ...engine.P, ...p.params };
    looks = { ...clone(LOOK_DEFAULTS), ...p.looks };
    auto = Automation.fromJSON(p.automation || {});
    if (p.current) current = p.current; else if (p.presetNo != null) current = { kind: 'factory', n: p.presetNo };
    presetTouched = true;
    if (p.start && unb64(p.start.store).length === engine.store.length) {
      engine.store.set(unb64(p.start.store)); engine.stencil.set(unb64(p.start.stencil)); engine.rng.s = p.start.rng;
      startSnap = engine.snapshot(true); startSnap.field = 0;
      if (p.start.params) startSnap.P = { ...engine.P, ...p.start.params };
      startSnap.looks = p.start.looks ? { ...clone(LOOK_DEFAULTS), ...p.start.looks } : clone(looks);
      startSnap.current = p.start.current || current;
    }
    syncFieldToTime(curTime()); markCurrentCard();
    toast('Project opened' + (src.v1 ? '' : ': import the matching video'));
  } catch (err) { toast(err.message); }
};

// ================================================================ export
const dlg = $('exportDlg');
let exporting = null;
$('btnExport').onclick = () => {
  if (!src.v1) { toast('Import a video first'); return; }
  $('exportMsg').textContent = auto.isEmpty() ? 'No automation recorded, so the current settings are used for the whole clip.' : 'Renders the clip from the start with your recorded automation.';
  $('exBar').style.width = '0'; $('exGo').disabled = false;
  dlg.showModal();
};
$('exCancel').onclick = async () => { if (exporting) { await exporting.cancel().catch(() => {}); exporting = null; } dlg.close(); };
$('exGo').onclick = () => runExport().catch((e) => { $('exportMsg').innerHTML = `<span class="err">${esc(e.message || e)}</span>`; exporting = null; $('exGo').disabled = false; });
async function runExport() {
  pause();
  $('exGo').disabled = true; $('exportMsg').textContent = 'Preparing…';
  const MB = await import('./vendor/mediabunny.min.mjs');
  const input = new MB.Input({ source: new MB.BlobSource(src.v1.file), formats: MB.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('That file has no video track.');
  const sw = vt.displayWidth, sh = vt.displayHeight;
  const resSel = $('exRes').value;
  let hgt = resSel === 'src' ? sh : Math.min(+resSel, sh);
  const wid = Math.round((hgt * sw / sh) / 2) * 2; hgt -= hgt % 2;
  const q = { high: MB.QUALITY_HIGH, vhigh: MB.QUALITY_VERY_HIGH, med: MB.QUALITY_MEDIUM }[$('exQ').value];
  if (!(await MB.canEncodeVideo('avc', { width: wid, height: hgt }))) throw new Error('This browser cannot encode H.264 at that size. Try 720p, or use Chrome or Edge.');
  const eng = new CVI(gridW, gridH);
  const base = exportBase();
  eng.restore(base); eng.field = 0;
  const lk = clone(base.looks);
  const au = Automation.fromJSON(clone(auto.toJSON()));
  const canvas = new OffscreenCanvas(wid, hgt);
  const rend = new Renderer(canvas, N); rend.resize(wid, hgt); rend.setSmooth(settings.smooth);
  const GW = gridW, GH = gridH;
  const s1 = new OffscreenCanvas(GW, GH).getContext('2d', { willReadFrequently: true });
  const s2 = new OffscreenCanvas(GW, GH).getContext('2d', { willReadFrequently: true });
  let sink2 = null, v2canvas = null;
  if (src.v2) {
    const in2 = new MB.Input({ source: new MB.BlobSource(src.v2.file), formats: MB.ALL_FORMATS });
    const t2 = await in2.getPrimaryVideoTrack();
    if (t2) { sink2 = new MB.VideoSampleSink(t2); v2canvas = new OffscreenCanvas(t2.displayWidth, t2.displayHeight); }
  }
  const v2dur = src.v2 ? src.v2.el.duration || 1 : 1;
  const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
  let t0 = null;
  const conv = await MB.Conversion.init({
    input, output,
    video: {
      forceTranscode: true, codec: 'avc', bitrate: q, processedWidth: wid, processedHeight: hgt,
      process: async (sample) => {
        if (t0 === null) t0 = sample.timestamp;
        const t = sample.timestamp - t0;
        sample.draw(s1, 0, 0, GW, GH);
        const inputs = { v1: s1.getImageData(0, 0, GW, GH).data, v2: null };
        let s2s = null;
        if (sink2) { s2s = await sink2.getSample(t % v2dur); if (s2s) { s2s.draw(s2, 0, 0, GW, GH); inputs.v2 = s2.getImageData(0, 0, GW, GH).data; } }
        const target = Math.floor(t * fieldRate + 1e-6);
        while (eng.field <= target) { applyAutomation(eng.field, eng, lk, au); eng.step(inputs, audioAt(eng.field)); }
        if (eng.P.anaSrc && s2s) { s2s.draw(v2canvas.getContext('2d'), 0, 0, v2canvas.width, v2canvas.height); rend.uploadAnalog(v2canvas); }
        else { const vf = sample.toVideoFrame(); rend.uploadAnalog(vf); vf.close(); }
        if (s2s) s2s.close();
        rend.uploadView(eng.view, GW, GH); rend.render(lk, eng.field, eng.P.blanking);
        return canvas;
      },
    },
    audio: $('exAudio').value === '1' ? {} : { discard: true },
  });
  if (!conv.isValid) throw new Error('Export could not start: ' + conv.discardedTracks.map((d) => `${d.track.type} track (${d.reason})`).join(', '));
  exporting = conv;
  conv.onProgress = (p) => { $('exBar').style.width = `${(p * 100).toFixed(1)}%`; $('exportMsg').textContent = `Rendering… ${(p * 100).toFixed(0)}%`; };
  const started = performance.now();
  await conv.execute();
  exporting = null;
  const blob = new Blob([output.target.buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);
  const name = src.v1.name.replace(/\.[^.]+$/, '') + '-cvi84.mp4';
  $('exBar').style.width = '100%';
  $('exportMsg').innerHTML = `Done in ${((performance.now() - started) / 1000).toFixed(0)} s, ${(blob.size / 1048576).toFixed(1)} MB. <a href="${url}" download="${esc(name)}">Save ${esc(name)}</a>`;
  download(blob, name);
  $('exGo').disabled = false;
}

// ================================================================ go
buildTools();
buildInspector();
buildChips();
buildFxList();
applyFactory(59, false);
drawDemo(demo, 0);
fitPreview();
requestAnimationFrame(tick);
window.__cvi = { engine, auto, get looks() { return looks; }, applyFactory, setParam, setLook, play, pause, seek, importVideo, loadVideo, runExport, selectTool, press };
