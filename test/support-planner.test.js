import { test } from "node:test";
import assert from "node:assert/strict";
import { planSupports } from "../build/support-planner.js";
import { transformMesh, translation } from "../build/mesh.js";
import { tShape, arch, ledge, cube, sphere } from "./helpers/fixtures.js";

const plan = (mesh, options = {}) =>
  planSupports([{ index: 0, name: "fixture", mesh }], { overhangAngle: 45, minArea: 20, ...options });

const near = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: expected ${expected} ± ${tolerance}, got ${actual}`);

test("a cube has no overhangs; its bed face is ignored", () => {
  assert.equal(plan(cube()).regions.length, 0);
});

test("T-shape: two wings at z = 20, over open air", () => {
  const { regions } = plan(tShape());
  assert.equal(regions.length, 2);
  for (const r of regions) {
    near(r.projectedArea, 150, 1e-6, "wing area");
    near(r.zMin, 20, 1e-6, "zMin");
    near(r.zMax, 20, 1e-6, "zMax");
    assert.equal(r.landsOn, "bed");
    assert.equal(r.verdict, "enforce");
    near(r.meanSlope, 0, 1e-6, "slope");
  }
  const xs = regions.map((r) => r.bbox.min.x).sort((a, b) => a - b);
  assert.deepEqual(xs, [0, 25]);
});

test("region ids are stable under translation", () => {
  const a = plan(tShape()).regions.map((r) => [r.id, r.bbox.min.x]);
  const b = plan(transformMesh(tShape(), translation(100, 50, 0))).regions.map((r) => [r.id, r.bbox.min.x - 100]);
  assert.deepEqual(a, b);
});

test("arch: the span between pillars is one region", () => {
  const { regions } = plan(arch());
  assert.equal(regions.length, 1);
  near(regions[0].projectedArea, 200, 1e-6, "bridge area");
  assert.equal(regions[0].landsOn, "bed");
});

test("ledge: support would stand on the base, so it needs review", () => {
  const { regions } = plan(ledge());
  assert.equal(regions.length, 1);
  near(regions[0].projectedArea, 600, 1e-6, "shelf area");
  near(regions[0].zMin, 25, 1e-6, "shelf height");
  assert.equal(regions[0].landsOn, "model");
  assert.equal(regions[0].verdict, "review");
});

test("sphere: the bottom cap within 45° is one region", () => {
  const { regions } = plan(sphere(10));
  assert.equal(regions.length, 1);
  const expected = Math.PI * (10 * Math.sin(Math.PI / 4)) ** 2; // 157 mm²
  near(regions[0].projectedArea, expected, expected * 0.08, "cap footprint");
  assert.equal(regions[0].landsOn, "bed");
});

test("a lower overhang angle shrinks the sphere cap", () => {
  const at30 = plan(sphere(10), { overhangAngle: 30 }).regions[0].projectedArea;
  const expected = Math.PI * (10 * Math.sin(Math.PI / 6)) ** 2; // 78.5 mm²
  near(at30, expected, expected * 0.12, "30° cap footprint");
});

test("small regions stay with the slicer", () => {
  const { regions } = plan(tShape(), { minArea: 200 });
  assert.ok(regions.every((r) => r.verdict === "slicer"));
});

test("cosmetic bottom faces become blocker candidates", () => {
  const { regions, totals } = plan(tShape(), { cosmeticSides: ["bottom"] });
  assert.equal(totals.block, 2);
  assert.ok(regions.every((r) => r.cosmetic));
});

test("support standing on a cosmetic top surface is flagged", () => {
  const { regions } = plan(ledge(), { cosmeticSides: ["top"] });
  assert.equal(regions[0].landsOnCosmetic, true);
  assert.equal(regions[0].verdict, "review");
  assert.match(regions[0].reason, /cosmetic/);
});

test("volume boxes extend past the region by the margin", () => {
  const [r] = plan(tShape(), { margin: 2 }).regions;
  assert.equal(r.volumeBox.min.x, r.bbox.min.x - 2);
  assert.equal(r.volumeBox.max.y, r.bbox.max.y + 2);
  assert.equal(r.volumeBox.min.z, 18);
  assert.equal(r.volumeBox.max.z, 22);
});
