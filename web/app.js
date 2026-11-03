/* PCB Scope — microscope viewer + PCB computer vision (UI thread). */
'use strict';
(() => {
const $ = (s, r = document) => r.querySelector(s);
const LS = {
  get(k, d) { try { const v = localStorage.getItem('pcbscope.' + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('pcbscope.' + k, JSON.stringify(v)); } catch (_) {} },
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- model ---------- */

const CLASSES = {
  ic:      { name: 'ICs / packages',        color: '#ff6b6b' },
  res:     { name: 'Resistors / diodes',    color: '#ffb84d' },
  cap:     { name: 'MLCC capacitors',       color: '#4dd0ff' },
  part:    { name: 'Other parts',           color: '#c39bff' },
  pad:     { name: 'Pads / solder',         color: '#e8f07a' },
  hole:    { name: 'Holes / open vias',     color: '#ff7ad9' },
  via:     { name: 'Tented vias (Hough)',   color: '#7affc1' },
  copper:  { name: 'Exposed copper / gold', color: '#ff9a3d' },
  anomaly: { name: 'Irregular dark (burn / residue?)', color: '#ff3b3b' },
  diff:    { name: 'Reference differences', color: '#ff2d55' },
};
const EXTRA_LAYERS = { board: 'Solder-mask outline', classmap: 'Pixel classes (tuning view)', peaking: 'Focus peaking' };
const CLASSMAP_RGBA = [null, [40, 200, 90], [70, 90, 255], [255, 255, 255], [255, 170, 60], [255, 70, 0]];
const LIST_CLASSES = ['ic', 'res', 'cap', 'part', 'copper', 'anomaly', 'diff'];
const SMALL = new Set(['pad', 'hole', 'via']);

const DEFAULTS = {
  procMax: 960, interval: 120,
  maskHue: 'auto', maskTol: 16, maskSmin: 60, maskVmax: 235, darkRel: 80, silkW: 8,
  darkV: 70, bodyS: 40, bodyClose: 3, tanS: 28, metalS: 45, metalV: 150, copperS: 130, copperMin: 6,
  silkFilter: true, silkV: 190, silkStd: 16, boardOnly: true, anomS: 70,
  minPart: 12, rectMin: 0.72, padMin: 3, holeMax: 30,
  viaSens: 28, viaRmin: 3, viaRmax: 14,
  peakThr: 35, focusFull: false,
  align: 'orb', diffThr: 38, diffMin: 10, orbN: 1500,
};
const LAYER_DEFAULTS = { ic: 1, res: 1, cap: 1, part: 1, pad: 0, hole: 1, via: 0, copper: 1, anomaly: 0, diff: 1, board: 0, classmap: 0, peaking: 0 };
const TUNING = [
  { g: 'Solder mask' },
  { key: 'maskHue', label: 'Mask colour', opts: [['auto', 'Auto'], ['60', 'Green'], ['105', 'Blue'], ['175', 'Red'], ['145', 'Purple'], ['28', 'Yellow'], ['none', 'None (black / white mask)']] },
  { key: 'maskTol', label: 'Hue tolerance', min: 4, max: 40, step: 1 },
  { key: 'maskSmin', label: 'Mask min saturation', min: 10, max: 200, step: 1 },
  { key: 'maskVmax', label: 'Mask max V (brighter = part body)', min: 120, max: 255, step: 1 },
  { g: 'Pixel classes (OpenCV HSV: H 0–179, S/V 0–255)' },
  { key: 'darkRel', label: 'Dark body: % of board brightness (0 = fixed V below)', min: 0, max: 120, step: 1 },
  { key: 'darkV', label: 'Dark body: fixed max V', min: 15, max: 150, step: 1 },
  { key: 'bodyS', label: 'Grey body: max S (below metal V)', min: 0, max: 120, step: 1 },
  { key: 'tanS', label: 'MLCC (warm hue H 4–32): min S', min: 5, max: 120, step: 1 },
  { key: 'metalS', label: 'Metal / solder: max S', min: 10, max: 150, step: 1 },
  { key: 'metalV', label: 'Metal / solder: min V', min: 60, max: 250, step: 1 },
  { key: 'copperS', label: 'Copper / gold: min S', min: 60, max: 250, step: 1 },
  { g: 'Shapes (px at 960 px processing width)' },
  { key: 'boardOnly', label: 'Ignore things off the board (when the board fills ≥25% of view)', bool: true },
  { key: 'anomS', label: 'Burn / residue: max saturation', min: 20, max: 160, step: 1 },
  { key: 'minPart', label: 'Min part size', min: 3, max: 120, step: 1 },
  { key: 'bodyClose', label: 'Bridge marking text on bodies', min: 0, max: 10, step: 1 },
  { key: 'silkW', label: 'Silkscreen line width to ignore', min: 1, max: 30, step: 1 },
  { key: 'rectMin', label: 'Min rectangularity', min: 0.4, max: 0.95, step: 0.01 },
  { key: 'padMin', label: 'Min pad width', min: 1, max: 20, step: 1 },
  { key: 'holeMax', label: 'Max hole diameter', min: 4, max: 150, step: 1 },
  { key: 'copperMin', label: 'Min copper patch', min: 2, max: 60, step: 1 },
  { g: 'Silkscreen rejection (pads)' },
  { key: 'silkFilter', label: 'Drop flat white blobs (silkscreen)', bool: true },
  { key: 'silkV', label: 'Silk: min mean V', min: 120, max: 255, step: 1 },
  { key: 'silkStd', label: 'Silk: max V spread', min: 2, max: 60, step: 1 },
  { g: 'Tented vias (Hough)' },
  { key: 'viaSens', label: 'Accumulator threshold (lower = more)', min: 8, max: 80, step: 1 },
  { key: 'viaRmin', label: 'Min radius', min: 1, max: 40, step: 1 },
  { key: 'viaRmax', label: 'Max radius', min: 3, max: 90, step: 1 },
  { g: 'Focus' },
  { key: 'peakThr', label: 'Peaking threshold', min: 5, max: 120, step: 1 },
  { key: 'focusFull', label: 'Score whole frame (not just centre)', bool: true },
  { g: 'Processing' },
  { key: 'procMax', label: 'Processing size (long side)', opts: [['640', '640 px — fastest'], ['960', '960 px'], ['1280', '1280 px'], ['1600', '1600 px — finest']] },
  { key: 'interval', label: 'Live analysis interval (ms)', min: 30, max: 1000, step: 10 },
];

const st = {
  source: null, stream: null, track: null, devices: [], deviceId: LS.get('deviceId', ''), res: LS.get('res', '1920x1080'),
  img: null, imgName: '',
  flipH: LS.get('flipH', false), flipV: LS.get('flipV', false), frozen: false,
  sw: 0, sh: 0, fit: 1, zoom: 1, vs: 1, ox: 0, oy: 0,
  tool: 'pan',
  p: Object.assign({}, DEFAULTS, LS.get('params', {})),
  layers: Object.assign({}, LAYER_DEFAULTS, LS.get('layers', {})),
  view: Object.assign({ bri: 100, con: 100, sat: 100, sharpen: false, grid: false, cross: false, scalebar: true }, LS.get('view', {})),
  detectOn: LS.get('detectOn', true),
  cmpOn: false, refInfo: null, refAlpha: 0, blink: false,
  cal: LS.get('cal', {}), presets: LS.get('calPresets', []),
  measures: [],
  dets: [], board: [], mask: null, cmp: null, focus: null, focusMax: 0, lastMs: 0,
  sel: null, hover: null,
  frameVer: 0, paramVer: 0,
};
for (const k of ['procMax', 'interval']) st.p[k] = +st.p[k];

/* ---------- DOM / canvases ---------- */

const video = $('#video'), stage = $('#stage'), cImg = $('#cvImg'), cOvl = $('#cvOvl');
const gImg = cImg.getContext('2d'), gOvl = cOvl.getContext('2d');
const frame = document.createElement('canvas'), gFrame = frame.getContext('2d');
const proc = document.createElement('canvas'), gProc = proc.getContext('2d', { willReadFrequently: true });
const peakCv = document.createElement('canvas'), refCv = document.createElement('canvas'), clsCv = document.createElement('canvas');
let dpr = 1, cw = 0, ch = 0, dirtyImg = true, dirtyOvl = true;

function resize() {
  const r = stage.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1; cw = r.width; ch = r.height;
  for (const c of [cImg, cOvl]) { c.width = Math.max(1, Math.round(cw * dpr)); c.height = Math.max(1, Math.round(ch * dpr)); c.style.width = cw + 'px'; c.style.height = ch + 'px'; }
  fitView(false);
}
new ResizeObserver(resize).observe(stage);

function fitView(reset) {
  if (!st.sw) { dirtyImg = dirtyOvl = true; return; }
  const cx = st.vs ? (cw / 2 - st.ox) / st.vs : st.sw / 2, cy = st.vs ? (ch / 2 - st.oy) / st.vs : st.sh / 2;
  st.fit = Math.min(cw / st.sw, ch / st.sh) || 1;
  if (reset) st.zoom = 1;
  st.vs = st.fit * st.zoom;
  if (reset) { st.ox = (cw - st.sw * st.vs) / 2; st.oy = (ch - st.sh * st.vs) / 2; }
  else { st.ox = cw / 2 - cx * st.vs; st.oy = ch / 2 - cy * st.vs; }
  clampPan();
}
function clampPan() {
  const W = st.sw * st.vs, H = st.sh * st.vs;
  st.ox = W <= cw ? (cw - W) / 2 : clamp(st.ox, cw - W, 0);
  st.oy = H <= ch ? (ch - H) / 2 : clamp(st.oy, ch - H, 0);
  dirtyImg = dirtyOvl = true;
}
function setZoom(z, mx = cw / 2, my = ch / 2) {
  const sx = (mx - st.ox) / st.vs, sy = (my - st.oy) / st.vs;
  st.zoom = clamp(z, 1, 64); st.vs = st.fit * st.zoom;
  st.ox = mx - sx * st.vs; st.oy = my - sy * st.vs;
  clampPan();
}
function zoomTo(d) {
  const w = d.bb[2] - d.bb[0], h = d.bb[3] - d.bb[1];
  const z = clamp(Math.min(cw / (w * 2.8), ch / (h * 2.8)) / st.fit, 1, 64);
  st.zoom = z; st.vs = st.fit * z;
  st.ox = cw / 2 - d.cx * st.vs; st.oy = ch / 2 - d.cy * st.vs;
  clampPan();
}
const toSrc = (mx, my) => [(mx - st.ox) / st.vs, (my - st.oy) / st.vs];

function setFrameSize(w, h) {
  if (frame.width === w && frame.height === h && st.sw === w) return;
  frame.width = w; frame.height = h; st.sw = w; st.sh = h; st.vs = 0;
  fitView(true);
  updateCalUI();
}
function drawSource(src, w, h) {
  setFrameSize(w, h);
  gFrame.setTransform(st.flipH ? -1 : 1, 0, 0, st.flipV ? -1 : 1, st.flipH ? w : 0, st.flipV ? h : 0);
  gFrame.drawImage(src, 0, 0, w, h);
  gFrame.setTransform(1, 0, 0, 1, 0, 0);
  st.frameVer++; dirtyImg = true;
}
function redrawStill() { if (st.source === 'image' && st.img) drawSource(st.img, st.img.naturalWidth, st.img.naturalHeight); }

/* ---------- worker ---------- */

let worker = null, workerReady = false, busy = false, jobId = 0, jobT0 = 0, lastJobT = 0, jobFrameVer = -1, jobParamVer = -1, jobTasks = null;
function startWorker() {
  try { worker = new Worker('cv-worker.js'); }
  catch (e) {
    banner(location.protocol === 'file:'
      ? 'Opened straight from disk, so the vision worker cannot start. Run <b>./serve.sh</b> in the project folder — it serves the app at http://localhost:8790 and opens Chrome.'
      : 'Could not start the vision worker: ' + e.message);
    $('#perfChip').textContent = 'OpenCV unavailable';
    return;
  }
  worker.onmessage = (e) => onWorker(e.data);
  worker.onerror = (e) => { $('#perfChip').textContent = 'worker error'; console.error(e); if (location.protocol === 'file:') banner('Run <b>./serve.sh</b> — workers cannot load from file:// URLs.'); };
}
function onWorker(m) {
  if (m.type === 'ready') { workerReady = true; $('#perfChip').innerHTML = `OpenCV <b>${m.version || 'ready'}</b>`; return; }
  if (m.type === 'fatal') { $('#perfChip').textContent = 'OpenCV failed'; banner('OpenCV failed to load: ' + m.error); return; }
  if (m.type === 'refset') {
    st.refInfo = { w: m.w, h: m.h, kp: m.keypoints, t: new Date() };
    $('#refInfo').textContent = `Reference set ${st.refInfo.t.toLocaleTimeString()} · ${m.w}×${m.h} · ${m.keypoints} ORB features`;
    if (!st.cmpOn) { st.cmpOn = true; $('#cmpOn').checked = true; }
    $('#secCompare').open = true;
    st.paramVer++; return;
  }
  if (m.type === 'refcleared') return;
  if (m.type === 'error') { busy = false; console.warn('worker', m); $('#perfChip').innerHTML = `<span class="status-bad">CV error: ${esc(m.error)}</span>`; return; }
  if (m.type !== 'result') return;
  busy = false;
  st.lastMs = m.ms; st.rtMs = performance.now() - jobT0;
  if (m.focus != null) updateFocus(m.focus);
  if (m.peak) {
    if (peakCv.width !== m.w || peakCv.height !== m.h) { peakCv.width = m.w; peakCv.height = m.h; }
    const g = peakCv.getContext('2d'), id = g.createImageData(m.w, m.h), d = id.data, pk = m.peak;
    for (let i = 0, j = 0; i < pk.length; i++, j += 4) if (pk[i]) { d[j] = 255; d[j + 1] = 40; d[j + 2] = 210; d[j + 3] = 255; }
    g.putImageData(id, 0, 0);
  } else if (!st.layers.peaking) peakCv.width = 0;
  if (m.classmap) {
    if (clsCv.width !== m.w || clsCv.height !== m.h) { clsCv.width = m.w; clsCv.height = m.h; }
    const g = clsCv.getContext('2d'), id = g.createImageData(m.w, m.h), d = id.data, cm = m.classmap;
    for (let i = 0, j = 0; i < cm.length; i++, j += 4) { const c = CLASSMAP_RGBA[cm[i]]; if (c) { d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; d[j + 3] = 150; } }
    g.putImageData(id, 0, 0);
  } else if (!st.layers.classmap) clsCv.width = 0;
  if (m.warp) {
    if (refCv.width !== m.w || refCv.height !== m.h) { refCv.width = m.w; refCv.height = m.h; }
    refCv.getContext('2d').putImageData(new ImageData(m.warp, m.w, m.h), 0, 0);
    dirtyImg = true;
  }
  const old = st.sel;
  st.dets = m.dets; st.board = m.board || []; st.mask = m.mask || (jobTasks && jobTasks.detect ? null : st.mask); st.cmp = m.cmp;
  if (old) st.sel = reselect(old);
  if (st.hover) st.hover = null;
  dirtyOvl = true;
  scheduleSide();
}
function reselect(old) {
  let best = null, bd = Math.max(12, Math.max(old.L || 0, old.W || 0) * 0.6);
  for (const d of st.dets) {
    if (d.c !== old.c) continue;
    const dd = Math.hypot(d.cx - old.cx, d.cy - old.cy);
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}
function tasksNow() {
  const L = st.layers, det = st.detectOn;
  return {
    focus: true, peaking: !!L.peaking, classmap: det && !!L.classmap,
    detect: det, parts: det && !!(L.ic || L.res || L.cap || L.part), pads: det && !!L.pad, holes: det && !!L.hole,
    vias: det && !!L.via, copper: det && !!L.copper, anomaly: det && !!L.anomaly,
    compare: st.cmpOn && !!st.refInfo,
  };
}
function calNow() { return st.cal[`${st.sw}x${st.sh}`] || null; }
function pump(now) {
  if (!workerReady || busy || !st.sw) return;
  const live = st.source === 'camera' && !st.frozen;
  if (live) { if (now - lastJobT < st.p.interval || jobFrameVer === st.frameVer) return; }
  else if (jobFrameVer === st.frameVer && jobParamVer === st.paramVer) return;
  const s = Math.min(1, st.p.procMax / Math.max(st.sw, st.sh));
  const w = Math.max(16, Math.round(st.sw * s)), h = Math.max(16, Math.round(st.sh * s));
  if (proc.width !== w || proc.height !== h) { proc.width = w; proc.height = h; }
  gProc.drawImage(frame, 0, 0, w, h);
  const id = gProc.getImageData(0, 0, w, h);
  busy = true; lastJobT = now; jobFrameVer = st.frameVer; jobParamVer = st.paramVer; jobT0 = performance.now();
  jobTasks = tasksNow();
  const cal = calNow();
  const p = Object.assign({}, st.p, { pxPerMm: cal ? cal.pxPerMm : 0, wantWarp: st.cmpOn && (st.refAlpha > 0 || st.blink) });
  worker.postMessage({ type: 'detect', id: ++jobId, w, h, k: st.sw / w, tasks: jobTasks, p, buf: id.data.buffer }, [id.data.buffer]);
}
function sendRef(source, w0, h0) {
  if (!workerReady) return toast('OpenCV is still loading');
  const s = Math.min(1, st.p.procMax / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(source, 0, 0, w, h);
  const id = g.getImageData(0, 0, w, h);
  worker.postMessage({ type: 'setRef', id: ++jobId, w, h, p: st.p, buf: id.data.buffer }, [id.data.buffer]);
}

/* ---------- camera ---------- */

const NOT_SCOPE = /facetime|iphone|ipad|desk view|virtual|obs|continuity|snap camera|zoom/i;
const LIKELY_SCOPE = /microscope|scope|webcam|usb|uvc|digital|camera/i;
function pickScope(list) {
  const c = list.filter((d) => !NOT_SCOPE.test(d.label));
  return c.find((d) => LIKELY_SCOPE.test(d.label)) || c[0] || null;
}
async function refreshDevices() {
  try { st.devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput'); } catch (_) { st.devices = []; }
  const sel = $('#camSel'); sel.innerHTML = '';
  if (!st.devices.length) sel.append(new Option('No camera found', ''));
  st.devices.forEach((d, i) => sel.append(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
  if (st.deviceId) sel.value = st.deviceId;
}
function stopCamera() {
  if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
  st.stream = null; st.track = null; video.srcObject = null;
  if (st.source === 'camera') st.source = null;
  updateSourceUI();
}
async function startCamera(deviceId, auto) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    $('#emptyMsg').textContent = 'Camera API not available here — open the app via http://localhost (./serve.sh).';
    return;
  }
  if (st.stream) { st.stream.getTracks().forEach((t) => t.stop()); st.stream = null; st.track = null; }
  const [rw, rh] = st.res.split('x').map(Number);
  const v = { width: { ideal: rw }, height: { ideal: rh }, frameRate: { ideal: 30 } };
  if (deviceId) v.deviceId = { exact: deviceId };
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); }
  catch (e) {
    if (deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError' || e.name === 'NotReadableError')) return startCamera('', auto);
    $('#emptyMsg').textContent = `Camera: ${e.name} — ${e.message}`;
    if (!auto) toast('Camera failed: ' + e.name);
    return;
  }
  const track = stream.getVideoTracks()[0];
  const curId = track.getSettings().deviceId;
  await refreshDevices();
  if (!deviceId) {
    const scope = pickScope(st.devices);
    if (scope && scope.deviceId !== curId) { stream.getTracks().forEach((t) => t.stop()); return startCamera(scope.deviceId, auto); }
  }
  st.stream = stream; st.track = track; st.deviceId = curId; LS.set('deviceId', curId);
  $('#camSel').value = curId;
  video.srcObject = stream;
  try { await video.play(); } catch (_) {}
  st.source = 'camera'; st.frozen = false; st.focusMax = 0; st.img = null;
  track.addEventListener('ended', () => { toast('Camera disconnected'); stopCamera(); });
  armVFC();
  buildCamControls();
  updateSourceUI();
}
let hasVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype, newVideoFrame = false;
function armVFC() { if (hasVFC) video.requestVideoFrameCallback(() => { newVideoFrame = true; if (st.stream) armVFC(); }); }

function buildCamControls() {
  const box = $('#camCtl'); box.innerHTML = '';
  const t = st.track; if (!t || !t.getCapabilities) { box.innerHTML = '<div class="hint">No controls.</div>'; return; }
  const caps = t.getCapabilities(), cur = t.getSettings();
  const keys = ['exposureMode', 'exposureTime', 'exposureCompensation', 'brightness', 'contrast', 'saturation', 'sharpness', 'whiteBalanceMode', 'colorTemperature', 'focusMode', 'focusDistance', 'zoom'];
  let n = 0;
  for (const k of keys) {
    const c = caps[k]; if (c == null) continue;
    n++;
    if (Array.isArray(c)) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<span class="hint" style="min-width:120px">${k}</span>`;
      const s = document.createElement('select'); c.forEach((o) => s.append(new Option(o, o))); s.value = cur[k];
      s.onchange = () => t.applyConstraints({ advanced: [{ [k]: s.value }] }).catch((e) => toast(e.message));
      row.append(s); box.append(row);
    } else if (typeof c === 'object' && 'max' in c) {
      const d = document.createElement('div'); d.className = 'slider';
      d.innerHTML = `<label>${k}</label><output>${cur[k] ?? ''}</output><input type="range" min="${c.min}" max="${c.max}" step="${c.step || 1}" value="${cur[k] ?? c.min}">`;
      const inp = d.querySelector('input'), out = d.querySelector('output');
      inp.oninput = () => { out.textContent = inp.value; t.applyConstraints({ advanced: [{ [k]: +inp.value }] }).catch(() => {}); };
      box.append(d);
    }
  }
  if (!n) box.innerHTML = '<div class="hint">This camera exposes no adjustable controls to the browser (normal for UVC microscopes on macOS).</div>';
}

/* ---------- image files ---------- */

function loadImageFile(file, asRef) {
  if (!file || !/^image\//.test(file.type)) return toast('Not an image file');
  const url = URL.createObjectURL(file);
  loadImageURL(url, file.name, asRef);
}
function loadImageURL(url, name, asRef) {
  const im = new Image();
  im.onload = () => {
    if (asRef) { sendRef(im, im.naturalWidth, im.naturalHeight); return; }
    if (st.stream) stopCamera();
    st.source = 'image'; st.img = im; st.imgName = name || 'image'; st.frozen = false; st.focusMax = 0;
    drawSource(im, im.naturalWidth, im.naturalHeight);
    updateSourceUI();
  };
  im.onerror = () => toast('Could not load ' + (name || 'image'));
  im.src = url;
}

/* ---------- render loop ---------- */

let fpsN = 0, fpsT = performance.now(), fps = 0;
function loop(now) {
  if (st.source === 'camera' && !st.frozen && video.readyState >= 2 && (newVideoFrame || !hasVFC)) {
    newVideoFrame = false;
    if (video.videoWidth) { drawSource(video, video.videoWidth, video.videoHeight); fpsN++; }
  }
  if (now - fpsT >= 1000) { fps = fpsN * 1000 / (now - fpsT); fpsN = 0; fpsT = now; updatePerf(); }
  if (st.blink && refCv.width) dirtyImg = true;
  if (dirtyImg) renderImg(now);
  if (dirtyOvl) renderOvl();
  pump(now);
  requestAnimationFrame(loop);
}
function renderImg(now) {
  dirtyImg = false;
  gImg.setTransform(1, 0, 0, 1, 0, 0); gImg.clearRect(0, 0, cImg.width, cImg.height);
  if (!st.sw) return;
  gImg.setTransform(dpr * st.vs, 0, 0, dpr * st.vs, dpr * st.ox, dpr * st.oy);
  gImg.imageSmoothingEnabled = st.vs < 3;
  const showRef = st.blink && refCv.width && Math.floor(now / 450) % 2 === 1;
  if (showRef) { gImg.fillStyle = '#000'; gImg.fillRect(0, 0, st.sw, st.sh); gImg.drawImage(refCv, 0, 0, st.sw, st.sh); }
  else {
    gImg.drawImage(frame, 0, 0);
    if (st.refAlpha > 0 && refCv.width) { gImg.globalAlpha = st.refAlpha; gImg.drawImage(refCv, 0, 0, st.sw, st.sh); gImg.globalAlpha = 1; }
  }
  if (st.blink && refCv.width) {
    gImg.setTransform(dpr, 0, 0, dpr, 0, 0);
    gImg.font = '600 12px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    gImg.fillStyle = showRef ? '#ffb84d' : '#3ddc97';
    gImg.fillText(showRef ? 'REFERENCE' : 'LIVE', cw - 90, 60);
  }
}
function applyFilter() {
  const v = st.view;
  cImg.style.filter = `brightness(${v.bri}%) contrast(${v.con}%) saturate(${v.sat}%)` + (v.sharpen ? ' url(#sharpen)' : '');
}
function renderOvl() {
  dirtyOvl = false;
  gOvl.setTransform(1, 0, 0, 1, 0, 0); gOvl.clearRect(0, 0, cOvl.width, cOvl.height);
  if (!st.sw) return;
  gOvl.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay(gOvl, { vs: st.vs, ox: st.ox, oy: st.oy, ui: 1, W: cw, H: ch, screen: true });
}

function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
function fmtLen(px) { const c = calNow(); return c ? fmtMm(px / c.pxPerMm) : `${px.toFixed(px < 10 ? 1 : 0)} px`; }
function fmtMm(mm) { return mm < 1 ? `${(mm * 1000).toFixed(0)} µm` : `${mm.toFixed(mm < 10 ? 2 : 1)} mm`; }

function drawOverlay(g, V) {
  const L = st.layers, ui = V.ui;
  const X = (x) => x * V.vs + V.ox, Y = (y) => y * V.vs + V.oy;
  const mono = `ui-monospace, SFMono-Regular, Menlo, monospace`;
  g.lineJoin = 'round'; g.lineCap = 'round';

  if (L.classmap && clsCv.width) { g.save(); g.imageSmoothingEnabled = false; g.drawImage(clsCv, X(0), Y(0), st.sw * V.vs, st.sh * V.vs); g.restore(); }
  if (L.peaking && peakCv.width) { g.save(); g.imageSmoothingEnabled = false; g.drawImage(peakCv, X(0), Y(0), st.sw * V.vs, st.sh * V.vs); g.restore(); }
  if (st.view.grid) drawGrid(g, V);

  if (L.board && st.board.length) {
    g.save(); g.setLineDash([6 * ui, 4 * ui]); g.strokeStyle = 'rgba(120,255,170,.75)'; g.lineWidth = 1.5 * ui;
    for (const P of st.board) { g.beginPath(); P.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y)))); g.closePath(); g.stroke(); }
    g.restore();
  }

  const shape = (d) => {
    g.beginPath();
    if (d.r) g.arc(X(d.cx), Y(d.cy), Math.max(1.5, d.r * V.vs), 0, Math.PI * 2);
    else { const P = d.poly || d.pts; g.moveTo(X(P[0][0]), Y(P[0][1])); for (let i = 1; i < P.length; i++) g.lineTo(X(P[i][0]), Y(P[i][1])); g.closePath(); }
  };
  for (const d of st.dets) {
    if (!L[d.c]) continue;
    const col = CLASSES[d.c].color, emph = d === st.sel || d === st.hover;
    shape(d);
    if (d.c === 'diff' || d.c === 'anomaly' || d.c === 'copper') { g.fillStyle = hexA(col, d.c === 'diff' ? 0.22 : 0.16); g.fill(); }
    if (emph) { g.strokeStyle = 'rgba(0,0,0,.7)'; g.lineWidth = 5 * ui; g.stroke(); }
    g.strokeStyle = col; g.lineWidth = (SMALL.has(d.c) ? 1.2 : 2) * ui * (emph ? 1.6 : 1);
    if (d.partial) g.setLineDash([5 * ui, 4 * ui]);
    g.stroke(); g.setLineDash([]);
  }
  // labels
  g.font = `600 ${11 * ui}px ${mono}`; g.textBaseline = 'middle';
  const many = st.dets.length > 250;
  for (const d of st.dets) {
    if (!L[d.c] || SMALL.has(d.c) || !d.label) continue;
    const emph = d === st.sel || d === st.hover;
    const sz = Math.max(d.bb[2] - d.bb[0], d.bb[3] - d.bb[1]) * V.vs;
    if (!emph && (sz < (many ? 26 : 14) * ui)) continue;
    let t = d.label;
    if (emph) t += '  ' + fmtLen(d.L) + ' × ' + fmtLen(d.W);
    const x = X(d.bb[0]), y = Y(d.bb[1]) - 9 * ui;
    const tw = g.measureText(t).width;
    g.fillStyle = 'rgba(8,10,13,.82)'; g.fillRect(x - 3 * ui, y - 8 * ui, tw + 6 * ui, 16 * ui);
    g.fillStyle = CLASSES[d.c].color; g.fillText(t, x, y);
  }

  for (const m of st.measures) drawMeasure(g, V, m, '#6fd3ff');
  if (drag && (drag.kind === 'measure' || drag.kind === 'calib') && drag.moved) drawMeasure(g, V, drag, drag.kind === 'calib' ? '#ffd84d' : '#6fd3ff');
  if (drag && drag.kind === 'ocr' && drag.moved) {
    const r = normRect(drag);
    g.save(); g.setLineDash([6, 4]); g.strokeStyle = '#ffd84d'; g.lineWidth = 1.5; g.strokeRect(X(r.x), Y(r.y), r.w * V.vs, r.h * V.vs); g.restore();
  }
  if (st.view.cross) {
    const cx = X(st.sw / 2), cy = Y(st.sh / 2);
    g.save(); g.strokeStyle = 'rgba(255,80,80,.85)'; g.lineWidth = 1 * ui;
    g.beginPath(); g.moveTo(X(0), cy); g.lineTo(X(st.sw), cy); g.moveTo(cx, Y(0)); g.lineTo(cx, Y(st.sh)); g.stroke();
    g.beginPath(); g.arc(cx, cy, 18 * ui, 0, Math.PI * 2); g.stroke(); g.restore();
  }
  if (st.view.scalebar) drawScaleBar(g, V);
}
function drawMeasure(g, V, m, col) {
  const ui = V.ui;
  const x1 = m.x1 * V.vs + V.ox, y1 = m.y1 * V.vs + V.oy, x2 = m.x2 * V.vs + V.ox, y2 = m.y2 * V.vs + V.oy;
  const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
  const ang = Math.atan2(y2 - y1, x2 - x1), nx = -Math.sin(ang) * 6 * ui, ny = Math.cos(ang) * 6 * ui;
  g.save();
  g.strokeStyle = 'rgba(0,0,0,.6)'; g.lineWidth = 4 * ui; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
  g.strokeStyle = col; g.lineWidth = 1.6 * ui;
  g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2);
  g.moveTo(x1 - nx, y1 - ny); g.lineTo(x1 + nx, y1 + ny); g.moveTo(x2 - nx, y2 - ny); g.lineTo(x2 + nx, y2 + ny); g.stroke();
  const t = m.kind === 'calib' ? `${len.toFixed(1)} px` : fmtLen(len);
  g.font = `600 ${12 * ui}px ui-monospace, Menlo, monospace`; g.textBaseline = 'middle';
  const tw = g.measureText(t).width, mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 12 * ui;
  g.fillStyle = 'rgba(8,10,13,.85)'; g.fillRect(mx - tw / 2 - 4 * ui, my - 9 * ui, tw + 8 * ui, 18 * ui);
  g.fillStyle = col; g.fillText(t, mx - tw / 2, my);
  g.restore();
}
function niceStep(target, steps) { for (const s of steps) if (s >= target) return s; return steps[steps.length - 1]; }
function drawGrid(g, V) {
  const cal = calNow();
  let stepPx, mmStep = 0;
  if (cal) { mmStep = niceStep(40 * V.ui / (cal.pxPerMm * V.vs), [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]); stepPx = mmStep * cal.pxPerMm; }
  else stepPx = niceStep(40 * V.ui / V.vs, [5, 10, 20, 50, 100, 200, 500, 1000, 2000]);
  const x0 = Math.max(0, -V.ox / V.vs), x1 = Math.min(st.sw, (V.W - V.ox) / V.vs);
  const y0 = Math.max(0, -V.oy / V.vs), y1 = Math.min(st.sh, (V.H - V.oy) / V.vs);
  g.save(); g.strokeStyle = 'rgba(255,255,255,.16)'; g.lineWidth = 1; g.beginPath();
  for (let x = Math.ceil(x0 / stepPx) * stepPx; x <= x1; x += stepPx) { const sx = Math.round(x * V.vs + V.ox) + 0.5; g.moveTo(sx, y0 * V.vs + V.oy); g.lineTo(sx, y1 * V.vs + V.oy); }
  for (let y = Math.ceil(y0 / stepPx) * stepPx; y <= y1; y += stepPx) { const sy = Math.round(y * V.vs + V.oy) + 0.5; g.moveTo(x0 * V.vs + V.ox, sy); g.lineTo(x1 * V.vs + V.ox, sy); }
  g.stroke(); g.restore();
  st.gridLabel = cal ? `grid ${fmtMm(mmStep)}` : `grid ${stepPx}px`;
}
function drawScaleBar(g, V) {
  const cal = calNow(); if (!cal) return;
  const ui = V.ui, ppm = cal.pxPerMm * V.vs;
  const mm = niceStep(130 * ui / ppm / 1.0001, [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 50]);
  const len = mm * ppm;
  const x = V.screen ? 16 : 20 * ui, y = V.screen ? V.H - 40 : st.sh - 24 * ui;
  g.save();
  g.fillStyle = 'rgba(8,10,13,.7)'; g.fillRect(x - 8 * ui, y - 22 * ui, len + 16 * ui, 32 * ui);
  g.fillStyle = '#fff'; g.fillRect(x, y, len, 4 * ui);
  g.fillRect(x, y - 5 * ui, 2 * ui, 14 * ui); g.fillRect(x + len - 2 * ui, y - 5 * ui, 2 * ui, 14 * ui);
  g.font = `600 ${12 * ui}px ui-monospace, Menlo, monospace`; g.textBaseline = 'alphabetic';
  g.fillText(fmtMm(mm), x, y - 8 * ui);
  g.restore();
}

/* ---------- pointer interaction ---------- */

let drag = null, spaceDown = false, lastMove = null;
const local = (e) => { const r = cOvl.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
const normRect = (d) => ({ x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), w: Math.abs(d.x2 - d.x1), h: Math.abs(d.y2 - d.y1) });

cOvl.addEventListener('pointerdown', (e) => {
  if (!st.sw) return;
  cOvl.setPointerCapture(e.pointerId);
  const [mx, my] = local(e), [sx, sy] = toSrc(mx, my);
  const pan = e.button === 1 || e.button === 2 || spaceDown || st.tool === 'pan';
  drag = pan ? { kind: 'pan', mx, my, ox: st.ox, oy: st.oy, moved: false }
    : { kind: st.tool, x1: sx, y1: sy, x2: sx, y2: sy, mx, my, moved: false };
  if (pan) stage.classList.add('panning');
});
cOvl.addEventListener('pointermove', (e) => {
  const [mx, my] = local(e);
  lastMove = { mx, my };
  if (drag) {
    if (Math.hypot(mx - drag.mx, my - drag.my) > 3) drag.moved = true;
    if (drag.kind === 'pan') { st.ox = drag.ox + mx - drag.mx; st.oy = drag.oy + my - drag.my; clampPan(); }
    else {
      let [sx, sy] = toSrc(mx, my);
      if (e.shiftKey && drag.kind !== 'ocr') { if (Math.abs(sx - drag.x1) > Math.abs(sy - drag.y1)) sy = drag.y1; else sx = drag.x1; }
      drag.x2 = sx; drag.y2 = sy; dirtyOvl = true;
    }
  } else hoverAt(mx, my);
  scheduleStatus();
});
cOvl.addEventListener('pointerup', (e) => {
  if (!drag) return;
  const d = drag; drag = null; stage.classList.remove('panning');
  if (d.kind === 'pan') { if (!d.moved) clickSelect(d.mx, d.my); return; }
  if (!d.moved) { dirtyOvl = true; return; }
  if (d.kind === 'measure') { st.measures.push({ x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 }); updateMeasureList(); }
  else if (d.kind === 'calib') openCalDialog(d);
  else if (d.kind === 'ocr') { const r = normRect(d); if (r.w > 4 && r.h > 4) runOCR(r); }
  dirtyOvl = true;
});
cOvl.addEventListener('pointerleave', () => { $('#tip').hidden = true; st.hover = null; lastMove = null; dirtyOvl = true; scheduleStatus(); });
cOvl.addEventListener('contextmenu', (e) => e.preventDefault());
cOvl.addEventListener('wheel', (e) => {
  if (!st.sw) return;
  e.preventDefault();
  const [mx, my] = local(e);
  const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
  setZoom(st.zoom * f, mx, my);
}, { passive: false });
cOvl.addEventListener('dblclick', (e) => {
  const [mx, my] = local(e);
  if (st.zoom > 1.5) fitView(true); else setZoom(4, mx, my);
});

function hitTest(mx, my) {
  const [sx, sy] = toSrc(mx, my);
  let best = null, ba = Infinity;
  for (const d of st.dets) {
    if (!st.layers[d.c]) continue;
    const [a, b, c, e] = d.bb;
    const pad = 3 / st.vs;
    if (sx < a - pad || sx > c + pad || sy < b - pad || sy > e + pad) continue;
    if (d.r) { if (Math.hypot(sx - d.cx, sy - d.cy) > d.r + pad) continue; }
    else if (!inPoly(sx, sy, d.poly || d.pts)) continue;
    const area = (c - a) * (e - b);
    if (area < ba) { ba = area; best = d; }
  }
  return best;
}
function inPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function hoverAt(mx, my) {
  const d = hitTest(mx, my), tip = $('#tip');
  if (d !== st.hover) { st.hover = d; dirtyOvl = true; }
  if (!d) { tip.hidden = true; return; }
  tip.textContent = describe(d, true);
  tip.hidden = false;
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  tip.style.left = clamp(mx + 14, 4, cw - tw - 4) + 'px';
  tip.style.top = clamp(my + 14, 4, ch - th - 4) + 'px';
}
function clickSelect(mx, my) { st.sel = hitTest(mx, my); dirtyOvl = true; renderSide(); }
function describe(d, short) {
  const c = CLASSES[d.c], i = d.info || {}, lines = [];
  lines.push(`${c.name}${d.label && !SMALL.has(d.c) ? ' — ' + d.label : ''}`);
  if (d.r) lines.push(`⌀ ${fmtLen(2 * d.r)}`);
  else lines.push(`${fmtLen(d.L)} × ${fmtLen(d.W)}`);
  if (i.pins) lines.push(`${i.pins} leads visible` + (i.pitchMm ? ` · pitch ${i.pitchMm} mm` : i.pitchPx ? ` · pitch ${i.pitchPx} px` : ''));
  if (i.family) lines.push(`looks like ${i.family}`);
  if (i.leads) lines.push(`leads: ${i.leads}`);
  if (i.pkg) lines.push(`package ≈ ${i.pkg}`);
  if (i.kind) lines.push(i.kind);
  if (d.c === 'diff' && i.area) lines.push(`area ${fmtArea(i.area)}`);
  if (d.c === 'anomaly') lines.push('irregular dark region — check for burn, flux residue or a lifted part');
  if (d.partial) lines.push('cut off by frame edge');
  if (!short) lines.push(`centre ${d.cx.toFixed(0)}, ${d.cy.toFixed(0)} px`);
  if (!calNow() && (d.c === 'res' || d.c === 'cap') && !short) lines.push('calibrate to get a package size (0402 / 0603 …)');
  return lines.join('\n');
}
function fmtArea(a) { const c = calNow(); return c ? `${(a / c.pxPerMm ** 2).toFixed(3)} mm²` : `${Math.round(a)} px²`; }

/* ---------- side panel ---------- */

let sideTimer = 0;
function scheduleSide() { if (!sideTimer) sideTimer = setTimeout(() => { sideTimer = 0; renderSide(); }, 250); }
function buildLayers() {
  const box = $('#layers'); box.innerHTML = '';
  const add = (key, name, color) => {
    const row = document.createElement('label'); row.className = 'layer';
    row.innerHTML = `<input type="checkbox"><span class="sw" style="background:${color}"></span><span>${name}</span><span class="n" data-n="${key}"></span>`;
    const cb = row.querySelector('input'); cb.checked = !!st.layers[key];
    cb.onchange = () => { st.layers[key] = cb.checked ? 1 : 0; LS.set('layers', st.layers); st.paramVer++; dirtyOvl = true; if (key === 'peaking' && !cb.checked) peakCv.width = 0; };
    box.append(row);
  };
  for (const [k, c] of Object.entries(CLASSES)) add(k, c.name, c.color);
  add('board', EXTRA_LAYERS.board, 'rgba(120,255,170,.75)');
  add('classmap', EXTRA_LAYERS.classmap, 'conic-gradient(#28c85a 0 25%, #465aff 0 50%, #fff 0 75%, #ffaa3c 0)');
  add('peaking', EXTRA_LAYERS.peaking, '#ff28d2');
}
function renderSide() {
  const counts = {};
  for (const d of st.dets) counts[d.c] = (counts[d.c] || 0) + 1;
  document.querySelectorAll('[data-n]').forEach((el) => { const k = el.dataset.n; el.textContent = CLASSES[k] ? (counts[k] || 0) : ''; });
  const parts = (counts.ic || 0) + (counts.res || 0) + (counts.cap || 0) + (counts.part || 0);
  $('#detAux').textContent = st.detectOn ? `${parts} parts` : 'off';
  const mi = $('#maskInfo');
  if (st.mask && st.detectOn) {
    const m = st.mask;
    mi.querySelector('.sw').style.background = m.hue == null ? 'repeating-linear-gradient(45deg,#222 0 4px,#ddd 4px 8px)' : `hsl(${m.hue * 2},70%,38%)`;
    mi.querySelector('span:last-child').textContent = m.hue == null
      ? 'solder mask: not found (black/white mask, or no board in view) — mask-based classes off'
      : `${m.name} solder mask${m.auto ? ' (auto)' : ''} · ${(m.coverage * 100).toFixed(0)}% of frame`;
  } else { mi.querySelector('.sw').style.background = 'transparent'; mi.querySelector('span:last-child').textContent = 'solder mask: –'; }

  // list
  const list = $('#detList');
  const items = st.dets.filter((d) => LIST_CLASSES.includes(d.c) && st.layers[d.c])
    .sort((a, b) => LIST_CLASSES.indexOf(a.c) - LIST_CLASSES.indexOf(b.c) || b.L * b.W - a.L * a.W).slice(0, 200);
  list.innerHTML = items.length ? '' : `<div class="empty-l">${st.detectOn || st.cmpOn ? 'Nothing detected yet.' : 'Detection is off.'}</div>`;
  const frag = document.createDocumentFragment();
  for (const d of items) {
    const it = document.createElement('div'); it.className = 'it' + (d === st.sel ? ' sel' : '');
    const i = d.info || {};
    const meta = [fmtLen(d.L) + '×' + fmtLen(d.W), i.pitchMm ? i.pitchMm + ' mm pitch' : '', i.pkg || ''].filter(Boolean).join(' · ');
    it.innerHTML = `<span class="sw" style="background:${CLASSES[d.c].color}"></span><span>${esc(d.label || d.c)}</span><span class="meta">${esc(meta)}</span>`;
    it.onclick = () => { st.sel = d; zoomTo(d); renderSide(); };
    it.onmouseenter = () => { st.hover = d; dirtyOvl = true; };
    it.onmouseleave = () => { st.hover = null; dirtyOvl = true; };
    frag.append(it);
  }
  list.append(frag);
  $('#selBox').textContent = st.sel ? describe(st.sel, false) : 'Click a detection on the image or in the list.';

  // compare
  const c = st.cmp, cs = $('#cmpStat');
  if (!st.refInfo) { cs.textContent = 'No reference yet.'; $('#cmpAux').textContent = ''; }
  else if (!st.cmpOn) { cs.textContent = 'Compare is off.'; $('#cmpAux').textContent = 'ref set'; }
  else if (!c) cs.textContent = 'Waiting for a frame…';
  else if (!c.ok) { cs.innerHTML = `<span class="status-bad">Alignment failed: ${esc(c.reason)}</span>${c.good != null ? `\n${c.good} matches, ${c.inliers || 0} inliers` : ''}\nIs the same board area in view?`; $('#cmpAux').textContent = 'no lock'; }
  else {
    const cls = c.n ? 'status-warn' : 'status-ok';
    cs.innerHTML = `<span class="${cls}">${c.n ? c.n + ' difference region' + (c.n > 1 ? 's' : '') : 'No differences'}</span>\n`
      + (c.align === 'orb' ? `aligned · ${c.inliers} inliers of ${c.good} matches\n` : 'no alignment (fixed camera)\n')
      + `${(c.changed * 100).toFixed(2)}% of overlap differs · overlap ${(c.overlap * 100).toFixed(0)}%`;
    $('#cmpAux').textContent = c.n ? `${c.n} Δ` : 'match';
  }
}
function updateFocus(f) {
  st.focus = f;
  st.focusMax = Math.max(f, st.focusMax * 0.998);
  const r = st.focusMax ? f / st.focusMax : 0;
  const bar = $('#focusBar'); bar.style.width = (r * 100).toFixed(0) + '%';
  bar.style.backgroundPosition = '0 0';
  $('#focusVal').innerHTML = `<b>${f >= 100 ? f.toFixed(0) : f.toFixed(1)}</b> ${(r * 100).toFixed(0)}%`;
}
function updatePerf() {
  if (!workerReady) return;
  const src = st.source === 'camera' ? `${fps.toFixed(0)} fps · ` : '';
  $('#perfChip').innerHTML = `${src}CV <b>${st.lastMs ? st.lastMs.toFixed(0) : '–'} ms</b> @ ${proc.width || '–'}px`;
}
function updateSourceUI() {
  const chip = $('#srcChip');
  if (st.source === 'camera') {
    const s = st.track ? st.track.getSettings() : {};
    const label = (st.devices.find((d) => d.deviceId === st.deviceId) || {}).label || 'camera';
    chip.innerHTML = `<b>${esc(label)}</b> ${s.width || '?'}×${s.height || '?'}${st.frozen ? ' · <span class="status-warn">frozen</span>' : ''}`;
    $('#camBtn').textContent = 'Stop';
    $('#srcAux').textContent = `${s.width || ''}×${s.height || ''}`;
  } else if (st.source === 'image') {
    chip.innerHTML = `<b>${esc(st.imgName)}</b> ${st.sw}×${st.sh}`;
    $('#camBtn').textContent = 'Start';
    $('#srcAux').textContent = 'image';
  } else { chip.textContent = 'no source'; $('#camBtn').textContent = 'Start'; $('#srcAux').textContent = ''; }
  $('#empty').hidden = !!st.source;
  $('#btnFreeze').textContent = st.frozen ? 'Resume' : 'Freeze';
  $('#btnFreeze').classList.toggle('on', st.frozen);
  $('#btnFreeze').disabled = st.source !== 'camera';
}
let statusPending = false;
function scheduleStatus() { if (!statusPending) { statusPending = true; requestAnimationFrame(() => { statusPending = false; renderStatus(); }); } }
function renderStatus() {
  const sb = $('#statusbar'), parts = [];
  if (st.sw && lastMove) {
    const [sx, sy] = toSrc(lastMove.mx, lastMove.my);
    if (sx >= 0 && sy >= 0 && sx < st.sw && sy < st.sh) {
      const px = gFrame.getImageData(Math.floor(sx), Math.floor(sy), 1, 1).data;
      const [H, S, V] = rgb2hsv(px[0], px[1], px[2]);
      const cal = calNow();
      parts.push(`<b>${sx.toFixed(0)}, ${sy.toFixed(0)}</b> px` + (cal ? ` · ${(sx / cal.pxPerMm).toFixed(2)}, ${(sy / cal.pxPerMm).toFixed(2)} mm` : ''));
      parts.push(`RGB <b>${px[0]} ${px[1]} ${px[2]}</b>`);
      parts.push(`HSV <b>${H} ${S} ${V}</b>`);
    }
  }
  if (st.sw) parts.push(`zoom <b>${(st.vs * 100).toFixed(0)}%</b>`);
  if (st.view.grid && st.gridLabel) parts.push(st.gridLabel);
  sb.innerHTML = parts.map((p) => `<span>${p}</span>`).join('');
}
function rgb2hsv(r, g, b) { // OpenCV 8-bit convention: H 0–179, S/V 0–255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) { if (mx === r) h = ((g - b) / d) % 6; else if (mx === g) h = (b - r) / d + 2; else h = (r - g) / d + 4; h *= 30; if (h < 0) h += 180; }
  return [Math.round(h), mx ? Math.round(255 * d / mx) : 0, mx];
}
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
let toastT = 0;
function toast(msg) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; stage.append(t); }
  t.textContent = msg; t.style.opacity = 1; clearTimeout(toastT);
  toastT = setTimeout(() => { t.style.opacity = 0; }, 2600);
}
function banner(html) { let b = $('#banner'); if (!b) { b = document.createElement('div'); b.id = 'banner'; b.className = 'banner'; stage.append(b); } b.innerHTML = html; }

/* ---------- calibration / measure ---------- */

const CAL_PRESETS = [['0.5', '0.5 pitch'], ['0.65', '0.65 pitch'], ['1.0', '0402 L'], ['1.27', '1.27 pitch'], ['1.6', '0603 L'], ['2.0', '0805 L'], ['2.54', '2.54 pitch'], ['3.2', '1206 L'], ['5', '5 mm'], ['10', '10 mm']];
let calLine = null;
function openCalDialog(d) {
  calLine = d;
  const len = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
  $('#calPx').textContent = len.toFixed(1);
  $('#calDlg').hidden = false;
  const inp = $('#calMm'); inp.value = ''; setTimeout(() => inp.focus(), 0);
}
function closeCalDialog() { $('#calDlg').hidden = true; calLine = null; dirtyOvl = true; }
function applyCal() {
  const mm = parseFloat($('#calMm').value);
  if (!calLine || !(mm > 0)) return toast('Enter the real length in mm');
  const len = Math.hypot(calLine.x2 - calLine.x1, calLine.y2 - calLine.y1);
  st.cal[`${st.sw}x${st.sh}`] = { pxPerMm: len / mm, t: Date.now() };
  LS.set('cal', st.cal);
  closeCalDialog(); setTool('measure');
  st.paramVer++; updateCalUI(); updateMeasureList(); dirtyOvl = true;
  toast(`Scale set: ${(len / mm).toFixed(2)} px/mm`);
}
function updateCalUI() {
  const c = calNow();
  $('#calInfo').innerHTML = c
    ? `<span class="status-ok">${c.pxPerMm.toFixed(2)} px/mm</span> at ${st.sw}×${st.sh} — field of view ${(st.sw / c.pxPerMm).toFixed(2)} × ${(st.sh / c.pxPerMm).toFixed(2)} mm`
    : `Uncalibrated${st.sw ? ` at ${st.sw}×${st.sh}` : ''} — sizes in pixels.`;
  $('#calAux').textContent = c ? `${c.pxPerMm.toFixed(1)} px/mm` : 'px';
  const sel = $('#presetSel'), keep = sel.value;
  sel.innerHTML = '<option value="">Magnification presets…</option>';
  st.presets.forEach((p, i) => sel.append(new Option(`${p.name} — ${p.pxPerMm.toFixed(1)} px/mm @ ${p.res}`, String(i))));
  sel.value = keep && st.presets[+keep] ? keep : '';
}
function updateMeasureList() {
  const box = $('#mList');
  box.innerHTML = st.measures.map((m, i) => {
    const len = Math.hypot(m.x2 - m.x1, m.y2 - m.y1);
    return `<div><span>#${i + 1}</span><b>${fmtLen(len)}</b><span>${len.toFixed(1)} px</span></div>`;
  }).join('');
}

/* ---------- OCR ---------- */

let tessP = null, lastOcrRect = null;
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('failed to load ' + src)); document.head.append(s); });
}
function ocrStatus(t) { $('#ocrStatus').textContent = t; }
function ensureTess() {
  if (!tessP) tessP = (async () => {
    if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    return window.Tesseract.createWorker('eng', 1, {
      logger: (m) => { if (m.status && m.status !== 'recognizing text') ocrStatus(`${m.status}${m.progress ? ' ' + Math.round(m.progress * 100) + '%' : ''}`); },
    });
  })().catch((e) => { tessP = null; throw e; });
  return tessP;
}
function rotated(src, deg) {
  if (!deg) return src;
  const c = document.createElement('canvas');
  const swap = deg % 180 !== 0;
  c.width = swap ? src.height : src.width; c.height = swap ? src.width : src.height;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2); g.rotate(deg * Math.PI / 180); g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}
async function runOCR(r) {
  lastOcrRect = r; $('#ocrAgain').disabled = false;
  $('#secOcr').open = true;
  ocrStatus('preparing…'); $('#ocrOut').textContent = ''; $('#ocrLinks').innerHTML = '';
  // Crop from the full-resolution frame, upscale, grey + contrast stretch, then pad.
  const scale = clamp(900 / Math.max(r.w, r.h), 1, 4);
  const w = Math.round(r.w * scale), h = Math.round(r.h * scale), pad = Math.round(Math.min(w, h) * 0.15) + 10;
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high';
  g.drawImage(frame, r.x, r.y, r.w, r.h, 0, 0, w, h);
  const id = g.getImageData(0, 0, w, h), d = id.data, n = w * h, gray = new Uint8Array(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) { const v = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8; gray[i] = v; hist[v]++; }
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.02) { lo = v; break; } }
  acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.02) { hi = v; break; } }
  const span = Math.max(1, hi - lo);
  const mk = (invert) => {
    const out = document.createElement('canvas'); out.width = w + 2 * pad; out.height = h + 2 * pad;
    const og = out.getContext('2d'); const im = og.createImageData(w, h);
    let border = 0, bn = 0;
    for (let i = 0; i < n; i++) {
      let v = clamp(Math.round((gray[i] - lo) * 255 / span), 0, 255); if (invert) v = 255 - v;
      im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { border += v; bn++; }
    }
    const b = Math.round(border / bn); og.fillStyle = `rgb(${b},${b},${b})`; og.fillRect(0, 0, out.width, out.height);
    og.putImageData(im, pad, pad);
    return out;
  };
  const variants = [{ name: 'light-on-dark', cv: mk(true) }, { name: 'dark-on-light', cv: mk(false) }];
  const rots = $('#ocrRot').checked ? [0, 180, 90, 270] : [0];
  let worker;
  try { ocrStatus('loading Tesseract…'); worker = await ensureTess(); }
  catch (e) { ocrStatus('Could not load Tesseract.js — no internet? ' + e.message); return; }
  await worker.setParameters({
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: $('#ocrWl').checked ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-./+#' : '',
  });
  const results = [];
  let k = 0;
  for (const v of variants) for (const deg of rots) {
    ocrStatus(`reading ${++k}/${variants.length * rots.length}…`);
    const cvs = rotated(v.cv, deg);
    try {
      const { data } = await worker.recognize(cvs);
      const text = (data.text || '').trim().replace(/\n{2,}/g, '\n');
      const alnum = text.replace(/[^A-Za-z0-9]/g, '').length;
      results.push({ text, conf: data.confidence || 0, score: alnum ? (data.confidence || 0) + Math.min(alnum, 12) : 0, deg, name: v.name, cvs });
    } catch (e) { console.warn(e); }
  }
  results.sort((a, b) => b.score - a.score);
  const best = results[0];
  if (!best || !best.score) { ocrStatus('No text found — tighten the box around the marking, focus, and add light.'); return; }
  ocrStatus(`confidence ${best.conf.toFixed(0)}% · ${best.name}${best.deg ? ' · rotated ' + best.deg + '°' : ''}`);
  $('#ocrOut').textContent = best.text;
  $('#ocrAux').textContent = best.text.split('\n')[0].slice(0, 14);
  const q = encodeURIComponent(best.text.replace(/\s+/g, ' ').trim());
  const first = encodeURIComponent((best.text.split(/\s+/).sort((a, b) => b.length - a.length)[0] || '').trim());
  $('#ocrLinks').innerHTML = `<a href="#" id="ocrCopy">Copy</a><a target="_blank" rel="noopener" href="https://www.lcsc.com/search?q=${first}">LCSC</a><a target="_blank" rel="noopener" href="https://www.google.com/search?q=${q}+datasheet+marking">Datasheet search</a><a target="_blank" rel="noopener" href="https://www.google.com/search?q=SMD+marking+code+${first}">Marking code</a>`;
  $('#ocrCopy').onclick = (e) => { e.preventDefault(); navigator.clipboard.writeText(best.text).then(() => toast('Copied')); };
  const pv = $('#ocrPrev'); pv.hidden = false; pv.width = best.cvs.width; pv.height = best.cvs.height; pv.getContext('2d').drawImage(best.cvs, 0, 0);
}

/* ---------- export ---------- */

const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
function savePNG(annotated) {
  if (!st.sw) return toast('No image');
  const c = document.createElement('canvas'); c.width = st.sw; c.height = st.sh;
  const g = c.getContext('2d');
  if (annotated) { const v = st.view; g.filter = `brightness(${v.bri}%) contrast(${v.con}%) saturate(${v.sat}%)` + (v.sharpen ? ' url(#sharpen)' : ''); }
  g.drawImage(frame, 0, 0); g.filter = 'none';
  if (annotated) drawOverlay(g, { vs: 1, ox: 0, oy: 0, ui: Math.max(1, st.sw / 1100), W: st.sw, H: st.sh, screen: false });
  c.toBlob((b) => download(b, `pcb-${annotated ? 'annotated' : 'raw'}-${stamp()}.png`), 'image/png');
  toast(annotated ? 'Saving annotated PNG…' : 'Saving raw frame…');
}
function exportJSON() {
  const cal = calNow(), mm = (px) => (cal ? +(px / cal.pxPerMm).toFixed(3) : undefined);
  const counts = {}; st.dets.forEach((d) => { counts[d.c] = (counts[d.c] || 0) + 1; });
  const data = {
    app: 'PCB Scope', time: new Date().toISOString(),
    source: { type: st.source, width: st.sw, height: st.sh, name: st.source === 'image' ? st.imgName : ((st.devices.find((d) => d.deviceId === st.deviceId) || {}).label) },
    calibration: cal ? { pxPerMm: cal.pxPerMm } : null, solderMask: st.mask, compare: st.cmp, counts,
    detections: st.dets.map((d) => ({ class: d.c, label: d.label, cx: +d.cx.toFixed(1), cy: +d.cy.toFixed(1), lengthPx: +d.L.toFixed(1), widthPx: +d.W.toFixed(1), lengthMm: mm(d.L), widthMm: mm(d.W), bbox: d.bb.map((v) => +v.toFixed(1)), info: d.info, partial: !!d.partial })),
    measurements: st.measures.map((m) => { const px = Math.hypot(m.x2 - m.x1, m.y2 - m.y1); return { x1: m.x1, y1: m.y1, x2: m.x2, y2: m.y2, px: +px.toFixed(2), mm: mm(px) }; }),
  };
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `pcb-detections-${stamp()}.json`);
}

/* ---------- controls wiring ---------- */

function setTool(t) {
  st.tool = t;
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t));
  stage.className = 'tool-' + t;
  $('#measBtn').classList.toggle('on', t === 'measure');
  $('#calBtn').classList.toggle('on', t === 'calib');
  $('#ocrBtn').classList.toggle('on', t === 'ocr');
  if (t === 'calib') toast('Drag along a feature of known length');
  if (t === 'ocr') toast('Drag a box around the marking');
}
function toggleFreeze() {
  if (st.source !== 'camera') return;
  st.frozen = !st.frozen; updateSourceUI(); st.paramVer++;
}
function setRefFromFrame() {
  if (!st.sw) return toast('No image');
  sendRef(frame, st.sw, st.sh);
  toast('Reference captured');
}
function bindSlider(id, get, set, fmt = (v) => v) {
  const inp = $('#' + id), out = $('#' + id + 'O');
  inp.value = get(); if (out) out.textContent = fmt(get());
  inp.oninput = () => { set(+inp.value); if (out) out.textContent = fmt(+inp.value); };
}
function buildTuning() {
  const box = $('#tune'); box.innerHTML = '';
  for (const t of TUNING) {
    if (t.g) { const d = document.createElement('div'); d.className = 'grp'; d.textContent = t.g; box.append(d); continue; }
    if (t.opts) {
      const row = document.createElement('div'); row.className = 'row';
      row.innerHTML = `<span class="hint" style="min-width:110px">${t.label}</span>`;
      const s = document.createElement('select'); t.opts.forEach(([v, l]) => s.append(new Option(l, v))); s.value = String(st.p[t.key]);
      s.onchange = () => { st.p[t.key] = t.key === 'procMax' ? +s.value : s.value; saveParams(); };
      row.append(s); box.append(row); continue;
    }
    if (t.bool) {
      const l = document.createElement('label'); l.className = 'check';
      l.innerHTML = `<input type="checkbox"> ${t.label}`; const cb = l.querySelector('input'); cb.checked = !!st.p[t.key];
      cb.onchange = () => { st.p[t.key] = cb.checked; saveParams(); };
      box.append(l); continue;
    }
    const d = document.createElement('div'); d.className = 'slider';
    d.innerHTML = `<label>${t.label}</label><output></output><input type="range" min="${t.min}" max="${t.max}" step="${t.step}">`;
    const inp = d.querySelector('input'), out = d.querySelector('output');
    inp.value = st.p[t.key]; out.textContent = st.p[t.key];
    inp.oninput = () => { st.p[t.key] = +inp.value; out.textContent = inp.value; saveParams(); };
    box.append(d);
  }
  const rb = document.createElement('button'); rb.textContent = 'Reset tuning to defaults';
  rb.onclick = () => { const keep = { align: st.p.align, diffThr: st.p.diffThr, diffMin: st.p.diffMin }; st.p = Object.assign({}, DEFAULTS, keep); saveParams(); buildTuning(); };
  box.append(rb);
}
function saveParams() { LS.set('params', st.p); st.paramVer++; }

function wire() {
  buildLayers(); buildTuning(); applyFilter(); updateCalUI(); setTool('pan');
  $('#resSel').value = st.res;
  $('#flipH').checked = st.flipH; $('#flipV').checked = st.flipV; $('#sharpen').checked = st.view.sharpen;
  $('#detOn').checked = st.detectOn; $('#alignSel').value = st.p.align;
  $('#scalebar').checked = st.view.scalebar; $('#gridChk').checked = st.view.grid; $('#crossChk').checked = st.view.cross;
  const saveView = () => { LS.set('view', st.view); applyFilter(); dirtyImg = dirtyOvl = true; syncViewButtons(); };
  bindSlider('bri', () => st.view.bri, (v) => { st.view.bri = v; saveView(); }, (v) => v + '%');
  bindSlider('con', () => st.view.con, (v) => { st.view.con = v; saveView(); }, (v) => v + '%');
  bindSlider('satr', () => st.view.sat, (v) => { st.view.sat = v; saveView(); }, (v) => v + '%');
  bindSlider('diffThr', () => st.p.diffThr, (v) => { st.p.diffThr = v; saveParams(); });
  bindSlider('diffMin', () => st.p.diffMin, (v) => { st.p.diffMin = v; saveParams(); });
  bindSlider('refAlpha', () => Math.round(st.refAlpha * 100), (v) => { st.refAlpha = v / 100; if (v > 0) ensureCompare(); st.paramVer++; dirtyImg = true; }, (v) => v + '%');
  $('#sharpen').onchange = (e) => { st.view.sharpen = e.target.checked; saveView(); };
  $('#flipH').onchange = (e) => { st.flipH = e.target.checked; LS.set('flipH', st.flipH); redrawStill(); };
  $('#flipV').onchange = (e) => { st.flipV = e.target.checked; LS.set('flipV', st.flipV); redrawStill(); };
  $('#scalebar').onchange = (e) => { st.view.scalebar = e.target.checked; saveView(); };
  $('#gridChk').onchange = (e) => { st.view.grid = e.target.checked; saveView(); };
  $('#crossChk').onchange = (e) => { st.view.cross = e.target.checked; saveView(); };
  $('#tGrid').onclick = () => { st.view.grid = !st.view.grid; $('#gridChk').checked = st.view.grid; saveView(); };
  $('#tCross').onclick = () => { st.view.cross = !st.view.cross; $('#crossChk').checked = st.view.cross; saveView(); };
  $('#detOn').onchange = (e) => { st.detectOn = e.target.checked; LS.set('detectOn', st.detectOn); st.paramVer++; if (!st.detectOn) { st.dets = st.dets.filter((d) => d.c === 'diff'); dirtyOvl = true; } renderSide(); };
  $('#alignSel').onchange = (e) => { st.p.align = e.target.value; saveParams(); };
  $('#cmpOn').onchange = (e) => { st.cmpOn = e.target.checked; if (!st.cmpOn) { refCv.width = 0; st.dets = st.dets.filter((d) => d.c !== 'diff'); dirtyImg = dirtyOvl = true; } st.paramVer++; renderSide(); };
  $('#blink').onchange = (e) => { st.blink = e.target.checked; if (st.blink) ensureCompare(); st.paramVer++; dirtyImg = true; };
  $('#refBtn').onclick = setRefFromFrame;
  $('#refLoad').onclick = () => $('#refFile').click();
  $('#refFile').onchange = (e) => { if (e.target.files[0]) loadImageFile(e.target.files[0], true); e.target.value = ''; };
  $('#refClear').onclick = () => { if (worker) worker.postMessage({ type: 'clearRef' }); st.refInfo = null; st.cmp = null; refCv.width = 0; st.dets = st.dets.filter((d) => d.c !== 'diff'); $('#refInfo').textContent = 'No reference.'; dirtyImg = dirtyOvl = true; renderSide(); };

  $('#camBtn').onclick = () => { if (st.source === 'camera') stopCamera(); else startCamera($('#camSel').value || st.deviceId, false); };
  $('#camSel').onchange = (e) => { st.deviceId = e.target.value; startCamera(e.target.value, false); };
  $('#resSel').onchange = (e) => { st.res = e.target.value; LS.set('res', st.res); if (st.source === 'camera') startCamera(st.deviceId, false); };
  $('#openBtn').onclick = $('#emptyOpen').onclick = () => $('#fileIn').click();
  $('#emptyCam').onclick = () => startCamera(st.deviceId, false);
  $('#fileIn').onchange = (e) => { if (e.target.files[0]) loadImageFile(e.target.files[0], false); e.target.value = ''; };
  $('#btnFreeze').onclick = toggleFreeze;
  $('#btnSnap').onclick = () => savePNG(true);
  $('#expJson').onclick = exportJSON;
  $('#expRaw').onclick = () => savePNG(false);
  $('#focusBox').onclick = () => { st.focusMax = st.focus || 0; };
  document.querySelectorAll('#toolbar [data-tool]').forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
  $('#zIn').onclick = () => setZoom(st.zoom * 1.5);
  $('#zOut').onclick = () => setZoom(st.zoom / 1.5);
  $('#zFit').onclick = () => fitView(true);
  $('#calBtn').onclick = () => { $('#secMeasure').open = true; setTool('calib'); };
  $('#measBtn').onclick = () => setTool(st.tool === 'measure' ? 'pan' : 'measure');
  $('#measClear').onclick = () => { st.measures = []; updateMeasureList(); dirtyOvl = true; };
  $('#ocrBtn').onclick = () => setTool('ocr');
  $('#ocrAgain').onclick = () => lastOcrRect && runOCR(lastOcrRect);
  $('#calOk').onclick = applyCal;
  $('#calCancel').onclick = closeCalDialog;
  $('#calMm').onkeydown = (e) => { if (e.key === 'Enter') applyCal(); if (e.key === 'Escape') closeCalDialog(); };
  const pb = $('#calPresetBtns');
  for (const [v, l] of CAL_PRESETS) { const b = document.createElement('button'); b.textContent = l; b.title = v + ' mm'; b.onclick = () => { $('#calMm').value = v; }; pb.append(b); }
  $('#presetSave').onclick = () => {
    const c = calNow(); if (!c) return toast('Calibrate first');
    const name = prompt('Name for this magnification (e.g. "10x", "zoom ring 3")'); if (!name) return;
    st.presets.push({ name, res: `${st.sw}x${st.sh}`, pxPerMm: c.pxPerMm }); LS.set('calPresets', st.presets); updateCalUI();
  };
  $('#presetSel').onchange = (e) => {
    const p = st.presets[+e.target.value]; if (!p || e.target.value === '') return;
    if (p.res !== `${st.sw}x${st.sh}`) toast(`Preset was made at ${p.res}; current frame is ${st.sw}×${st.sh}`);
    st.cal[`${st.sw}x${st.sh}`] = { pxPerMm: p.pxPerMm, t: Date.now(), preset: p.name }; LS.set('cal', st.cal);
    st.paramVer++; updateCalUI(); updateMeasureList(); dirtyOvl = true;
  };
  $('#presetDel').onclick = () => { const i = $('#presetSel').value; if (i === '') return; st.presets.splice(+i, 1); LS.set('calPresets', st.presets); updateCalUI(); };

  // drag & drop
  let dragDepth = 0;
  const hint = () => { let h = $('#dropHint'); if (!h) { h = document.createElement('div'); h.id = 'dropHint'; h.className = 'drop-hint'; h.textContent = 'Drop image — hold Alt to drop as reference'; stage.append(h); } return h; };
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; hint().hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; hint().hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; hint().hidden = true; const f = e.dataTransfer.files[0]; if (f) loadImageFile(f, e.altKey); });

  window.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.metaKey || e.ctrlKey) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); if (!spaceDown) { spaceDown = true; if (st.source === 'camera') toggleFreeze(); } return; }
    if (k === 's') savePNG(true);
    else if (k === 'S') savePNG(false);
    else if (k === 'd') { $('#detOn').click(); }
    else if (k === 'r') setRefFromFrame();
    else if (k === 'b') { $('#blink').click(); }
    else if (k === 'v') setTool('pan');
    else if (k === 'm') setTool('measure');
    else if (k === 'c') { $('#secMeasure').open = true; setTool('calib'); }
    else if (k === 'o') setTool('ocr');
    else if (k === 'g') $('#tGrid').click();
    else if (k === 'x') $('#tCross').click();
    else if (k === 'h') $('#flipH').click();
    else if (k === '0' || k === 'f') fitView(true);
    else if (k === '+' || k === '=') setZoom(st.zoom * 1.5);
    else if (k === '-') setZoom(st.zoom / 1.5);
    else if (k === 'Escape') { drag = null; st.sel = null; closeCalDialog(); setTool('pan'); renderSide(); }
    else if (k === 'Backspace' || k === 'Delete') { st.measures.pop(); updateMeasureList(); dirtyOvl = true; }
    else return;
    e.preventDefault();
  });
  window.addEventListener('keyup', (e) => { if (e.key === ' ') spaceDown = false; });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
}
function syncViewButtons() {
  $('#tGrid').classList.toggle('on', st.view.grid);
  $('#tCross').classList.toggle('on', st.view.cross);
}
function ensureCompare() {
  if (!st.refInfo) return toast('Set a reference first');
  if (!st.cmpOn) { st.cmpOn = true; $('#cmpOn').checked = true; }
}

/* ---------- boot ---------- */

wire(); syncViewButtons(); updateSourceUI(); renderSide(); resize();
startWorker();
requestAnimationFrame(loop);
const qs = new URLSearchParams(location.search);
if (qs.get('img')) loadImageURL(qs.get('img'), qs.get('img').split('/').pop(), false);
else if (qs.get('nocam') == null) {
  refreshDevices().then(() => startCamera(st.deviceId, true));
}
window.__pcbscope = { st, loadImageURL, setRefFromFrame, sendRef, frame, startCamera };
// The macOS app saves downloads to ~/Downloads/PCB Scope and reports the path back here.
window.__pcbscopeNativeSaved = (path) => toast('Saved ' + path);
})();
