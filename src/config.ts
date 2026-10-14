import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import type { PrusaConfig } from "./types.js";

const WINDOWS_INSTALL_PATHS = [
  "C:\\Program Files\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe",
  "C:\\Program Files (x86)\\Prusa3D\\PrusaSlicer\\prusa-slicer-console.exe",
];

const MAC_APP_BUNDLES = [
  "/Applications/PrusaSlicer.app",
  "/Applications/Original Prusa Drivers/PrusaSlicer.app",
  join(homedir(), "Applications", "PrusaSlicer.app"),
  join(homedir(), "Applications", "Original Prusa Drivers", "PrusaSlicer.app"),
];

const LINUX_INSTALL_PATHS = [
  "/usr/bin/prusa-slicer",
  "/usr/local/bin/prusa-slicer",
  "/opt/PrusaSlicer/prusa-slicer",
];

function installPaths(platform: NodeJS.Platform): string[] {
  if (platform === "win32") return WINDOWS_INSTALL_PATHS;
  if (platform === "darwin") {
    return MAC_APP_BUNDLES.map((app) => join(app, "Contents", "MacOS", "PrusaSlicer"));
  }
  return LINUX_INSTALL_PATHS;
}

function findOnPath(platform: NodeJS.Platform): string | null {
  const [cmd, names] = platform === "win32"
    ? ["where", ["prusa-slicer-console.exe"]]
    : ["which", ["prusa-slicer", "PrusaSlicer"]];

  for (const name of names) {
    try {
      const result = execFileSync(cmd, [name], { encoding: "utf-8", timeout: 5000 });
      const firstLine = result.trim().split("\n")[0].trim();
      if (firstLine && existsSync(firstLine)) return firstLine;
    } catch {
      // not found on PATH
    }
  }
  return null;
}

export function detectPrusaSlicerPath(platform: NodeJS.Platform = process.platform): string | null {
  const envPath = process.env.PRUSASLICER_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  for (const p of installPaths(platform)) {
    if (existsSync(p)) return p;
  }

  return findOnPath(platform);
}

export function profilesDirCandidates(platform: NodeJS.Platform = process.platform): string[] {
  const home = homedir();
  if (platform === "win32") {
    return process.env.APPDATA ? [join(process.env.APPDATA, "PrusaSlicer")] : [];
  }
  if (platform === "darwin") {
    return [join(home, "Library", "Application Support", "PrusaSlicer")];
  }
  const xdg = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [join(xdg, "PrusaSlicer"), join(home, ".PrusaSlicer")];
}

export function getProfilesDir(platform: NodeJS.Platform = process.platform): string | null {
  const envDir = process.env.PRUSASLICER_PROFILES_DIR;
  if (envDir && existsSync(envDir)) return envDir;

  return profilesDirCandidates(platform).find((dir) => existsSync(dir)) ?? null;
}

/**
 * Read the version from the first line of `--help`, e.g. "PrusaSlicer-2.9.6 based on Slic3r".
 */
export function detectPrusaSlicerVersion(executablePath: string): string | null {
  if (!executablePath) return null;
  try {
    const out = execFileSync(executablePath, ["--help"], {
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.match(/PrusaSlicer-([\d.]+[\w.-]*)/)?.[1] ?? null;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    return stdout.match(/PrusaSlicer-([\d.]+[\w.-]*)/)?.[1] ?? null;
  }
}

export function loadConfig(): PrusaConfig {
  const executablePath = detectPrusaSlicerPath() ?? "";
  const profilesDir = getProfilesDir() ?? "";
  const version = detectPrusaSlicerVersion(executablePath) ?? "";

  if (!executablePath) {
    console.error(
      "[config] PrusaSlicer not found. Install PrusaSlicer or set PRUSASLICER_PATH env var. " +
      "Slicing tools will not work, but analysis and recommendation tools are still available."
    );
  }

  if (!profilesDir) {
    console.error(
      "[config] PrusaSlicer profiles directory not found. Set PRUSASLICER_PROFILES_DIR to use presets by name."
    );
  }

  return { executablePath, profilesDir, version };
}
