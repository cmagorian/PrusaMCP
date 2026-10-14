import type { StlData } from "./types.js";
import { read3mf, plateObjectWorldMesh } from "./threemf.js";
import { toTriangles } from "./mesh.js";

/**
 * Parse a 3MF into one triangle soup in bed coordinates.
 * Includes every instance of every object, model parts only.
 */
export async function parse3mf(filePath: string): Promise<StlData> {
  const plate = await read3mf(filePath);
  const triangles = plate.objects.flatMap((obj) =>
    obj.instances.flatMap((_, i) => toTriangles(plateObjectWorldMesh(obj, i))),
  );
  return {
    triangles,
    name: plate.objects.map((o) => o.name).join(" + ") || "3mf_model",
  };
}
