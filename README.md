# PrusaMCP

**Intelligent MCP Server for PrusaSlicer** — 17 tools to analyze, configure and launch your 3D prints from Claude or any MCP client.

> **Fork:** adds plate layout, mesh repair, support planning with enforcer/blocker volumes, preset-based slicing, and macOS/Linux support. See [FORK.md](FORK.md) for the tools, the verified PrusaSlicer 2.9.6 CLI behavior, and test status.

PrusaMCP is not a simple CLI wrapper. It's a **3D printing assistant** that analyzes your mesh, recommends optimal settings with justification, diagnoses defects, and can drive PrusaSlicer automatically.

> Built with [Claude Code](https://claude.ai/claude-code).

## Features

- **Native mesh analysis** — Binary/ASCII STL and 3MF parser, zero external dependencies for parsing
- **Recommendation engine** — Bible FDM + official Prusa knowledge base, justification for every setting
- **MVS-based speed capping** — Automatic speed calculation based on material Max Volumetric Speed
- **17 MCP tools** covering the full print workflow
- **Post-print diagnostics** — Bible FDM diagnostic tree for 9 common defects
- **Filament database** — 30+ filaments with temperatures, MVS, recommended surface

## Tools

### Analysis & Recommendation (no PrusaSlicer needed)

| Tool | Description |
|------|-------------|
| `analyze_mesh` | Geometric analysis of STL/3MF (dimensions, volume, overhangs, manifold) |
| `check_printability` | Issue detection: thin walls, bridges, overhangs, stability |
| `suggest_orientation` | Test 6 orientations with scoring (overhangs, height, adhesion) |
| `recommend_profile` | Full profile recommendation with per-setting justification |
| `generate_prusaslicer_config` | Generate PrusaSlicer-compatible .ini file |
| `estimate_cost` | Cost estimate (filament + electricity) and print time |
| `search_filament` | Search filament database (30+ entries) |
| `print_wizard` | All-in-one: analysis + printability + orientation + profile + questions |
| `diagnose_print` | Post-print diagnosis (warping, stringing, under-extrusion...) |

### PrusaSlicer Integration

| Tool | Description |
|------|-------------|
| `slice_prusaslicer` | Run slicing via CLI with G-code stats |
| `get_current_model` | Get the model currently open in PrusaSlicer |
| `screenshot_prusaslicer` | Capture PrusaSlicer window (even in background) |
| `postprocess_gcode` | G-code post-processing (pause, filament change, etc.) |
| `upload_print` | Upload to OctoPrint / Prusa Connect |

### Plate Layout & Supports (fork)

| Tool | Description |
|------|-------------|
| `arrange_plate` | Pack models on the bed, with rotations and copies, into a plate 3MF |
| `merge_models` | Combine files into one 3MF, keeping relative positions |
| `repair_mesh` | Fill holes, fix winding, and drop bad faces; compare PrusaSlicer `--info` before and after |
| `plan_supports` | Overhang regions with area, height, landing surface, and a verdict |
| `apply_supports` | Add support enforcer and blocker volumes to a copy of a 3MF |

### Feedback & Community

| Tool | Description |
|------|-------------|
| `submit_feedback` | Submit print feedback after printing |
| `feedback_stats` | Feedback statistics by material/goal |
| `export_feedback` | Anonymized community data export |

## Installation

```bash
git clone https://github.com/cmagorian/PrusaMCP.git
cd PrusaMCP
npm install
npm run build
```

## Configuration

### Claude Desktop / Claude Code

Add to your MCP configuration:

```json
{
  "mcpServers": {
    "prusa-mcp": {
      "command": "node",
      "args": ["/path/to/PrusaMCP/build/index.js"],
      "env": {
        "PRUSASLICER_PATH": "C:/Program Files/Prusa3D/PrusaSlicer/prusa-slicer-console.exe"
      }
    }
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PRUSASLICER_PATH` | PrusaSlicer executable (`prusa-slicer-console.exe` on Windows, `PrusaSlicer.app/Contents/MacOS/PrusaSlicer` on macOS) | Auto-detected |
| `PRUSASLICER_PROFILES_DIR` | PrusaSlicer profiles folder | `%APPDATA%/PrusaSlicer`, `~/Library/Application Support/PrusaSlicer`, or `~/.config/PrusaSlicer` |
| `OCTOPRINT_URL` | Your OctoPrint instance URL | — |
| `OCTOPRINT_API_KEY` | OctoPrint API key | — |

## Usage

### Typical Workflow

1. **Analyze a model**: `analyze_mesh` to get dimensions, overhangs, etc.
2. **Check printability**: `check_printability` to detect potential issues
3. **Get a recommendation**: `recommend_profile` with your goal (draft, standard, quality, strong, speed)
4. **Generate config**: `generate_prusaslicer_config` for a ready-to-use .ini
5. **Slice**: `slice_prusaslicer` to generate G-code

### Or in one command

`print_wizard` does everything at once: analysis + printability + orientation + profile + cost estimate + follow-up questions to refine.

### Available Goals

| Goal | Description |
|------|-------------|
| `draft` / `prototype` | Fast, quality secondary |
| `standard` | Good quality/time balance |
| `quality` / `fine` | Smooth surface, fine details |
| `strong` / `structural` | Maximum mechanical strength |
| `vase` | Spiral vase mode |
| `speed` | Everything maxed out |

### Supported Materials

PLA, PETG, ABS, ASA, TPU, Nylon, PC — with official Prusa temperatures, Bible FDM MVS values, drying/enclosure warnings.

## Knowledge Base

The recommendation engine is built on:

- **Bible de l'impression 3D FDM** — Comprehensive FDM settings guide for PrusaSlicer
- **Official Prusa documentation** — Temperatures, MVS, reference profiles
- **9-step calibration workflow** (mechanical → PID → Z → EM → MVS → retraction → cooling → PA → accel)
- **Diagnostic tree** for 9 common defects with causes and fixes

### MVS (Max Volumetric Speed) — The Central Parameter

| Material | MVS (mm³/s) |
|----------|-------------|
| PLA | ~15 |
| ABS/ASA | ~11 |
| PETG | ~8 |
| Nylon/PC | ~8 |
| PVA/BVOH | ~4 |
| TPU | ~1-2.5 |

## Architecture

```
src/
├── index.ts              # MCP entry point + STDIO transport
├── types.ts              # TypeScript interfaces
├── config.ts             # PrusaSlicer detection
├── stl-parser.ts         # Native binary/ASCII STL parser
├── threemf-parser.ts     # 3MF parser (ZIP + XML)
├── mesh-analyzer.ts      # Geometric analysis
├── profile-engine.ts     # Recommendation engine (Bible FDM)
├── ini-writer.ts         # PrusaSlicer .ini generation
├── print-issues.ts       # Issue detection + Bible FDM diagnostics
├── orientation.ts        # Optimal orientation suggestion
├── cost-estimator.ts     # Cost/time estimation
├── filament-db.ts        # Filament database
├── prusa-cli.ts          # PrusaSlicer CLI wrapper
├── community-data.json   # Community data (MVS, diagnostics, best practices)
└── tools/                # 17 MCP tools
    ├── analyze-mesh.ts
    ├── check-printability.ts
    ├── suggest-orientation.ts
    ├── recommend-profile.ts
    ├── generate-config.ts
    ├── estimate-cost.ts
    ├── search-filament.ts
    ├── print-wizard.ts
    ├── diagnose-print.ts
    ├── slice.ts
    ├── get-current-model.ts
    ├── screenshot-prusaslicer.ts
    ├── postprocess-gcode.ts
    ├── upload-print.ts
    └── feedback.ts
```

## Requirements

- **Node.js** >= 18
- **PrusaSlicer** (optional — only needed for slice, screenshot, get_current_model)
- **Windows** for the screenshot tool (uses PrintWindow API); everything else runs on Windows, macOS, and Linux

## License

MIT
