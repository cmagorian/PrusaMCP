import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { dirname, basename, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { unlink } from "node:fs/promises";
import type { PrusaConfig, MeshAnalysis, GCodeStats } from "../types.js";
import { sliceToGcode, type SliceOutcome, type SliceRequest } from "../prusa-cli.js";
import { recommendProfile } from "../profile-engine.js";
import { writeRawIniFile, profileToIniSettings, supportSettings } from "../ini-writer.js";
import { parseStl } from "../stl-parser.js";
import { analyzeMesh } from "../mesh-analyzer.js";
import { readGuiPresets, type PresetSelection } from "../presets.js";
import { arrangeModels } from "../plate-builder.js";
import { write3mf } from "../threemf.js";
import { bedInput, bedOf, errorMessage, errorResult, pickSupportOptions, supportInputs, textResult } from "./shared-schemas.js";

export function registerSlice(server: McpServer, config: PrusaConfig) {
  server.registerTool(
    "slice_prusaslicer",
    {
      title: "Slice a model with PrusaSlicer",
      description:
        "Slices an STL or 3MF with the PrusaSlicer CLI and reports G-code path, print time, filament, support " +
        "filament, and warnings. Settings come from, lowest priority first: the 3MF's embedded config, PrusaSlicer " +
        "presets by name (or the presets selected in the GUI), a .ini file (config_path, or one generated from goal " +
        "when no presets are given), then the support options here. Pass compare_path to slice a second model with " +
        "identical settings and get the difference, e.g. a plate with and without support volumes. A GUI-built " +
        "multi-material 3MF keeps its tool assignments when sliced with no config or with matching MMU presets.",
      inputSchema: {
        stl_path: z.string().describe("Absolute path to the STL or 3MF"),
        config_path: z.string().optional().describe("PrusaSlicer .ini to load"),
        output_gcode: z.string().optional().describe("G-code output path (default: beside the model)"),
        goal: z.string().optional().describe("Without config_path or presets: print intent for a generated profile"),
        printer: z.string().optional().describe("Printer name for the generated profile"),
        nozzle: z.number().optional().describe("Nozzle diameter for the generated profile"),
        material: z.string().optional().describe("Material for the generated profile"),
        printer_profile: z.string().optional().describe("PrusaSlicer printer preset name, e.g. 'Original Prusa i3 MK3S & MK3S+'"),
        print_profile: z.string().optional().describe("PrusaSlicer print preset name, e.g. '0.15mm QUALITY @MK3'"),
        material_profile: z.string().optional().describe("PrusaSlicer filament preset name, e.g. 'Prusament PLA'"),
        use_gui_presets: z.boolean().default(false).describe("Start from the presets currently selected in the PrusaSlicer GUI"),
        datadir: z.string().optional().describe("PrusaSlicer configuration folder (default: detected)"),
        ...supportInputs,
        arrange: z.boolean().default(false).describe("Re-arrange the model's objects on the bed before slicing"),
        bed_size: bedInput,
        compare_path: z.string().optional().describe("Second STL/3MF to slice with the same settings for a side-by-side"),
        timeout_seconds: z.number().int().min(10).default(600),
      },
    },
    async (input) => {
      const temps: string[] = [];
      try {
        const { stl_path, config_path, output_gcode, goal, compare_path } = input;
        if (!config.executablePath) {
          return errorResult("PrusaSlicer not found. Install it or set PRUSASLICER_PATH.");
        }
        for (const p of [stl_path, config_path, compare_path]) {
          if (p && !existsSync(p)) return errorResult(`File not found: ${p}`);
        }

        // Presets
        const datadir = input.datadir ?? (config.profilesDir || undefined);
        let presets: PresetSelection = {};
        if (input.use_gui_presets) {
          if (!datadir) return errorResult("No PrusaSlicer configuration folder found. Pass datadir.");
          presets = readGuiPresets(datadir);
        }
        presets = {
          printer: input.printer_profile ?? presets.printer,
          print: input.print_profile ?? presets.print,
          material: input.material_profile ?? presets.material,
        };
        const usingPresets = Boolean(presets.printer || presets.print || presets.material);
        const notes: string[] = [];

        // Generated profile, only when nothing better is given
        let iniPath = config_path;
        if (!iniPath && goal && !usingPresets) {
          let meshAnalysis: MeshAnalysis | undefined;
          if (stl_path.toLowerCase().endsWith(".stl")) {
            meshAnalysis = analyzeMesh(await parseStl(stl_path));
          }
          const profile = recommendProfile(input.printer ?? "Generic", input.nozzle ?? 0.4, goal, input.material ?? "PLA", meshAnalysis);
          iniPath = join(tmpdir(), `prusaslicer-slice-${Date.now()}.ini`);
          await writeRawIniFile(profileToIniSettings(profile), iniPath);
          temps.push(iniPath);
        } else if (goal && usingPresets) {
          notes.push("goal was ignored because presets were given.");
        }

        // Optional re-arrange
        const prepare = async (path: string, tag: string): Promise<string> => {
          if (!input.arrange) return path;
          const arranged = await arrangeModels([{ path }], { bed: bedOf(input.bed_size) });
          if (arranged.unplaced.length > 0) throw new Error(`${basename(path)} does not fit on the bed`);
          const out = join(tmpdir(), `prusamcp-${tag}-${Date.now()}.3mf`);
          await write3mf(arranged.plate, out);
          temps.push(out);
          return out;
        };

        const base: Omit<SliceRequest, "inputPath" | "outputPath"> = {
          iniPath,
          datadir,
          presets: usingPresets ? presets : undefined,
          overrides: supportSettings(pickSupportOptions(input)),
          timeoutMs: input.timeout_seconds * 1000,
        };

        const gcodePath = output_gcode ?? resolve(dirname(stl_path), basename(stl_path).replace(/\.[^.]+$/, ".gcode"));
        const main = await sliceToGcode(config, { ...base, inputPath: await prepare(stl_path, "main"), outputPath: gcodePath });

        let other: SliceOutcome | null = null;
        if (compare_path) {
          const comparePath = gcodePath.replace(/\.gcode$/i, "") + ".compare.gcode";
          other = await sliceToGcode(config, { ...base, inputPath: await prepare(compare_path, "compare"), outputPath: comparePath });
        }

        if (!main.ok) {
          // PrusaSlicer's reason for refusing can arrive as an unlabeled line, so show everything it said
          return errorResult([
            `Slicing failed for ${basename(stl_path)}:`,
            ...[...main.errors, ...main.warnings].map((e) => `- ${e}`),
            "",
            `Command: prusa-slicer ${main.args.map(quote).join(" ")}`,
          ].join("\n"));
        }

        const settingsLine = [
          usingPresets && `presets ${[presets.printer, presets.print, presets.material].filter(Boolean).join(" / ")}`,
          iniPath && `ini ${iniPath === config_path ? iniPath : "(generated)"}`,
          Object.keys(base.overrides ?? {}).length > 0 &&
            `overrides ${Object.entries(base.overrides!).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        ].filter(Boolean).join("; ") || "embedded 3MF config or PrusaSlicer defaults";

        return textResult([
          `## Sliced ${basename(stl_path)}`,
          `**G-code**: ${main.gcodePath}`,
          `**Settings**: ${settingsLine}`,
          `**PrusaSlicer**: ${config.version || "unknown version"}`,
          "",
          ...statsLines(main.stats),
          ...messageLines(main),
          ...(other ? compareLines(basename(stl_path), main, basename(compare_path!), other) : []),
          ...notes.map((n) => `_Note: ${n}_`),
        ]);
      } catch (error) {
        return errorResult(`Slicing error: ${errorMessage(error)}`);
      } finally {
        for (const t of temps) {
          try { await unlink(t); } catch { /* ignore */ }
        }
      }
    },
  );
}

function statsLines(s: GCodeStats): string[] {
  const supportShare = s.supportFilamentMm !== undefined && s.filamentUsedMm
    ? ` (${((s.supportFilamentMm / s.filamentUsedMm) * 100).toFixed(1)}% of filament)` : "";
  return [
    s.estimatedTime && `- **Print time**: ${s.estimatedTime}`,
    s.filamentUsedG !== undefined && `- **Filament**: ${s.filamentUsedG} g, ${s.filamentUsedMm ?? "?"} mm`,
    s.filamentCost !== undefined && `- **Filament cost**: ${s.filamentCost}`,
    s.layerCount !== undefined && `- **Layers**: ${s.layerCount}`,
    `- **Support**: ${s.supportFilamentMm ?? 0} mm of filament on ${s.supportLayers ?? 0} layers${supportShare}`,
  ].filter((l): l is string => Boolean(l));
}

/**
 * PrusaSlicer logs some non-fatal problems at error level, so once G-code exists they read as warnings.
 */
function messageLines(o: SliceOutcome): string[] {
  const messages = [...o.errors, ...o.warnings];
  if (messages.length === 0) return [];
  const lines = ["", "### Warnings", ...messages.map((m) => `- ${m}`)];
  if (messages.some((m) => /path conflicts/i.test(m))) {
    lines.push("- Toolpaths of neighboring objects collide, often their supports. Re-run arrange_plate with a larger spacing.");
  }
  return lines;
}

function compareLines(nameA: string, a: SliceOutcome, nameB: string, b: SliceOutcome): string[] {
  if (!b.ok) {
    return ["", `### Comparison`, `Slicing ${nameB} failed: ${b.errors.join("; ")}`];
  }
  const row = (label: string, x?: number, y?: number, unit = "") => {
    if (x === undefined || y === undefined) return `| ${label} | ${x ?? "?"} | ${y ?? "?"} | ? |`;
    const d = Math.round((x - y) * 100) / 100;
    return `| ${label} | ${x}${unit} | ${y}${unit} | ${d > 0 ? "+" : ""}${d}${unit} |`;
  };
  return [
    "",
    `### Comparison (same settings)`,
    `| | ${nameA} | ${nameB} | Difference |`,
    "| --- | --- | --- | --- |",
    `| Print time | ${a.stats.estimatedTime ?? "?"} | ${b.stats.estimatedTime ?? "?"} | ${formatDelta((a.stats.estimatedTimeSeconds ?? 0) - (b.stats.estimatedTimeSeconds ?? 0))} |`,
    row("Filament", a.stats.filamentUsedG, b.stats.filamentUsedG, " g"),
    row("Support filament", a.stats.supportFilamentMm, b.stats.supportFilamentMm, " mm"),
    row("Support layers", a.stats.supportLayers, b.stats.supportLayers),
    `G-code for ${nameB}: ${b.gcodePath}`,
    ...messageLines(b).map((l) => l.replace("### ", `### ${nameB} `)),
  ];
}

function formatDelta(seconds: number): string {
  const sign = seconds > 0 ? "+" : seconds < 0 ? "-" : "";
  const s = Math.abs(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return `${sign}${h > 0 ? `${h}h ` : ""}${m}m ${r}s`;
}

function quote(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}
