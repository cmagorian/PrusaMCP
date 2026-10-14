import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { PrusaConfig } from "../types.js";
import { DEFAULT_SUPPORT_CLEARANCE, arrangeModels, objectsOffBed } from "../plate-builder.js";
import { write3mf } from "../threemf.js";
import { modelInfo } from "../prusa-cli.js";
import { bedInput, bedOf, errorMessage, errorResult, mm, textResult } from "./shared-schemas.js";

export function outputBeside(inputPath: string, suffix: string): string {
  return join(dirname(inputPath), basename(inputPath).replace(/\.[^.]+$/, "") + suffix);
}

export function registerArrangePlate(server: McpServer, config: PrusaConfig) {
  server.registerTool(
    "arrange_plate",
    {
      title: "Arrange models on a plate",
      description:
        "Lays out STL/3MF models on the print bed and writes a PrusaSlicer plate 3MF with each model " +
        "as its own object. Applies optional per-model rotations first, so the pose picked with " +
        "suggest_orientation can be baked in (rotate_x/rotate_y match its X/Y values). Packs bounding " +
        "rectangles, turning items 90° when that fits better. Objects whose support would stand on the bed " +
        "get extra room for PrusaSlicer's widened first support layer; without it, neighboring supports can " +
        "merge, and PrusaSlicer 2.9.6's CLI crashes on those toolpath conflicts. Use the output 3MF for " +
        "plan_supports, apply_supports, and slice_prusaslicer.",
      inputSchema: {
        models: z.array(z.object({
          path: z.string().describe("Absolute path to an STL or 3MF"),
          copies: z.number().int().min(1).max(100).optional().describe("Number of copies (default 1)"),
          rotate_x: z.number().optional().describe("Rotation about X in degrees, applied first"),
          rotate_y: z.number().optional().describe("Rotation about Y in degrees, applied second"),
          rotate_z: z.number().optional().describe("Rotation about Z in degrees, applied third"),
        })).min(1),
        bed_size: bedInput,
        spacing: z.number().min(0).default(6).describe("Gap between objects in mm (PrusaSlicer's default is 6)"),
        allow_rotation: z.boolean().default(true).describe("Allow turning objects 90° about Z to fit"),
        support_clearance: z.number().min(0).default(DEFAULT_SUPPORT_CLEARANCE)
          .describe("Extra mm on each side of objects that need support from the bed. 0 turns it off."),
        output_path: z.string().optional().describe("Output .3mf path (default: <first model>.plate.3mf)"),
      },
    },
    async ({ models, bed_size, spacing, allow_rotation, support_clearance, output_path }) => {
      try {
        const missing = models.filter((m) => !existsSync(m.path)).map((m) => m.path);
        if (missing.length > 0) return errorResult(`File not found: ${missing.join(", ")}`);

        const bed = bedOf(bed_size);
        const result = await arrangeModels(
          models.map((m) => ({ path: m.path, copies: m.copies, rotateX: m.rotate_x, rotateY: m.rotate_y, rotateZ: m.rotate_z })),
          { bed, spacing, allowRotation: allow_rotation, supportClearance: support_clearance },
        );

        if (result.items.length === 0) {
          return errorResult(`Nothing fits on a ${bed.x} × ${bed.y} mm bed.`);
        }

        const outPath = output_path ?? outputBeside(models[0].path, ".plate.3mf");
        await write3mf(result.plate, outPath);

        const offBed = objectsOffBed(result.plate, bed);
        let check: string | null = null;
        if (config.executablePath) {
          const info = await modelInfo(config, outPath);
          check = info.length === result.plate.objects.length
            ? `PrusaSlicer ${config.version ?? ""} reads ${info.length} object(s) from the plate.`
            : `**Check failed**: PrusaSlicer ${config.version ?? ""} read ${info.length} of ${result.plate.objects.length} objects.`;
        }

        return textResult([
          `## Plate arranged`,
          `**3MF**: ${outPath}`,
          `**Bed**: ${bed.x} × ${bed.y} mm, ${(result.bedCoverage * 100).toFixed(0)}% covered`,
          "",
          "| Object | Copy | Center X, Y (mm) | Size X × Y × Z (mm) | Turned 90° | Support room (mm) |",
          "| --- | --- | --- | --- | --- | --- |",
          ...result.items.map((i) =>
            `| ${i.objectName} | ${i.copy} | ${mm(i.center.x)}, ${mm(i.center.y)} | ${mm(i.size.x)} × ${mm(i.size.y)} × ${mm(i.size.z)} | ${i.rotatedOnBed ? "yes" : "no"} | ${i.supportRoom} |`),
          result.clearanceDropped && "",
          result.clearanceDropped &&
            "**No support room**: the models only fit without it. Neighboring supports may merge; slice and check for path conflicts.",
          result.unplaced.length > 0 && "",
          result.unplaced.length > 0 && `**Did not fit**: ${result.unplaced.map((u) => `${u.objectName} (${mm(u.size.x)} × ${mm(u.size.y)} mm)`).join(", ")}`,
          offBed.length > 0 && `**Outside the bed**: ${offBed.join(", ")}`,
          check && "",
          check,
        ]);
      } catch (error) {
        return errorResult(`Arrange failed: ${errorMessage(error)}`);
      }
    },
  );
}
