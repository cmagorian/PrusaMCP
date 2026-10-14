# Fork notes

This fork adds plate layout, mesh repair, and support planning to PrusaMCP, and widens slicing to real PrusaSlicer presets.

## Baseline

| Item | Value |
| --- | --- |
| Upstream | [Noosbai/PrusaMCP](https://github.com/Noosbai/PrusaMCP) at `9ee82a4` |
| PrusaSlicer tested | 2.9.6 |
| OS tested | macOS 26 (Darwin 25.5), arm64 |
| Node | 22 or later (CI), 26 (local) |

## Tools

| Tool | Status | Purpose |
| --- | --- | --- |
| `arrange_plate` | New | Pack STL/3MF models on the bed, with per-model rotation and copies |
| `merge_models` | New | Combine files into one 3MF, keeping relative positions |
| `repair_mesh` | New | Weld, clean, re-orient, and fill holes; report PrusaSlicer's `--info` before and after |
| `plan_supports` | New | Overhang regions with area, height, landing surface, and a verdict |
| `apply_supports` | New | Add enforcer and blocker volumes to a copy of a 3MF |
| `generate_prusaslicer_config` | Changed | Support options |
| `slice_prusaslicer` | Changed | Presets by name or from the GUI, support overrides, arrange, compare run, failure detection |
| `suggest_orientation` | Changed | Overhang measured by area, bed faces excluded |
| `screenshot_prusaslicer` | Changed | Registered on Windows only |

## Workflow

1. `suggest_orientation` on the model.
2. `arrange_plate` with the chosen `rotate_x` / `rotate_y`.
3. `plan_supports` on the plate 3MF.
4. `apply_supports` with the region ids to enforce or block.
5. `slice_prusaslicer` on the new 3MF, with `compare_path` set to the plate without volumes.
6. Open the 3MF in PrusaSlicer and check the volumes before printing.

## PrusaSlicer 2.9.6 CLI behavior

Each row was checked on this machine.

| Behavior | Consequence here |
| --- | --- |
| No `--repair` flag | `repair_mesh` repairs in TypeScript |
| Load-time repair fixes reversed facets but leaves holes (`open_edges` stays) | Holes are filled with a centroid fan |
| `--merge` without `--dont-arrange` segfaults (exit 139) | `arrange_plate` uses its own packer |
| Several inputs without `--merge` export one by one to the same `--output`, last wins | Slicing takes one model; plates go in as one 3MF |
| Exit code 0 with no G-code when objects sit outside the bed or the wipe tower config is invalid | Success requires a G-code file written by this run |
| Non-fatal G-code path conflicts are logged at `[error]` | Listed as warnings once G-code exists |
| After logging a path conflict, the CLI segfaults in `Print::export_gcode` (the G-code is already complete) | A crash counts as success only when the file ends with `; prusaslicer_config = end`, and the crash is reported |
| The first support layer flares about 3 mm past the overhang (`raft_first_layer_expansion`); two supported objects 6 mm apart touched | `arrange_plate` adds 4 mm of room on each side of objects whose support stands on the bed |
| `--datadir` with `--printer-profile`, `--print-profile`, `--material-profile` slices with system presets | `slice_prusaslicer` takes preset names or the GUI selection |
| `--key=value` overrides beat presets and `--load` | Support options go on the command line |
| 3MF build-item positions are kept when slicing | Plates slice where they were arranged |

## 3MF support volumes

| Fact | Evidence |
| --- | --- |
| Volumes live in `Metadata/Slic3r_PE_model.config` as `<volume firstid lastid>` with `volume_type` `SupportEnforcer` or `SupportBlocker` | PrusaSlicer re-exports hand-written files with the same entries |
| Mesh vertices are in object coordinates; `<build><item transform>` places each instance | CLI export of a merged plate |
| Enforcers need `support_material = 1`; with `support_material_auto = 0`, support appears only inside them | Sliced T-shape: 0 support layers without the enforcer, 63 with it |
| A blocker must cover the whole overhang | A blocker 1 mm short of each edge changed nothing; one past the edges removed that wing's support |

`plan_supports` boxes extend past each region by a margin (2 mm default) for that reason.

## Tests

`npm test` builds and runs `test/*.test.js`. PrusaSlicer tests skip when it is not installed.

| Check from the plan | Status |
| --- | --- |
| CLI calls on the installed version, version recorded | Done: 2.9.6, this file |
| Overhang clustering on fixtures with known answers | Done: T-shape, arch, ledge, sphere, cube |
| 3MF with an enforcer loads as an enforcer | Done through the CLI: round trip keeps the type, slicing honors it |
| MMU tool assignments survive | Done on a PrusaSlicer-format two-extruder 3MF: identical T0/T1 changes before and after `apply_supports` |
| Suite on Windows and Linux | CI runs unit tests on Ubuntu, Windows, and macOS; PrusaSlicer tests run only where it is installed |
| Five models, CLI filament vs GUI slice | Manual, not done |
| Enforcer volume visible in the GUI | Manual, not done |
| GUI-built MMU3 3MF | Manual, not done; the MMU3 presets are not installed on the test machine |

## Limits

- The packer packs bounding rectangles, so it nests less tightly than PrusaSlicer's polygon arrange.
- Every real CLI crash raises a macOS "quit unexpectedly" dialog. The tests never crash PrusaSlicer on purpose; crash handling is tested with a fake executable.
- Support volumes are axis-aligned boxes and can cover neighboring overhangs. `plan_supports` lists those overlaps.
- `arrange_plate` and `merge_models` keep geometry, paint, and per-object and per-volume settings, but drop a source 3MF's embedded print config. `apply_supports` and `repair_mesh` keep it.
- Cosmetic faces are named by side or by a bed-coordinate box.
- New and rewritten tool text is English; untouched upstream tools stay French.
