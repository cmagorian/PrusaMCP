import { writeFile } from "node:fs/promises";
import type { RecommendedProfile, PrusaSlicerSettings } from "./types.js";

/**
 * Mapping from our internal setting names to PrusaSlicer .ini keys.
 * PrusaSlicer uses specific key names that differ from what we expose.
 */
const KEY_MAP: Record<string, string> = {
  layer_height: "layer_height",
  line_width: "extrusion_width",
  perimeters: "perimeters",
  infill_density: "fill_density",
  fill_pattern: "fill_pattern",
  nozzle_temperature: "temperature",
  first_layer_nozzle_temperature: "first_layer_temperature",
  bed_temperature: "bed_temperature",
  first_layer_bed_temperature: "first_layer_bed_temperature",
  print_speed: "perimeter_speed",
  travel_speed: "travel_speed",
  first_layer_speed: "first_layer_speed",
  support_material: "support_material",
  support_material_style: "support_material_style",
  support_material_contact_distance: "support_material_contact_distance",
  brim_width: "brim_width",
  fan_speed: "max_fan_speed",
  min_fan_speed: "min_fan_speed",
  bridge_fan_speed: "bridge_fan_speed",
  min_layer_time: "slowdown_below_layer_time",
  retraction_length: "retract_length",
  retraction_speed: "retract_speed",
  max_volumetric_speed: "max_volumetric_speed",
  extrusion_multiplier: "extrusion_multiplier",
  acceleration: "default_acceleration",
};

// Materials where wipe should be disabled (flexible = risk of jamming)
const NO_WIPE_MATERIALS = new Set(["TPU", "NYLON"]);

/**
 * Convert a RecommendedProfile to PrusaSlicer .ini key-value pairs.
 */
export function profileToIniSettings(profile: RecommendedProfile): PrusaSlicerSettings {
  const result: PrusaSlicerSettings = {};

  for (const [key, setting] of Object.entries(profile.settings)) {
    const iniKey = KEY_MAP[key] ?? key;
    let value = setting.value;

    // PrusaSlicer-specific formatting
    if (key === "infill_density") {
      value = `${value}%`;
    } else if (key === "support_material") {
      value = value ? 1 : 0;
    } else if (key === "first_layer_speed") {
      value = `${value}mm/s`;
    }

    result[iniKey] = value;
  }

  const printSpeed = profile.settings.print_speed.value as number;
  const lh = profile.settings.layer_height.value as number;

  // ─── First layer height ────────────────────────────────────
  // Bible FDM: first layer slightly thicker for better adhesion
  // PrusaSlicer default: typically 0.2mm or same as layer_height
  result["first_layer_height"] = Math.max(lh, 0.2);

  // ─── Derived speed settings ────────────────────────────────
  // All speeds derived from perimeter_speed for consistency
  result["infill_speed"] = Math.round(printSpeed * 1.2);          // infill can go faster
  result["solid_infill_speed"] = Math.round(printSpeed * 0.8);    // solid infill slightly slower
  result["top_solid_infill_speed"] = Math.round(printSpeed * 0.5); // top surface = visible, slow
  result["external_perimeter_speed"] = Math.round(printSpeed * 0.5); // external = visible
  result["small_perimeter_speed"] = Math.round(printSpeed * 0.5);
  result["bridge_speed"] = Math.round(printSpeed * 0.4);          // slow for clean bridges
  result["gap_fill_speed"] = Math.round(printSpeed * 0.5);
  result["support_material_speed"] = Math.round(printSpeed * 0.8);

  // ─── Retraction settings ───────────────────────────────────
  result["retract_before_travel"] = 2;
  result["retract_lift"] = 0.2;
  result["retract_layer_change"] = 1; // Bible FDM: recommended on

  // Wipe: conditionnel — désactivé pour TPU/flexibles (Bible FDM: rétraction délicate)
  const matUpper = profile.material.toUpperCase().replace(/\s*\(.*\)/, ""); // strip "(Polycarbonate)" etc
  result["wipe"] = NO_WIPE_MATERIALS.has(matUpper) ? 0 : 1;

  // ─── Top/bottom layers ─────────────────────────────────────
  const shellThickness = 0.8; // mm — standard shell
  const solidLayers = Math.max(3, Math.ceil(shellThickness / lh));
  result["top_solid_layers"] = solidLayers;
  result["bottom_solid_layers"] = solidLayers;

  // ─── Nozzle diameter ───────────────────────────────────────
  result["nozzle_diameter"] = profile.nozzle;

  // First layer extrusion width (wider for adhesion)
  result["first_layer_extrusion_width"] = Math.round(profile.nozzle * 1.4 * 100) / 100;

  // ─── Filament MVS ──────────────────────────────────────────
  result["filament_max_volumetric_speed"] = profile.settings.max_volumetric_speed.value;

  // ─── Seam position ─────────────────────────────────────────
  // Bible FDM: seam position matters for blobs/zits — "nearest" reduces travel
  result["seam_position"] = "nearest";

  // ─── Elephant foot compensation ────────────────────────────
  // Bible FDM: ajuster si base "écrasée"
  result["elefant_foot_compensation"] = 0.1; // PrusaSlicer uses this exact spelling

  // ─── Overhang speed ────────────────────────────────────────
  // Bible FDM: ajuster supports/overhang speed plutôt que fan (surtout ASA)
  result["overhangs"] = 1; // enable overhang detection for speed reduction

  return result;
}

export interface SupportOptions {
  support_material?: boolean;
  support_material_auto?: boolean;
  support_material_style?: "grid" | "snug" | "organic";
  support_material_threshold?: number;
  support_material_buildplate_only?: boolean;
  support_material_contact_distance?: number;
}

/**
 * PrusaSlicer support keys for the options that are set. Booleans become 0/1.
 */
export function supportSettings(options: SupportOptions): PrusaSlicerSettings {
  const out: PrusaSlicerSettings = {};
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    out[key] = typeof value === "boolean" ? (value ? 1 : 0) : value;
  }
  return out;
}

/**
 * Serialize settings to PrusaSlicer .ini format.
 */
export function serializeIni(settings: PrusaSlicerSettings): string {
  const lines = [
    "# PrusaSlicer config generated by PrusaMCP",
    "# Generated: " + new Date().toISOString(),
    "# Knowledge base: Bible de l'impression 3D FDM + Prusa official docs",
    "",
  ];

  const sortedKeys = Object.keys(settings).sort();
  for (const key of sortedKeys) {
    const value = settings[key];
    lines.push(`${key} = ${value}`);
  }

  return lines.join("\n") + "\n";
}

/**
 * Write a .ini config file from a RecommendedProfile.
 */
export async function writeIniFile(
  profile: RecommendedProfile,
  outputPath: string,
): Promise<string> {
  const settings = profileToIniSettings(profile);
  const content = serializeIni(settings);
  await writeFile(outputPath, content, "utf-8");
  return outputPath;
}

/**
 * Write raw settings to a .ini file.
 */
export async function writeRawIniFile(
  settings: PrusaSlicerSettings,
  outputPath: string,
): Promise<string> {
  const content = serializeIni(settings);
  await writeFile(outputPath, content, "utf-8");
  return outputPath;
}
