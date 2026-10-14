import { writeFile } from "node:fs/promises";
import type { Face, Mesh, Vec3 } from "./types.js";
import { edgeFaces, edgeKey, edgeStats, faceAreaOf, faceNormalOf, shells, signedVolume, type EdgeStats } from "./mesh.js";

/**
 * Mesh repair for what PrusaSlicer's load-time fix leaves behind. PrusaSlicer 2.9.6 has no
 * CLI repair flag. Loading fixes reversed and degenerate facets but leaves holes open.
 */

export interface RepairOptions {
  weldTolerance?: number; // mm
  maxHoleEdges?: number;  // larger holes stay open and are reported
}

export interface MeshHealth extends EdgeStats {
  faces: number;
  shells: number;
  volume: number; // mm³, signed; negative means inside-out
}

export interface RepairReport {
  before: MeshHealth;
  after: MeshHealth;
  verticesWelded: number;
  degenerateRemoved: number;
  duplicatesRemoved: number;
  facesFlipped: number;
  shellsInverted: number;
  holesFilled: number;
  holesSkipped: number;
}

export function meshHealth(mesh: Mesh): MeshHealth {
  return {
    faces: mesh.faces.length,
    shells: shells(mesh).length,
    volume: signedVolume(mesh),
    ...edgeStats(mesh),
  };
}

export function repairMesh(input: Mesh, options: RepairOptions = {}): { mesh: Mesh; report: RepairReport } {
  const tolerance = options.weldTolerance ?? 1e-4;
  const maxHoleEdges = options.maxHoleEdges ?? 200;
  const before = meshHealth(input);

  const welded = weldVertices(input, tolerance);
  const cleaned = removeBadFaces(welded.mesh);
  const flipped = orientConsistently(cleaned.mesh);
  const holes = fillHoles(cleaned.mesh, maxHoleEdges);
  const inverted = orientOutward(cleaned.mesh);

  return {
    mesh: cleaned.mesh,
    report: {
      before,
      after: meshHealth(cleaned.mesh),
      verticesWelded: welded.merged,
      degenerateRemoved: cleaned.degenerate,
      duplicatesRemoved: cleaned.duplicates,
      facesFlipped: flipped,
      shellsInverted: inverted,
      holesFilled: holes.filled,
      holesSkipped: holes.skipped,
    },
  };
}

// ─── Steps ───────────────────────────────────────────────────

function weldVertices(mesh: Mesh, tolerance: number): { mesh: Mesh; merged: number } {
  const scale = 1 / tolerance;
  const index = new Map<string, number>();
  const remap = new Int32Array(mesh.vertices.length);
  const vertices: Vec3[] = [];

  mesh.vertices.forEach((v, i) => {
    const key = `${Math.round(v.x * scale)},${Math.round(v.y * scale)},${Math.round(v.z * scale)}`;
    let id = index.get(key);
    if (id === undefined) {
      id = vertices.length;
      vertices.push({ ...v });
      index.set(key, id);
    }
    remap[i] = id;
  });

  return {
    mesh: {
      vertices,
      faces: mesh.faces.map(([a, b, c]) => [remap[a], remap[b], remap[c]] as Face),
      faceAttrs: mesh.faceAttrs ? [...mesh.faceAttrs] : undefined,
    },
    merged: mesh.vertices.length - vertices.length,
  };
}

function removeBadFaces(mesh: Mesh): { mesh: Mesh; degenerate: number; duplicates: number } {
  const seen = new Set<string>();
  const faces: Face[] = [];
  const attrs: (string | undefined)[] = [];
  let degenerate = 0, duplicates = 0;

  mesh.faces.forEach(([a, b, c], i) => {
    if (a === b || b === c || a === c ||
      faceAreaOf(mesh.vertices[a], mesh.vertices[b], mesh.vertices[c]) < 1e-12) {
      degenerate++;
      return;
    }
    const key = [a, b, c].sort((x, y) => x - y).join(",");
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    faces.push([a, b, c]);
    attrs.push(mesh.faceAttrs?.[i]);
  });

  return {
    mesh: { vertices: mesh.vertices, faces, faceAttrs: mesh.faceAttrs ? attrs : undefined },
    degenerate,
    duplicates,
  };
}

function hasDirectedEdge([a, b, c]: Face, p: number, q: number): boolean {
  return (a === p && b === q) || (b === p && c === q) || (c === p && a === q);
}

/**
 * Walk each shell across two-face edges and flip neighbors whose winding disagrees.
 * The shell keeps its majority winding, so one reversed face counts as one flip.
 */
function orientConsistently(mesh: Mesh): number {
  const edges = edgeFaces(mesh);
  const visited = new Uint8Array(mesh.faces.length);
  const flip = (f: number) => {
    const [x, y, z] = mesh.faces[f];
    mesh.faces[f] = [x, z, y];
  };
  let total = 0;

  for (let start = 0; start < mesh.faces.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const queue = [start];
    const shell = [start];
    const flipped = new Set<number>();

    while (queue.length > 0) {
      const f = queue.pop()!;
      const [a, b, c] = mesh.faces[f];
      for (const [p, q] of [[a, b], [b, c], [c, a]]) {
        const pair = edges.get(edgeKey(p, q))!;
        if (pair.length !== 2) continue;
        const g = pair[0] === f ? pair[1] : pair[0];
        if (visited[g]) continue;
        visited[g] = 1;
        shell.push(g);
        if (hasDirectedEdge(mesh.faces[g], p, q)) {
          flip(g);
          flipped.add(g);
        }
        queue.push(g);
      }
    }

    if (flipped.size > shell.length / 2) {
      shell.forEach(flip);
      total += shell.length - flipped.size;
    } else {
      total += flipped.size;
    }
  }
  return total;
}

/**
 * Close boundary loops with a fan around the loop's centroid.
 */
function fillHoles(mesh: Mesh, maxHoleEdges: number): { filled: number; skipped: number } {
  const counts = new Map<string, number>();
  for (const [a, b, c] of mesh.faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(p, q);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  // Loop edges run opposite to the open face edge so new faces wind the same way
  const next = new Map<number, number[]>();
  for (const [a, b, c] of mesh.faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      if (counts.get(edgeKey(p, q)) !== 1) continue;
      const list = next.get(q);
      if (list) list.push(p);
      else next.set(q, [p]);
    }
  }

  let filled = 0, skipped = 0;
  for (const [startVertex, outs] of next) {
    while (outs.length > 0) {
      const loop = [startVertex];
      let current = outs.pop()!;
      let closed = false;

      // Walk the whole loop so an oversized hole is consumed once and counted once
      while (loop.length <= mesh.faces.length * 3) {
        if (current === startVertex) {
          closed = true;
          break;
        }
        loop.push(current);
        const candidates = next.get(current);
        if (!candidates || candidates.length === 0) break;
        current = candidates.pop()!;
      }

      if (!closed || loop.length > maxHoleEdges || loop.length < 3) {
        skipped++;
        continue;
      }
      triangulateLoop(mesh, loop);
      filled++;
    }
  }
  return { filled, skipped };
}

function triangulateLoop(mesh: Mesh, loop: number[]): void {
  const add = (face: Face) => {
    mesh.faces.push(face);
    mesh.faceAttrs?.push(undefined);
  };

  if (loop.length === 3) {
    add([loop[0], loop[1], loop[2]]);
    return;
  }

  const c = { x: 0, y: 0, z: 0 };
  for (const v of loop) {
    c.x += mesh.vertices[v].x;
    c.y += mesh.vertices[v].y;
    c.z += mesh.vertices[v].z;
  }
  const center = mesh.vertices.length;
  mesh.vertices.push({ x: c.x / loop.length, y: c.y / loop.length, z: c.z / loop.length });
  for (let i = 0; i < loop.length; i++) {
    add([loop[i], loop[(i + 1) % loop.length], center]);
  }
}

/**
 * Flip closed shells with negative volume so normals face outward.
 */
function orientOutward(mesh: Mesh): number {
  const counts = new Map<string, number>();
  for (const [a, b, c] of mesh.faces) {
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(p, q);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  let inverted = 0;
  for (const shell of shells(mesh)) {
    const closed = shell.every((f) => {
      const [a, b, c] = mesh.faces[f];
      return [[a, b], [b, c], [c, a]].every(([p, q]) => counts.get(edgeKey(p, q)) === 2);
    });
    if (!closed || signedVolume(mesh, shell) >= 0) continue;
    for (const f of shell) {
      const [a, b, c] = mesh.faces[f];
      mesh.faces[f] = [a, c, b];
    }
    inverted++;
  }
  return inverted;
}

// ─── STL output ──────────────────────────────────────────────

export async function writeBinaryStl(mesh: Mesh, outputPath: string, name = "PrusaMCP"): Promise<void> {
  const buf = Buffer.alloc(84 + mesh.faces.length * 50);
  buf.write(name.slice(0, 79), 0, "ascii");
  buf.writeUInt32LE(mesh.faces.length, 80);

  let o = 84;
  for (const [a, b, c] of mesh.faces) {
    const v1 = mesh.vertices[a], v2 = mesh.vertices[b], v3 = mesh.vertices[c];
    const n = faceNormalOf(v1, v2, v3);
    for (const v of [n, v1, v2, v3]) {
      buf.writeFloatLE(v.x, o);
      buf.writeFloatLE(v.y, o + 4);
      buf.writeFloatLE(v.z, o + 8);
      o += 12;
    }
    o += 2;
  }
  await writeFile(outputPath, buf);
}
