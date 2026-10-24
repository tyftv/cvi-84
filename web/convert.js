// Any-format import. Browsers only play MP4/MOV/WebM with common codecs, so anything else
// (AVI, WMV, FLV, MPEG-2, DV, MXF, ProRes, old DivX/Xvid...) is converted to H.264/AAC MP4 in the
// browser with ffmpeg.wasm. First we try a lossless remux (instant); if that still won't play we transcode.

let ff = null;
const abs = (p) => new URL(p, import.meta.url).href;

// Can this browser decode the file's picture?
export function probePlayable(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto';
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (ok) => { if (done) return; done = true; clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(ok); };
    const timer = setTimeout(() => finish(false), 8000);
    v.onloadeddata = () => finish(v.videoWidth > 0 && v.videoHeight > 0);
    v.onerror = () => finish(false);
    v.src = url;
  });
}

async function getFF(onLog) {
  if (!ff) {
    const { FFmpeg } = await import('./vendor/ffmpeg/index.js');
    ff = new FFmpeg();
    await ff.load({ coreURL: abs('./vendor/ffmpeg/ffmpeg-core.js'), wasmURL: abs('./vendor/ffmpeg/ffmpeg-core.wasm') });
  }
  ff.off('log'); if (onLog) ff.on('log', onLog);
  return ff;
}

// onStatus(text, progress0to1)
export async function convertToMp4(file, onStatus = () => {}) {
  if (file.size > 1.8e9) throw new Error('That file is over 1.8 GB, which is more than the in-browser converter can hold. Convert it to MP4 first (HandBrake or Premiere), then load it.');
  onStatus('Loading converter…', 0);
  const f = await getFF();
  const ext = (file.name.match(/\.[^.]+$/) || ['.bin'])[0].toLowerCase();
  const inName = 'in' + ext, outName = 'out.mp4';
  await f.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
  const base = file.name.replace(/\.[^.]+$/, '');
  const prog = ({ progress }) => onStatus('Converting to MP4…', Math.max(0, Math.min(1, progress)));
  f.on('progress', prog);
  try {
    // 1. lossless remux (works when the codecs are fine and only the container isn't)
    onStatus('Rewrapping as MP4…', 0);
    let code = await f.exec(['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', outName]);
    if (code === 0) {
      const out = new File([await f.readFile(outName)], base + '.mp4', { type: 'video/mp4' });
      if (await probePlayable(out)) return out;
      await f.deleteFile(outName).catch(() => {});
    }
    // 2. full transcode
    onStatus('Converting to MP4…', 0);
    code = await f.exec(['-i', inName, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outName]);
    if (code !== 0) throw new Error('This file could not be converted. It may be damaged or use a codec ffmpeg doesn\'t know.');
    return new File([await f.readFile(outName)], base + '.mp4', { type: 'video/mp4' });
  } finally {
    f.off('progress', prog);
    await f.deleteFile(inName).catch(() => {});
    await f.deleteFile(outName).catch(() => {});
  }
}

export const VIDEO_ACCEPT = 'video/*,.avi,.wmv,.asf,.flv,.f4v,.mkv,.mov,.mp4,.m4v,.webm,.mpg,.mpeg,.m2v,.vob,.ts,.mts,.m2ts,.3gp,.3g2,.ogv,.dv,.mxf,.divx,.xvid,.rm,.rmvb,.gif,.y4m';
export const looksLikeVideo = (f) => f.type.startsWith('video/') || /\.(avi|wmv|asf|flv|f4v|mkv|mov|mp4|m4v|webm|mpe?g|m2v|vob|ts|mts|m2ts|3gp|3g2|ogv|dv|mxf|divx|xvid|rmvb?|gif|y4m)$/i.test(f.name);
