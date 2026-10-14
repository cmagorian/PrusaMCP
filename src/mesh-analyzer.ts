import type { Triangle, Vec3, StlData, MeshAnalysis, BoundingBox } from "./types.js";

/**
 * Full geometric analysis of a parsed STL mesh.
 */
export function analyzeMesh(stl: StlData): MeshAnalysis {
  const { triangles } = stl;
  const n = triangles.length;

  if (n === 0) {
    return {
      triangleCount: 0,
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 } },
      volume: 0,
      surfaceArea: 0,
      overhangPercent: 0,
      overhangTriangles: 0,
      hasSmallDetails: false,
      smallDetailPercent: 0,
      isManifold: false,
      nonManifoldEdges: 0,
    };
  }

  // Single pass for volume, surface area, bounding box, overhangs, triangle areas
  let volume = 0;
  let surfaceArea = 0;
  let overhangCount = 0;
  const areas: number[] = new Array(n);

  const bbMin: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const bbMax: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };

  for (let i = 0; i < n; i++) {
    const t = triangles[i];

    // Bounding box
    updateBB(bbMin, bbMax, t.v1);
    updateBB(bbMin, bbMax, t.v2);
    updateBB(bbMin, bbMax, t.v3);

    // Signed volume (tetrahedron with origin)
    volume += signedTetraVolume(t.v1, t.v2, t.v3);

    // Surface area via cross product
    const area = triangleArea(t.v1, t.v2, t.v3);
    surfaceArea += area;
    areas[i] = area;

  }

  // Overhang: normal points down more than 45° (nz < -0.707). Faces resting on the bed are not overhangs.
  const bedLimit = bbMin.z + 0.05;
  for (let i = 0; i < n; i++) {
    const t = triangles[i];
    if (Math.max(t.v1.z, t.v2.z, t.v3.z) <= bedLimit) continue;
    if (computeNormal(t.v1, t.v2, t.v3).z < -0.707) overhangCount++;
  }

  // Small detail detection: triangles with area < 10% of median area
  const sortedAreas = [...areas].sort((a, b) => a - b);
  const medianArea = sortedAreas[Math.floor(n / 2)];
  const smallThreshold = medianArea * 0.1;
  let smallDetailCount = 0;
  for (let i = 0; i < n; i++) {
    if (areas[i] < smallThreshold && areas[i] > 0) {
      smallDetailCount++;
    }
  }

  // Manifold check: each edge must be shared by exactly 2 triangles
  const { isManifold, nonManifoldEdges } = checkManifold(triangles);

  const size: Vec3 = {
    x: bbMax.x - bbMin.x,
    y: bbMax.y - bbMin.y,
    z: bbMax.z - bbMin.z,
  };

  return {
    triangleCount: n,
    boundingBox: { min: bbMin, max: bbMax, size },
    volume: Math.abs(volume),
    surfaceArea,
    overhangPercent: (overhangCount / n) * 100,
    overhangTriangles: overhangCount,
    hasSmallDetails: smallDetailCount > n * 0.05,
    smallDetailPercent: (smallDetailCount / n) * 100,
    isManifold,
    nonManifoldEdges,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function updateBB(min: Vec3, max: Vec3, v: Vec3): void {
  if (v.x < min.x) min.x = v.x;
  if (v.y < min.y) min.y = v.y;
  if (v.z < min.z) min.z = v.z;
  if (v.x > max.x) max.x = v.x;
  if (v.y > max.y) max.y = v.y;
  if (v.z > max.z) max.z = v.z;
}

/**
 * Signed volume of tetrahedron formed by triangle + origin.
 * V = (v1 · (v2 × v3)) / 6
 */
function signedTetraVolume(v1: Vec3, v2: Vec3, v3: Vec3): number {
  return (
    (v1.x * (v2.y * v3.z - v2.z * v3.y) +
      v1.y * (v2.z * v3.x - v2.x * v3.z) +
      v1.z * (v2.x * v3.y - v2.y * v3.x)) /
    6
  );
}

/**
 * Area of a triangle via cross product: ||(v2-v1) × (v3-v1)|| / 2
 */
function triangleArea(v1: Vec3, v2: Vec3, v3: Vec3): number {
  const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
  const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}

/**
 * Compute normalized face normal from vertices.
 */
function computeNormal(v1: Vec3, v2: Vec3, v3: Vec3): Vec3 {
  const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
  const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (len === 0) return { x: 0, y: 0, z: 1 };
  return { x: nx / len, y: ny / len, z: nz / len };
}

/**
 * Manifold check: every edge (pair of vertices) must appear in exactly 2 triangles.
 */
function checkManifold(triangles: Triangle[]): { isManifold: boolean; nonManifoldEdges: number } {
  const edgeCount = new Map<string, number>();

  for (const t of triangles) {
    addEdge(edgeCount, t.v1, t.v2);
    addEdge(edgeCount, t.v2, t.v3);
    addEdge(edgeCount, t.v3, t.v1);
  }

  let nonManifold = 0;
  for (const count of edgeCount.values()) {
    if (count !== 2) nonManifold++;
  }

  return { isManifold: nonManifold === 0, nonManifoldEdges: nonManifold };
}

/**
 * Create a canonical edge key from two vertices (order-independent).
 * We round to 6 decimals to handle floating point.
 */
function addEdge(map: Map<string, number>, a: Vec3, b: Vec3): void {
  const key = edgeKey(a, b);
  map.set(key, (map.get(key) ?? 0) + 1);
}

function edgeKey(a: Vec3, b: Vec3): string {
  const ax = a.x.toFixed(6), ay = a.y.toFixed(6), az = a.z.toFixed(6);
  const bx = b.x.toFixed(6), by = b.y.toFixed(6), bz = b.z.toFixed(6);
  // Sort to make order-independent
  const ka = `${ax},${ay},${az}`;
  const kb = `${bx},${by},${bz}`;
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
}
