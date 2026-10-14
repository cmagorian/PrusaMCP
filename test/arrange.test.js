import { test } from "node:test";
import assert from "node:assert/strict";
import { packRectangles } from "../build/arrange.js";
import { arrangeModels, mergeModels, objectsOffBed } from "../build/plate-builder.js";
import { bounds, transformMesh } from "../build/mesh.js";
import { tShape, cube, sphere, tempDir, writeStl } from "./helpers/fixtures.js";

function footprints(result, items) {
  return result.placements.map((p) => {
    const item = items.find((i) => i.key === p.key);
    const [w, d] = p.rotated ? [item.depth, item.width] : [item.width, item.depth];
    return { x0: p.centerX - w / 2, x1: p.centerX + w / 2, y0: p.centerY - d / 2, y1: p.centerY + d / 2 };
  });
}

test("packs items on the bed with the spacing between them", () => {
  const items = Array.from({ length: 12 }, (_, key) => ({ key, width: 40 + (key % 3) * 10, depth: 30 }));
  const result = packRectangles(items, 250, 210, 6);
  assert.equal(result.unplaced.length, 0);

  const rects = footprints(result, items);
  for (const r of rects) {
    assert.ok(r.x0 >= -1e-9 && r.y0 >= -1e-9 && r.x1 <= 250 + 1e-9 && r.y1 <= 210 + 1e-9, "inside bed");
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const gapX = Math.max(b.x0 - a.x1, a.x0 - b.x1);
      const gapY = Math.max(b.y0 - a.y1, a.y0 - b.y1);
      assert.ok(Math.max(gapX, gapY) >= 6 - 1e-9, `items ${i} and ${j} closer than the spacing`);
    }
  }
});

test("turns a long item to fit and reports what cannot fit", () => {
  const turned = packRectangles([{ key: 0, width: 200, depth: 240 }], 250, 210, 6);
  assert.equal(turned.placements[0].rotated, true);

  const tooBig = packRectangles([{ key: 0, width: 300, depth: 300 }, { key: 1, width: 20, depth: 20 }], 250, 210, 6);
  assert.deepEqual(tooBig.unplaced, [0]);
  assert.equal(tooBig.placements.length, 1);
});

test("a single item lands at the bed center", () => {
  const { placements } = packRectangles([{ key: 0, width: 40, depth: 10 }], 250, 210, 6);
  assert.equal(placements[0].centerX, 125);
  assert.equal(placements[0].centerY, 105);
});

test("arrangeModels builds a plate from STLs with copies and rotations", async () => {
  const dir = tempDir();
  const t = await writeStl(dir, "t.stl", tShape());
  const c = await writeStl(dir, "cube.stl", cube());

  const result = await arrangeModels([{ path: t, rotateX: 90 }, { path: c, copies: 3 }]);
  assert.equal(result.unplaced.length, 0);
  assert.equal(result.plate.objects.length, 2);
  assert.equal(result.plate.objects[1].instances.length, 3);
  assert.deepEqual(objectsOffBed(result.plate, { x: 250, y: 210 }), []);

  // X +90° maps (x, y, z) to (x, -z, y), so the T's 10 mm depth becomes its height
  const tObj = result.plate.objects[0];
  const tb = bounds(transformMesh(tObj.volumes[0].mesh, tObj.instances[0]).vertices);
  assert.ok(Math.abs(tb.min.z) < 1e-9, "sits on the bed");
  assert.ok(Math.abs(tb.max.z - tb.min.z - 10) < 1e-6, "height after rotation");
});

test("mergeModels keeps relative positions", async () => {
  const dir = tempDir();
  const a = await writeStl(dir, "a.stl", cube(2));
  const shifted = cube(2);
  shifted.vertices = shifted.vertices.map((v) => ({ ...v, x: v.x + 30 }));
  const b = await writeStl(dir, "b.stl", shifted);

  for (const mode of ["objects", "parts"]) {
    const plate = await mergeModels([{ path: a }, { path: b }], { mode });
    const worlds = plate.objects.flatMap((o) =>
      o.volumes.map((v) => bounds(transformMesh(v.mesh, o.instances[0]).vertices)));
    assert.equal(worlds.length, 2);
    assert.ok(Math.abs(worlds[1].min.x - worlds[0].min.x - 30) < 1e-6, `${mode}: offset kept`);
    assert.ok(Math.abs((worlds[0].min.x + worlds[1].max.x) / 2 - 125) < 1e-6, `${mode}: centered`);
  }
});

test("objects with support from the bed get room for its widened first layer", async () => {
  const dir = tempDir();
  const t = await writeStl(dir, "t.stl", tShape());
  const s = await writeStl(dir, "sphere.stl", sphere(10));
  const c = await writeStl(dir, "cube.stl", cube());

  const result = await arrangeModels([{ path: t }, { path: s }, { path: c }], { spacing: 6, supportClearance: 4 });
  const room = Object.fromEntries(result.items.map((i) => [i.objectName, i.supportRoom]));
  assert.deepEqual(room, { "t.stl": 4, "sphere.stl": 4, "cube.stl": 0 });
  assert.equal(result.clearanceDropped, false);

  // Footprint gap between the two supported objects is spacing plus room on both sides
  const [ft, fs] = ["t.stl", "sphere.stl"].map((name) => {
    const obj = result.plate.objects.find((o) => o.name === name);
    return bounds(transformMesh(obj.volumes[0].mesh, obj.instances[0]).vertices);
  });
  const gap = Math.max(fs.min.x - ft.max.x, ft.min.x - fs.max.x, fs.min.y - ft.max.y, ft.min.y - fs.max.y);
  assert.ok(gap >= 14 - 1e-6, `gap ${gap}`);
});

test("support room is given up before a model is left off the bed", async () => {
  const dir = tempDir();
  const t = await writeStl(dir, "t.stl", tShape());

  // A 40 mm T on a 44 mm bed fits only without 4 mm of room per side
  const result = await arrangeModels([{ path: t }], { bed: { x: 44, y: 44 }, supportClearance: 4, allowRotation: false });
  assert.equal(result.unplaced.length, 0);
  assert.equal(result.clearanceDropped, true);
  assert.equal(result.items[0].supportRoom, 0);
});
