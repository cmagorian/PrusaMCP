import type { Mesh, Vec3 } from "./types.js";
import { bounds, edgeFaces, faceAreaOf, faceNormalOf, toTriangles, weld } from "./mesh.js";

export type Side = "top" | "bottom" | "front" | "back" | "left" | "right";
export type Verdict = "slicer" | "enforce" | "review" | "block";

export const SIDE_DIRECTIONS: Record<Side, Vec3> = {
  top: { x: 0, y: 0, z: 1 },
  bottom: { x: 0, y: 0, z: -1 },
  front: { x: 0, y: -1, z: 0 },
  back: { x: 0, y: 1, z: 0 },
  left: { x: -1, y: 0, z: 0 },
  right: { x: 1, y: 0, z: 0 },
};

// A face belongs to a side when its normal is within 60° of the side's direction
const SIDE_COS = 0.5;

export interface PlanObject {
  index: number;    // position on the plate
  objectId?: number; // 3MF object id, when planning a 3MF
  name: string;
  mesh: Mesh;       // bed coordinates
}

export interface SupportPlanOptions {
  overhangAngle: number;   // degrees from horizontal; flatter faces need support
  minArea: number;         // mm² of projected area; smaller regions stay with the slicer
  shallowBand?: number;    // degrees below the overhang angle still treated as mild
  margin?: number;         // mm the volume box extends past the region
  bedTolerance?: number;   // mm above the lowest point still counted as bed contact
  cosmeticSides?: Side[];
  cosmeticBox?: { min: Vec3; max: Vec3 };
}

export interface OverhangRegion {
  id: number;
  objectIndex: number;
  objectId?: number;
  objectName: string;
  faceCount: number;
  area: number;           // mm², true surface area
  projectedArea: number;  // mm², footprint on the bed plane
  zMin: number;
  zMax: number;
  bbox: { min: Vec3; max: Vec3 };
  meanSlope: number;      // degrees from horizontal, area weighted
  landsOn: "bed" | "model" | "mixed";
  bedFraction: number;    // share of the region with nothing between it and the bed
  cosmetic: boolean;
  landsOnCosmetic: boolean;
  verdict: Verdict;
  reason: string;
  volumeBox: { min: Vec3; max: Vec3 }; // bed coordinates for an enforcer or blocker
  overlaps: number[];     // other region ids inside this region's volume box
}

export interface SupportPlan {
  options: Required<Omit<SupportPlanOptions, "cosmeticSides" | "cosmeticBox">> & Pick<SupportPlanOptions, "cosmeticSides" | "cosmeticBox">;
  regions: OverhangRegion[];
  totals: Record<Verdict, number>;
}

const DEFAULTS = { shallowBand: 10, margin: 2, bedTolerance: 0.05 };

export function planSupports(objects: PlanObject[], options: SupportPlanOptions): SupportPlan {
  const opts = { ...DEFAULTS, ...options };
  const regions: OverhangRegion[] = [];

  for (const obj of objects) {
    const found = findRegions(obj, opts);
    found.sort((a, b) =>
      b.projectedArea - a.projectedArea || a.zMin - b.zMin || a.bbox.min.x - b.bbox.min.x || a.bbox.min.y - b.bbox.min.y);
    for (const r of found) {
      r.id = regions.length + 1;
      regions.push(r);
    }
  }

  for (const r of regions) {
    r.overlaps = regions
      .filter((o) => o.id !== r.id && o.objectIndex === r.objectIndex && boxesOverlap(r.volumeBox, o.bbox))
      .map((o) => o.id);
  }

  const totals: Record<Verdict, number> = { slicer: 0, enforce: 0, review: 0, block: 0 };
  for (const r of regions) totals[r.verdict]++;

  return { options: opts, regions, totals };
}

// ─── Region detection ────────────────────────────────────────

function findRegions(obj: PlanObject, opts: SupportPlanOptions & typeof DEFAULTS): OverhangRegion[] {
  const mesh = weld(toTriangles(obj.mesh));
  const n = mesh.faces.length;
  if (n === 0) return [];

  const bedZ = bounds(mesh.vertices).min.z;
  const cosThreshold = Math.cos((opts.overhangAngle * Math.PI) / 180);

  const normals: Vec3[] = new Array(n);
  const areas: number[] = new Array(n);
  const isOverhang: boolean[] = new Array(n).fill(false);

  for (let f = 0; f < n; f++) {
    const [a, b, c] = mesh.faces[f];
    const v1 = mesh.vertices[a], v2 = mesh.vertices[b], v3 = mesh.vertices[c];
    normals[f] = faceNormalOf(v1, v2, v3);
    areas[f] = faceAreaOf(v1, v2, v3);

    const onBed = Math.max(v1.z, v2.z, v3.z) <= bedZ + opts.bedTolerance;
    isOverhang[f] = areas[f] > 0 && !onBed && normals[f].z < -cosThreshold;
  }

  // Union overhang faces that share an edge
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const faces of edgeFaces(mesh).values()) {
    const over = faces.filter((f) => isOverhang[f]);
    for (let i = 1; i < over.length; i++) {
      const ra = find(over[0]), rb = find(over[i]);
      if (ra !== rb) parent[ra] = rb;
    }
  }

  const clusters = new Map<number, number[]>();
  for (let f = 0; f < n; f++) {
    if (!isOverhang[f]) continue;
    const r = find(f);
    const list = clusters.get(r);
    if (list) list.push(f);
    else clusters.set(r, [f]);
  }

  const caster = new DownwardRaycaster(mesh);
  const cosmeticFace = (f: number, centroid: Vec3) => isCosmetic(normals[f], centroid, opts);

  const out: OverhangRegion[] = [];
  for (const faces of clusters.values()) {
    out.push(describeRegion(obj, mesh, faces, normals, areas, caster, cosmeticFace, opts));
  }
  return out;
}

function describeRegion(
  obj: PlanObject,
  mesh: Mesh,
  faces: number[],
  normals: Vec3[],
  areas: number[],
  caster: DownwardRaycaster,
  cosmeticFace: (f: number, centroid: Vec3) => boolean,
  opts: SupportPlanOptions & typeof DEFAULTS,
): OverhangRegion {
  let area = 0, projectedArea = 0, slopeSum = 0, cosmeticArea = 0;
  const pts: Vec3[] = [];

  for (const f of faces) {
    const [a, b, c] = mesh.faces[f];
    pts.push(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
    area += areas[f];
    projectedArea += areas[f] * Math.abs(normals[f].z);
    slopeSum += areas[f] * (Math.acos(Math.min(1, -normals[f].z)) * 180) / Math.PI;
    if (cosmeticFace(f, centroidOf(mesh, f))) cosmeticArea += areas[f];
  }
  const bbox = bounds(pts);
  const meanSlope = slopeSum / area;

  // Cast straight down from a sample of faces to see what the support would stand on
  const stride = Math.max(1, Math.floor(faces.length / 400));
  let sampledArea = 0, bedArea = 0, cosmeticLanding = 0;
  for (let i = 0; i < faces.length; i += stride) {
    const f = faces[i];
    const c = centroidOf(mesh, f);
    sampledArea += areas[f];
    const hit = caster.hitBelow(c, f);
    if (!hit) {
      bedArea += areas[f];
    } else if (cosmeticFace(hit.face, { x: c.x, y: c.y, z: hit.z })) {
      cosmeticLanding += areas[f];
    }
  }
  const bedFraction = sampledArea > 0 ? bedArea / sampledArea : 1;
  const landsOn = bedFraction >= 0.9 ? "bed" : bedFraction <= 0.1 ? "model" : "mixed";

  const cosmetic = cosmeticArea / area >= 0.5;
  const landsOnCosmetic = cosmeticLanding / Math.max(sampledArea, 1e-9) >= 0.25;

  const { verdict, reason } = classify({ projectedArea, meanSlope, landsOn, cosmetic, landsOnCosmetic }, opts);

  const m = opts.margin;
  return {
    id: 0,
    objectIndex: obj.index,
    objectId: obj.objectId,
    objectName: obj.name,
    faceCount: faces.length,
    area,
    projectedArea,
    zMin: bbox.min.z,
    zMax: bbox.max.z,
    bbox,
    meanSlope,
    landsOn,
    bedFraction,
    cosmetic,
    landsOnCosmetic,
    verdict,
    reason,
    volumeBox: {
      min: { x: bbox.min.x - m, y: bbox.min.y - m, z: Math.max(0, bbox.min.z - m) },
      max: { x: bbox.max.x + m, y: bbox.max.y + m, z: bbox.max.z + m },
    },
    overlaps: [],
  };
}

function classify(
  r: { projectedArea: number; meanSlope: number; landsOn: string; cosmetic: boolean; landsOnCosmetic: boolean },
  opts: SupportPlanOptions & typeof DEFAULTS,
): { verdict: Verdict; reason: string } {
  if (r.cosmetic) {
    return {
      verdict: "block",
      reason: "Faces marked cosmetic. A blocker keeps support marks off them, but the underside will sag. Reorienting may avoid the trade-off.",
    };
  }
  if (r.projectedArea < opts.minArea) {
    return { verdict: "slicer", reason: `Small (under ${opts.minArea} mm²). The slicer's overhang handling covers it.` };
  }
  if (r.meanSlope >= opts.overhangAngle - opts.shallowBand) {
    return { verdict: "slicer", reason: "Shallow. The slope sits close to the printable angle." };
  }
  if (r.landsOnCosmetic) {
    return {
      verdict: "review",
      reason: "Support would stand on cosmetic faces. Use buildplate-only support, or block this region.",
    };
  }
  if (r.landsOn === "bed") {
    return { verdict: "enforce", reason: "Large overhang with open air down to the bed. An enforcer guarantees support here." };
  }
  return {
    verdict: "review",
    reason: r.landsOn === "model"
      ? "Support would stand on the model and may scar it. Enforce if it must hold, or set buildplate-only."
      : "Support would stand partly on the model. Enforce if it must hold, or set buildplate-only.",
  };
}

function isCosmetic(normal: Vec3, centroid: Vec3, opts: SupportPlanOptions): boolean {
  for (const side of opts.cosmeticSides ?? []) {
    const d = SIDE_DIRECTIONS[side];
    if (normal.x * d.x + normal.y * d.y + normal.z * d.z >= SIDE_COS) return true;
  }
  const box = opts.cosmeticBox;
  if (box) {
    return centroid.x >= box.min.x && centroid.x <= box.max.x &&
      centroid.y >= box.min.y && centroid.y <= box.max.y &&
      centroid.z >= box.min.z && centroid.z <= box.max.z;
  }
  return false;
}

function centroidOf(mesh: Mesh, f: number): Vec3 {
  const [a, b, c] = mesh.faces[f];
  const v1 = mesh.vertices[a], v2 = mesh.vertices[b], v3 = mesh.vertices[c];
  return { x: (v1.x + v2.x + v3.x) / 3, y: (v1.y + v2.y + v3.y) / 3, z: (v1.z + v2.z + v3.z) / 3 };
}

function boxesOverlap(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x &&
    a.min.y <= b.max.y && a.max.y >= b.min.y &&
    a.min.z <= b.max.z && a.max.z >= b.min.z;
}

// ─── Downward raycasting ─────────────────────────────────────

/**
 * Finds the nearest face straight below a point. Faces are binned on an XY grid.
 */
export class DownwardRaycaster {
  private readonly cells = new Map<number, number[]>();
  private readonly minX: number;
  private readonly minY: number;
  private readonly cell: number;
  private readonly cols: number;

  constructor(private readonly mesh: Mesh) {
    const { min, max } = bounds(mesh.vertices);
    const extent = Math.max(max.x - min.x, max.y - min.y, 1e-6);
    const divisions = Math.min(256, Math.max(8, Math.round(Math.sqrt(mesh.faces.length) / 2)));
    this.cell = extent / divisions;
    this.minX = min.x;
    this.minY = min.y;
    this.cols = Math.floor((max.x - min.x) / this.cell) + 1;

    mesh.faces.forEach(([a, b, c], f) => {
      const v1 = mesh.vertices[a], v2 = mesh.vertices[b], v3 = mesh.vertices[c];
      const i0 = this.col(Math.min(v1.x, v2.x, v3.x)), i1 = this.col(Math.max(v1.x, v2.x, v3.x));
      const j0 = this.row(Math.min(v1.y, v2.y, v3.y)), j1 = this.row(Math.max(v1.y, v2.y, v3.y));
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = j * this.cols + i;
          const list = this.cells.get(key);
          if (list) list.push(f);
          else this.cells.set(key, [f]);
        }
      }
    });
  }

  private col(x: number): number { return Math.floor((x - this.minX) / this.cell); }
  private row(y: number): number { return Math.floor((y - this.minY) / this.cell); }

  hitBelow(p: Vec3, ignoreFace: number): { face: number; z: number } | null {
    const candidates = this.cells.get(this.row(p.y) * this.cols + this.col(p.x));
    if (!candidates) return null;

    let best: { face: number; z: number } | null = null;
    for (const f of candidates) {
      if (f === ignoreFace) continue;
      const [a, b, c] = this.mesh.faces[f];
      const z = zAt(this.mesh.vertices[a], this.mesh.vertices[b], this.mesh.vertices[c], p.x, p.y);
      if (z === null || z >= p.z - 1e-3) continue;
      if (!best || z > best.z) best = { face: f, z };
    }
    return best;
  }
}

/**
 * Height of the triangle at (x, y), or null when the point falls outside its XY footprint.
 */
function zAt(v1: Vec3, v2: Vec3, v3: Vec3, x: number, y: number): number | null {
  const d = (v2.y - v3.y) * (v1.x - v3.x) + (v3.x - v2.x) * (v1.y - v3.y);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((v2.y - v3.y) * (x - v3.x) + (v3.x - v2.x) * (y - v3.y)) / d;
  const l2 = ((v3.y - v1.y) * (x - v3.x) + (v1.x - v3.x) * (y - v3.y)) / d;
  const l3 = 1 - l1 - l2;
  const eps = -1e-9;
  if (l1 < eps || l2 < eps || l3 < eps) return null;
  return l1 * v1.z + l2 * v2.z + l3 * v3.z;
}
