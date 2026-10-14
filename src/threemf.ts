import * as yauzl from "yauzl-promise";
import yazl from "yazl";
import { createWriteStream } from "node:fs";
import { basename } from "node:path";
import type { Face, Mesh, Vec3 } from "./types.js";
import {
  IDENTITY, applyTransform, composeTransforms, invertTransform, isIdentity, mergeMeshes, transformMesh,
  type Transform,
} from "./mesh.js";

/**
 * PrusaSlicer 3MF layout, confirmed against PrusaSlicer 2.9.6 exports:
 * - 3D/3dmodel.model holds one <mesh> per object, every volume's triangles concatenated,
 *   vertices in object coordinates.
 * - Metadata/Slic3r_PE_model.config maps triangle ranges (firstid..lastid) to volumes and
 *   stores each volume's type ("ModelPart", "SupportEnforcer", "SupportBlocker", ...).
 * - <build><item transform> places each instance on the bed.
 */

export type VolumeType =
  | "ModelPart"
  | "NegativeVolume"
  | "ParameterModifier"
  | "SupportBlocker"
  | "SupportEnforcer";

export interface PlateVolume {
  name: string;
  type: VolumeType;
  mesh: Mesh;                       // object coordinates
  metadata: Record<string, string>; // extra volume metadata (extruder, per-volume settings)
}

export interface PlateObject {
  id: number;                       // 3MF object id
  name: string;
  volumes: PlateVolume[];
  instances: Transform[];           // object → bed, one per build item
  metadata: Record<string, string>; // extra object metadata (per-object settings)
}

export interface Plate {
  objects: PlateObject[];
}

const MODEL_PATH = "3D/3dmodel.model";
const CONFIG_PATH = "Metadata/Slic3r_PE_model.config";
const CORE_NS = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02";

// Volume metadata that describes the original import, stale once geometry is rewritten
const DERIVED_VOLUME_KEYS = new Set([
  "name", "volume_type", "modifier", "matrix", "source_file", "source_object_id",
  "source_volume_id", "source_offset_x", "source_offset_y", "source_offset_z", "source_in_inches", "source_in_meters",
]);

// ─── Zip I/O ─────────────────────────────────────────────────

export async function readZipEntries(filePath: string): Promise<Map<string, Buffer>> {
  const zip = await yauzl.open(filePath);
  const entries = new Map<string, Buffer>();
  try {
    for await (const entry of zip) {
      if (entry.filename.endsWith("/")) continue;
      const stream = await entry.openReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      entries.set(entry.filename, Buffer.concat(chunks));
    }
  } finally {
    await zip.close();
  }
  return entries;
}

export function writeZipEntries(entries: Map<string, Buffer>, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    for (const [name, data] of entries) {
      zip.addBuffer(data, name, { compress: !name.endsWith(".png") });
    }
    zip.end();
    zip.outputStream
      .pipe(createWriteStream(outputPath))
      .on("close", () => resolve())
      .on("error", reject);
  });
}

// ─── XML helpers ─────────────────────────────────────────────

export function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function xmlUnescape(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function attrs(tagBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tagBody)) !== null) out[m[1]] = xmlUnescape(m[2]);
  return out;
}

function parseTransform(value: string | undefined): Transform {
  if (!value) return [...IDENTITY];
  const nums = value.trim().split(/\s+/).map(Number);
  return nums.length === 12 && nums.every(Number.isFinite) ? nums : [...IDENTITY];
}

function formatTransform(m: Transform): string {
  return m.map(fmt).join(" ");
}

function fmt(n: number): string {
  if (Object.is(n, -0) || Math.abs(n) < 1e-12) return "0";
  return String(Math.round(n * 1e6) / 1e6);
}

// ─── Reader ──────────────────────────────────────────────────

interface RawObject {
  id: number;
  name?: string;
  mesh?: Mesh;
  components: { objectId: number; transform: Transform; path?: string }[];
}

interface RawConfigObject {
  metadata: Record<string, string>;
  volumes: { firstId: number; lastId: number; metadata: Record<string, string> }[];
}

function parseModelObjects(xml: string): Map<number, RawObject> {
  const objects = new Map<number, RawObject>();
  const objectRe = /<object\b([^>]*?)(\/>|>([\s\S]*?)<\/object>)/g;
  let m: RegExpExecArray | null;

  while ((m = objectRe.exec(xml)) !== null) {
    const a = attrs(m[1]);
    const id = Number(a.id);
    const body = m[3] ?? "";
    const obj: RawObject = { id, name: a.name, components: [] };

    if (body.includes("<mesh")) obj.mesh = parseMesh(body);

    const compRe = /<component\b([^>]*)\/?>/g;
    let c: RegExpExecArray | null;
    while ((c = compRe.exec(body)) !== null) {
      const ca = attrs(c[1]);
      obj.components.push({
        objectId: Number(ca.objectid),
        transform: parseTransform(ca.transform),
        path: ca["p:path"],
      });
    }
    objects.set(id, obj);
  }
  return objects;
}

function parseMesh(body: string): Mesh {
  const vertices: Vec3[] = [];
  const vertexRe = /<vertex\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(body)) !== null) {
    const a = attrs(m[1]);
    vertices.push({ x: parseFloat(a.x), y: parseFloat(a.y), z: parseFloat(a.z) });
  }

  const faces: Face[] = [];
  const faceAttrs: (string | undefined)[] = [];
  let anyAttrs = false;
  const triRe = /<triangle\b([^>]*?)\/?>/g;
  while ((m = triRe.exec(body)) !== null) {
    const a = attrs(m[1]);
    faces.push([Number(a.v1), Number(a.v2), Number(a.v3)]);
    const extra = m[1].replace(/\b(v1|v2|v3)\s*=\s*"[^"]*"/g, "").trim();
    faceAttrs.push(extra || undefined);
    if (extra) anyAttrs = true;
  }
  return anyAttrs ? { vertices, faces, faceAttrs } : { vertices, faces };
}

function parseBuildItems(xml: string): { objectId: number; transform: Transform; path?: string }[] {
  const build = xml.match(/<build\b[^>]*>([\s\S]*?)<\/build>/)?.[1] ?? "";
  const items: { objectId: number; transform: Transform; path?: string }[] = [];
  const re = /<item\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(build)) !== null) {
    const a = attrs(m[1]);
    items.push({ objectId: Number(a.objectid), transform: parseTransform(a.transform), path: a["p:path"] });
  }
  return items;
}

function parseConfig(xml: string): Map<number, RawConfigObject> {
  const out = new Map<number, RawConfigObject>();
  const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(xml)) !== null) {
    const id = Number(attrs(m[1]).id);
    const body = m[2];
    const obj: RawConfigObject = { metadata: {}, volumes: [] };

    const volRe = /<volume\b([^>]*)>([\s\S]*?)<\/volume>/g;
    let v: RegExpExecArray | null;
    while ((v = volRe.exec(body)) !== null) {
      const va = attrs(v[1]);
      obj.volumes.push({
        firstId: Number(va.firstid),
        lastId: Number(va.lastid),
        metadata: parseMetadata(v[2], "volume"),
      });
    }
    obj.metadata = parseMetadata(body.replace(volRe, ""), "object");
    out.set(id, obj);
  }
  return out;
}

function parseMetadata(body: string, type: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<metadata\b([^>]*)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const a = attrs(m[1]);
    if (a.type === type && a.key !== undefined) out[a.key] = a.value ?? "";
  }
  return out;
}

function volumeTypeOf(meta: Record<string, string>): VolumeType {
  const t = meta.volume_type;
  if (t === "NegativeVolume" || t === "ParameterModifier" || t === "SupportBlocker" || t === "SupportEnforcer") return t;
  if (meta.modifier === "1") return "ParameterModifier";
  return "ModelPart";
}

function sliceMesh(mesh: Mesh, first: number, last: number): Mesh {
  const used = new Map<number, number>();
  const vertices: Vec3[] = [];
  const faces: Face[] = [];
  const faceAttrs: (string | undefined)[] = [];
  for (let f = first; f <= last && f < mesh.faces.length; f++) {
    faces.push(mesh.faces[f].map((vi) => {
      let id = used.get(vi);
      if (id === undefined) {
        id = vertices.length;
        vertices.push(mesh.vertices[vi]);
        used.set(vi, id);
      }
      return id;
    }) as Face);
    faceAttrs.push(mesh.faceAttrs?.[f]);
  }
  return mesh.faceAttrs ? { vertices, faces, faceAttrs } : { vertices, faces };
}

/**
 * Read a 3MF into objects, volumes, and instance transforms.
 * Handles PrusaSlicer files and generic 3MF component trees, including p:path references.
 */
export async function read3mf(filePath: string): Promise<Plate> {
  const entries = await readZipEntries(filePath);
  const rootPath = findRootModelPath(entries);
  const rootXml = entries.get(rootPath)?.toString("utf-8");
  if (!rootXml) throw new Error("No 3D model found in 3MF archive");

  const modelCache = new Map<string, Map<number, RawObject>>();
  const objectsIn = (path: string): Map<number, RawObject> => {
    const key = path.replace(/^\//, "");
    let objs = modelCache.get(key);
    if (!objs) {
      const xml = entries.get(key)?.toString("utf-8");
      if (!xml) throw new Error(`3MF references missing part ${path}`);
      objs = parseModelObjects(xml);
      modelCache.set(key, objs);
    }
    return objs;
  };

  const configXml = entries.get(CONFIG_PATH)?.toString("utf-8");
  const config = configXml ? parseConfig(configXml) : new Map<number, RawConfigObject>();

  let items = parseBuildItems(rootXml);
  if (items.length === 0) {
    // No build section: treat every top-level mesh object as placed where it is
    items = [...objectsIn(rootPath).values()]
      .filter((o) => o.mesh)
      .map((o) => ({ objectId: o.id, transform: [...IDENTITY] }));
  }
  const plate: Plate = { objects: [] };
  const byId = new Map<number, PlateObject>();

  for (const item of items) {
    const path = item.path ?? rootPath;
    const existing = path === rootPath ? byId.get(item.objectId) : undefined;
    if (existing) {
      existing.instances.push(item.transform);
      continue;
    }

    const raw = objectsIn(path).get(item.objectId);
    if (!raw) throw new Error(`Build item references missing object ${item.objectId}`);

    const cfg = path === rootPath ? config.get(item.objectId) : undefined;
    const volumes = raw.mesh
      ? volumesFromConfig(raw.mesh, cfg, raw.name)
      : volumesFromComponents(raw, path, objectsIn);

    const obj: PlateObject = {
      id: item.objectId,
      name: cfg?.metadata.name ?? raw.name ?? `object_${item.objectId}`,
      volumes,
      instances: [item.transform],
      metadata: Object.fromEntries(Object.entries(cfg?.metadata ?? {}).filter(([k]) => k !== "name")),
    };
    plate.objects.push(obj);
    if (path === rootPath) byId.set(item.objectId, obj);
  }
  return plate;
}

function volumesFromConfig(mesh: Mesh, cfg: RawConfigObject | undefined, name?: string): PlateVolume[] {
  if (!cfg || cfg.volumes.length === 0) {
    return [{ name: name ?? "part", type: "ModelPart", mesh, metadata: {} }];
  }
  return cfg.volumes.map((v) => ({
    name: v.metadata.name ?? name ?? "part",
    type: volumeTypeOf(v.metadata),
    mesh: sliceMesh(mesh, v.firstId, v.lastId),
    metadata: Object.fromEntries(Object.entries(v.metadata).filter(([k]) => !DERIVED_VOLUME_KEYS.has(k))),
  }));
}

function volumesFromComponents(
  raw: RawObject,
  path: string,
  objectsIn: (path: string) => Map<number, RawObject>,
  parent: Transform = IDENTITY,
  depth = 0,
): PlateVolume[] {
  if (depth > 16) throw new Error("3MF component nesting is too deep");
  const out: PlateVolume[] = [];
  for (const comp of raw.components) {
    const compPath = comp.path ?? path;
    const child = objectsIn(compPath).get(comp.objectId);
    if (!child) throw new Error(`Component references missing object ${comp.objectId}`);
    const transform = composeTransforms(comp.transform, parent);
    if (child.mesh) {
      out.push({
        name: child.name ?? raw.name ?? `part_${comp.objectId}`,
        type: "ModelPart",
        mesh: transformMesh(child.mesh, transform),
        metadata: {},
      });
    }
    out.push(...volumesFromComponents(child, compPath, objectsIn, transform, depth + 1));
  }
  return out;
}

function findRootModelPath(entries: Map<string, Buffer>): string {
  const rels = entries.get("_rels/.rels")?.toString("utf-8");
  const target = rels?.match(/Target="\/?([^"]+\.model)"/)?.[1];
  if (target && entries.has(target)) return target;
  if (entries.has(MODEL_PATH)) return MODEL_PATH;
  const any = [...entries.keys()].find((k) => k.endsWith(".model"));
  if (!any) throw new Error("No .model file found in 3MF archive");
  return any;
}

/**
 * Every ModelPart volume of every instance, in bed coordinates.
 */
export function plateObjectWorldMesh(obj: PlateObject, instance = 0, types: VolumeType[] = ["ModelPart"]): Mesh {
  const parts = obj.volumes.filter((v) => types.includes(v.type)).map((v) => v.mesh);
  return transformMesh(mergeMeshes(parts), obj.instances[instance] ?? IDENTITY);
}

// ─── Writer ──────────────────────────────────────────────────

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

export function serializeModel(plate: Plate, title = "plate"): string {
  const out: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">`,
    ` <metadata name="slic3rpe:Version3mf">1</metadata>`,
    ` <metadata name="Title">${xmlEscape(title)}</metadata>`,
    ` <metadata name="Application">PrusaMCP</metadata>`,
    ` <resources>`,
  ];

  for (const obj of plate.objects) {
    const mesh = mergeMeshes(obj.volumes.map((v) => v.mesh));
    out.push(`  <object id="${obj.id}" type="model">`, `   <mesh>`, `    <vertices>`);
    for (const v of mesh.vertices) out.push(`     <vertex x="${fmt(v.x)}" y="${fmt(v.y)}" z="${fmt(v.z)}"/>`);
    out.push(`    </vertices>`, `    <triangles>`);
    mesh.faces.forEach(([a, b, c], i) => {
      const extra = mesh.faceAttrs?.[i];
      out.push(`     <triangle v1="${a}" v2="${b}" v3="${c}"${extra ? " " + extra : ""}/>`);
    });
    out.push(`    </triangles>`, `   </mesh>`, `  </object>`);
  }

  out.push(` </resources>`, ` <build>`);
  for (const obj of plate.objects) {
    for (const t of obj.instances) {
      out.push(`  <item objectid="${obj.id}" transform="${formatTransform(t)}" printable="1"/>`);
    }
  }
  out.push(` </build>`, `</model>`, ``);
  return out.join("\n");
}

export function serializeConfig(plate: Plate): string {
  const out: string[] = [`<?xml version="1.0" encoding="UTF-8"?>`, `<config>`];
  for (const obj of plate.objects) {
    out.push(` <object id="${obj.id}" instances_count="${obj.instances.length}">`);
    out.push(metadataLine("object", "name", obj.name, 2));
    for (const [k, v] of Object.entries(obj.metadata)) out.push(metadataLine("object", k, v, 2));

    let first = 0;
    for (const vol of obj.volumes) {
      const last = first + vol.mesh.faces.length - 1;
      out.push(`  <volume firstid="${first}" lastid="${last}">`);
      out.push(metadataLine("volume", "name", vol.name, 3));
      out.push(metadataLine("volume", "volume_type", vol.type, 3));
      for (const [k, v] of Object.entries(vol.metadata)) out.push(metadataLine("volume", k, v, 3));
      out.push(`  </volume>`);
      first = last + 1;
    }
    out.push(` </object>`);
  }
  out.push(`</config>`, ``);
  return out.join("\n");
}

function metadataLine(type: string, key: string, value: string, indent: number): string {
  return `${" ".repeat(indent)}<metadata type="${type}" key="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`;
}

/**
 * Write a plate as a PrusaSlicer 3MF. `carryFrom` copies a source archive's other parts
 * (embedded print config, layer-height profiles, thumbnails); object ids must still match it.
 */
export async function write3mf(plate: Plate, outputPath: string, carryFrom?: Map<string, Buffer>): Promise<void> {
  const title = basename(outputPath).replace(/\.3mf$/i, "");
  const entries = new Map<string, Buffer>();

  for (const [name, data] of carryFrom ?? []) {
    if (name.endsWith(".model") || name.endsWith(".rels") || name === "[Content_Types].xml" || name === CONFIG_PATH) continue;
    entries.set(name, data);
  }
  entries.set("[Content_Types].xml", Buffer.from(CONTENT_TYPES));
  entries.set("_rels/.rels", Buffer.from(RELS));
  entries.set(MODEL_PATH, Buffer.from(serializeModel(plate, title)));
  entries.set(CONFIG_PATH, Buffer.from(serializeConfig(plate)));
  await writeZipEntries(entries, outputPath);
}

// ─── In-place patching ───────────────────────────────────────

export interface AddedVolume {
  objectId: number;
  name: string;
  type: VolumeType;
  mesh: Mesh; // object coordinates
}

/**
 * Append volumes to objects of an existing 3MF and write the result to `outputPath`.
 * Edits the XML as text so painting, MMU segmentation, per-object settings, and the
 * embedded print config survive untouched.
 */
export async function appendVolumes(inputPath: string, outputPath: string, added: AddedVolume[]): Promise<void> {
  const entries = await readZipEntries(inputPath);
  const rootPath = findRootModelPath(entries);
  let model = entries.get(rootPath)!.toString("utf-8");
  let config = entries.get(CONFIG_PATH)?.toString("utf-8");

  const byObject = new Map<number, AddedVolume[]>();
  for (const v of added) {
    const list = byObject.get(v.objectId);
    if (list) list.push(v);
    else byObject.set(v.objectId, [v]);
  }

  for (const [objectId, volumes] of byObject) {
    const span = findObjectSpan(model, objectId);
    if (!span) throw new Error(`Object ${objectId} not found in ${rootPath}`);
    let body = model.slice(span.start, span.end);
    if (!body.includes("<mesh")) {
      throw new Error(
        `Object ${objectId} is built from components. Open and re-save the file in PrusaSlicer, ` +
        `or rebuild it with arrange_plate, before adding support volumes.`,
      );
    }

    const vertexCount = countTags(body, "vertex");
    const triangleCount = countTags(body, "triangle");

    const vertexLines: string[] = [];
    const triangleLines: string[] = [];
    const ranges: { volume: AddedVolume; first: number; last: number }[] = [];
    let vBase = vertexCount;
    let tBase = triangleCount;

    for (const vol of volumes) {
      for (const v of vol.mesh.vertices) vertexLines.push(`     <vertex x="${fmt(v.x)}" y="${fmt(v.y)}" z="${fmt(v.z)}"/>`);
      for (const [a, b, c] of vol.mesh.faces) triangleLines.push(`     <triangle v1="${a + vBase}" v2="${b + vBase}" v3="${c + vBase}"/>`);
      ranges.push({ volume: vol, first: tBase, last: tBase + vol.mesh.faces.length - 1 });
      vBase += vol.mesh.vertices.length;
      tBase += vol.mesh.faces.length;
    }

    body = insertBefore(body, "</vertices>", vertexLines.join("\n") + "\n    ");
    body = insertBefore(body, "</triangles>", triangleLines.join("\n") + "\n    ");
    model = model.slice(0, span.start) + body + model.slice(span.end);

    config = patchConfig(config, objectId, triangleCount, ranges);
  }

  entries.set(rootPath, Buffer.from(model));
  entries.set(CONFIG_PATH, Buffer.from(config!));
  await writeZipEntries(entries, outputPath);
}

function findObjectSpan(xml: string, objectId: number): { start: number; end: number } | null {
  const re = new RegExp(`<object\\b[^>]*\\bid="${objectId}"[^>]*>`, "g");
  const m = re.exec(xml);
  if (!m) return null;
  const end = xml.indexOf("</object>", m.index);
  return end === -1 ? null : { start: m.index, end };
}

function countTags(xml: string, tag: string): number {
  return xml.match(new RegExp(`<${tag}\\b`, "g"))?.length ?? 0;
}

function insertBefore(xml: string, marker: string, text: string): string {
  const i = xml.lastIndexOf(marker);
  if (i === -1) throw new Error(`Malformed 3MF mesh: missing ${marker}`);
  return xml.slice(0, i) + text + xml.slice(i);
}

function patchConfig(
  config: string | undefined,
  objectId: number,
  existingTriangles: number,
  ranges: { volume: AddedVolume; first: number; last: number }[],
): string {
  const volumeXml = ranges.map(({ volume, first, last }) => [
    `  <volume firstid="${first}" lastid="${last}">`,
    metadataLine("volume", "name", volume.name, 3),
    metadataLine("volume", "volume_type", volume.type, 3),
    `  </volume>`,
  ].join("\n")).join("\n");

  const base = config ?? `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n</config>\n`;
  const re = new RegExp(`<object\\b[^>]*\\bid="${objectId}"[^>]*>`);
  const m = re.exec(base);

  if (m) {
    const end = base.indexOf("</object>", m.index);
    return base.slice(0, end) + volumeXml + "\n " + base.slice(end);
  }

  // No config entry yet, so the existing triangles become one ModelPart
  const objectXml = [
    ` <object id="${objectId}" instances_count="1">`,
    `  <volume firstid="0" lastid="${existingTriangles - 1}">`,
    metadataLine("volume", "volume_type", "ModelPart", 3),
    `  </volume>`,
    volumeXml,
    ` </object>`,
    ``,
  ].join("\n");
  return insertBefore(base, "</config>", objectXml);
}

/**
 * Convert an axis-aligned box in bed coordinates into a mesh in the object's own coordinates.
 */
export function bedBoxToObjectMesh(obj: PlateObject, min: Vec3, max: Vec3, instance = 0): Mesh {
  const toObject = invertTransform(obj.instances[instance] ?? IDENTITY);
  const corners: Vec3[] = [
    { x: min.x, y: min.y, z: min.z }, { x: max.x, y: min.y, z: min.z },
    { x: max.x, y: max.y, z: min.z }, { x: min.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z }, { x: max.x, y: min.y, z: max.z },
    { x: max.x, y: max.y, z: max.z }, { x: min.x, y: max.y, z: max.z },
  ].map((p) => applyTransform(toObject, p));

  const faces: Face[] = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7],
  ];
  const mirrored = !isIdentity(toObject) && determinant3(toObject) < 0;
  return { vertices: corners, faces: mirrored ? faces.map(([a, b, c]) => [a, c, b] as Face) : faces };
}

function determinant3(m: Transform): number {
  const [a, b, c, d, e, f, g, h, i] = m;
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}
