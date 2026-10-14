// Test meshes with known overhang answers. Voxel shapes share grid vertices, so they are closed and manifold.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeBinaryStl } from "../../build/mesh-repair.js";

export const VOXEL = 5; // mm

export function box(x0, x1, y0, y1, z0, z1) {
  const out = [];
  for (let i = x0; i < x1; i++) for (let j = y0; j < y1; j++) for (let k = z0; k < z1; k++) out.push([i, j, k]);
  return out;
}

export function voxelMesh(voxels, size = VOXEL) {
  const filled = new Set(voxels.map((v) => v.join(",")));
  const has = (i, j, k) => filled.has(`${i},${j},${k}`);
  const index = new Map();
  const vertices = [];
  const faces = [];
  const id = (i, j, k) => {
    const key = `${i},${j},${k}`;
    if (!index.has(key)) {
      index.set(key, vertices.length);
      vertices.push({ x: i * size, y: j * size, z: k * size });
    }
    return index.get(key);
  };
  const quad = (a, b, c, d) => faces.push([a, b, c], [a, c, d]);

  for (const [i, j, k] of voxels) {
    if (!has(i + 1, j, k)) quad(id(i + 1, j, k), id(i + 1, j + 1, k), id(i + 1, j + 1, k + 1), id(i + 1, j, k + 1));
    if (!has(i - 1, j, k)) quad(id(i, j, k), id(i, j, k + 1), id(i, j + 1, k + 1), id(i, j + 1, k));
    if (!has(i, j + 1, k)) quad(id(i, j + 1, k), id(i, j + 1, k + 1), id(i + 1, j + 1, k + 1), id(i + 1, j + 1, k));
    if (!has(i, j - 1, k)) quad(id(i, j, k), id(i + 1, j, k), id(i + 1, j, k + 1), id(i, j, k + 1));
    if (!has(i, j, k + 1)) quad(id(i, j, k + 1), id(i + 1, j, k + 1), id(i + 1, j + 1, k + 1), id(i, j + 1, k + 1));
    if (!has(i, j, k - 1)) quad(id(i, j, k), id(i, j + 1, k), id(i + 1, j + 1, k), id(i + 1, j, k));
  }
  return { vertices, faces };
}

// Stem 10 × 10 × 20 under a 40 × 10 × 5 bar: two 15 × 10 wings overhang at z = 20
export const tShape = () => voxelMesh([...box(3, 5, 0, 2, 0, 4), ...box(0, 8, 0, 2, 4, 5)]);

// Two pillars under a 40 mm deck: one 20 × 10 bridge at z = 20
export const arch = () => voxelMesh([...box(0, 2, 0, 2, 0, 4), ...box(6, 8, 0, 2, 0, 4), ...box(0, 8, 0, 2, 4, 6)]);

// 40 × 20 base, a wall at the left, and a 30 × 20 shelf at z = 25 over the base top
export const ledge = () => voxelMesh([...box(0, 8, 0, 4, 0, 1), ...box(0, 2, 0, 4, 1, 6), ...box(2, 8, 0, 4, 5, 6)]);

export const cube = (n = 4) => voxelMesh(box(0, n, 0, n, 0, n));

export function sphere(radius = 10, stacks = 36, slices = 72) {
  const vertices = [{ x: 0, y: 0, z: 0 }];
  for (let s = 1; s < stacks; s++) {
    const phi = (Math.PI * s) / stacks; // from the bottom pole
    for (let t = 0; t < slices; t++) {
      const theta = (2 * Math.PI * t) / slices;
      vertices.push({
        x: radius * Math.sin(phi) * Math.cos(theta),
        y: radius * Math.sin(phi) * Math.sin(theta),
        z: radius - radius * Math.cos(phi),
      });
    }
  }
  const top = vertices.length;
  vertices.push({ x: 0, y: 0, z: 2 * radius });

  const ring = (s, t) => 1 + (s - 1) * slices + (t % slices);
  const faces = [];
  for (let t = 0; t < slices; t++) faces.push([0, ring(1, t + 1), ring(1, t)]);
  for (let s = 1; s < stacks - 1; s++) {
    for (let t = 0; t < slices; t++) {
      faces.push([ring(s, t), ring(s, t + 1), ring(s + 1, t + 1)], [ring(s, t), ring(s + 1, t + 1), ring(s + 1, t)]);
    }
  }
  for (let t = 0; t < slices; t++) faces.push([top, ring(stacks - 1, t), ring(stacks - 1, t + 1)]);
  return { vertices, faces };
}

export function tempDir() {
  return mkdtempSync(join(tmpdir(), "prusamcp-test-"));
}

export async function writeStl(dir, name, mesh) {
  const path = join(dir, name);
  await writeBinaryStl(mesh, path, name);
  return path;
}
