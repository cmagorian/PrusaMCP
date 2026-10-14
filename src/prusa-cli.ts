import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import type { PrusaConfig, CliResult, GCodeStats } from "./types.js";

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export function runPrusaSlicer(
  config: PrusaConfig,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT,
): Promise<CliResult> {
  if (!config.executablePath) {
    return Promise.resolve({
      exitCode: 1,
      stdout: "",
      stderr: "PrusaSlicer not found. Install PrusaSlicer or set PRUSASLICER_PATH.",
    });
  }

  return new Promise((resolve) => {
    execFile(
      config.executablePath,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        let exitCode = 0;
        if (error && "code" in error && typeof error.code === "number") {
          exitCode = error.code;
        } else if (error) {
          exitCode = 1;
        }

        // A signal without our timeout kill means PrusaSlicer crashed
        const timedOut = Boolean(error?.killed);
        const signal = !timedOut && error?.signal ? error.signal : undefined;
        resolve({
          exitCode,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          signal,
          timedOut,
        });
      },
    );
  });
}

/**
 * Parse G-code file for slicing statistics (embedded as comments by PrusaSlicer).
 */
export async function parseGCodeStats(gcodePath: string): Promise<GCodeStats> {
  const content = await readFile(gcodePath, "utf-8");
  const stats: GCodeStats = {};

  const timeMatch = content.match(
    /;\s*estimated printing time \(normal mode\)\s*=\s*(.+)/i,
  );
  if (timeMatch) {
    stats.estimatedTime = timeMatch[1].trim();
    stats.estimatedTimeSeconds = parseTimeToSeconds(timeMatch[1].trim());
  }

  const filamentMmMatch = content.match(
    /;\s*filament used \[mm\]\s*=\s*([\d.]+)/i,
  );
  if (filamentMmMatch) {
    stats.filamentUsedMm = parseFloat(filamentMmMatch[1]);
  }

  const filamentGMatch = content.match(
    /;\s*total filament used \[g\]\s*=\s*([\d.]+)/i,
  );
  if (filamentGMatch) {
    stats.filamentUsedG = parseFloat(filamentGMatch[1]);
  }

  const costMatch = content.match(
    /;\s*total filament cost\s*=\s*([\d.]+)/i,
  );
  if (costMatch) {
    stats.filamentCost = parseFloat(costMatch[1]);
  }

  const layerMatch = content.match(
    /;\s*total layers count\s*=\s*(\d+)/i,
  );
  if (layerMatch) {
    stats.layerCount = parseInt(layerMatch[1], 10);
  }

  Object.assign(stats, measureSupport(content));
  return stats;
}

/**
 * Filament extruded inside ";TYPE:Support material" sections, and the layers that hold any.
 * Handles both relative (M83) and absolute (M82) extrusion.
 */
export function measureSupport(gcode: string): { supportFilamentMm: number; supportLayers: number } {
  let relative = true;
  let inSupport = false;
  let lastE = 0;
  let supportFilamentMm = 0;
  let supportLayers = 0;
  let layerHasSupport = false;

  for (const line of gcode.split("\n")) {
    if (line.startsWith(";LAYER_CHANGE")) {
      if (layerHasSupport) supportLayers++;
      layerHasSupport = false;
    } else if (line.startsWith(";TYPE:")) {
      inSupport = line.startsWith(";TYPE:Support material");
    } else if (line.startsWith("M83")) {
      relative = true;
    } else if (line.startsWith("M82")) {
      relative = false;
    } else if (line.startsWith("G92")) {
      const e = line.match(/\bE(-?[\d.]+)/);
      if (e) lastE = parseFloat(e[1]);
    } else if (line.startsWith("G1 ") || line.startsWith("G0 ")) {
      const e = line.match(/\bE(-?[\d.]+)/);
      if (!e) continue;
      const value = parseFloat(e[1]);
      const delta = relative ? value : value - lastE;
      if (!relative) lastE = value;
      if (inSupport && delta > 0) {
        supportFilamentMm += delta;
        layerHasSupport = true;
      }
    }
  }
  if (layerHasSupport) supportLayers++;
  return { supportFilamentMm: Math.round(supportFilamentMm * 100) / 100, supportLayers };
}

/**
 * Split CLI output into warnings and errors, dropping progress lines.
 */
export function parseCliMessages(output: string): { warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];

  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d+ => /.test(line)) continue;
    if (/^(Slicing result exported to|File exported to)/.test(line)) continue;

    const tagged = line.match(/\[(warning|error|fatal)\]\s*:?\s*(.*)$/i);
    if (tagged) {
      (tagged[1].toLowerCase() === "warning" ? warnings : errors).push(tagged[2]);
      continue;
    }
    if (/^\[[^\]]*\]/.test(line)) continue; // other log levels
    if (/outside of the print volume|error|failed|cannot|could not|invalid/i.test(line)) errors.push(line);
    else warnings.push(line);
  }
  return { warnings: [...new Set(warnings)], errors: [...new Set(errors)] };
}

export interface SliceRequest {
  inputPath: string;
  outputPath: string;
  iniPath?: string;
  datadir?: string;
  presets?: { printer?: string; print?: string; material?: string };
  overrides?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}

export interface SliceOutcome {
  ok: boolean;
  gcodePath: string;
  stats: GCodeStats;
  warnings: string[];
  errors: string[];
  args: string[];
}

export function overrideArgs(overrides: Record<string, string | number | boolean>): string[] {
  return Object.entries(overrides).map(([key, value]) => {
    const v = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    return `--${key.replace(/_/g, "-")}=${v}`;
  });
}

/**
 * Slice one model to G-code. Success requires a G-code file written by this run, because
 * the CLI exits 0 even when it refuses to slice (e.g. objects outside the print volume).
 */
export async function sliceToGcode(config: PrusaConfig, req: SliceRequest): Promise<SliceOutcome> {
  const args: string[] = [];
  const { presets } = req;
  if (presets && (presets.printer || presets.print || presets.material)) {
    if (req.datadir) args.push("--datadir", req.datadir);
    if (presets.printer) args.push("--printer-profile", presets.printer);
    if (presets.print) args.push("--print-profile", presets.print);
    if (presets.material) args.push("--material-profile", presets.material);
  }
  if (req.iniPath) args.push("--load", req.iniPath);
  if (req.overrides) args.push(...overrideArgs(req.overrides));
  args.push("--export-gcode", "--output", req.outputPath, req.inputPath);

  const started = Date.now();
  const result = await runPrusaSlicer(config, args, req.timeoutMs);
  const messages = parseCliMessages(`${result.stdout}\n${result.stderr}`);
  const fail = (reason: string): SliceOutcome => {
    messages.errors.unshift(reason);
    return { ok: false, gcodePath: req.outputPath, stats: {}, ...messages, args };
  };

  if (result.timedOut) return fail(`PrusaSlicer did not finish within ${Math.round((req.timeoutMs ?? 0) / 1000)} s.`);

  let fresh = false;
  try {
    fresh = (await stat(req.outputPath)).mtimeMs >= started - 1000;
  } catch {
    fresh = false;
  }

  if (!fresh) {
    if (result.signal) return fail(`PrusaSlicer crashed (${result.signal}) before writing G-code.`);
    if (result.exitCode !== 0) messages.errors.push(`PrusaSlicer exited with code ${result.exitCode}`);
    if (messages.errors.length === 0) messages.errors.push("PrusaSlicer wrote no G-code.");
    return { ok: false, gcodePath: req.outputPath, stats: {}, ...messages, args };
  }

  if (result.signal) {
    if (!(await gcodeIsComplete(req.outputPath))) {
      return fail(`PrusaSlicer crashed (${result.signal}) while writing G-code. The file is incomplete.`);
    }
    messages.warnings.unshift(crashAfterExport(result.signal, [...messages.errors, ...messages.warnings]));
  }

  const stats = await parseGCodeStats(req.outputPath);
  return { ok: true, gcodePath: req.outputPath, stats, ...messages, args };
}

/**
 * PrusaSlicer writes its config block last, so the closing marker means the file was finished.
 */
async function gcodeIsComplete(path: string): Promise<boolean> {
  const content = await readFile(path, "utf-8");
  return content.slice(-200_000).includes("; prusaslicer_config = end");
}

/**
 * PrusaSlicer 2.9.6's CLI segfaults after a successful export whenever it finds toolpath conflicts,
 * because it stores the conflict into a result object the CLI never creates.
 */
function crashAfterExport(signal: string, messages: string[]): string {
  const conflict = messages.some((m) => /path conflicts/i.test(m));
  return conflict
    ? `PrusaSlicer crashed (${signal}) after writing complete G-code. 2.9.6 does this when objects' toolpaths overlap, as reported below.`
    : `PrusaSlicer crashed (${signal}) after writing complete G-code.`;
}

/**
 * Run `--info` and parse its key = value lines, one record per object.
 */
export async function modelInfo(config: PrusaConfig, path: string): Promise<Record<string, string>[]> {
  const result = await runPrusaSlicer(config, ["--info", path], 120_000);
  const records: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;

  for (const line of result.stdout.split("\n")) {
    const m = line.match(/^\s*([a-z_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[1] === "size_x" || !current) {
      current = {};
      records.push(current);
    }
    current[m[1]] = m[2];
  }
  return records;
}

function parseTimeToSeconds(timeStr: string): number {
  let total = 0;
  const h = timeStr.match(/(\d+)\s*h/);
  const m = timeStr.match(/(\d+)\s*m/);
  const s = timeStr.match(/(\d+)\s*s/);
  if (h) total += parseInt(h[1], 10) * 3600;
  if (m) total += parseInt(m[1], 10) * 60;
  if (s) total += parseInt(s[1], 10);
  return total;
}
