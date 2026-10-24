import { CVI, DISPLAY, MENUS, SLIDERS, texel, PLANE } from './cvi-engine.js';
import { FACTORY, presetState } from './presets.js';
import { Renderer, LOOK_DEFAULTS } from './gl.js';
import { Automation } from './automation.js';

const N = 256;
const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- state
const engine = new CVI(N);
let looks = clone(LOOK_DEFAULTS);
let auto = new Automation();
let fieldRate = 50;
let playing = false, recArm = false, loop = false;
let startSnap = null;
let presetNo = 76, presetTouched = false;
let drawHeld = false;
let menuOpen = false, menuPage = 'V0';
let presetEntry = null; // null | '' | '5'
let uiDirty = true;
let toastMsg = '', toastUntil = 0;
const src = { v1: null, v2: null }; // {el, file, env, name}

const screenEl = $('screen'), outCanvas = $('out'), overlay = $('overlay'), octx = overlay.getContext('2d');
let renderer;
try { renderer = new Renderer(outCanvas, N); }
catch (e) { document.body.insertAdjacentHTML('afterbegin', `<p class="err" style="padding:16px">This browser can't run CVI-84: ${e.message}. Use a current Chrome, Edge or Safari.</p>`); throw e; }

// samplers: every source is digitised to the NxN field-store grid
const mkSampler = () => { const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; return x; };
const samp1 = mkSampler(), samp2 = mkSampler();

// demo source: a subject moving over a blue key background, so keys and trails work before you load anything
const demo = document.createElement('canvas'); demo.width = 640; demo.height = 480;
const dctx = demo.getContext('2d');
function drawDemo(t) {
  const g = dctx;
  g.fillStyle = '#1d3fd8'; g.fillRect(0, 0, 640, 480);
  const x = 320 + Math.sin(t * 0.9) * 200, y = 260 + Math.sin(t * 1.7) * 70;
  g.save(); g.translate(x, y); g.rotate(Math.sin(t * 1.3) * 0.3);
  g.fillStyle = '#ff7a2f'; g.beginPath(); g.ellipse(0, 40, 52, 78, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#ffd9b0'; g.beginPath(); g.arc(0, -64, 42, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#1a1a1a'; g.beginPath(); g.arc(-14, -70, 6, 0, 7); g.arc(14, -70, 6, 0, 7); g.fill();
  g.strokeStyle = '#1a1a1a'; g.lineWidth = 5; g.beginPath(); g.arc(0, -58, 18, 0.2, Math.PI - 0.2); g.stroke();
  g.strokeStyle = '#ff7a2f'; g.lineWidth = 18; g.lineCap = 'round';
  g.beginPath(); g.moveTo(-40, 10); g.lineTo(-95, -30 + Math.sin(t * 6) * 40); g.moveTo(40, 10); g.lineTo(95, -30 - Math.sin(t * 6) * 40); g.stroke();
  g.restore();
  for (let i = 0; i < 6; i++) { g.fillStyle = `hsl(${(i * 60 + t * 40) % 360} 90% 55%)`; g.beginPath(); g.arc(560, 80, 50 - i * 8, 0, 7); g.fill(); }
  g.fillStyle = '#fff'; g.font = 'bold 44px Barlow Condensed, sans-serif'; g.fillText('TELL YOUR FRIENDS', ((-t * 120) % 1100 + 1100) % 1100 - 420, 450);
}

// ---------------------------------------------------------------- audio analysis (music modes)
// Bass / mid / treble envelopes at 100 Hz, computed once from the file so preview and export see the same numbers.
async function analyseAudio(file) {
  try {
    const buf = await file.arrayBuffer();
    const ac = new OfflineAudioContext(1, 1, 44100);
    const ab = await ac.decodeAudioData(buf);
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
  } catch (e) { return null; }
}
function audioAt(f) {
  const env = src.v1 && src.v1.env;
  if (!env) { // no soundtrack: a steady 120 bpm pulse so the music modes still do something
    const beat = (f / fieldRate) * 2; const ph = beat - Math.floor(beat);
    return { b: Math.exp(-ph * 6), m: 0.4 + 0.3 * Math.sin(f / fieldRate * 3.1), t: 0.3 + 0.3 * Math.sin(f / fieldRate * 7.3) };
  }
  const i = Math.min(env.b.length - 1, Math.floor(f / fieldRate * 100));
  return { b: env.b[i] || 0, m: env.m[i] || 0, t: env.t[i] || 0 };
}

// ---------------------------------------------------------------- sources
function v1Source() { return src.v1 && src.v1.el.readyState >= 2 ? src.v1.el : demo; }
function v2Source() { return src.v2 && src.v2.el.readyState >= 2 ? src.v2.el : null; }
function grabInputs() {
  const s1 = v1Source();
  samp1.drawImage(s1, 0, 0, N, N);
  const out = { v1: samp1.getImageData(0, 0, N, N).data, v2: null };
  const s2 = v2Source();
  if (s2) { samp2.drawImage(s2, 0, 0, N, N); out.v2 = samp2.getImageData(0, 0, N, N).data; }
  return out;
}
function sourceSize() {
  const s = v1Source();
  const w = s.videoWidth || s.width, h = s.videoHeight || s.height;
  return [w || 640, h || 480];
}
function fitPreview() {
  let [w, h] = sourceSize();
  if (h > 720) { w = Math.round(w * 720 / h); h = 720; }
  w -= w % 2; h -= h % 2;
  renderer.resize(w, h);
  overlay.width = w; overlay.height = h;
  screenEl.style.aspectRatio = `${w} / ${h}`;
}

async function loadVideo(which, file) {
  if (!file) return;
  const el = document.createElement('video');
  el.src = URL.createObjectURL(file); el.playsInline = true; el.preload = 'auto'; el.crossOrigin = 'anonymous';
  if (which === 'v2') el.muted = true;
  if (src[which]) { src[which].el.pause(); URL.revokeObjectURL(src[which].el.src); }
  src[which] = { el, file, env: null, name: file.name };
  await new Promise((res, rej) => { el.onloadeddata = res; el.onerror = () => rej(new Error('That file could not be decoded by this browser.')); }).catch((e) => { toast(e.message); src[which] = null; throw e; });
  if (which === 'v1') {
    pause(); el.currentTime = 0;
    el.onended = () => { if (loop) { home(); play(); } else pause(); };
    $('srcName').textContent = file.name;
    $('dropzone').hidden = true;
    startSnap = null; engine.field = 0;
    if (!presetTouched) loadPreset(76, false);
    fitPreview();
    analyseAudio(file).then((env) => { if (src.v1 && src.v1.file === file) src.v1.env = env; });
    toast('Loaded ' + file.name);
  } else {
    el.loop = true; el.play().catch(() => {});
    toast('V2: ' + file.name);
  }
  uiDirty = true;
}
$('fileV1').onchange = (e) => loadVideo('v1', e.target.files[0]).catch(() => {});
$('fileV2').onchange = (e) => loadVideo('v2', e.target.files[0]).catch(() => {});
screenEl.addEventListener('dragover', (e) => { e.preventDefault(); screenEl.classList.add('dragging'); });
screenEl.addEventListener('dragleave', () => screenEl.classList.remove('dragging'));
screenEl.addEventListener('drop', (e) => {
  e.preventDefault(); screenEl.classList.remove('dragging');
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v)$/i.test(x.name));
  if (f) loadVideo('v1', f).catch(() => {});
});

// ---------------------------------------------------------------- actions (all console input flows through here)
function recording() { return recArm && playing; }
function act(a) {
  const prev = a.k === 'set' ? engine.P[a.p] : undefined;
  engine.dispatch(a);
  if (recording()) { if (a.k === 'set') auto.recordValue(a.p, engine.field, a.v, prev); else auto.recordEvent(engine.field, a); }
  uiDirty = true;
}
function setParam(p, v) { act({ k: 'set', p, v }); }
function press(b) { act({ k: 'press', b }); }
function setLook(look, key, v) {
  const prev = looks[look][key];
  looks[look][key] = v;
  if (recording()) auto.recordValue(`look.${look}.${key}`, engine.field, v, prev);
  uiDirty = true;
}
function releaseLane(lane) { auto.release(lane); }

function applyLane(lane, v, eng = engine, lk = looks) {
  if (lane.startsWith('look.')) { const [, l, k] = lane.split('.'); if (lk[l] && JSON.stringify(lk[l][k]) !== JSON.stringify(v)) lk[l][k] = v; return; }
  if (eng.P[lane] !== v) eng.dispatch({ k: 'set', p: lane, v });
}
function applyAutomation(f, eng = engine, lk = looks, au = auto) {
  for (const [lane, v] of au.valuesAt(f)) applyLane(lane, v, eng, lk);
  for (const a of au.eventsAt(f)) { eng.dispatch(a); if (eng === engine && a.k === 'preset') { presetNo = a.n; } }
}

// ---------------------------------------------------------------- presets
function userPresets() { try { return JSON.parse(localStorage.getItem('cvi84.user') || '{}'); } catch { return {}; } }
function saveUserPresets(u) { try { localStorage.setItem('cvi84.user', JSON.stringify(u)); } catch { toast('This browser blocked saving presets.'); } }
function presetFor(n) {
  const u = userPresets()[n];
  if (u) return { name: u.name, p: u.p, enter: [] };
  return presetState(n);
}
function loadPreset(n, touched = true) {
  const st = presetFor(n);
  if (!st) { toast(`Preset ${String(n).padStart(2, '0')} is empty`); return; }
  presetNo = n; if (touched) presetTouched = true;
  act({ k: 'preset', n, state: { p: st.p, enter: st.enter } });
  toast(`${String(n).padStart(2, '0')} ${st.name}`);
}
function saveCurrentPreset() {
  const u = userPresets();
  const name = (presetFor(presetNo) || {}).name || 'User preset';
  u[presetNo] = { name: name.startsWith('User: ') ? name : 'User: ' + name, p: { ...engine.P } };
  saveUserPresets(u);
  toast(`Saved into preset ${String(presetNo).padStart(2, '0')}`);
}

// ---------------------------------------------------------------- transport + time
function duration() { return src.v1 ? src.v1.el.duration || 0 : 0; }
function curTime() { return src.v1 ? src.v1.el.currentTime : 0; }
function syncFieldToTime(t) { engine.field = Math.floor(t * fieldRate + 1e-6); auto.seekEvents(engine.field); for (const [lane, v] of auto.valuesAt(engine.field)) applyLane(lane, v); uiDirty = true; }
function play() {
  if (!src.v1) { toast('Load a video to use the transport'); return; }
  const t = curTime();
  if (t < 1 / fieldRate) takeStartSnapshot();
  syncFieldToTime(t);
  playing = true;
  src.v1.el.play().catch((e) => { playing = false; toast(e.message); });
  if (src.v2) src.v2.el.play().catch(() => {});
  src.v1.el.requestVideoFrameCallback(onVideoFrame);
  uiDirty = true;
}
// The start state = everything as it was when the tape rolled from 0:00 (picture in the store, settings, looks).
// With automation recorded, Back-to-start and Export both begin from it, so they replay exactly what you performed.
function takeStartSnapshot() { engine.field = 0; startSnap = engine.snapshot(true); startSnap.field = 0; startSnap.looks = clone(looks); startSnap.presetNo = presetNo; }
function exportBase() {
  if (startSnap && !auto.isEmpty()) return startSnap;
  const s = engine.snapshot(true); s.looks = clone(looks); return s;
}
function pause() { playing = false; auto.releaseAll(); if (src.v1) src.v1.el.pause(); uiDirty = true; }
function seek(t) {
  if (!src.v1) return;
  t = Math.max(0, Math.min(duration() || 0, t));
  src.v1.el.currentTime = t;
  syncFieldToTime(t);
}
function home() {
  seek(0);
  if (startSnap) {
    const full = !auto.isEmpty();
    engine.restore({ ...startSnap, P: full ? startSnap.P : null });
    if (full) { looks = clone(startSnap.looks); presetNo = startSnap.presetNo; }
    syncFieldToTime(0);
  }
}
$('btnPlay').onclick = () => (playing ? pause() : play());
$('btnHome').onclick = home;
$('btnRec').onclick = () => { recArm = !recArm; if (!recArm) auto.releaseAll(); uiDirty = true; };
$('btnLoop').onclick = () => { loop = !loop; uiDirty = true; };
$('fieldRate').onchange = (e) => { fieldRate = +e.target.value; syncFieldToTime(curTime()); toast(`Field clock ${fieldRate} Hz`); };
$('btnClearAuto').onclick = () => { auto.clear(); uiDirty = true; toast('Automation cleared'); };

// advance the engine to media time t, one field at a time, playing back automation on the way
function advanceTo(t, inputs) {
  const target = Math.floor(t * fieldRate + 1e-6);
  if (target < engine.field - 2) { syncFieldToTime(t); }
  let steps = 0;
  while (engine.field <= target) {
    if (steps++ > 6) { engine.field = target; auto.seekEvents(target); }
    applyAutomation(engine.field);
    engine.step(inputs, audioAt(engine.field));
  }
}

function onVideoFrame(now, meta) {
  if (!playing) return;
  const inputs = grabInputs();
  advanceTo(meta.mediaTime, inputs);
  draw();
  uiDirty = true;
  src.v1.el.requestVideoFrameCallback(onVideoFrame);
}

// free-running when the tape is paused: the CVI keeps processing the held frame live
let lastTick = performance.now(), freeAcc = 0, demoT = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  if (!playing) {
    if (!src.v1) { demoT += dt; drawDemo(demoT); }
    freeAcc += dt * fieldRate;
    if (freeAcc >= 1) {
      const inputs = grabInputs();
      let n = Math.min(4, Math.floor(freeAcc)); freeAcc -= Math.floor(freeAcc);
      while (n--) engine.step(inputs, audioAt(engine.field));
      if (src.v1) engine.field = Math.floor(curTime() * fieldRate); // keep the clock pinned to the tape position
    }
    draw();
  }
  if (uiDirty) { uiDirty = false; syncUI(); }
  drawOverlay();
  drawTimeline();
  requestAnimationFrame(tick);
}

function draw() {
  const P = engine.P;
  const ana = P.anaSrc && v2Source() ? v2Source() : v1Source();
  if (renderer.w === 0) fitPreview();
  renderer.uploadAnalog(ana);
  renderer.uploadView(engine.view, N);
  renderer.render(looks, engine.field, P.blanking);
}

// ---------------------------------------------------------------- pad (the monitor is the graphics tablet)
let padDown = false, hover = null;
function padPos(e) { const r = screenEl.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; }
const drawing = () => drawHeld || engine.P.drawLock;
screenEl.addEventListener('pointerdown', (e) => {
  if (menuOpen) return;
  const p = padPos(e); padDown = true; screenEl.setPointerCapture(e.pointerId);
  act({ k: 'pad', ph: 'down', x: p.x, y: p.y, draw: drawing() });
});
screenEl.addEventListener('pointermove', (e) => {
  hover = padPos(e);
  if (!padDown || menuOpen) return;
  act({ k: 'pad', ph: 'move', x: hover.x, y: hover.y, draw: drawing() });
});
const padUp = (e) => { if (!padDown) return; padDown = false; const p = padPos(e); act({ k: 'pad', ph: 'up', x: p.x, y: p.y, draw: drawing() }); };
screenEl.addEventListener('pointerup', padUp);
screenEl.addEventListener('pointercancel', padUp);
screenEl.addEventListener('pointerleave', () => { hover = null; });

function drawOverlay() {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  const o = engine.overlay;
  octx.strokeStyle = '#fff'; octx.lineWidth = Math.max(1, h / 300); octx.setLineDash([6, 4]);
  if (o) {
    const x0 = o.x0 * w, y0 = o.y0 * h, x1 = o.x1 * w, y1 = o.y1 * h;
    octx.beginPath();
    if (o.m === 2) { octx.moveTo(x0, y0); octx.lineTo(x1, y1); }
    else if (o.m === 3) { octx.arc(x0, y0, Math.hypot(x1 - x0, (y1 - y0)), 0, 7); }
    else if (o.m === 4) { octx.ellipse((x0 + x1) / 2, (y0 + y1) / 2, Math.abs(x1 - x0) / 2, Math.abs(y1 - y0) / 2, 0, 0, 7); }
    else octx.rect(x0, y0, x1 - x0, y1 - y0);
    octx.stroke();
  }
  octx.setLineDash([]);
  if (hover && !menuOpen && (drawing() || engine.pickArmed || engine.titleArmed)) {
    const cx = Math.floor(hover.x * N) / N * w, cy = Math.floor(hover.y * N) / N * h;
    octx.strokeStyle = engine.pickArmed ? '#ffb02e' : '#fff';
    octx.beginPath(); octx.moveTo(cx - 10, cy); octx.lineTo(cx + 10, cy); octx.moveTo(cx, cy - 10); octx.lineTo(cx, cy + 10); octx.stroke();
  }
}

// ---------------------------------------------------------------- console: faders
const FADERS = [
  ['hue', 'Hue', '--cap-hsv', 'fg1'], ['sat', 'Sat', '--cap-hsv', 'fg1'], ['val', 'Value', '--cap-hsv', 'fg1'], ['depth', 'Colour depth', '--cap-hsv', 'fg1', 1],
  ['rate1', 'Rate 1', '--cap-rate', 'fg2'], ['rate2', 'Rate 2', '--cap-rate', 'fg2'],
  ['hpan', 'H pan', '--cap-geo', 'fg3', 1], ['vpan', 'V pan', '--cap-geo', 'fg3', 1], ['stretch', 'Stretch', '--cap-geo', 'fg3', 1], ['zoom', 'Zoom', '--cap-geo', 'fg3'],
];
const faderEls = {};
for (const [p, label, cap, group, bipolar] of FADERS) {
  const el = document.createElement('div'); el.className = 'fader';
  el.innerHTML = `<output>000</output><div class="track" tabindex="0" role="slider" aria-label="${label}" aria-valuemin="0" aria-valuemax="255">${Array.from({ length: 11 }, (_, i) => `<i class="tick${i === 5 && bipolar ? ' mid' : ''}" style="top:${6 + i * 13.8}px"></i>`).join('')}<div class="cap" style="--cap:var(${cap})"></div></div><label>${label}</label>`;
  $(group).appendChild(el);
  const track = el.querySelector('.track');
  const setFromY = (clientY) => { const r = track.getBoundingClientRect(); const v = Math.round((1 - (clientY - r.top - 8) / (r.height - 16)) * 255); setParam(p, Math.max(0, Math.min(255, v))); };
  track.addEventListener('pointerdown', (e) => { track.setPointerCapture(e.pointerId); setFromY(e.clientY); });
  track.addEventListener('pointermove', (e) => { if (track.hasPointerCapture(e.pointerId)) setFromY(e.clientY); });
  track.addEventListener('pointerup', () => releaseLane(p));
  track.addEventListener('dblclick', () => { setParam(p, bipolar ? 128 : p === 'zoom' ? 0 : engine.P[p]); releaseLane(p); });
  track.addEventListener('keydown', (e) => {
    const d = { ArrowUp: 1, ArrowDown: -1, PageUp: 16, PageDown: -16 }[e.key];
    if (d) { e.preventDefault(); e.stopPropagation(); setParam(p, Math.max(0, Math.min(255, engine.P[p] + d))); }
  });
  track.addEventListener('keyup', () => releaseLane(p));
  faderEls[p] = { el, cap: el.querySelector('.cap'), out: el.querySelector('output'), track };
}

// ---------------------------------------------------------------- console: the sixteen buttons
const BUTTONS = [
  ['FREEZE', 'freeze'], ['PRESET', 'preset'], ['MENU', 'menu'], ['STOP', 'stop'], ['DRAW', 'draw'], ['DRAW LOCK', 'drawLock'],
  ['COLOURIZE', 'colourize', 0], ['DRAW COLOUR', 'drawColour', 1], ['DRAW STENCIL', 'drawStencil', 2], ['USE TEXTURE', 'useTexture', 3], ['WIPE COLOUR', 'wipeColour', 4], ['WIPE STENCIL', 'wipeStencil', 5],
  ['PICK COLOUR', 'pick', 6], ['TITLE', 'title', 7], ['USE STENCIL', 'useStencil', 8], ['INVERT STENCIL', 'invertStencil', 9],
];
const btnEls = {};
for (const [label, id, num] of BUTTONS) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'hb' + (id === 'stop' ? ' red' : '');
  b.innerHTML = (num != null ? `<span class="num">${num}</span>` : '') + label;
  if (id === 'draw') {
    b.addEventListener('pointerdown', () => { drawHeld = true; b.classList.add('held'); uiDirty = true; });
    const up = () => { drawHeld = false; b.classList.remove('held'); uiDirty = true; };
    b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up);
    b.addEventListener('click', () => { if (menuOpen) menuStep(-1); });
  } else b.addEventListener('click', () => buttonPress(id, num));
  $('btns').appendChild(b); btnEls[id] = b;
}
function digit(d) {
  if (presetEntry !== null) {
    presetEntry += d;
    if (presetEntry.length === 2) { const n = +presetEntry; presetEntry = null; loadPreset(n); }
    uiDirty = true; return;
  }
  if (menuOpen) { menuDigit(d); return; }
  const id = BUTTONS.find((b) => b[2] === d)[1];
  if (['wipeColour', 'wipeStencil', 'pick', 'title'].includes(id)) press(id);
  else setParam(id, engine.P[id] ? 0 : 1);
}
function buttonPress(id, num) {
  if (num != null) { digit(num); return; }
  switch (id) {
    case 'freeze':
      if (presetEntry !== null) { presetEntry = null; saveCurrentPreset(); }
      else press('freeze');
      break;
    case 'preset': presetEntry = presetEntry === null ? '' : null; break;
    case 'menu': menuOpen = !menuOpen; break;
    case 'stop':
      if (presetEntry !== null) presetEntry = null;
      else if (menuOpen) menuOpen = false;
      else press('stop');
      break;
    case 'drawLock':
      if (menuOpen) menuStep(1); else setParam('drawLock', engine.P.drawLock ? 0 : 1);
      break;
  }
  uiDirty = true;
}

// ---------------------------------------------------------------- menus (white-on-blue pages)
const PAGE_ORDER = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9'];
const SCREEN_KEYS = ['vmirror', 'hmirror', 'hwipe', 'vwipe', 'shatter', 'panpen', 'glide', 'slide'];
const single = (title, key, items, base = 0) => ({ title, key, items, base });
const PAGES = {
  P0: single('PAINT 0  PAINT METHOD', 'paintMethod', MENUS.paintMethod),
  P1: single('PAINT 1  BRUSH SHAPE', 'brush', MENUS.brush),
  P2: single('PAINT 2  PAINT TYPE', 'paintType', MENUS.paintType),
  P3: { title: 'PAINT 3  TEXTURES', custom: pageTextures },
  P4: { title: 'PAINT 4  COLOUR CONTROL', custom: pageColourCtl },
  P5: single('PAINT 5  COLOUR TYPE', 'colourType', MENUS.colourType),
  P6: single('PAINT 6  SYMMETRY', 'symmetry', MENUS.symmetry),
  P7: { title: 'PAINT 7  COLOUR WIPES', custom: () => pageWipe('colourWipe', MENUS.colourWipe, 'WIPE COLOUR (4)', 'wipeColour') },
  P8: { title: 'PAINT 8  STENCIL WIPES', custom: () => pageWipe('stencilWipe', MENUS.stencilWipe, 'WIPE STENCIL (5)', 'wipeStencil') },
  P9: { title: 'PAINT 9  TITLE EDIT', custom: pageTitle },
  V0: single('VIDEO 0  DISPLAY CONTROL', 'display', DISPLAY.slice(1).map((d) => d[0]), 1),
  V1: { title: 'VIDEO 1  STENCIL SOURCE', custom: pageStencilSource },
  V2: { title: 'VIDEO 2  SCREEN CONTROL', toggles: SCREEN_KEYS, items: MENUS.screen },
  V3: single('VIDEO 3  FREEZE CONTROL', 'freezeMode', MENUS.freezeMode),
  V4: single('VIDEO 4  COLOURIZE CONTROL', 'colourizeCtl', MENUS.colourizeCtl),
  V5: single('VIDEO 5  COLOURIZE TYPE', 'colourizeType', MENUS.colourizeType),
  V6: { title: 'VIDEO 6  PRESETS', custom: pagePresets },
  V7: { title: 'VIDEO 7  SEQUENCER', custom: pageSequencer },
  V8: { title: 'VIDEO 8  SAVE & RECALL', custom: pageSave },
  V9: { title: 'VIDEO 9  SETUP', custom: pageSetup },
};
const menuEl = $('menu');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function itemBtn(label, on, data) { return `<button type="button" class="it${on ? ' on' : ''}" ${data}>${esc(label)}</button>`; }
let lastMenuHTML = '';
function renderMenu() {
  menuEl.hidden = !menuOpen;
  if (!menuOpen) { lastMenuHTML = ''; return; }
  if (menuEl.contains(document.activeElement) && document.activeElement.matches('input, textarea, select')) return;
  const pg = PAGES[menuPage], P = engine.P;
  let body = '';
  if (pg.custom) body = pg.custom();
  else if (pg.toggles) body = `<div class="items">${pg.items.map((n, i) => itemBtn(`${i} ${n}`, P[pg.toggles[i]], `data-tog="${pg.toggles[i]}"`)).join('')}</div>`;
  else body = `<div class="items">${pg.items.map((n, i) => itemBtn(`${String(i + pg.base).padStart(2, ' ')} ${n}`, P[pg.key] === i + pg.base, `data-set="${pg.key}" data-v="${i + pg.base}"`)).join('')}</div>`;
  const qs = (row) => PAGE_ORDER.filter((p) => p[0] === row).map((p) => `<button type="button" data-page="${p}" class="${p === menuPage ? 'on' : ''}">${p[1]}</button>`).join('');
  const html = `<h2>${pg.title}</h2>${body}<div class="qs"><span>PAINT</span>${qs('P')}<span>VIDEO</span>${qs('V')}</div>`;
  if (html !== lastMenuHTML) { menuEl.innerHTML = html; lastMenuHTML = html; }
}
menuEl.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.page) { menuPage = b.dataset.page; }
  else if (b.dataset.set) { setParam(b.dataset.set, isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v); releaseLane(b.dataset.set); if (b.dataset.set === 'display') presetTouched = true; }
  else if (b.dataset.tog) { setParam(b.dataset.tog, engine.P[b.dataset.tog] ? 0 : 1); releaseLane(b.dataset.tog); }
  else if (b.dataset.fire) press(b.dataset.fire);
  else if (b.dataset.preset) { loadPreset(+b.dataset.preset); }
  else if (b.dataset.act) menuAction(b.dataset.act, b.dataset);
  uiDirty = true;
});
menuEl.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.set) setParam(t.dataset.set, t.type === 'range' ? +t.value : t.value);
});
menuEl.addEventListener('change', (e) => { const t = e.target; if (t.dataset.set) { releaseLane(t.dataset.set); uiDirty = true; } });
function menuStep(d) { const i = PAGE_ORDER.indexOf(menuPage); menuPage = PAGE_ORDER[(i + d + PAGE_ORDER.length) % PAGE_ORDER.length]; uiDirty = true; }
function menuDigit(d) {
  const pg = PAGES[menuPage];
  if (pg.toggles) setParam(pg.toggles[d] || pg.toggles[0], engine.P[pg.toggles[d]] ? 0 : 1);
  else if (pg.key) { const v = pg.base === 1 ? (d === 0 ? 10 : d) : d; if (v - pg.base < pg.items.length) setParam(pg.key, v); }
  else if (menuPage === 'P3') setParam('texture', d);
  else if (menuPage === 'P4') setParam('colourCtl', Math.min(3, d));
  else if (menuPage === 'P7') setParam('colourWipe', Math.min(7, d));
  else if (menuPage === 'P8') setParam('stencilWipe', Math.min(8, d));
  else if (menuPage === 'V1') setParam('stencilSource', Math.min(3, d));
  uiDirty = true;
}
function pageTextures() {
  const P = engine.P;
  const sw = (i) => { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'); const im = x.createImageData(32, 32); for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) { const v = texel(i, z, y) ? 255 : 31; const o = (y * 32 + z) * 4; im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255; } x.putImageData(im, 0, 0); return c.toDataURL(); };
  pageTextures.cache = pageTextures.cache || MENUS.texture.map((_, i) => sw(i));
  return `<div class="items wide">${MENUS.texture.map((n, i) => `<button type="button" class="it${P.texture === i ? ' on' : ''}" data-set="texture" data-v="${i}"><img src="${pageTextures.cache[i]}" alt="" width="22" height="22" style="vertical-align:middle;image-rendering:pixelated;margin-right:8px">${String(i).padStart(2, ' ')} ${esc(n)}</button>`).join('')}</div><p class="note">USE TEXTURE (3) paints only where the texture is set. Stencil wipe "Texture" and colour wipe "Texture" use this pattern too.</p>`;
}
function pageColourCtl() {
  const P = engine.P;
  const t = (k, on, off) => itemBtn(`${P[k] ? on : off}`, P[k], `data-tog="${k}"`);
  return `<div class="items" style="grid-template-rows:repeat(4,auto)">${MENUS.colourCtl.map((n, i) => itemBtn(`${i} ${n}`, P.colourCtl === i, `data-set="colourCtl" data-v="${i}"`)).join('')}</div>
  <div class="row">${t('stencilErase', 'STENCIL: ERASE', 'STENCIL: DRAW')}${t('stencilShow', 'STENCIL: SHOW', 'STENCIL: HIDE')}${t('drawUnder', 'DRAW: UNDER', 'DRAW: OVER')}${t('dejag', 'DEJAG: ON', 'DEJAG: OFF')}</div>`;
}
function pageWipe(key, items, btnLabel, fire) {
  const P = engine.P;
  return `<div class="items">${items.map((n, i) => itemBtn(`${i} ${n}`, P[key] === i, `data-set="${key}" data-v="${i}"`)).join('')}</div><div class="row"><button type="button" class="it on" data-fire="${fire}">RUN NOW — ${btnLabel}</button><button type="button" class="it" data-fire="stop">STOP</button></div>`;
}
function pageTitle() {
  const P = engine.P;
  return `<div class="row"><label>TEXT&nbsp;<textarea id="mTitle" rows="2" data-set="title" style="vertical-align:top">${esc(P.title)}</textarea></label></div>
  <div class="row">SIZE ${[1, 2, 3, 4, 5].map((s) => itemBtn(String(s), P.titleSize === s, `data-set="titleSize" data-v="${s}"`)).join('')}</div>
  <div class="items" style="grid-template-rows:repeat(6,auto)">${MENUS.titleFormat.map((n, i) => itemBtn(`${i} ${n}`, P.titleFormat === i, `data-set="titleFormat" data-v="${i}"`)).join('')}</div>
  <p class="note">Press TITLE (7), then click the monitor to stamp. DRAW COLOUR writes to the picture, DRAW STENCIL writes to the stencil.</p>`;
}
function pageStencilSource() {
  const P = engine.P;
  const pair = (k, a, b) => itemBtn(a, !P[k], `data-set="${k}" data-v="0"`) + itemBtn(b, !!P[k], `data-set="${k}" data-v="1"`);
  return `<div class="items" style="grid-template-rows:repeat(4,auto)">${MENUS.stencilSource.map((n, i) => itemBtn(`${i} ${n}`, P.stencilSource === i, `data-set="stencilSource" data-v="${i}"`)).join('')}</div>
  <div class="row">DIGITAL ← ${pair('digSrc', 'V1', 'V2')} &nbsp; ANALOG ← ${pair('anaSrc', 'V1', 'V2')} &nbsp; KEY ← ${pair('keySrc', 'V1', 'V2')}</div>
  <div class="row">KEY TYPE ${pair('keyMode', 'CHROMA (BLUE)', 'LUMINANCE')} &nbsp; ${itemBtn(P.keyInvert ? 'KEY INVERTED' : 'KEY NORMAL', P.keyInvert, 'data-tog="keyInvert"')}</div>
  <div class="row">BLANKING ${pair('blanking', 'NORMAL', 'EXTENDED')}</div>
  <p class="note">Key levels are on VIDEO 9 SETUP. USE STENCIL (8) must be lit for any stencil to split the screen.</p>`;
}
function pagePresets() {
  const u = userPresets();
  let s = '<div class="items wide">';
  for (let n = 0; n < 100; n++) {
    const name = u[n] ? u[n].name : FACTORY[n] ? FACTORY[n][0] : '—';
    s += itemBtn(`${String(n).padStart(2, '0')} ${name}`, presetNo === n, `data-preset="${n}"`);
  }
  s += '</div><div class="row">';
  s += `<button type="button" class="it" data-act="savePreset">SAVE CURRENT INTO ${String(presetNo).padStart(2, '0')}</button>`;
  if (u[presetNo]) s += `<button type="button" class="it" data-act="factoryPreset">RESTORE FACTORY ${String(presetNo).padStart(2, '0')}</button>`;
  return s + '</div>';
}
function pageSequencer() {
  const lanes = auto.lanes.size, evs = auto.events.length;
  return `<p class="note">The sequencer records gestures, not pictures, like the original. Arm ● REC under the monitor and play the video: fader moves, buttons, menu choices, presets, wipes and paint strokes are written to the timeline against the tape. Export replays them exactly.</p>
  <p class="note">Now holding ${lanes} automation lane${lanes === 1 ? '' : 's'} and ${evs} event${evs === 1 ? '' : 's'}.</p>
  <div class="row">${itemBtn(recArm ? '● RECORD ARMED' : 'ARM RECORD', recArm, 'data-act="rec"')}${itemBtn('CLEAR ALL', false, 'data-act="clearAuto"')}</div>`;
}
function pageSave() {
  return `<p class="note">The original saved to video tape in about three and a half minutes. This saves a project file with every setting, the looks, your automation and the field store picture.</p>
  <div class="row">${itemBtn('SAVE PROJECT FILE', false, 'data-act="saveProj"')}${itemBtn('RECALL PROJECT FILE', false, 'data-act="openProj"')}</div>`;
}
function pageSetup() {
  const P = engine.P;
  const rng = (k, label, max = 255) => `<label class="row">${label}&nbsp;<input type="range" min="0" max="${max}" value="${P[k]}" data-set="${k}">&nbsp;${String(P[k]).padStart(3, '0')}</label>`;
  return `${rng('keyHue', 'KEY HUE', 360)}${rng('keyTol', 'KEY RANGE')}${rng('keySat', 'KEY MIN SAT')}${rng('keyLuma', 'LUMA LEVEL')}
  <div class="row">${itemBtn('COLOUR BARS', false, 'data-act="bars"')}${itemBtn('TEST PATTERN', false, 'data-act="test"')}${itemBtn('PICK KEY COLOUR', false, 'data-act="pickKey"')}${itemBtn('CLEAR STORE', false, 'data-act="clearStore"')}</div>
  <p class="note">Default key is blue. PICK KEY COLOUR then click the monitor on the backdrop.</p>`;
}
let pickKey = false;
function menuAction(a) {
  switch (a) {
    case 'savePreset': saveCurrentPreset(); break;
    case 'factoryPreset': { const u = userPresets(); delete u[presetNo]; saveUserPresets(u); toast('Factory preset restored'); break; }
    case 'rec': recArm = !recArm; break;
    case 'clearAuto': auto.clear(); break;
    case 'saveProj': saveProject(); break;
    case 'openProj': $('fileProj').click(); break;
    case 'bars': act({ k: 'pattern', v: 'bars' }); break;
    case 'test': act({ k: 'pattern', v: 'test' }); break;
    case 'clearStore': act({ k: 'storeFill', c: [0, 0, 0] }); break;
    case 'pickKey': pickKey = true; menuOpen = false; toast('Click the backdrop colour'); break;
  }
}
screenEl.addEventListener('pointerdown', (e) => {
  if (!pickKey) return;
  pickKey = false;
  const p = padPos(e);
  const inp = grabInputs().v1, i = ((Math.floor(p.y * N) * N) + Math.floor(p.x * N)) * 4;
  const r = inp[i] / 255, g = inp[i + 1] / 255, b = inp[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0; if (d) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; }
  setParam('keyHue', Math.round(h)); setParam('keyMode', 0);
  toast(`Key hue ${Math.round(h)}°`);
}, true);

// ---------------------------------------------------------------- looks rack
const LOOK_UI = {
  bw: { title: 'Black & white', sub: 'Film stock, grain, toning', ctl: [
    ['mode', 'Filter', 'sel', ['Neutral', 'Red filter', 'Green filter', 'Blue (ortho)']], ['contrast', 'Contrast', 0.4, 2.5, 0.01], ['bright', 'Brightness', -0.5, 0.5, 0.01], ['gamma', 'Gamma', 0.4, 2.2, 0.01],
    ['grain', 'Grain', 0, 0.6, 0.01], ['grainSize', 'Grain size', 1, 5, 0.1], ['tintAmt', 'Toning', 0, 1, 0.01], ['tintHue', 'Tone hue', 0, 1, 0.005], ['vignette', 'Vignette', 0, 1, 0.01]] },
  halftone: { title: 'Halftone', sub: 'Print screen dots', ctl: [
    ['style', 'Screen', 'sel', ['Mono', 'CMYK', 'Colour dots']], ['shape', 'Dot', 'sel', ['Round', 'Lines', 'Squares']], ['cell', 'Cell size', 3, 32, 0.5], ['angle', 'Angle', 0, 90, 1],
    ['contrast', 'Contrast', 0.4, 2.5, 0.01], ['ink', 'Ink', 'col'], ['paper', 'Paper', 'col'], ['mixAmt', 'Mix', 0, 1, 0.01]] },
  vhs: { title: 'VHS', sub: 'Tape, tracking, chroma bleed', ctl: [
    ['chromaBlur', 'Chroma blur', 0.3, 8, 0.1], ['chromaShift', 'Chroma delay', 0, 6, 0.1], ['bleed', 'Colour bleed', 0, 1, 0.01], ['sat', 'Saturation', 0, 2, 0.01],
    ['soft', 'Softness', 0.3, 3, 0.05], ['sharpen', 'Ringing', 0, 2, 0.01], ['noise', 'Snow', 0, 1, 0.01], ['tracking', 'Tracking', 0, 1, 0.01],
    ['jitter', 'Line jitter', 0, 1, 0.01], ['headSwitch', 'Head switch', 0, 1, 0.01], ['dropouts', 'Dropouts', 0, 1, 0.01], ['wear', 'Tape wear', 0, 1, 0.01]] },
  crt: { title: 'CRT', sub: 'Tube, scanlines, phosphor mask', ctl: [
    ['curv', 'Curvature', 0, 1.5, 0.01], ['scan', 'Scanlines', 0, 1, 0.01], ['lines', 'Line count', 120, 1080, 2], ['maskType', 'Mask', 'sel', ['None', 'Aperture grille', 'Shadow mask', 'Slot mask']],
    ['maskAmt', 'Mask strength', 0, 1, 0.01], ['bloom', 'Glow', 0, 1.5, 0.01], ['converge', 'Convergence', 0, 4, 0.05], ['persist', 'Persistence', 0, 0.9, 0.01],
    ['vignette', 'Vignette', 0, 1, 0.01], ['bright', 'Brightness', 0.5, 2, 0.01], ['flicker', 'Flicker', 0, 1, 0.01], ['cornerR', 'Corners', 0, 0.2, 0.005], ['interlace', 'Interlace', 'sel', ['Off', 'On']]] },
};
const lookEls = {};
const hex = (c) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
const unhex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function buildLooks() {
  const host = $('looks');
  host.innerHTML = '';
  for (const k of ['bw', 'halftone', 'vhs', 'crt']) {
    const spec = LOOK_UI[k];
    const sec = document.createElement('section'); sec.className = 'look closed';
    let rows = '';
    for (const [key, label, a, b, step] of spec.ctl) {
      const id = `lk-${k}-${key}`;
      if (a === 'sel') rows += `<label class="knob" data-k="${key}"><span>${label}</span><select id="${id}">${b.map((o, i) => `<option value="${i}">${o}</option>`).join('')}</select></label>`;
      else if (a === 'col') rows += `<label class="knob" data-k="${key}"><span>${label}</span><input type="color" id="${id}"></label>`;
      else rows += `<label class="knob" data-k="${key}"><span>${label}</span><input type="range" id="${id}" min="${a}" max="${b}" step="${step}"><output></output></label>`;
    }
    sec.innerHTML = `<header><button type="button" class="pwr" role="switch" aria-checked="false" aria-label="${spec.title} on/off"></button><h3>${spec.title}</h3><small>${spec.sub}</small></header><div class="body">${rows}</div>`;
    host.appendChild(sec);
    const pwr = sec.querySelector('.pwr');
    pwr.addEventListener('click', (e) => { e.stopPropagation(); setLook(k, 'on', looks[k].on ? 0 : 1); auto.release(`look.${k}.on`); if (looks[k].on) sec.classList.remove('closed'); });
    sec.querySelector('header').addEventListener('click', () => sec.classList.toggle('closed'));
    for (const el of sec.querySelectorAll('.knob')) {
      const key = el.dataset.k, inp = el.querySelector('input, select');
      const lane = `look.${k}.${key}`;
      inp.addEventListener('input', () => setLook(k, key, inp.type === 'color' ? unhex(inp.value) : +inp.value));
      inp.addEventListener('change', () => auto.release(lane));
      inp.addEventListener('pointerup', () => auto.release(lane));
    }
    lookEls[k] = sec;
  }
  const note = document.createElement('p'); note.className = 'hint'; note.textContent = 'Signal path: CVI → Black & white → Halftone → VHS → CRT. Every knob here can be recorded too.';
  host.appendChild(note);
}
buildLooks();

// ---------------------------------------------------------------- UI sync
function syncUI() {
  const P = engine.P;
  for (const p of SLIDERS) {
    const f = faderEls[p]; const v = P[p];
    f.cap.style.top = `${8 + (1 - v / 255) * (f.track.clientHeight - 16)}px`;
    f.out.textContent = String(Math.round(v)).padStart(3, '0');
    f.track.setAttribute('aria-valuenow', Math.round(v));
    f.el.classList.toggle('auto', auto.lanes.has(p));
  }
  const lit = {
    freeze: P.freezeMode === 3 || P.freezeMode === 5 ? engine.singlePending : !!P.freeze,
    preset: presetEntry !== null, menu: menuOpen, draw: drawHeld, drawLock: !!P.drawLock,
    colourize: !!P.colourize, drawColour: !!P.drawColour, drawStencil: !!P.drawStencil, useTexture: !!P.useTexture,
    wipeColour: engine.procs.some((p) => p.t[0] === 'c' || p.t === 'tunnel'), wipeStencil: engine.procs.some((p) => p.t[0] === 's'),
    pick: engine.pickArmed, title: engine.titleArmed, useStencil: !!P.useStencil, invertStencil: !!P.invertStencil, stop: false,
  };
  for (const id in btnEls) btnEls[id].classList.toggle('lit', !!lit[id]);
  for (const k in lookEls) {
    const sec = lookEls[k];
    sec.querySelector('.pwr').setAttribute('aria-checked', looks[k].on ? 'true' : 'false');
    for (const el of sec.querySelectorAll('.knob')) {
      const key = el.dataset.k, inp = el.querySelector('input, select'), v = looks[k][key];
      if (document.activeElement !== inp) inp.value = inp.type === 'color' ? hex(v) : v;
      const o = el.querySelector('output'); if (o) o.textContent = (+v).toFixed(+inp.step >= 1 ? 0 : 2);
      el.classList.toggle('auto', auto.lanes.has(`look.${k}.${key}`));
    }
  }
  const pn = presetFor(presetNo);
  $('presetName').textContent = `${String(presetNo).padStart(2, '0')} ${pn ? pn.name : ''}`;
  $('dispName').textContent = `${P.display} ${DISPLAY[P.display][0]}`;
  $('btnRec').classList.toggle('armed', recArm);
  $('btnLoop').classList.toggle('on', loop);
  $('playIcon').innerHTML = playing ? '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>' : '<path d="M3 2l11 6-11 6z"/>';
  // OSD
  const osd = $('osd');
  let txt = '';
  if (menuOpen) txt = '';
  else if (presetEntry !== null) txt = `PRESET ${presetEntry.padEnd(2, '_')}`;
  else if (engine.pickArmed) txt = 'PICK COLOUR';
  else if (pickKey) txt = 'PICK KEY COLOUR';
  else if (engine.titleArmed) txt = 'TITLE: CLICK TO STAMP';
  else if (performance.now() < toastUntil) txt = toastMsg;
  else if (recording()) txt = 'REC';
  osd.textContent = txt;
  osd.classList.toggle('rec', recording() && txt === 'REC');
  renderMenu();
}
function toast(m) { toastMsg = m.toUpperCase(); toastUntil = performance.now() + 2200; uiDirty = true; setTimeout(() => { uiDirty = true; }, 2300); }

// ---------------------------------------------------------------- timeline
const tl = $('timeline'), tctx = tl.getContext('2d');
const LABEL_W = 132, RULER_H = 22, ROW_H = 18;
function laneList() { const l = [...auto.lanes.keys()]; if (auto.events.length) l.push('#events'); return l; }
function laneLabel(l) {
  if (l === '#events') return 'Buttons / paint / presets';
  if (l.startsWith('look.')) { const [, k, key] = l.split('.'); const c = LOOK_UI[k].ctl.find((c) => c[0] === key); return `${LOOK_UI[k].title}: ${c ? c[1] : key}`; }
  const f = FADERS.find((f) => f[0] === l); return f ? f[1] : l;
}
function drawTimeline() {
  const lanes = laneList();
  const cssH = Math.max(150, RULER_H + 8 + lanes.length * ROW_H + 8);
  const dpr = window.devicePixelRatio || 1, cssW = tl.clientWidth;
  if (tl.width !== Math.round(cssW * dpr) || tl.height !== Math.round(cssH * dpr)) { tl.style.height = cssH + 'px'; tl.width = Math.round(cssW * dpr); tl.height = Math.round(cssH * dpr); }
  const g = tctx; g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#111214'; g.fillRect(0, 0, cssW, cssH);
  const dur = duration(), W = cssW - LABEL_W - 8;
  const X = (t) => LABEL_W + (dur ? t / dur : 0) * W;
  g.font = '12px Barlow, sans-serif'; g.textBaseline = 'middle';
  // ruler
  g.fillStyle = '#1c1e22'; g.fillRect(0, 0, cssW, RULER_H);
  if (dur) {
    const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((s) => (W / dur) * s > 60) || 600;
    g.fillStyle = '#8b877d';
    for (let t = 0; t <= dur; t += step) { const x = X(t); g.fillRect(x, RULER_H - 6, 1, 6); g.fillText(fmtShort(t), x + 3, RULER_H / 2); }
  } else { g.fillStyle = '#8b877d'; g.fillText('Load a video to record automation against it', LABEL_W, RULER_H / 2); }
  // lanes
  lanes.forEach((lane, i) => {
    const y = RULER_H + 8 + i * ROW_H;
    g.fillStyle = i % 2 ? '#15161a' : '#18191d'; g.fillRect(0, y, cssW, ROW_H);
    g.fillStyle = '#c9c3b4'; g.fillText(laneLabel(lane).slice(0, 19), 8, y + ROW_H / 2);
    g.fillStyle = '#ff8a80'; g.fillText('×', LABEL_W - 16, y + ROW_H / 2);
    if (!dur) return;
    if (lane === '#events') {
      g.fillStyle = '#6aa6d8';
      for (const e of auto.events) g.fillRect(X(e.f / fieldRate), y + 4, 2, ROW_H - 8);
      return;
    }
    const pts = auto.lanes.get(lane);
    const nums = pts.map((p) => (Array.isArray(p.v) ? p.v[0] : +p.v)).filter((v) => !isNaN(v));
    const lo = Math.min(0, ...nums), hi = Math.max(1, ...nums);
    const Y = (v) => y + ROW_H - 3 - ((+v - lo) / (hi - lo || 1)) * (ROW_H - 6);
    g.strokeStyle = '#ffb02e'; g.lineWidth = 1.5; g.beginPath();
    pts.forEach((p, j) => { const v = Array.isArray(p.v) ? p.v[0] : p.v; const x = X(p.f / fieldRate); if (j === 0) g.moveTo(LABEL_W, Y(v)); g.lineTo(x, j ? Y(pts[j - 1].v) : Y(v)); g.lineTo(x, Y(v)); });
    g.lineTo(LABEL_W + W, Y(pts[pts.length - 1].v)); g.stroke();
  });
  if (dur) { const x = X(curTime()); g.fillStyle = recording() ? '#ff3b30' : '#fff'; g.fillRect(x, 0, 2, cssH); }
  $('tc').textContent = fmtTC(curTime());
}
const fmtShort = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function fmtTC(t) { const f = Math.floor((t % 1) * fieldRate / 2); return [Math.floor(t / 3600), Math.floor(t / 60) % 60, Math.floor(t) % 60, f].map((v) => String(v).padStart(2, '0')).join(':'); }
let scrubbing = false;
tl.addEventListener('pointerdown', (e) => {
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (x < LABEL_W) {
    const i = Math.floor((y - RULER_H - 8) / ROW_H), lanes = laneList();
    if (i >= 0 && i < lanes.length && x > LABEL_W - 24) { auto.clearLane(lanes[i]); uiDirty = true; }
    return;
  }
  scrubbing = true; tl.setPointerCapture(e.pointerId);
  seek(((x - LABEL_W) / (r.width - LABEL_W - 8)) * duration());
});
tl.addEventListener('pointermove', (e) => { if (!scrubbing) return; const r = tl.getBoundingClientRect(); seek(((e.clientX - r.left - LABEL_W) / (r.width - LABEL_W - 8)) * duration()); });
tl.addEventListener('pointerup', () => { scrubbing = false; });

// ---------------------------------------------------------------- keyboard
const heldKeys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.matches && e.target.matches('input, textarea, select') && e.target.type !== 'range') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (/^[0-9]$/.test(k)) { digit(+k); e.preventDefault(); return; }
  switch (k.toLowerCase()) {
    case ' ': e.preventDefault(); playing ? pause() : play(); break;
    case 'd': if (!heldKeys.has('d')) { drawHeld = true; uiDirty = true; } break;
    case 'f': buttonPress('freeze'); break;
    case 'p': buttonPress('preset'); break;
    case 'm': buttonPress('menu'); break;
    case 'escape': buttonPress('stop'); break;
    case 'r': recArm = !recArm; if (!recArm) auto.releaseAll(); uiDirty = true; break;
    case 'arrowleft': if (menuOpen) menuStep(-1); else seek(curTime() - 1); break;
    case 'arrowright': if (menuOpen) menuStep(1); else seek(curTime() + 1); break;
  }
  heldKeys.add(k.toLowerCase());
});
window.addEventListener('keyup', (e) => { const k = e.key.toLowerCase(); heldKeys.delete(k); if (k === 'd') { drawHeld = false; uiDirty = true; } });

// ---------------------------------------------------------------- save / open project
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function saveProject() {
  const snap = exportBase();
  const proj = {
    app: 'CVI-84', version: 1, fieldRate, presetNo, params: engine.P, looks, automation: auto.toJSON(),
    start: { store: b64(snap.store), stencil: b64(snap.stencil), rng: snap.rng, params: snap.P, looks: snap.looks, presetNo: snap.presetNo ?? presetNo },
  };
  const blob = new Blob([JSON.stringify(proj)], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = (src.v1 ? src.v1.name.replace(/\.[^.]+$/, '') : 'cvi-84') + '.cvi84.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Project saved');
}
$('btnSave').onclick = saveProject;
$('fileProj').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (p.app !== 'CVI-84') throw new Error('Not a CVI-84 project file');
    fieldRate = p.fieldRate || 50; $('fieldRate').value = String(fieldRate);
    engine.P = { ...engine.P, ...p.params };
    looks = { ...clone(LOOK_DEFAULTS), ...p.looks };
    auto = Automation.fromJSON(p.automation || {});
    presetNo = p.presetNo ?? presetNo; presetTouched = true;
    if (p.start) {
      engine.store.set(unb64(p.start.store)); engine.stencil.set(unb64(p.start.stencil)); engine.rng.s = p.start.rng;
      startSnap = engine.snapshot(true); startSnap.field = 0;
      if (p.start.params) startSnap.P = { ...engine.P, ...p.start.params };
      startSnap.looks = p.start.looks ? { ...clone(LOOK_DEFAULTS), ...p.start.looks } : clone(looks);
      startSnap.presetNo = p.start.presetNo ?? presetNo;
    }
    syncFieldToTime(curTime());
    toast('Project recalled');
  } catch (err) { toast(err.message); }
  e.target.value = '';
};

// ---------------------------------------------------------------- export
const dlg = $('exportDlg');
let exporting = null;
$('btnExport').onclick = () => {
  if (!src.v1) { toast('Load a video first'); return; }
  $('exportMsg').textContent = auto.isEmpty() ? 'No automation recorded: the export uses the current settings for the whole clip.' : 'Renders the clip with your recorded automation, from the start.';
  $('exBar').style.width = '0';
  dlg.showModal();
};
$('exCancel').onclick = async () => { if (exporting) { await exporting.cancel().catch(() => {}); exporting = null; } dlg.close(); };
$('exGo').onclick = () => runExport().catch((e) => { $('exportMsg').innerHTML = `<span class="err">${esc(e.message || e)}</span>`; exporting = null; $('exGo').disabled = false; });

async function runExport() {
  pause();
  $('exGo').disabled = true;
  $('exportMsg').textContent = 'Preparing…';
  const MB = await import('./vendor/mediabunny.min.mjs');
  const input = new MB.Input({ source: new MB.BlobSource(src.v1.file), formats: MB.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  if (!vt) throw new Error('That file has no video track.');
  const sw = vt.displayWidth, sh = vt.displayHeight;
  const resSel = $('exRes').value;
  let h = resSel === 'src' ? sh : Math.min(+resSel, sh);
  let w = Math.round((h * sw / sh) / 2) * 2; h -= h % 2;
  const q = { high: MB.QUALITY_HIGH, vhigh: MB.QUALITY_VERY_HIGH, med: MB.QUALITY_MEDIUM }[$('exQ').value];
  if (!(await MB.canEncodeVideo('avc', { width: w, height: h }))) throw new Error('This browser cannot encode H.264 at that size. Try 720p, or use Chrome or Edge.');

  // a separate engine + renderer, reset to the start state, replaying the automation exactly
  const eng = new CVI(N);
  const base = exportBase();
  eng.restore(base); eng.field = 0;
  const lk = clone(base.looks);
  const au = Automation.fromJSON(clone(auto.toJSON()));
  const canvas = new OffscreenCanvas(w, h);
  const rend = new Renderer(canvas, N);
  rend.resize(w, h);
  const s1 = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true });
  const s2 = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true });
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
      forceTranscode: true, codec: 'avc', bitrate: q, processedWidth: w, processedHeight: h,
      process: async (sample) => {
        if (t0 === null) t0 = sample.timestamp;
        const t = sample.timestamp - t0;
        sample.draw(s1, 0, 0, N, N);
        const inputs = { v1: s1.getImageData(0, 0, N, N).data, v2: null };
        let s2sample = null;
        if (sink2) {
          s2sample = await sink2.getSample(t % v2dur);
          if (s2sample) { s2sample.draw(s2, 0, 0, N, N); inputs.v2 = s2.getImageData(0, 0, N, N).data; }
        }
        const target = Math.floor(t * fieldRate + 1e-6);
        while (eng.field <= target) { applyAutomation(eng.field, eng, lk, au); eng.step(inputs, audioAt(eng.field)); }
        if (eng.P.anaSrc && s2sample) { const c = v2canvas.getContext('2d'); s2sample.draw(c, 0, 0, v2canvas.width, v2canvas.height); rend.uploadAnalog(v2canvas); }
        else { const vf = sample.toVideoFrame(); rend.uploadAnalog(vf); vf.close(); }
        if (s2sample) s2sample.close();
        rend.uploadView(eng.view, N);
        rend.render(lk, eng.field, eng.P.blanking);
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
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  $('exGo').disabled = false;
}

// ---------------------------------------------------------------- go
loadPreset(59, false); // demo opens on TRAIL: the subject leaves copies of itself on the blue key
drawDemo(0);
fitPreview();
window.addEventListener('resize', () => { uiDirty = true; });
requestAnimationFrame(tick);
window.__cvi = { engine, auto, get looks() { return looks; }, loadPreset, setParam, setLook, play, pause, seek, loadVideo, runExport };
