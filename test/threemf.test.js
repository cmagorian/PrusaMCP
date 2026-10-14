import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  read3mf, write3mf, appendVolumes, bedBoxToObjectMesh, plateObjectWorldMesh, readZipEntries, writeZipEntries,
} from "../build/threemf.js";
import { boxMesh, bounds, composeTransforms, rotationXYZ, translation, applyTransform, invertTransform } from "../build/mesh.js";
import { tShape, cube, tempDir } from "./helpers/fixtures.js";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test("write then read keeps objects, volume types, and instances", async () => {
  const dir = tempDir();
  const path = join(dir, "plate.3mf");
  await write3mf({
    objects: [
      {
        id: 1, name: "t", metadata: { support_material: "1" },
        volumes: [
          { name: "t", type: "ModelPart", mesh: tShape(), metadata: {} },
          { name: "enf", type: "SupportEnforcer", mesh: boxMesh({ x: 0, y: 0, z: 18 }, { x: 15, y: 10, z: 22 }), metadata: {} },
        ],
        instances: [translation(100, 80, 0)],
      },
      {
        id: 2, name: "cube", metadata: {},
        volumes: [{ name: "cube", type: "ModelPart", mesh: cube(), metadata: { extruder: "2" } }],
        instances: [translation(30, 30, 0), translation(60, 30, 0)],
      },
    ],
  }, path);

  const plate = await read3mf(path);
  assert.equal(plate.objects.length, 2);
  const [t, c] = plate.objects;
  assert.deepEqual(t.volumes.map((v) => v.type), ["ModelPart", "SupportEnforcer"]);
  assert.equal(t.volumes[0].mesh.faces.length, tShape().faces.length);
  assert.equal(t.metadata.support_material, "1");
  assert.equal(c.instances.length, 2);
  assert.equal(c.volumes[0].metadata.extruder, "2");

  const world = bounds(plateObjectWorldMesh(t, 0).vertices);
  assert.ok(close(world.min.x, 100) && close(world.max.x, 140) && close(world.min.y, 80));
});

test("appendVolumes keeps paint, MMU segmentation, settings, and other parts untouched", async () => {
  const dir = tempDir();
  const source = join(dir, "gui.3mf");
  const patched = join(dir, "gui.supports.3mf");

  // A GUI-style file: painted triangles, per-volume extruder, embedded print config
  const mesh = tShape();
  mesh.faceAttrs = mesh.faces.map((_, i) => (i % 2 ? 'slic3rpe:mmu_segmentation="8"' : undefined));
  await write3mf({
    objects: [{
      id: 1, name: "t", metadata: { layer_height: "0.1" },
      volumes: [{ name: "t", type: "ModelPart", mesh, metadata: { extruder: "3" } }],
      instances: [translation(125, 105, 0)],
    }],
  }, source);
  const entries = await readZipEntries(source);
  entries.set("Metadata/Slic3r_PE.config", Buffer.from("; layer_height = 0.1\n"));
  await writeZipEntries(entries, source);

  const box = boxMesh({ x: 100, y: 95, z: 18 }, { x: 120, y: 115, z: 22 });
  const obj = (await read3mf(source)).objects[0];
  await appendVolumes(source, patched, [{
    objectId: 1, name: "enforcer R1", type: "SupportEnforcer",
    mesh: bedBoxToObjectMesh(obj, box.vertices[0], box.vertices[6]),
  }]);

  const before = await readZipEntries(source);
  const after = await readZipEntries(patched);
  assert.deepEqual(after.get("Metadata/Slic3r_PE.config"), before.get("Metadata/Slic3r_PE.config"));

  const model = after.get("3D/3dmodel.model").toString();
  assert.equal(model.match(/mmu_segmentation="8"/g).length, mesh.faces.length / 2);

  const plate = await read3mf(patched);
  const [t] = plate.objects;
  assert.deepEqual(t.volumes.map((v) => v.type), ["ModelPart", "SupportEnforcer"]);
  assert.equal(t.volumes[0].metadata.extruder, "3");
  assert.equal(t.metadata.layer_height, "0.1");
  assert.equal(t.volumes[0].mesh.faces.length, mesh.faces.length);
  assert.equal(t.volumes[1].mesh.faces.length, 12);

  const enforcerWorld = bounds(plateObjectWorldMesh(t, 0, ["SupportEnforcer"]).vertices);
  assert.ok(close(enforcerWorld.min.x, 100) && close(enforcerWorld.max.y, 115) && close(enforcerWorld.min.z, 18));
});

test("bed boxes map into rotated object coordinates and back", () => {
  const instance = composeTransforms(rotationXYZ(0, 0, 90), translation(50, 60, 0));
  const obj = { id: 1, name: "x", metadata: {}, volumes: [], instances: [instance] };
  const mesh = bedBoxToObjectMesh(obj, { x: 40, y: 50, z: 0 }, { x: 70, y: 65, z: 10 });
  const world = bounds(mesh.vertices.map((v) => applyTransform(instance, v)));
  assert.ok(close(world.min.x, 40) && close(world.max.x, 70) && close(world.min.y, 50) && close(world.max.y, 65));
});

test("transform inverse round-trips", () => {
  const m = composeTransforms(rotationXYZ(30, -20, 75), translation(5, -7, 11));
  const p = { x: 1.5, y: -2, z: 3 };
  const back = applyTransform(invertTransform(m), applyTransform(m, p));
  assert.ok(close(back.x, p.x) && close(back.y, p.y) && close(back.z, p.z));
});

test("suggest_orientation's X/Y rotations match rotationXYZ", () => {
  // orientation.ts maps "X +90°" to (x, -z, y) and "Y +90°" to (z, y, -x)
  const p = { x: 1, y: 2, z: 3 };
  const rx = applyTransform(rotationXYZ(90, 0, 0), p);
  const ry = applyTransform(rotationXYZ(0, 90, 0), p);
  assert.deepEqual([rx.x, rx.y, rx.z], [1, -3, 2]);
  assert.deepEqual([ry.x, ry.y, ry.z], [3, 2, -1]);
});
