# M02 — Track model: Daytona road course

| | |
|---|---|
| **Owns** | `packages/shared/config/track.daytona.json`, `packages/engine/src/track/geometry.ts`, `track/surface.ts` |
| **Depends on** | `shared` |
| **Used by** | M03 (node grid, grip), M06 (incident zones), M07 (pit lane), M08, backend `/track` routes, frontend map and Track tab |
| **Gate** | 1 |
| **Audit fixes** | P0-3 / 1.3, P0-4 / 1.4 (single grip function), C03 / Finding 7, C04, C12, B11(b), 3.1 |

## 2.1 Data status

The layout is a **hand-drawn schematic**, not a survey. Only these values are `REPORTED` (public specifications, not re-verified): lap length ≈ 5,730 m (3.56 mi); banking 18° on S01, 31° on S10 and S11. Everything else is `ILLUSTRATIVE` (from the drawing) or `UNCALIBRATED` (incident-zone levels). The map shows the note: *"Schematic layout. Lengths scaled to the reported 5.73 km lap."*

## 2.2 `track.daytona.json` (create exactly this)

Conventions: lap distance `s` in metres from the start/finish line (0 m), wrapping at 5,730 m; segment intervals are `[start_m, end_m)`. `points` are schematic SVG coordinates (viewBox `0 0 1000 620`, y down); each segment's polyline starts where the previous one ends. `cornerRadius_m` is used by the lap solver **only inside apex windows**; it is `null` for straights without an apex window (S03, S07, S09). S01 (curved tri-oval) and S06 (exit kink) are straights with a short apex window, so they carry a radius with a note. `drawnMinRadius_m` is the drawing artefact, kept for display only. Apex windows are **centred** on `at` (fraction of the segment).

```json
{
  "name": "Daytona International Speedway — Road Course (schematic)",
  "lapLength_m": { "value": 5730, "provenance": "REPORTED" },
  "viewBox": [0, 0, 1000, 620],
  "meanDryGrip": 1.0278,
  "segments": [
    { "id": "S01", "name": "Front Tri-Oval (Start/Finish)", "type": "straight", "start_m": 0, "end_m": 974,
      "elevation_m": { "value": 2, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 18, "provenance": "REPORTED" },
      "cornerRadius_m": { "value": 413, "provenance": "ILLUSTRATIVE", "note": "tri-oval curvature; applied only in the apex window" },
      "drawnMinRadius_m": 413, "dryGrip": { "value": 1.04, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.62, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.55, "window_m": 380 }],
      "points": [[380,545],[470,551],[560,556],[640,555],[720,548],[790,535]] },
    { "id": "S02", "name": "Turn 1 Horseshoe", "type": "infield_turn", "start_m": 974, "end_m": 1426,
      "elevation_m": { "value": 2, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 0, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": { "value": 68, "provenance": "ILLUSTRATIVE" }, "drawnMinRadius_m": 68,
      "dryGrip": { "value": 1.00, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.58, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.55, "window_m": 60 }],
      "points": [[790,535],[845,522],[872,495],[868,463],[840,445],[800,445]] },
    { "id": "S03", "name": "Infield Straight", "type": "straight", "start_m": 1426, "end_m": 1934,
      "elevation_m": { "value": 2, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 0, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": null, "drawnMinRadius_m": 284,
      "dryGrip": { "value": 1.02, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.60, "provenance": "ILLUSTRATIVE" },
      "apex": [], "points": [[800,445],[700,445],[600,446]] },
    { "id": "S04", "name": "West Horseshoe", "type": "infield_turn", "start_m": 1934, "end_m": 2358,
      "elevation_m": { "value": 3, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 0, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": { "value": 44, "provenance": "ILLUSTRATIVE" }, "drawnMinRadius_m": 44,
      "dryGrip": { "value": 1.00, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.57, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.5, "window_m": 50 }],
      "points": [[600,446],[560,440],[538,415],[545,388],[575,375],[615,378]] },
    { "id": "S05", "name": "Infield Esses", "type": "chicane", "start_m": 2358, "end_m": 2959,
      "elevation_m": { "value": 3, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 0, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": { "value": 57, "provenance": "ILLUSTRATIVE" }, "drawnMinRadius_m": 57,
      "dryGrip": { "value": 0.98, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.56, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.3, "window_m": 40 }, { "at": 0.7, "window_m": 40 }],
      "points": [[615,378],[660,372],[695,355],[725,362],[760,345],[790,330]] },
    { "id": "S06", "name": "Infield Exit", "type": "straight", "start_m": 2959, "end_m": 3364,
      "elevation_m": { "value": 3, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 0, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": { "value": 48, "provenance": "ILLUSTRATIVE", "note": "exit kink at the start of the segment" }, "drawnMinRadius_m": 48,
      "dryGrip": { "value": 1.01, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.59, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.1, "window_m": 40 }],
      "points": [[790,330],[820,295],[850,250],[880,205]] },
    { "id": "S07", "name": "Backstretch", "type": "straight", "start_m": 3364, "end_m": 3749,
      "elevation_m": { "value": 4, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 3, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": null, "drawnMinRadius_m": 51,
      "dryGrip": { "value": 1.03, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.61, "provenance": "ILLUSTRATIVE" },
      "apex": [], "points": [[880,205],[862,145],[822,108],[762,92],[700,88]] },
    { "id": "S08", "name": "Bus Stop Chicane", "type": "chicane", "start_m": 3749, "end_m": 4048,
      "elevation_m": { "value": 4, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 0, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": { "value": 27, "provenance": "ILLUSTRATIVE" }, "drawnMinRadius_m": 27,
      "dryGrip": { "value": 0.97, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.55, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.35, "window_m": 30 }, { "at": 0.7, "window_m": 30 }],
      "points": [[700,88],[672,88],[658,101],[636,101],[622,88],[592,88]] },
    { "id": "S09", "name": "Back Straight Exit", "type": "straight", "start_m": 4048, "end_m": 4430,
      "elevation_m": { "value": 4, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 3, "provenance": "ILLUSTRATIVE" },
      "cornerRadius_m": null, "drawnMinRadius_m": 105,
      "dryGrip": { "value": 1.03, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.61, "provenance": "ILLUSTRATIVE" },
      "apex": [], "points": [[592,88],[505,88],[420,90]] },
    { "id": "S10", "name": "Banked Turn 3", "type": "banked_turn", "start_m": 4430, "end_m": 4943,
      "elevation_m": { "value": 5, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 31, "provenance": "REPORTED" },
      "cornerRadius_m": { "value": 284, "provenance": "ILLUSTRATIVE" }, "drawnMinRadius_m": 284,
      "dryGrip": { "value": 1.08, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.66, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.5, "window_m": 513 }],
      "points": [[420,90],[330,100],[252,138],[198,198],[172,270]] },
    { "id": "S11", "name": "Banked Turn 4", "type": "banked_turn", "start_m": 4943, "end_m": 5730,
      "elevation_m": { "value": 3, "provenance": "ILLUSTRATIVE" }, "banking_deg": { "value": 31, "provenance": "REPORTED" },
      "cornerRadius_m": { "value": 277, "provenance": "ILLUSTRATIVE" }, "drawnMinRadius_m": 277,
      "dryGrip": { "value": 1.08, "provenance": "ILLUSTRATIVE" }, "wetGrip": { "value": 0.66, "provenance": "ILLUSTRATIVE" },
      "apex": [{ "at": 0.5, "window_m": 787 }],
      "points": [[172,270],[174,352],[203,430],[262,498],[325,532],[380,545]] }
  ],
  "pitLane": {
    "entry_s_m": 5613, "exit_s_m": 884,
    "laneLength_m": { "value": 400, "provenance": "ILLUSTRATIVE", "note": "override; the 1,129 m schematic route would give 67.7 s transit and a ≈128 s full stop" },
    "timingLine_u_m": { "value": 47, "provenance": "ILLUSTRATIVE", "note": "lane distance from pit entry to where the start/finish line crosses the lane" },
    "box_u_m": { "value": 200, "provenance": "ILLUSTRATIVE" },
    "speedLimit_kph": { "value": 60, "provenance": "ILLUSTRATIVE", "note": "assumed to apply under green and caution" },
    "entryLoss_s": { "value": 2.0, "provenance": "ILLUSTRATIVE" },
    "exitLoss_s": { "value": 2.5, "provenance": "ILLUSTRATIVE" },
    "points": [[318,526],[360,529],[420,533],[520,538],[620,538],[700,533],[776,529]]
  },
  "sectors": [
    { "id": "SC1", "from_m": 0, "to_m": 1900, "provenance": "ILLUSTRATIVE" },
    { "id": "SC2", "from_m": 1900, "to_m": 3900, "provenance": "ILLUSTRATIVE" },
    { "id": "SC3", "from_m": 3900, "to_m": 5730, "provenance": "ILLUSTRATIVE" }
  ],
  "incidentZones": [
    { "id": "IZ1", "name": "Turn 1 braking / Horseshoe", "from_m": 824, "to_m": 1426, "categories": ["Braking-zone contact", "Spin"], "level": 2, "provenance": "UNCALIBRATED" },
    { "id": "IZ2", "name": "Infield Esses", "from_m": 2358, "to_m": 2959, "categories": ["Contact", "Track-limit abuse"], "level": 1, "provenance": "UNCALIBRATED" },
    { "id": "IZ3", "name": "Bus Stop chicane", "from_m": 3649, "to_m": 4048, "categories": ["Chicane contact", "Cutting"], "level": 2, "provenance": "UNCALIBRATED" },
    { "id": "IZ4", "name": "Banked Turns 3–4", "from_m": 4430, "to_m": 5730, "categories": ["Multi-car pack incident", "High-speed debris"], "level": 3, "provenance": "UNCALIBRATED" }
  ]
}
```

Notes:
- Segment intervals are contiguous and sum to exactly 5,730 m (974 + 452 + 508 + 424 + 601 + 405 + 385 + 299 + 382 + 513 + 787).
- Banked turns S10 and S11 have apex windows covering the whole segment (constant-radius arcs).
- Elevation is stored but **not used** by the lap solver (site is flat; values are placeholders); the grade term is 0.
- `meanDryGrip` = length-weighted mean of `dryGrip` (1.0278); used by the rubber term in §2.4.
- Incident-zone levels are uncalibrated; in v2 they are used only for display and for placing incidents on the map, not to scale hazard rates (C07).

## 2.3 Geometry (`geometry.ts`)

1. Concatenate the segment `points` into one closed polyline (drop duplicated joints) and smooth it with a **centripetal Catmull–Rom** spline (α = 0.5), 40 samples per original span. Record which segment each sample belongs to.
2. **Mapping lap distance to drawing**: for `s` in segment `seg`, `f = (s − start_m)/(end_m − start_m)`; the position is the point at fraction `f` of that segment's drawn arc length. Each segment is scaled independently, so real lengths stay correct on a schematic drawing.
3. **Pit lane**: lane distance `u ∈ [0, laneLength]` maps to the same fraction of the pit-lane polyline. `u = 0` is pit entry, `u = timingLine_u` is the timing line, `u = box_u` is the box, `u = laneLength` is pit exit.
4. Lookups (binary search on cumulative arrays): `segmentAt(s)`, `sectorAt(s)`, `incidentZonesAt(s)`, `xyAt(s)`, `headingAt(s)`, `pitXyAt(u)`.
5. Track stretch bypassed by the pit lane (track distance from entry to exit, wrapping): `D_stretch = (5730 − 5613) + 884 = 1,001 m`. Used only for the time a car would have spent on track (M07), never to split lane time.
6. **Solver node grid**: `ds = 2 m`, `N = 2,865` nodes. Node `i` at `s_i = i·ds` stores: segment index, sector index, bank angle θ (rad), radius `r_i` (= `cornerRadius_m` if `s_i` lies inside any apex window of its segment, else `Infinity`), `dryGrip`, `wetGrip`.

## 2.4 The single surface-grip function (`surface.ts`) — used by both the UI and the solver

v1 used one formula for the UI and a different decomposition in the solver (P0-4). v2 defines **one** function, structured so the solver's factorisation is exact.

Inputs: global wetness `w`, global track temperature `T_trk`, global rubber `R`, and per-segment overrides `{ wetnessOffset_j ∈ [−1, 1], debris_j ∈ {0, 1} }`. Per-segment temperature and rubber overrides are **not** supported (they would break the factorisation).

```
w_j       = clip(w + wetnessOffset_j, 0, 1)
blend_j   = (1 − w_j)·dryGrip_j + w_j·wetGrip_j
sw_j      = clip((w_j − 0.6) / 0.4, 0, 1)                    standing-water indicator (display: sw_j × 4 mm)
node_j    = max(0.05, blend_j − 0.20·sw_j − 0.08·debris_j)   segment-specific part
f_trk(T)  = max(0.80, 1 − ((T − 38) / 48)²)                  peaks at 38 °C, floor 0.80
S_track   = f_trk(T_trk) · (1 + R·(1 − w) / meanDryGrip)     uniform part (temperature, rubber)
grip_j    = S_track · node_j                                  effective grip shown in the UI
```

- Check: S01, dry, 30 °C, no rubber ⇒ `0.97222 × 1.04 = 1.0111` (matches the track document's inspector).
- The solver uses `μ_i = μ_peak · S_car · S_track · node_{j(i)}` (M03). Because `grip_j = S_track·node_j` exactly, the UI value and the physics value are identical by construction; a test asserts equality to 1e-12.
- Changing an override (wetness offset or debris) changes `node_j` and therefore requires a **surrogate rebuild** (M03 §3.4); changing global `T_trk` or `R` only changes the uniform scale and needs no rebuild.

## 2.5 Tests

1. Segment lengths sum to 5,730 m; intervals are contiguous; every segment without an apex window has `cornerRadius_m = null` and every segment with one has a radius; banked windows equal their segment lengths.
2. `segmentAt(2500) = S05`, `sectorAt(3000) = SC2`, `incidentZonesAt(4500) = [IZ4]`; `xyAt(0)` equals the S01 start point; `xyAt` is continuous across every joint (gap < 1 px).
3. `pitXyAt(0)` and `pitXyAt(400)` equal the first and last pit-lane points; `timingLine_u < box_u < laneLength`.
4. Grip: S01 dry 30 °C ⇒ 1.011 ± 0.001; grip never below `0.05·0.8`; debris lowers `node_j` by exactly 0.08 (when above the floor); `grip_j` equals the solver's per-node track factor to 1e-12 for 200 random (w, T, R, override) combinations.
