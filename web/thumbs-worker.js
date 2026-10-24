// Renders effect thumbnails off the main thread: each effect runs for a moment on the demo clip.
import { CVI } from './cvi-engine.js';
import { drawDemo } from './demo.js';
const N = 256;
const demo = new OffscreenCanvas(640, 480);
const samp = new OffscreenCanvas(N, N).getContext('2d', { willReadFrequently: true });
self.onmessage = (e) => {
  const { key, state } = e.data;
  const eng = new CVI(N);
  eng.applyPresetState(state);
  let d;
  for (let f = 0; f < 36; f++) {
    drawDemo(demo, 1.2 + f / 25);
    samp.drawImage(demo, 0, 0, N, N);
    d = samp.getImageData(0, 0, N, N).data;
    const beat = (f / 50) * 2, ph = beat - Math.floor(beat);
    eng.step({ v1: d, v2: d }, { b: Math.exp(-ph * 6), m: 0.5, t: 0.4 });
  }
  const out = new Uint8ClampedArray(N * N * 4), v = eng.view;
  for (let i = 0; i < N * N; i++) {
    const o = i * 4, pl = v[o + 3];
    const k = pl === 0 ? 1 : pl === 3 ? 0.5 : 0;
    out[o] = v[o] * (1 - k) + d[o] * k; out[o + 1] = v[o + 1] * (1 - k) + d[o + 1] * k; out[o + 2] = v[o + 2] * (1 - k) + d[o + 2] * k; out[o + 3] = 255;
  }
  self.postMessage({ key, data: out }, [out.buffer]);
};
