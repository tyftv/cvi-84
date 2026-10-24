// CVI-84 timeline: two video tracks of clips.
// Track 0 = Video 1 (top, runs through the effect chain). Clips butt together with no gaps: drag to reorder.
// Track 1 = Video 2 (underneath, shows through keyed areas). Clips sit anywhere, gaps allowed.

export const MIN_CLIP = 0.1; // seconds
let nextId = 1;

export const tl = {
  media: [],          // imported files
  tracks: [[], []],   // clips per track, sorted by start
  mute: [false, false],
  proj: null,         // [w, h] picture shape of the project, set by the first clip imported
};

export const clipLen = (c) => c.out - c.in;
export const clipEnd = (c) => c.start + clipLen(c);
export const hasClips = () => tl.tracks[0].length + tl.tracks[1].length > 0;
export function duration() { let d = 0; for (const cl of tl.tracks) for (const c of cl) d = Math.max(d, clipEnd(c)); return d; }
export function clipAt(track, t) { for (const c of tl.tracks[track]) if (t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) return c; return null; }
export function trackOf(c) { return tl.tracks[0].includes(c) ? 0 : tl.tracks[1].includes(c) ? 1 : -1; }

// ---------------------------------------------------------------- media
export async function addMedia(file) {
  const url = URL.createObjectURL(file);
  const el = document.createElement('video');
  el.src = url; el.muted = true; el.preload = 'metadata';
  await new Promise((res, rej) => { el.onloadedmetadata = res; el.onerror = () => rej(new Error(`${file.name} could not be decoded by this browser.`)); });
  const m = { id: nextId++, file, name: file.name, url, dur: el.duration || 0, w: el.videoWidth || 640, h: el.videoHeight || 480, fps: 0, env: null, thumbs: [], hasAudio: true };
  el.removeAttribute('src'); el.load();
  if (!isFinite(m.dur) || m.dur <= 0) m.dur = 1;
  tl.media.push(m);
  probeMedia(m);
  return m;
}
// frame rate, audio and a filmstrip, worked out in the background
async function probeMedia(m) {
  try {
    const MB = await import('./vendor/mediabunny.min.mjs');
    const input = new MB.Input({ source: new MB.BlobSource(m.file), formats: MB.ALL_FORMATS });
    const vt = await input.getPrimaryVideoTrack();
    m.hasAudio = !!(await input.getPrimaryAudioTrack());
    if (!vt) return;
    try { const st = await vt.computePacketStats(120); m.fps = st.averagePacketRate || 0; } catch {}
    const sink = new MB.CanvasSink(vt, { height: 72, fit: 'fill', width: Math.max(8, Math.round(72 * m.w / m.h)) });
    const n = Math.max(2, Math.min(120, Math.ceil(m.dur / Math.max(0.5, m.dur / 120))));
    const ts = Array.from({ length: n }, (_, i) => Math.min(m.dur - 0.01, (i + 0.5) * m.dur / n));
    let i = 0;
    for await (const wc of sink.canvasesAtTimestamps(ts)) {
      if (wc) m.thumbs.push({ t: ts[i], img: await createImageBitmap(wc.canvas) });
      i++;
    }
  } catch (e) { console.warn('probe', m.name, e); }
}
export function thumbAt(m, t) {
  const th = m.thumbs; if (!th.length) return null;
  let best = th[0], bd = Infinity;
  for (const x of th) { const d = Math.abs(x.t - t); if (d < bd) { bd = d; best = x; } }
  return best.img;
}

// ---------------------------------------------------------------- clips
function makeEl(m) {
  const el = document.createElement('video');
  el.src = m.url; el.playsInline = true; el.preload = 'auto';
  return el;
}
export function makeClip(m, inP = 0, outP = m.dur) { return { id: nextId++, media: m, in: inP, out: outP, start: 0, el: makeEl(m) }; }

// keep Video 1 gapless and both tracks sorted
export function restack() {
  let t = 0;
  for (const c of tl.tracks[0]) { c.start = t; t += clipLen(c); }
  tl.tracks[1].sort((a, b) => a.start - b.start);
}
// can a clip of length len sit on Video 2 at start without overlapping (ignoring `skip`)?
export function v2Free(start, len, skip) {
  if (start < -1e-6) return false;
  for (const c of tl.tracks[1]) if (c !== skip && start < clipEnd(c) - 1e-6 && start + len > c.start + 1e-6) return false;
  return true;
}
// nearest place on Video 2 at or around `want` where the clip fits
export function v2Place(want, len, skip) {
  want = Math.max(0, want);
  if (v2Free(want, len, skip)) return want;
  const cands = [0];
  for (const c of tl.tracks[1]) if (c !== skip) { cands.push(clipEnd(c)); cands.push(c.start - len); }
  let best = null;
  for (const s of cands) if (s >= 0 && v2Free(s, len, skip) && (best === null || Math.abs(s - want) < Math.abs(best - want))) best = s;
  return best;
}
export function insertClip(c, track, opts = {}) {
  if (track === 0) {
    const i = opts.index ?? tl.tracks[0].length;
    tl.tracks[0].splice(Math.max(0, Math.min(tl.tracks[0].length, i)), 0, c);
  } else {
    const want = opts.at ?? tl.tracks[1].reduce((e, x) => Math.max(e, clipEnd(x)), 0);
    c.start = v2Place(want, clipLen(c), c) ?? tl.tracks[1].reduce((e, x) => Math.max(e, clipEnd(x)), 0);
    tl.tracks[1].push(c);
  }
  restack();
}
export function detach(c) {
  for (const cl of tl.tracks) { const i = cl.indexOf(c); if (i >= 0) cl.splice(i, 1); }
  restack();
}
export function removeClip(c) { detach(c); c.el.pause(); }
export function splitClip(c, t) {
  const at = c.in + (t - c.start);
  if (at - c.in < MIN_CLIP || c.out - at < MIN_CLIP) return null;
  const k = trackOf(c);
  const b = makeClip(c.media, at, c.out); b.start = t;
  c.out = at;
  if (k === 0) tl.tracks[0].splice(tl.tracks[0].indexOf(c) + 1, 0, b); else tl.tracks[1].push(b);
  restack();
  return b;
}
// V1 index a clip dropped at time t would land at (ignoring `skip`)
export function v1IndexAt(t, skip) {
  let s = 0, i = 0;
  for (const c of tl.tracks[0]) { if (c === skip) continue; if (t > s + clipLen(c) / 2) i++; s += clipLen(c); }
  return i;
}

// undo snapshot of the layout (clip objects keep their video elements)
export function snapshot() { return { tracks: tl.tracks.map((cl) => cl.map((c) => ({ c, start: c.start, in: c.in, out: c.out }))), mute: [...tl.mute] }; }
export function restore(s) {
  const keep = new Set(s.tracks.flat().map((x) => x.c));
  for (const cl of tl.tracks) for (const c of cl) if (!keep.has(c)) c.el.pause();
  tl.tracks = s.tracks.map((cl) => cl.map((x) => { Object.assign(x.c, { start: x.start, in: x.in, out: x.out }); return x.c; }));
  tl.mute = [...s.mute];
  restack();
}

// ---------------------------------------------------------------- playback: keep each clip's <video> where the playhead says
export function syncMedia(T, playing) {
  tl.tracks.forEach((cl, k) => {
    for (const c of cl) {
      const el = c.el;
      el.muted = tl.mute[k];
      const active = T >= c.start - 1e-6 && T < clipEnd(c) - 1e-6;
      if (active) {
        const want = c.in + (T - c.start);
        if (playing) {
          if (el.paused) { if (Math.abs(el.currentTime - want) > 0.05) el.currentTime = want; el.play().catch(() => {}); }
          else if (Math.abs(el.currentTime - want) > 0.3 && !el.seeking) el.currentTime = want;
        } else {
          if (!el.paused) el.pause();
          if (!el.seeking && Math.abs(el.currentTime - want) > 0.01) el.currentTime = want;
        }
      } else {
        if (!el.paused) el.pause();
        // park clips that are about to start on their first frame
        if (c.start > T && c.start - T < 4 && !el.seeking && Math.abs(el.currentTime - c.in) > 0.03) el.currentTime = c.in;
      }
    }
  });
}
export function pauseAll() { for (const cl of tl.tracks) for (const c of cl) c.el.pause(); }

export function toJSON() { return { mute: [...tl.mute], tracks: tl.tracks.map((cl) => cl.map((c) => ({ name: c.media.name, in: c.in, out: c.out, start: c.start }))) }; }
// rebuild a saved layout when every file it uses has been imported; returns false otherwise
export function fromJSON(j) {
  if (!j || !j.tracks) return false;
  const byName = (n) => tl.media.find((m) => m.name === n);
  if (!j.tracks.flat().every((x) => byName(x.name))) return false;
  pauseAll();
  tl.tracks = j.tracks.map((cl) => cl.map((x) => { const c = makeClip(byName(x.name), x.in, x.out); c.start = x.start; return c; }));
  tl.mute = [...(j.mute || [false, false])];
  restack();
  return true;
}
