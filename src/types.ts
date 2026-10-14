// ─── Geometry ────────────────────────────────────────────────

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Triangle {
  normal: Vec3;
  v1: Vec3;
  v2: Vec3;
  v3: Vec3;
}

// ─── STL Parse Result ────────────────────────────────────────

export interface StlData {
  triangles: Triangle[];
  name: string;
}

// ─── Indexed Mesh ────────────────────────────────────────────

export type Face = [number, number, number];

export interface Mesh {
  vertices: Vec3[];
  faces: Face[];

  // Raw extra <triangle> attributes from a 3MF (paint, MMU segmentation), kept per face
  faceAttrs?: (string | undefined)[];
}

// ─── Mesh Analysis ───────────────────────────────────────────

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
  size: Vec3; // max - min
}

export interface MeshAnalysis {
  triangleCount: number;
  boundingBox: BoundingBox;
  volume: number;          // mm³ (absolute value)
  surfaceArea: number;     // mm²
  overhangPercent: number; // 0-100, faces > 45° from vertical
  overhangTriangles: number;
  hasSmallDetails: boolean;
  smallDetailPercent: number; // % of triangles considered "fine detail"
  isManifold: boolean;
  nonManifoldEdges: number;
}

// ─── Profile Recommendation ─────────────────────────────────

export type PrintGoal =
  | "draft"
  | "standard"
  | "quality"
  | "strong"
  | "vase"
  | "speed";

export interface MaterialProfile {
  name: string;
  nozzleTemp: number;          // °C (standard layers)
  firstLayerNozzleTemp: number; // °C (first layer — often slightly higher)
  bedTemp: number;             // °C
  firstLayerBedTemp?: number;  // °C (if different from bedTemp)
  fanSpeed: number;            // 0-100%
  minFanSpeed: number;
  bridgeFanSpeed?: number;     // 0-100% for bridges
  retractionLength: number;
  retractionSpeed: number;
  maxVolumetricSpeed: number;  // mm³/s — central PrusaSlicer parameter
  notes: string;
  requiresEnclosure: boolean;
  recommendedSurface?: string; // PEI sheet type recommendation
}

export interface SettingWithReason {
  value: string | number | boolean;
  reason: string;
}

export interface RecommendedProfile {
  goal: string;
  printer: string;
  nozzle: number;
  material: string;
  settings: {
    layer_height: SettingWithReason;
    line_width: SettingWithReason;
    perimeters: SettingWithReason;
    infill_density: SettingWithReason;
    fill_pattern: SettingWithReason;
    nozzle_temperature: SettingWithReason;
    first_layer_nozzle_temperature: SettingWithReason;
    bed_temperature: SettingWithReason;
    first_layer_bed_temperature: SettingWithReason;
    print_speed: SettingWithReason;
    travel_speed: SettingWithReason;
    first_layer_speed: SettingWithReason;
    support_material: SettingWithReason;
    support_material_style: SettingWithReason;
    support_material_contact_distance: SettingWithReason;
    brim_width: SettingWithReason;
    fan_speed: SettingWithReason;
    min_fan_speed: SettingWithReason;
    bridge_fan_speed: SettingWithReason;
    min_layer_time: SettingWithReason;
    retraction_length: SettingWithReason;
    retraction_speed: SettingWithReason;
    max_volumetric_speed: SettingWithReason;
    extrusion_multiplier: SettingWithReason;
    acceleration: SettingWithReason;
  };
  warnings: string[];
}

// ─── PrusaSlicer Config (.ini) ──────────────────────────────

export interface PrusaSlicerSettings {
  [key: string]: string | number | boolean;
}

// ─── CLI ─────────────────────────────────────────────────────

export interface PrusaConfig {
  executablePath: string;
  profilesDir: string;
  version?: string;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  signal?: string;   // set when PrusaSlicer crashed
  timedOut?: boolean;
}

export interface GCodeStats {
  estimatedTime?: string;
  estimatedTimeSeconds?: number;
  filamentUsedMm?: number;
  filamentUsedG?: number;
  filamentCost?: number;
  layerCount?: number;
  supportFilamentMm?: number;
  supportLayers?: number;
}
