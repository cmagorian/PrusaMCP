import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import type { PrusaConfig } from "../types.js";
import { mergeModels, objectsOffBed } from "../plate-builder.js";
import { write3mf } from "../threemf.js";
import { modelInfo } from "../prusa-cli.js";
import { outputBeside } from "./arrange-plate.js";
import { bedInput, bedOf, errorMessage, errorResult, textResult } from "./shared-schemas.js";

export function registerMergeModels(server: McpServer, config: PrusaConfig) {
  server.registerTool(
    "merge_models",
    {
      title: "Merge models into one 3MF",
      description:
        "Combines STL/3MF files into one PrusaSlicer 3MF and keeps their positions relative to each other, " +
        "as for assembly parts exported in shared coordinates. mode 'objects' keeps each file a separate " +
        "object; mode 'parts' makes them parts of a single object. Use arrange_plate instead to spread " +
        "independent models across the bed.",
      inputSchema: {
        model_paths: z.array(z.string()).min(1).describe("Absolute paths to STL or 3MF files"),
        mode: z.enum(["objects", "parts"]).default("objects"),
        name: z.string().optional().describe("Object name in 'parts' mode"),
        center_on_bed: z.boolean().default(true).describe("Center the group on the bed (otherwise keep source XY)"),
        bed_size: bedInput,
        output_path: z.string().optional().describe("Output .3mf path (default: <first model>.merged.3mf)"),
      },
    },
    async ({ model_paths, mode, name, center_on_bed, bed_size, output_path }) => {
      try {
        const missing = model_paths.filter((p) => !existsSync(p));
        if (missing.length > 0) return errorResult(`File not found: ${missing.join(", ")}`);

        const bed = bedOf(bed_size);
        const plate = await mergeModels(model_paths.map((path) => ({ path })), {
          mode, name, bed, centerOnBed: center_on_bed,
        });

        const outPath = output_path ?? outputBeside(model_paths[0], ".merged.3mf");
        await write3mf(plate, outPath);

        const offBed = objectsOffBed(plate, bed);
        const objectCount = plate.objects.length;
        const partCount = plate.objects.reduce((n, o) => n + o.volumes.length, 0);
        let check: string | null = null;
        if (config.executablePath) {
          const info = await modelInfo(config, outPath);
          check = `PrusaSlicer ${config.version ?? ""} reads ${info.length} object(s).`;
        }

        return textResult([
          `## Models merged`,
          `**3MF**: ${outPath}`,
          `**Layout**: ${objectCount} object(s), ${partCount} part(s), mode '${mode}'`,
          offBed.length > 0 && `**Outside the ${bed.x} × ${bed.y} mm bed**: ${offBed.join(", ")}`,
          check,
        ]);
      } catch (error) {
        return errorResult(`Merge failed: ${errorMessage(error)}`);
      }
    },
  );
}
