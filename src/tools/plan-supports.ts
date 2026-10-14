import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { Vec3 } from "../types.js";
import { parseStl } from "../stl-parser.js";
import { weld } from "../mesh.js";
import { read3mf, plateObjectWorldMesh, type Plate } from "../threemf.js";
import { planSupports, type OverhangRegion, type PlanObject, type Side } from "../support-planner.js";
import { errorMessage, errorResult, mm, textResult } from "./shared-schemas.js";

export const DEFAULT_OVERHANG_ANGLE = 45;

export async function loadPlanObjects(path: string): Promise<{ objects: PlanObject[]; plate?: Plate }> {
  const lower = path.toLowerCase();
  if (lower.endsWith(".stl")) {
    const stl = await parseStl(path);
    return { objects: [{ index: 0, name: basename(path), mesh: weld(stl.triangles) }] };
  }
  if (lower.endsWith(".3mf")) {
    const plate = await read3mf(path);
    const objects = plate.objects.map((obj, index) => ({
      index,
      objectId: obj.id,
      name: obj.name,
      mesh: plateObjectWorldMesh(obj, 0),
    }));
    return { objects, plate };
  }
  throw new Error("Supported formats: STL, 3MF");
}

/**
 * Overhang angle from a PrusaSlicer .ini, when it sets a nonzero support_material_threshold.
 */
export function thresholdFromIni(iniPath: string): number | undefined {
  const value = readFileSync(iniPath, "utf-8").match(/^\s*support_material_threshold\s*=\s*([\d.]+)/m)?.[1];
  const n = value ? parseFloat(value) : NaN;
  return n > 0 ? n : undefined;
}

const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const overhangAngleInput = z.number().min(1).max(89).optional()
  .describe(`Overhang angle in degrees from horizontal; flatter faces need support. Default: the config's support_material_threshold, else ${DEFAULT_OVERHANG_ANGLE}.`);

export function registerPlanSupports(server: McpServer) {
  server.registerTool(
    "plan_supports",
    {
      title: "Plan supports by overhang region",
      description:
        "Finds overhang faces, groups touching faces into regions, and gives each region an id, area, height " +
        "range, what its support would stand on (bed or model), and a verdict: 'slicer' (small or shallow, " +
        "leave to PrusaSlicer), 'enforce' (large, over open air), 'review' (support would stand on the model), " +
        "or 'block' (cosmetic faces). Faces lying on the bed are ignored. Run it on the plate 3MF you will pass " +
        "to apply_supports, with the same overhang_angle, so region ids match. Advisory: check the result in " +
        "PrusaSlicer before printing.",
      inputSchema: {
        path: z.string().describe("Absolute path to an STL or 3MF (3MF positions are used as placed on the bed)"),
        overhang_angle: overhangAngleInput,
        config_path: z.string().optional().describe("PrusaSlicer .ini to read support_material_threshold from"),
        min_area: z.number().min(0).default(20).describe("Regions with less projected area (mm²) stay with the slicer"),
        cosmetic_sides: z.array(z.enum(["top", "bottom", "front", "back", "left", "right"])).optional()
          .describe("Sides that must stay clean, in bed coordinates (front is -Y). A face counts when its normal is within 60° of the side."),
        cosmetic_box: z.object({ min: vec3, max: vec3 }).optional()
          .describe("Bed-coordinate box; faces with centroids inside count as cosmetic"),
        margin: z.number().min(0).default(2).describe("How far (mm) suggested volumes extend past each region"),
      },
    },
    async ({ path, overhang_angle, config_path, min_area, cosmetic_sides, cosmetic_box, margin }) => {
      try {
        if (!existsSync(path)) return errorResult(`File not found: ${path}`);

        const fromIni = config_path && existsSync(config_path) ? thresholdFromIni(config_path) : undefined;
        const angle = overhang_angle ?? fromIni ?? DEFAULT_OVERHANG_ANGLE;
        const { objects } = await loadPlanObjects(path);
        const plan = planSupports(objects, {
          overhangAngle: angle,
          minArea: min_area,
          margin,
          cosmeticSides: cosmetic_sides as Side[] | undefined,
          cosmeticBox: cosmetic_box,
        });

        const { regions, totals } = plan;
        const enforce = regions.filter((r) => r.verdict === "enforce").map((r) => r.id);
        const block = regions.filter((r) => r.verdict === "block").map((r) => r.id);
        const review = regions.filter((r) => r.verdict === "review").map((r) => r.id);

        return textResult([
          `## Support plan: ${basename(path)}`,
          `Overhang angle ${angle}° from horizontal${fromIni && overhang_angle === undefined ? " (from config)" : ""}, ` +
          `min area ${min_area} mm², ${objects.length} object(s).`,
          `${regions.length} region(s): ${totals.enforce} enforce, ${totals.review} review, ${totals.block} block, ${totals.slicer} slicer.`,
          "",
          regions.length > 0 && "| ID | Object | Verdict | Area (mm²) | Z (mm) | Slope | Lands on | Volume box min → max (mm) |",
          regions.length > 0 && "| --- | --- | --- | --- | --- | --- | --- | --- |",
          ...regions.map(regionRow),
          "",
          ...regions.filter((r) => r.verdict !== "slicer").map((r) =>
            `- **R${r.id}** ${r.reason}${r.overlaps.length > 0 ? ` Its box also covers R${r.overlaps.join(", R")}.` : ""}`),
          "",
          "### Next steps",
          enforce.length + block.length > 0
            ? `- apply_supports with enforce: [${enforce.join(", ")}], block: [${block.join(", ")}], overhang_angle: ${angle}`
            : "- No region needs a volume. Slice with PrusaSlicer's automatic supports.",
          review.length > 0 && `- Decide on review regions ${review.map((id) => `R${id}`).join(", ")}: enforce them, or slice with support_material_buildplate_only.`,
          "- Enforcers only, nothing else: slice with support_material: true, support_material_auto: false.",
          "- Automatic supports plus these volumes: slice with support_material: true, support_material_auto: true.",
          "- Pass compare_path to slice_prusaslicer to see the filament and time cost against the plate without volumes.",
        ]);
      } catch (error) {
        return errorResult(`Support planning failed: ${errorMessage(error)}`);
      }
    },
  );
}

function regionRow(r: OverhangRegion): string {
  const box = (v: Vec3) => `${mm(v.x)}, ${mm(v.y)}, ${mm(v.z)}`;
  const lands = r.landsOn === "mixed" ? `mixed (${Math.round(r.bedFraction * 100)}% bed)` : r.landsOn;
  return `| R${r.id} | ${r.objectName} | ${r.verdict} | ${mm(r.projectedArea)} | ${mm(r.zMin)}–${mm(r.zMax)} | ${mm(r.meanSlope, 0)}° | ${lands} | ${box(r.volumeBox.min)} → ${box(r.volumeBox.max)} |`;
}
