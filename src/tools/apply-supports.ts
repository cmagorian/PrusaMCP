import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import type { Vec3 } from "../types.js";
import { bounds } from "../mesh.js";
import { planSupports } from "../support-planner.js";
import { appendVolumes, bedBoxToObjectMesh, plateObjectWorldMesh, read3mf, type AddedVolume } from "../threemf.js";
import { DEFAULT_OVERHANG_ANGLE, loadPlanObjects, overhangAngleInput } from "./plan-supports.js";
import { outputBeside } from "./arrange-plate.js";
import { errorMessage, errorResult, textResult } from "./shared-schemas.js";

const vec3 = z.object({ x: z.number(), y: z.number(), z: z.number() });

export function registerApplySupports(server: McpServer) {
  server.registerTool(
    "apply_supports",
    {
      title: "Add support enforcers and blockers to a 3MF",
      description:
        "Writes a copy of a plate 3MF with support enforcer and blocker volumes added. Volumes come from " +
        "plan_supports region ids (re-planned here with the same overhang_angle) or from explicit boxes in " +
        "bed coordinates. Everything else in the 3MF is kept, including paint, MMU segmentation, per-object " +
        "settings, and the embedded print config. Enforcers only act when support_material is on; with " +
        "support_material_auto off, supports appear only inside enforcers. Blockers must cover the whole " +
        "overhang, so boxes extend past each region by the margin.",
      inputSchema: {
        path: z.string().describe("Absolute path to a plate 3MF (make one from STL with arrange_plate)"),
        enforce: z.array(z.number().int().positive()).default([]).describe("Region ids to cover with enforcers"),
        block: z.array(z.number().int().positive()).default([]).describe("Region ids to cover with blockers"),
        overhang_angle: overhangAngleInput,
        margin: z.number().min(0).default(2).describe("How far (mm) region volumes extend past each region"),
        boxes: z.array(z.object({
          type: z.enum(["enforcer", "blocker"]),
          min: vec3,
          max: vec3,
          object: z.number().int().positive().optional()
            .describe("Plate object number (1-based). Omit to add to every object the box touches."),
        })).default([]).describe("Extra volumes as bed-coordinate boxes"),
        output_path: z.string().optional().describe("Output .3mf path (default: <name>.supports.3mf)"),
      },
    },
    async ({ path, enforce, block, overhang_angle, margin, boxes, output_path }) => {
      try {
        if (!existsSync(path)) return errorResult(`File not found: ${path}`);
        if (!path.toLowerCase().endsWith(".3mf")) {
          return errorResult("apply_supports needs a 3MF. Run arrange_plate on the STL first, then plan_supports on that plate.");
        }
        if (enforce.length + block.length + boxes.length === 0) {
          return errorResult("Nothing to add. Pass region ids in enforce/block, or boxes.");
        }
        const both = enforce.filter((id) => block.includes(id));
        if (both.length > 0) return errorResult(`Regions in both enforce and block: ${both.join(", ")}`);

        const { objects, plate } = await loadPlanObjects(path);
        const angle = overhang_angle ?? DEFAULT_OVERHANG_ANGLE;
        const plan = planSupports(objects, { overhangAngle: angle, minArea: 0, margin });
        const byId = new Map(plan.regions.map((r) => [r.id, r]));

        const unknown = [...enforce, ...block].filter((id) => !byId.has(id));
        if (unknown.length > 0) {
          return errorResult(
            `Unknown region ids ${unknown.join(", ")}. This plate has ${plan.regions.length} region(s) at ${angle}°. ` +
            `Re-run plan_supports on this exact file with the same overhang_angle.`,
          );
        }

        const added: AddedVolume[] = [];
        const describe: string[] = [];
        const addRegion = (id: number, type: "SupportEnforcer" | "SupportBlocker") => {
          const r = byId.get(id)!;
          const obj = plate!.objects[r.objectIndex];
          const label = type === "SupportEnforcer" ? "enforcer" : "blocker";
          added.push({ objectId: obj.id, name: `${label} R${id}`, type, mesh: bedBoxToObjectMesh(obj, r.volumeBox.min, r.volumeBox.max) });
          describe.push(`| ${label} R${id} | ${obj.name} | ${fmtBox(r.volumeBox.min, r.volumeBox.max)} |`);
        };
        enforce.forEach((id) => addRegion(id, "SupportEnforcer"));
        block.forEach((id) => addRegion(id, "SupportBlocker"));

        boxes.forEach((b, i) => {
          const min = { x: Math.min(b.min.x, b.max.x), y: Math.min(b.min.y, b.max.y), z: Math.max(0, Math.min(b.min.z, b.max.z)) };
          const max = { x: Math.max(b.min.x, b.max.x), y: Math.max(b.min.y, b.max.y), z: Math.max(b.min.z, b.max.z) };
          const targets = b.object !== undefined
            ? [plate!.objects[b.object - 1]].filter(Boolean)
            : plate!.objects.filter((obj) => touches(bounds(plateObjectWorldMesh(obj, 0).vertices), { min, max }));
          if (targets.length === 0) throw new Error(`Box ${i + 1} does not touch any object on the plate`);

          const type = b.type === "enforcer" ? "SupportEnforcer" : "SupportBlocker";
          for (const obj of targets) {
            added.push({ objectId: obj.id, name: `${b.type} box ${i + 1}`, type, mesh: bedBoxToObjectMesh(obj, min, max) });
            describe.push(`| ${b.type} box ${i + 1} | ${obj.name} | ${fmtBox(min, max)} |`);
          }
        });

        const outPath = output_path ?? path.replace(/\.3mf$/i, "") + ".supports.3mf";
        if (outPath === path) return errorResult("output_path must differ from the input so the original stays intact.");
        await appendVolumes(path, outPath, added);

        // Read the result back to confirm every volume landed with its type
        const check = await read3mf(outPath);
        const counts = check.objects.map((o) => {
          const n = (t: string) => o.volumes.filter((v) => v.type === t).length;
          return `${o.name}: ${n("SupportEnforcer")} enforcer(s), ${n("SupportBlocker")} blocker(s)`;
        });

        return textResult([
          `## Support volumes added`,
          `**3MF**: ${outPath}`,
          "",
          "| Volume | Object | Box min → max (mm, bed) |",
          "| --- | --- | --- |",
          ...describe,
          "",
          `Read back: ${counts.join("; ")}.`,
          "",
          "Slice with support_material: true. Set support_material_auto: false for supports only inside enforcers.",
          `Compare costs with slice_prusaslicer(stl_path: "${outPath}", compare_path: "${path}").`,
          "Open the 3MF in PrusaSlicer to check the volumes by eye before printing.",
        ]);
      } catch (error) {
        return errorResult(`apply_supports failed: ${errorMessage(error)}`);
      }
    },
  );
}

function touches(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): boolean {
  return a.min.x <= b.max.x && a.max.x >= b.min.x && a.min.y <= b.max.y && a.max.y >= b.min.y && a.min.z <= b.max.z && a.max.z >= b.min.z;
}

function fmtBox(min: Vec3, max: Vec3): string {
  const f = (v: Vec3) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;
  return `${f(min)} → ${f(max)}`;
}
