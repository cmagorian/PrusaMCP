// End-to-end through the MCP server and the installed PrusaSlicer. Skips when PrusaSlicer is missing.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectPrusaSlicerPath, detectPrusaSlicerVersion } from "../build/config.js";
import { tShape, cube, sphere, tempDir, writeStl } from "./helpers/fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const slicer = detectPrusaSlicerPath();
const skip = slicer ? false : "PrusaSlicer not installed";

let client;
let dir;
let ini;

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  return { error: Boolean(res.isError), text: res.content.map((c) => c.text ?? "").join("\n") };
};

// "- **Support**: 123.45 mm of filament on 67 layers"
const support = (text) => {
  const m = text.match(/\*\*Support\*\*: ([\d.]+) mm of filament on (\d+) layers/);
  return m ? { mm: parseFloat(m[1]), layers: parseInt(m[2], 10) } : null;
};

before(async () => {
  if (skip) return;
  dir = tempDir();
  ini = join(dir, "mk3s-bed.ini");
  writeFileSync(ini, "bed_shape = 0x0,250x0,250x210,0x210\n");
  client = new Client({ name: "prusamcp-test", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [join(root, "build", "index.js")],
    stderr: "ignore",
  }));
});

after(async () => {
  await client?.close();
});

test("PrusaSlicer version is detected", { skip }, () => {
  const version = detectPrusaSlicerVersion(slicer);
  assert.match(version, /^\d+\.\d+\.\d+/);
});

test("arrange, plan, enforce, slice, compare", { skip, timeout: 300_000 }, async () => {
  const t = await writeStl(dir, "t.stl", tShape());
  const c = await writeStl(dir, "cube.stl", cube());
  const s = await writeStl(dir, "sphere.stl", sphere(10));
  const plate = join(dir, "plate.3mf");

  const arranged = await call("arrange_plate", { models: [{ path: t }, { path: c }, { path: s }], output_path: plate });
  assert.equal(arranged.error, false, arranged.text);
  assert.match(arranged.text, /reads 3 object\(s\)/);

  const plan = await call("plan_supports", { path: plate });
  assert.equal(plan.error, false, plan.text);
  assert.match(plan.text, /3 region\(s\): 3 enforce/);

  const withVolumes = join(dir, "plate.supports.3mf");
  const applied = await call("apply_supports", { path: plate, enforce: [1, 2], output_path: withVolumes });
  assert.equal(applied.error, false, applied.text);
  assert.match(applied.text, /t\.stl: 2 enforcer\(s\)/);

  const sliced = await call("slice_prusaslicer", {
    stl_path: withVolumes,
    config_path: ini,
    support_material: true,
    support_material_auto: false,
    compare_path: plate,
    output_gcode: join(dir, "enforced.gcode"),
  });
  assert.equal(sliced.error, false, sliced.text);
  const enforced = support(sliced.text);
  assert.ok(enforced.layers > 0 && enforced.mm > 0, `enforcers produced support: ${sliced.text}`);
  assert.match(sliced.text, /\| Support layers \| \d+ \| 0 \|/, "no support without volumes when auto is off");
});

test("blockers remove automatic support from the regions they cover", { skip, timeout: 300_000 }, async () => {
  const t = await writeStl(dir, "t-block.stl", tShape());
  const plate = join(dir, "t-plate.3mf");
  await call("arrange_plate", { models: [{ path: t }], output_path: plate });

  const blocked = join(dir, "t-plate.blocked.3mf");
  const applied = await call("apply_supports", { path: plate, block: [1, 2], output_path: blocked });
  assert.equal(applied.error, false, applied.text);

  const sliced = await call("slice_prusaslicer", {
    stl_path: blocked,
    config_path: ini,
    support_material: true,
    support_material_auto: true,
    compare_path: plate,
    output_gcode: join(dir, "blocked.gcode"),
  });
  assert.equal(sliced.error, false, sliced.text);
  const row = sliced.text.match(/\| Support filament \| ([\d.]+) mm \| ([\d.]+) mm \|/);
  assert.ok(row, sliced.text);
  assert.equal(parseFloat(row[1]), 0, "blocked plate has no support");
  assert.ok(parseFloat(row[2]) > 0, "automatic support without blockers");
});

test("support options reach the G-code", { skip, timeout: 120_000 }, async () => {
  const t = await writeStl(dir, "t-opts.stl", tShape());
  const plate = join(dir, "t-opts.3mf");
  await call("arrange_plate", { models: [{ path: t }], output_path: plate });

  const gcode = join(dir, "opts.gcode");
  const sliced = await call("slice_prusaslicer", {
    stl_path: plate,
    config_path: ini,
    support_material: true,
    support_material_style: "organic",
    support_material_threshold: 30,
    support_material_buildplate_only: true,
    output_gcode: gcode,
  });
  assert.equal(sliced.error, false, sliced.text);
  const header = readFileSync(gcode, "utf-8");
  assert.match(header, /^; support_material = 1$/m);
  assert.match(header, /^; support_material_style = organic$/m);
  assert.match(header, /^; support_material_threshold = 30$/m);
  assert.match(header, /^; support_material_buildplate_only = 1$/m);
});

test("a model outside the bed fails loudly", { skip, timeout: 120_000 }, async () => {
  const t = await writeStl(dir, "t-off.stl", tShape());
  const plate = join(dir, "t-off.3mf");
  await call("arrange_plate", { models: [{ path: t }], output_path: plate });

  const tiny = join(dir, "tiny-bed.ini");
  writeFileSync(tiny, "bed_shape = 0x0,20x0,20x20,0x20\n");
  const sliced = await call("slice_prusaslicer", { stl_path: plate, config_path: tiny, output_gcode: join(dir, "off.gcode") });
  assert.equal(sliced.error, true);
  assert.match(sliced.text, /outside of the print volume/);
});

test("repair_mesh closes a hole PrusaSlicer leaves open", { skip, timeout: 120_000 }, async () => {
  const m = cube();
  m.faces.pop();
  const broken = await writeStl(dir, "broken.stl", m);
  const res = await call("repair_mesh", { path: broken });
  assert.equal(res.error, false, res.text);
  assert.match(res.text, /\| Before \| no \| 3 \|/);
  assert.match(res.text, /\| After \| yes \| 0 \|/);
});

test("multi-material tool assignments survive apply_supports", { skip, timeout: 300_000 }, async () => {
  const { write3mf } = await import("../build/threemf.js");
  const { transformMesh, translation } = await import("../build/mesh.js");

  // One object, two parts on extruders 1 and 2, as the GUI saves an MMU print
  const source = join(dir, "mmu.3mf");
  await write3mf({
    objects: [{
      id: 1, name: "mmu", metadata: {}, instances: [translation(125, 105, 0)],
      volumes: [
        { name: "t", type: "ModelPart", mesh: transformMesh(tShape(), translation(-20, -5, 0)), metadata: { extruder: "1" } },
        { name: "c", type: "ModelPart", mesh: transformMesh(cube(2), translation(25, -5, 0)), metadata: { extruder: "2" } },
      ],
    }],
  }, source);

  const mmuIni = join(dir, "mmu.ini");
  writeFileSync(mmuIni, [
    "bed_shape = 0x0,250x0,250x210,0x210",
    "single_extruder_multi_material = 1",
    "nozzle_diameter = 0.4,0.4,0.4,0.4,0.4",
    "use_relative_e_distances = 1",
    "wipe_tower = 1",
    "wipe_tower_x = 170",
    "wipe_tower_y = 140",
    "support_material_extruder = 0",
    "support_material_interface_extruder = 0",
    "",
  ].join("\n"));

  const patched = join(dir, "mmu.supports.3mf");
  const applied = await call("apply_supports", { path: source, enforce: [1], output_path: patched });
  assert.equal(applied.error, false, applied.text);

  const toolChanges = (path) => {
    const counts = {};
    for (const m of readFileSync(path, "utf-8").matchAll(/^(T[0-4])$/gm)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
    return counts;
  };

  const outA = join(dir, "mmu.gcode");
  const outB = join(dir, "mmu.supports.gcode");
  for (const [input, output] of [[source, outA], [patched, outB]]) {
    const res = await call("slice_prusaslicer", {
      stl_path: input, config_path: mmuIni, support_material: true, support_material_auto: false, output_gcode: output,
    });
    assert.equal(res.error, false, res.text);
  }

  const before = toolChanges(outA);
  assert.ok(before.T0 > 0 && before.T1 > 0, `both tools used: ${JSON.stringify(before)}`);
  assert.deepEqual(toolChanges(outB), before);

  // PrusaSlicer exits 0 without G-code here; its unlabeled reason must reach the caller
  const absoluteE = join(dir, "mmu-absolute.ini");
  writeFileSync(absoluteE, readFileSync(mmuIni, "utf-8").replace("use_relative_e_distances = 1", "use_relative_e_distances = 0"));
  const refused = await call("slice_prusaslicer", { stl_path: source, config_path: absoluteE, output_gcode: join(dir, "refused.gcode") });
  assert.equal(refused.error, true);
  assert.match(refused.text, /Wipe Tower/);
});

test("generate_prusaslicer_config writes support options", { skip: false }, async (t) => {
  if (skip) return t.skip(skip);
  const out = join(dir, "supports.ini");
  const res = await call("generate_prusaslicer_config", {
    goal: "standard",
    output_path: out,
    support_material: true,
    support_material_auto: false,
    support_material_style: "snug",
    support_material_buildplate_only: true,
  });
  assert.equal(res.error, false, res.text);
  const content = readFileSync(out, "utf-8");
  assert.match(content, /^support_material = 1$/m);
  assert.match(content, /^support_material_auto = 0$/m);
  assert.match(content, /^support_material_style = snug$/m);
  assert.match(content, /^support_material_buildplate_only = 1$/m);
});
