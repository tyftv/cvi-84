// CVI-84 engine — a field-accurate model of the 1984-88 Fairlight Computer Video Instrument.
// Pure JS, no DOM. Runs one PAL/NTSC *field* per step() on an NxN (default 256x256) field store
// with 4 bits per RGB channel and a 1-bit stencil plane, exactly like the hardware.
//
// Output of every step: `view` (RGBA8, NxN). rgb = what the 256-res digital side shows at that pixel,
// alpha = the plane id the compositor must show there (0 Analog, 1 Digital, 2 Store, 3 Mix, 4 Cascade).
// The compositor takes Analog (and the analog half of Mix) from the full-resolution source, because
// the hardware's analog path is never digitised.

export const PLANE = { A: 0, D: 1, S: 2, M: 3, C: 4 };
const { A, D, S, M, C } = PLANE;
const U_NONE = 0, U_IMG = 1, U_COL = 2;

// DISPLAY CONTROL (VIDEO menu 0) — the 20 named routings from the 1985 Rev 5 manual.
// [name, offDisplay, offUpdate, onDisplay, onUpdate, crawl]
export const DISPLAY = [
  null,
  ['Paint', S, U_NONE, S, U_NONE, 0],
  ['Paint/Analog', S, U_NONE, A, U_NONE, 0],
  ['Paint/Digital', S, U_NONE, D, U_IMG, 0],
  ['Trail', S, U_NONE, A, U_IMG, 0],
  ['Dig./Analog', D, U_IMG, A, U_NONE, 0],
  ['Colour', S, U_NONE, S, U_COL, 0],
  ['Store', S, U_NONE, S, U_IMG, 0],
  ['Col./Analog', S, U_COL, A, U_COL, 0],
  ['Store/Analog', S, U_IMG, A, U_IMG, 0],
  ['Colour trail', S, U_NONE, A, U_COL, 0],
  ['Acquire', S, U_IMG, A, U_NONE, 0],
  ['Ghost', S, U_NONE, M, U_IMG, 0],
  ['Protect', S, U_NONE, D, U_NONE, 0],
  ['Mix', A, U_IMG, M, U_IMG, 0],
  ['Live combo', D, U_NONE, A, U_NONE, 0],
  ['Crawl', S, U_NONE, S, U_NONE, 1],
  ['Crawl/Analog', S, U_NONE, A, U_NONE, 1],
  ['Trail crawl', S, U_NONE, D, U_IMG, 2],
  ['Cascade', S, U_NONE, C, U_IMG, 0],
  ['Cas./Analog', C, U_IMG, A, U_NONE, 0],
];

export const MENUS = {
  stencilSource: ['Internal', 'External key (V2)', 'Chroma key', 'Under-over'],
  screen: ['Vertical mirror', 'Horizontal mirror', 'Horizontal wipe', 'Vertical wipe', 'Shatter', 'Pan:pen', 'Glide', 'Slide'],
  freezeMode: ['Continuous', 'Strobe', 'Burst', 'Single', 'Music', 'External'],
  colourizeCtl: ['HSV sliders', 'HSV fix', 'Music', 'Random'],
  colourizeType: ['Tint', 'Translucent', 'Shade', 'Range', 'Solarize', 'Monochrome', 'Contour', 'Spectrum'],
  paintMethod: ['Draw', 'Dots', 'Rubber band', 'Circle', 'Ellipse', 'Rectangle', 'Rays', 'Cut & paste', 'Fill', 'Copy'],
  brush: ['Pixel', 'Round 2', 'Round 4', 'Round 6', 'Round 10', 'Round 16', 'Round 24', 'Square 2', 'Square 4', 'Square 8', 'Bar', 'Post', 'Slash', 'Backslash', 'Spray', 'Big spray'],
  paintType: ['Flat', 'Spatter', 'Mottled', 'Shade L-R', 'Shade T-B', 'Hue-sat'],
  texture: ['Checker 8', 'Checker 16', 'Grid', 'Stripes H', 'Stripes V', 'Diagonals', 'Dots', 'Hearts', 'Bricks', 'Noise', 'Diamonds', 'Rings', 'Crosshatch', 'Waves', 'Stars', 'Fine check'],
  colourCtl: ['HSV sliders', 'Music', 'Random', 'Random B&W'],
  colourType: ['Opaque', 'Tint', 'Translucent', 'Shade', 'Range', 'Solarize', 'Monochrome', 'Contour', 'Spectrum'],
  symmetry: ['Off', 'Horizontal', 'Vertical', 'Flip', 'Cross', 'Diagonal', 'Kaleidoscope', 'Rotary 90', 'Spin 180'],
  colourWipe: ['White', 'Colour', 'Texture', 'Wipe right', 'Wipe down', 'Change', 'Colour tunnel', 'Disintegrate'],
  stencilWipe: ['Clear', 'Texture', 'Wipe right', 'Wipe down', 'Invert', 'Edge detect', 'Colour detect', 'Disintegrate', 'Window'],
  titleFormat: ['Normal', 'Underline', 'Drop shadow 1', 'Drop shadow 2', 'Background', 'Background + shadow'],
};

export const SLIDERS = ['hue', 'sat', 'val', 'depth', 'rate1', 'rate2', 'hpan', 'vpan', 'stretch', 'zoom'];

export function defaultParams() {
  return {
    // ten console sliders, 0..255 (pans, stretch and depth are bipolar around 128)
    hue: 0, sat: 200, val: 255, depth: 128, rate1: 128, rate2: 128, hpan: 128, vpan: 128, stretch: 128, zoom: 0,
    // console buttons
    colourize: 0, drawColour: 1, drawStencil: 0, useTexture: 0, useStencil: 0, invertStencil: 0, freeze: 0, drawLock: 0,
    // VIDEO menus
    display: 5, stencilSource: 0, keyMode: 0, keyHue: 225, keyTol: 70, keySat: 60, keyLuma: 128, keyInvert: 0, keyEdge: 0,
    digSrc: 0, anaSrc: 0, keySrc: 0, blanking: 0,
    vmirror: 0, hmirror: 0, hwipe: 0, vwipe: 0, shatter: 0, panpen: 0, glide: 0, slide: 0,
    freezeMode: 0, colourizeCtl: 0, colourizeType: 7,
    // PAINT menus
    paintMethod: 0, brush: 4, paintType: 0, texture: 0, colourCtl: 0, colourType: 0, symmetry: 0,
    colourWipe: 1, stencilWipe: 2, stencilErase: 0, stencilShow: 0, drawUnder: 0, dejag: 1,
    title: 'TELL YOUR FRIENDS', titleSize: 2, titleFormat: 2,
  };
}

// ---------- small maths ----------
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const frac = (v) => v - Math.floor(v);
const bip = (v) => { // bipolar slider with centre dead-spot -> [-1, 1]
  const x = (v - 128) / 127;
  return Math.abs(x) < 0.04 ? 0 : (x - Math.sign(x) * 0.04) / 0.96;
};
export function hsv2rgb(h, s, v) {
  h = frac(h) * 6; const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i) { case 0: return [v, t, p]; case 1: return [q, v, p]; case 2: return [p, v, t]; case 3: return [p, q, v]; case 4: return [t, p, v]; default: return [v, p, q]; }
}
export function rgb2hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 0) { h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; if (h < 0) h += 1; }
  return [h, mx === 0 ? 0 : d / mx, mx];
}
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const tri = (x) => 1 - Math.abs(2 * frac(x) - 1);

// Deterministic PRNG (mulberry32) — state lives in the engine so exports replay identically.
function rngNext(st) {
  let t = (st.s = (st.s + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// The colour maths shared by COLOURIZE (live, VIDEO 5) and COLOUR TYPE (paint, PAINT 5).
// c: [r,g,b] 0..1 (screen colour), k: [r,g,b] chosen colour, d: bipolar depth -1..1, hsv: [h,s,v] of the sliders.
// Returns new [r,g,b] 0..1.
export function colourMath(type, c, k, d, hsv, out) {
  const a = Math.abs(d), neg = d < 0;
  const r = c[0], g = c[1], b = c[2];
  const L = lum(r, g, b);
  let x, y, z;
  switch (type) {
    case 0: // Tint: add (or subtract) the colour
      x = r + d * k[0]; y = g + d * k[1]; z = b + d * k[2]; break;
    case 1: { // Translucent: a coloured film over the picture; negative depth uses the complement film
      const f0 = neg ? 1 - k[0] : k[0], f1 = neg ? 1 - k[1] : k[1], f2 = neg ? 1 - k[2] : k[2];
      const s = 0.3 + 0.7 * L * 1.25;
      x = r + (f0 * s - r) * a; y = g + (f1 * s - g) * a; z = b + (f2 * s - b) * a; break;
    }
    case 2: { // Shade: subtract — positive darkens toward the colour, negative removes it
      const s0 = neg ? k[0] : 1 - k[0], s1 = neg ? k[1] : 1 - k[1], s2 = neg ? k[2] : 1 - k[2];
      x = r - a * s0; y = g - a * s1; z = b - a * s2; break;
    }
    case 3: { // Range: per-component MAX clamp toward the colour (white = no effect, black = black)
      const r0 = neg ? 1 - r : r, g0 = neg ? 1 - g : g, b0 = neg ? 1 - b : b;
      x = r + (Math.min(r0, k[0]) - r) * a; y = g + (Math.min(g0, k[1]) - g) * a; z = b + (Math.min(b0, k[2]) - b) * a; break;
    }
    case 4: { // Solarize: folded partial negatives, the most dramatic family
      const folds = 0.5 + a * 2.5, ph = hsv[0] * 0.5;
      let sr = tri(r * folds + ph), sg = tri(g * folds + ph * 1.3), sb = tri(b * folds + ph * 0.7);
      if (neg) { sr = 1 - sr; sg = 1 - sg; sb = 1 - sb; }
      const m = Math.min(1, a * 2), ts = hsv[1];
      sr *= 1 - ts + ts * k[0] * 1.2; sg *= 1 - ts + ts * k[1] * 1.2; sb *= 1 - ts + ts * k[2] * 1.2;
      x = r + (sr - r) * m; y = g + (sg - g) * m; z = b + (sb - b) * m; break;
    }
    case 5: { // Monochrome: discard hue, tint the tone (minimum saturation = pure B&W, negative = tinted negative)
      const t = neg ? 1 - L : L;
      const col = hsv2rgb(hsv[0], hsv[1], 1);
      const v = 0.15 + 0.85 * hsv[2];
      x = r + (t * col[0] * v * 1.1 - r) * a; y = g + (t * col[1] * v * 1.1 - g) * a; z = b + (t * col[2] * v * 1.1 - b) * a; break;
    }
    case 6: { // Contour: posterize, the colour's R,G,B set contours per channel (dark colour = many contours)
      const q = (v, kc) => {
        const n = 2 + Math.floor((1 - kc) * 9);
        const band = Math.min(n - 1, Math.floor(v * n));
        let o = band / (n - 1);
        if (neg && band & 1) o = 1 - o;
        return o;
      };
      x = r + (q(r, k[0]) - r) * a; y = g + (q(g, k[1]) - g) * a; z = b + (q(b, k[2]) - b) * a; break;
    }
    default: { // 7 Spectrum: intensity mapped to hue. HUE rotates, SAT whitens, VALUE sets the colour range
      const t = neg ? 1 - L : L;
      const range = 0.25 + hsv[2] * 1.75;
      const sp = hsv2rgb(hsv[0] + t * range, 1 - hsv[1] * 0.85, 0.25 + 0.75 * Math.sqrt(t + 0.02));
      x = r + (sp[0] - r) * a; y = g + (sp[1] - g) * a; z = b + (sp[2] - b) * a; break;
    }
  }
  out[0] = clamp01(x); out[1] = clamp01(y); out[2] = clamp01(z);
  return out;
}

// ---------- brushes, textures, font ----------
function makeBrushes() {
  const round = (r) => { const pts = []; const R = r + 0.5; for (let y = -r - 1; y <= r + 1; y++) for (let x = -r - 1; x <= r + 1; x++) { const d = Math.hypot(x, y); if (d <= R + 0.7) pts.push([x, y, clamp01(R + 0.7 - d)]); } return pts; };
  const rect = (w, h) => { const pts = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pts.push([x - (w >> 1), y - (h >> 1), 1]); return pts; };
  const line = (n, sx) => { const pts = []; for (let i = -n; i <= n; i++) { pts.push([i * sx, i, 1]); pts.push([i * sx + 1, i, 1]); } return pts; };
  return [
    [[0, 0, 1]], round(1), round(2), round(3), round(5), round(8), round(12),
    rect(2, 2), rect(4, 4), rect(8, 8), rect(11, 2), rect(2, 11), line(5, 1), line(5, -1),
    { spray: 5, n: 10 }, { spray: 12, n: 28 },
  ];
}
const BRUSHES = makeBrushes();

// 1-bit textures in store coordinates (procedural versions of the hardware's ROM textures)
const HEART = ['..........', '.XX...XX..', 'XXXX.XXXX.', 'XXXXXXXXX.', 'XXXXXXXXX.', '.XXXXXXX..', '..XXXXX...', '...XXX....', '....X.....', '..........'];
const STAR = ['.......', '...X...', '...X...', 'XXXXXXX', '.XXXXX.', '.XX.XX.', 'X.....X'];
function hash2(x, y) { let h = Math.imul(x * 374761393 + y * 668265263, 1274126177); h ^= h >>> 13; h = Math.imul(h, 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
export function texel(i, x, y) {
  switch (i) {
    case 0: return ((x >> 3) + (y >> 3)) & 1;
    case 1: return ((x >> 4) + (y >> 4)) & 1;
    case 2: return (x & 15) < 2 || (y & 15) < 2 ? 1 : 0;
    case 3: return (y & 7) < 4 ? 1 : 0;
    case 4: return (x & 7) < 4 ? 1 : 0;
    case 5: return ((x + y) & 15) < 6 ? 1 : 0;
    case 6: { const dx = (x & 7) - 3.5, dy = (y & 7) - 3.5; return dx * dx + dy * dy < 6 ? 1 : 0; }
    case 7: return HEART[y % 10][x % 10] === 'X' ? 1 : 0;
    case 8: { const row = y >> 3, bx = (x + (row & 1) * 8) & 15; return (y & 7) === 0 || bx === 0 ? 0 : 1; }
    case 9: return hash2(x, y) < 0.5 ? 1 : 0;
    case 10: return (Math.abs((x & 15) - 7.5) + Math.abs((y & 15) - 7.5)) < 6 ? 1 : 0;
    case 11: return (Math.floor(Math.hypot(x - 128, y - 128) / 6) & 1);
    case 12: return ((x + y) & 7) === 0 || ((x - y) & 7) === 0 ? 1 : 0;
    case 13: return ((y + Math.round(Math.sin(x / 6) * 4)) & 15) < 6 ? 1 : 0;
    case 14: return STAR[y % 7][x % 7] === 'X' ? 1 : 0;
    default: return (x + y) & 1;
  }
}

// 5x7 title font (the hardware ROM had 63 characters)
const FONT = (() => {
  const g = {
    'A': '01110,10001,10001,11111,10001,10001,10001', 'B': '11110,10001,10001,11110,10001,10001,11110',
    'C': '01110,10001,10000,10000,10000,10001,01110', 'D': '11100,10010,10001,10001,10001,10010,11100',
    'E': '11111,10000,10000,11110,10000,10000,11111', 'F': '11111,10000,10000,11110,10000,10000,10000',
    'G': '01110,10001,10000,10111,10001,10001,01111', 'H': '10001,10001,10001,11111,10001,10001,10001',
    'I': '01110,00100,00100,00100,00100,00100,01110', 'J': '00111,00010,00010,00010,00010,10010,01100',
    'K': '10001,10010,10100,11000,10100,10010,10001', 'L': '10000,10000,10000,10000,10000,10000,11111',
    'M': '10001,11011,10101,10101,10001,10001,10001', 'N': '10001,10001,11001,10101,10011,10001,10001',
    'O': '01110,10001,10001,10001,10001,10001,01110', 'P': '11110,10001,10001,11110,10000,10000,10000',
    'Q': '01110,10001,10001,10001,10101,10010,01101', 'R': '11110,10001,10001,11110,10100,10010,10001',
    'S': '01111,10000,10000,01110,00001,00001,11110', 'T': '11111,00100,00100,00100,00100,00100,00100',
    'U': '10001,10001,10001,10001,10001,10001,01110', 'V': '10001,10001,10001,10001,10001,01010,00100',
    'W': '10001,10001,10001,10101,10101,10101,01010', 'X': '10001,10001,01010,00100,01010,10001,10001',
    'Y': '10001,10001,10001,01010,00100,00100,00100', 'Z': '11111,00001,00010,00100,01000,10000,11111',
    '0': '01110,10001,10011,10101,11001,10001,01110', '1': '00100,01100,00100,00100,00100,00100,01110',
    '2': '01110,10001,00001,00010,00100,01000,11111', '3': '11111,00010,00100,00010,00001,10001,01110',
    '4': '00010,00110,01010,10010,11111,00010,00010', '5': '11111,10000,11110,00001,00001,10001,01110',
    '6': '00110,01000,10000,11110,10001,10001,01110', '7': '11111,00001,00010,00100,01000,01000,01000',
    '8': '01110,10001,10001,01110,10001,10001,01110', '9': '01110,10001,10001,01111,00001,00010,01100',
    ' ': '00000,00000,00000,00000,00000,00000,00000', '.': '00000,00000,00000,00000,00000,01100,01100',
    ',': '00000,00000,00000,00000,01100,00100,01000', '!': '00100,00100,00100,00100,00100,00000,00100',
    '?': '01110,10001,00001,00010,00100,00000,00100', '-': '00000,00000,00000,11111,00000,00000,00000',
    '+': '00000,00100,00100,11111,00100,00100,00000', '=': '00000,00000,11111,00000,11111,00000,00000',
    ':': '00000,01100,01100,00000,01100,01100,00000', '\'': '00100,00100,01000,00000,00000,00000,00000',
    '"': '01010,01010,00000,00000,00000,00000,00000', '/': '00001,00010,00010,00100,01000,01000,10000',
    '(': '00010,00100,01000,01000,01000,00100,00010', ')': '01000,00100,00010,00010,00010,00100,01000',
    '#': '01010,11111,01010,01010,01010,11111,01010', '$': '00100,01111,10100,01110,00101,11110,00100',
    '%': '11001,11010,00010,00100,01000,01011,10011', '&': '01100,10010,10100,01000,10101,10010,01101',
    '*': '00000,10101,01110,11111,01110,10101,00000', '@': '01110,10001,10111,10101,10111,10000,01111',
    '<': '00010,00100,01000,10000,01000,00100,00010', '>': '01000,00100,00010,00001,00010,00100,01000',
    '_': '00000,00000,00000,00000,00000,00000,11111', ';': '00000,01100,01100,00000,01100,00100,01000',
  };
  const out = {};
  for (const k in g) out[k] = g[k].split(',').map((r) => r.split('').map(Number));
  return out;
})();

// ---------- the engine ----------
export class CVI {
  // W x H field store. The 1984 hardware was 256 x 256 stretched over a 4:3 frame; here the grid can follow
  // the video's aspect ratio (square pixels) and be made finer.
  constructor(W = 256, H = W) {
    this.W = W; this.H = H; this.N = W; const NN = W * H;
    this.P = defaultParams();
    this.store = new Uint8Array(NN * 3); // 4-bit per channel (0..15)
    this.stencil = new Uint8Array(NN); // 1-bit internal stencil, store coordinates
    this.view = new Uint8Array(NN * 4); // output for compositor
    this.digital = new Uint8Array(NN * 3); // live digital plane (0..15), screen coords
    this.mask = new Uint8Array(NN); // effective stencil this field, screen coords
    this.cascade = new Uint8Array(NN * 3); // previous composite (cascade = feedback through a 2nd pass)
    this.mapX = new Int32Array(W); this.mapY = new Int32Array(H);
    this.ownX = new Uint8Array(W); this.ownY = new Uint8Array(H); // mirror: is this screen pixel on the source side
    this.lut = new Uint16Array(4096);
    this.lutKey = '';
    this.overlay = null; // rubber-band preview for the UI
    this.reset();
  }

  reset() {
    this.store.fill(0); this.stencil.fill(0); this.cascade.fill(0);
    this.rng = { s: 19840101 };
    this.field = 0;
    this.g = { hpan: this.P.hpan, vpan: this.P.vpan, stretch: this.P.stretch, zoom: this.P.zoom }; // glided slider values
    this.slideX = 0; this.slideY = 0;
    this.procs = [];
    this.singlePending = false;
    this.pickArmed = false; this.titleArmed = false; this.picked = [0, 0, 1];
    this.pad = null; this.clip = null;
    this.shatterPhase = 0;
    this.randColour = [1, 0, 0]; this.randPaint = [1, 1, 1];
    this.audio = { b: 0, m: 0, t: 0 }; this.prevBass = 0; this.lastPeak = -99;
    this.fixLutKey = null;
    this.tunnelHist = [];
    this.lastColourize = [1, 0, 0];
  }

  // ---- snapshots (store, stencil and all machine state; params optional) ----
  snapshot(withParams = true) {
    return {
      W: this.W, H: this.H, store: this.store.slice(), stencil: this.stencil.slice(), cascade: this.cascade.slice(),
      rng: this.rng.s, field: this.field, g: { ...this.g }, slideX: this.slideX, slideY: this.slideY,
      procs: JSON.parse(JSON.stringify(this.procs)), picked: [...this.picked], randColour: [...this.randColour], randPaint: [...this.randPaint],
      tunnelHist: this.tunnelHist.slice(), clip: this.clip ? { ...this.clip, data: this.clip.data.slice() } : null,
      P: withParams ? { ...this.P } : null,
    };
  }
  restore(s) {
    if (s.store.length === this.store.length) { this.store.set(s.store); this.stencil.set(s.stencil); this.cascade.set(s.cascade); }
    this.rng.s = s.rng; this.field = s.field; this.g = { ...s.g }; this.slideX = s.slideX; this.slideY = s.slideY;
    this.procs = JSON.parse(JSON.stringify(s.procs)); this.picked = [...s.picked];
    this.randColour = [...s.randColour]; this.randPaint = [...s.randPaint]; this.tunnelHist = s.tunnelHist.slice();
    this.clip = s.clip ? { ...s.clip, data: s.clip.data.slice() } : null;
    if (s.P) this.P = { ...s.P };
    this.singlePending = false; this.pad = null; this.overlay = null;
  }

  rand() { return rngNext(this.rng); }

  // ---- derived control values ----
  sliderColour() { const P = this.P; return hsv2rgb(P.hue / 255, P.sat / 255, P.val / 255); }
  hsv() { const P = this.P; return [P.hue / 255, P.sat / 255, P.val / 255]; }
  depth() { return bip(this.P.depth); }
  period(rate) { return Math.max(1, Math.round(1 + Math.pow(1 - rate / 255, 2) * 99)); }

  colourizeColour() {
    const P = this.P;
    if (P.colourizeCtl === 2) { const a = this.audio, s = 1.6; return [clamp01(a.b * s), clamp01(a.m * s), clamp01(a.t * s)]; }
    if (P.colourizeCtl === 3) return this.randColour;
    return this.sliderColour();
  }
  paintColour(x = 0, y = 0) {
    const P = this.P;
    if (P.paintType === 5) return hsv2rgb(x / this.W, 1 - y / this.H * 0.8, 1);
    if (P.colourCtl === 1) { const a = this.audio, s = 1.6; return [clamp01(a.b * s), clamp01(a.m * s), clamp01(a.t * s)]; }
    if (P.colourCtl === 2 || P.colourCtl === 3) return this.randPaint;
    return this.sliderColour();
  }

  // ---- actions (everything the console can do; the automation recorder logs these) ----
  dispatch(a) {
    const P = this.P;
    switch (a.k) {
      case 'set':
        if (a.p in P) {
          const old = P[a.p];
          P[a.p] = a.v;
          if (a.p === 'colourize' && old && !a.v && P.colourizeCtl === 1) this.fixLutKey = this.lutKey; // HSV FIX latch
          if (a.p === 'freezeMode') this.singlePending = false;
        }
        break;
      case 'press': this.press(a.b); break;
      case 'pad': this.padEvent(a); break;
      case 'preset': if (a.state) this.applyPresetState(a.state); break;
      case 'stencilFill': this.stencil.fill(a.v ? 1 : 0); break;
      case 'storeFill': this.fillStore(a.c || [0, 0, 0]); break;
      case 'pattern': this.drawPattern(a.v); break;
    }
  }

  applyPresetState(st) {
    const base = defaultParams();
    const keep = { title: this.P.title, keyHue: this.P.keyHue, keyTol: this.P.keyTol, keySat: this.P.keySat, keyLuma: this.P.keyLuma, keyMode: this.P.keyMode };
    this.P = { ...base, ...keep, ...st.p };
    this.procs = []; this.singlePending = false; this.fixLutKey = null; this.pickArmed = false; this.titleArmed = false;
    this.g = { hpan: this.P.hpan, vpan: this.P.vpan, stretch: this.P.stretch, zoom: this.P.zoom };
    this.slideX = 0; this.slideY = 0;
    if (st.enter) for (const act of st.enter) this.dispatch(act);
  }

  press(b) {
    const P = this.P;
    switch (b) {
      case 'freeze':
        if (P.freezeMode === 3 || P.freezeMode === 5) this.singlePending = true;
        else P.freeze = P.freeze ? 0 : 1;
        break;
      case 'stop': this.procs = []; this.pickArmed = false; this.titleArmed = false; this.clip = this.clip && this.clip.ready ? this.clip : null; break;
      case 'wipeColour': this.startColourWipe(P.colourWipe); break;
      case 'wipeStencil': this.startStencilWipe(P.stencilWipe); break;
      case 'pick': this.pickArmed = true; break;
      case 'title': this.titleArmed = !this.titleArmed; break;
      default: if (b in P) P[b] = P[b] ? 0 : 1;
    }
  }

  // ---- readout transform (zoom, stretch, pan, slide, mirror) — store coords for each screen pixel ----
  buildMaps() {
    const W = this.W, H = this.H, P = this.P, g = this.g, cx = W / 2, cy = H / 2;
    const z = 1 + Math.pow(g.zoom / 255, 1.6) * 15;
    const s = bip(g.stretch);
    const zx = s > 0 ? z * (1 + s * 7) : z, zy = s < 0 ? z * (1 - s * 7) : z;
    this.zx = zx; this.zy = zy;
    let panX = 0, panY = 0, axX = cx, axY = cy;
    if (P.slide) { panX = this.slideX; panY = this.slideY; }
    if (P.vmirror) axX = cx + bip(g.hpan) * cx; else if (!P.slide) panX = bip(g.hpan) * cx;
    if (P.hmirror) axY = cy + bip(g.vpan) * cy; else if (!P.slide) panY = bip(g.vpan) * cy;
    this.panX = panX; this.panY = panY;
    for (let x = 0; x < W; x++) {
      let xs = x; this.ownX[x] = 1;
      if (P.vmirror && x > axX) { xs = 2 * axX - x; this.ownX[x] = 0; }
      this.mapX[x] = ((Math.floor((xs - cx) / zx + cx - panX) % W) + W) % W;
    }
    for (let y = 0; y < H; y++) {
      let ys = y; this.ownY[y] = 1;
      if (P.hmirror && y > axY) { ys = 2 * axY - y; this.ownY[y] = 0; }
      this.mapY[y] = ((Math.floor((ys - cy) / zy + cy - panY) % H) + H) % H;
    }
  }

  buildLut() {
    const P = this.P, d = this.depth(), k = this.colourizeColour(), hsv = this.hsv();
    const key = `${P.colourizeType}|${d.toFixed(3)}|${k.map((v) => v.toFixed(3))}|${hsv.map((v) => v.toFixed(3))}`;
    if (key === this.lutKey) return;
    this.lutKey = key;
    const c = [0, 0, 0], o = [0, 0, 0];
    for (let i = 0; i < 4096; i++) {
      c[0] = (i >> 8) / 15; c[1] = ((i >> 4) & 15) / 15; c[2] = (i & 15) / 15;
      colourMath(P.colourizeType, c, k, d, hsv, o);
      this.lut[i] = (Math.round(o[0] * 15) << 8) | (Math.round(o[1] * 15) << 4) | Math.round(o[2] * 15);
    }
  }

  // ---- one field ----
  // dig, ana: RGBA8 NxN frames for the digital and analog paths (already routed V1/V2); key: frame used for keying
  step(inputs, audio) {
    const W = this.W, H = this.H, NN = W * H, P = this.P;
    const dig = P.digSrc ? inputs.v2 || inputs.v1 : inputs.v1;
    const ana = P.anaSrc ? inputs.v2 || inputs.v1 : inputs.v1;
    const keySrc = P.keySrc ? inputs.v2 || inputs.v1 : inputs.v1;
    if (audio) this.audio = audio;

    // 1. glide and slide (50/60 Hz field clock)
    const sp = 0.5 + (P.rate2 / 255) * 16;
    for (const k of ['hpan', 'vpan', 'stretch', 'zoom']) {
      if (P.glide) { const d = P[k] - this.g[k]; this.g[k] += Math.abs(d) <= sp ? d : Math.sign(d) * sp; }
      else this.g[k] = P[k];
    }
    if (P.slide) {
      const sx = bip(P.hpan), sy = bip(P.vpan);
      this.slideX = (this.slideX + sx * sx * sx * W / 2 + W * 64) % W;
      this.slideY = (this.slideY + sy * sy * sy * H / 2 + H * 64) % H;
    }

    // 2. random / music colour programs (RATE 1)
    const p1 = this.period(P.rate1);
    if (this.field % p1 === 0) {
      this.randColour = hsv2rgb(this.rand(), 0.55 + this.rand() * 0.45, 0.6 + this.rand() * 0.4);
    }
    if (P.colourCtl === 2) this.randPaint = hsv2rgb(this.field / (p1 * 24), 1, 1); // LFO-like program
    else if (P.colourCtl === 3 && this.field % p1 === 0) { const v = this.rand() < 0.5 ? 0 : 1; this.randPaint = [v, v, v]; }

    this.buildMaps();

    // 3. digital plane: quantize to 4 bits, colourize (palette LUT), mosaic by ZOOM/STRETCH, pan
    const colourizeOn = (P.colourize || P.colourizeCtl === 1) && this.depth() !== 0;
    if (colourizeOn) { if (!(P.colourizeCtl === 1 && !P.colourize && this.fixLutKey)) this.buildLut(); }
    const useLut = colourizeOn || (P.colourizeCtl === 1 && this.fixLutKey);
    const bx = Math.max(1, Math.round(this.zx)), by = Math.max(1, Math.round(this.zy));
    const cx = W / 2, cy = H / 2, panX = Math.round(this.panX), panY = Math.round(this.panY);
    const dg = this.digital;
    for (let y = 0; y < H; y++) {
      let ly = Math.floor((y - cy) / by) * by + cy - panY; ly = ((ly % H) + H) % H;
      for (let x = 0; x < W; x++) {
        let lx = Math.floor((x - cx) / bx) * bx + cx - panX; lx = ((lx % W) + W) % W;
        const si = (ly * W + lx) * 4, di = (y * W + x) * 3;
        let r = dig[si] >> 4, g = dig[si + 1] >> 4, b = dig[si + 2] >> 4;
        if (useLut) { const e = this.lut[(r << 8) | (g << 4) | b]; r = e >> 8; g = (e >> 4) & 15; b = e & 15; }
        dg[di] = r; dg[di + 1] = g; dg[di + 2] = b;
      }
    }

    // 4. stencil for this field (screen coords)
    const mk = this.mask, st = this.stencil, mx = this.mapX, my = this.mapY;
    const needKey = P.stencilSource !== 0;
    let invert = P.invertStencil;
    if (P.shatter) { const p2 = this.period(P.rate2); if (this.field % p2 === 0) this.shatterPhase ^= 1; invert ^= this.shatterPhase; }
    this.effInvert = invert;
    const kh = P.keyHue / 360, kt = P.keyTol / 255 * 0.5, ksat = P.keySat / 255, kl = P.keyLuma / 255;
    for (let y = 0; y < H; y++) {
      const row = my[y] * W;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        let m = 0;
        if (P.useStencil) {
          const internal = st[row + mx[x]];
          if (P.stencilSource === 0) m = internal;
          else {
            let key;
            const src = P.stencilSource === 1 ? (inputs.v2 || keySrc) : keySrc;
            const r = src[i * 4] / 255, g = src[i * 4 + 1] / 255, b = src[i * 4 + 2] / 255;
            if (P.stencilSource === 1 || P.keyMode === 1) key = lum(r, g, b) > kl ? 1 : 0;
            else {
              const mxv = r > g ? (r > b ? r : b) : (g > b ? g : b), mnv = r < g ? (r < b ? r : b) : (g < b ? g : b), dd = mxv - mnv;
              let hh = 0;
              if (dd > 0) { hh = mxv === r ? ((g - b) / dd) % 6 : mxv === g ? (b - r) / dd + 2 : (r - g) / dd + 4; hh /= 6; if (hh < 0) hh += 1; }
              let dh = Math.abs(hh - kh); if (dh > 0.5) dh = 1 - dh;
              key = dh < kt && (mxv > 0 ? dd / mxv : 0) > ksat && mxv > 0.12 ? 0 : 1; // On = foreground (not the key colour)
            }
            if (P.keyInvert) key ^= 1;
            m = P.stencilSource === 3 ? key & internal : key;
          }
          m ^= invert;
        }
        mk[i] = m;
      }
    }

    // 5. freeze control decides whether this field grabs into the store
    let grab = false;
    switch (P.freezeMode) {
      case 0: grab = !P.freeze; break;
      case 1: grab = !P.freeze && this.field % this.period(P.rate2) === 0; break;
      case 2: grab = !P.freeze && Math.floor(this.field / this.period(P.rate2)) % 2 === 0; break;
      case 3: case 5: grab = this.singlePending; this.singlePending = false; break;
      case 4: {
        const b = this.audio.b, thr = 0.72 - Math.abs(this.depth()) * 0.55;
        grab = !P.freeze && b > thr && b > this.prevBass * 1.08 && this.field - this.lastPeak > 4;
        if (grab) this.lastPeak = this.field;
        this.prevBass = b; break;
      }
    }

    // 6. plane routing + store update
    const R = DISPLAY[P.display] || DISPLAY[5];
    const [, offD, offU, onD, onU, crawl] = R;
    const kc = this.colourizeColour();
    const kr = Math.round(kc[0] * 15), kg = Math.round(kc[1] * 15), kb = Math.round(kc[2] * 15);
    const store = this.store, view = this.view, cas = this.cascade;
    const wipeEdgeX = P.hwipe ? Math.round((this.g.hpan / 255) * W) : -1;
    const wipeEdgeY = P.vwipe ? Math.round((this.g.vpan / 255) * H) : -1;
    const ownX = this.ownX, ownY = this.ownY;
    // update pass first (writes the store), then readout — this is what makes continuous freeze + zoom/slide/mirror feed back
    if (grab && (offU || onU)) {
      for (let y = 0; y < H; y++) {
        if (!ownY[y]) continue;
        const row = my[y] * W;
        for (let x = 0; x < W; x++) {
          if (!ownX[x]) continue;
          const i = y * W + x, u = mk[i] ? onU : offU;
          if (!u) continue;
          const si = (row + mx[x]) * 3;
          if (u === U_IMG) { store[si] = dg[i * 3]; store[si + 1] = dg[i * 3 + 1]; store[si + 2] = dg[i * 3 + 2]; }
          else { store[si] = kr; store[si + 1] = kg; store[si + 2] = kb; }
        }
      }
    }
    // readout
    const crawlPhase = this.field / (this.period(P.rate1) * 3);
    // colour of one plane at one pixel (4-bit), or -1 for the full-res analog plane
    const planeRGB = (plane, i, x, row, out, o) => {
      let r, g, b;
      if (plane === D) { r = dg[i * 3]; g = dg[i * 3 + 1]; b = dg[i * 3 + 2]; }
      else if (plane === C) { r = cas[i * 3]; g = cas[i * 3 + 1]; b = cas[i * 3 + 2]; }
      else if (plane === A) { r = ana[i * 4] >> 4; g = ana[i * 4 + 1] >> 4; b = ana[i * 4 + 2] >> 4; }
      else {
        const si = (row + mx[x]) * 3;
        r = store[si]; g = store[si + 1]; b = store[si + 2];
        if (crawl && (r | g | b)) {
          const hs = rgb2hsv(r / 15, g / 15, b / 15);
          const xy = x + ((i / W) | 0);
          const ph = crawl === 2 ? 0.5 + 0.5 * Math.sin(crawlPhase * 6.283 + xy * 0.15) : 1;
          const cr = hsv2rgb(hs[0] - crawlPhase + xy * 0.012, Math.max(hs[1], 0.6), hs[2] * (crawl === 2 ? 0.4 + 0.6 * ph : 1));
          r = Math.round(cr[0] * 15); g = Math.round(cr[1] * 15); b = Math.round(cr[2] * 15);
        }
        if (P.stencilShow && st[row + mx[x]]) { r = Math.min(15, r + 4); g = Math.min(15, g + 4); b = Math.min(15, b + 4); }
      }
      out[o] = r * 17; out[o + 1] = g * 17; out[o + 2] = b * 17; out[o + 3] = plane;
    };
    // with a smooth key edge, the compositor needs both the inside and the outside picture everywhere
    const dual = P.keyEdge > 0 && P.useStencil && (P.stencilSource === 1 || P.stencilSource === 2);
    if (dual && (!this.viewOn || this.viewOn.length !== view.length)) { this.viewOn = new Uint8Array(view.length); this.viewOff = new Uint8Array(view.length); }
    this.dual = dual;
    for (let y = 0; y < H; y++) {
      const row = my[y] * W;
      for (let x = 0; x < W; x++) {
        const i = y * W + x, o = i * 4;
        let plane = mk[i] ? onD : offD, pOn = onD, pOff = offD;
        if ((wipeEdgeX >= 0 && x >= wipeEdgeX) || (wipeEdgeY >= 0 && y >= wipeEdgeY)) plane = pOn = pOff = D;
        planeRGB(plane, i, x, row, view, o);
        if (dual) { planeRGB(pOn, i, x, row, this.viewOn, o); planeRGB(pOff, i, x, row, this.viewOff, o); }
      }
    }
    // cascade feedback = this field's composite as the hardware would pass it to a 2nd CVI
    for (let i = 0; i < NN; i++) {
      const o = i * 4, p = view[o + 3];
      if (p === A) { cas[i * 3] = ana[o] >> 4; cas[i * 3 + 1] = ana[o + 1] >> 4; cas[i * 3 + 2] = ana[o + 2] >> 4; }
      else if (p === M) { cas[i * 3] = (view[o] / 17 + (ana[o] >> 4)) >> 1; cas[i * 3 + 1] = (view[o + 1] / 17 + (ana[o + 1] >> 4)) >> 1; cas[i * 3 + 2] = (view[o + 2] / 17 + (ana[o + 2] >> 4)) >> 1; }
      else { cas[i * 3] = view[o] / 17; cas[i * 3 + 1] = view[o + 1] / 17; cas[i * 3 + 2] = view[o + 2] / 17; }
    }

    // 7. running wipes and processes
    if (this.procs.length) this.runProcs();
    this.field++;
  }

  // ---- paint ----
  protectedAt(si) { const P = this.P; return P.drawUnder && P.useStencil && (this.stencil[si] ^ P.invertStencil) === 1; }

  // paint one store pixel with colour k through the current COLOUR TYPE at strength w (0..1)
  paintPixel(si, k, w) {
    const P = this.P, s = this.store, i3 = si * 3;
    if (this.protectedAt(si)) return;
    if (P.useTexture && !texel(P.texture, si % this.W, (si / this.W) | 0)) return;
    if (P.colourType === 0) {
      if (w >= 0.999) { s[i3] = Math.round(k[0] * 15); s[i3 + 1] = Math.round(k[1] * 15); s[i3 + 2] = Math.round(k[2] * 15); return; }
      s[i3] = Math.round((s[i3] / 15 * (1 - w) + k[0] * w) * 15); s[i3 + 1] = Math.round((s[i3 + 1] / 15 * (1 - w) + k[1] * w) * 15); s[i3 + 2] = Math.round((s[i3 + 2] / 15 * (1 - w) + k[2] * w) * 15);
      return;
    }
    const c = [s[i3] / 15, s[i3 + 1] / 15, s[i3 + 2] / 15], o = [0, 0, 0];
    colourMath(P.colourType - 1, c, k, this.depth() * w, this.hsv(), o);
    s[i3] = Math.round(o[0] * 15); s[i3 + 1] = Math.round(o[1] * 15); s[i3 + 2] = Math.round(o[2] * 15);
  }
  stencilPixel(si) { if (this.P.drawUnder && this.P.useStencil && this.P.drawColour) return; this.stencil[si] = this.P.stencilErase ? 0 : 1; }

  // stamp the brush centred on screen point (x, y) — all symmetry copies, through the readout transform
  stamp(x, y) {
    const P = this.P, W = this.W, H = this.H;
    const pts = this.symmetry(x, y);
    const brush = BRUSHES[P.brush] || BRUSHES[0];
    for (const [px, py] of pts) {
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      const cx = this.mapX[px | 0], cy = this.mapY[py | 0];
      const dots = brush.spray ? Array.from({ length: brush.n }, () => { const a = this.rand() * 6.283, r = Math.sqrt(this.rand()) * brush.spray; return [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r), 1]; }) : brush;
      let ext = 1; for (const [dx] of dots) ext = Math.max(ext, Math.abs(dx));
      for (const [dx, dy, wt] of dots) {
        let w = P.dejag ? wt : wt > 0.35 ? 1 : 0;
        if (w <= 0) continue;
        if (P.paintType === 1 && this.rand() > 0.3) continue;
        if (P.paintType === 2) w *= this.rand();
        if (P.paintType === 3) w *= clamp01((dx + ext) / (2 * ext));
        if (P.paintType === 4) w *= clamp01((dy + ext) / (2 * ext));
        const sx = ((cx + dx) % W + W) % W, sy = ((cy + dy) % H + H) % H, si = sy * W + sx;
        if (P.drawColour || !P.drawStencil) this.paintPixel(si, this.paintColour(sx, sy), w);
        if (P.drawStencil && w > 0.3) this.stencilPixel(si);
      }
    }
  }
  symmetry(x, y) {
    const cx = this.W / 2, cy = this.H / 2, dx = x - cx, dy = y - cy;
    switch (this.P.symmetry) {
      case 1: return [[x, y], [cx - dx, y]];
      case 2: return [[x, y], [x, cy - dy]];
      case 3: return [[cx - dx, y]];
      case 4: return [[x, y], [cx - dx, y], [x, cy - dy], [cx - dx, cy - dy]];
      case 5: return [[x, y], [cx - dx, cy - dy], [cx + dy, cy + dx], [cx - dy, cy - dx]];
      case 6: { const o = []; for (const [a, b] of [[dx, dy], [dy, dx]]) for (const sx of [1, -1]) for (const sy of [1, -1]) o.push([cx + a * sx, cy + b * sy]); return o; }
      case 7: return [[x, y], [cx - dy, cy + dx], [cx - dx, cy - dy], [cx + dy, cy - dx]];
      case 8: return [[x, y], [cx - dx, cy - dy]];
      default: return [[x, y]];
    }
  }
  line(x0, y0, x1, y1, spacing = 1) {
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / spacing));
    for (let i = 0; i <= n; i++) this.stamp(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n);
  }
  // filled shapes go straight into the store via screen->store mapping (symmetry applies)
  fillShape(test, x0, y0, x1, y1) {
    const W = this.W, H = this.H, P = this.P;
    const ax = Math.max(0, Math.floor(Math.min(x0, x1))), bx = Math.min(W - 1, Math.ceil(Math.max(x0, x1)));
    const ay = Math.max(0, Math.floor(Math.min(y0, y1))), by = Math.min(H - 1, Math.ceil(Math.max(y0, y1)));
    const done = new Uint8Array(W * H);
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) {
      if (!test(x, y)) continue;
      for (const [px, py] of this.symmetry(x, y)) {
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const sx = this.mapX[px | 0], sy = this.mapY[py | 0], si = sy * W + sx;
        if (done[si]) continue; done[si] = 1;
        let w = 1;
        if (P.paintType === 1 && this.rand() > 0.3) continue;
        if (P.paintType === 2) w = this.rand();
        if (P.paintType === 3) w = (x - ax) / Math.max(1, bx - ax);
        if (P.paintType === 4) w = (y - ay) / Math.max(1, by - ay);
        if (P.drawColour || !P.drawStencil) this.paintPixel(si, this.paintColour(sx, sy), w);
        if (P.drawStencil) this.stencilPixel(si);
      }
    }
  }
  floodFill(x, y) {
    const W = this.W, H = this.H, sx0 = this.mapX[x | 0], sy0 = this.mapY[y | 0], seed = sy0 * W + sx0;
    const sv = this.stencil[seed], seen = new Uint8Array(W * H), stack = [seed];
    seen[seed] = 1;
    const P = this.P;
    while (stack.length) {
      const i = stack.pop();
      if (P.drawColour || !P.drawStencil) this.paintPixel(i, this.paintColour(i % W, (i / W) | 0), P.paintType === 2 ? this.rand() : 1);
      const px = i % W, py = (i / W) | 0;
      for (const [nx, ny] of [[px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]]) {
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const j = ny * W + nx;
        if (!seen[j] && this.stencil[j] === sv) { seen[j] = 1; stack.push(j); }
      }
    }
  }
  title(x, y) {
    const P = this.P, W = this.W, H = this.H;
    const sc = [1, 2, 3, 4, 6][Math.max(0, Math.min(4, P.titleSize - 1))];
    const text = String(P.title || '').toUpperCase().split('\n').slice(0, 7);
    const k = this.paintColour(x, y), comp = [1 - k[0], 1 - k[1], 1 - k[2]];
    const fmt = P.titleFormat;
    const put = (px, py, col) => {
      if (px < 0 || py < 0 || px >= W || py >= H) return;
      const si = this.mapY[py] * W + this.mapX[px];
      if (P.drawColour || !P.drawStencil) {
        if (this.protectedAt(si)) return;
        this.store[si * 3] = Math.round(col[0] * 15); this.store[si * 3 + 1] = Math.round(col[1] * 15); this.store[si * 3 + 2] = Math.round(col[2] * 15);
      }
      if (P.drawStencil) this.stencil[si] = P.stencilErase ? 0 : 1;
    };
    const lineH = 9 * sc;
    const each = (fn) => text.forEach((ln, li) => [...ln].forEach((ch, ci) => {
      const gl = FONT[ch] || FONT['?'];
      for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) if (gl[gy][gx]) fn(x + ci * 6 * sc + gx * sc, y + li * lineH + gy * sc);
    }));
    if (fmt >= 4) text.forEach((ln, li) => { for (let py = -sc; py < 8 * sc; py++) for (let px = -sc; px < ln.length * 6 * sc; px++) put(Math.round(x + px), Math.round(y + li * lineH + py), comp); });
    if (fmt === 2 || fmt === 3 || fmt === 5) { const off = fmt === 3 ? 2 * sc : sc; each((px, py) => { for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) put(Math.round(px + a + off), Math.round(py + b + off), fmt === 5 ? [0, 0, 0] : comp); }); }
    each((px, py) => { for (let a = 0; a < sc; a++) for (let b = 0; b < sc; b++) put(Math.round(px + a), Math.round(py + b), k); });
    if (fmt === 1) text.forEach((ln, li) => { for (let px = 0; px < ln.length * 6 * sc - sc; px++) for (let b = 0; b < sc; b++) put(Math.round(x + px), Math.round(y + li * lineH + 8 * sc + b), k); });
  }

  // pad events: x, y in 0..1 screen space. ph: down | move | up. draw: whether DRAW is held
  padEvent(a) {
    const P = this.P, W = this.W, H = this.H;
    const x = Math.max(0, Math.min(W - 1, a.x * W)), y = Math.max(0, Math.min(H - 1, a.y * H));
    if (a.ph === 'down' && this.pickArmed) {
      this.pickArmed = false;
      const i = ((y | 0) * W + (x | 0)) * 4;
      const v = this.view;
      const hs = rgb2hsv(v[i] / 255, v[i + 1] / 255, v[i + 2] / 255);
      P.hue = Math.round(hs[0] * 255); P.sat = Math.round(hs[1] * 255); P.val = Math.round(hs[2] * 255);
      this.picked = [v[i] / 255, v[i + 1] / 255, v[i + 2] / 255];
      return;
    }
    if (a.ph === 'down' && this.titleArmed) { this.buildMaps(); this.title(Math.round(x), Math.round(y)); return; }
    if (P.panpen && !a.draw) {
      if (a.ph === 'down') this.pad = { x, y };
      else if (a.ph === 'move' && this.pad) {
        P.hpan = Math.max(0, Math.min(255, P.hpan + (x - this.pad.x) * 255 / W));
        P.vpan = Math.max(0, Math.min(255, P.vpan + (y - this.pad.y) * 255 / H));
        this.pad = { x, y };
      } else this.pad = null;
      return;
    }
    if (!a.draw && a.ph === 'down') return;
    this.buildMaps();
    const m = P.paintMethod;
    if (a.ph === 'down') {
      this.pad = { x0: x, y0: y, x, y, acc: 0 };
      if (m === 0 || m === 1) this.stamp(x, y);
      else if (m === 7 && this.clip && this.clip.ready) { this.paste(x, y); this.pad = null; }
      else if (m === 8) { this.floodFill(x, y); this.pad = null; }
      else if (m === 9) { this.procs.push({ t: 'copy', i: 0, n: 250 }); this.pad = null; }
      return;
    }
    const pd = this.pad;
    if (!pd) return;
    if (a.ph === 'move') {
      if (m === 0) this.line(pd.x, pd.y, x, y);
      else if (m === 1) { pd.acc += Math.hypot(x - pd.x, y - pd.y); if (pd.acc > 6) { pd.acc = 0; this.stamp(x, y); } }
      else if (m === 6) this.line(pd.x0, pd.y0, x, y, 2);
      pd.x = x; pd.y = y;
      this.overlay = m >= 2 && m <= 5 || m === 7 ? { m, x0: pd.x0 / W, y0: pd.y0 / H, x1: x / W, y1: y / H } : null;
      return;
    }
    // up
    this.overlay = null;
    const { x0, y0 } = pd;
    if (m === 2) this.line(x0, y0, x, y);
    else if (m === 3) { const r = Math.hypot(x - x0, y - y0); this.fillShape((px, py) => (px - x0) ** 2 + (py - y0) ** 2 <= r * r, x0 - r, y0 - r, x0 + r, y0 + r); }
    else if (m === 4) { const cx = (x0 + x) / 2, cy = (y0 + y) / 2, rx = Math.max(0.5, Math.abs(x - x0) / 2), ry = Math.max(0.5, Math.abs(y - y0) / 2); this.fillShape((px, py) => ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1, x0, y0, x, y); }
    else if (m === 5) this.fillShape(() => true, x0, y0, x, y);
    else if (m === 7) this.cut(x0, y0, x, y);
    this.pad = null;
  }
  cut(x0, y0, x1, y1) {
    const W = this.W, H = this.H, ax = Math.floor(Math.min(x0, x1)), ay = Math.floor(Math.min(y0, y1));
    const w = Math.max(1, Math.abs(Math.floor(x1) - Math.floor(x0))), h = Math.max(1, Math.abs(Math.floor(y1) - Math.floor(y0)));
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = (this.mapY[Math.min(H - 1, ay + y)] * W + this.mapX[Math.min(W - 1, ax + x)]) * 3;
      data.set(this.store.subarray(si, si + 3), (y * w + x) * 3);
    }
    this.clip = { w, h, data, ready: true };
  }
  paste(x, y) {
    const W = this.W, H = this.H, c = this.clip;
    for (let j = 0; j < c.h; j++) for (let i = 0; i < c.w; i++) {
      const px = Math.floor(x) + i, py = Math.floor(y) + j;
      if (px >= W || py >= H) continue;
      const si = this.mapY[py] * W + this.mapX[px];
      if (this.protectedAt(si)) continue;
      this.store.set(c.data.subarray((j * c.w + i) * 3, (j * c.w + i) * 3 + 3), si * 3);
    }
  }

  // ---- wipes ----
  fillStore(k) { const NN = this.W * this.H; for (let i = 0; i < NN; i++) if (!this.protectedAt(i)) { this.store[i * 3] = Math.round(k[0] * 15); this.store[i * 3 + 1] = Math.round(k[1] * 15); this.store[i * 3 + 2] = Math.round(k[2] * 15); } }
  startColourWipe(t) {
    const W = this.W, NN = W * this.H;
    switch (t) {
      case 0: this.fillStore([1, 1, 1]); break;
      case 1: for (let i = 0; i < NN; i++) this.paintPixel(i, this.paintColour(i % W, (i / W) | 0), 1); break;
      case 2: this.procs.push({ t: 'cTex', i: 0, n: 200 }); break;
      case 3: this.procs.push({ t: 'cRight', i: 0, n: 150 }); break;
      case 4: this.procs.push({ t: 'cDown', i: 0, n: 150 }); break;
      case 5: this.procs.push({ t: 'cChange', i: 0, n: 150 }); break;
      case 6: this.procs.push({ t: 'tunnel', i: 0 }); this.tunnelHist = []; break;
      case 7: this.procs.push({ t: 'cDis', i: 0 }); break;
    }
  }
  startStencilWipe(t) {
    const W = this.W, H = this.H, pol = this.P.stencilErase ? 0 : 1;
    switch (t) {
      case 0: this.stencil.fill(pol); break;
      case 1: this.procs.push({ t: 'sTex', i: 0, n: 250 }); break;
      case 2: this.procs.push({ t: 'sRight', i: 0, n: W }); break;
      case 3: this.procs.push({ t: 'sDown', i: 0, n: H }); break;
      case 4: this.procs.push({ t: 'sInv', i: 0, n: 400 }); break;
      case 5: this.procs.push({ t: 'sEdge', i: 0, n: 250 }); break;
      case 6: this.procs.push({ t: 'sCol', i: 0, n: 300 }); break;
      case 7: this.procs.push({ t: 'sDis', i: 0 }); break;
      case 8: {
        const P = this.P, cx = (P.hpan / 255) * W, cy = (P.vpan / 255) * H;
        const sz = 8 + (P.zoom / 255) * H, s = bip(P.stretch);
        const w = sz * (1 + Math.max(0, s) * 2) / 2, h = sz * (1 + Math.max(0, -s) * 2) / 2;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.stencil[y * W + x] = Math.abs(x - cx) <= w && Math.abs(y - cy) <= h ? pol : pol ^ 1;
        break;
      }
    }
  }
  runProcs() {
    const W = this.W, H = this.H, NN = W * H, P = this.P, pol = P.stencilErase ? 0 : 1;
    const span = (p, L) => { const a = Math.floor(p.i * L / p.n), b = Math.floor((p.i + 1) * L / p.n); return [a, Math.max(a + 1, b)]; };
    const keep = [];
    for (const p of this.procs) {
      let done = false;
      switch (p.t) {
        case 'cTex': case 'cRight': case 'sTex': case 'sInv': case 'sEdge': case 'sCol': case 'copy': {
          const [a, b] = span(p, W);
          for (let x = a; x < b && x < W; x++) for (let y = 0; y < H; y++) {
            const si = y * W + x;
            if (p.t === 'cTex') { if (texel(P.texture, x, y)) this.paintPixel(si, this.paintColour(x, y), 1); }
            else if (p.t === 'cRight') this.paintPixel(si, this.paintColour(x, y), 1);
            else if (p.t === 'sTex') this.stencil[si] = texel(P.texture, x, y) ? pol : pol ^ 1;
            else if (p.t === 'sInv') this.stencil[si] ^= 1;
            else if (p.t === 'sEdge') {
              const s = this.store, i3 = si * 3, j3 = (y * W + Math.min(W - 1, x + 1)) * 3, k3 = (Math.min(H - 1, y + 1) * W + x) * 3;
              const dd = Math.abs(s[i3] - s[j3]) + Math.abs(s[i3 + 1] - s[j3 + 1]) + Math.abs(s[i3 + 2] - s[j3 + 2]) + Math.abs(s[i3] - s[k3]) + Math.abs(s[i3 + 1] - s[k3 + 1]) + Math.abs(s[i3 + 2] - s[k3 + 2]);
              this.stencil[si] = dd > 3 ? pol : pol ^ 1;
            } else if (p.t === 'sCol') {
              const s = this.store, i3 = si * 3, k = this.picked;
              const dd = Math.abs(s[i3] / 15 - k[0]) + Math.abs(s[i3 + 1] / 15 - k[1]) + Math.abs(s[i3 + 2] / 15 - k[2]);
              this.stencil[si] = dd < 0.35 ? pol : pol ^ 1;
            } else if (p.t === 'copy') {
              // copy the live digital image into the stencilled area of the store
              if (!(this.stencil[si] ^ P.invertStencil)) continue;
              // find screen pixel showing this store pixel (approximate with identity when no transform)
              const d3 = si * 3;
              this.store[d3] = this.digital[d3]; this.store[d3 + 1] = this.digital[d3 + 1]; this.store[d3 + 2] = this.digital[d3 + 2];
            }
          }
          done = ++p.i >= p.n; break;
        }
        case 'cDown': case 'cChange': {
          const [a, b] = span(p, H);
          for (let y = a; y < b && y < H; y++) for (let x = 0; x < W; x++) this.paintPixel(y * W + x, this.paintColour(x, y), 1);
          done = ++p.i >= p.n; break;
        }
        case 'sRight': { const x = p.i; for (let y = 0; y < H; y++) this.stencil[y * W + x] = pol; done = ++p.i >= W; break; }
        case 'sDown': { const y = p.i; this.stencil.fill(pol, y * W, y * W + W); done = ++p.i >= H; break; }
        case 'sDis': { const n = (NN / 150) | 0; for (let j = 0; j < n; j++) this.stencil[(this.rand() * NN) | 0] = pol; p.i++; break; }
        case 'cDis': { const n = (NN / 150) | 0; for (let j = 0; j < n; j++) { const si = (this.rand() * NN) | 0; this.paintPixel(si, this.paintColour(si % W, (si / W) | 0), 1); } p.i++; break; }
        case 'tunnel': {
          // concentric colour rings radiating from the centre; PAN moves the centre, ZOOM ring width, STRETCH aspect
          this.tunnelHist.unshift(this.paintColour());
          if (this.tunnelHist.length > 400) this.tunnelHist.length = 400;
          const cx = (P.hpan / 255) * W, cy = (P.vpan / 255) * H;
          const ring = 1 + (P.zoom / 255) * 10, s = bip(P.stretch), ax = 1 + Math.max(0, s) * 3, ay = 1 + Math.max(0, -s) * 3;
          const intro = p.i < 150;
          const hist = this.tunnelHist;
          for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
            const si = y * W + x;
            if (this.protectedAt(si)) continue;
            const r = Math.hypot((x - cx) / ax, (y - cy) / ay);
            if (intro && r > (p.i / 150) * Math.max(W, H)) continue;
            const k = hist[Math.min(hist.length - 1, Math.floor(r / ring))];
            this.store[si * 3] = Math.round(k[0] * 15); this.store[si * 3 + 1] = Math.round(k[1] * 15); this.store[si * 3 + 2] = Math.round(k[2] * 15);
          }
          p.i++; break;
        }
      }
      if (!done) keep.push(p);
    }
    this.procs = keep;
  }

  // ---- built-in images (test pattern, colour bars) ----
  drawPattern(kind) {
    const W = this.W, H = this.H, s = this.store;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      let r, g, b;
      if (kind === 'bars') {
        const bar = Math.floor(x / W * 8); // EBU 100/75 order
        const v = y < H * 0.75 ? 11 : 15;
        r = [v, v, 0, 0, v, v, 0, 0][bar]; g = [v, v, v, v, 0, 0, 0, 0][bar]; b = [v, 0, v, 0, v, 0, v, 0][bar];
        if (bar === 0) { r = g = b = 15; }
        if (y >= H * 0.75) { const q = Math.floor(x / W * 4); r = g = b = [0, 5, 10, 15][q]; }
      } else {
        const grid = (x % 32 === 0 || y % 32 === 0) ? 15 : 0;
        const circ = Math.abs(Math.hypot(x - W / 2, y - H / 2) - H * 0.4) < 1.5 ? 15 : 0;
        const ramp = y > H * 0.42 && y < H * 0.58 ? Math.floor(x / W * 16) : -1;
        r = g = b = Math.max(grid, circ);
        if (ramp >= 0) { r = g = b = ramp; }
        if (y > H * 0.25 && y < H * 0.4 && x > W * 0.2 && x < W * 0.8) { const hc = hsv2rgb((x - W * 0.2) / (W * 0.6), 1, 1); r = Math.round(hc[0] * 15); g = Math.round(hc[1] * 15); b = Math.round(hc[2] * 15); }
      }
      s[i] = r; s[i + 1] = g; s[i + 2] = b;
    }
  }
}
