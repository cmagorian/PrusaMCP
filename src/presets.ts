import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface PresetSelection {
  printer?: string;
  print?: string;
  material?: string;
}

/**
 * The presets currently selected in the PrusaSlicer GUI, from the [presets] section of PrusaSlicer.ini.
 */
export function readGuiPresets(datadir: string): PresetSelection {
  const iniPath = join(datadir, "PrusaSlicer.ini");
  if (!existsSync(iniPath)) return {};

  const section = readFileSync(iniPath, "utf-8").match(/^\[presets\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1] ?? "";
  const value = (key: string) => section.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"))?.[1]?.trim() || undefined;

  return {
    printer: value("printer"),
    print: value("print"),
    material: value("filament"),
  };
}
