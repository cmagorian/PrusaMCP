import { test } from "node:test";
import assert from "node:assert/strict";
import { repairMesh, meshHealth } from "../build/mesh-repair.js";
import { cube } from "./helpers/fixtures.js";

const clone = (m) => ({ vertices: m.vertices.map((v) => ({ ...v })), faces: m.faces.map((f) => [...f]) });

test("a clean cube passes through unchanged", () => {
  const { report } = repairMesh(cube());
  assert.equal(report.after.openEdges, 0);
  assert.equal(report.facesFlipped, 0);
  assert.equal(report.holesFilled, 0);
  assert.ok(Math.abs(report.after.volume - 8000) < 1e-6);
});

test("fills a missing triangle and flips a reversed one", () => {
  const m = clone(cube());
  m.faces.pop();
  const [a, b, c] = m.faces[0];
  m.faces[0] = [a, c, b];

  const before = meshHealth(m);
  assert.ok(before.openEdges > 0);

  const { mesh, report } = repairMesh(m);
  assert.equal(report.facesFlipped, 1);
  assert.equal(report.holesFilled, 1);
  assert.equal(report.after.openEdges, 0);
  assert.equal(report.after.nonManifoldEdges, 0);
  assert.equal(mesh.faces.length, cube().faces.length);
  assert.ok(Math.abs(report.after.volume - 8000) < 1e-6, `volume ${report.after.volume}`);
});

test("fills a missing quad with a fan", () => {
  const m = clone(cube());
  m.faces.splice(0, 2);
  const { report } = repairMesh(m);
  assert.equal(report.holesFilled, 1);
  assert.equal(report.after.openEdges, 0);
  assert.ok(Math.abs(report.after.volume - 8000) < 1e-6);
});

test("turns an inside-out shell outward", () => {
  const m = clone(cube());
  m.faces = m.faces.map(([a, b, c]) => [a, c, b]);
  assert.ok(meshHealth(m).volume < 0);
  const { report } = repairMesh(m);
  assert.equal(report.shellsInverted, 1);
  assert.ok(report.after.volume > 0);
});

test("drops degenerate and duplicate faces", () => {
  const m = clone(cube());
  m.faces.push([0, 0, 1], [...m.faces[3]]);
  const { report } = repairMesh(m);
  assert.equal(report.degenerateRemoved, 1);
  assert.equal(report.duplicatesRemoved, 1);
  assert.equal(report.after.nonManifoldEdges, 0);
});

test("welds split vertices back together", () => {
  const m = clone(cube());
  const v = m.faces[0][0];
  m.vertices.push({ ...m.vertices[v] });
  m.faces[0][0] = m.vertices.length - 1;
  assert.ok(meshHealth(m).openEdges > 0);
  const { report } = repairMesh(m);
  assert.equal(report.verticesWelded, 1);
  assert.equal(report.after.openEdges, 0);
});
