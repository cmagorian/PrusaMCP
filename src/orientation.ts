import type { Triangle, Vec3, StlData } from "./types.js";

export interface OrientationResult {
  name: string;
  rotation: { axisX: number; axisY: number; axisZ: number }; // degrees
  overhangPercent: number; // share of surface area, bed contact excluded
  overhangArea: number;    // mm²
  supportVolume: number;   // rough estimate in mm³
  printHeight: number;     // mm — lower = faster
  bedContact: number;      // mm² — higher = better adhesion
  score: number;           // 0-100
  reasoning: string;
}

/**
 * Lightweight analysis for orientation scoring.
 * Only computes bounding box, overhangs, and surface area — skips manifold check,
 * small details, volume calculation, and edge analysis (6× faster than full analyzeMesh).
 */
function analyzeForOrientation(triangles: Triangle[]): {
  overhangPercent: number;
  surfaceArea: number;
  height: number;
} {
  let surfaceArea = 0;
  let overhangCount = 0;

  for (const t of triangles) {
    const area = triArea(t.v1, t.v2, t.v3);
    surfaceArea += area;

    // Overhang: normal Z < cos(135°) ≈ -0.707 means face points down > 45°
    const normal = computeNormal(t.v1, t.v2, t.v3);
    if (normal.z < -0.707) {
      overhangCount++;
    }
  }

  // Height (bounding box Z)
  let minZ = Infinity, maxZ = -Infinity;
  for (const t of triangles) {
    minZ = Math.min(minZ, t.v1.z, t.v2.z, t.v3.z);
    maxZ = Math.max(maxZ, t.v1.z, t.v2.z, t.v3.z);
  }

  return {
    overhangPercent: triangles.length > 0 ? (overhangCount / triangles.length) * 100 : 0,
    surfaceArea,
    height: maxZ - minZ,
  };
}

/**
 * Test 6 principal orientations (original + 5 rotations) and rank them.
 */
export function suggestOrientation(stl: StlData): OrientationResult[] {
  const orientations: Array<{
    name: string;
    rotation: { axisX: number; axisY: number; axisZ: number };
    transform: (v: Vec3) => Vec3;
  }> = [
    {
      name: "Original",
      rotation: { axisX: 0, axisY: 0, axisZ: 0 },
      transform: (v) => v,
    },
    {
      name: "Face avant vers le bas (rotation X +90°)",
      rotation: { axisX: 90, axisY: 0, axisZ: 0 },
      transform: (v) => ({ x: v.x, y: -v.z, z: v.y }),
    },
    {
      name: "Face arrière vers le bas (rotation X -90°)",
      rotation: { axisX: -90, axisY: 0, axisZ: 0 },
      transform: (v) => ({ x: v.x, y: v.z, z: -v.y }),
    },
    {
      name: "Face droite vers le bas (rotation Y +90°)",
      rotation: { axisX: 0, axisY: 90, axisZ: 0 },
      transform: (v) => ({ x: v.z, y: v.y, z: -v.x }),
    },
    {
      name: "Face gauche vers le bas (rotation Y -90°)",
      rotation: { axisX: 0, axisY: -90, axisZ: 0 },
      transform: (v) => ({ x: -v.z, y: v.y, z: v.x }),
    },
    {
      name: "Retourné (rotation X 180°)",
      rotation: { axisX: 180, axisY: 0, axisZ: 0 },
      transform: (v) => ({ x: v.x, y: -v.y, z: -v.z }),
    },
  ];

  // Pre-compute original height for scoring
  const originalHeight = Math.max(
    stl.triangles.reduce((m, t) => Math.max(m, t.v1.z, t.v2.z, t.v3.z), -Infinity) -
    stl.triangles.reduce((m, t) => Math.min(m, t.v1.z, t.v2.z, t.v3.z), Infinity),
    1,
  );

  const results: OrientationResult[] = [];

  for (const orient of orientations) {
    // Transform all triangles and shift to Z=0 in a single pass
    let minZ = Infinity;
    const transformed: Triangle[] = stl.triangles.map((t) => {
      const v1 = orient.transform(t.v1);
      const v2 = orient.transform(t.v2);
      const v3 = orient.transform(t.v3);
      minZ = Math.min(minZ, v1.z, v2.z, v3.z);
      return { normal: orient.transform(t.normal), v1, v2, v3 };
    });

    // Shift to Z=0, compute overhangs/bedContact in single pass
    let bedContact = 0;
    let overhangArea = 0;
    let surfaceArea = 0;
    let maxZ = -Infinity;

    for (const t of transformed) {
      t.v1.z -= minZ;
      t.v2.z -= minZ;
      t.v3.z -= minZ;

      maxZ = Math.max(maxZ, t.v1.z, t.v2.z, t.v3.z);

      const area = triArea(t.v1, t.v2, t.v3);
      surfaceArea += area;

      const normal = computeNormal(t.v1, t.v2, t.v3);

      // Bed contact: faces near Z=0 facing down. Other faces pointing down > 45° are overhangs.
      if (t.v1.z < 0.3 && t.v2.z < 0.3 && t.v3.z < 0.3 && normal.z < -0.5) {
        bedContact += area;
      } else if (normal.z < -0.707) {
        overhangArea += area;
      }
    }

    // Area-weighted, so dense tessellation does not inflate a small curved overhang
    const overhangPercent = surfaceArea > 0 ? (overhangArea / surfaceArea) * 100 : 0;
    const printHeight = maxZ > 0 ? maxZ : 0;

    // Rough support volume estimate
    const avgOverhangHeight = printHeight * 0.3;
    const supportVolume = (surfaceArea * overhangPercent / 100) * avgOverhangHeight * 0.1;

    // Score
    let score = 100;
    score -= overhangPercent * 1.5;
    score -= (printHeight / originalHeight - 1) * 10;
    score += Math.min(bedContact / 10, 20);
    score -= supportVolume * 0.01;
    score = Math.max(0, Math.min(100, score));

    // Reasoning
    const parts: string[] = [];
    if (overhangPercent < 5) parts.push("très peu d'overhangs");
    else if (overhangPercent < 15) parts.push("overhangs modérés");
    else parts.push(`${overhangPercent.toFixed(0)}% d'overhangs`);

    parts.push(`hauteur ${printHeight.toFixed(1)}mm`);

    if (bedContact > 50) parts.push("bonne adhésion au plateau");
    else if (bedContact < 5) parts.push("faible contact avec le plateau");

    results.push({
      name: orient.name,
      rotation: orient.rotation,
      overhangPercent,
      overhangArea,
      supportVolume,
      printHeight,
      bedContact,
      score: Math.round(score),
      reasoning: parts.join(", "),
    });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ─── Helpers ─────────────────────────────────────────────────

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

function triArea(v1: Vec3, v2: Vec3, v3: Vec3): number {
  const ax = v2.x - v1.x, ay = v2.y - v1.y, az = v2.z - v1.z;
  const bx = v3.x - v1.x, by = v3.y - v1.y, bz = v3.z - v1.z;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
}
