/* PCB Scope — OpenCV.js worker.
 * Runs off the UI thread: focus score, focus peaking, solder-mask / metal / body
 * pixel classes, part detection (ICs with lead counting, 2-terminal chips with
 * package guess), holes, tented vias, exposed copper, irregular dark regions,
 * and golden-board compare (ORB + RANSAC homography, Lab difference).
 * All coordinates sent back are in full-resolution source pixels.
 */
'use strict';
importScripts('vendor/opencv.js');

let cv = null;
let ref = null; // golden reference: { w, h, rgb, gray, kp, des, kpts }

const ready = (async () => {
  let c = self.cv;
  if (c && !c.Mat && typeof c.then === 'function') {
    // Wrap so a thenable Module can never be re-adopted by the promise machinery.
    const box = await new Promise((res) => c.then((m) => res({ m })));
    c = box.m;
  }
  if (!c.Mat) await new Promise((res) => { c.onRuntimeInitialized = res; });
  cv = c;
  let ver = '';
  try { ver = (cv.getBuildInformation().match(/General configuration for OpenCV ([\w.\-]+)/) || [])[1] || ''; } catch (_) {}
  postMessage({ type: 'ready', version: ver });
})().catch((e) => postMessage({ type: 'fatal', error: String((e && e.message) || e) }));

function errMsg(e) {
  if (typeof e === 'number' && cv) { try { return cv.exceptionFromPtr(e).msg; } catch (_) {} }
  return (e && e.message) || String(e);
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  await ready;
  if (!cv) return;
  try {
    if (msg.type === 'detect') { const [out, tr] = runJob(msg); postMessage(out, tr); }
    else if (msg.type === 'setRef') postMessage(setRef(msg));
    else if (msg.type === 'clearRef') { clearRef(); postMessage({ type: 'refcleared' }); }
  } catch (e) {
    postMessage({ type: 'error', id: msg.id, kind: msg.type, error: errMsg(e) });
  }
};

/* ---------- helpers ---------- */

function withMats(fn) {
  const list = [];
  const T = (m) => { list.push(m); return m; };
  try { return fn(T); } finally { for (const m of list) { try { m.delete(); } catch (_) {} } }
}
function rgbaMat(T, buf, w, h) { const m = T(new cv.Mat(h, w, cv.CV_8UC4)); m.data.set(new Uint8Array(buf)); return m; }
function kern(T, r) { return T(cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(2 * r + 1, 2 * r + 1))); }
function contoursOf(T, bin) {
  const cs = T(new cv.MatVector()), hi = T(new cv.Mat());
  cv.findContours(bin, cs, hi, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
  return cs;
}
function polyOf(mat, k) { const d = mat.data32S, P = []; for (let i = 0; i < d.length; i += 2) P.push([d[i] * k, d[i + 1] * k]); return P; }
function bbOf(P) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of P) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
  return [a, b, c, d];
}
function hueName(h) {
  if (h == null) return 'none';
  if (h < 6 || h >= 168) return 'red';
  if (h < 18) return 'orange';
  if (h < 34) return 'yellow';
  if (h < 86) return 'green';
  if (h < 97) return 'cyan';
  if (h < 131) return 'blue';
  return 'purple';
}

const CHIP = [['01005', 0.4, 0.2], ['0201', 0.6, 0.3], ['0402', 1.0, 0.5], ['0603', 1.6, 0.8], ['0805', 2.0, 1.25],
  ['1206', 3.2, 1.6], ['1210', 3.2, 2.5], ['1812', 4.5, 3.2], ['2010', 5.0, 2.5], ['2512', 6.4, 3.2]];
function chipPkg(Lmm, Wmm) {
  const a = Math.max(Lmm, Wmm), b = Math.min(Lmm, Wmm);
  let best = null, bd = 1e9;
  for (const [n, l, w] of CHIP) { const d = Math.abs(Math.log(a / l)) + Math.abs(Math.log(b / w)); if (d < bd) { bd = d; best = n; } }
  return bd < 0.5 ? best : null;
}
const PITCH = [[0.4, 'fine-pitch QFP/QFN'], [0.5, 'QFP / QFN / TSSOP'], [0.65, 'TSSOP / SSOP'], [0.8, 'QFP'],
  [0.95, 'SOT-23'], [1.27, 'SOIC'], [2.54, 'DIP / header']];
function pitchName(mm) {
  let best = null, bd = 1e9;
  for (const [p, n] of PITCH) { const d = Math.abs(mm - p) / p; if (d < bd) { bd = d; best = [p, n]; } }
  return bd < 0.15 ? best : null;
}
function inPoly(x, y, P) {
  let inside = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/* Walk along a blob's long axis: ends vs middle in brightness / saturation / pixel class. */
function chipProfile(rr, lab, H, w, h) {
  const q = cv.RotatedRect.points(rr);
  const ax = q[1].x - q[0].x, ay = q[1].y - q[0].y, bx = q[2].x - q[1].x, by = q[2].y - q[1].y;
  let La = Math.hypot(ax, ay) || 1, Lb = Math.hypot(bx, by) || 1;
  let A = [ax / La, ay / La], B = [bx / Lb, by / Lb];
  if (Lb > La) { [La, Lb] = [Lb, La]; [A, B] = [B, A]; }
  const cx = rr.center.x, cy = rr.center.y;
  const seg = () => ({ v: 0, s: 0, n: 0, cls: new Uint32Array(8) });
  const e1 = seg(), e2 = seg(), mid = seg(), all = seg();
  const tMax = Math.max(1, 0.3 * Lb);
  for (let sA = -La / 2 + 0.5; sA < La / 2; sA += 1) {
    const f = (sA + La / 2) / La;
    const g = f < 0.25 ? e1 : f > 0.75 ? e2 : f >= 0.35 && f <= 0.65 ? mid : null;
    for (let t = -tMax; t <= tMax; t += 1) {
      const x = Math.round(cx + sA * A[0] + t * B[0]), y = Math.round(cy + sA * A[1] + t * B[1]);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const i = y * w + x, c = lab[i];
      all.cls[c]++; all.n++;
      if (!g || c === 1) continue;
      g.v += H[i * 3 + 2]; g.s += H[i * 3 + 1]; g.n++; g.cls[c]++;
    }
  }
  const mean = (g, key) => (g.n ? g[key] / g.n : 0);
  const major = (g) => { let b = 0; for (let c = 2; c < 8; c++) if (g.cls[c] > g.cls[b]) b = c; return b; };
  const d = (e) => Math.abs(mean(e, 'v') - mean(mid, 'v')) + 0.7 * Math.abs(mean(e, 's') - mean(mid, 's'));
  const contrast = Math.min(d(e1), d(e2));
  const mc = major(mid), ec1 = major(e1), ec2 = major(e2);
  const term = e1.n > 0 && e2.n > 0 && (contrast >= 22 || (ec1 !== mc && ec2 !== mc && ec1 !== 0 && ec2 !== 0));
  return { mid: mc, term, contrast, fracDark: all.n ? all.cls[2] / all.n : 0 };
}
function solidityOf(T, c, area) {
  const hull = T(new cv.Mat()); cv.convexHull(c, hull, false, true);
  return area / Math.max(1, cv.contourArea(hull));
}
function median(a) { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[s.length >> 1]; }

/* ---------- job ---------- */

function runJob(msg) {
  return withMats((T) => {
    const t0 = performance.now();
    const { w, h, k, tasks, p } = msg;
    const rgba = rgbaMat(T, msg.buf, w, h);
    const rgb = T(new cv.Mat()); cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const gray = T(new cv.Mat()); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
    const out = { type: 'result', id: msg.id, w, h, k, dets: [], board: [], mask: null, cmp: null };
    const tr = [];
    if (tasks.focus) out.focus = focusScore(T, gray, p.focusFull);
    if (tasks.peaking) { out.peak = peaking(T, gray, p.peakThr); tr.push(out.peak.buffer); }
    if (tasks.detect) analyse(T, rgb, gray, out, msg);
    if (out.classmap) tr.push(out.classmap.buffer);
    if (tasks.compare) compare(T, rgb, gray, out, msg, tr);
    out.ms = performance.now() - t0;
    return [out, tr];
  });
}

function focusScore(T, gray, full) {
  const w = gray.cols, h = gray.rows;
  const src = full ? gray : T(gray.roi(new cv.Rect(Math.round(w * 0.25), Math.round(h * 0.25), Math.round(w * 0.5), Math.round(h * 0.5))));
  const lap = T(new cv.Mat()); cv.Laplacian(src, lap, cv.CV_32F, 3);
  const mean = T(new cv.Mat()), sd = T(new cv.Mat()); cv.meanStdDev(lap, mean, sd);
  const s = sd.doubleAt(0, 0);
  return s * s;
}

function peaking(T, gray, thr) {
  const b = T(new cv.Mat()); cv.GaussianBlur(gray, b, new cv.Size(3, 3), 0);
  const lap = T(new cv.Mat()); cv.Laplacian(b, lap, cv.CV_16S, 3);
  const a = T(new cv.Mat()); cv.convertScaleAbs(lap, a);
  const m = T(new cv.Mat()); cv.threshold(a, m, thr, 255, cv.THRESH_BINARY);
  return m.data.slice();
}

/* ---------- PCB analysis ---------- */

function analyse(T, rgb, gray, out, msg) {
  const { w, h, k, p, tasks } = msg;
  const N = w * h, u = w / 960, u2 = u * u;
  const hsv = T(new cv.Mat()); cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const H = hsv.data;

  // 1. Solder-mask hue: peak of the hue histogram of saturated pixels.
  const hist = new Float64Array(180); let sat = 0;
  for (let i = 0, j = 0; i < N; i++, j += 3) if (H[j + 1] >= 60 && H[j + 2] >= 45) { hist[H[j]]++; sat++; }
  const sm = new Float64Array(180);
  for (let a = 0; a < 180; a++) { let s = 0; for (let d = -4; d <= 4; d++) s += hist[(a + d + 180) % 180]; sm[a] = s; }
  let hue = null;
  const auto = p.maskHue === 'auto';
  if (auto) {
    if (sat / N >= 0.10) {
      let b1 = 0; for (let a = 1; a < 180; a++) if (sm[a] > sm[b1]) b1 = a;
      hue = b1;
      if (b1 >= 6 && b1 <= 32) { // copper / MLCC / gold zone — prefer a strong peak elsewhere
        let b2 = -1; for (let a = 0; a < 180; a++) if ((a < 6 || a > 32) && (b2 < 0 || sm[a] > sm[b2])) b2 = a;
        if (b2 >= 0 && sm[b2] >= 0.25 * sm[b1]) hue = b2;
      }
    }
  } else if (p.maskHue !== 'none') hue = +p.maskHue;
  const useMask = hue !== null;

  // 2. Per-pixel classes. lab: 1 mask, 2 dark body, 3 bright (metal / white ceramic), 4 warm (beige / brown),
  //    5 copper / gold, 6 coloured body (blue …), 7 mid grey.
  const tol = p.maskTol, sMin = p.maskSmin;
  const lab = new Uint8Array(N);
  const vHist = new Uint32Array(256);
  let nMask = 0;
  for (let i = 0, j = 0; i < N; i++, j += 3) {
    if (!useMask) break;
    const hh = H[j], s = H[j + 1], v = H[j + 2];
    if (s >= sMin && v >= 30 && v <= p.maskVmax) {
      let dh = hh > hue ? hh - hue : hue - hh; if (dh > 90) dh = 180 - dh;
      if (dh <= tol) { lab[i] = 1; nMask++; vHist[v]++; }
    }
  }
  // Dark threshold follows the board brightness, so exposure changes don't break it.
  let darkThr = p.darkV;
  if (p.darkRel > 0 && nMask > 0.05 * N) {
    let acc = 0, med = 0; for (let v = 0; v < 256; v++) { acc += vHist[v]; if (acc >= nMask / 2) { med = v; break; } }
    darkThr = Math.max(35, Math.min(160, Math.round(med * p.darkRel / 100)));
  }
  for (let i = 0, j = 0; i < N; i++, j += 3) {
    if (lab[i]) continue;
    const hh = H[j], s = H[j + 1], v = H[j + 2];
    const warm = hh >= 4 && hh <= 32;
    if (warm && s >= 70 && v >= 40) { lab[i] = s >= p.copperS && v >= 100 ? 5 : 4; continue; }
    if (v <= darkThr) { lab[i] = 2; continue; }
    if (warm && s >= p.tanS && v >= 70) { lab[i] = 4; continue; }
    if (s <= p.metalS && v >= p.metalV) { lab[i] = 3; continue; }
    if (s >= 60) { lab[i] = 6; continue; }
    if (s <= p.bodyS && v < p.metalV) { lab[i] = 2; continue; }
    lab[i] = 7;
  }
  const mask = new Uint8Array(N), dark = new Uint8Array(N), metal = new Uint8Array(N), copper = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const c = lab[i];
    if (c === 1) mask[i] = 255; else if (c === 2) dark[i] = 255; else if (c === 3) metal[i] = 255; else if (c === 5) copper[i] = 255;
  }
  out.mask = { hue, auto, name: useMask ? hueName(hue) : 'unsaturated', coverage: nMask / N, darkThr };
  if (tasks.classmap) out.classmap = lab.slice();

  const toMat = (arr) => { const m = T(new cv.Mat(h, w, cv.CV_8UC1)); m.data.set(arr); return m; };
  const r1 = Math.max(1, Math.round(u));

  // 3. Board region: convex hull of the larger solder-mask regions (components sit inside it).
  let boardFill = null;
  if (useMask && nMask > 0.02 * N) {
    const bm = toMat(mask);
    cv.morphologyEx(bm, bm, cv.MORPH_CLOSE, kern(T, Math.max(2, Math.round(6 * u))));
    const cs = contoursOf(T, bm);
    const pts = [];
    for (let i = 0; i < cs.size(); i++) {
      const c = T(cs.get(i));
      if (cv.contourArea(c) < 0.005 * N) continue;
      const d = c.data32S; for (let j = 0; j < d.length; j++) pts.push(d[j]);
    }
    if (pts.length >= 6) {
      const all = T(cv.matFromArray(pts.length / 2, 1, cv.CV_32SC2, pts));
      const hull = T(new cv.Mat()); cv.convexHull(all, hull, false, true);
      boardFill = T(cv.Mat.zeros(h, w, cv.CV_8UC1));
      const hv = T(new cv.MatVector()); hv.push_back(hull);
      cv.drawContours(boardFill, hv, 0, new cv.Scalar(255), cv.FILLED);
      out.board.push(polyOf(hull, k));
    }
  }

  // Only report things on the board when the board clearly fills a good part of the view.
  let onBoard = () => true;
  if (p.boardOnly && boardFill && cv.countNonZero(boardFill) >= 0.25 * N) {
    const grown = T(new cv.Mat());
    cv.dilate(boardFill, grown, kern(T, Math.max(2, Math.round(12 * u))));
    const G = grown.data.slice();
    onBoard = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < w && yi < h && G[yi * w + xi] > 0; };
  }
  out.boardOnly = onBoard.length > 0;
  const minSide = p.minPart * u, minA = minSide * minSide * 0.6;
  const ctx = { w, h, k, p, metal, u };
  out.dets = out.dets || [];

  // 4. Dark blobs → IC / resistor / diode bodies, holes, irregular dark regions.
  if (tasks.parts || tasks.holes || tasks.anomaly) {
    const dm = toMat(dark);
    cv.morphologyEx(dm, dm, cv.MORPH_OPEN, kern(T, r1));
    // Close over marking text so a body with white print stays one blob.
    cv.morphologyEx(dm, dm, cv.MORPH_CLOSE, kern(T, Math.max(1, Math.round(p.bodyClose * u))));
    const cs = contoursOf(T, dm);
    for (let i = 0; i < cs.size(); i++) {
      const c = T(cs.get(i));
      const area = cv.contourArea(c);
      if (area < 6 * u2) continue;
      const bb = cv.boundingRect(c);
      const touches = bb.x <= 1 || bb.y <= 1 || bb.x + bb.width >= w - 1 || bb.y + bb.height >= h - 1;
      const rr = cv.minAreaRect(c);
      if (!onBoard(rr.center.x, rr.center.y)) continue;
      const rw = rr.size.width, rh = rr.size.height;
      const long = Math.max(rw, rh), short = Math.max(1, Math.min(rw, rh));
      const rectness = area / Math.max(1, rw * rh);
      const peri = cv.arcLength(c, true);
      const circ = 4 * Math.PI * area / Math.max(1, peri * peri);
      const round = long / short < 1.3 && circ > 0.84 && rectness < 0.9;
      if (round && (touches || long > p.holeMax * u || !tasks.holes)) continue;
      if (round) {
        const r = (rw + rh) / 4;
        out.dets.push({ c: 'hole', cx: rr.center.x * k, cy: rr.center.y * k, r: r * k,
          bb: [(rr.center.x - r) * k, (rr.center.y - r) * k, (rr.center.x + r) * k, (rr.center.y + r) * k],
          L: 2 * r * k, W: 2 * r * k, label: 'H' });
      } else if (tasks.parts && area >= minA && short >= minSide * 0.5 && (rectness >= p.rectMin || (rectness >= p.rectMin - 0.12 && solidityOf(T, c, area) >= 0.85))) {
        out.dets.push(classifyBody(rr, false, touches, ctx));
      } else if (tasks.anomaly && boardFill && !touches && area >= Math.max(150 * u2, minA * 3) && area <= 0.2 * N && rectness < 0.6) {
        const roi = T(boardFill.roi(bb));
        if (cv.countNonZero(roi) / (bb.width * bb.height) < 0.5) continue;
        const cm = T(cv.Mat.zeros(bb.height, bb.width, cv.CV_8UC1)), one = T(new cv.MatVector()), hi2 = T(new cv.Mat());
        one.push_back(c);
        cv.drawContours(cm, one, 0, new cv.Scalar(255), cv.FILLED, cv.LINE_8, hi2, 0, new cv.Point(-bb.x, -bb.y));
        const mean = T(new cv.Mat()), sd = T(new cv.Mat());
        cv.meanStdDev(T(hsv.roi(bb)), mean, sd, cm);
        const meanS = mean.doubleAt(1, 0), sdV = sd.doubleAt(2, 0);
        if (meanS > p.anomS) continue;          // brownish → a part body, not char
        if (sdV < 8) continue;                  // perfectly flat → shadow / plastic, not burnt texture
        const ap = T(new cv.Mat()); cv.approxPolyDP(c, ap, 0.01 * peri, true);
        const poly = polyOf(ap, k);
        out.dets.push({ c: 'anomaly', poly, bb: bbOf(poly), cx: (bb.x + bb.width / 2) * k, cy: (bb.y + bb.height / 2) * k,
          L: Math.max(bb.width, bb.height) * k, W: Math.min(bb.width, bb.height) * k, label: '?',
          info: { area: area * k * k, rectness: +rectness.toFixed(2) } });
      }
    }
  }

  // 5. Chip parts from foreground (= not solder mask) blobs. Thin silkscreen strokes are opened away;
  //    each remaining blob is a part with its pads. Body colour + terminal contrast decide R / C.
  if (tasks.parts) {
    const fg = new Uint8Array(N);
    for (let i = 0; i < N; i++) if (lab[i] !== 1) fg[i] = 255;
    const fm = toMat(fg);
    cv.morphologyEx(fm, fm, cv.MORPH_OPEN, kern(T, Math.max(1, Math.round(p.silkW * u / 2))));
    const cs = contoursOf(T, fm);
    const chips = [];
    for (let i = 0; i < cs.size(); i++) {
      const c = T(cs.get(i));
      const area = cv.contourArea(c);
      if (area < minA * 1.5 || area > 0.15 * N) continue;
      const rr = cv.minAreaRect(c);
      if (!onBoard(rr.center.x, rr.center.y)) continue;
      const rw = rr.size.width, rh = rr.size.height;
      const La = Math.max(rw, rh), Lb = Math.max(1, Math.min(rw, rh)), aspect = La / Lb;
      const rect = area / Math.max(1, rw * rh);
      if (rect < 0.6 || Lb < minSide * 0.6) continue;
      const bb = cv.boundingRect(c);
      const touches = bb.x <= 1 || bb.y <= 1 || bb.x + bb.width >= w - 1 || bb.y + bb.height >= h - 1;
      const pr = chipProfile(rr, lab, H, w, h);
      if (pr.fracDark > 0.45) continue;                    // dark-bodied things are handled by the IC / body pass
      const big = area >= 0.02 * N;
      let cls = null, label = '', info = {};
      if (aspect >= 1.15 && aspect <= 4) {
        if (pr.mid === 2 && pr.term) { cls = 'res'; label = 'RES'; }
        else if (pr.mid === 4) { cls = 'cap'; label = 'CAP'; info.body = 'beige / brown ceramic'; }
        else if (pr.mid === 6) { cls = 'cap'; label = 'L/C'; info.body = 'coloured body — MLCC or chip inductor'; }
        else if (pr.mid === 3 && pr.term && pr.contrast >= 30) { cls = 'cap'; label = 'CAP'; info.body = 'white ceramic'; }
        else if (pr.mid === 7 && pr.term && pr.contrast >= 30) { cls = 'part'; label = 'part'; }
      }
      if (!cls && big && rect >= 0.75 && aspect < 2 && (pr.mid === 3 || pr.mid === 7)) { cls = 'part'; label = 'XTAL / can'; info.body = 'metal lid'; }
      if (!cls) continue;
      if (pr.term) info.terminals = 2;
      info.contrast = Math.round(pr.contrast);
      const mmPerPx = p.pxPerMm ? k / p.pxPerMm : 0;
      if (mmPerPx) {
        info.Lmm = +(La * mmPerPx).toFixed(2); info.Wmm = +(Lb * mmPerPx).toFixed(2);
        if (cls !== 'part') { const pk = chipPkg(La * mmPerPx * 0.85, Lb * mmPerPx * 0.9); if (pk) { info.pkg = pk; label += ' ' + pk; } }
      }
      const P = cv.RotatedRect.points(rr).map((q) => [q.x * k, q.y * k]);
      chips.push({ c: cls, pts: P, bb: bbOf(P), cx: rr.center.x * k, cy: rr.center.y * k, L: La * k, W: Lb * k, label, info, partial: touches || undefined });
    }
    // De-duplicate against the dark-body pass: ICs win over anything inside them; chips win over small dark bits.
    const inside = (d, o) => d.cx >= o.bb[0] && d.cx <= o.bb[2] && d.cy >= o.bb[1] && d.cy <= o.bb[3] && inPoly(d.cx, d.cy, o.pts || o.poly);
    const ics = out.dets.filter((d) => d.c === 'ic');
    const keepChips = chips.filter((d) => !ics.some((o) => inside(d, o)));
    out.dets = out.dets.filter((d) => !((d.c === 'res' || d.c === 'part') && keepChips.some((o) => inside(d, o))));
    out.dets.push(...keepChips);
  }

  // 6. Metal blobs → pads / solder joints / leads (thin silkscreen strokes removed by opening).
  if (tasks.pads) {
    const mt = toMat(metal);
    const pr = Math.max(1, Math.round(p.padMin * u / 2));
    cv.morphologyEx(mt, mt, cv.MORPH_OPEN, kern(T, pr));
    const cs = contoursOf(T, mt);
    const minPadA = Math.max(4, (p.padMin * u) ** 2);
    const pads = [];
    const ch = T(new cv.MatVector()); cv.split(hsv, ch);
    const vch = T(ch.get(2)), sch = T(ch.get(1));
    const hier = T(new cv.Mat());
    let silk = 0;
    for (let i = 0; i < cs.size(); i++) {
      const c = T(cs.get(i));
      const area = cv.contourArea(c);
      if (area < minPadA || area > 0.15 * N) continue;
      const hull = T(new cv.Mat()); cv.convexHull(c, hull, false, true);
      const solidity = area / Math.max(1, cv.contourArea(hull));
      if (solidity < 0.6) continue;
      // Silkscreen ink is flat and white; solder / tinned copper is shiny with strong shading.
      const bb = cv.boundingRect(c);
      const m = T(cv.Mat.zeros(bb.height, bb.width, cv.CV_8UC1));
      const one = T(new cv.MatVector()); one.push_back(c);
      cv.drawContours(m, one, 0, new cv.Scalar(255), cv.FILLED, cv.LINE_8, hier, 0, new cv.Point(-bb.x, -bb.y));
      const mean = T(new cv.Mat()), sd = T(new cv.Mat());
      cv.meanStdDev(T(vch.roi(bb)), mean, sd, m);
      const mv = mean.doubleAt(0, 0), sv = sd.doubleAt(0, 0);
      cv.meanStdDev(T(sch.roi(bb)), mean, sd, m);
      const ms = mean.doubleAt(0, 0);
      if (p.silkFilter && mv >= p.silkV && sv <= p.silkStd) { silk++; continue; }
      const rr = cv.minAreaRect(c);
      if (!onBoard(rr.center.x, rr.center.y)) continue;
      const P = cv.RotatedRect.points(rr).map((q) => [q.x * k, q.y * k]);
      pads.push({ c: 'pad', pts: P, bb: bbOf(P), cx: rr.center.x * k, cy: rr.center.y * k,
        L: Math.max(rr.size.width, rr.size.height) * k, W: Math.min(rr.size.width, rr.size.height) * k,
        label: 'pad', info: { solidity: +solidity.toFixed(2), meanV: Math.round(mv), stdV: Math.round(sv), meanS: Math.round(ms) }, area });
    }
    out.silk = silk;
    pads.sort((a, b) => b.area - a.area);
    for (const d of pads.slice(0, 2500)) { delete d.area; out.dets.push(d); }
  }

  // 7. Exposed copper / gold.
  if (tasks.copper) {
    const cm = toMat(copper);
    cv.morphologyEx(cm, cm, cv.MORPH_OPEN, kern(T, r1));
    const cs = contoursOf(T, cm);
    const minCu = (p.copperMin * u) ** 2;
    for (let i = 0; i < cs.size(); i++) {
      const c = T(cs.get(i));
      const area = cv.contourArea(c);
      if (area < minCu) continue;
      const bb = cv.boundingRect(c);
      if (!onBoard(bb.x + bb.width / 2, bb.y + bb.height / 2)) continue;
      let hs = 0, n = 0;
      for (let y = bb.y; y < bb.y + bb.height; y++) for (let x = bb.x; x < bb.x + bb.width; x++) {
        const i2 = y * w + x; if (copper[i2]) { hs += H[i2 * 3]; n++; }
      }
      const mh = n ? hs / n : 15;
      const ap = T(new cv.Mat()); cv.approxPolyDP(c, ap, 0.01 * cv.arcLength(c, true), true);
      const poly = polyOf(ap, k);
      const gold = mh >= 18;
      out.dets.push({ c: 'copper', poly, bb: bbOf(poly), cx: (bb.x + bb.width / 2) * k, cy: (bb.y + bb.height / 2) * k,
        L: Math.max(bb.width, bb.height) * k, W: Math.min(bb.width, bb.height) * k,
        label: gold ? 'Au' : 'Cu', info: { kind: gold ? 'gold / ENIG / tantalum?' : 'bare copper', hue: +mh.toFixed(1), area: area * k * k } });
    }
  }

  // 8. Tented vias (Hough circles on the grey image).
  if (tasks.vias) {
    const g = T(new cv.Mat()); cv.medianBlur(gray, g, 5);
    const circ = T(new cv.Mat());
    const rmin = Math.max(1, Math.round(p.viaRmin * u)), rmax = Math.max(rmin + 1, Math.round(p.viaRmax * u));
    cv.HoughCircles(g, circ, cv.HOUGH_GRADIENT, 1, rmin * 2.2, 90, p.viaSens, rmin, rmax);
    const n = Math.min(circ.cols, 1000), D = circ.data32F;
    for (let i = 0; i < n; i++) {
      const x = D[i * 3] * k, y = D[i * 3 + 1] * k, r = D[i * 3 + 2] * k;
      out.dets.push({ c: 'via', cx: x, cy: y, r, bb: [x - r, y - r, x + r, y + r], L: 2 * r, W: 2 * r, label: 'via' });
    }
  }
}

/* A dark or tan rectangle → IC (leads counted on its edges), 2-terminal chip, or other part. */
function classifyBody(rr, isTan, touches, ctx) {
  const { w, h, k, p, metal } = ctx;
  const q = cv.RotatedRect.points(rr);
  const ax = q[1].x - q[0].x, ay = q[1].y - q[0].y, bx = q[2].x - q[1].x, by = q[2].y - q[1].y;
  let La = Math.hypot(ax, ay) || 1, Lb = Math.hypot(bx, by) || 1;
  let A = [ax / La, ay / La], B = [bx / Lb, by / Lb];
  if (Lb > La) { [La, Lb] = [Lb, La]; [A, B] = [B, A]; }
  const cx = rr.center.x, cy = rr.center.y;
  const sample = (x, y) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= w || y >= h) return -1;
    return metal[y * w + x] ? 1 : 0;
  };
  const depth = Math.max(2, Math.min(0.35 * Lb, 40 * ctx.u));
  // Scan just outside one edge: U = direction along the edge, V = outward normal.
  function scanEdge(U, V, half, off) {
    const n = Math.max(4, Math.round(2 * half)), step = (2 * half) / n, D = Math.max(2, Math.round(depth));
    const prof = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = -half + (i + 0.5) * step; let m = 0, c = 0;
      for (let d = 1; d <= D; d++) {
        const v = sample(cx + s * U[0] + (off + d) * V[0], cy + s * U[1] + (off + d) * V[1]);
        if (v >= 0) { m += v; c++; }
      }
      prof[i] = c ? m / c : 0;
    }
    const runsAt = (thr) => {
      const runs = []; let st = -1;
      for (let i = 0; i <= n; i++) {
        const on = i < n && prof[i] >= thr;
        if (on && st < 0) st = i;
        if (!on && st >= 0) { runs.push([st, i - 1]); st = -1; }
      }
      const minRun = Math.max(1, Math.round(n * 0.015));
      return runs.filter((r) => r[1] - r[0] + 1 >= minRun);
    };
    const R = runsAt(0.15);          // leads: any solid metal in the strip (specular leads are patchy)
    const R40 = runsAt(0.4);         // terminations: metal fills the strip
    let cov = 0; for (let i = 0; i < n; i++) if (prof[i] >= 0.4) cov++;
    // How far does metal continue outward (terminal length)?
    let ext = 0, gap = 0;
    const maxExt = Math.round(depth * 2);
    for (let d = 1; d <= maxExt; d++) {
      let m = 0, c = 0;
      for (let i = Math.round(n * 0.1); i < Math.round(n * 0.9); i++) {
        const s = -half + (i + 0.5) * step;
        const v = sample(cx + s * U[0] + (off + d) * V[0], cy + s * U[1] + (off + d) * V[1]);
        if (v >= 0) { m += v; c++; }
      }
      if (c && m / c >= 0.35) { ext = d; gap = 0; } else if (++gap > 1) break;
    }
    return { runs: R, runs40: R40, n, step, cover: cov / n, ext, centers: R.map((r) => ((r[0] + r[1] + 1) / 2) * step) };
  }
  const nA = [-A[0], -A[1]], nB = [-B[0], -B[1]];
  const eA1 = scanEdge(B, A, Lb / 2, La / 2), eA2 = scanEdge(B, nA, Lb / 2, La / 2);
  const eB1 = scanEdge(A, B, La / 2, Lb / 2), eB2 = scanEdge(A, nB, La / 2, Lb / 2);
  const narrow = (e) => e.runs.every((r) => r[1] - r[0] + 1 < 0.45 * e.n);
  const isLead = (e) => e.runs.length >= 2 && narrow(e);
  const single = (e) => e.runs.length === 1 && narrow(e);
  const isTerm = (e) => e.cover >= 0.45 && e.runs40.length <= 2 && e.ext >= 1;

  let pins = 0; const leadEdges = [];
  for (const e of [eA1, eA2, eB1, eB2]) if (isLead(e)) { pins += e.runs.length; leadEdges.push(e); }
  if (isLead(eB1) && single(eB2)) pins += 1; else if (isLead(eB2) && single(eB1)) pins += 1;
  const termA = isTerm(eA1) && isTerm(eA2), termB = isTerm(eB1) && isTerm(eB2);

  const mmPerPx = p.pxPerMm ? k / p.pxPerMm : 0; // proc px → mm
  let cls, L = La, W = Lb, info = {}, label;
  let poly = q.map((pt) => [pt.x, pt.y]);

  if (pins >= 3) {
    cls = 'ic'; info.pins = pins;
    const gaps = [];
    for (const e of leadEdges) for (let i = 1; i < e.centers.length; i++) gaps.push(e.centers[i] - e.centers[i - 1]);
    const pitchPx = median(gaps);
    if (pitchPx) {
      info.pitchPx = +(pitchPx * k).toFixed(1);
      if (mmPerPx) {
        info.pitchMm = +(pitchPx * mmPerPx).toFixed(2);
        const pn = pitchName(info.pitchMm);
        if (pn) info.family = `${pn[1]} (${pn[0]} mm)`;
      }
    }
    if (pins === 3) info.family = 'SOT-23 / SOT-323 (3-lead)';
    else if (pins === 5 || pins === 6) info.family = info.family || `SOT-23-${pins}?`;
    label = `IC ${pins} pins`;
  } else if (termA || termB) {
    const useA = termA && (!termB || eA1.cover + eA2.cover >= eB1.cover + eB2.cover);
    const [T1, T2, U, V, hT, hO] = useA ? [eA1, eA2, A, B, La / 2, Lb / 2] : [eB1, eB2, B, A, Lb / 2, La / 2];
    L = 2 * hT + T1.ext + T2.ext; W = 2 * hO;
    // Full part outline = body + both terminations.
    const c1 = hT + T1.ext, c2 = -(hT + T2.ext);
    poly = [[c1, hO], [c1, -hO], [c2, -hO], [c2, hO]].map(([s, t]) => [cx + s * U[0] + t * V[0], cy + s * U[1] + t * V[1]]);
    cls = isTan ? 'cap' : 'res';
    info.terminals = 2;
    if (mmPerPx) { const pk = chipPkg(L * mmPerPx, W * mmPerPx); if (pk) info.pkg = pk; }
    label = (isTan ? 'CAP' : 'RES') + (info.pkg ? ' ' + info.pkg : '');
  } else {
    const big = mmPerPx ? Lb * mmPerPx >= 2.4 : La * Lb >= 0.012 * w * h;
    if (big && !isTan) { cls = 'ic'; info.leads = 'none visible (QFN / BGA / module?)'; label = 'IC'; }
    else { cls = 'part'; label = isTan ? 'part (tan)' : 'part'; }
  }
  if (mmPerPx) { info.Lmm = +(L * mmPerPx).toFixed(2); info.Wmm = +(W * mmPerPx).toFixed(2); }
  const P = poly.map(([x, y]) => [x * k, y * k]);
  return { c: cls, pts: P, bb: bbOf(P), cx: cx * k, cy: cy * k, L: L * k, W: W * k, label, info, partial: touches || undefined };
}

/* ---------- golden-board compare ---------- */

function clearRef() {
  if (!ref) return;
  for (const m of [ref.rgb, ref.gray, ref.kp, ref.des]) { try { m.delete(); } catch (_) {} }
  ref = null;
}

function makeORB(n) {
  try { return new cv.ORB(n); } catch (_) {
    const o = new cv.ORB();
    try { o.setMaxFeatures(n); } catch (_) {}
    return o;
  }
}

function setRef(msg) {
  clearRef();
  const { w, h } = msg;
  const rgba = new cv.Mat(h, w, cv.CV_8UC4); rgba.data.set(new Uint8Array(msg.buf));
  const rgb = new cv.Mat(); cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB); rgba.delete();
  const gray = new cv.Mat(); cv.cvtColor(rgb, gray, cv.COLOR_RGB2GRAY);
  const orb = makeORB(msg.p.orbN || 1500), kp = new cv.KeyPointVector(), des = new cv.Mat(), none = new cv.Mat();
  orb.detectAndCompute(gray, none, kp, des);
  orb.delete(); none.delete();
  const kpts = new Float32Array(kp.size() * 2);
  for (let i = 0; i < kp.size(); i++) { const pt = kp.get(i).pt; kpts[2 * i] = pt.x; kpts[2 * i + 1] = pt.y; }
  ref = { w, h, rgb, gray, kp, des, kpts };
  return { type: 'refset', id: msg.id, w, h, keypoints: kp.size() };
}

function compare(T, rgb, gray, out, msg, tr) {
  if (!ref) { out.cmp = { ok: false, reason: 'no reference set' }; return; }
  const { w, h, k, p } = msg;
  const N = w * h, u = w / 960;
  let Hm = null, good = 0, inliers = 0;
  if (p.align === 'orb') {
    const orb = T(makeORB(p.orbN || 1500)), kp = T(new cv.KeyPointVector()), des = T(new cv.Mat()), none = T(new cv.Mat());
    orb.detectAndCompute(gray, none, kp, des);
    if (des.rows >= 8 && ref.des.rows >= 8) {
      const bf = T(new cv.BFMatcher(cv.NORM_HAMMING, false)), mv = T(new cv.DMatchVectorVector());
      bf.knnMatch(ref.des, des, mv, 2);
      const src = [], dst = [];
      for (let i = 0; i < mv.size(); i++) {
        const m = mv.get(i);
        if (m.size() >= 2) {
          const a = m.get(0), b = m.get(1);
          if (a.distance < 0.75 * b.distance) {
            const pc = kp.get(a.trainIdx).pt;
            src.push(ref.kpts[2 * a.queryIdx], ref.kpts[2 * a.queryIdx + 1]); dst.push(pc.x, pc.y);
          }
        }
        m.delete();
      }
      good = src.length / 2;
      if (good >= 8) {
        const sM = T(cv.matFromArray(good, 1, cv.CV_32FC2, src)), dM = T(cv.matFromArray(good, 1, cv.CV_32FC2, dst));
        const inl = T(new cv.Mat());
        const Hh = T(cv.findHomography(sM, dM, cv.RANSAC, 4, inl));
        if (!Hh.empty()) { inliers = cv.countNonZero(inl); if (inliers >= 8) Hm = Hh; }
      }
    }
  } else {
    Hm = T(cv.matFromArray(3, 3, cv.CV_64F, [w / ref.w, 0, 0, 0, h / ref.h, 0, 0, 0, 1]));
  }
  if (!Hm) { out.cmp = { ok: false, good, inliers, reason: good < 8 ? 'too few feature matches' : 'alignment failed' }; return; }

  const size = new cv.Size(w, h);
  const warped = T(new cv.Mat());
  cv.warpPerspective(ref.rgb, warped, Hm, size, cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
  const ones = T(new cv.Mat(ref.h, ref.w, cv.CV_8UC1, new cv.Scalar(255)));
  const valid = T(new cv.Mat());
  cv.warpPerspective(ones, valid, Hm, size, cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
  cv.erode(valid, valid, kern(T, Math.max(2, Math.round(4 * u))));
  const la = T(new cv.Mat()), lb = T(new cv.Mat());
  cv.cvtColor(warped, la, cv.COLOR_RGB2Lab); cv.cvtColor(rgb, lb, cv.COLOR_RGB2Lab);
  const bs = new cv.Size(5, 5);
  cv.GaussianBlur(la, la, bs, 0); cv.GaussianBlur(lb, lb, bs, 0);
  const A = la.data, B = lb.data, V = valid.data;
  let sum = 0, cnt = 0;
  for (let i = 0, j = 0; i < N; i++, j += 3) if (V[i]) { sum += B[j] - A[j]; cnt++; }
  const off = cnt ? sum / cnt : 0; // global brightness change between the two shots
  const diff = T(new cv.Mat(h, w, cv.CV_8UC1)), D = diff.data;
  const thr = p.diffThr; let changed = 0;
  for (let i = 0, j = 0; i < N; i++, j += 3) {
    if (!V[i]) { D[i] = 0; continue; }
    const dl = Math.abs(B[j] - A[j] - off), da = Math.abs(B[j + 1] - A[j + 1]), db = Math.abs(B[j + 2] - A[j + 2]);
    if (Math.max(dl, 1.6 * da, 1.6 * db) >= thr) { D[i] = 255; changed++; } else D[i] = 0;
  }
  cv.morphologyEx(diff, diff, cv.MORPH_OPEN, kern(T, Math.max(1, Math.round(1.5 * u))));
  cv.morphologyEx(diff, diff, cv.MORPH_CLOSE, kern(T, Math.max(1, Math.round(3 * u))));
  const cs = contoursOf(T, diff);
  const minA = (p.diffMin * u) ** 2;
  let n = 0;
  for (let i = 0; i < cs.size(); i++) {
    const c = T(cs.get(i));
    const area = cv.contourArea(c);
    if (area < minA) continue;
    const rr = cv.minAreaRect(c);
    const P = cv.RotatedRect.points(rr).map((q) => [q.x * k, q.y * k]);
    out.dets.push({ c: 'diff', pts: P, bb: bbOf(P), cx: rr.center.x * k, cy: rr.center.y * k,
      L: Math.max(rr.size.width, rr.size.height) * k, W: Math.min(rr.size.width, rr.size.height) * k,
      label: 'Δ', info: { area: Math.round(area * k * k) } });
    n++;
  }
  out.cmp = { ok: true, good, inliers, n, changed: cnt ? changed / cnt : 0, overlap: cnt / N, align: p.align };
  if (p.wantWarp) {
    const wr = T(new cv.Mat()); cv.cvtColor(warped, wr, cv.COLOR_RGB2RGBA);
    const px = new Uint8ClampedArray(wr.data);
    const Vv = valid.data; // eroded mask — fine for display
    for (let i = 0; i < N; i++) if (!Vv[i]) px[i * 4 + 3] = 0;
    out.warp = px; tr.push(px.buffer);
  }
}
