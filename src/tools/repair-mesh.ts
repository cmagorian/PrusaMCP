import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import type { PrusaConfig } from "../types.js";
import { parseStl } from "../stl-parser.js";
import { weld } from "../mesh.js";
import { repairMesh, writeBinaryStl, type MeshHealth, type RepairReport } from "../mesh-repair.js";
import { read3mf, readZipEntries, write3mf } from "../threemf.js";
import { modelInfo } from "../prusa-cli.js";
import { outputBeside } from "./arrange-plate.js";
import { errorMessage, errorResult, textResult } from "./shared-schemas.js";

export function registerRepairMesh(server: McpServer, config: PrusaConfig) {
  server.registerTool(
    "repair_mesh",
    {
      title: "Repair a mesh before slicing",
      description:
        "Fixes an STL or 3MF and writes a repaired copy in the same format. Welds duplicate vertices, drops " +
        "degenerate and duplicate faces, makes face winding consistent, fills holes, and turns inside-out " +
        "shells outward. PrusaSlicer's CLI has no repair flag and its load-time fix leaves holes open, so " +
        "this fills that gap. Reports PrusaSlicer's own --info view before and after when it is installed.",
      inputSchema: {
        path: z.string().describe("Absolute path to an STL or 3MF"),
        output_path: z.string().optional().describe("Output path (default: <name>.repaired.<ext>)"),
        max_hole_edges: z.number().int().min(3).default(200).describe("Leave holes with more edges than this open"),
      },
    },
    async ({ path, output_path, max_hole_edges }) => {
      try {
        if (!existsSync(path)) return errorResult(`File not found: ${path}`);
        const lower = path.toLowerCase();
        const reports: { name: string; report: RepairReport }[] = [];
        let outPath: string;

        if (lower.endsWith(".stl")) {
          outPath = output_path ?? outputBeside(path, ".repaired.stl");
          const stl = await parseStl(path);
          const { mesh, report } = repairMesh(weld(stl.triangles, 1e-6), { maxHoleEdges: max_hole_edges });
          await writeBinaryStl(mesh, outPath, stl.name);
          reports.push({ name: stl.name, report });
        } else if (lower.endsWith(".3mf")) {
          outPath = output_path ?? outputBeside(path, ".repaired.3mf");
          const plate = await read3mf(path);
          for (const obj of plate.objects) {
            for (const vol of obj.volumes) {
              if (vol.type !== "ModelPart") continue;
              const { mesh, report } = repairMesh(vol.mesh, { maxHoleEdges: max_hole_edges });
              vol.mesh = mesh;
              reports.push({ name: `${obj.name} / ${vol.name}`, report });
            }
          }
          await write3mf(plate, outPath, await readZipEntries(path));
        } else {
          return errorResult("Supported formats: STL, 3MF");
        }

        let cliBefore: Record<string, string>[] = [];
        let cliAfter: Record<string, string>[] = [];
        if (config.executablePath) {
          [cliBefore, cliAfter] = await Promise.all([modelInfo(config, path), modelInfo(config, outPath)]);
        }

        const lines: (string | false)[] = [`## Mesh repaired`, `**Output**: ${outPath}`, ""];
        for (const { name, report } of reports) {
          lines.push(
            `### ${name}`,
            "| | Faces | Open edges | Non-manifold edges | Shells | Volume (mm³) |",
            "| --- | --- | --- | --- | --- | --- |",
            healthRow("Before", report.before),
            healthRow("After", report.after),
            "",
            `Welded ${report.verticesWelded} vertices, removed ${report.degenerateRemoved} degenerate and ` +
            `${report.duplicatesRemoved} duplicate faces, flipped ${report.facesFlipped} faces, ` +
            `turned ${report.shellsInverted} shells outward, filled ${report.holesFilled} holes` +
            (report.holesSkipped > 0 ? `, left ${report.holesSkipped} holes open (too large or tangled)` : "") + ".",
            report.after.nonManifoldEdges > 0 &&
              `Non-manifold edges remain. They usually mean touching or overlapping shells; PrusaSlicer slices those as a union.`,
            "",
          );
        }

        if (cliAfter.length > 0) {
          lines.push(
            `### PrusaSlicer ${config.version ?? ""} --info`,
            "| | manifold | open_edges | facets_reversed | number_of_parts | volume |",
            "| --- | --- | --- | --- | --- | --- |",
            ...cliBefore.map((r, i) => infoRow(`Before${cliBefore.length > 1 ? ` #${i + 1}` : ""}`, r)),
            ...cliAfter.map((r, i) => infoRow(`After${cliAfter.length > 1 ? ` #${i + 1}` : ""}`, r)),
          );
        }

        return textResult(lines);
      } catch (error) {
        return errorResult(`Repair failed: ${errorMessage(error)}`);
      }
    },
  );
}

function healthRow(label: string, h: MeshHealth): string {
  return `| ${label} | ${h.faces} | ${h.openEdges} | ${h.nonManifoldEdges} | ${h.shells} | ${h.volume.toFixed(1)} |`;
}

function infoRow(label: string, r: Record<string, string>): string {
  return `| ${label} | ${r.manifold ?? "?"} | ${r.open_edges ?? "0"} | ${r.facets_reversed ?? "0"} | ${r.number_of_parts ?? "?"} | ${r.volume ?? "?"} |`;
}
