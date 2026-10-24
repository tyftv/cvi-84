// Automation = the CVI's SEQUENCER, done like a DAW.
// Continuous controls live in lanes of {f, v} points (f = field index, 50 or 60 per second).
// One-shot gestures (button presses, pad strokes, preset loads, wipes) live in an ordered event list.
// Recording uses "touch" mode: while you hold a control, its lane is overwritten; let go and it reads again.

export class Automation {
  constructor() { this.clear(); }
  clear() { this.lanes = new Map(); this.events = []; this.touch = new Map(); this.cursor = 0; }
  isEmpty() { return this.lanes.size === 0 && this.events.length === 0; }

  // ---- recording ----
  // prev = the control's value before this touch; a new lane starts with it at field 0 so the
  // recording only takes effect from the moment you touched the control.
  recordValue(lane, f, v, prev) {
    let pts = this.lanes.get(lane);
    if (!pts) { pts = []; this.lanes.set(lane, pts); }
    if (!pts.length && f > 0 && prev !== undefined) pts.push({ f: 0, v: JSON.parse(JSON.stringify(prev)) });
    const from = this.touch.has(lane) ? this.touch.get(lane) : f;
    // overwrite everything between where this touch last wrote and now
    let i = 0; while (i < pts.length && pts[i].f < from) i++;
    let j = i; while (j < pts.length && pts[j].f <= f) j++;
    pts.splice(i, j - i, { f, v });
    this.touch.set(lane, f);
  }
  release(lane) { this.touch.delete(lane); }
  releaseAll() { this.touch.clear(); }
  recordEvent(f, a) {
    let i = this.events.length;
    while (i > 0 && this.events[i - 1].f > f) i--;
    this.events.splice(i, 0, { f, a: JSON.parse(JSON.stringify(a)) });
    if (i <= this.cursor) this.cursor++;
    if (this.cur) for (const [k, c] of this.cur) if (i < c) this.cur.set(k, c + 1);
  }
  clearLane(lane) { if (lane === '#events') this.events = []; else this.lanes.delete(lane); }

  // ---- reading ----
  valueAt(lane, f) {
    const pts = this.lanes.get(lane);
    if (!pts || !pts.length) return undefined;
    if (f <= pts[0].f) return pts[0].v;
    let lo = 0, hi = pts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid].f <= f) lo = mid; else hi = mid - 1; }
    return pts[lo].v;
  }
  // values of every lane at field f (skipping lanes being touched)
  valuesAt(f) {
    const out = [];
    for (const [lane] of this.lanes) if (!this.touch.has(lane)) out.push([lane, this.valueAt(lane, f)]);
    return out;
  }
  seekEvents(f) { let i = 0; while (i < this.events.length && this.events[i].f < f) i++; this.cursor = i; }
  // events scheduled exactly at field f (call once per field, in order)
  eventsAt(f) {
    const out = [];
    while (this.cursor < this.events.length && this.events[this.cursor].f < f) this.cursor++;
    while (this.cursor < this.events.length && this.events[this.cursor].f === f) out.push(this.events[this.cursor++].a);
    return out;
  }

  // ---- per-block reading (lanes are named "<blockId>|<param>", events carry a.node) ----
  valuesFor(id, f) {
    const out = [], pre = id + '|';
    for (const [lane] of this.lanes) if (lane.startsWith(pre) && !this.touch.has(lane)) out.push([lane.slice(pre.length), this.valueAt(lane, f)]);
    return out;
  }
  eventsFor(id, f) {
    if (!this.cur) this.cur = new Map();
    let c = this.cur.get(id) || 0;
    const ev = this.events;
    if (c > 0 && c <= ev.length && ev[c - 1] && ev[c - 1].f >= f) c = 0; // went backwards: rescan
    while (c < ev.length && ev[c].f < f) c++;
    const out = [];
    let j = c;
    while (j < ev.length && ev[j].f === f) { if (ev[j].a.node === id) out.push(ev[j].a); j++; }
    this.cur.set(id, j);
    return out;
  }
  resetCursors() { this.cur = new Map(); }
  toJSON() { return { lanes: [...this.lanes.entries()], events: this.events }; }
  static fromJSON(j) { const a = new Automation(); a.lanes = new Map(j.lanes || []); a.events = j.events || []; return a; }
}
