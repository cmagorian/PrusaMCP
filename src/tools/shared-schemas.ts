import { z } from "zod";
import type { SupportOptions } from "../ini-writer.js";
import { DEFAULT_BED, type BedSize } from "../plate-builder.js";

export const supportInputs = {
  support_material: z.boolean().optional()
    .describe("Generate support. Enforcer volumes only take effect when this is on."),
  support_material_auto: z.boolean().optional()
    .describe("Detect overhangs automatically. Off means support only inside enforcer volumes."),
  support_material_style: z.enum(["grid", "snug", "organic"]).optional()
    .describe("Support style. Organic builds tree supports."),
  support_material_threshold: z.number().min(0).max(90).optional()
    .describe("Overhang angle in degrees from horizontal. 0 lets PrusaSlicer decide."),
  support_material_buildplate_only: z.boolean().optional()
    .describe("Only build support that stands on the bed, never on the model."),
  support_material_contact_distance: z.number().min(0).optional()
    .describe("Gap between support top and the part, in mm. 0 gives soluble-style contact."),
};

export function pickSupportOptions(input: Record<string, unknown>): SupportOptions {
  const out: SupportOptions = {};
  for (const key of Object.keys(supportInputs) as (keyof SupportOptions)[]) {
    if (input[key] !== undefined) (out as Record<string, unknown>)[key] = input[key];
  }
  return out;
}

export const bedInput = z.object({
  x: z.number().positive(),
  y: z.number().positive(),
}).optional().describe(`Bed size in mm. Defaults to ${DEFAULT_BED.x} × ${DEFAULT_BED.y} (Original Prusa MK3S/MK3S+).`);

export function bedOf(input?: { x: number; y: number }): BedSize {
  return input ?? DEFAULT_BED;
}

export function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function textResult(lines: (string | null | undefined | false)[]) {
  return { content: [{ type: "text" as const, text: lines.filter((l) => l !== null && l !== undefined && l !== false).join("\n") }] };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const mm = (n: number, digits = 1) => n.toFixed(digits);
