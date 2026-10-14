import { basename } from "node:path";
import type { Mesh, Vec3 } from "./types.js";
import { parseStl } from "./stl-parser.js";
import { read3mf, type Plate, type PlateObject, type PlateVolume } from "./threemf.js";
import {
  IDENTITY, bounds, composeTransforms, mergeMeshes, rotationXYZ, transformMesh, translation, weld, type Transform,
} from "./mesh.js";
import { packRectangles } from "./arrange.js";
import { planSupports } from "./support-planner.js";

export interface BedSize {
  x: number;
  y: number;
}

// Original Prusa MK3S / MK3S+
export const DEFAULT_BED: BedSize = { x: 250, y: 210 };

export interface ModelSource {
  path: string;
  copies?: number;
  rotateX?: number; // degrees
  rotateY?: number;
  rotateZ?: number;
}

/**
 * A model loaded with every volume in bed-aligned coordinates, before placement.
 */
interface LoadedObject {
  name: string;
  volumes: PlateVolume[];
  metadata: Record<string, string>;
  placement: Transform; // where it sat in its source file
}

async function loadObjects(source: ModelSource): Promise<LoadedObject[]> {
  const lower = source.path.toLowerCase();
  const rotation = rotationXYZ(source.rotateX ?? 0, source.rotateY ?? 0, source.rotateZ ?? 0);

  if (lower.endsWith(".stl")) {
    const stl = await parseStl(source.path);
    const mesh = transformMesh(weld(stl.triangles), rotation);
    return [{
      name: basename(source.path),
      volumes: [{ name: basename(source.path), type: "ModelPart", mesh, metadata: {} }],
      metadata: {},
      placement: IDENTITY,
    }];
  }

  if (lower.endsWith(".3mf")) {
    const plate = await read3mf(source.path);
    return plate.objects.flatMap((obj) => obj.instances.map((instance) => {
      // Bake each instance's rotation and scale; keep its translation as the placement
      const linear: Transform = [...instance.slice(0, 9), 0, 0, 0];
      const full = composeTransforms(linear, rotation);
      return {
        name: obj.name,
        volumes: obj.volumes.map((v) => ({ ...v, mesh: transformMesh(v.mesh, full) })),
        metadata: obj.metadata,
        placement: translation(instance[9], instance[10], instance[11]),
      };
    }));
  }

  throw new Error(`Unsupported format: ${source.path}. Use STL or 3MF.`);
}

function partBounds(volumes: PlateVolume[]): { min: Vec3; max: Vec3 } {
  const parts = volumes.filter((v) => v.type === "ModelPart");
  return bounds((parts.length > 0 ? parts : volumes).flatMap((v) => v.mesh.vertices));
}

/**
 * Shift volumes so the model parts sit on z = 0, centered on the origin in XY.
 */
function centerVolumes(volumes: PlateVolume[]): { volumes: PlateVolume[]; offset: Vec3 } {
  const { min, max } = partBounds(volumes);
  const offset = { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: min.z };
  const shift = translation(-offset.x, -offset.y, -offset.z);
  return { volumes: volumes.map((v) => ({ ...v, mesh: transformMesh(v.mesh, shift) })), offset };
}

// ─── Arrange ─────────────────────────────────────────────────

// PrusaSlicer widens the first support layer by raft_first_layer_expansion (3 mm), plus a line width
export const DEFAULT_SUPPORT_CLEARANCE = 4;

export interface ArrangeOptions {
  bed?: BedSize;
  spacing?: number;
  allowRotation?: boolean;
  supportClearance?: number; // extra room on each side of objects whose support reaches the bed
}

export interface ArrangedItem {
  objectName: string;
  source: string;
  copy: number;
  center: { x: number; y: number };
  size: { x: number; y: number; z: number };
  rotatedOnBed: boolean;
  supportRoom: number; // mm reserved on each side for support bases
}

export interface ArrangeResult {
  plate: Plate;
  items: ArrangedItem[];
  unplaced: { objectName: string; source: string; size: { x: number; y: number } }[];
  bedCoverage: number;
  clearanceDropped: boolean; // support room was given up to fit everything
}

/**
 * Whether PrusaSlicer would build support from the bed under this object.
 */
function supportReachesBed(volumes: PlateVolume[], name: string): boolean {
  if (volumes.some((v) => v.type === "SupportEnforcer")) return true;
  const mesh = mergeMeshes(volumes.filter((v) => v.type === "ModelPart").map((v) => v.mesh));
  const { regions } = planSupports([{ index: 0, name, mesh }], { overhangAngle: 45, minArea: 0 });
  return regions.some((r) => r.landsOn !== "model");
}

export async function arrangeModels(sources: ModelSource[], options: ArrangeOptions = {}): Promise<ArrangeResult> {
  const bed = options.bed ?? DEFAULT_BED;
  const spacing = options.spacing ?? 6;
  const clearance = options.supportClearance ?? DEFAULT_SUPPORT_CLEARANCE;

  const objects: { obj: PlateObject; source: string; size: Vec3; copies: number; room: number }[] = [];
  for (const source of sources) {
    for (const loaded of await loadObjects(source)) {
      const { volumes } = centerVolumes(loaded.volumes);
      const { min, max } = partBounds(volumes);
      objects.push({
        obj: { id: objects.length + 1, name: loaded.name, volumes, instances: [], metadata: loaded.metadata },
        source: source.path,
        size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
        copies: Math.max(1, Math.floor(source.copies ?? 1)),
        room: clearance > 0 && supportReachesBed(volumes, loaded.name) ? clearance : 0,
      });
    }
  }

  const keyTo: { objectIndex: number; copy: number }[] = [];
  objects.forEach((o, objectIndex) => {
    for (let copy = 0; copy < o.copies; copy++) keyTo.push({ objectIndex, copy });
  });
  const packWith = (useRoom: boolean) => packRectangles(
    keyTo.map(({ objectIndex }, key) => {
      const o = objects[objectIndex];
      const room = useRoom ? o.room : 0;
      return { key, width: o.size.x + 2 * room, depth: o.size.y + 2 * room };
    }),
    bed.x, bed.y, spacing, options.allowRotation ?? true,
  );

  // Support room only matters between objects, so give it up rather than leave a model off the plate
  let result = packWith(true);
  let clearanceDropped = false;
  if (result.unplaced.length > 0 && objects.some((o) => o.room > 0)) {
    const tight = packWith(false);
    if (tight.unplaced.length < result.unplaced.length) {
      result = tight;
      clearanceDropped = true;
    }
  }
  const items: ArrangedItem[] = [];

  for (const p of result.placements) {
    const { objectIndex, copy } = keyTo[p.key];
    const o = objects[objectIndex];
    const turn = p.rotated ? rotationXYZ(0, 0, 90) : IDENTITY;
    o.obj.instances.push(composeTransforms(turn, translation(p.centerX, p.centerY, 0)));
    items.push({
      objectName: o.obj.name,
      source: o.source,
      copy: copy + 1,
      center: { x: p.centerX, y: p.centerY },
      size: o.size,
      rotatedOnBed: p.rotated,
      supportRoom: clearanceDropped ? 0 : o.room,
    });
  }

  const unplaced = result.unplaced.map((key) => {
    const o = objects[keyTo[key].objectIndex];
    return { objectName: o.obj.name, source: o.source, size: { x: o.size.x, y: o.size.y } };
  });

  const placedObjects = objects.map((o) => o.obj).filter((o) => o.instances.length > 0);
  placedObjects.forEach((o, i) => (o.id = i + 1));

  return { plate: { objects: placedObjects }, items, unplaced, bedCoverage: result.usedArea, clearanceDropped };
}

// ─── Merge ───────────────────────────────────────────────────

export interface MergeOptions {
  mode: "objects" | "parts";
  bed?: BedSize;
  centerOnBed?: boolean;
  name?: string;
}

/**
 * Combine models into one plate, keeping their positions relative to each other.
 * "objects" keeps each model a separate object; "parts" makes them volumes of one object.
 */
export async function mergeModels(sources: ModelSource[], options: MergeOptions): Promise<Plate> {
  const bed = options.bed ?? DEFAULT_BED;
  const loaded = (await Promise.all(sources.map(loadObjects))).flat();

  // Everything in shared source coordinates
  const placed = loaded.map((l) => ({
    ...l,
    volumes: l.volumes.map((v) => ({ ...v, mesh: transformMesh(v.mesh, l.placement) })),
  }));

  const all = partBounds(placed.flatMap((p) => p.volumes));
  const groupShift = options.centerOnBed === false
    ? translation(0, 0, -all.min.z)
    : translation(bed.x / 2 - (all.min.x + all.max.x) / 2, bed.y / 2 - (all.min.y + all.max.y) / 2, -all.min.z);

  if (options.mode === "parts") {
    const volumes = placed.flatMap((p) => p.volumes.map((v) => ({ ...v, mesh: transformMesh(v.mesh, groupShift) })));
    const { volumes: centered, offset } = centerVolumes(volumes);
    return {
      objects: [{
        id: 1,
        name: options.name ?? "merged",
        volumes: centered,
        instances: [translation(offset.x, offset.y, offset.z)],
        metadata: {},
      }],
    };
  }

  return {
    objects: placed.map((p, i) => {
      const shifted = p.volumes.map((v) => ({ ...v, mesh: transformMesh(v.mesh, groupShift) }));
      const { volumes, offset } = centerVolumes(shifted);
      return { id: i + 1, name: p.name, volumes, instances: [translation(offset.x, offset.y, offset.z)], metadata: p.metadata };
    }),
  };
}

/**
 * Footprints that cross the bed edge, for a sanity check before slicing.
 */
export function objectsOffBed(plate: Plate, bed: BedSize): string[] {
  const off: string[] = [];
  for (const obj of plate.objects) {
    obj.instances.forEach((t, i) => {
      const parts = obj.volumes.filter((v) => v.type === "ModelPart").map((v) => v.mesh);
      const pts = parts.flatMap((m: Mesh) => transformMesh(m, t).vertices);
      const { min, max } = bounds(pts);
      if (min.x < -0.01 || min.y < -0.01 || max.x > bed.x + 0.01 || max.y > bed.y + 0.01) {
        off.push(obj.instances.length > 1 ? `${obj.name} #${i + 1}` : obj.name);
      }
    });
  }
  return off;
}
