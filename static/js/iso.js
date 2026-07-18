/* Zulfidraw editor — SVG canvas locked to an isometric (triangular) lattice.
 *
 * Lattice: p(i,j) = ((i+j)·H, (i−j)·V) with H = S·√3/2, V = S/2.
 * Iso axes (screen y grows down):
 *   U = ( H, −V)  right-and-up 30°
 *   Vx= (−H, −V)  left-and-up 30°
 *   W = ( 0, −S)  vertical
 */
(() => {
  "use strict";

  const CFG = window.ZULFIDRAW;
  const S = 24, H = S * Math.sqrt(3) / 2, V = S / 2;
  const U = [H, -V], VX = [-H, -V], W = [0, -S];

  const STROKES = ["#1e293b", "#e11d48", "#2563eb", "#059669", "#d97706", "#7c3aed"];
  const FILLS = ["transparent", "#f1f5f9", "#fecdd3", "#bfdbfe", "#a7f3d0", "#fde68a", "#ddd6fe"];
  const WIDTHS = [["S", 1.5], ["M", 2.5], ["L", 4]];
  const DASHES = ["solid", "dashed", "dotted"];
  const ROUND_R = 7; // corner radius (world units) when edge rounding is on

  const doc = CFG.doc || {};
  let shapes = Array.isArray(doc.shapes) ? doc.shapes : [];
  let view = doc.view && typeof doc.view.k === "number"
    ? doc.view
    : { tx: window.innerWidth / 2, ty: window.innerHeight / 2, k: 1 };

  let tool = "select";
  let style = { stroke: STROKES[0], fill: "transparent", sw: 2.5, dash: "solid", round: false, op: 1, heads: "end" };
  let sel = new Set();
  let mode = null;          // active interaction state machine
  let spaceDown = false;
  let cursorPt = null;      // last snapped point (for the snap indicator)
  let uiReady = false;      // style panel built — safe to sync

  // ---------- svg scaffolding ----------
  const svg = document.getElementById("canvas");
  const NS = "http://www.w3.org/2000/svg";
  svg.innerHTML = `
    <defs>
      <pattern id="isogrid" patternUnits="userSpaceOnUse" width="${2 * H}" height="${S}">
        <g id="gridStrokes" stroke="#dfe7ee" stroke-width="1" fill="none">
          <path d="M0 0 L${2 * H} ${S}"/>
          <path d="M0 ${S} L${2 * H} 0"/>
          <path d="M0 0 V${S}"/>
          <path d="M${H} 0 V${S}"/>
        </g>
      </pattern>
    </defs>
    <g id="viewport">
      <rect id="gridRect" x="-100000" y="-100000" width="200000" height="200000" fill="url(#isogrid)"/>
      <g id="shapesLayer"></g>
      <g id="overlayLayer"></g>
      <g id="tempLayer"></g>
    </g>`;
  const viewport = svg.querySelector("#viewport");
  const gridRect = svg.querySelector("#gridRect");
  const gridStrokes = svg.querySelector("#gridStrokes");
  const shapesLayer = svg.querySelector("#shapesLayer");
  const overlayLayer = svg.querySelector("#overlayLayer");
  const tempLayer = svg.querySelector("#tempLayer");

  const measureCtx = document.createElement("canvas").getContext("2d");
  const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

  // ---------- geometry ----------
  const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
  const mul = (p, n) => [p[0] * n, p[1] * n];
  const eq = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;

  // Decompose a delta into iso-axis units [along U, along VX, vertical].
  // W = U + VX makes the split ambiguous; a shared a/b sign reads as vertical,
  // so a straight-up drag is height, not a 1×1 in-plane diagonal.
  function isoDims(d) {
    let a = (d[0] / H - d[1] / V) / 2;
    let b = (-d[0] / H - d[1] / V) / 2;
    let c = 0;
    if (a * b > 0) { c = Math.sign(a) * Math.min(Math.abs(a), Math.abs(b)); a -= c; b -= c; }
    return [a, b, c].map(n => Math.abs(Math.round(n * 10) / 10));
  }
  const fmtDims = ds => ds.filter(n => n).join("×");

  function screenToWorld(x, y) {
    return [(x - view.tx) / view.k, (y - view.ty) / view.k];
  }

  // nearest lattice point (checks the 4 rounding candidates of the basis coords)
  function snap(p) {
    const fi = (p[0] / H + p[1] / V) / 2, fj = (p[0] / H - p[1] / V) / 2;
    let best = null, bd = Infinity;
    for (const i of [Math.floor(fi), Math.ceil(fi)])
      for (const j of [Math.floor(fj), Math.ceil(fj)]) {
        const q = [(i + j) * H, (i - j) * V];
        const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
    return best;
  }
  const maybeSnap = (p, ev) => (ev && ev.altKey ? p : snap(p));

  function boxCorners(sh) {
    const { p, a, b, c } = sh;
    const P = (au, bv, cw) => add(add(add(p, mul(U, au)), mul(VX, bv)), mul(W, cw));
    return {
      b00: P(0, 0, 0), b10: P(a, 0, 0), b01: P(0, b, 0), b11: P(a, b, 0),
      t00: P(0, 0, c), t10: P(a, 0, c), t01: P(0, b, c), t11: P(a, b, c),
    };
  }

  const isPath = sh => sh.type === "line" || sh.type === "poly" || sh.type === "arrow";

  function shapePoints(sh) {
    if (isPath(sh)) return sh.pts;
    if (sh.type === "box") return Object.values(boxCorners(sh));
    if (sh.type === "text") {
      measureCtx.font = `500 ${sh.size}px ${FONT}`;
      const w = measureCtx.measureText(sh.text).width;
      return [sh.p, add(sh.p, [w, sh.size * 1.25])];
    }
    return [];
  }

  function bbox(pts) {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const [x, y] of pts) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
    return { x1, y1, x2, y2 };
  }

  // flip negative extents so p is always the near (bottom) corner
  function normalizeBox(p, a, b) {
    if (a < 0) { p = add(p, mul(U, a)); a = -a; }
    if (b < 0) { p = add(p, mul(VX, b)); b = -b; }
    return { p, a, b };
  }

  function translateShape(sh, d) {
    if (sh.type === "box" || sh.type === "text") sh.p = add(sh.p, d);
    else sh.pts = sh.pts.map(pt => add(pt, d));
  }

  // ---------- color ----------
  function shade(hex, amt) { // amt > 0 lighten toward white, < 0 darken toward black
    const n = parseInt(hex.slice(1), 16);
    let ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    ch = ch.map(c => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
    return "#" + ch.map(c => c.toString(16).padStart(2, "0")).join("");
  }

  // ---------- rendering ----------
  const esc = s => String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
  const pathOf = (pts, close) => "M" + pts.map(p => `${p[0]} ${p[1]}`).join(" L") + (close ? " Z" : "");

  // Corner rounding: cut each corner back along both edges and bridge with a
  // quadratic through the original vertex. Straight segments stay straight —
  // only the joins soften, so the figure stays paraline-true.
  function pathRound(pts, close, r) {
    const P = pts.filter((p, i) => i === 0 || !eq(p, pts[i - 1]));
    if (close && P.length > 1 && eq(P[0], P[P.length - 1])) P.pop();
    const n = P.length;
    if (!r || n < 3) return pathOf(P, close);

    const cut = [];  // [inPoint, outPoint] per vertex
    for (let i = 0; i < n; i++) {
      const b = P[i];
      const a = P[(i - 1 + n) % n], c = P[(i + 1) % n];
      const endpoint = !close && (i === 0 || i === n - 1);
      if (endpoint) { cut.push([b, b]); continue; }
      const d1 = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const d2 = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const rr = Math.min(r, d1 / 2, d2 / 2);
      cut.push([
        [b[0] + (a[0] - b[0]) / d1 * rr, b[1] + (a[1] - b[1]) / d1 * rr],
        [b[0] + (c[0] - b[0]) / d2 * rr, b[1] + (c[1] - b[1]) / d2 * rr],
      ]);
    }

    const xy = p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
    let d = `M${xy(cut[0][1])}`;
    for (let i = 1; i < n; i++) d += ` L${xy(cut[i][0])} Q${xy(P[i])} ${xy(cut[i][1])}`;
    if (close) d += ` L${xy(cut[0][0])} Q${xy(P[0])} ${xy(cut[0][1])} Z`;
    return d;
  }

  // Arrowhead: a V of two strokes on the terminal segment, sized off stroke width.
  // Drawn as its own solid path so a dashed shaft still gets a clean head.
  function tipPath(sh, which) {
    const pts = sh.pts;
    if (pts.length < 2) return "";
    const [tip, from] = which === "end"
      ? [pts[pts.length - 1], pts[pts.length - 2]]
      : [pts[0], pts[1]];
    const dx = tip[0] - from[0], dy = tip[1] - from[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return "";
    const ux = dx / len, uy = dy / len;
    const L = Math.min(9 + sh.sw * 2.2, len);      // never longer than the segment
    const A = 0.42;                                 // half-angle, radians
    const cos = Math.cos(A), sin = Math.sin(A);
    const barb = (s) => [
      tip[0] - L * (ux * cos + s * uy * sin),
      tip[1] - L * (uy * cos - s * ux * sin),
    ];
    const b1 = barb(1), b2 = barb(-1);
    const xy = p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
    return `<path d="M${xy(b1)} L${xy(tip)} L${xy(b2)}" fill="none" stroke="${sh.stroke}"
      stroke-width="${sh.sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }

  const dashOf = sh =>
    sh.dash === "dashed" ? `stroke-dasharray="${sh.sw * 3.6} ${sh.sw * 2.6}"`
      : sh.dash === "dotted" ? `stroke-dasharray="0.01 ${sh.sw * 2.2}"`
        : "";

  function renderShape(sh, { hit = true } = {}) {
    const hw = Math.max(sh.sw || 2, 12 / view.k);
    const op = sh.op === undefined ? 1 : sh.op;
    const open = `<g data-id="${sh.id}"${op < 1 ? ` opacity="${op}"` : ""}>`;
    const hitPath = (d, area) => hit
      ? `<path d="${d}" fill="none" stroke="transparent" stroke-width="${hw}" pointer-events="${area ? "all" : "stroke"}"/>` : "";
    const r = sh.round ? ROUND_R : 0;
    const ends = 'stroke-linecap="round" stroke-linejoin="round"';

    if (sh.type === "arrow") {
      const d = pathRound(sh.pts, false, r);
      // heads are drawn solid even on a dashed shaft, and sit on the last/first segment
      const heads = [tipPath(sh, "end"), sh.heads === "both" ? tipPath(sh, "start") : ""].join("");
      return `${open}<path d="${d}" fill="none" stroke="${sh.stroke}" stroke-width="${sh.sw}" ${dashOf(sh)} ${ends}/>${heads}${hitPath(d, false)}</g>`;
    }

    if (isPath(sh)) {
      const close = sh.type === "poly" && sh.closed;
      const d = pathRound(sh.pts, close, r);
      const fill = close && sh.fill !== "transparent" ? sh.fill : "none";
      return `${open}<path d="${d}" fill="${fill}" stroke="${sh.stroke}" stroke-width="${sh.sw}" ${dashOf(sh)} ${ends}/>${hitPath(d, fill !== "none")}</g>`;
    }

    if (sh.type === "box") {
      const c = boxCorners(sh);
      const faces = [];
      if (sh.c > 0) {
        faces.push([[c.b00, c.b10, c.t10, c.t00], -0.18]); // right
        faces.push([[c.b00, c.b01, c.t01, c.t00], 0.02]);  // left
      }
      faces.push([[c.t00, c.t10, c.t11, c.t01], 0.3]);     // top
      const wire = sh.fill === "transparent";
      const inner = faces.map(([pts, amt]) => {
        const f = wire ? "none" : shade(sh.fill, amt);
        return `<path d="${pathRound(pts, true, r)}" fill="${f}" stroke="${sh.stroke}" stroke-width="${sh.sw}" ${dashOf(sh)} ${ends}/>`;
      }).join("");
      const hitD = faces.map(([pts]) => pathOf(pts, true)).join(" ");
      return `${open}${inner}${hitPath(hitD, true)}</g>`;
    }

    if (sh.type === "text") {
      const [p1, p2] = shapePoints(sh).slice(0, 2);
      const rect = hit ? `<rect x="${p1[0]}" y="${p1[1]}" width="${p2[0] - p1[0]}" height="${p2[1] - p1[1]}" fill="transparent"/>` : "";
      return `${open}<text x="${sh.p[0]}" y="${sh.p[1]}" fill="${sh.stroke}" font-size="${sh.size}" font-weight="500" font-family="${FONT}" dominant-baseline="text-before-edge" style="white-space:pre">${esc(sh.text)}</text>${rect}</g>`;
    }
    return "";
  }

  function render() {
    shapesLayer.innerHTML = shapes.map(sh => renderShape(sh)).join("");
    renderOverlay();
  }

  function renderOverlay() {
    let out = "";
    const pad = 6 / view.k, k = view.k;
    const selShapes = shapes.filter(s => sel.has(s.id));
    for (const sh of selShapes) {
      const b = bbox(shapePoints(sh));
      out += `<rect x="${b.x1 - pad}" y="${b.y1 - pad}" width="${b.x2 - b.x1 + 2 * pad}" height="${b.y2 - b.y1 + 2 * pad}"
        fill="none" stroke="#6366f1" stroke-width="${1.2 / k}" stroke-dasharray="${4 / k} ${3 / k}" pointer-events="none"/>`;
    }
    if (tool === "select" && selShapes.length && mode?.type !== "marquee") out += renderHandles(selShapes);
    overlayLayer.innerHTML = out;
    syncPanel();
  }

  // resize/reshape handles for the current selection
  function renderHandles(selShapes) {
    const k = view.k, r = 5 / k;
    const sq = (x, y, id, cur) =>
      `<rect data-handle="${id}" x="${x - r}" y="${y - r}" width="${2 * r}" height="${2 * r}" rx="${1.5 / k}"
        fill="#fff" stroke="#6366f1" stroke-width="${1.5 / k}" style="cursor:${cur}" pointer-events="all"/>`;
    const dot = (x, y, id) =>
      `<circle data-handle="${id}" cx="${x}" cy="${y}" r="${r}" fill="#fff" stroke="#6366f1" stroke-width="${1.5 / k}" style="cursor:move" pointer-events="all"/>`;

    const one = selShapes.length === 1 ? selShapes[0] : null;

    // single box: stretch along its own iso axes — stays on-lattice
    if (one && one.type === "box") {
      const c = boxCorners(one);
      const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
      const ha = mid(c.b10, c.t10), hb = mid(c.b01, c.t01), hc = one.c > 0 ? c.t00 : c.b00;
      return dot(ha[0], ha[1], "axis:a") + dot(hb[0], hb[1], "axis:b") + dot(hc[0], hc[1], "axis:c");
    }

    let out = "";
    // single line/poly/arrow: direct vertex reshaping
    if (one && isPath(one)) {
      out += one.pts.map((p, i) => dot(p[0], p[1], `vtx:${i}`)).join("");
      if (one.pts.length === 2) return out; // bbox handles add nothing for a segment
    }

    const b = bbox(selShapes.flatMap(shapePoints));
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    const HS = [
      ["nw", b.x1, b.y1, "nwse-resize"], ["ne", b.x2, b.y1, "nesw-resize"],
      ["se", b.x2, b.y2, "nwse-resize"], ["sw", b.x1, b.y2, "nesw-resize"],
      ["n", cx, b.y1, "ns-resize"], ["s", cx, b.y2, "ns-resize"],
      ["e", b.x2, cy, "ew-resize"], ["w", b.x1, cy, "ew-resize"],
    ];
    out += HS.map(([id, x, y, cur]) => sq(x, y, `bbox:${id}`, cur)).join("");
    return out;
  }

  const scaleInt = (v, f) => (v === 0 ? 0 : Math.max(1, Math.round(v * f)));

  // Live size readout for the active interaction, in lattice units — the
  // scale-drawing affordance. Boxes report their defining a×b×c (zeros kept:
  // 0×5 is a wall); segments report the iso decomposition of their delta.
  function modeDims() {
    if (!mode) return "";
    if (mode.type === "line" && mode.end) return fmtDims(isoDims(sub(mode.end, mode.start)));
    if ((mode.type === "poly" || mode.type === "arrow") && mode.cursor && mode.pts.length)
      return fmtDims(isoDims(sub(mode.cursor, mode.pts[mode.pts.length - 1])));
    if (mode.type === "box-foot") return `${Math.abs(mode.a)}×${Math.abs(mode.b)}`;
    if (mode.type === "box-height") return `${mode.a}×${mode.b}×${mode.c}`;
    if (mode.type === "axis" || mode.type === "vtx") {
      const sh = shapes.find(s => s.id === mode.id);
      if (!sh) return "";
      if (sh.type === "box") return `${sh.a}×${sh.b}×${sh.c}`;
      if (isPath(sh) && sh.pts.length > 1) {
        const o = sh.pts[mode.i - 1] || sh.pts[mode.i + 1];
        return fmtDims(isoDims(sub(sh.pts[mode.i], o)));
      }
      return "";
    }
    if (mode.type === "scale" && mode.orig.size === 1) {
      const sh = shapes.find(s => s.id === [...mode.orig.keys()][0]);
      if (sh?.type === "box") return `${sh.a}×${sh.b}×${sh.c}`;
    }
    return "";
  }

  function renderTemp() {
    const k = view.k;
    let out = "";
    if (cursorPt && ["line", "poly", "arrow", "box"].includes(tool)) {
      out += `<circle cx="${cursorPt[0]}" cy="${cursorPt[1]}" r="${3.5 / k}" fill="#6366f1" opacity="0.7"/>`;
    }
    if (mode) {
      const ghost = sh => renderShape(sh, { hit: false });
      const dots = pts => pts.map((p, i) =>
        `<circle cx="${p[0]}" cy="${p[1]}" r="${(i === 0 ? 5 : 3.5) / k}" fill="${i === 0 ? "#fff" : "#6366f1"}" stroke="#6366f1" stroke-width="${1.5 / k}"/>`).join("");
      if (mode.type === "line" && mode.end) {
        out += ghost(styled({ type: "line", pts: [mode.start, mode.end] }));
      } else if (mode.type === "poly") {
        const pts = mode.cursor ? [...mode.pts, mode.cursor] : mode.pts;
        if (pts.length > 1) out += ghost(styled({ type: "poly", pts, closed: false, fill: "transparent" }));
        out += dots(mode.pts);
      } else if (mode.type === "arrow") {
        const pts = mode.cursor ? [...mode.pts, mode.cursor] : mode.pts;
        if (pts.length > 1) out += ghost(styled({ type: "arrow", pts, heads: style.heads }));
        out += dots(mode.pts);
      } else if (mode.type === "box-foot" || mode.type === "box-height") {
        const n = normalizeBox(mode.p, mode.a || 0, mode.b || 0);
        out += ghost(styled({ type: "box", p: n.p, a: n.a, b: n.b, c: mode.c || 0 }));
      } else if (mode.type === "marquee" && mode.cur) {
        const r = marqueeRect(mode);
        out += `<rect x="${r.x1}" y="${r.y1}" width="${r.x2 - r.x1}" height="${r.y2 - r.y1}"
          fill="#6366f1" fill-opacity="0.08" stroke="#6366f1" stroke-width="${1 / k}" stroke-dasharray="${4 / k} ${3 / k}"/>`;
      }
      const dims = modeDims();
      if (dims && cursorPt) {
        out += `<text id="dimLabel" x="${cursorPt[0] + 12 / k}" y="${cursorPt[1] - 10 / k}"
          font-size="${12 / k}" font-weight="600" font-family="${FONT}" fill="#6366f1"
          paint-order="stroke" stroke="#fff" stroke-width="${3 / k}" stroke-linejoin="round"
          pointer-events="none">${dims}</text>`;
      }
    }
    tempLayer.innerHTML = out;
  }

  const marqueeRect = m => ({
    x1: Math.min(m.start[0], m.cur[0]), y1: Math.min(m.start[1], m.cur[1]),
    x2: Math.max(m.start[0], m.cur[0]), y2: Math.max(m.start[1], m.cur[1]),
  });

  function applyView() {
    viewport.setAttribute("transform", `translate(${view.tx} ${view.ty}) scale(${view.k})`);
    const fade = Math.max(0, Math.min(1, (view.k * S - 5) / 10));
    gridRect.setAttribute("opacity", fade);
    gridStrokes.setAttribute("stroke-width", 1 / view.k);
    document.getElementById("zoomReset").textContent = Math.round(view.k * 100) + "%";
    render(); renderTemp();
    scheduleSave();
  }

  // ---------- persistence ----------
  let saveTimer = null, dirty = false;
  const statusEl = document.getElementById("saveStatus");

  function scheduleSave() {
    dirty = true;
    statusEl.textContent = "Saving…";
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 700);
  }

  async function saveNow() {
    if (!dirty) return;
    dirty = false;
    try {
      const r = await fetch(`/api/d/${CFG.id}/data`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload(),
      });
      statusEl.textContent = r.ok ? "Saved" : "Save failed";
    } catch {
      statusEl.textContent = "Offline";
      dirty = true;
    }
  }
  const payload = () => JSON.stringify({ shapes, view });

  window.addEventListener("beforeunload", () => {
    if (dirty) navigator.sendBeacon && fetch(`/api/d/${CFG.id}/data`, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: payload(), keepalive: true,
    });
  });

  // ---------- history ----------
  let history = [JSON.stringify(shapes)], hIdx = 0;
  function commit() {
    history = history.slice(0, hIdx + 1);
    history.push(JSON.stringify(shapes));
    if (history.length > 200) history.shift();
    hIdx = history.length - 1;
    updateHistoryButtons();
    render(); scheduleSave();
  }
  function timeTravel(dir) {
    const n = hIdx + dir;
    if (n < 0 || n >= history.length) return;
    hIdx = n;
    shapes = JSON.parse(history[hIdx]);
    sel.clear();
    updateHistoryButtons();
    render(); scheduleSave();
  }
  function updateHistoryButtons() {
    document.getElementById("undoBtn").disabled = hIdx <= 0;
    document.getElementById("redoBtn").disabled = hIdx >= history.length - 1;
  }

  // ---------- tools & interaction ----------
  const uid = () => Math.random().toString(36).slice(2, 10);
  // current style, stamped onto every new shape (and onto ghost previews)
  const styled = props => ({
    stroke: style.stroke, fill: style.fill, sw: style.sw,
    dash: style.dash, round: style.round, op: style.op, ...props,
  });
  const hasArrow = () => shapes.some(s => sel.has(s.id) && s.type === "arrow");
  const HINTS = {
    select: "Drag empty space to box-select (Shift adds) · drag to move · arrows nudge · handles resize (Shift = uniform) · Ctrl+C/X/V · Del",
    pan: "Drag to pan · scroll to zoom",
    line: "Drag to draw a line · Alt disables snapping",
    poly: "Click to add points · click first point to close · Enter finishes · right-click removes last · Esc cancels",
    arrow: "Drag for a straight arrow · or click points for an elbow arrow, Enter finishes · right-click removes last",
    box: "Drag the footprint, release, move up for height, click to place · Esc cancels",
    text: "Click to place text",
  };

  function setTool(t) {
    cancelMode();
    tool = t;
    sel.clear();
    document.querySelectorAll("#toolbar [data-tool]").forEach(b =>
      b.classList.toggle("tool-active", b.dataset.tool === t));
    svg.style.cursor = t === "pan" ? "grab" : t === "select" ? "default" : t === "text" ? "text" : "crosshair";
    document.getElementById("hint").textContent = HINTS[t] || "";
    render(); renderTemp();
  }

  function cancelMode() {
    mode = null;
    renderTemp();
  }

  function finishPoly(close) {
    if (mode?.type !== "poly") return;
    const pts = mode.pts;
    if (pts.length >= 2) {
      shapes.push(styled({ id: uid(), type: "poly", pts, closed: !!close }));
      commit();
    }
    cancelMode();
  }

  function finishArrow() {
    if (mode?.type !== "arrow") return;
    if (mode.pts.length >= 2) {
      shapes.push(styled({ id: uid(), type: "arrow", pts: mode.pts, heads: style.heads }));
      commit();
    }
    cancelMode();
  }

  svg.addEventListener("pointerdown", e => {
    if (e.button === 1 || spaceDown || tool === "pan") {
      mode = { type: "pan", sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
      svg.setPointerCapture(e.pointerId);
      svg.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;
    const w = screenToWorld(e.clientX, e.clientY);
    const p = maybeSnap(w, e);
    svg.setPointerCapture(e.pointerId);

    if (mode?.type === "box-height") { // second click commits the box
      if (mode.a || mode.b) { // a or b may be 0: that's a vertical "wall" plane
        shapes.push(styled({ id: uid(), type: "box", p: mode.p, a: mode.a, b: mode.b, c: mode.c || 0 }));
        commit();
      }
      cancelMode();
      return;
    }

    if (tool === "line") {
      mode = { type: "line", start: p, end: null };
    } else if (tool === "poly") {
      if (!mode) mode = { type: "poly", pts: [p], cursor: null };
      else if (mode.pts.length > 2 && eq(p, mode.pts[0])) finishPoly(true);
      else if (!eq(p, mode.pts[mode.pts.length - 1])) { mode.pts.push(p); }
      renderTemp();
    } else if (tool === "arrow") {
      // first press starts it; a drag finishes a straight arrow on release,
      // a click without dragging keeps going for elbow arrows (Enter to finish)
      if (!mode) mode = { type: "arrow", pts: [p], cursor: null, down: p };
      else if (!eq(p, mode.pts[mode.pts.length - 1])) { mode.pts.push(p); mode.down = p; }
      else mode.down = p;
      renderTemp();
    } else if (tool === "box") {
      mode = { type: "box-foot", p, a: 0, b: 0, c: 0 };
    } else if (tool === "text") {
      e.preventDefault(); // keep the default focus change from stealing the input's focus
      openTextInput(p);
    } else if (tool === "select") {
      const hEl = e.target.closest("[data-handle]");
      if (hEl && sel.size) {
        const [kind, arg] = hEl.dataset.handle.split(":");
        const selShapes = shapes.filter(s => sel.has(s.id));
        const orig = new Map(selShapes.map(s => [s.id, JSON.stringify(s)]));
        const oneId = selShapes.length === 1 ? selShapes[0].id : null;
        if (kind === "vtx") mode = { type: "vtx", i: +arg, id: oneId, orig, moved: false };
        else if (kind === "axis") mode = { type: "axis", axis: arg, id: oneId, start: w, orig, moved: false };
        else mode = { type: "scale", h: arg, b: bbox(selShapes.flatMap(shapePoints)), orig, moved: false };
        return;
      }
      const g = e.target.closest("g[data-id]");
      if (g) {
        const id = g.dataset.id;
        if (e.shiftKey) sel.has(id) ? sel.delete(id) : sel.add(id);
        else if (!sel.has(id)) { sel.clear(); sel.add(id); }
        mode = {
          type: "move", start: w, moved: false,
          orig: new Map([...sel].map(id => [id, JSON.stringify(shapes.find(s => s.id === id))])),
        };
      } else {
        // empty canvas: rubber-band select (shift keeps the existing selection)
        if (!e.shiftKey) sel.clear();
        mode = { type: "marquee", start: w, cur: null, base: new Set(sel) };
      }
      renderOverlay();
    }
  });

  svg.addEventListener("pointermove", e => {
    const w = screenToWorld(e.clientX, e.clientY);
    const p = maybeSnap(w, e);
    cursorPt = p;

    if (mode?.type === "pan") {
      view.tx = mode.tx + e.clientX - mode.sx;
      view.ty = mode.ty + e.clientY - mode.sy;
      applyView();
      return;
    }
    if (mode?.type === "line") {
      mode.end = p;
    } else if (mode?.type === "poly") {
      mode.cursor = p;
    } else if (mode?.type === "arrow") {
      mode.cursor = p;
    } else if (mode?.type === "box-foot") {
      const dx = w[0] - mode.p[0], dy = w[1] - mode.p[1];
      mode.a = Math.round((dx / H - dy / V) / 2);
      mode.b = Math.round((-dx / H - dy / V) / 2);
    } else if (mode?.type === "box-height") {
      mode.c = Math.max(0, Math.round((mode.baseY - w[1]) / S));
    } else if (mode?.type === "marquee") {
      mode.cur = w; // raw, unsnapped: the band should track the pointer exactly
      const r = marqueeRect(mode);
      sel = new Set(mode.base);
      for (const sh of shapes) {
        const b = bbox(shapePoints(sh));
        const hits = b.x1 <= r.x2 && b.x2 >= r.x1 && b.y1 <= r.y2 && b.y2 >= r.y1;
        if (hits) sel.add(sh.id);
      }
      renderOverlay();
    } else if (mode?.type === "vtx") {
      const sh = shapes.find(s => s.id === mode.id);
      if (sh) { sh.pts[mode.i] = p; mode.moved = true; render(); }
    } else if (mode?.type === "axis") {
      const sh = shapes.find(s => s.id === mode.id);
      if (sh) {
        const o = JSON.parse(mode.orig.get(mode.id));
        const AX = { a: U, b: VX, c: W }[mode.axis];
        const d = [w[0] - mode.start[0], w[1] - mode.start[1]];
        let nv = Math.max(0, o[mode.axis] + Math.round((d[0] * AX[0] + d[1] * AX[1]) / (S * S)));
        if (mode.axis !== "c" && nv === 0 && (mode.axis === "a" ? sh.b : sh.a) === 0) nv = 1;
        if (sh[mode.axis] !== nv) { sh[mode.axis] = nv; mode.moved = true; render(); }
      }
    } else if (mode?.type === "scale") {
      const b0 = mode.b, hn = mode.h;
      const ax = hn.includes("e") ? b0.x1 : hn.includes("w") ? b0.x2 : null;
      const ay = hn.includes("s") ? b0.y1 : hn.includes("n") ? b0.y2 : null;
      const sx = hn.includes("e") ? b0.x2 : b0.x1, sy = hn.includes("s") ? b0.y2 : b0.y1;
      const clampF = f => Math.min(50, Math.max(0.02, f));
      let fx = ax === null ? 1 : clampF((w[0] - ax) / ((sx - ax) || 1e-9));
      let fy = ay === null ? 1 : clampF((w[1] - ay) / ((sy - ay) || 1e-9));
      if (e.shiftKey && ax !== null && ay !== null) fx = fy = Math.abs(fx) > Math.abs(fy) ? fx : fy;
      const ox = ax ?? b0.x1, oy = ay ?? b0.y1;
      const scalePt = pt => [ox + (pt[0] - ox) * fx, oy + (pt[1] - oy) * fy];
      const fEff = ax !== null && ay !== null ? (fx + fy) / 2 : (ay !== null ? fy : fx);
      for (const [id, json] of mode.orig) {
        const i = shapes.findIndex(s => s.id === id);
        if (i < 0) continue;
        const sh = JSON.parse(json);
        if (isPath(sh)) {
          sh.pts = sh.pts.map(pt => (e.altKey ? scalePt(pt) : snap(scalePt(pt))));
        } else if (sh.type === "text") {
          sh.p = scalePt(sh.p);
          sh.size = Math.min(300, Math.max(6, Math.round(sh.size * fEff * 10) / 10));
        } else if (sh.type === "box") {
          sh.p = e.altKey ? scalePt(sh.p) : snap(scalePt(sh.p));
          sh.a = scaleInt(sh.a, fx); sh.b = scaleInt(sh.b, fx); sh.c = scaleInt(sh.c, fy);
        }
        shapes[i] = sh;
      }
      mode.moved = true;
      render();
    } else if (mode?.type === "move") {
      let d = [w[0] - mode.start[0], w[1] - mode.start[1]];
      if (!e.altKey) d = snap(d);
      if (d[0] || d[1]) mode.moved = true;
      for (const [id, orig] of mode.orig) {
        const i = shapes.findIndex(s => s.id === id);
        if (i < 0) continue;
        const sh = JSON.parse(orig);
        translateShape(sh, d);
        shapes[i] = sh;
      }
      render();
    }
    renderTemp();
  });

  svg.addEventListener("pointerup", e => {
    if (mode?.type === "pan") {
      mode = null;
      svg.style.cursor = tool === "pan" ? "grab" : tool === "select" ? "default" : "crosshair";
      scheduleSave();
      return;
    }
    if (mode?.type === "line") {
      if (mode.end && !eq(mode.start, mode.end)) {
        shapes.push(styled({ id: uid(), type: "line", pts: [mode.start, mode.end] }));
        commit();
      }
      cancelMode();
    } else if (mode?.type === "arrow") {
      // released away from where the press landed → that was a drag: finish here
      const p = maybeSnap(screenToWorld(e.clientX, e.clientY), e);
      if (mode.down && !eq(p, mode.down)) {
        if (!eq(p, mode.pts[mode.pts.length - 1])) mode.pts.push(p);
        finishArrow();
      }
    } else if (mode?.type === "box-foot") {
      if (!mode.a && !mode.b) { cancelMode(); return; }
      const { p, a, b } = normalizeBox(mode.p, mode.a, mode.b);
      mode = { type: "box-height", p, a, b, c: 0, baseY: p[1] };
      renderTemp();
    } else if (mode?.type === "marquee") {
      mode = null;
      renderTemp(); renderOverlay();
    } else if (mode?.type === "move" || mode?.type === "vtx" || mode?.type === "axis" || mode?.type === "scale") {
      if (mode.moved) commit(); else renderOverlay();
      mode = null;
    }
  });

  svg.addEventListener("dblclick", e => {
    if (tool === "poly") { finishPoly(false); return; }
    if (tool === "arrow") { finishArrow(); return; }
    if (tool === "select") {
      const g = e.target.closest("g[data-id]");
      const sh = g && shapes.find(s => s.id === g.dataset.id);
      if (sh?.type === "text") openTextInput(sh.p, sh);
    }
  });

  svg.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (mode?.type === "poly" || mode?.type === "arrow") {
      mode.pts.pop();
      if (!mode.pts.length) cancelMode(); else renderTemp();
    }
  });

  svg.addEventListener("wheel", e => {
    e.preventDefault();
    const f = Math.exp(-e.deltaY * 0.0015);
    zoomAt(e.clientX, e.clientY, view.k * f);
  }, { passive: false });

  function zoomAt(cx, cy, k) {
    k = Math.max(0.1, Math.min(8, k));
    view.tx = cx - (cx - view.tx) * (k / view.k);
    view.ty = cy - (cy - view.ty) * (k / view.k);
    view.k = k;
    applyView();
  }

  // ---------- text input overlay ----------
  function openTextInput(p, existing) {
    const size = existing ? existing.size : 20;
    const input = document.createElement("input");
    input.value = existing ? existing.text : "";
    input.className = "absolute z-30 bg-transparent border border-indigo-300 rounded px-0.5 outline-none";
    input.style.left = (p[0] * view.k + view.tx - 3) + "px";
    input.style.top = (p[1] * view.k + view.ty - 3) + "px";
    input.style.font = `500 ${size * view.k}px ${FONT}`;
    input.style.color = existing ? existing.stroke : style.stroke;
    input.style.minWidth = "160px";
    document.body.appendChild(input);
    if (existing) existing.hidden = true;
    render();
    input.focus();
    setTimeout(() => input.focus(), 0);

    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      input.remove();
      if (existing) delete existing.hidden;
      const text = input.value.trim();
      if (ok && text) {
        if (existing) existing.text = text;
        else shapes.push(styled({ id: uid(), type: "text", p, text, size }));
        commit();
      } else if (existing) render();
      if (!existing) setTool("select");
    };
    input.addEventListener("keydown", ev => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  // hidden flag: skip rendering while its text is being edited
  const origRenderShape = renderShape;
  renderShape = (sh, o) => (sh.hidden ? "" : origRenderShape(sh, o));

  // ---------- selection ops ----------
  function deleteSelected() {
    if (!sel.size) return;
    shapes = shapes.filter(s => !sel.has(s.id));
    sel.clear();
    commit();
  }

  function duplicateSelected() {
    if (!sel.size) return;
    const clones = shapes.filter(s => sel.has(s.id)).map(s => {
      const c = JSON.parse(JSON.stringify(s));
      c.id = uid();
      translateShape(c, [H, V]); // one lattice step down-right
      return c;
    });
    shapes.push(...clones);
    sel = new Set(clones.map(c => c.id));
    commit();
  }

  // ---------- z-order (paint order = array order) ----------
  function reorder(how) {
    if (!sel.size) return;
    if (how === "front" || how === "back") {
      const picked = shapes.filter(s => sel.has(s.id));   // relative order preserved
      const rest = shapes.filter(s => !sel.has(s.id));
      shapes = how === "front" ? [...rest, ...picked] : [...picked, ...rest];
    } else if (how === "raise") {
      for (let i = shapes.length - 2; i >= 0; i--)
        if (sel.has(shapes[i].id) && !sel.has(shapes[i + 1].id))
          [shapes[i], shapes[i + 1]] = [shapes[i + 1], shapes[i]];
    } else if (how === "lower") {
      for (let i = 1; i < shapes.length; i++)
        if (sel.has(shapes[i].id) && !sel.has(shapes[i - 1].id))
          [shapes[i], shapes[i - 1]] = [shapes[i - 1], shapes[i]];
    }
    commit();
  }

  function applyStyleToSelection(patch) {
    let touched = false;
    for (const sh of shapes) {
      if (!sel.has(sh.id)) continue;
      touched = true;
      if (patch.stroke) sh.stroke = patch.stroke;
      if (patch.fill && !["line", "arrow", "text"].includes(sh.type)) sh.fill = patch.fill;
      if (patch.heads && sh.type === "arrow") sh.heads = patch.heads;
      if (patch.sw) sh.sw = patch.sw;
      if (patch.dash) sh.dash = patch.dash;
      if (patch.round !== undefined) sh.round = patch.round;
      if (patch.op !== undefined) sh.op = patch.op;
    }
    if (touched) commit();
  }

  // ---------- clipboard ----------
  let clipboardCache = null; // fallback when the system clipboard is unavailable

  function copySelection() {
    if (!sel.size) return false;
    const picked = shapes.filter(s => sel.has(s.id)).map(s => JSON.parse(JSON.stringify(s)));
    const payload = JSON.stringify({ zulfidraw: 1, shapes: picked });
    clipboardCache = payload;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(payload).catch(() => {});
    return true;
  }

  function addClones(clones) {
    shapes.push(...clones);
    if (tool !== "select") setTool("select"); // setTool clears sel, so select after
    sel = new Set(clones.map(c => c.id));
    commit();
  }

  function pasteShapes(arr) {
    if (!arr.length) return;
    const b = bbox(arr.flatMap(shapePoints));
    const center = snap([(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2]);
    let d = cursorPt ? [cursorPt[0] - center[0], cursorPt[1] - center[1]] : [H, V];
    if (!d[0] && !d[1]) d = [H, V]; // pasting exactly onto the source: nudge one step
    addClones(arr.map(s => {
      const c = JSON.parse(JSON.stringify(s));
      c.id = uid();
      delete c.hidden;
      translateShape(c, d);
      return c;
    }));
  }

  window.addEventListener("paste", e => {
    if (e.target instanceof Element && e.target.matches("input, textarea, [contenteditable]")) return;
    const txt = e.clipboardData?.getData("text/plain") || clipboardCache || "";
    if (!txt) return;
    e.preventDefault();
    try {
      const data = JSON.parse(txt);
      if (data && data.zulfidraw && Array.isArray(data.shapes)) { pasteShapes(data.shapes); return; }
    } catch { /* not ours — treat as plain text */ }
    const p0 = cursorPt || snap(screenToWorld(innerWidth / 2, innerHeight / 2));
    const clones = txt.split("\n").slice(0, 40).filter(l => l.trim()).map((l, i) =>
      styled({ id: uid(), type: "text", p: add(p0, [0, i * S]), text: l.trimEnd(), size: 20 }));
    if (clones.length) addClones(clones);
  });

  // ---------- keyboard ----------
  window.addEventListener("keydown", e => {
    if (e.target.matches("input, textarea, [contenteditable]")) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === "z") { e.preventDefault(); timeTravel(e.shiftKey ? 1 : -1); }
      if (k === "y") { e.preventDefault(); timeTravel(1); }
      if (k === "d") { e.preventDefault(); duplicateSelected(); }
      if (k === "a") { e.preventDefault(); sel = new Set(shapes.map(s => s.id)); renderOverlay(); }
      if (k === "c") copySelection();
      if (k === "x") { if (copySelection()) deleteSelected(); }
      // ctrl+v: handled by the native "paste" event above
      if (e.code === "BracketRight") { e.preventDefault(); reorder(e.shiftKey ? "front" : "raise"); }
      if (e.code === "BracketLeft") { e.preventDefault(); reorder(e.shiftKey ? "back" : "lower"); }
      return;
    }
    if (k === " ") { spaceDown = true; if (!mode) svg.style.cursor = "grab"; e.preventDefault(); return; }
    if (k === "escape") {
      if (mode?.orig) { // abort an in-flight move/reshape/scale: restore originals
        for (const [id, json] of mode.orig) {
          const i = shapes.findIndex(s => s.id === id);
          if (i >= 0) shapes[i] = JSON.parse(json);
        }
        render();
      }
      cancelMode(); sel.clear(); renderOverlay(); return;
    }
    if (k === "enter") { finishPoly(false); finishArrow(); return; }
    if (k === "delete" || k === "backspace") { deleteSelected(); return; }
    // arrows: nudge selection one lattice step (pure-horizontal step is 2H); Alt = 1px
    const ARROWS = { arrowup: [0, -S], arrowdown: [0, S], arrowleft: [-2 * H, 0], arrowright: [2 * H, 0] };
    if (ARROWS[k]) {
      if (!sel.size) return;
      e.preventDefault();
      const a = ARROWS[k];
      const d = e.altKey ? [Math.sign(a[0]), Math.sign(a[1])] : a;
      for (const sh of shapes) if (sel.has(sh.id)) translateShape(sh, d);
      commit();
      return;
    }
    const tools = {
      v: "select", h: "pan", l: "line", p: "poly", a: "arrow", b: "box", t: "text",
      1: "select", 2: "pan", 3: "line", 4: "poly", 5: "arrow", 6: "box", 7: "text",
    };
    if (tools[k]) setTool(tools[k]);
  });
  window.addEventListener("keyup", e => {
    if (e.key === " ") { spaceDown = false; if (!mode) setToolCursor(); }
  });
  function setToolCursor() {
    svg.style.cursor = tool === "pan" ? "grab" : tool === "select" ? "default" : tool === "text" ? "text" : "crosshair";
  }

  // ---------- ui wiring ----------
  document.querySelectorAll("#toolbar [data-tool]").forEach(b =>
    b.addEventListener("click", () => setTool(b.dataset.tool)));
  document.getElementById("undoBtn").addEventListener("click", () => timeTravel(-1));
  document.getElementById("redoBtn").addEventListener("click", () => timeTravel(1));
  document.getElementById("zoomIn").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, view.k * 1.2));
  document.getElementById("zoomOut").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, view.k / 1.2));
  document.getElementById("zoomReset").addEventListener("click", () => zoomAt(innerWidth / 2, innerHeight / 2, 1));

  const menuBtn = document.getElementById("menuBtn"), menuPanel = document.getElementById("menuPanel");
  menuBtn.addEventListener("click", () => {
    menuPanel.classList.toggle("hidden");
    if (!menuPanel.classList.contains("hidden")) {
      // flush pending edits first, so the version list reflects what's on screen
      Promise.resolve(saveNow()).then(() => document.body.dispatchEvent(new Event("menuOpened")));
    }
  });
  document.addEventListener("pointerdown", e => {
    if (!menuPanel.classList.contains("hidden") && !menuPanel.contains(e.target) && !menuBtn.contains(e.target))
      menuPanel.classList.add("hidden");
  });

  // style panel
  function markActive(el, btn) {
    el.querySelectorAll("button").forEach(b => b.classList.toggle("swatch-active", b === btn));
  }

  // A control group = buttons keyed to one style property. Each item is
  // {v, html, title, cls, css}; `parse` turns the data-v string back into the stored value.
  function buildGroup(elId, items, key, parse = String) {
    const el = document.getElementById(elId);
    el.innerHTML = items.map(it =>
      `<button data-v="${it.v}" title="${it.title}" class="${it.cls}" style="${it.css || ""}">${it.html || ""}</button>`).join("");
    el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
      const v = parse(b.dataset.v);
      style[key] = v;
      markActive(el, b);
      applyStyleToSelection({ [key]: v });
    }));
    return el;
  }

  const SWATCH = "swatch h-6 w-6 rounded-md border border-slate-300";
  const BTN = "grid h-7 w-9 place-items-center rounded-md border border-slate-300 text-xs text-slate-600 hover:bg-slate-100";
  const CHECKER = "background:linear-gradient(to top right,#fff 45%,#f43f5e 45%,#f43f5e 55%,#fff 55%)";

  const colorItems = colors => colors.map(c =>
    ({ v: c, title: c, cls: SWATCH, css: c === "transparent" ? CHECKER : `background:${c}` }));

  const strokeEl = buildGroup("strokeSwatches", colorItems(STROKES), "stroke");
  const fillEl = buildGroup("fillSwatches", colorItems(FILLS), "fill");
  const widthEl = buildGroup("widthBtns",
    WIDTHS.map(([l, w]) => ({ v: w, html: l, title: l + " stroke", cls: BTN })), "sw", parseFloat);

  const dashIcon = d => {
    const da = d === "dashed" ? "6 4" : d === "dotted" ? "0.1 4" : "";
    return `<svg width="24" height="8" viewBox="0 0 24 8"><path d="M2 4h20" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" ${da ? `stroke-dasharray="${da}"` : ""}/></svg>`;
  };
  const dashEl = buildGroup("dashBtns",
    DASHES.map(d => ({ v: d, html: dashIcon(d), title: d[0].toUpperCase() + d.slice(1), cls: BTN })), "dash");

  const edgeIcon = round => round
    ? `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 14V6a4 4 0 0 1 4-4h8"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 14V2h12"/></svg>`;
  const edgeEl = buildGroup("edgeBtns", [
    { v: "", html: edgeIcon(false), title: "Sharp corners", cls: BTN },
    { v: "1", html: edgeIcon(true), title: "Rounded corners", cls: BTN },
  ], "round", v => v === "1");

  const headIcon = both => `<svg width="26" height="10" viewBox="0 0 26 10" fill="none" stroke="currentColor"
      stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 5h20"/><path d="M19 2l4 3-4 3"/>${both ? '<path d="M7 2 3 5l4 3"/>' : ""}</svg>`;
  const headsEl = buildGroup("headBtns", [
    { v: "end", html: headIcon(false), title: "Arrowhead at the end", cls: BTN + " w-11" },
    { v: "both", html: headIcon(true), title: "Arrowheads at both ends", cls: BTN + " w-11" },
  ], "heads");
  const headsRow = document.getElementById("headsRow");

  // z-order buttons (not a style property — these act, they don't hold state)
  const Z_ACTIONS = [
    ["back", "Send to back — Ctrl+Shift+[", `<path d="M3 13h10v-2H3zM6 3h7v7H8V8H6z"/>`],
    ["lower", "Send backward — Ctrl+[", `<path d="M3 9h7v4H3zM6 3h7v7h-3V9H6z"/>`],
    ["raise", "Bring forward — Ctrl+]", `<path d="M6 6h7v7H6zM3 3h7v2H5v5H3z"/>`],
    ["front", "Bring to front — Ctrl+Shift+]", `<path d="M5 5h6v6H5zM3 3h1v1H3zM12 3h1v1h-1zM3 12h1v1H3zM12 12h1v1h-1z"/>`],
  ];
  const zEl = document.getElementById("zBtns");
  zEl.innerHTML = Z_ACTIONS.map(([a, title, path]) =>
    `<button data-z="${a}" title="${title}" class="${BTN}">
       <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">${path}</svg>
     </button>`).join("");
  zEl.querySelectorAll("button").forEach(b =>
    b.addEventListener("click", () => reorder(b.dataset.z)));

  const opEl = document.getElementById("opacity"), opValEl = document.getElementById("opVal");
  const setOpUI = v => { opEl.value = Math.round(v * 100); opValEl.textContent = Math.round(v * 100) + "%"; };
  opEl.addEventListener("input", () => {
    style.op = +opEl.value / 100;
    opValEl.textContent = opEl.value + "%";
    // live-preview on the selection; commit once on release
    for (const sh of shapes) if (sel.has(sh.id)) sh.op = style.op;
    render();
  });
  opEl.addEventListener("change", () => { if (sel.size) applyStyleToSelection({ op: style.op }); });

  // Reflect the panel state: the selection's style when it agrees, else the
  // current drawing style. Selecting a shape adopts its style for the panel.
  function syncPanel() {
    if (!uiReady) return;
    const selShapes = shapes.filter(s => sel.has(s.id));
    const agreed = key => {
      if (!selShapes.length) return undefined;
      const vals = selShapes.map(s => (key === "op" ? (s.op ?? 1) : key === "round" ? !!s.round : key === "dash" ? (s.dash || "solid") : s[key]));
      return vals.every(v => v === vals[0]) ? vals[0] : undefined;
    };
    for (const key of ["stroke", "fill", "sw", "dash", "round", "op"]) {
      const v = agreed(key);
      if (v !== undefined) style[key] = v;
    }
    const selHeads = selShapes.filter(s => s.type === "arrow").map(s => s.heads || "end");
    if (selHeads.length && selHeads.every(v => v === selHeads[0])) style.heads = selHeads[0];
    // the arrowhead control only means something for arrows
    headsRow.classList.toggle("hidden", !(tool === "arrow" || hasArrow()));
    markActive(headsEl, headsEl.querySelector(`[data-v="${style.heads}"]`));
    markActive(strokeEl, strokeEl.querySelector(`[data-v="${style.stroke}"]`));
    markActive(fillEl, fillEl.querySelector(`[data-v="${style.fill}"]`));
    markActive(widthEl, widthEl.querySelector(`[data-v="${style.sw}"]`));
    markActive(dashEl, dashEl.querySelector(`[data-v="${style.dash}"]`));
    markActive(edgeEl, edgeEl.querySelector(`[data-v="${style.round ? "1" : ""}"]`));
    setOpUI(style.op);
  }
  uiReady = true;
  syncPanel();

  // ---------- export ----------
  document.getElementById("exportBtn").addEventListener("click", () => {
    if (!shapes.length) return;
    const b = bbox(shapes.flatMap(shapePoints));
    const m = 40;
    const w = b.x2 - b.x1 + 2 * m, h2 = b.y2 - b.y1 + 2 * m;
    const body = shapes.map(sh => renderShape(sh, { hit: false })).join("");
    const out = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x1 - m} ${b.y1 - m} ${w} ${h2}" width="${w}" height="${h2}"><rect x="${b.x1 - m}" y="${b.y1 - m}" width="${w}" height="${h2}" fill="#fff"/>${body}</svg>`;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([out], { type: "image/svg+xml" }));
    a.download = (document.querySelector('#menuPanel input[name="name"]').value || "zulfidraw") + ".svg";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---------- go ----------
  setTool("select");
  updateHistoryButtons();
  applyView();
})();
