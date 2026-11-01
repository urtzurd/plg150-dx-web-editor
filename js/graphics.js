// SVG rendering: DX7 algorithm diagrams and envelope graphs.
(function () {
  'use strict';

  // The 32 DX7 algorithms. mods: [modulator, carrier-or-modulator target] pairs,
  // carriers: operators summed to the output, fb: [from, to] feedback loop.
  const ALGORITHMS = [
    { mods: [[2, 1], [4, 3], [5, 4], [6, 5]], carriers: [1, 3], fb: [6, 6] },
    { mods: [[2, 1], [4, 3], [5, 4], [6, 5]], carriers: [1, 3], fb: [2, 2] },
    { mods: [[2, 1], [3, 2], [5, 4], [6, 5]], carriers: [1, 4], fb: [6, 6] },
    { mods: [[2, 1], [3, 2], [5, 4], [6, 5]], carriers: [1, 4], fb: [4, 6] },
    { mods: [[2, 1], [4, 3], [6, 5]], carriers: [1, 3, 5], fb: [6, 6] },
    { mods: [[2, 1], [4, 3], [6, 5]], carriers: [1, 3, 5], fb: [5, 6] },
    { mods: [[2, 1], [4, 3], [5, 3], [6, 5]], carriers: [1, 3], fb: [6, 6] },
    { mods: [[2, 1], [4, 3], [5, 3], [6, 5]], carriers: [1, 3], fb: [4, 4] },
    { mods: [[2, 1], [4, 3], [5, 3], [6, 5]], carriers: [1, 3], fb: [2, 2] },
    { mods: [[2, 1], [3, 2], [5, 4], [6, 4]], carriers: [1, 4], fb: [3, 3] },
    { mods: [[2, 1], [3, 2], [5, 4], [6, 4]], carriers: [1, 4], fb: [6, 6] },
    { mods: [[2, 1], [4, 3], [5, 3], [6, 3]], carriers: [1, 3], fb: [2, 2] },
    { mods: [[2, 1], [4, 3], [5, 3], [6, 3]], carriers: [1, 3], fb: [6, 6] },
    { mods: [[2, 1], [4, 3], [5, 4], [6, 4]], carriers: [1, 3], fb: [6, 6] },
    { mods: [[2, 1], [4, 3], [5, 4], [6, 4]], carriers: [1, 3], fb: [2, 2] },
    { mods: [[2, 1], [3, 1], [5, 1], [4, 3], [6, 5]], carriers: [1], fb: [6, 6] },
    { mods: [[2, 1], [3, 1], [5, 1], [4, 3], [6, 5]], carriers: [1], fb: [2, 2] },
    { mods: [[2, 1], [3, 1], [4, 1], [5, 4], [6, 5]], carriers: [1], fb: [3, 3] },
    { mods: [[2, 1], [3, 2], [6, 4], [6, 5]], carriers: [1, 4, 5], fb: [6, 6] },
    { mods: [[3, 1], [3, 2], [5, 4], [6, 4]], carriers: [1, 2, 4], fb: [3, 3] },
    { mods: [[3, 1], [3, 2], [6, 4], [6, 5]], carriers: [1, 2, 4, 5], fb: [3, 3] },
    { mods: [[2, 1], [6, 3], [6, 4], [6, 5]], carriers: [1, 3, 4, 5], fb: [6, 6] },
    { mods: [[3, 2], [6, 4], [6, 5]], carriers: [1, 2, 4, 5], fb: [6, 6] },
    { mods: [[6, 3], [6, 4], [6, 5]], carriers: [1, 2, 3, 4, 5], fb: [6, 6] },
    { mods: [[6, 4], [6, 5]], carriers: [1, 2, 3, 4, 5], fb: [6, 6] },
    { mods: [[3, 2], [5, 4], [6, 4]], carriers: [1, 2, 4], fb: [6, 6] },
    { mods: [[3, 2], [5, 4], [6, 4]], carriers: [1, 2, 4], fb: [3, 3] },
    { mods: [[2, 1], [4, 3], [5, 4]], carriers: [1, 3, 6], fb: [5, 5] },
    { mods: [[4, 3], [6, 5]], carriers: [1, 2, 3, 5], fb: [6, 6] },
    { mods: [[4, 3], [5, 4]], carriers: [1, 2, 3, 6], fb: [5, 5] },
    { mods: [[6, 5]], carriers: [1, 2, 3, 4, 5], fb: [6, 6] },
    { mods: [], carriers: [1, 2, 3, 4, 5, 6], fb: [6, 6] },
  ];

  // Places each operator on a grid: carriers on the bottom row, modulators
  // stacked above the operator they modulate.
  function layout(alg) {
    const pos = {};
    let col = 0;
    const place = (op, row) => {
      if (pos[op]) return;
      pos[op] = { col, row };
      const mods = alg.mods.filter(([, t]) => t === op).map(([m]) => m).sort((a, b) => a - b);
      mods.forEach((m, i) => {
        if (pos[m]) return;
        if (i > 0) col++;
        place(m, row + 1);
      });
    };
    alg.carriers.forEach((c, i) => { if (i > 0) col++; place(c, 0); });
    return { pos, cols: col + 1, rows: 1 + Math.max(...Object.values(pos).map(p => p.row)) };
  }

  const MAX_COLS = Math.max(...ALGORITHMS.map(a => layout(a).cols));
  const MAX_ROWS = Math.max(...ALGORITHMS.map(a => layout(a).rows));

  const svgNS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => {
    const e = document.createElementNS(svgNS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  };

  // opEnabled(op) -> bool; onToggle(op) is called when an operator box is clicked.
  function drawAlgorithm(svg, algIndex, opEnabled, onToggle) {
    const alg = ALGORITHMS[algIndex];
    const { pos, cols, rows } = layout(alg);
    const B = 30, GX = 16, GY = 20, PAD = 16;
    const width = c => c * B + (c - 1) * GX + PAD * 2 + 14;
    const height = r => r * B + (r - 1) * GY + PAD * 2 + 16;
    const W = width(cols), H = height(rows);
    // Every algorithm uses the same canvas, sized for the widest and the
    // tallest one, so operator boxes are drawn at one constant scale; the
    // diagram is centred on it by shifting the viewBox origin.
    const maxW = width(MAX_COLS), maxH = height(MAX_ROWS);
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `${-(maxW - W) / 2} ${-(maxH - H) / 2} ${maxW} ${maxH}`);
    const xy = op => {
      const p = pos[op];
      return { x: PAD + p.col * (B + GX), y: H - PAD - 16 - B - p.row * (B + GY) };
    };
    const lines = el('g', { class: 'alg-lines' });
    svg.appendChild(lines);
    for (const [m, t] of alg.mods) {
      const a = xy(m), b = xy(t);
      lines.appendChild(el('path', {
        d: `M${a.x + B / 2} ${a.y + B} L${a.x + B / 2} ${a.y + B + GY / 2} L${b.x + B / 2} ${a.y + B + GY / 2} L${b.x + B / 2} ${b.y}`,
      }));
    }
    // output bus
    const busY = H - PAD;
    const cx = alg.carriers.map(c => xy(c).x + B / 2);
    lines.appendChild(el('path', { d: `M${Math.min(...cx)} ${busY} L${Math.max(...cx)} ${busY}` }));
    alg.carriers.forEach((c, i) => {
      const p = xy(c);
      lines.appendChild(el('path', { d: `M${cx[i]} ${p.y + B} L${cx[i]} ${busY}` }));
    });
    // feedback loop: from the output of fb[0] back into fb[1]
    const [ff, ft] = alg.fb;
    const pf = xy(ff), pt = xy(ft);
    const rx = Math.max(pf.x, pt.x) + B + 7;
    lines.appendChild(el('path', {
      class: 'alg-fb',
      d: `M${pf.x + B / 2} ${pf.y + B} L${pf.x + B / 2} ${pf.y + B + 6} L${rx} ${pf.y + B + 6} L${rx} ${pt.y - 6} L${pt.x + B / 2} ${pt.y - 6} L${pt.x + B / 2} ${pt.y}`,
    }));

    for (let op = 1; op <= 6; op++) {
      const p = xy(op);
      const g = el('g', {
        class: 'alg-op' + (alg.carriers.includes(op) ? ' carrier' : '') + (opEnabled(op) ? '' : ' off'),
        'data-op': op,
      });
      g.appendChild(el('rect', { x: p.x, y: p.y, width: B, height: B, rx: 3 }));
      g.appendChild(el('text', { x: p.x + B / 2, y: p.y + B / 2 + 5, 'text-anchor': 'middle' }, op));
      g.appendChild(el('title', {}, `OP${op}${alg.carriers.includes(op) ? ' (carrier)' : ' (modulator)'} — click to toggle on/off`));
      g.addEventListener('click', () => onToggle(op));
      svg.appendChild(g);
    }
  }

  // Envelope graph. Rate 99 is fastest; DX7 attack/decay time grows roughly
  // exponentially as the rate is lowered. The curve is a visual guide only.
  function segTime(rate, from, to) {
    const dist = Math.abs(to - from) / 99;
    if (dist === 0) return 0.05;
    return (0.06 + dist) * Math.pow(2, (99 - rate) / 10.5) * 0.04;
  }

  function drawEnvelope(svg, rates, levels, opts = {}) {
    const W = 220, H = 70, P = 4;
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    const start = levels[3];
    const t = [
      segTime(rates[0], start, levels[0]),
      segTime(rates[1], levels[0], levels[1]),
      segTime(rates[2], levels[1], levels[2]),
    ];
    const sustain = 0.35;
    const tRel = segTime(rates[3], levels[2], levels[3]);
    const cap = 4;
    const ts = t.map(x => Math.min(x, cap));
    const total = ts[0] + ts[1] + ts[2] + sustain + Math.min(tRel, cap);
    const sx = (W - 2 * P) / total;
    const y = l => opts.bipolar
      ? H / 2 - ((l - 50) / 50) * (H / 2 - P)
      : H - P - (l / 99) * (H - 2 * P);
    let x = P;
    const pts = [[x, y(start)]];
    for (let i = 0; i < 3; i++) { x += ts[i] * sx; pts.push([x, y(levels[i])]); }
    x += sustain * sx; pts.push([x, y(levels[2])]);
    const keyOff = x;
    x += Math.min(tRel, cap) * sx; pts.push([x, y(levels[3])]);

    if (opts.bipolar) svg.appendChild(el('line', { x1: 0, x2: W, y1: H / 2, y2: H / 2, class: 'eg-axis' }));
    svg.appendChild(el('line', { x1: keyOff, x2: keyOff, y1: 0, y2: H, class: 'eg-keyoff' }));
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    if (!opts.bipolar) {
      svg.appendChild(el('path', { d: `${d} L${x.toFixed(1)} ${H - P} L${P} ${H - P} Z`, class: 'eg-fill' }));
    }
    svg.appendChild(el('path', { d, class: 'eg-line' }));
  }

  // Connection lines between the operator panels, drawn into an SVG that
  // covers the panels' grid container. panels[op] is the panel element.
  function drawOpConnections(svg, container, algIndex, panels, opEnabled) {
    svg.innerHTML = '';
    // Collapse the SVG before measuring: it is inside the container, so at its
    // previous size it would keep the container (and the page) as tall as the
    // last algorithm with more rows.
    svg.setAttribute('width', 0);
    svg.setAttribute('height', 0);
    const box = container.getBoundingClientRect();
    if (!box.width) return;                       // tab hidden; redrawn on resize
    svg.setAttribute('width', container.scrollWidth);
    svg.setAttribute('height', container.scrollHeight);
    const alg = ALGORITHMS[algIndex];
    const r = {};
    for (let op = 1; op <= 6; op++) {
      const b = panels[op].getBoundingClientRect();
      const x = b.left - box.left + container.scrollLeft, y = b.top - box.top;
      r[op] = { x, y, w: b.width, h: b.height, cx: x + b.width / 2, bottom: y + b.height };
    }
    const style = getComputedStyle(container);
    const rowGap = parseFloat(style.rowGap) || 24;
    const path = (d, cls) => svg.appendChild(el('path', { d, class: cls }));

    for (const [m, t] of alg.mods) {
      const a = r[m], b = r[t];
      const midY = a.bottom + rowGap / 2;
      path(`M${a.cx} ${a.bottom} L${a.cx} ${midY} L${b.cx} ${midY} L${b.cx} ${b.y}`,
        'op-link' + (opEnabled(m) ? '' : ' off'));
    }

    // carriers into the output bus under the bottom row
    const bottom = Math.max(...alg.carriers.map(c => r[c].bottom));
    const busY = bottom + 14;
    const xs = alg.carriers.map(c => r[c].cx);
    for (const c of alg.carriers) {
      path(`M${r[c].cx} ${r[c].bottom} L${r[c].cx} ${busY}`, 'op-out' + (opEnabled(c) ? '' : ' off'));
    }
    const busEnd = Math.max(...xs) + 26;
    path(`M${Math.min(...xs)} ${busY} L${busEnd} ${busY}`, 'op-out');
    path(`M${busEnd - 6} ${busY - 4} L${busEnd} ${busY} L${busEnd - 6} ${busY + 4}`, 'op-out');
    svg.appendChild(el('text', { x: busEnd + 5, y: busY + 4, class: 'op-out-label' }, 'OUT'));

    // feedback: leaves fb[0] at the bottom, runs up the right-hand gap and
    // enters fb[1] from the top, off-centre so it doesn't hide the other links
    const [ff, ft] = alg.fb;
    const a = r[ff], b = r[ft];
    const sx = a.x + a.w * 0.75, ex = b.x + b.w * 0.75;
    const rx = Math.max(a.x + a.w, b.x + b.w) + 6;
    path(`M${sx} ${a.bottom} L${sx} ${a.bottom + 6} L${rx} ${a.bottom + 6} L${rx} ${b.y - 6} L${ex} ${b.y - 6} L${ex} ${b.y}`,
      'op-fb');
  }

  // Seven-segment LED display drawn as SVG polygons, so no special font is
  // needed. Segments a-g in the usual order: a top, b upper right, c lower
  // right, d bottom, e lower left, f upper left, g middle. Unlit segments are
  // drawn faintly, as on a real LED. dot lights the decimal point after the
  // last digit (the DX Simulator's "edited" dot).
  const SEGMENTS = {
    0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
    5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg', '-': 'g', ' ': '',
  };
  const DW = 20, DH = 36, T = 3.6, PITCH = 27;   // digit size, segment thickness, digit spacing

  function segmentPoints(seg) {
    const hx = (y, x1 = 2, x2 = DW - 2) =>        // horizontal bar centred on y
      [[x1 + T / 2 + 0.6, y], [x1 + T + 0.6, y - T / 2], [x2 - T - 0.6, y - T / 2],
        [x2 - T / 2 - 0.6, y], [x2 - T - 0.6, y + T / 2], [x1 + T + 0.6, y + T / 2]];
    const vx = (x, y1, y2) =>                      // vertical bar centred on x
      [[x, y1 + T / 2 + 0.6], [x + T / 2, y1 + T + 0.6], [x + T / 2, y2 - T - 0.6],
        [x, y2 - T / 2 - 0.6], [x - T / 2, y2 - T - 0.6], [x - T / 2, y1 + T + 0.6]];
    const mid = DH / 2;
    const pts = {
      a: hx(2), g: hx(mid), d: hx(DH - 2),
      f: vx(2, 2, mid), b: vx(DW - 2, 2, mid),
      e: vx(2, mid, DH - 2), c: vx(DW - 2, mid, DH - 2),
    }[seg];
    return pts.map(p => p.map(n => n.toFixed(2)).join(',')).join(' ');
  }

  function drawSevenSegment(svg, text, dot) {
    const n = text.length;
    svg.innerHTML = '';
    // extra room on the left for the italic slant and on the right for the dot
    const vbW = (n - 1) * PITCH + DW + 10;
    svg.setAttribute('viewBox', `-3 -1 ${vbW} ${DH + 2}`);
    svg.style.aspectRatio = `${vbW} / ${DH + 2}`;
    const g = el('g', { transform: 'skewX(-6)', 'transform-origin': `0 ${DH}` });
    [...text].forEach((ch, i) => {
      const lit = SEGMENTS[ch] ?? '';
      const digit = el('g', { transform: `translate(${i * PITCH} 0)` });
      for (const seg of 'abcdefg') {
        digit.appendChild(el('polygon', { points: segmentPoints(seg), class: lit.includes(seg) ? 'seg on' : 'seg' }));
      }
      g.appendChild(digit);
    });
    g.appendChild(el('circle', { cx: (n - 1) * PITCH + DW + 3, cy: DH - 2, r: 2.2, class: dot ? 'seg on' : 'seg' }));
    svg.appendChild(g);
  }

  window.Graphics = { ALGORITHMS, layout, drawAlgorithm, drawEnvelope, drawOpConnections, drawSevenSegment };
})();
