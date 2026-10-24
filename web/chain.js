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
  keyer: { keyer: true, name: 'Chroma key', cat: 'Key', kind: 'cvi', desc: 'Keys out a backdrop (blue by default, or click Pick from video on yours) and puts something else behind the subject: black, a colour, Video 2, or the canvas.', p: { display: 2, ...key }, enter: [{ k: 'storeFill', c: [0, 0, 0] }], sections: ['keyBg', 'key'] },
  lumakey: { keyer: true, name: 'Luma key', cat: 'Key', kind: 'cvi', desc: 'Keys on brightness instead of colour: keeps everything brighter (or darker) than the threshold.', p: { display: 2, ...key, keyMode: 1, keyLuma: 128 }, enter: [{ k: 'storeFill', c: [0, 0, 0] }], sections: ['keyBg', 'key'] },
  wipe: { name: 'Wipe to Video 2', cat: 'Video 2', kind: 'cvi', desc: 'Transition from this video to Video 2: sweep across, down or disintegrate.', p: { display: 15, useStencil: 1, digSrc: 1, stencilErase: 1, stencilWipe: 2 }, enter: [{ k: 'stencilFill', v: 1 }, { k: 'press', b: 'wipeStencil' }], sections: ['scan', 'inputs'] },
  double: { name: 'Double exposure', cat: 'Video 2', kind: 'cvi', desc: 'Blends this video with Video 2 through the frame buffer.', p: { display: 12, ...allOn, digSrc: 1 }, enter: clearStencil, sections: ['freeze', 'inputs'] },
  flip: { name: 'Video 1/2 flip', cat: 'Video 2', kind: 'cvi', desc: 'Flickers between this video and Video 2 at the Rate.', p: { display: 15, ...allOn, digSrc: 1, shatter: 1, rate2: 160 }, enter: clearStencil, sections: ['shatterRate', 'inputs'] },
  unit: { name: 'CVI unit', cat: 'Advanced', kind: 'cvi', desc: 'A whole CVI with every setting exposed. Presets load into one of these.', p: { display: 5 }, sections: ['all'] },
  bw: { name: 'Black & white', cat: 'Look', kind: 'look', look: 'bw', desc: 'Film stock with filters, grain and toning (sepia, cyanotype…).' },
  halftone: { name: 'Halftone', cat: 'Look', kind: 'look', look: 'halftone', desc: 'Printed dots: mono, CMYK or colour, round, line or square screens.' },
  vhs: { name: 'VHS', cat: 'Look', kind: 'look', look: 'vhs', desc: 'Tape: chroma bleed, tracking wobble, snow, dropouts, head-switch noise.' },
  crt: { name: 'CRT', cat: 'Look', kind: 'look', look: 'crt', desc: 'Tube: curvature, scanlines, phosphor mask, glow and persistence.' },
};
export const CATEGORIES = ['Key', 'Color', 'Time', 'Shape', 'Paint', 'Video 2', 'Look', 'Advanced'];

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
export function renderChain(chain, R, { advance, hasV2, frame, blanking, smooth }) {
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
      if (m.look === 'crt') {
        const prev = R.target('p' + node.id);
        R.run('crt', { ...p, frame }, cur, tgt, { prev: prev.t });
        R.run('copy', {}, tgt.t, prev);
      } else R.run(m.look, { ...p, frame }, cur, tgt);
    } else {
      const inputs = { v1: grab(cur), v2: needsV2(e.P) ? grab(v2t) : null, matte: m.keyed && matte ? matte : null };
      advance(e, node, inputs);
      if (m.keyer) matte = e.mask.slice(); // the subject this key found, for keyed effects below it
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
