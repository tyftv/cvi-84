// Effect chain: a list of effect blocks applied in order, Video 1 -> ... -> Output.
// Each CVI block is its own CVI unit, cascaded into the next (the way real CVIs were chained);
// look blocks (B&W, Halftone, VHS, CRT) are GPU passes that can sit anywhere in the chain.
// Nodes carry ids and an `in` reference so a node-graph view can be layered on later.
import { CVI, defaultParams } from './cvi-engine.js';
import { LOOK_DEFAULTS } from './gl.js';

const allOn = { useStencil: 1, stencilSource: 0, invertStencil: 1 };
const clearStencil = [{ k: 'stencilFill', v: 0 }];
const key = { useStencil: 1, stencilSource: 2 };

// sections: which inspector groups a block shows by default (every CVI block can reveal all settings)
export const MODULES = {
  colorize: { name: 'Colorize', cat: 'Color', kind: 'cvi', desc: 'The CVI\'s palette remap: spectrum false colour, solarize, sepia, posterize, negatives. Also digitises the picture to the CVI grid.', p: { display: 5, colourize: 1, colourizeType: 7, depth: 255, hue: 0, sat: 0, val: 160 }, sections: ['color', 'pixelate'] },
  pixelate: { name: 'Pixelate', cat: 'Shape', kind: 'cvi', desc: 'Chunky CVI pixels. Pixelate sets the block size, Stretch makes them wide or tall.', p: { display: 5, zoom: 120 }, sections: ['transform'] },
  mirror: { name: 'Mirror', cat: 'Shape', kind: 'cvi', desc: 'Left/right, top/bottom or four-way mirror of the frame buffer. Position moves the mirror line.', p: { display: 7, ...allOn, vmirror: 1 }, enter: clearStencil, sections: ['mirror', 'freeze'] },
  scroll: { name: 'Scroll', cat: 'Shape', kind: 'cvi', desc: 'The picture slides and wraps around endlessly. Position X/Y set the scroll speed and direction.', p: { display: 7, ...allOn, slide: 1, hpan: 150, vpan: 128 }, enter: clearStencil, sections: ['scroll', 'freeze'] },
  trail: { keyed: true, name: 'Trail', cat: 'Time', kind: 'cvi', desc: 'The keyed subject plays live and leaves frozen copies of itself. Pick the background colour with the eyedropper in Key.', p: { display: 4, ...key }, sections: ['key', 'freeze', 'scroll'] },
  colourtrail: { keyed: true, name: 'Colour trail', cat: 'Time', kind: 'cvi', desc: 'Like Trail, but the subject leaves a splash of changing colour.', p: { display: 10, ...key, colourizeCtl: 3, rate1: 230 }, sections: ['key', 'colourSource', 'freeze'] },
  strobe: { name: 'Strobe', cat: 'Time', kind: 'cvi', desc: 'Grabs a frame at the Rate and holds it. Burst grabs a run then holds; Music grabs on bass hits.', p: { display: 7, ...allOn, freezeMode: 1, rate2: 170 }, enter: clearStencil, sections: ['freeze'] },
  ghost: { name: 'Ghost', cat: 'Time', kind: 'cvi', desc: 'Double exposure of a held frame and the live picture.', p: { display: 12, ...allOn, freezeMode: 1, rate2: 140 }, enter: clearStencil, sections: ['freeze'] },
  catchup: { keyed: true, name: 'Catch-up', cat: 'Time', kind: 'cvi', desc: 'The keyed subject plays live with a delayed, strobed copy of the scene behind it.', p: { display: 9, ...key, freezeMode: 1, rate2: 170 }, sections: ['key', 'freeze'] },
  feedback: { name: 'Feedback', cat: 'Time', kind: 'cvi', desc: 'The CVI\'s own output fed back into itself, like cascading a second unit. Pixelate and Scroll turn it into tunnels and smears.', p: { display: 19, ...allOn, zoom: 25 }, enter: clearStencil, sections: ['transform', 'freeze'] },
  crawl: { keyed: true, name: 'Colour crawl', cat: 'Color', kind: 'cvi', desc: 'A trail whose colours pulse and crawl.', p: { display: 18, ...key, rate1: 210 }, sections: ['key', 'colourSpeed'] },
  pattern: { name: 'Pattern colourize', cat: 'Color', kind: 'cvi', desc: 'Colourizes through a sliding pattern: grid, hearts, checkerboard, diagonals.', p: { display: 15, useStencil: 1, slide: 1, hpan: 150, colourize: 1, colourizeType: 7, depth: 255, texture: 7, stencilWipe: 1 }, enter: [{ k: 'press', b: 'wipeStencil' }], sections: ['pattern', 'color', 'scroll'] },
  shatter: { name: 'Shatter', cat: 'Color', kind: 'cvi', desc: 'Flickers a pattern between the clean and the colourized picture at the Rate.', p: { display: 15, useStencil: 1, shatter: 1, rate2: 210, colourize: 1, colourizeType: 4, depth: 240, texture: 1, stencilWipe: 1 }, enter: [{ k: 'press', b: 'wipeStencil' }], sections: ['pattern', 'shatterRate', 'color'] },
  slowscan: { name: 'Slow scan', cat: 'Time', kind: 'cvi', desc: 'Freezes the picture one column (or row) at a time, so motion smears across the frame. Press Run scan.', p: { display: 3, useStencil: 1, stencilErase: 1, stencilWipe: 2 }, enter: [{ k: 'stencilFill', v: 1 }, { k: 'press', b: 'wipeStencil' }], sections: ['scan'] },
  paint: { name: 'Paint layer', cat: 'Paint', kind: 'cvi', desc: 'Draw, fill and write text over the video with the CVI paintbox. Pick a tool above the viewer.', p: { display: 2, ...allOn, drawColour: 1, drawStencil: 1, brush: 4, sat: 255 }, enter: clearStencil, sections: ['paint', 'fill', 'text'] },
  tunnel: { keyed: true, name: 'Colour tunnel', cat: 'Paint', kind: 'cvi', desc: 'Rings of colour radiating from the centre behind the keyed subject.', p: { display: 2, ...key, colourWipe: 6, colourCtl: 2, zoom: 40 }, enter: [{ k: 'press', b: 'wipeColour' }], sections: ['key', 'tunnel'] },
  keyer: { keyer: true, name: 'Chroma key', cat: 'Key', kind: 'cvi', desc: 'Swaps the background: keys out your backdrop and puts black, a colour, Video 2 or the canvas behind you. Effects like Trail have their own key built in, so you only need this to change the background.', p: { display: 2, ...key }, enter: [{ k: 'storeFill', c: [0, 0, 0] }], sections: ['keyBg', 'key'] },
  lumakey: { keyer: true, name: 'Luma key', cat: 'Key', kind: 'cvi', desc: 'Keys on brightness instead of colour: keeps everything brighter (or darker) than the threshold.', p: { display: 2, ...key, keyMode: 1, keyLuma: 128 }, enter: [{ k: 'storeFill', c: [0, 0, 0] }], sections: ['keyBg', 'key'] },
  wipe: { name: 'Wipe to Video 2', cat: 'Video 2', kind: 'cvi', desc: 'Transition from this video to Video 2: sweep across, down or disintegrate.', p: { display: 15, useStencil: 1, digSrc: 1, stencilErase: 1, stencilWipe: 2 }, enter: [{ k: 'stencilFill', v: 1 }, { k: 'press', b: 'wipeStencil' }], sections: ['scan', 'inputs'] },
  double: { name: 'Double exposure', cat: 'Video 2', kind: 'cvi', desc: 'Blends this video with Video 2 through the frame buffer.', p: { display: 12, ...allOn, digSrc: 1 }, enter: clearStencil, sections: ['freeze', 'inputs'] },
  flip: { name: 'Video 1/2 flip', cat: 'Video 2', kind: 'cvi', desc: 'Flickers between this video and Video 2 at the Rate.', p: { display: 15, ...allOn, digSrc: 1, shatter: 1, rate2: 160 }, enter: clearStencil, sections: ['shatterRate', 'inputs'] },
  unit: { name: 'CVI unit', cat: 'Advanced', kind: 'cvi', desc: 'A whole CVI with every setting exposed. Presets load into one of these.', p: { display: 5 }, sections: ['all'] },
  datamosh: { name: 'Datamosh', cat: 'Glitch', kind: 'look', look: 'mosh', desc: 'The picture stops refreshing and the new movement drags the old image around, like a video file with its keyframes deleted. Hit Mosh, or let it mosh at every cut.' },
  bw: { name: 'Black & white', cat: 'Look', kind: 'look', look: 'bw', desc: 'Film stock with filters, grain and toning (sepia, cyanotype…).' },
  halftone: { name: 'Halftone', cat: 'Look', kind: 'look', look: 'halftone', desc: 'Printed dots: mono, CMYK or colour, round, line or square screens.' },
  vhs: { name: 'VHS', cat: 'Look', kind: 'look', look: 'vhs', desc: 'Tape: chroma bleed, tracking wobble, snow, dropouts, head-switch noise.' },
  crt: { name: 'CRT', cat: 'Look', kind: 'look', look: 'crt', desc: 'Tube: curvature, scanlines, phosphor mask, glow and persistence.' },
};
export const CATEGORIES = ['Key', 'Color', 'Time', 'Glitch', 'Shape', 'Paint', 'Video 2', 'Look', 'Advanced'];

let nextId = 1;
export const needsV2 = (P) => P.digSrc || P.anaSrc || P.keySrc || P.stencilSource === 1;

export class Chain {
  constructor(W = 256, H = 256) { this.W = W; this.H = H; this.nodes = []; this.engines = new Map(); }
  // create a block; params override the module defaults
  make(type, opts = {}) {
    const m = MODULES[type]; if (!m) throw new Error('Unknown effect ' + type);
    const node = { id: opts.id || 'n' + nextId++, type, name: opts.name || m.name, bypass: 0, mix: 1 };
    if (+node.id.slice(1) >= nextId) nextId = +node.id.slice(1) + 1;
    if (m.kind === 'look') node.params = { ...JSON.parse(JSON.stringify(LOOK_DEFAULTS[m.look])), on: 1, ...(opts.params || {}) };
    else {
      const e = new CVI(this.W, this.H);
      e.applyPresetState(opts.state || { p: { ...m.p, ...(opts.params || {}) }, enter: m.enter || [] });
      this.engines.set(node.id, e);
    }
    return node;
  }
  insert(node, index = this.nodes.length) { this.nodes.splice(index, 0, node); return node; }
  remove(id) { this.nodes = this.nodes.filter((n) => n.id !== id); this.engines.delete(id); }
  move(id, to) { const i = this.nodes.findIndex((n) => n.id === id); if (i < 0) return; const [n] = this.nodes.splice(i, 1); this.nodes.splice(Math.max(0, Math.min(this.nodes.length, to)), 0, n); }
  get(id) { return this.nodes.find((n) => n.id === id); }
  engine(id) { return this.engines.get(id); }
  kind(node) { return MODULES[node.type].kind; }
  getParam(node, k) { if (k === 'bypass' || k === 'mix') return node[k]; return this.kind(node) === 'cvi' ? this.engines.get(node.id).P[k] : node.params[k]; }
  setParam(node, k, v) {
    if (k === 'bypass' || k === 'mix') { node[k] = v; return; }
    if (this.kind(node) === 'cvi') this.engines.get(node.id).dispatch({ k: 'set', p: k, v });
    else node.params[k] = v;
  }
  // new grid size: rebuild every unit, keeping its settings (the pictures in their frame buffers are cleared)
  resize(W, H) {
    if (W === this.W && H === this.H) return false;
    this.W = W; this.H = H;
    for (const [id, e] of this.engines) {
      const n = new CVI(W, H); n.P = { ...e.P }; n.g = { hpan: n.P.hpan, vpan: n.P.vpan, stretch: n.P.stretch, zoom: n.P.zoom };
      this.engines.set(id, n);
    }
    return true;
  }
  clearBuffers() { for (const e of this.engines.values()) { e.store.fill(0); e.stencil.fill(0); e.cascade.fill(0); } }
  setField(f) { for (const e of this.engines.values()) e.field = f; }
  // structure + settings (no pictures)
  toJSON() { return { W: this.W, H: this.H, nodes: this.nodes.map((n) => ({ ...n, params: n.params ? JSON.parse(JSON.stringify(n.params)) : undefined, P: this.engines.has(n.id) ? { ...this.engines.get(n.id).P } : undefined })) }; }
  // everything, including each unit's frame buffer and machine state
  snapshot() { const j = this.toJSON(); j.engines = {}; for (const [id, e] of this.engines) j.engines[id] = e.snapshot(true); return j; }
  static from(j, W = j.W, H = j.H) {
    const c = new Chain(W, H);
    for (const n of j.nodes) {
      const m = MODULES[n.type]; if (!m) continue;
      const node = { id: n.id, type: n.type, name: n.name, bypass: n.bypass || 0, mix: n.mix ?? 1, bg: n.bg };
      if (+n.id.slice(1) >= nextId) nextId = +n.id.slice(1) + 1;
      if (m.kind === 'look') node.params = { ...JSON.parse(JSON.stringify(LOOK_DEFAULTS[m.look])), ...n.params };
      else {
        const e = new CVI(W, H);
        if (j.engines && j.engines[n.id]) e.restore(j.engines[n.id]);
        e.P = { ...defaultParams(), ...(j.engines && j.engines[n.id] ? j.engines[n.id].P : n.P) };
        e.g = { hpan: e.P.hpan, vpan: e.P.vpan, stretch: e.P.stretch, zoom: e.P.zoom };
        c.engines.set(n.id, e);
      }
      c.nodes.push(node);
    }
    return c;
  }
}

// Render one frame through the chain. `advance(engine, node, inputs)` steps that unit's fields.
// The renderer must already hold the current Video 1 (slot 'analog') and Video 2 (slot 'v2') frames.
export function renderChain(chain, R, { advance, hasV2, frame, blanking, smooth, cut = false, fieldRate = 50 }) {
  R.run('src', {}, R.tex.analog, R.target('src'));
  let cur = R.target('src').t;
  let v2t = cur;
  if (hasV2) { R.run('src', {}, R.tex.v2, R.target('src2')); v2t = R.target('src2').t; }
  const grabs = new Map();
  const grab = (t) => { let d = grabs.get(t); if (!d) { d = R.grab(t, chain.W, chain.H); grabs.set(t, d); } return d; };
  const keep = new Set(['src', 'src2']);
  let matte = null;
  if (R.smooth !== !!smooth) R.setSmooth(smooth);
  for (const node of chain.nodes) {
    const m = MODULES[node.type];
    keep.add('n' + node.id); keep.add('m' + node.id); keep.add('p' + node.id);
    const e = chain.engines.get(node.id);
    if (node.bypass) { if (e) advance(e, node, null); continue; }
    const tgt = R.target('n' + node.id);
    if (m.kind === 'look') {
      const p = node.params;
      if (m.look === 'mosh') {
        keep.add('h0' + node.id); keep.add('h1' + node.id); keep.add('mp' + node.id); keep.add('mv' + node.id); keep.add('mf' + node.id);
        runMosh(R, node, cur, hasV2 ? v2t : null, tgt, frame, cut, fieldRate);
      } else if (m.look === 'crt') {
        const prev = R.target('p' + node.id);
        R.run('crt', { ...p, frame }, cur, tgt, { prev: prev.t });
        R.run('copy', {}, tgt.t, prev);
      } else R.run(m.look, { ...p, frame }, cur, tgt);
    } else {
      const inputs = { v1: grab(cur), v2: needsV2(e.P) ? grab(v2t) : null, matte: null };
      advance(e, node, inputs);
      const ana = e.P.anaSrc ? v2t : cur;
      if (e.dual) {
        // smooth key edge: pick inside/outside per output pixel from a full-resolution key
        R.uploadGrid('vOn', e.viewOn, chain.W, chain.H); R.uploadGrid('vOff', e.viewOff, chain.W, chain.H);
        const P = e.P, ks = P.stencilSource === 1 ? v2t : P.keySrc ? v2t : cur;
        R.run('comp3', {
          keyMode: P.stencilSource === 1 || P.keyMode === 1 ? 1 : 0, keyHue: P.keyHue / 360, keyTol: P.keyTol / 255 * 0.5, keySat: P.keySat / 255, keyLuma: P.keyLuma / 255,
          keyInv: (P.keyInvert ? 1 : 0) ^ (e.effInvert ? 1 : 0), soft: 0.01,
          // Edge fader: key resolution goes gradually from the CVI grid (0) to full resolution (255)
          cells: (() => { const f = 1 + (Math.max(1, R.h / chain.H) - 1) * (P.keyEdge / 255); return [chain.W * f, chain.H * f]; })(),
        }, null, tgt, { analog: ana, vOn: R.tex.vOn, vOff: R.tex.vOff, keysrc: ks });
      } else {
        R.uploadView(e.view, chain.W, chain.H);
        R.run('comp2', { blanking: 0 }, null, tgt, { analog: ana, view: R.tex.view });
      }
    }
    let out = tgt;
    if (node.mix < 0.999) { const mt = R.target('m' + node.id); R.run('mix', { amount: node.mix }, tgt.t, mt, { other: cur }); out = mt; }
    cur = out.t;
  }
  if (blanking) { R.run('blank', {}, cur, R.target('out')); keep.add('out'); cur = R.target('out').t; }
  R.dropTargets(keep);
  return cur;
}

// Datamosh. A video file stores a full picture (I-frame) now and then, and in between only "this block moved
// there" instructions (P-frames). Delete the I-frame and the new movement gets applied to the old picture.
// Here: a held picture stops refreshing while moshing, and each frame its blocks are pushed by the motion
// measured between the last two frames of the live video (or Video 2).
const holdFields = (p, rate) => (p.hold >= 10 ? Infinity : Math.max(1, Math.round(p.hold * rate)));
function runMosh(R, node, live, v2, tgt, frame, cut, rate) {
  const p = node.params, id = node.id;
  if (!R.mosh) R.mosh = new Map();
  let st = R.mosh.get(id);
  const fresh = !st || st.w !== R.w || st.h !== R.h || !R.targets.has('h0' + id) || frame < st.last;
  if (fresh) { st = { w: R.w, h: R.h, last: frame, until: -1, trig: p.trig, refresh: p.refresh, ping: 0, frozen: false, primed: false }; R.mosh.set(id, st); }
  const held = () => R.target('h' + st.ping + id);
  const motionSrc = p.src && v2 ? v2 : live;
  if (frame !== st.last || fresh) {
    const start = () => { st.until = frame + holdFields(p, rate); };
    if (p.trig !== st.trig) { st.trig = p.trig; start(); }
    if (p.refresh !== st.refresh) { st.refresh = p.refresh; st.until = -1; }
    if (p.cuts && cut) start();
    if (p.auto > 0) { const a = Math.max(1, Math.round(p.auto * rate)); if (Math.floor(frame / a) !== Math.floor(st.last / a) && !fresh) start(); }
    const moshing = frame < st.until && st.primed;
    if (!moshing) { R.run('copy', {}, live, held()); st.frozen = false; }
    else {
      const sc = R.h / 720, bs = Math.max(4, p.block * sc), rad = Math.max(4, bs);
      const mw = Math.ceil(R.w / bs), mh = Math.ceil(R.h / bs);
      let mv = R.sized('mv' + id, mw, mh);
      if (!(p.bloom && st.frozen)) R.run('moshMe', { bs, rad, full: [R.w, R.h] }, motionSrc, mv, { prev: R.target('mp' + id).t });
      if (p.bloom) {
        const mf = R.sized('mf' + id, mw, mh);
        if (!st.frozen) { R.run('copy', {}, mv.t, mf); st.frozen = true; }
        mv = mf;
      } else st.frozen = false;
      // bloom repeats one frame's motion every update: keep its speed the same at any frame rate
      const k = p.bloom ? Math.min(4, (frame - st.last) * 30 / rate) : 1;
      const src = held(); st.ping ^= 1;
      R.run('moshMove', { bs, rad, strength: p.strength * k, bleed: p.bleed }, src.t, held(), { mv: mv.t, live });
    }
    R.run('copy', {}, motionSrc, R.target('mp' + id));
    st.primed = true;
    st.last = frame;
  }
  R.run('copy', {}, held().t, tgt);
}
