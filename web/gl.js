// WebGL2 compositor: CVI planes -> B&W -> Halftone -> VHS -> CRT
// The analog plane comes straight from the full-resolution source; digital/store/cascade come from the
// engine's 256x256 view (nearest-neighbour, so the field-store pixels stay chunky like the real thing).

const VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const HEAD = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform vec2 res; uniform float time; uniform float frame; uniform float scale;
float h1(vec2 p){ p = fract(p*vec2(443.897,441.423)); p += dot(p, p.yx+19.19); return fract((p.x+p.y)*p.x); }
float vnoise(float x){ float i=floor(x), f=fract(x); f=f*f*(3.-2.*f); return mix(h1(vec2(i,7.1)), h1(vec2(i+1.,7.1)), f); }
vec3 rgb2yiq(vec3 c){ return vec3(dot(c,vec3(.299,.587,.114)), dot(c,vec3(.596,-.274,-.322)), dot(c,vec3(.211,-.523,.312))); }
vec3 yiq2rgb(vec3 c){ return vec3(c.x+.956*c.y+.621*c.z, c.x-.272*c.y-.647*c.z, c.x-1.106*c.y+1.703*c.z); }
`;

const FS_COMPOSITE = HEAD + `
uniform sampler2D analog; uniform sampler2D view; uniform float blanking; uniform float hasVideo;
void main(){
  vec2 u = uv; u.y = 1.-u.y;
  vec4 v = texture(view, u);
  ivec2 vs = textureSize(view, 0);
  int plane = int(texelFetch(view, clamp(ivec2(u*vec2(vs)), ivec2(0), vs-1), 0).a*255.+.5);
  vec3 an = hasVideo > .5 ? texture(analog, u).rgb : vec3(0.);
  vec3 c = plane==0 ? an : plane==3 ? (v.rgb+an)*.5 : v.rgb;
  if (blanking > .5) { vec2 b = step(vec2(.045,.03), u) * step(u, vec2(.955,.97)); c *= b.x*b.y; }
  o = vec4(c,1.);
}`;

const FS_BW = HEAD + `
uniform sampler2D src; uniform float mode, contrast, bright, gamma, grain, grainSize, tintAmt, tintHue, vignette;
vec3 hue2rgb(float h){ return clamp(abs(fract(h+vec3(0.,2./3.,1./3.))*6.-3.)-1.,0.,1.); }
void main(){
  vec3 c = texture(src, uv).rgb;
  vec3 w = mode<.5 ? vec3(.299,.587,.114) : mode<1.5 ? vec3(.7,.25,.05) : mode<2.5 ? vec3(.2,.7,.1) : vec3(.05,.25,.7);
  float l = dot(c, w);
  l = pow(max(l,0.), gamma);
  l = (l-.5)*contrast+.5+bright;
  vec2 gp = floor(uv*res/(grainSize*scale));
  l += (h1(gp + fract(frame*.618)*91.) - .5) * grain;
  float d = length(uv-.5); l *= 1. - vignette*smoothstep(.3,.85,d);
  vec3 col = vec3(clamp(l,0.,1.));
  col *= mix(vec3(1.), (hue2rgb(tintHue)*.6+.4)*1.15, tintAmt);
  o = vec4(col,1.);
}`;

const FS_HALFTONE = HEAD + `
uniform sampler2D src; uniform float style, cell, angle, contrast, mixAmt, shape; uniform vec3 ink, paper;
float dotAt(vec2 px, float ang, float v){
  float s=sin(ang), c=cos(ang);
  vec2 r = mat2(c,-s,s,c)*px;
  vec2 g = fract(r/(cell*scale))-.5;
  float d;
  if (shape<.5) d = length(g)*2.;                 // round
  else if (shape<1.5) d = abs(g.y)*2.;             // lines
  else d = max(abs(g.x),abs(g.y))*2.;              // squares
  float rad = shape<.5 ? sqrt(v)*1.15 : v;
  float aa = 2./(cell*scale);
  return 1.-smoothstep(rad-aa, rad+aa, d);
}
vec3 cellColour(vec2 px, float ang){
  float s=sin(ang), c=cos(ang);
  vec2 r = mat2(c,-s,s,c)*px;
  vec2 cc = (floor(r/(cell*scale))+.5)*(cell*scale);
  vec2 back = mat2(c,s,-s,c)*cc;
  return texture(src, clamp(back/res,0.,1.)).rgb;
}
vec4 cmyk(vec3 sc){
  vec3 cmy = 1.-clamp((sc-.5)*contrast+.5,0.,1.);
  float k = min(cmy.r, min(cmy.g, cmy.b));
  return vec4((cmy-k)/max(1.-k,1e-3), k);
}
void main(){
  vec2 px = uv*res;
  vec3 base = texture(src, uv).rgb;
  vec3 col;
  float a = radians(angle);
  if (style < .5) { // mono
    float l = dot(cellColour(px,a), vec3(.299,.587,.114));
    l = clamp((l-.5)*contrast+.5,0.,1.);
    col = mix(paper, ink, dotAt(px, a, 1.-l));
  } else if (style < 1.5) { // CMYK, classic screen angles
    float ac = a+radians(15.), am = a+radians(75.), ak = a+radians(45.);
    vec4 kc = cmyk(cellColour(px, ac)), km = cmyk(cellColour(px, am)), ky = cmyk(cellColour(px, a)), kk = cmyk(cellColour(px, ak));
    float dc = dotAt(px, ac, kc.x);
    float dm = dotAt(px, am, km.y);
    float dy = dotAt(px, a, ky.z);
    float dk = dotAt(px, ak, kk.w);
    col = paper;
    col *= 1.-dc*vec3(1.,0.,0.)*.95;
    col *= 1.-dm*vec3(0.,1.,0.)*.95;
    col *= 1.-dy*vec3(0.,0.,1.)*.95;
    col *= 1.-dk*.92;
  } else { // colour dots: each cell's own colour on paper
    vec3 sc = cellColour(px, a);
    float l = dot(sc, vec3(.299,.587,.114));
    float d = dotAt(px, a, clamp(1.-(l-.5)*contrast-.5+.5,0.,1.)*.4+.6*max(max(sc.r,sc.g),sc.b));
    col = mix(paper, sc, d);
  }
  o = vec4(mix(base, col, mixAmt),1.);
}`;

const FS_VHS = HEAD + `
uniform sampler2D src; uniform float chromaBlur, chromaShift, soft, sharpen, noise, tracking, jitter, headSwitch, dropouts, sat, bleed, wear;
vec3 yiqAt(vec2 u){ return rgb2yiq(texture(src, clamp(u,0.,1.)).rgb); }
void main(){
  float line = floor(uv.y*res.y*.5);              // ~240 tape lines
  float t = frame;
  // tracking wobble: slow bands of horizontal displacement drifting down the frame
  float band = smoothstep(.0,.08, abs(fract(uv.y*.7 - t*.004)-.5)-.38);
  float wob = (vnoise(line*.07 + t*.37)-.5)*.012*tracking + band*(vnoise(line*.9+t*3.1)-.5)*.05*tracking;
  wob += (h1(vec2(line, t))-.5)*.0025*jitter;
  // head-switching noise at the bottom of the frame
  float hs = smoothstep(.06*headSwitch+.001, 0., uv.y) * headSwitch;
  wob += hs*(.02 + (h1(vec2(line*3., t))-.5)*.03);
  vec2 u = vec2(uv.x + wob, uv.y);
  float px = 1./res.x * (res.x/640.);
  // luma: softened, then sharpened to give the ringing halo
  float y=0., ys=0.;
  for (int i=-3;i<=3;i++){ float w = exp(-float(i*i)/(2.*max(soft,.01)*max(soft,.01)+.01)); y += yiqAt(u+vec2(float(i)*px,0.)).x*w; ys+=w; }
  y/=ys;
  float yw=0., yws=0.;
  for (int i=-6;i<=6;i++){ float w = exp(-float(i*i)/18.); yw += yiqAt(u+vec2(float(i)*px*1.5,0.)).x*w; yws+=w; }
  yw/=yws;
  y += (y-yw)*sharpen;
  // chroma: much lower bandwidth, delayed to the right, bleeding
  vec2 iq = vec2(0.); float cs=0.;
  for (int i=-8;i<=8;i++){ float w = exp(-float(i*i)/(2.*max(chromaBlur,.2)*max(chromaBlur,.2))); iq += yiqAt(u+vec2((float(i)*1.6+chromaShift*3.)*px,0.)).yz*w; cs+=w; }
  iq/=cs;
  vec2 iqb = yiqAt(u+vec2((chromaShift*3.+10.)*px*bleed,0.)).yz;
  iq = mix(iq, max(iq, iqb), bleed*.5);
  iq *= sat * (1.-wear*.35);
  // noise: per-pixel snow plus line streaks
  float n = (h1(uv*res + t*13.1)-.5)*noise*.35;
  float streak = step(1.-noise*.012, h1(vec2(line, floor(t)))) * (h1(vec2(floor(uv.x*res.x/40.), line+t))) * noise;
  y += n + streak*.6;
  iq += vec2(h1(uv*res*.5+t)-.5, h1(uv*res*.5-t)-.5)*noise*.06;
  // dropouts: short white horizontal flecks
  float dl = h1(vec2(line, floor(t*.5)));
  if (dl > 1.-dropouts*.03) { float x0 = h1(vec2(line+1., t)); if (abs(uv.x-x0) < .02+.06*h1(vec2(line,2.))) y = mix(y, .95, .85); }
  y += hs*(h1(vec2(uv.x*200., line+t))-.5)*.4;
  y = mix(y, y*.92+.04, wear);
  vec3 c = yiq2rgb(vec3(y, iq));
  o = vec4(clamp(c,0.,1.),1.);
}`;

const FS_CRT = HEAD + `
uniform sampler2D src; uniform sampler2D prev;
uniform float curv, scan, lines, maskType, maskAmt, bloom, vignette, bright, flicker, persist, converge, interlace, cornerR;
vec2 warp(vec2 u){ vec2 c=u*2.-1.; vec2 off = abs(c.yx)/vec2(6.,4.)*curv; c += c*off*off*4.; return c*.5+.5; }
void main(){
  vec2 u = warp(uv);
  if (u.x<0.||u.y<0.||u.x>1.||u.y>1.) { o = vec4(0.,0.,0.,1.); return; }
  float cv = converge*scale/res.x*2.;
  vec3 c = vec3(texture(src,u+vec2(cv,0.)).r, texture(src,u).g, texture(src,u-vec2(cv,0.)).b);
  // glow
  vec3 g = vec3(0.); float gs=0.;
  for (int i=-2;i<=2;i++) for (int j=-2;j<=2;j++){ float w=exp(-float(i*i+j*j)*.35); g += texture(src, u+vec2(float(i),float(j))*vec2(3.*scale/res.x,3.*scale/res.y)).rgb*w; gs+=w; }
  g/=gs;
  c += g*g*bloom*1.2;
  // scanlines: beam profile gets wider on bright pixels
  float ln = u.y*lines + (interlace>.5 ? mod(frame,2.)*.5 : 0.);
  float l = dot(c, vec3(.299,.587,.114));
  float beam = mix(.25, .55, clamp(l,0.,1.));
  float sl = exp(-pow((fract(ln)-.5)/beam, 2.));
  c *= mix(1., sl*1.6, scan);
  // phosphor mask
  vec2 px = uv*res/max(scale,1.);
  vec3 m = vec3(1.);
  if (maskType > .5 && maskType < 1.5) { float k = mod(floor(px.x),3.); m = k<1.?vec3(1.,.25,.25):k<2.?vec3(.25,1.,.25):vec3(.25,.25,1.); }
  else if (maskType > 1.5 && maskType < 2.5) { float k = mod(floor(px.x)+mod(floor(px.y),2.)*1.5,3.); m = k<1.?vec3(1.,.3,.3):k<2.?vec3(.3,1.,.3):vec3(.3,.3,1.); }
  else if (maskType > 2.5) { float k = mod(floor(px.x),3.); m = k<1.?vec3(1.,.3,.3):k<2.?vec3(.3,1.,.3):vec3(.3,.3,1.); if (mod(floor(px.y)+floor(px.x/3.)*2.,4.)<1.) m*=.4; }
  c *= mix(vec3(1.), m*1.35, maskAmt);
  // vignette, corners, flicker
  vec2 d = u*2.-1.;
  c *= 1.-vignette*dot(d,d)*.35;
  vec2 cr = max(abs(d)-1.+cornerR, 0.);
  c *= 1.-smoothstep(cornerR*.5, cornerR, length(cr)) * step(.001, cornerR);
  c *= bright * (1.-flicker*.04*(.5+.5*sin(frame*2.7)));
  vec3 pv = texture(prev, uv).rgb;
  c = max(c, pv*persist);
  o = vec4(c,1.);
}`;

const FS_COPY = HEAD + `uniform sampler2D src; void main(){ o = vec4(texture(src, uv).rgb,1.); }`;

// chain passes ---------------------------------------------------------------
// source upload (top-down rows) -> FBO orientation
const FS_SRC = HEAD + `uniform sampler2D src; void main(){ o = vec4(texture(src, vec2(uv.x, 1.-uv.y)).rgb,1.); }`;
// CVI planes over an input picture that is already in FBO orientation
const FS_COMP2 = HEAD + `
uniform sampler2D analog; uniform sampler2D view; uniform float blanking;
void main(){
  vec2 u = vec2(uv.x, 1.-uv.y);
  vec4 v = texture(view, u);
  ivec2 vs = textureSize(view, 0);
  int plane = int(texelFetch(view, clamp(ivec2(u*vec2(vs)), ivec2(0), vs-1), 0).a*255.+.5);
  vec3 an = texture(analog, uv).rgb;
  vec3 c = plane==0 ? an : plane==3 ? (v.rgb+an)*.5 : v.rgb;
  if (blanking > .5) { vec2 b = step(vec2(.045,.03), u) * step(u, vec2(.955,.97)); c *= b.x*b.y; }
  o = vec4(c,1.);
}`;
// keyed composite with a smooth, full-resolution key edge (the inside/outside pictures come from the engine)
const FS_COMP3 = HEAD + `
uniform sampler2D analog; uniform sampler2D vOn; uniform sampler2D vOff; uniform sampler2D keysrc;
uniform float keyMode, keyHue, keyTol, keySat, keyLuma, keyInv, soft;
vec3 hsv(vec3 c){ vec4 K=vec4(0.,-1./3.,2./3.,-1.); vec4 p=mix(vec4(c.bg,K.wz),vec4(c.gb,K.xy),step(c.b,c.g)); vec4 q=mix(vec4(p.xyw,c.r),vec4(c.r,p.yzx),step(p.x,c.r)); float d=q.x-min(q.w,q.y); return vec3(abs(q.z+(q.w-q.y)/(6.*d+1e-10)), d/(q.x+1e-10), q.x); }
vec3 plane(sampler2D v, vec2 u, vec3 an){
  ivec2 vs = textureSize(v, 0);
  vec4 t = texelFetch(v, clamp(ivec2(u*vec2(vs)), ivec2(0), vs-1), 0);
  int p = int(t.a*255.+.5);
  return p==0 ? an : p==3 ? (t.rgb+an)*.5 : t.rgb;
}
void main(){
  vec2 u = vec2(uv.x, 1.-uv.y);
  vec3 an = texture(analog, uv).rgb;
  vec3 k = texture(keysrc, uv).rgb;
  float fg;
  if (keyMode > .5) fg = smoothstep(keyLuma - soft, keyLuma + soft, dot(k, vec3(.299,.587,.114)));
  else {
    vec3 h = hsv(k);
    float dh = abs(h.x - keyHue); dh = min(dh, 1.-dh);
    float bg = (1. - smoothstep(keyTol - soft, keyTol + soft, dh)) * smoothstep(keySat - soft, keySat + soft, h.y) * smoothstep(.12 - soft*.5, .12 + soft*.5, h.z);
    fg = 1. - bg;
  }
  if (keyInv > .5) fg = 1. - fg;
  o = vec4(mix(plane(vOff, u, an), plane(vOn, u, an), fg), 1.);
}`;
// hardware blanking borders
const FS_BLANK = HEAD + `uniform sampler2D src; void main(){ vec2 b = step(vec2(.045,.03), uv) * step(uv, vec2(.955,.97)); o = vec4(texture(src, uv).rgb*b.x*b.y, 1.); }`;
// blend an effect's output with its input
const FS_MIX = HEAD + `uniform sampler2D src; uniform sampler2D other; uniform float amount;
void main(){ o = vec4(mix(texture(other, uv).rgb, texture(src, uv).rgb, amount), 1.); }`;
// downsample for the CVI digitiser: 4x4 box, flipped so readPixels returns top row first
const FS_GRAB = HEAD + `uniform sampler2D src; uniform vec2 srcRes; uniform vec2 dstRes;
void main(){
  vec2 u = vec2(uv.x, 1.-uv.y);
  vec2 cell = 1./dstRes; vec3 acc = vec3(0.);
  for (int i=0;i<4;i++) for (int j=0;j<4;j++) acc += texture(src, u + (vec2(float(i),float(j))-1.5)/4.*cell).rgb;
  o = vec4(acc/16., 1.);
}`;

export const LOOK_DEFAULTS = {
  bw: { on: 0, mode: 0, contrast: 1.15, bright: 0, gamma: 1, grain: 0.12, grainSize: 1.5, tintAmt: 0, tintHue: 0.08, vignette: 0.3 },
  halftone: { on: 0, style: 0, cell: 8, angle: 45, contrast: 1.2, mixAmt: 1, shape: 0, ink: [0.08, 0.07, 0.12], paper: [0.96, 0.94, 0.88] },
  vhs: { on: 0, chromaBlur: 3, chromaShift: 1.5, soft: 1.2, sharpen: 0.6, noise: 0.35, tracking: 0.4, jitter: 0.5, headSwitch: 0.6, dropouts: 0.4, sat: 1.1, bleed: 0.5, wear: 0.2 },
  crt: { on: 0, curv: 0.6, scan: 0.7, lines: 480, maskType: 1, maskAmt: 0.45, bloom: 0.5, vignette: 0.6, bright: 1.25, flicker: 0.3, persist: 0.35, converge: 1.2, interlace: 0, cornerR: 0.06 },
};

export class Renderer {
  constructor(canvas, N = 256) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available in this browser.');
    this.gl = gl; this.canvas = canvas; this.N = N;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.progs = {
      composite: this.prog(FS_COMPOSITE), bw: this.prog(FS_BW), halftone: this.prog(FS_HALFTONE),
      vhs: this.prog(FS_VHS), crt: this.prog(FS_CRT), copy: this.prog(FS_COPY),
      src: this.prog(FS_SRC), comp2: this.prog(FS_COMP2), mix: this.prog(FS_MIX), grab: this.prog(FS_GRAB), blank: this.prog(FS_BLANK), comp3: this.prog(FS_COMP3),
    };
    this.targets = new Map(); this.grabT = null;
    this.tex = { analog: this.makeTex(gl.LINEAR), v2: this.makeTex(gl.LINEAR), view: this.makeTex(gl.NEAREST), vOn: this.makeTex(gl.NEAREST), vOff: this.makeTex(gl.NEAREST) };
    this.fbos = [];
    this.w = 0; this.h = 0;
    this.setViewSize(N);
  }
  prog(fs) {
    const gl = this.gl;
    const mk = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => i + 1 + ': ' + l).join('\n')); return s; };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, VS)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  makeTex(filter) {
    const gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return t;
  }
  setViewSize(N) { this.N = N; }
  resize(w, h) {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h;
    const gl = this.gl;
    for (const f of this.fbos) { gl.deleteFramebuffer(f.fb); gl.deleteTexture(f.t); }
    this.fbos = [];
    for (let i = 0; i < 4; i++) {
      const t = this.makeTex(gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      this.fbos.push({ fb, t });
    }
    this.crtPrev = 3; // fbo 3 holds last CRT output for phosphor persistence
    for (const t of this.targets.values()) { gl.deleteFramebuffer(t.fb); gl.deleteTexture(t.t); }
    this.targets.clear();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  makeTarget(w, h) {
    const gl = this.gl, t = this.makeTex(gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { fb, t, w, h };
  }
  // a named full-size render target (one per chain slot), created on demand
  target(id) {
    let t = this.targets.get(id);
    if (!t) { t = this.makeTarget(this.w, this.h); this.targets.set(id, t); }
    return t;
  }
  dropTargets(keep) { for (const [id, t] of this.targets) if (!keep.has(id)) { this.gl.deleteFramebuffer(t.fb); this.gl.deleteTexture(t.t); this.targets.delete(id); } }
  // generic pass into a target object (or the canvas when target is null)
  run(name, uniforms, srcTex, target, extra) {
    const gl = this.gl, pr = this.progs[name];
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    let unit = 0;
    const bind = (nm, t) => { if (pr.u[nm] == null) return; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(pr.u[nm], unit); unit++; };
    if (srcTex) bind('src', srcTex);
    if (extra) for (const k in extra) bind(k, extra[k]);
    if (pr.u.res) gl.uniform2f(pr.u.res, this.w, this.h);
    if (pr.u.scale) gl.uniform1f(pr.u.scale, this.h / 720);
    for (const k in uniforms) {
      const loc = pr.u[k]; if (loc == null) continue;
      const v = uniforms[k];
      if (Array.isArray(v)) { if (v.length === 2) gl.uniform2fv(loc, v); else gl.uniform3fv(loc, v); } else gl.uniform1f(loc, +v);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // upload a video frame / canvas into a texture slot ('analog' = video 1, 'v2' = video 2)
  uploadSource(slot, src) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[slot]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }
  // read a texture back at the CVI grid size (RGBA8, top row first)
  grab(tex, gw, gh) {
    const gl = this.gl;
    if (!this.grabT || this.grabT.w !== gw || this.grabT.h !== gh) {
      if (this.grabT) { gl.deleteFramebuffer(this.grabT.fb); gl.deleteTexture(this.grabT.t); }
      this.grabT = this.makeTarget(gw, gh);
    }
    this.run('grab', { srcRes: [this.w, this.h], dstRes: [gw, gh] }, tex, this.grabT);
    const out = new Uint8Array(gw * gh * 4);
    gl.readPixels(0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }
  present(tex) { this.run('copy', {}, tex, null); }
  uploadAnalog(src) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.analog);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    this.hasVideo = 1;
  }
  uploadView(data, w, h = w) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.view);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  uploadGrid(slot, data, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[slot]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  // smooth = soften the field-store pixels instead of hard squares
  setSmooth(on) {
    const gl = this.gl, f = on ? gl.LINEAR : gl.NEAREST;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.view);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    this.smooth = !!on;
  }
  pass(name, uniforms, srcTex, target, extra) {
    const gl = this.gl, pr = this.progs[name];
    gl.useProgram(pr.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target === null ? null : this.fbos[target].fb);
    gl.viewport(0, 0, this.w, this.h);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    let unit = 0;
    const bind = (nm, t) => { if (pr.u[nm] == null) return; gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(pr.u[nm], unit); unit++; };
    if (srcTex) bind('src', srcTex);
    if (extra) for (const k in extra) bind(k, extra[k]);
    if (pr.u.res) gl.uniform2f(pr.u.res, this.w, this.h);
    if (pr.u.scale) gl.uniform1f(pr.u.scale, this.h / 720);
    for (const k in uniforms) {
      const loc = pr.u[k]; if (loc == null) continue;
      const v = uniforms[k];
      if (Array.isArray(v)) gl.uniform3fv(loc, v); else gl.uniform1f(loc, +v);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // looks: {bw, halftone, vhs, crt}; frame: integer frame index (drives all noise deterministically)
  render(looks, frame, blanking) {
    const order = ['bw', 'halftone', 'vhs', 'crt'].filter((k) => looks[k] && looks[k].on);
    // ping-pong between fbo 0 and 1; CRT also reads fbo 3 (its last output) and writes fbo 2 then copies to 3
    let cur = 0;
    this.pass('composite', { blanking: blanking ? 1 : 0, hasVideo: this.hasVideo ? 1 : 0, frame }, null, 0, { analog: this.tex.analog, view: this.tex.view });
    for (const k of order) {
      const nxt = cur === 0 ? 1 : 0;
      if (k === 'crt') {
        this.pass('crt', { ...looks.crt, frame }, this.fbos[cur].t, 2, { prev: this.fbos[3].t });
        this.pass('copy', {}, this.fbos[2].t, 3);
        cur = 2; continue;
      }
      this.pass(k, { ...looks[k], frame }, this.fbos[cur].t, nxt);
      cur = nxt;
    }
    this.pass('copy', {}, this.fbos[cur].t, null);
  }
}
