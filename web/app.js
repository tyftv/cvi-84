import { MENUS, texel, CVI } from './cvi-engine.js';
import { FACTORY, presetState } from './presets.js';
import { Renderer, LOOK_DEFAULTS } from './gl.js';
import { Automation } from './automation.js';
import { probePlayable, convertToMp4, VIDEO_ACCEPT, looksLikeVideo } from './convert.js';
import { Chain, MODULES, CATEGORIES, renderChain } from './chain.js';

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ================================================================ state
const DETAIL = [256, 360, 480]; // short side of every CVI unit's field store: original, fine, extra fine
const settings = { detail: 0, smooth: 0, blanking: 0 };
let chain = new Chain(341, 256);
let selected = null; // block id, or null = project settings
let auto = new Automation();
let fieldRate = 50;
let playing = false, recArm = false, loop = false;
let startSnap = null;
let uiDirty = true, inspDirty = true, stripDirty = true;
const src = { v1: null, v2: null };
const undoStack = [];
let curFrameTex = null;

const screenEl = $('screen'), outCanvas = $('out'), overlay = $('overlay'), octx = overlay.getContext('2d');
let renderer;
try { renderer = new Renderer(outCanvas, 256); }
catch (e) { document.body.innerHTML = `<p class="err" style="padding:20px">This browser can't run CVI-84 (${esc(e.message)}). Use a current Chrome or Edge.</p>`; throw e; }
const demo = document.createElement('canvas'); demo.width = 640; demo.height = 480;

const selNode = () => (selected ? chain.get(selected) : null);
const selEngine = () => { const n = selNode(); return n ? chain.engine(n.id) : null; };
const cviNodes = () => chain.nodes.filter((n) => chain.kind(n) === 'cvi');

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

// ================================================================ sources + grid
const v1Source = () => (src.v1 && src.v1.el.readyState >= 2 ? src.v1.el : demo);
const v2Source = () => (src.v2 && src.v2.el.readyState >= 2 ? src.v2.el : null);
function srcDims() { const e = src.v1 && src.v1.el; return e && e.videoWidth ? [e.videoWidth, e.videoHeight] : [640, 480]; }
function gridFor(w, h, level) { const s = DETAIL[level] || 256; return w >= h ? [Math.round(s * w / h), s] : [s, Math.round(s * h / w)]; }
function rebuildGrid() {
  const [w, h] = gridFor(...srcDims(), settings.detail);
  if (!chain.resize(w, h)) return false;
  startSnap = null; undoStack.length = 0; uiDirty = true;
  return true;
}
let aspect = 4 / 3;
function fitPreview() {
  let [w, h] = srcDims();
  if (h > 720) { w = Math.round(w * 720 / h); h = 720; }
  w -= w % 2; h -= h % 2;
  renderer.resize(w, h); overlay.width = w; overlay.height = h;
  aspect = w / h; layoutScreen();
}
function layoutScreen() {
  const st = screenEl.parentElement, cs = getComputedStyle(st);
  const aw = st.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  let ah = st.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (window.innerWidth <= 860) ah = aw / aspect;
  let w = aw, hh = w / aspect;
  if (hh > ah) { hh = ah; w = hh * aspect; }
  screenEl.style.width = Math.max(100, Math.floor(w)) + 'px'; screenEl.style.height = Math.max(75, Math.floor(hh)) + 'px';
}
new ResizeObserver(layoutScreen).observe(screenEl.parentElement);

function setBusy(msg, p) { const b = $('busy'); if (msg == null) { b.hidden = true; return; } b.hidden = false; $('busyMsg').textContent = msg; $('busyBar').style.width = `${Math.round((p || 0) * 100)}%`; }
async function importVideo(which, file) {
  if (!file) return;
  if (!looksLikeVideo(file)) { toast(`${file.name} doesn't look like a video file`); return; }
  try {
    setBusy('Checking ' + file.name + '…', 0);
    if (!(await probePlayable(file))) file = await convertToMp4(file, (msg, p) => setBusy(`${msg} ${p ? Math.round(p * 100) + '%' : ''}`, p));
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
    $('srcName').textContent = file.name; $('drop').hidden = true;
    startSnap = null;
    if (!rebuildGrid()) chain.clearBuffers();
    chain.setField(0);
    fitPreview();
    analyseAudio(file).then((env) => { if (src.v1 && src.v1.file === file) src.v1.env = env; });
    toast('Loaded ' + file.name);
  } else { el.loop = true; el.play().catch(() => {}); toast('Video 2: ' + file.name); }
  uiDirty = inspDirty = stripDirty = true;
}
for (const id of ['fileV1', 'fileV2']) $(id).accept = VIDEO_ACCEPT;
$('btnImport').onclick = () => $('fileV1').click();
$('btnImportV2').onclick = () => $('fileV2').click();
$('fileV1').onchange = (e) => { importVideo('v1', e.target.files[0]); e.target.value = ''; };
$('fileV2').onchange = (e) => { importVideo('v2', e.target.files[0]); e.target.value = ''; };
screenEl.addEventListener('dragover', (e) => { e.preventDefault(); screenEl.classList.add('dragging'); });
screenEl.addEventListener('dragleave', () => screenEl.classList.remove('dragging'));
screenEl.addEventListener('drop', (e) => { e.preventDefault(); screenEl.classList.remove('dragging'); const f = [...e.dataTransfer.files].find(looksLikeVideo); if (f) importVideo('v1', f); else toast('Drop a video file'); });

// ================================================================ actions + automation
const recording = () => recArm && playing;
const curField = () => (cviNodes()[0] ? chain.engine(cviNodes()[0].id).field : Math.floor((src.v1 ? src.v1.el.currentTime : 0) * fieldRate));
// set one block's parameter (recorded as "<id>|<param>")
function setNodeParam(node, k, v) {
  if (!node) return;
  const prev = chain.getParam(node, k);
  chain.setParam(node, k, v);
  if (recording()) auto.recordValue(`${node.id}|${k}`, curField(), v, prev);
  uiDirty = true;
}
const release = (node, k) => node && auto.release(`${node.id}|${k}`);
// an engine action on one block (press, pad stroke, preset, fill...) — recorded as an event
function act(node, a) {
  const e = node && chain.engine(node.id); if (!e) return;
  e.dispatch(a);
  if (recording()) auto.recordEvent(e.field, { ...a, node: node.id });
  uiDirty = true;
}
function applyNodeAuto(node, f, au, ch) {
  for (const [k, v] of au.valuesFor(node.id, f)) if (ch.getParam(node, k) !== v) ch.setParam(node, k, v);
  const e = ch.engine(node.id);
  if (e) for (const a of au.eventsFor(node.id, f)) e.dispatch(a);
}
function pushUndo(node = selNode()) { const e = node && chain.engine(node.id); if (!e || recording()) return; undoStack.push({ id: node.id, store: e.store.slice(), stencil: e.stencil.slice() }); if (undoStack.length > 30) undoStack.shift(); }
function undo() { const u = undoStack.pop(); const e = u && chain.engine(u.id); if (!e) { toast('Nothing to undo'); return; } e.store.set(u.store); e.stencil.set(u.stencil); toast('Undone'); }

// ================================================================ chain editing
function addBlock(type, opts = {}) {
  const node = chain.make(type, opts);
  const i = selected ? chain.nodes.findIndex((n) => n.id === selected) + 1 : chain.nodes.length;
  chain.insert(node, i <= 0 ? chain.nodes.length : i);
  const e = chain.engine(node.id); if (e) e.field = curField();
  if ((MODULES[type].keyed || MODULES[type].keyer) && !opts.state) detectKey(node, false);
  selected = node.id; openCards.add(node.id);
  stripDirty = inspDirty = uiDirty = true;
  toast('Added ' + node.name);
  return node;
}
// find the backdrop colour from the edges of the frame, like clicking it with the eyedropper
function detectKey(node, announce) {
  const e = chain.engine(node.id); if (!e || !src.v1 || !renderer.targets.has('src')) { if (announce) toast('Import a video first'); return; }
  const W = chain.W, H = chain.H, d = renderer.grab(renderer.target('src').t, W, H);
  const bins = new Array(36).fill(0), sums = new Array(36).fill(0); let lumSum = 0, n = 0, satSum = 0;
  const take = (x, y) => {
    const i = (y * W + x) * 4, r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), dd = mx - mn;
    let hh = 0; if (dd) { hh = mx === r ? ((g - b) / dd) % 6 : mx === g ? (b - r) / dd + 2 : (r - g) / dd + 4; hh = (hh * 60 + 360) % 360; }
    const s = mx ? dd / mx : 0; satSum += s; lumSum += 0.299 * r + 0.587 * g + 0.114 * b; n++;
    if (s > 0.25 && mx > 0.15) { const k = Math.floor(hh / 10) % 36; bins[k]++; sums[k] += hh; }
  };
  for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) if (x < W * 0.12 || x > W * 0.88 || y < H * 0.1) take(x, y);
  let best = 0; for (let k = 1; k < 36; k++) if (bins[k] > bins[best]) best = k;
  if (bins[best] > n * 0.35) {
    setNodeParam(node, 'useStencil', 1); setNodeParam(node, 'stencilSource', 2); setNodeParam(node, 'keyMode', 0); setNodeParam(node, 'keyInvert', 0);
    setNodeParam(node, 'keyHue', Math.round(sums[best] / bins[best]));
    if (announce) toast('Backdrop detected');
  } else {
    const L = lumSum / n;
    setNodeParam(node, 'useStencil', 1); setNodeParam(node, 'stencilSource', 2); setNodeParam(node, 'keyMode', 1);
    setNodeParam(node, 'keyLuma', Math.max(10, Math.min(245, Math.round(L * 255 + (L > 0.5 ? -50 : 50))))); setNodeParam(node, 'keyInvert', L > 0.5 ? 1 : 0);
    if (announce) toast('No coloured backdrop found: keying on brightness');
  }
  e.store.fill(0); e.cascade.fill(0);
}
function removeBlock(id) {
  const i = chain.nodes.findIndex((n) => n.id === id);
  chain.remove(id);
  for (const lane of [...auto.lanes.keys()]) if (lane.startsWith(id + '|')) auto.lanes.delete(lane);
  auto.events = auto.events.filter((e) => e.a.node !== id); auto.resetCursors();
  if (selected === id) selected = chain.nodes[Math.min(i, chain.nodes.length - 1)]?.id || null;
  stripDirty = inspDirty = uiDirty = true;
}
function select(id) { selected = id; if (id) openCards.add(id); stripDirty = inspDirty = uiDirty = true; }

// ================================================================ library (effects) + presets
const thumbs = new Map();
let thumbWorker = null;
function thumbFor(key, state) {
  let c = thumbs.get(key);
  if (c) return c;
  c = document.createElement('canvas'); c.width = 112; c.height = 84; thumbs.set(key, c);
  if (thumbWorker === null) {
    try {
      thumbWorker = new Worker(new URL('./thumbs-worker.js', import.meta.url), { type: 'module' });
      thumbWorker.onmessage = ({ data }) => {
        const t = thumbs.get(data.key); if (!t) return;
        const tmp = new OffscreenCanvas(256, 256); tmp.getContext('2d').putImageData(new ImageData(data.data, 256, 256), 0, 0);
        const g = t.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(tmp, 0, 0, t.width, t.height);
      };
    } catch { thumbWorker = false; }
  }
  if (thumbWorker) thumbWorker.postMessage({ key, state });
  return c;
}
let libTab = 'lib', query = '';
document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => {
  libTab = b.dataset.tab;
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
  $('libPane').hidden = libTab !== 'lib'; $('prePane').hidden = libTab !== 'pre';
  $('fxSearch').placeholder = libTab === 'lib' ? 'Search effects' : 'Search 100 presets';
  buildLib(); buildPresets();
});
$('fxSearch').oninput = (e) => { query = e.target.value.trim().toLowerCase(); buildLib(); buildPresets(); };
const CAT_COLOUR = { Key: '#34d399', Color: '#ff6b9a', Time: '#ffb02e', Shape: '#4fd1c5', Paint: '#a78bfa', 'Video 2': '#60a5fa', Look: '#9ca3af', Advanced: '#e8e8ec' };
function buildLib() {
  const host = $('libPane'); host.innerHTML = '';
  for (const cat of CATEGORIES) {
    const types = Object.keys(MODULES).filter((t) => MODULES[t].cat === cat && (!query || (MODULES[t].name + ' ' + MODULES[t].desc).toLowerCase().includes(query)));
    if (!types.length) continue;
    host.insertAdjacentHTML('beforeend', `<div class="libcat">${cat}</div>`);
    const grid = document.createElement('div'); grid.className = 'libgrid';
    for (const t of types) {
      const m = MODULES[t];
      const b = document.createElement('button'); b.type = 'button'; b.className = 'mod'; b.title = 'Add ' + m.name + ' to the chain';
      if (m.kind === 'cvi') b.appendChild(thumbFor('mod:' + t, { p: m.p, enter: m.enter || [] }));
      else b.insertAdjacentHTML('beforeend', `<span class="tile ${m.look}"></span>`);
      b.insertAdjacentHTML('beforeend', `<span><b>${esc(m.name)}</b><small>${esc(m.desc)}</small></span><span class="plus">+</span>`);
      b.onclick = () => addBlock(t);
      grid.appendChild(b);
    }
    host.appendChild(grid);
  }
}
const PRESET_CATS = [
  ['Color', [25, 26, 27, 28, 29, 44, 46, 48, 49, 74]], ['Trails', [59, 60, 61, 62, 63, 66, 70, 71, 72, 73, 57, 58]], ['Mirror', [31, 32, 33, 64, 65, 67, 68]],
  ['Pixel', [30, 36, 37, 75]], ['Freeze', [38, 39, 43, 47, 52]], ['Key', [69, 20, 22, 24, 53, 55, 8, 9, 17, 56, 79, 80, 98, 99]], ['Shatter', [40, 41, 42, 45, 54]],
  ['Scan & wipe', [34, 35, 51, 3, 13, 14]], ['Paint', [0, 1, 2, 4, 5, 6, 7, 10, 11, 12, 15, 16, 18, 19, 21, 23, 50]], ['Two videos', [85, 86, 87, 88, 84, 89, 90, 91, 92, 93]],
  ['Music', [81, 82, 83]], ['Utility', [76, 77, 78, 94, 95, 97]],
];
let preCat = 'All';
const mine = () => { try { return JSON.parse(localStorage.getItem('cvi84.chains') || '[]'); } catch { return []; } };
const saveMine = (m) => { try { localStorage.setItem('cvi84.chains', JSON.stringify(m)); } catch { toast('This browser blocked saving.'); } };
function buildPresets() {
  $('fxChips').innerHTML = ['All', ...PRESET_CATS.map((c) => c[0]), 'My chains'].map((c) => `<button type="button" class="chip${c === preCat ? ' on' : ''}" data-cat="${c}">${c}</button>`).join('');
  $('mineRow').hidden = preCat !== 'My chains';
  const n = selNode();
  $('preHint').textContent = preCat === 'My chains' ? 'Save the current chain with all its settings, or load one.' : n && chain.kind(n) === 'cvi' ? `Click a preset to load it into "${n.name}".` : 'Click a preset to add it to the chain as a CVI unit.';
  const host = $('fxList'); host.innerHTML = '';
  if (preCat === 'My chains') {
    const list = mine();
    if (!list.length) host.innerHTML = '<p class="desc" style="grid-column:1/-1;padding:4px">No saved chains yet.</p>';
    list.forEach((m) => {
      if (query && !m.name.toLowerCase().includes(query)) return;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'card';
      b.innerHTML = `<span style="padding:8px;border:1px solid var(--line);border-radius:6px;min-height:60px;-webkit-line-clamp:5"><b>★</b>${esc(m.name)}<br><small class="desc">${m.chain.nodes.map((x) => esc(x.name)).join(' → ') || 'empty'}</small></span>`;
      b.onclick = () => loadChain(m.chain, m.name);
      host.appendChild(b);
    });
    return;
  }
  const nums = preCat === 'All' ? PRESET_CATS.flatMap((c) => c[1]) : PRESET_CATS.find((c) => c[0] === preCat)[1];
  for (const num of nums) {
    const name = FACTORY[num][0], label = String(num).padStart(2, '0');
    if (query && !(name.toLowerCase().includes(query) || label.includes(query))) continue;
    const b = document.createElement('button'); b.type = 'button'; b.className = 'card';
    const st = presetState(num);
    b.appendChild(thumbFor('pre:' + num, { p: st.p, enter: st.enter }));
    b.insertAdjacentHTML('beforeend', `<span><b>${label}</b>${esc(name)}</span>`);
    b.onclick = () => applyPreset(num);
    host.appendChild(b);
  }
}
$('fxChips').onclick = (e) => { const b = e.target.closest('.chip'); if (!b) return; preCat = b.dataset.cat; buildPresets(); };
$('mineSave').onclick = () => {
  const name = $('mineName').value.trim() || `Chain ${mine().length + 1}`;
  const m = mine(); m.push({ name, chain: chain.toJSON() }); saveMine(m);
  $('mineName').value = ''; buildPresets(); toast('Saved ' + name);
};
function applyPreset(num) {
  const st = presetState(num); if (!st) return;
  const name = `${String(num).padStart(2, '0')} ${st.name}`;
  const n = selNode();
  if (n && chain.kind(n) === 'cvi') {
    pushUndo(n);
    n.type = 'unit'; n.name = name;
    act(n, { k: 'preset', n: num, state: { p: st.p, enter: st.enter } });
    inspDirty = stripDirty = true; toast('Loaded ' + name);
  } else addBlock('unit', { name, state: { p: st.p, enter: st.enter } });
}
function loadChain(json, name) {
  chain = Chain.from(json, chain.W, chain.H);
  chain.setField(Math.floor((src.v1 ? src.v1.el.currentTime : 0) * fieldRate));
  auto.clear(); startSnap = null; selected = chain.nodes[0]?.id || null;
  stripDirty = inspDirty = uiDirty = true; toast('Loaded ' + name);
}

// ================================================================ transport
const duration = () => (src.v1 ? src.v1.el.duration || 0 : 0);
const curTime = () => (src.v1 ? src.v1.el.currentTime : 0);
function syncFieldToTime(t) {
  const f = Math.floor(t * fieldRate + 1e-6);
  chain.setField(f); auto.resetCursors();
  for (const n of chain.nodes) for (const [k, v] of auto.valuesFor(n.id, f)) chain.setParam(n, k, v);
  uiDirty = true;
}
function takeStartSnapshot() { chain.setField(0); startSnap = chain.snapshot(); }
function exportBase() { return startSnap && !auto.isEmpty() ? startSnap : chain.snapshot(); }
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
  if (!startSnap) return;
  if (!auto.isEmpty()) { const sel = selected; chain = Chain.from(clone_(startSnap), chain.W, chain.H); selected = chain.get(sel) ? sel : null; stripDirty = inspDirty = true; }
  else for (const [id, s] of Object.entries(startSnap.engines || {})) { const e = chain.engine(id); if (e) e.restore({ ...s, P: null }); }
  syncFieldToTime(0);
}
$('btnPlay').onclick = () => (playing ? pause() : play());
$('btnHome').onclick = home;
$('btnLoop').onclick = () => { loop = !loop; uiDirty = true; };
$('btnRec').onclick = () => { recArm = !recArm; if (!recArm) auto.releaseAll(); uiDirty = true; toast(recArm ? 'Recording armed: press play' : 'Recording off'); };
$('btnFreeze').onclick = () => { const n = selNode(); const targets = n && chain.kind(n) === 'cvi' ? [n] : cviNodes(); for (const x of targets) act(x, { k: 'press', b: 'freeze' }); };
$('btnClearAuto').onclick = () => { auto.clear(); uiDirty = true; toast('Automation cleared'); };

// the frame loop: playing follows the video's clock; paused, the CVI units keep running live on the held frame
let targetField = 0, freeSteps = 0;
function advanceLive(e, node, inputs) {
  if (freeSteps) { for (let i = 0; i < freeSteps; i++) { if (inputs) e.step(inputs, audioAt(e.field)); else e.field++; } return; }
  if (targetField < e.field - 2) e.field = targetField;
  let steps = 0;
  while (e.field <= targetField) {
    if (steps++ > 6) e.field = targetField;
    applyNodeAuto(node, e.field, auto, chain);
    if (inputs) e.step(inputs, audioAt(e.field)); else e.field++;
  }
}
function applyLookAuto(f, ch, au) { for (const n of ch.nodes) if (ch.kind(n) !== 'cvi') for (const [k, v] of au.valuesFor(n.id, f)) ch.setParam(n, k, v); }
function drawFrame() {
  if (renderer.w === 0) fitPreview();
  renderer.uploadSource('analog', v1Source());
  const v2 = v2Source(); if (v2) renderer.uploadSource('v2', v2);
  if (!freeSteps) applyLookAuto(targetField, chain, auto);
  curFrameTex = renderChain(chain, renderer, { advance: advanceLive, hasV2: !!v2, frame: targetField, blanking: settings.blanking, smooth: settings.smooth });
  renderer.present(curFrameTex);
}
function onVideoFrame(now, meta) {
  if (!playing) return;
  targetField = Math.floor(meta.mediaTime * fieldRate + 1e-6); freeSteps = 0;
  drawFrame(); uiDirty = true;
  src.v1.el.requestVideoFrameCallback(onVideoFrame);
}
let lastTick = performance.now(), freeAcc = 0, demoT = 0;
function tick(now) {
  const dt = Math.min(0.1, (now - lastTick) / 1000); lastTick = now;
  if (!playing) {
    freeAcc += dt * fieldRate;
    freeSteps = Math.min(4, Math.floor(freeAcc)); freeAcc -= Math.floor(freeAcc);
    targetField = curField();
    if (freeSteps || !curFrameTex) drawFrame(); else renderer.present(curFrameTex);
    if (src.v1) chain.setField(Math.floor(curTime() * fieldRate));
    freeSteps = 0;
  }
  if ((stripDirty || inspDirty) && !$('insp').contains(document.activeElement)) { const st = $('insp').scrollTop; stripDirty = inspDirty = false; buildChainPanel(); $('insp').scrollTop = st; buildPresetsHint(); }
  else if ((stripDirty || inspDirty) && document.activeElement && !document.activeElement.matches('input, textarea, select')) { const st = $('insp').scrollTop; stripDirty = inspDirty = false; buildChainPanel(); $('insp').scrollTop = st; buildPresetsHint(); }
  if (uiDirty) { uiDirty = false; syncUI(); }
  drawOverlay(); drawTimeline(); updateTC();
  requestAnimationFrame(tick);
}
function buildPresetsHint() { if (libTab === 'pre') buildPresets(); }

// ================================================================ chain stack (left panel)
const SVG = { power: '<path d="M12 3v8M6.3 6.3a8 8 0 1011.4 0"/>', x: '<path d="M6 6l12 12M18 6L6 18"/>', down: '<path d="M12 5v14M6 13l6 6 6-6"/>' };
const openCards = new Set(); // which blocks are dropped down
let dragId = null, HOST = null;
function flowArrow() { return h(`<div class="ch-flow"><svg viewBox="0 0 24 24">${SVG.down}</svg></div>`); }
function buildChainPanel() {
  binds.length = 0;
  const host = $('insp'); host.innerHTML = '';
  const head = h(`<div class="ch-head"><h2>Effect chain</h2><button type="button" class="btn ghost" id="btnClearChain">Clear</button></div>`);
  head.querySelector('button').onclick = () => { for (const n of [...chain.nodes]) removeBlock(n.id); toast('Chain cleared'); };
  host.appendChild(head);
  const srcRow = h(`<button type="button" class="ch-src" title="Import a video">Video 1&nbsp;<b>${src.v1 ? esc(src.v1.name) : 'none, click to import'}</b></button>`);
  srcRow.onclick = () => $('fileV1').click();
  host.appendChild(srcRow);
  if (!chain.nodes.length) host.appendChild(h(`<div class="ch-empty"><b>No effects yet</b>Click an effect in the library on the right to add it here. Effects run from top to bottom, like layers in Premiere.</div>`));
  chain.nodes.forEach((node, idx) => { host.appendChild(flowArrow()); host.appendChild(buildCard(node, idx)); });
  host.appendChild(flowArrow());
  host.appendChild(buildOutputCard());
}
function buildCard(node, idx) {
  const m = MODULES[node.type];
  const card = h(`<div class="ccard${openCards.has(node.id) ? '' : ' closed'}${node.id === selected ? ' sel' : ''}"></div>`);
  card.dataset.id = node.id;
  const head = h(`<div class="chead" title="Click to open or close"><span class="grip" draggable="true" title="Drag to reorder"><svg viewBox="0 0 12 16"><circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="8" r="1.5"/><circle cx="9" cy="8" r="1.5"/><circle cx="3" cy="13" r="1.5"/><circle cx="9" cy="13" r="1.5"/></svg></span>
    <svg class="chev2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg><span class="num">${idx + 1}</span><span class="dot" style="background:${CAT_COLOUR[m.cat]}"></span><span class="cname">${esc(node.name)}</span>
    <button type="button" class="ib pw" title="On / off"><svg viewBox="0 0 24 24">${SVG.power}</svg></button><button type="button" class="ib del" title="Remove"><svg viewBox="0 0 24 24">${SVG.x}</svg></button></div>`);
  card.appendChild(head);
  head.addEventListener('click', (e) => {
    if (e.target.closest('.pw')) { setNodeParam(node, 'bypass', node.bypass ? 0 : 1); release(node, 'bypass'); return; }
    if (e.target.closest('.del')) { removeBlock(node.id); return; }
    if (e.target.closest('.grip')) return;
    const wasSel = selected === node.id;
    selected = node.id;
    if (wasSel || !openCards.has(node.id)) { if (openCards.has(node.id)) openCards.delete(node.id); else openCards.add(node.id); }
    document.querySelectorAll('.ccard').forEach((c) => c.classList.toggle('sel', c.dataset.id === selected));
    card.classList.toggle('closed', !openCards.has(node.id));
    $('pillOutCard') && $('pillOutCard').classList.remove('sel');
    if (libTab === 'pre') buildPresets();
    uiDirty = true;
  });
  head.querySelector('.cname').addEventListener('dblclick', (e) => { e.stopPropagation(); const inp = h(`<input class="name" style="font:inherit;font-weight:600;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px 4px;width:100%" maxlength="40">`); inp.value = node.name; e.target.replaceWith(inp); inp.focus(); inp.select(); const done = () => { node.name = inp.value.trim() || m.name; stripDirty = true; }; inp.onblur = done; inp.onkeydown = (k) => { if (k.key === 'Enter') inp.blur(); k.stopPropagation(); }; });
  // drag to reorder (grip)
  const grip = head.querySelector('.grip');
  grip.addEventListener('dragstart', (e) => { dragId = node.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id); e.dataTransfer.setDragImage(card, 20, 16); });
  grip.addEventListener('dragend', () => { dragId = null; stripDirty = true; });
  card.addEventListener('dragover', (e) => { if (!dragId || dragId === node.id) return; e.preventDefault(); const r = card.getBoundingClientRect(); const top = e.clientY < r.top + Math.min(r.height / 2, 24); card.classList.toggle('drop-t', top); card.classList.toggle('drop-b', !top); });
  card.addEventListener('dragleave', () => card.classList.remove('drop-t', 'drop-b'));
  card.addEventListener('drop', (e) => {
    e.preventDefault(); if (!dragId) return;
    const r = card.getBoundingClientRect(); const top = e.clientY < r.top + Math.min(r.height / 2, 24);
    const from = chain.nodes.findIndex((x) => x.id === dragId); let to = chain.nodes.findIndex((x) => x.id === node.id) + (top ? 0 : 1);
    if (from < to) to--;
    chain.move(dragId, to); stripDirty = true;
  });
  binds.push(() => { card.classList.toggle('off', !!node.bypass); head.querySelector('.pw').classList.toggle('on', !node.bypass); });
  // body: description, on/amount, the effect's own controls, and everything else under Advanced
  const body = h('<div class="cbody"></div>');
  card.appendChild(body);
  // controls inside this card act on this block
  for (const ev of ['click', 'input', 'change', 'pointerdown', 'dblclick', 'keydown']) body.addEventListener(ev, () => { CUR = node; }, true);
  if (openCards.has(node.id)) fillCard(body, node);
  else head.addEventListener('click', function once() { if (!body.childElementCount && openCards.has(node.id)) fillCard(body, node); }, { capture: false });
  return card;
}
function fillCard(body, node) {
  const m = MODULES[node.type];
  const first = binds.length;
  CUR = node; HOST = body;
  body.appendChild(h(`<p class="cdesc">${esc(m.desc)}</p>`));
  const top = h('<div class="ctop"></div>'); body.appendChild(top);
  slider(top, { p: 'mix', label: 'Amount', min: 0, max: 1, step: 0.01, fmt: (v) => Math.round(v * 100) + '%', reset: 1 });
  if (m.kind === 'look') SECTIONS.look(top, m.look);
  else {
    const simple = m.sections[0] === 'all' ? ALL : m.sections;
    for (const s of simple) SECTIONS[s](section(SECTION_TITLES[s], true));
    if (m.sections[0] !== 'all') {
      const advOpen = showAll.has(node.id);
      const adv = h(`<button type="button" class="advbtn">${advOpen ? 'Hide advanced settings' : 'Advanced: every CVI setting for this effect'}</button>`);
      adv.onclick = () => { if (showAll.has(node.id)) showAll.delete(node.id); else showAll.add(node.id); stripDirty = true; };
      if (advOpen) for (const s of ALL.filter((x) => !simple.includes(x))) SECTIONS[s](section(SECTION_TITLES[s], false));
      body.appendChild(adv);
    }
  }
  // binds made for this card read their own block
  for (let i = first; i < binds.length; i++) { const f = binds[i]; binds[i] = () => { CUR = node; f(); }; }
  HOST = null;
}
function buildOutputCard() {
  const card = h(`<div class="ccard${openCards.has('out') ? '' : ' closed'}" id="pillOutCard"><div class="chead"><span class="grip"></span><svg class="chev2" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg><span class="num"></span><span class="dot" style="background:var(--faint)"></span><span class="cname">Output</span><span class="desc" style="margin-right:6px">project settings</span></div><div class="cbody"></div></div>`);
  card.querySelector('.chead').onclick = () => { if (openCards.has('out')) openCards.delete('out'); else openCards.add('out'); card.classList.toggle('closed', !openCards.has('out')); };
  const first = binds.length; HOST = card.querySelector('.cbody');
  buildProjectPanel();
  HOST = null;
  return card;
}
// ================================================================ tools + pad
const ICON = {
  pointer: '<path d="M5 3l14 8-6 2-2 6z"/>',
  brush: '<path d="M18 3l3 3-9 9-3-3zM9 12c-3 0-5 2-5 5 0 1-1 2-2 2 2 2 7 2 9-1 1-2 1-4-2-6z"/>',
  dots: '<circle cx="6" cy="6" r="1.6"/><circle cx="12" cy="9" r="1.6"/><circle cx="17" cy="14" r="1.6"/><circle cx="9" cy="17" r="1.6"/>',
  line: '<path d="M4 20L20 4"/>', rays: '<path d="M4 20L20 4M4 20l16-6M4 20l6-16M4 20l16 2M4 20L2 4"/>',
  rect: '<rect x="4" y="6" width="16" height="12" rx="1"/>', circle: '<circle cx="12" cy="12" r="8"/>', ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
  fill: '<path d="M5 11l7-7 7 7-7 7zM19 15s2 3 2 4a2 2 0 01-4 0c0-1 2-4 2-4z"/>',
  cut: '<rect x="4" y="4" width="10" height="10" stroke-dasharray="2 2"/><rect x="10" y="10" width="10" height="10"/>',
  copy: '<path d="M4 4h10v4M4 4v10h4"/><rect x="9" y="9" width="11" height="11" rx="1"/>',
  text: '<path d="M5 6V4h14v2M12 4v16M9 20h6"/>', pick: '<path d="M14 4l6 6-2 2-6-6zM12 8l-7 7v4h4l7-7"/>',
};
const TOOLS = [
  ['pointer', 'Select (V): no painting', null, 'v'], 'sep',
  ['brush', 'Brush (B)', 0, 'b'], ['dots', 'Dots', 1], ['line', 'Line (L)', 2, 'l'], ['rays', 'Rays', 6],
  ['rect', 'Rectangle (R)', 5, 'r'], ['circle', 'Circle (C)', 3, 'c'], ['ellipse', 'Ellipse', 4], ['fill', 'Fill area (G)', 8, 'g'],
  ['cut', 'Cut & paste: drag a box, then click to paste', 7], ['copy', 'Copy live video into the masked area', 9], 'sep',
  ['text', 'Text (T): click to place', 'text', 't'], ['pick', 'Eyedropper (I): pick a colour', 'pick', 'i'],
];
let tool = 'pointer', prevTool = 'pointer';
function buildTools() {
  $('tools').innerHTML = TOOLS.map((t) => (t === 'sep' ? '<span class="sep"></span>' : `<button type="button" class="tool" data-tool="${t[0]}" title="${t[1]}" aria-label="${t[1]}"><svg viewBox="0 0 24 24">${ICON[t[0]]}</svg></button>`)).join('')
    + '<span class="sep"></span><span class="desc" style="margin:0 6px 0 0;white-space:nowrap">Paint on</span><div class="target" id="paintTarget"><button type="button" data-t="c">Picture</button><button type="button" data-t="m">Mask</button><button type="button" data-t="b">Both</button></div>'
    + '<button type="button" class="tool" id="btnUndo" title="Undo paint (Ctrl+Z)" aria-label="Undo"><svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3"/></svg></button><span class="toolhint" id="toolHint"></span>';
  $('tools').addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]'); if (b) { selectTool(b.dataset.tool); return; }
    const t = e.target.closest('[data-t]');
    if (t) { const n = paintNode(true); if (!n) return; const v = t.dataset.t; setNodeParam(n, 'drawColour', v !== 'm' ? 1 : 0); setNodeParam(n, 'drawStencil', v !== 'c' ? 1 : 0); }
  });
  $('btnUndo').onclick = undo;
}
// the block that receives paint: the selected CVI unit, or a new Paint layer
function paintNode(create) {
  const n = selNode();
  if (n && chain.kind(n) === 'cvi') return n;
  return create ? addBlock('paint') : null;
}
function selectTool(id) {
  const t = TOOLS.find((x) => x !== 'sep' && x[0] === id); if (!t) return;
  const e = selEngine();
  if (e) { if (tool === 'text' && id !== 'text') e.titleArmed = false; if (tool === 'pick' && id !== 'pick') e.pickArmed = false; }
  if (id === 'pointer') { tool = 'pointer'; uiDirty = true; return; }
  const n = paintNode(true); const en = chain.engine(n.id);
  if (id === 'text') en.titleArmed = true;
  else if (id === 'pick') { prevTool = tool; en.pickArmed = true; }
  else setNodeParam(n, 'paintMethod', t[2]);
  tool = id; uiDirty = true;
}
let padDown = false, hover = null, pickKeyArmed = false;
const padPos = (e) => { const r = screenEl.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; };
screenEl.addEventListener('pointerdown', (e) => {
  const p = padPos(e);
  if (pickKeyArmed) { pickKeyArmed = false; pickKeyAt(p); uiDirty = true; return; }
  if (tool === 'pointer') return;
  const n = paintNode(false); if (!n) { tool = 'pointer'; uiDirty = true; return; }
  const en = chain.engine(n.id), wasPick = en.pickArmed;
  if (tool !== 'pick') pushUndo(n);
  padDown = true; screenEl.setPointerCapture(e.pointerId);
  act(n, { k: 'pad', ph: 'down', x: p.x, y: p.y, draw: tool !== 'text' && tool !== 'pick' });
  if (wasPick) { toast('Colour picked'); padDown = false; selectTool(prevTool === 'pick' ? 'pointer' : prevTool); }
});
screenEl.addEventListener('pointermove', (e) => { hover = padPos(e); if (padDown) act(paintNode(false), { k: 'pad', ph: 'move', x: hover.x, y: hover.y, draw: true }); });
const padUp = (e) => { if (!padDown) return; padDown = false; const p = padPos(e); act(paintNode(false), { k: 'pad', ph: 'up', x: p.x, y: p.y, draw: true }); };
screenEl.addEventListener('pointerup', padUp); screenEl.addEventListener('pointercancel', padUp);
screenEl.addEventListener('pointerleave', () => { hover = null; });
function pickKeyAt(p) {
  const n = selNode(); if (!n || chain.kind(n) !== 'cvi') return;
  const W = chain.W, H = chain.H, data = renderer.grab(renderer.target('src').t, W, H);
  const i = ((Math.floor(p.y * H) * W) + Math.floor(p.x * W)) * 4;
  const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0; if (d) { hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh = (hh * 60 + 360) % 360; }
  setNodeParam(n, 'useStencil', 1); if (chain.getParam(n, 'stencilSource') === 0) setNodeParam(n, 'stencilSource', 2);
  if (d / (mx || 1) < 0.2) { setNodeParam(n, 'keyMode', 1); setNodeParam(n, 'keyLuma', Math.max(10, Math.min(245, Math.round(mx * 255 + (mx > 0.5 ? -40 : 40))))); setNodeParam(n, 'keyInvert', mx > 0.5 ? 1 : 0); toast('Neutral backdrop: keying on brightness'); }
  else { setNodeParam(n, 'keyHue', Math.round(hh)); setNodeParam(n, 'keyMode', 0); setNodeParam(n, 'keyInvert', 0); toast(`Key colour set (${Math.round(hh)}°)`); }
}
function drawOverlay() {
  const w = overlay.width, h = overlay.height;
  octx.clearRect(0, 0, w, h);
  const e = selEngine();
  const o = e && e.overlay;
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
  if (hover && (tool !== 'pointer' || pickKeyArmed)) {
    const W = chain.W, H = chain.H;
    const cx = (Math.floor(hover.x * W) + 0.5) / W * w, cy = (Math.floor(hover.y * H) + 0.5) / H * h;
    if (tool === 'text' && e) { octx.fillStyle = '#fff9'; octx.font = `${Math.round(h / 26)}px Geist, sans-serif`; octx.fillText((e.P.title || '').split('\n')[0], cx, cy + h / 40); }
    octx.strokeStyle = tool === 'pick' || pickKeyArmed ? '#ffb02e' : '#fff';
    octx.beginPath();
    if ((tool === 'brush' || tool === 'dots') && e) octx.arc(cx, cy, Math.max(3, [1, 2, 3, 4, 6, 9, 13, 2, 3, 5, 6, 2, 6, 6, 6, 13][e.P.brush] / W * w), 0, 7);
    octx.moveTo(cx - 8, cy); octx.lineTo(cx + 8, cy); octx.moveTo(cx, cy - 8); octx.lineTo(cx, cy + 8);
    octx.stroke();
  }
}

// ================================================================ inspector
const binds = [];
const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
let CUR = null; // the block the inspector is editing
const gp = (k) => chain.getParam(CUR, k);
const sp = (k, v) => setNodeParam(CUR, k, v);
function section(title, open = true, desc) {
  const s = h(`<section class="sec${open ? '' : ' closed'}"><header><h3>${title}</h3><svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></header><div class="body">${desc ? `<p class="desc" style="margin:0">${desc}</p>` : ''}</div></section>`);
  s.querySelector('header').onclick = () => s.classList.toggle('closed');
  (HOST || $('insp')).appendChild(s);
  return s.querySelector('.body');
}
function slider(host, { p, label, min = 0, max = 255, step = 1, fmt, cls = '', reset, show }) {
  const node = CUR;
  const el = h(`<label class="field"><span title="Double-click to reset">${label}</span><input type="range" class="${cls}" min="${min}" max="${max}" step="${step}"><output></output></label>`);
  const inp = el.querySelector('input'), out = el.querySelector('output'), lab = el.querySelector('span');
  inp.addEventListener('input', () => setNodeParam(node, p, +inp.value));
  const rel = () => release(node, p);
  inp.addEventListener('change', rel); inp.addEventListener('pointerup', rel); inp.addEventListener('keyup', rel);
  lab.addEventListener('dblclick', () => { if (reset !== undefined) { setNodeParam(node, p, reset); rel(); } });
  binds.push(() => {
    const v = chain.getParam(node, p);
    if (document.activeElement !== inp) inp.value = v;
    out.textContent = fmt ? fmt(v) : (+v).toFixed(step < 1 ? 2 : 0);
    lab.classList.toggle('dot', auto.lanes.has(`${node.id}|${p}`));
    if (show) el.hidden = !show();
  });
  host.appendChild(el); return el;
}
function seg(host, { p, label, opts, show }) {
  const node = CUR;
  const el = h(`<div class="field" style="grid-template-columns:${label ? '88px ' : ''}minmax(0,1fr)">${label ? `<span>${label}</span>` : ''}<div class="seg">${opts.map(([v, t]) => `<button type="button" data-v="${v}">${t}</button>`).join('')}</div></div>`);
  el.querySelector('.seg').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; setNodeParam(node, p, +b.dataset.v); release(node, p); };
  binds.push(() => { const v = chain.getParam(node, p); for (const b of el.querySelectorAll('button')) b.classList.toggle('on', String(+v) === b.dataset.v); if (show) el.hidden = !show(); });
  host.appendChild(el); return el;
}
function select_(host, { p, label, opts, show, groups }) {
  const node = CUR;
  const optHTML = groups ? groups.map(([g, items]) => `<optgroup label="${g}">${items.map((i) => `<option value="${opts[i][0]}">${esc(opts[i][1])}</option>`).join('')}</optgroup>`).join('') : opts.map(([v, t]) => `<option value="${v}">${esc(t)}</option>`).join('');
  const el = h(`<label class="field"${label ? '' : ' style="grid-template-columns:minmax(0,1fr)"'}>${label ? `<span>${label}</span>` : ''}<select>${optHTML}</select></label>`);
  const s = el.querySelector('select');
  s.onchange = () => { setNodeParam(node, p, +s.value); release(node, p); };
  binds.push(() => { if (document.activeElement !== s) s.value = String(chain.getParam(node, p)); if (show) el.hidden = !show(); });
  host.appendChild(el); return el;
}
function toggle(host, { p, label, show, hint }) {
  const node = CUR;
  const el = h(`<div class="row"><label>${label}${hint ? ` <span class="desc">${hint}</span>` : ''}</label><button type="button" class="switch" role="switch" aria-label="${esc(label)}"></button></div>`);
  const sw = el.querySelector('.switch');
  sw.onclick = () => { setNodeParam(node, p, chain.getParam(node, p) ? 0 : 1); release(node, p); };
  binds.push(() => { sw.setAttribute('aria-checked', chain.getParam(node, p) ? 'true' : 'false'); if (show) el.hidden = !show(); });
  host.appendChild(el); return el;
}
function buttons(host, items, cols = 3) {
  const el = h(`<div class="grid-btns" style="grid-template-columns:repeat(${cols},1fr)">${items.map((it, i) => `<button type="button" class="gbtn${it.stop ? ' stop' : ''}${it.primary ? ' on' : ''}" data-i="${i}" title="${esc(it.title || it.label)}">${it.label}</button>`).join('')}</div>`);
  el.onclick = (e) => { const b = e.target.closest('button'); if (b) items[+b.dataset.i].run(); uiDirty = true; };
  host.appendChild(el); return el;
}
const sub = (host, text, show) => { const el = host.appendChild(h(`<div class="sub">${text}</div>`)); if (show) binds.push(() => { el.hidden = !show(); }); return el; };
const note = (host, text, show) => { const el = host.appendChild(h(`<p class="desc">${text}</p>`)); if (show) binds.push(() => { el.hidden = !show(); }); return el; };
const pct = (v) => Math.round(v / 2.55) + '%';
const bipf = (v) => { const x = Math.round((v - 128) / 1.27); return (x > 0 ? '+' : '') + x; };
const deg = (v) => Math.round(v / 255 * 360) + '°';
const pix = (v) => '×' + (1 + Math.pow(v / 255, 1.6) * 15).toFixed(1);
const doAct = (a) => act(CUR, a);
const press = (b) => doAct({ k: 'press', b });
function hsvHex(hh, s, v) { const f = (n) => { const k = (n + hh * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return '#' + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join(''); }
function hsvRgb(hh, s, v) { const f = (n) => { const k = (n + hh * 6) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); }; return [f(5), f(3), f(1)]; }
function hexHsv(hex) { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let hh = 0; if (d) { hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; hh = ((hh / 6) + 1) % 1; } return [hh, mx ? d / mx : 0, mx]; }

const MODES = [
  [1, 'Canvas only', 'Paint'], [2, 'Canvas + live in mask', 'Paint/Analog'], [3, 'Canvas + CVI video in mask (records)', 'Paint/Digital'],
  [4, 'Trail: subject leaves copies', 'Trail'], [5, 'CVI video + live in mask', 'Dig./Analog'], [6, 'Paint colour into mask', 'Colour'],
  [7, 'Frame buffer (freeze, pixelate, feedback)', 'Store'], [8, 'Colour splash + live', 'Col./Analog'], [9, 'Catch-up: delayed copy behind live', 'Store/Analog'],
  [10, 'Colour trail', 'Colour trail'], [11, 'Grab outside mask, live inside', 'Acquire'], [12, 'Ghost: frozen + live double exposure', 'Ghost'],
  [13, 'Canvas with CVI video holes', 'Protect'], [14, 'Live + double exposure', 'Mix'], [15, 'CVI video, clean video in mask', 'Live combo'],
  [16, 'Canvas with colour crawl', 'Crawl'], [17, 'Colour crawl + live in mask', 'Crawl/Analog'], [18, 'Trail with colour crawl', 'Trail crawl'],
  [19, 'Feedback loop in mask', 'Cascade'], [20, 'Feedback loop, live in mask', 'Cas./Analog'],
];
const LOOK_UI = {
  bw: [['mode', 'Filter', 'sel', ['Neutral', 'Red', 'Green', 'Blue']], ['contrast', 'Contrast', 0.4, 2.5, 0.01], ['bright', 'Brightness', -0.5, 0.5, 0.01], ['gamma', 'Gamma', 0.4, 2.2, 0.01],
    ['grain', 'Grain', 0, 0.6, 0.01], ['grainSize', 'Grain size', 1, 5, 0.1], ['tintAmt', 'Toning', 0, 1, 0.01], ['tintHue', 'Tone hue', 0, 1, 0.005], ['vignette', 'Vignette', 0, 1, 0.01]],
  halftone: [['style', 'Screen', 'sel', ['Mono', 'CMYK', 'Colour']], ['shape', 'Dot', 'sel', ['Round', 'Lines', 'Squares']], ['cell', 'Dot size', 3, 32, 0.5], ['angle', 'Angle', 0, 90, 1],
    ['contrast', 'Contrast', 0.4, 2.5, 0.01], ['ink', 'Ink', 'col'], ['paper', 'Paper', 'col']],
  vhs: [['chromaBlur', 'Colour blur', 0.3, 8, 0.1], ['chromaShift', 'Colour shift', 0, 6, 0.1], ['bleed', 'Colour bleed', 0, 1, 0.01], ['sat', 'Saturation', 0, 2, 0.01],
    ['soft', 'Softness', 0.3, 3, 0.05], ['sharpen', 'Edge ringing', 0, 2, 0.01], ['noise', 'Snow', 0, 1, 0.01], ['tracking', 'Tracking', 0, 1, 0.01],
    ['jitter', 'Jitter', 0, 1, 0.01], ['headSwitch', 'Head switch', 0, 1, 0.01], ['dropouts', 'Dropouts', 0, 1, 0.01], ['wear', 'Tape wear', 0, 1, 0.01]],
  crt: [['maskType', 'Mask', 'sel', ['None', 'Grille', 'Shadow', 'Slot']], ['curv', 'Curvature', 0, 1.5, 0.01], ['scan', 'Scanlines', 0, 1, 0.01], ['lines', 'Line count', 120, 1080, 2],
    ['maskAmt', 'Mask strength', 0, 1, 0.01], ['bloom', 'Glow', 0, 1.5, 0.01], ['converge', 'Convergence', 0, 4, 0.05], ['persist', 'Persistence', 0, 0.9, 0.01],
    ['vignette', 'Vignette', 0, 1, 0.01], ['bright', 'Brightness', 0.5, 2, 0.01], ['flicker', 'Flicker', 0, 1, 0.01], ['cornerR', 'Corners', 0, 0.2, 0.005], ['interlace', 'Interlace', 'sel', ['Off', 'On']]],
};
const keyed = () => gp('stencilSource') === 2 || gp('stencilSource') === 3;
// inspector sections; each builds controls for the block in CUR
const SECTIONS = {
  mode(b) {
    select_(b, { p: 'display', opts: MODES.map(([v, t, o]) => [v, `${t}  (${o})`]), groups: [['Live video', [5, 15, 14, 12]], ['Trails & catch-up', [4, 10, 18, 9, 11]], ['Canvas & paint', [1, 2, 3, 6, 7, 8, 13]], ['Colour crawl', [16, 17]], ['Feedback', [19, 20]]].map(([g, ids]) => [g, ids.map((d) => d - 1)]) });
    note(b, 'The routing decides what shows inside and outside the mask, and where the frame buffer records. These are the CVI\'s 20 Display Control setups.');
  },
  color(b) {
    toggle(b, { p: 'colourize', label: 'Colorize' });
    select_(b, { p: 'colourizeType', label: 'Style', opts: [[0, 'Tint (add colour)'], [1, 'Translucent film'], [2, 'Shade (subtract)'], [3, 'Range (clamp)'], [4, 'Solarize'], [5, 'Monochrome / sepia'], [6, 'Posterize contours'], [7, 'Spectrum false colour']] });
    slider(b, { p: 'hue', label: 'Hue', cls: 'hue', fmt: deg, reset: 0 });
    slider(b, { p: 'sat', label: 'Saturation', fmt: pct, reset: 200 });
    slider(b, { p: 'val', label: 'Brightness', fmt: pct, reset: 255 });
    slider(b, { p: 'depth', label: 'Intensity', cls: 'bip', fmt: bipf, reset: 128 });
    note(b, 'Intensity: right of centre is the positive effect, left the negative (centre is off).');
    SECTIONS.colourSource(b);
  },
  colourSource(b) {
    sub(b, 'Colour comes from');
    seg(b, { p: 'colourizeCtl', opts: [[0, 'Sliders'], [1, 'Hold'], [2, 'Music'], [3, 'Random']] });
    slider(b, { p: 'rate1', label: 'Change speed', fmt: pct, reset: 128, show: () => gp('colourizeCtl') === 3 });
  },
  colourSpeed(b) { slider(b, { p: 'rate1', label: 'Crawl speed', fmt: pct, reset: 210 }); },
  pixelate(b) {
    slider(b, { p: 'zoom', label: 'Pixelate', fmt: pix, reset: 0 });
    slider(b, { p: 'stretch', label: 'Stretch', cls: 'bip', fmt: bipf, reset: 128 });
  },
  transform(b) {
    SECTIONS.pixelate(b);
    slider(b, { p: 'hpan', label: 'Position X', cls: 'bip', fmt: bipf, reset: 128 });
    slider(b, { p: 'vpan', label: 'Position Y', cls: 'bip', fmt: bipf, reset: 128 });
    toggle(b, { p: 'vmirror', label: 'Mirror left / right' });
    toggle(b, { p: 'hmirror', label: 'Mirror top / bottom' });
    toggle(b, { p: 'slide', label: 'Auto-scroll', hint: 'position = speed' });
    toggle(b, { p: 'glide', label: 'Smooth moves', hint: 'speed = Rate' });
    toggle(b, { p: 'hwipe', label: 'Split screen ↔' });
    toggle(b, { p: 'vwipe', label: 'Split screen ↕' });
  },
  mirror(b) {
    toggle(b, { p: 'vmirror', label: 'Mirror left / right' });
    toggle(b, { p: 'hmirror', label: 'Mirror top / bottom' });
    slider(b, { p: 'hpan', label: 'Mirror line X', cls: 'bip', fmt: bipf, reset: 128 });
    slider(b, { p: 'vpan', label: 'Mirror line Y', cls: 'bip', fmt: bipf, reset: 128 });
    slider(b, { p: 'zoom', label: 'Pixelate', fmt: pix, reset: 0 });
  },
  scroll(b) {
    toggle(b, { p: 'slide', label: 'Scroll' });
    slider(b, { p: 'hpan', label: 'Speed X', cls: 'bip', fmt: bipf, reset: 128, show: () => gp('slide') });
    slider(b, { p: 'vpan', label: 'Speed Y', cls: 'bip', fmt: bipf, reset: 128, show: () => gp('slide') });
    slider(b, { p: 'zoom', label: 'Pixelate', fmt: pix, reset: 0 });
  },
  freeze(b) {
    seg(b, { p: 'freezeMode', opts: [[0, 'Live'], [1, 'Strobe'], [2, 'Burst'], [3, 'Single'], [4, 'Music']] });
    slider(b, { p: 'rate2', label: 'Rate', fmt: pct, reset: 128, show: () => gp('freezeMode') === 1 || gp('freezeMode') === 2 });
    slider(b, { p: 'depth', label: 'Sensitivity', cls: 'bip', fmt: bipf, reset: 200, show: () => gp('freezeMode') === 4 });
    const fb = buttons(b, [{ label: 'Freeze', run: () => press('freeze') }], 1);
    binds.push(() => { fb.firstChild.textContent = gp('freezeMode') === 3 ? 'Grab a frame' : (gp('freeze') ? 'Release freeze' : 'Freeze'); fb.firstChild.classList.toggle('on', !!gp('freeze') && gp('freezeMode') !== 3); });
    note(b, 'Live grabs every field. Strobe and Burst grab at the Rate. Single grabs only when you press the button (or F). Music grabs on bass hits.');
  },
  // what goes behind a keyed subject
  keyBg(b) {
    const node = CUR;
    const bgOf = () => node.bg || (chain.getParam(node, 'display') === 5 && chain.getParam(node, 'digSrc') ? 'v2' : 'black');
    const fillColour = () => { act(node, { k: 'storeFill', c: hsvRgb(chain.getParam(node, 'hue') / 255, chain.getParam(node, 'sat') / 255, chain.getParam(node, 'val') / 255) }); };
    const set = (bg) => {
      node.bg = bg;
      if (bg === 'v2') { setNodeParam(node, 'display', 5); setNodeParam(node, 'digSrc', 1); setNodeParam(node, 'colourize', 0); if (!src.v2) toast('Import Video 2 from the top bar'); }
      else { setNodeParam(node, 'display', 2); setNodeParam(node, 'digSrc', 0); if (bg === 'black') act(node, { k: 'storeFill', c: [0, 0, 0] }); if (bg === 'colour') fillColour(); if (bg === 'canvas') toast('Paint, fill or freeze into this block to build the background'); }
      uiDirty = true;
    };
    const el = h(`<div class="field" style="grid-template-columns:88px minmax(0,1fr)"><span>Background</span><div class="seg"><button type="button" data-v="black">Black</button><button type="button" data-v="colour">Colour</button><button type="button" data-v="v2">Video 2</button><button type="button" data-v="canvas">Canvas</button></div></div>`);
    el.querySelector('.seg').onclick = (e) => { const x = e.target.closest('button'); if (x) set(x.dataset.v); };
    const cc = h(`<label class="field"><span>Colour</span><input type="color"></label>`);
    const ci = cc.querySelector('input');
    ci.oninput = () => { const [hh, s, v] = hexHsv(ci.value); setNodeParam(node, 'hue', Math.round(hh * 255)); setNodeParam(node, 'sat', Math.round(s * 255)); setNodeParam(node, 'val', Math.round(v * 255)); fillColour(); };
    binds.push(() => { const bg = bgOf(); el.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === bg)); cc.hidden = bg !== 'colour'; if (document.activeElement !== ci) ci.value = hsvHex(chain.getParam(node, 'hue') / 255, chain.getParam(node, 'sat') / 255, chain.getParam(node, 'val') / 255); });
    b.appendChild(el); b.appendChild(cc);
    note(b, 'Tip: put Chroma key first in the chain, then add effects after it (Trail, Colorize, VHS…) to treat the whole composite.');
  },
  shatterRate(b) { toggle(b, { p: 'shatter', label: 'Flicker' }); slider(b, { p: 'rate2', label: 'Rate', fmt: pct, reset: 200 }); },
  key(b) {
    seg(b, { p: 'stencilSource', label: 'Key from', opts: [[2, 'Picture'], [1, 'Video 2'], [0, 'Painted']] });
    seg(b, { p: 'keyMode', label: 'Key on', opts: [[0, 'Colour'], [1, 'Brightness']], show: keyed });
    const kc = h(`<label class="field" style="grid-template-columns:88px minmax(0,1fr) auto"><span>Backdrop</span><input type="color"><button type="button" class="gbtn">Pick</button></label>`);
    const kci = kc.querySelector('input');
    kci.oninput = () => sp('keyHue', Math.round(hexHsv(kci.value)[0] * 360));
    kc.querySelector('button').onclick = (e) => { e.preventDefault(); pickKeyArmed = true; uiDirty = true; toast('Click the background in the picture'); };
    buttons(b, [{ label: 'Detect backdrop automatically', run: () => detectKey(CUR, true) }], 1);
    binds.push(() => { kc.hidden = !keyed(); kci.hidden = gp('keyMode') !== 0; if (document.activeElement !== kci) kci.value = hsvHex(gp('keyHue') / 360, 0.85, 0.85); });
    b.appendChild(kc);
    slider(b, { p: 'keyTol', label: 'Tolerance', fmt: pct, reset: 70, show: () => keyed() && gp('keyMode') === 0 });
    slider(b, { p: 'keySat', label: 'Min saturation', fmt: pct, reset: 60, show: () => keyed() && gp('keyMode') === 0 });
    slider(b, { p: 'keyLuma', label: 'Threshold', fmt: pct, reset: 128, show: () => (keyed() && gp('keyMode') === 1) || gp('stencilSource') === 1 });
    toggle(b, { p: 'keyInvert', label: 'Swap subject / background', show: () => gp('stencilSource') !== 0 });
    {
      slider(b, { p: 'keyEdge', label: 'Edge detail', fmt: (v) => (v === 0 ? 'CVI' : Math.round(v / 2.55) + '%'), reset: 0, show: () => gp('stencilSource') !== 0 });
      note(b, 'Edge detail: 0 is the original blocky CVI edge. Raise it and the edge gets gradually finer, up to full resolution at 100%.', () => gp('stencilSource') !== 0);
    }
    note(b, 'The key decides which part is the subject. The original CVI keyed on a blue backdrop; on other footage use Pick from video and click your background (a plain wall works best).', keyed);
  },
  mask(b) {
    toggle(b, { p: 'useStencil', label: 'Use mask' });
    select_(b, { p: 'stencilSource', label: 'Mask from', opts: [[0, 'Painted mask'], [2, 'Key (colour/brightness)'], [1, 'Video 2 brightness'], [3, 'Painted ∩ key']] });
    toggle(b, { p: 'invertStencil', label: 'Invert' });
    toggle(b, { p: 'shatter', label: 'Flicker', hint: 'invert at Rate' });
    toggle(b, { p: 'stencilShow', label: 'Highlight painted mask' });
    sub(b, 'Key', () => gp('stencilSource') !== 0);
    seg(b, { p: 'keyMode', label: 'Key on', opts: [[0, 'Colour'], [1, 'Brightness']], show: keyed });
    slider(b, { p: 'keyHue', label: 'Key hue', min: 0, max: 360, fmt: (v) => v + '°', reset: 225, show: () => keyed() && gp('keyMode') === 0 });
    slider(b, { p: 'keyTol', label: 'Tolerance', fmt: pct, reset: 70, show: () => keyed() && gp('keyMode') === 0 });
    slider(b, { p: 'keySat', label: 'Min saturation', fmt: pct, reset: 60, show: () => keyed() && gp('keyMode') === 0 });
    slider(b, { p: 'keyLuma', label: 'Threshold', fmt: pct, reset: 128, show: () => (keyed() && gp('keyMode') === 1) || gp('stencilSource') === 1 });
    toggle(b, { p: 'keyInvert', label: 'Invert key', show: () => gp('stencilSource') !== 0 });
    slider(b, { p: 'keyEdge', label: 'Edge', fmt: (v) => (v === 0 ? 'Blocky' : Math.round(v / 2.55) + '%'), reset: 0, show: () => gp('stencilSource') === 1 || gp('stencilSource') === 2 });
    buttons(b, [{ label: 'Pick key from video', run: () => { pickKeyArmed = true; toast('Click the background in the picture'); } }], 1);
    SECTIONS.maskTools(b);
  },
  maskTools(b) {
    sub(b, 'Mask tools');
    seg(b, { p: 'stencilErase', label: 'Tools will', opts: [[0, 'Add'], [1, 'Erase']] });
    const sw = (i) => () => { pushUndo(CUR); sp('stencilWipe', i); press('wipeStencil'); };
    buttons(b, [
      { label: 'Clear mask', run: () => { pushUndo(CUR); doAct({ k: 'stencilFill', v: 0 }); } }, { label: 'Fill mask', run: () => { pushUndo(CUR); doAct({ k: 'stencilFill', v: 1 }); } }, { label: 'Texture', run: sw(1) },
      { label: 'Sweep →', run: sw(2) }, { label: 'Sweep ↓', run: sw(3) }, { label: 'Invert sweep', run: sw(4) },
      { label: 'Find edges', run: sw(5) }, { label: 'Find colour', run: sw(6) }, { label: 'Boil', run: sw(7) },
      { label: 'Window', title: 'Rectangle from Position, Pixelate (size) and Stretch', run: sw(8) }, { label: 'Stop', stop: true, run: () => press('stop') },
    ]);
  },
  pattern(b) {
    const tx = h(`<div class="swatches">${MENUS.texture.map((n, i) => `<button type="button" data-i="${i}" title="${n}"><img alt="${n}" src="${textureURL(i)}"></button>`).join('')}</div>`);
    tx.onclick = (e) => { const x = e.target.closest('button'); if (!x) return; sp('texture', +x.dataset.i); sp('stencilWipe', 1); press('wipeStencil'); };
    binds.push(() => tx.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', gp('texture') === i)));
    b.appendChild(tx);
    toggle(b, { p: 'invertStencil', label: 'Invert pattern' });
  },
  scan(b) {
    const run = (wipe) => () => { pushUndo(CUR); press('stop'); doAct({ k: 'stencilFill', v: 1 }); sp('stencilErase', 1); sp('stencilWipe', wipe); press('wipeStencil'); };
    buttons(b, [{ label: 'Run across', primary: true, run: run(2) }, { label: 'Run down', run: run(3) }, { label: 'Disintegrate', run: run(7) }, { label: 'Reset', run: () => { press('stop'); doAct({ k: 'stencilFill', v: 1 }); } }], 2);
    note(b, 'Sweeps one column (or row) per field, like the hardware. Record it to place it on the timeline.');
  },
  tunnel(b) {
    buttons(b, [{ label: 'Start tunnel', primary: true, run: () => { sp('colourWipe', 6); press('wipeColour'); } }, { label: 'Stop', stop: true, run: () => press('stop') }], 2);
    seg(b, { p: 'colourCtl', label: 'Colours', opts: [[0, 'Fixed'], [1, 'Music'], [2, 'Cycle'], [3, 'B&W']] });
    slider(b, { p: 'zoom', label: 'Ring width', fmt: pct, reset: 40 });
    slider(b, { p: 'hpan', label: 'Centre X', fmt: pct, reset: 128 });
    slider(b, { p: 'vpan', label: 'Centre Y', fmt: pct, reset: 128 });
  },
  inputs(b) {
    note(b, src.v2 ? `Video 2: ${esc(src.v2.name)}` : 'Import Video 2 from the top bar (+ Video 2) for this effect.');
    seg(b, { p: 'digSrc', label: 'CVI video', opts: [[0, 'Video 1'], [1, 'Video 2']] });
    seg(b, { p: 'anaSrc', label: 'Clean video', opts: [[0, 'Video 1'], [1, 'Video 2']] });
    seg(b, { p: 'keySrc', label: 'Key from', opts: [[0, 'Video 1'], [1, 'Video 2']] });
  },
  paint(b) {
    const pc = h(`<div class="paintcol"><div class="chipcol"></div><input type="color" aria-label="Paint colour"></div>`);
    const pci = pc.querySelector('input'), chip = pc.querySelector('.chipcol');
    pci.oninput = () => { const [hh, s, v] = hexHsv(pci.value); sp('hue', Math.round(hh * 255)); sp('sat', Math.round(s * 255)); sp('val', Math.round(v * 255)); };
    binds.push(() => { const c = hsvHex(gp('hue') / 255, gp('sat') / 255, gp('val') / 255); chip.style.background = c; if (document.activeElement !== pci) pci.value = c; });
    b.appendChild(pc);
    seg(b, { p: 'colourCtl', label: 'Colour', opts: [[0, 'Fixed'], [1, 'Music'], [2, 'Cycle'], [3, 'B&W']] });
    sub(b, 'Brush');
    const br = h(`<div class="brushes">${MENUS.brush.map((n, i) => `<button type="button" data-i="${i}" title="${n}"><canvas width="32" height="32"></canvas></button>`).join('')}</div>`);
    br.querySelectorAll('canvas').forEach((c, i) => drawBrushIcon(c, i));
    br.onclick = (e) => { const x = e.target.closest('button'); if (x) sp('brush', +x.dataset.i); };
    binds.push(() => br.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', gp('brush') === i)));
    b.appendChild(br);
    select_(b, { p: 'paintType', label: 'Style', opts: ['Solid', 'Spatter', 'Mottled', 'Fade left→right', 'Fade top→bottom', 'Rainbow by position'].map((n, i) => [i, n]) });
    select_(b, { p: 'colourType', label: 'Blend', opts: [[0, 'Normal'], [1, 'Tint (add)'], [2, 'Watercolour'], [3, 'Shade'], [4, 'Range (clamp)'], [5, 'Solarize'], [6, 'Monochrome'], [7, 'Posterize'], [8, 'Spectrum']] });
    slider(b, { p: 'depth', label: 'Blend strength', cls: 'bip', fmt: bipf, reset: 200, show: () => gp('colourType') > 0 });
    select_(b, { p: 'symmetry', label: 'Symmetry', opts: ['Off', 'Mirror ↔', 'Mirror ↕', 'Flip only', '4-way', 'Diagonal', 'Kaleidoscope (8)', 'Rotate 90° (4)', 'Spin 180°'].map((n, i) => [i, n]) });
    toggle(b, { p: 'useTexture', label: 'Paint through texture' });
    const tx = h(`<div class="swatches">${MENUS.texture.map((n, i) => `<button type="button" data-i="${i}" title="${n}"><img alt="${n}" src="${textureURL(i)}"></button>`).join('')}</div>`);
    tx.onclick = (e) => { const x = e.target.closest('button'); if (x) sp('texture', +x.dataset.i); };
    binds.push(() => { tx.hidden = !gp('useTexture'); tx.querySelectorAll('button').forEach((x, i) => x.classList.toggle('on', gp('texture') === i)); });
    b.appendChild(tx);
    toggle(b, { p: 'drawUnder', label: 'Respect mask' });
    toggle(b, { p: 'dejag', label: 'Smooth edges' });
  },
  fill(b) {
    const cw = (i) => () => { pushUndo(CUR); sp('colourWipe', i); press('wipeColour'); };
    buttons(b, [
      { label: 'White', run: cw(0) }, { label: 'Solid colour', run: cw(1) }, { label: 'Texture', run: cw(2) },
      { label: 'Sweep →', run: cw(3) }, { label: 'Sweep ↓', run: cw(4) }, { label: 'Recolour all', run: cw(5) },
      { label: 'Colour tunnel', run: cw(6) }, { label: 'Disintegrate', run: cw(7) }, { label: 'Stop', stop: true, run: () => press('stop') },
      { label: 'Clear', run: () => { pushUndo(CUR); doAct({ k: 'storeFill', c: [0, 0, 0] }); } }, { label: 'Colour bars', run: () => { pushUndo(CUR); doAct({ k: 'pattern', v: 'bars' }); } }, { label: 'Test pattern', run: () => { pushUndo(CUR); doAct({ k: 'pattern', v: 'test' }); } },
    ]);
  },
  text(b) {
    const node = CUR;
    const ta = h(`<textarea rows="2" maxlength="160" aria-label="Text"></textarea>`);
    ta.oninput = () => setNodeParam(node, 'title', ta.value.toUpperCase());
    binds.push(() => { if (document.activeElement !== ta) ta.value = chain.getParam(node, 'title'); });
    b.appendChild(ta);
    seg(b, { p: 'titleSize', label: 'Size', opts: [1, 2, 3, 4, 5].map((s) => [s, String(s)]) });
    select_(b, { p: 'titleFormat', label: 'Style', opts: MENUS.titleFormat.map((n, i) => [i, n]) });
    buttons(b, [{ label: 'Place text on picture', run: () => selectTool('text') }], 1);
  },
  look(b, look) {
    for (const [key, label, a, bb, step] of LOOK_UI[look]) {
      if (a === 'sel') { if (bb.length <= 4) seg(b, { p: key, label, opts: bb.map((o, i) => [i, o]) }); else select_(b, { p: key, label, opts: bb.map((o, i) => [i, o]) }); }
      else if (a === 'col') {
        const node = CUR;
        const el = h(`<label class="field"><span>${label}</span><input type="color"></label>`);
        const ci = el.querySelector('input');
        ci.oninput = () => setNodeParam(node, key, [1, 3, 5].map((i) => parseInt(ci.value.slice(i, i + 2), 16) / 255));
        binds.push(() => { if (document.activeElement !== ci) ci.value = '#' + chain.getParam(node, key).map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''); });
        b.appendChild(el);
      } else slider(b, { p: key, label, min: a, max: bb, step, reset: LOOK_DEFAULTS[look][key] });
    }
  },
};
const SECTION_TITLES = { keyBg: 'Background', mode: 'Routing', color: 'Color', colourSource: 'Colour', colourSpeed: 'Crawl', pixelate: 'Pixels', transform: 'Transform', mirror: 'Mirror', scroll: 'Scroll', freeze: 'Freeze & strobe', shatterRate: 'Flicker', key: 'Key', mask: 'Mask', pattern: 'Pattern', scan: 'Scan', tunnel: 'Tunnel', inputs: 'Video 2', paint: 'Paint & brush', fill: 'Fill canvas', text: 'Text' };
const ALL = ['mode', 'color', 'freeze', 'transform', 'mask', 'paint', 'fill', 'text', 'inputs'];
const showAll = new Set();
function buildProjectPanel() {
  const b = h('<div class="ctop"></div>'); HOST.appendChild(b);
  const dt = h(`<div class="field" style="grid-template-columns:88px minmax(0,1fr)"><span>Pixel detail</span><div class="seg"><button type="button" data-v="0">Original</button><button type="button" data-v="1">Fine</button><button type="button" data-v="2">Extra fine</button></div></div>`);
  dt.querySelector('.seg').onclick = (e) => { const x = e.target.closest('button'); if (!x) return; settings.detail = +x.dataset.v; rebuildGrid(); toast(`Pixel grid ${chain.W} × ${chain.H}`); uiDirty = true; };
  const tg = (label, key, hint) => { const el = h(`<div class="row"><label>${label}${hint ? ` <span class="desc">${hint}</span>` : ''}</label><button type="button" class="switch" role="switch" aria-label="${label}"></button></div>`); el.querySelector('.switch').onclick = () => { settings[key] = settings[key] ? 0 : 1; uiDirty = true; }; binds.push(() => el.querySelector('.switch').setAttribute('aria-checked', settings[key] ? 'true' : 'false')); return el; };
  const fr = h(`<div class="field" style="grid-template-columns:88px minmax(0,1fr)"><span>Field clock</span><div class="seg"><button type="button" data-v="50">50 Hz PAL</button><button type="button" data-v="60">60 Hz NTSC</button></div></div>`);
  fr.querySelector('.seg').onclick = (e) => { const x = e.target.closest('button'); if (!x) return; fieldRate = +x.dataset.v; syncFieldToTime(curTime()); toast(`Field clock ${fieldRate} Hz`); uiDirty = true; };
  binds.push(() => { dt.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.v === settings.detail)); fr.querySelectorAll('button').forEach((x) => x.classList.toggle('on', +x.dataset.v === fieldRate)); });
  b.appendChild(dt); b.appendChild(tg('Smooth pixels', 'smooth', 'soft blocks')); b.appendChild(tg('Hardware borders', 'blanking', 'extended blanking')); b.appendChild(fr);
  const gi = note(b, ''); binds.push(() => { gi.textContent = `Each CVI unit's field store is ${chain.W} × ${chain.H}, shaped to your video. Original is the real CVI resolution; finer grids look cleaner but work your computer harder (export is never affected). The field clock sets how fast rates, strobes and sweeps run: the original was PAL, 50 fields a second.`; });
}
function textureURL(i) {
  const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'); const im = x.createImageData(32, 32);
  for (let y = 0; y < 32; y++) for (let z = 0; z < 32; z++) { const v = texel(i, z, y) ? 230 : 30; const o = (y * 32 + z) * 4; im.data[o] = im.data[o + 1] = im.data[o + 2] = v; im.data[o + 3] = 255; }
  x.putImageData(im, 0, 0); return c.toDataURL();
}
function drawBrushIcon(c, i) {
  const g = c.getContext('2d'); g.fillStyle = '#e8e8ec';
  const t = new CVI(32); t.P.brush = i; t.P.colourType = 0; t.P.dejag = 0; t.P.hue = 0; t.P.sat = 0; t.P.val = 255; t.buildMaps(); t.stamp(16, 16);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (t.store[(y * 32 + x) * 3]) g.fillRect(x, y, 1, 1);
}

// ================================================================ sync
function syncUI() {
  for (const f of binds) f();
  for (const b of document.querySelectorAll('.tool[data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  const pn = paintNode(false), e = pn && chain.engine(pn.id);
  const tgt = e ? (e.P.drawColour && e.P.drawStencil ? 'b' : e.P.drawStencil ? 'm' : 'c') : '';
  for (const b of document.querySelectorAll('#paintTarget button')) b.classList.toggle('on', b.dataset.t === tgt);
  const hints = { pointer: '', text: 'Click to place text', pick: 'Click to pick a colour', fill: 'Fills the area bounded by the mask', cut: 'Drag a box, then click to paste', copy: 'Copies live video into the masked area' };
  $('toolHint').textContent = (hints[tool] ?? (tool === 'brush' || tool === 'dots' ? 'Drag to paint' : 'Drag to draw')) + (pn && tool !== 'pointer' ? ` · into "${pn.name}"` : '');
  screenEl.classList.toggle('painting', tool !== 'pointer' || pickKeyArmed);
  const sn = selNode(), se = sn && chain.engine(sn.id);
  const single = se && (se.P.freezeMode === 3 || se.P.freezeMode === 5);
  $('btnFreeze').textContent = single ? 'Grab frame' : 'Freeze';
  $('btnFreeze').classList.toggle('on', !!(se && !single && se.P.freeze));
  $('btnRec').classList.toggle('on', recArm); $('btnRec').classList.toggle('live', recording());
  $('btnLoop').classList.toggle('on', loop);
  $('playIcon').innerHTML = playing ? '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>' : '<path d="M4 2l10 6-10 6z"/>';
  const lanes = auto.lanes.size + (auto.events.length ? 1 : 0);
  $('autoCount').textContent = lanes ? `(${lanes})` : '';
  $('tlNote').textContent = recording() ? 'Recording: every change is written to the timeline.' : recArm ? 'Armed. Press play to record.' : 'Press Record, then play: every change you make is replayed on export.';
}
let toastTimer;
function toast(m) { const t = $('toast'); t.textContent = m; t.style.opacity = 1; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.opacity = 0; }, 2200); }

// ================================================================ automation timeline
const tl = $('timeline'), tctx = tl.getContext('2d');
const LABEL_W = 170, RULER_H = 20, ROW_H = 18;
const PARAM_LABELS = { hue: 'Hue', sat: 'Saturation', val: 'Brightness', depth: 'Intensity', rate1: 'Speed', rate2: 'Rate', hpan: 'Position X', vpan: 'Position Y', stretch: 'Stretch', zoom: 'Pixelate', display: 'Routing', colourize: 'Colorize', colourizeType: 'Colour style', freezeMode: 'Freeze mode', freeze: 'Freeze', useStencil: 'Mask on', invertStencil: 'Invert', stencilSource: 'Mask from', bypass: 'On/off', mix: 'Amount' };
function laneList() { const l = [...auto.lanes.keys()].filter((x) => chain.get(x.split('|')[0])); if (auto.events.length) l.push('#events'); return l; }
function laneLabel(l) {
  if (l === '#events') return 'Buttons / paint / presets';
  const [id, k] = l.split('|'); const n = chain.get(id);
  return `${n ? n.name : '?'}: ${PARAM_LABELS[k] || k.replace(/([A-Z])/g, ' $1').toLowerCase()}`;
}
function drawTimeline() {
  const lanes = laneList();
  const cssH = Math.max(120, RULER_H + 6 + lanes.length * ROW_H + 6);
  const dpr = window.devicePixelRatio || 1, cssW = tl.clientWidth;
  const H = Math.min(cssH, 220);
  if (tl.width !== Math.round(cssW * dpr) || tl.height !== Math.round(H * dpr)) { tl.style.height = H + 'px'; tl.width = Math.round(cssW * dpr); tl.height = Math.round(H * dpr); }
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
  if (!lanes.length && dur) { g.fillStyle = '#6c6e78'; g.fillText('Nothing recorded yet. Press Record, then play, and move any control.', LABEL_W, RULER_H + 24); }
  lanes.forEach((lane, i) => {
    const y = RULER_H + 6 + i * ROW_H; if (y > H) return;
    g.fillStyle = i % 2 ? '#131417' : '#16171a'; g.fillRect(0, y, cssW, ROW_H);
    g.fillStyle = '#c9cad1'; g.fillText(laneLabel(lane).slice(0, 25), 8, y + ROW_H / 2);
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
}
function updateTC() { const t = curTime(), dur = duration(); $('tc').innerHTML = `${fmtShort(t)}<small>.${String(Math.floor((t % 1) * 100)).padStart(2, '0')}</small>${dur ? ` <small>/ ${fmtShort(dur)}</small>` : ''}`; }
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
  if (presetKeys !== null && /^[0-9]$/.test(k)) { presetKeys += k; if (presetKeys.length === 2) { applyPreset(+presetKeys); presetKeys = null; } e.preventDefault(); return; }
  const tt = TOOLS.find((t) => t !== 'sep' && t[3] === k);
  if (tt) { selectTool(tt[0]); return; }
  switch (k) {
    case ' ': e.preventDefault(); playing ? pause() : play(); break;
    case 'f': $('btnFreeze').click(); break;
    case 'escape': { const n = selNode(); if (n && chain.engine(n.id)) act(n, { k: 'press', b: 'stop' }); pickKeyArmed = false; selectTool('pointer'); break; }
    case 'p': presetKeys = ''; toast('Type a two-digit preset number'); break;
    case 'home': home(); break;
    case 'arrowleft': seek(curTime() - (e.shiftKey ? 5 : 1)); break;
    case 'arrowright': seek(curTime() + (e.shiftKey ? 5 : 1)); break;
    case '[': { const n = paintNode(false); if (n) setNodeParam(n, 'brush', Math.max(0, chain.getParam(n, 'brush') - 1)); break; }
    case ']': { const n = paintNode(false); if (n) setNodeParam(n, 'brush', Math.min(15, chain.getParam(n, 'brush') + 1)); break; }
  }
});

// ================================================================ project files
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
function packSnap(s) { const o = clone({ ...s, engines: undefined }); o.engines = {}; for (const [id, e] of Object.entries(s.engines || {})) o.engines[id] = { ...e, store: b64(e.store), stencil: b64(e.stencil), cascade: b64(e.cascade), clip: null }; return o; }
function unpackSnap(o) { const s = { ...o, engines: {} }; for (const [id, e] of Object.entries(o.engines || {})) s.engines[id] = { ...e, store: unb64(e.store), stencil: unb64(e.stencil), cascade: unb64(e.cascade), clip: null }; return s; }
// deep copy of a chain snapshot that keeps typed arrays
function clone_(s) { const o = clone({ ...s, engines: undefined }); o.engines = {}; for (const [id, e] of Object.entries(s.engines || {})) o.engines[id] = { ...e, store: e.store.slice(), stencil: e.stencil.slice(), cascade: e.cascade.slice(), P: { ...e.P }, g: { ...e.g }, procs: clone(e.procs), tunnelHist: e.tunnelHist.slice(), picked: [...e.picked], randColour: [...e.randColour], randPaint: [...e.randPaint], clip: null }; return o; }
$('btnSave').onclick = () => {
  const proj = { app: 'CVI-84', version: 4, fieldRate, settings: { ...settings }, chain: packSnap(exportBase()), automation: auto.toJSON() };
  download(new Blob([JSON.stringify(proj)], { type: 'application/json' }), (src.v1 ? src.v1.name.replace(/\.[^.]+$/, '') : 'cvi-84') + '.cvi84.json');
  toast('Project saved');
};
$('btnOpen').onclick = () => $('fileProj').click();
$('fileProj').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const p = JSON.parse(await f.text());
    if (p.app !== 'CVI-84' || !p.chain) throw new Error('Not a CVI-84 chain project (projects saved before the chain editor can\'t be opened here)');
    fieldRate = p.fieldRate || 50; Object.assign(settings, p.settings || {});
    const [w, h] = gridFor(...srcDims(), settings.detail);
    chain = Chain.from(unpackSnap(p.chain), w, h);
    startSnap = chain.snapshot();
    auto = Automation.fromJSON(p.automation || {});
    selected = chain.nodes[0]?.id || null;
    syncFieldToTime(curTime());
    stripDirty = inspDirty = uiDirty = true;
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
  const ch = Chain.from(clone_(exportBase()), chain.W, chain.H); ch.setField(0);
  const au = Automation.fromJSON(clone(auto.toJSON()));
  const canvas = new OffscreenCanvas(wid, hgt);
  const R = new Renderer(canvas, 256); R.resize(wid, hgt);
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
        const target = Math.floor(t * fieldRate + 1e-6);
        const vf = sample.toVideoFrame(); R.uploadSource('analog', vf); vf.close();
        let has2 = false;
        if (sink2) { const s2 = await sink2.getSample(t % v2dur); if (s2) { s2.draw(v2canvas.getContext('2d'), 0, 0, v2canvas.width, v2canvas.height); s2.close(); R.uploadSource('v2', v2canvas); has2 = true; } }
        applyLookAuto(target, ch, au);
        const adv = (e, node, inputs) => { while (e.field <= target) { applyNodeAuto(node, e.field, au, ch); if (inputs) e.step(inputs, audioAt(e.field)); else e.field++; } };
        const tex = renderChain(ch, R, { advance: adv, hasV2: has2, frame: target, blanking: settings.blanking, smooth: settings.smooth });
        R.present(tex);
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
buildLib();
buildPresets();
// start blank: no video, no effects
{ const g = demo.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, demo.width, demo.height); }
selected = null;
fitPreview();
requestAnimationFrame(tick);
window.__cvi = { get chain() { return chain; }, get auto() { return auto; }, addBlock, select, applyPreset, setNodeParam, play, pause, seek, importVideo, loadVideo, runExport, selectTool, removeBlock };
