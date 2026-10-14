/**
 * Bed packing for plate layout. PrusaSlicer 2.9.6's CLI arrange segfaults on macOS
 * (`--merge` without `--dont-arrange`), so plates are packed here.
 *
 * Each item is packed by its XY bounding rectangle with MaxRects, best-short-side-fit.
 * The packed group is then centered on the bed.
 */

export interface PackItem {
  key: number;
  width: number;  // X extent, mm
  depth: number;  // Y extent, mm
}

export interface Placement {
  key: number;
  centerX: number;
  centerY: number;
  rotated: boolean; // turned 90° about Z to fit
}

export interface PackResult {
  placements: Placement[];
  unplaced: number[];
  usedArea: number; // fraction of bed area covered by item footprints
}

interface Rect { x: number; y: number; w: number; h: number }

export function packRectangles(
  items: PackItem[],
  bedWidth: number,
  bedDepth: number,
  spacing: number,
  allowRotation = true,
): PackResult {
  // Inflating items and bin by the spacing keeps that gap between items, with none forced at the edges
  const binW = bedWidth + spacing;
  const binH = bedDepth + spacing;
  let free: Rect[] = [{ x: 0, y: 0, w: binW, h: binH }];

  const order = [...items].sort((a, b) => b.width * b.depth - a.width * a.depth || a.key - b.key);
  const placed: { key: number; rect: Rect; rotated: boolean; w: number; h: number }[] = [];
  const unplaced: number[] = [];

  for (const item of order) {
    const options = [{ w: item.width, h: item.depth, rotated: false }];
    if (allowRotation && item.width !== item.depth) options.push({ w: item.depth, h: item.width, rotated: true });

    let best: { rect: Rect; rotated: boolean; w: number; h: number; short: number; long: number } | null = null;
    for (const opt of options) {
      const w = opt.w + spacing, h = opt.h + spacing;
      for (const f of free) {
        if (w > f.w + 1e-9 || h > f.h + 1e-9) continue;
        const short = Math.min(f.w - w, f.h - h);
        const long = Math.max(f.w - w, f.h - h);
        if (!best || short < best.short || (short === best.short && long < best.long)) {
          best = { rect: { x: f.x, y: f.y, w, h }, rotated: opt.rotated, w: opt.w, h: opt.h, short, long };
        }
      }
    }

    if (!best) {
      unplaced.push(item.key);
      continue;
    }
    placed.push({ key: item.key, rect: best.rect, rotated: best.rotated, w: best.w, h: best.h });
    free = splitFree(free, best.rect);
  }

  if (placed.length === 0) return { placements: [], unplaced, usedArea: 0 };

  // Center the packed group on the bed
  const minX = Math.min(...placed.map((p) => p.rect.x));
  const minY = Math.min(...placed.map((p) => p.rect.y));
  const maxX = Math.max(...placed.map((p) => p.rect.x + p.w));
  const maxY = Math.max(...placed.map((p) => p.rect.y + p.h));
  const shiftX = (bedWidth - (maxX - minX)) / 2 - minX;
  const shiftY = (bedDepth - (maxY - minY)) / 2 - minY;

  const placements = placed
    .map((p) => ({
      key: p.key,
      centerX: p.rect.x + p.w / 2 + shiftX,
      centerY: p.rect.y + p.h / 2 + shiftY,
      rotated: p.rotated,
    }))
    .sort((a, b) => a.key - b.key);

  const usedArea = placed.reduce((sum, p) => sum + p.w * p.h, 0) / (bedWidth * bedDepth);
  return { placements, unplaced, usedArea };
}

function splitFree(free: Rect[], used: Rect): Rect[] {
  const next: Rect[] = [];
  for (const f of free) {
    if (!overlaps(f, used)) {
      next.push(f);
      continue;
    }
    if (used.x > f.x) next.push({ x: f.x, y: f.y, w: used.x - f.x, h: f.h });
    if (used.x + used.w < f.x + f.w) next.push({ x: used.x + used.w, y: f.y, w: f.x + f.w - used.x - used.w, h: f.h });
    if (used.y > f.y) next.push({ x: f.x, y: f.y, w: f.w, h: used.y - f.y });
    if (used.y + used.h < f.y + f.h) next.push({ x: f.x, y: used.y + used.h, w: f.w, h: f.y + f.h - used.y - used.h });
  }
  return next.filter((a, i) => !next.some((b, j) => j !== i && contains(b, a) && (!contains(a, b) || j < i)));
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}
