// Crash handling in sliceToGcode, driven by a fake PrusaSlicer so no real crash report is raised.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { sliceToGcode } from "../build/prusa-cli.js";
import { tempDir } from "./helpers/fixtures.js";

const skip = process.platform === "win32" ? "fake executable needs a POSIX shebang" : false;

// Writes G-code to --output, logs like PrusaSlicer, then dies by signal or exits
function fakeSlicer(dir, { complete, die }) {
  const path = join(dir, "fake-prusaslicer");
  writeFileSync(path, `#!/usr/bin/env node
const args = process.argv.slice(2);
const out = args[args.indexOf("--output") + 1];
require("fs").writeFileSync(out, [
  ";TYPE:Perimeter",
  "G1 X1 Y1 E0.5",
  "; filament used [mm] = 12.5",
  "; estimated printing time (normal mode) = 1m 2s",
  ${complete ? '"; prusaslicer_config = end",' : ""}
  "",
].join("\\n"));
console.error("[2026-10-14 11:01:34.223183] [0x1] [error]   gcode path conflicts found between a.stl and b.stl");
${die ? 'process.kill(process.pid, "SIGKILL");' : ""}
`);
  chmodSync(path, 0o755);
  return { executablePath: path, profilesDir: "" };
}

test("a crash after a complete export keeps the G-code and says why", { skip }, async () => {
  const dir = tempDir();
  const outcome = await sliceToGcode(fakeSlicer(dir, { complete: true, die: true }), {
    inputPath: "plate.3mf", outputPath: join(dir, "out.gcode"),
  });
  assert.equal(outcome.ok, true);
  assert.match(outcome.warnings[0], /crashed \(SIGKILL\) after writing complete G-code.*toolpaths overlap/);
  assert.equal(outcome.stats.filamentUsedMm, 12.5);
  assert.ok(outcome.errors.some((e) => /path conflicts/.test(e)));
});

test("a crash mid-export fails", { skip }, async () => {
  const dir = tempDir();
  const outcome = await sliceToGcode(fakeSlicer(dir, { complete: false, die: true }), {
    inputPath: "plate.3mf", outputPath: join(dir, "out.gcode"),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.errors[0], /crashed \(SIGKILL\) while writing G-code/);
});

test("a clean exit needs no end marker", { skip }, async () => {
  const dir = tempDir();
  const outcome = await sliceToGcode(fakeSlicer(dir, { complete: false, die: false }), {
    inputPath: "plate.3mf", outputPath: join(dir, "out.gcode"),
  });
  assert.equal(outcome.ok, true);
  assert.ok(!outcome.warnings.some((w) => /crashed/.test(w)));
});
