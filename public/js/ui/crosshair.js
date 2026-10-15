// ---------------------------------------------------------------------------
// crosshair.js — draws a CS2-style crosshair from the same kind of settings
// CS2 uses (size, gap, thickness, outline, dot, T-style, colour, alpha).
// Sizes scale with screen height like CS2 (values are "CS units").
// ---------------------------------------------------------------------------

export function drawCrosshair(canvas, c, gapExtra = 0) {
  const scale = window.innerHeight / 480; // CS crosshair values are defined at 480p
  const thick = Math.max(1, Math.round(Math.max(0.5, c.thickness) * scale * 0.5) * 2 / 2);
  const len = Math.max(0, Math.round(c.size * scale));
  const gap = Math.round((c.gap + 4) * scale * 0.5 + gapExtra); // CS2 gap -1 ~ small gap
  const out = c.outline ? Math.max(1, Math.round(c.outlineThickness)) : 0;
  const size = (len + gap + out + 4) * 2 + thick;
  const dpr = 1; // crisp: draw at CSS pixels
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = size + 'px';
  canvas.style.height = size + 'px';
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, size, size);
  const cx = Math.floor(size / 2), cy = Math.floor(size / 2);
  const half = Math.floor(thick / 2);
  const rects = [];
  if (len > 0) {
    rects.push([cx + gap + half + 1, cy - half, len, thick]); // right
    rects.push([cx - gap - half - len, cy - half, len, thick]); // left
    rects.push([cx - half, cy + gap + half + 1, thick, len]); // bottom
    if (!c.tStyle) rects.push([cx - half, cy - gap - half - len, thick, len]); // top
  }
  if (c.dot) rects.push([cx - half, cy - half, thick, thick]);
  if (out) {
    g.fillStyle = `rgba(0,0,0,${(c.alpha / 255) * 0.9})`;
    for (const [x, y, w, h] of rects) g.fillRect(x - out, y - out, w + out * 2, h + out * 2);
  }
  g.fillStyle = hexToRgba(c.color, c.alpha / 255);
  for (const [x, y, w, h] of rects) g.fillRect(x, y, w, h);
}

function hexToRgba(hex, a) {
  const v = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
