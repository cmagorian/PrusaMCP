import type { Face, Mesh, Triangle, Vec3 } from "./types.js";

// ─── Construction ────────────────────────────────────────────

/**
 * Build an indexed mesh from a triangle soup, merging vertices closer than `tolerance` mm.
 */
export function weld(triangles: Triangle[], tolerance = 1e-4): Mesh {
  const index = new Map<string, number>();
  const vertices: Vec3[] = [];
  const faces: Face[] = new Array(triangles.length);
  const scale = 1 / tolerance;

  const idOf = (v: Vec3): number => {
    const key = `${Math.round(v.x * scale)},${Math.round(v.y * scale)},${Math.round(v.z * scale)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = vertices.length;
      vertices.push({ x: v.x, y: v.y, z: v.z });
      index.set(key, id);
    }
    return id;
  };

  for (let i = 0; i < triangles.length; i++) {
    const t = triangles[i];
    faces[i] = [idOf(t.v1), idOf(t.v2), idOf(t.v3)];
  }
  return { vertices, faces };
}

export function toTriangles(mesh: Mesh): Triangle[] {
  return mesh.faces.map(([a, b, c]) => {
    const v1 = mesh.vertices[a], v2 = mesh.vertices[b], v3 = mesh.vertices[c];
    return { normal: faceNormalOf(v1, v2, v3), v1, v2, v3 };
  });
}

export function cloneMesh(mesh: Mesh): Mesh {
  return {
    vertices: mesh.vertices.map((v) => ({ ...v })),
    faces: mesh.faces.map((f) => [...f] as Face),
    faceAttrs: mesh.faceAttrs ? [...mesh.faceAttrs] : undefined,
  };
}

/**
 * Concatenate meshes into one, offsetting face indices.
 */
export function mergeMeshes(meshes: Mesh[]): Mesh {
  const out: Mesh = { vertices: [], faces: [] };
  const hasAttrs = meshes.some((m) => m.faceAttrs);
  if (hasAttrs) out.faceAttrs = [];

  for (const m of meshes) {
    const base = out.vertices.length;
    out.vertices.push(...m.vertices);
    for (let i = 0; i < m.faces.length; i++) {
      const [a, b, c] = m.faces[i];
      out.faces.push([a + base, b + base, c + base]);
      if (hasAttrs) out.faceAttrs!.push(m.faceAttrs?.[i]);
    }
  }
  return out;
}

/**
 * Closed axis-aligned box with outward-facing triangles.
 */
export function boxMesh(min: Vec3, max: Vec3): Mesh {
  const vertices: Vec3[] = [
    { x: min.x, y: min.y, z: min.z }, { x: max.x, y: min.y, z: min.z },
    { x: max.x, y: max.y, z: min.z }, { x: min.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z }, { x: max.x, y: min.y, z: max.z },
    { x: max.x, y: max.y, z: max.z }, { x: min.x, y: max.y, z: max.z },
  ];
  const faces: Face[] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  return { vertices, faces };
}

// ─── Geometry ────────────────────────────────────────────────

export function faceNormalOf(v1: Vec3, v2: Vec3, v3: Vec3): Vec3 {
  const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
  const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return { x: 0, y: 0, z: 0 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

export function faceAreaOf(v1: Vec3, v2: Vec3, v3: Vec3): number {
  const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
  const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

export function faceNormal(mesh: Mesh, f: number): Vec3 {
  const [a, b, c] = mesh.faces[f];
  return faceNormalOf(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
}

export function faceArea(mesh: Mesh, f: number): number {
  const [a, b, c] = mesh.faces[f];
  return faceAreaOf(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]);
}

export function faceCentroid(mesh: Mesh, f: number): Vec3 {
  const [a, b, c] = mesh.faces[f];
  const v1 = mesh.vertices[a], v2 = mesh.vertices[b], v3 = mesh.vertices[c];
  return { x: (v1.x + v2.x + v3.x) / 3, y: (v1.y + v2.y + v3.y) / 3, z: (v1.z + v2.z + v3.z) / 3 };
}

export function bounds(vertices: Vec3[]): { min: Vec3; max: Vec3 } {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const v of vertices) {
    if (v.x < min.x) min.x = v.x;
    if (v.y < min.y) min.y = v.y;
    if (v.z < min.z) min.z = v.z;
    if (v.x > max.x) max.x = v.x;
    if (v.y > max.y) max.y = v.y;
    if (v.z > max.z) max.z = v.z;
  }
  return { min, max };
}

/**
 * Signed volume of a closed mesh. Positive when faces wind outward.
 */
export function signedVolume(mesh: Mesh, faces: Iterable<number> = mesh.faces.keys()): number {
  let vol = 0;
  for (const f of faces) {
    const [a, b, c] = mesh.faces[f];
    const v1 = mesh.vertices[a], v2 = mesh.vertices[b], v3 = mesh.vertices[c];
    vol += v1.x * (v2.y * v3.z - v2.z * v3.y)
      + v1.y * (v2.z * v3.x - v2.x * v3.z)
      + v1.z * (v2.x * v3.y - v2.y * v3.x);
  }
  return vol / 6;
}

// ─── Topology ────────────────────────────────────────────────

export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}_${b}` : `${b}_${a}`;
}

/**
 * Map each undirected edge to the faces that use it.
 */
export function edgeFaces(mesh: Mesh): Map<string, number[]> {
  const map = new Map<string, number[]>();
  mesh.faces.forEach(([a, b, c], f) => {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(p, q);
      const list = map.get(key);
      if (list) list.push(f);
      else map.set(key, [f]);
    }
  });
  return map;
}

export interface EdgeStats {
  openEdges: number;        // used by one face
  nonManifoldEdges: number; // used by three or more faces
}

export function edgeStats(mesh: Mesh): EdgeStats {
  let openEdges = 0, nonManifoldEdges = 0;
  for (const faces of edgeFaces(mesh).values()) {
    if (faces.length === 1) openEdges++;
    else if (faces.length > 2) nonManifoldEdges++;
  }
  return { openEdges, nonManifoldEdges };
}

/**
 * Group faces into connected shells through shared edges.
 */
export function shells(mesh: Mesh): number[][] {
  const parent = mesh.faces.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (const faces of edgeFaces(mesh).values()) {
    for (let i = 1; i < faces.length; i++) {
      const ra = find(faces[0]), rb = find(faces[i]);
      if (ra !== rb) parent[ra] = rb;
    }
  }
  const groups = new Map<number, number[]>();
  mesh.faces.forEach((_, f) => {
    const r = find(f);
    const g = groups.get(r);
    if (g) g.push(f);
    else groups.set(r, [f]);
  });
  return [...groups.values()];
}

// ─── Transforms ──────────────────────────────────────────────

/**
 * Affine transform in 3MF order: m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32.
 * A point maps as p' = p.x * row0 + p.y * row1 + p.z * row2 + row3.
 */
export type Transform = number[];

export const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

export function translation(x: number, y: number, z: number): Transform {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z];
}

export function applyTransform(m: Transform, p: Vec3): Vec3 {
  return {
    x: p.x * m[0] + p.y * m[3] + p.z * m[6] + m[9],
    y: p.x * m[1] + p.y * m[4] + p.z * m[7] + m[10],
    z: p.x * m[2] + p.y * m[5] + p.z * m[8] + m[11],
  };
}

/**
 * Compose so that the result applies `first`, then `second`.
 */
export function composeTransforms(first: Transform, second: Transform): Transform {
  const r = (i: number) => applyLinear(second, { x: first[i * 3], y: first[i * 3 + 1], z: first[i * 3 + 2] });
  const t = applyTransform(second, { x: first[9], y: first[10], z: first[11] });
  const r0 = r(0), r1 = r(1), r2 = r(2);
  return [r0.x, r0.y, r0.z, r1.x, r1.y, r1.z, r2.x, r2.y, r2.z, t.x, t.y, t.z];
}

function applyLinear(m: Transform, p: Vec3): Vec3 {
  return {
    x: p.x * m[0] + p.y * m[3] + p.z * m[6],
    y: p.x * m[1] + p.y * m[4] + p.z * m[7],
    z: p.x * m[2] + p.y * m[5] + p.z * m[8],
  };
}

export function invertTransform(m: Transform): Transform {
  const [a, b, c, d, e, f, g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error("Transform is not invertible");
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const t = applyLinear([...inv, 0, 0, 0], { x: m[9], y: m[10], z: m[11] });
  return [...inv, -t.x, -t.y, -t.z];
}

export function isIdentity(m: Transform): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
}

export function transformMesh(mesh: Mesh, m: Transform): Mesh {
  const flipped = linearDeterminant(m) < 0;
  return {
    vertices: mesh.vertices.map((v) => applyTransform(m, v)),
    faces: flipped ? mesh.faces.map(([a, b, c]) => [a, c, b] as Face) : mesh.faces.map((f) => [...f] as Face),
    faceAttrs: mesh.faceAttrs ? [...mesh.faceAttrs] : undefined,
  };
}

function linearDeterminant(m: Transform): number {
  const [a, b, c, d, e, f, g, h, i] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}

/**
 * Rotation in degrees, applied about X, then Y, then Z.
 */
export function rotationXYZ(rxDeg: number, ryDeg: number, rzDeg: number): Transform {
  const rad = Math.PI / 180;
  const [cx, sx] = [Math.cos(rxDeg * rad), Math.sin(rxDeg * rad)];
  const [cy, sy] = [Math.cos(ryDeg * rad), Math.sin(ryDeg * rad)];
  const [cz, sz] = [Math.cos(rzDeg * rad), Math.sin(rzDeg * rad)];

  const rx: Transform = [1, 0, 0, 0, cx, sx, 0, -sx, cx, 0, 0, 0];
  const ry: Transform = [cy, 0, -sy, 0, 1, 0, sy, 0, cy, 0, 0, 0];
  const rz: Transform = [cz, sz, 0, -sz, cz, 0, 0, 0, 1, 0, 0, 0];
  return snap(composeTransforms(composeTransforms(rx, ry), rz));
}

// Clean float noise so right-angle rotations stay exact
function snap(m: Transform): Transform {
  return m.map((v) => {
    const r = Math.round(v);
    return Math.abs(v - r) < 1e-12 ? r : v;
  });
}

/**
 * Translate so the mesh sits on z = 0 with its XY bounding-box center at the origin.
 * Returns the offset that was subtracted.
 */
export function centerOnOrigin(mesh: Mesh): { mesh: Mesh; offset: Vec3 } {
  const { min, max } = bounds(mesh.vertices);
  const offset = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: min.z };
  return {
    mesh: transformMesh(mesh, translation(-offset.x, -offset.y, -offset.z)),
    offset,
  };
}
