# Frontend module — `apps/frontend`

| | |
|---|---|
| **Role** | The PITWALL dashboard. Renders what the backend streams; sends user commands. It never simulates. |
| **Depends on** | `packages/shared` (types and schemas only); the backend API (`backend/BACKEND.md`) |
| **Stack** | Vite 5.4, React 18.3, TypeScript 5.5, Tailwind 3.4, Zustand 4.5, `d3-scale`/`d3-shape`/`d3-array`, self-hosted fonts via `@fontsource/*` |
| **Gate** | 1 (track view), 6 (full dashboard) |
| **Audit fixes** | C02/3.8 (fonts self-hosted), C05/15.3 (consistent mock values), 3.2 (synthetic race label), B04 (weather card numbers), B10 (seed/split display), P0-4 (Track tab overrides), C13 (injection semantics shown) |

## F.1 Structure

```
src/api/client.ts      typed REST client (fetch, base URL from VITE_API_URL, default http://localhost:8787/api/v1)
src/api/stream.ts      WebSocket client: reconnect with fromSeq, sends display-time pacing, heartbeat watchdog
src/store/raceStore.ts per-world lap records, events, decisions, projections, derived chart series
src/store/uiStore.ts   tab, selected car, displayed world, ghost toggles, speed, display clock, hover
src/store/benchStore.ts bench/experiment/sensitivity jobs and results
src/ui/layout/*        TopBar, Tabs, Panel, Badge, ProvenanceBadge, Tooltip, Modal
src/ui/race/*          WorldBuilder, Seeds, RaceMap, PositionChart, StintTimeline, DecisionPanel, Scoreboard, FuelTyres, RaceTable, ParameterCards, AuditLog
src/ui/track/*         TrackInspector, SegmentTable, SurfaceControls, SpeedProfile
src/ui/bench/*         BenchmarkView, ForestPlot, ExperimentCards
src/ui/assumptions/*   AssumptionsView, Tornado
src/ui/common/*        Sparkline, Histogram, Gauge, NumberCell
```

Data flow: `client.ts` creates the run and loads defaults/track; `stream.ts` feeds `raceStore`; components read selectors; commands go through `client.ts`. The display clock lives in `uiStore` and advances by `dt × speed` per animation frame, never past the last received lap time; `stream.ts` reports it to the backend for pacing (≤ 10 msgs/s).

## F.2 Visual language (match the PITWALL mock-up)

```css
:root {
  --bg: #0E1013; --panel: #15181D; --panel-2: #1B1F25; --line: #23272E; --line-2: #323843;
  --text: #E8EAED; --muted: #8B929C; --faint: #5C636D;
  --opt: #D7FF3F; --b1: #5BB8FF; --b0: #FF8C42;           /* strategies; our car is always --opt */
  --caution: #FFC23D; --bad: #FF5A5A; --good: #3ED598; --wet: #3B7DD8;
  --asphalt: #2A2F36; --asphalt-edge: #3A404A;
  --prov-reported: #3ED598; --prov-illustrative: #8B929C; --prov-assumed: #FFC23D;
  --prov-uncalibrated: #FF5A5A; --prov-unverified: #B48CFF; --prov-fitted: #D7FF3F;
}
```

- Panel titles: Barlow Condensed 600, 12 px, uppercase, letter-spacing 0.12em. Big numbers: Barlow Condensed 700, 40–64 px. Tables and values: JetBrains Mono 12–13 px, right-aligned. Body: Inter 13 px.
- Panels: `--panel`, 1 px `--line` border, 10 px radius, 14 px padding, 12 px gap.
- Badges: 10 px Barlow uppercase, 1 px border in the provenance colour, 4 px radius. Trigger badges: amber filled `CAUTION`, blue `WEATHER`, grey others.
- Buttons: `--panel-2`, Barlow uppercase; `RUN` lime filled with dark text; active speed outlined lime.
- Motion: 150 ms hover transitions; the map animates at frame rate; nothing else animates.
- Fonts: import `@fontsource/barlow-condensed/600.css`, `/700.css`, `@fontsource/inter/400.css`, `/500.css`, `@fontsource/jetbrains-mono/400.css`, `/500.css` in `main.tsx`. No external font links.

## F.3 Page structure

**TopBar** (sticky, two rows):
- Row 1: `PITWALL` wordmark · run block "synthetic · seed dev-914 · Synthetic 3 h race" · `LAP 46 / ~101` · `CLOCK 15:01` · `ELAPSED 1:21:14` · `REMAINING 1:38:46` · flag chip (`GREEN` / amber `CAUTION · LAP 45` / blue `RAIN`) · outline badge `SIMULATED DATA` · `RUN` `PAUSE` `1X` `5X` `20X` `60X` `STEP LAP` `INJECT CAUTION`.
- Row 2: `INJECT RAIN` `FUEL SPIKE` `FORK WHAT-IF` · tabs `RACE` · `TRACK` · `BENCHMARK` · `ASSUMPTIONS`.
- Tooltip on the run block: code version, config hash, master seed, split, injections list (the reproducibility record).

**RACE tab grid** (≥ 1440 px: `grid-template-columns: 300px minmax(0,1fr) 420px`; 1024–1440 px: two columns; < 1024 px: one column; the map keeps 1000:620):

```
┌──────────────┬───────────────────────────────────────┬─────────────────────────┐
│ WORLD        │ RACE MAP                  [OPT B1 B0] │ DECISION   [TRIGGER: …] │
│ BUILDER      │  Daytona map, 10 cars, ghosts         │ candidate table         │
│ (tall)       │  big LAP 46 / status overlay          │ finishing-pos histogram │
│              ├───────────────────────────────────────┼─────────────────────────┤
│              │ POSITION VS LAP        [PAIRED SCEN.] │ STRATEGY SCOREBOARD     │
├──────────────┼───────────────────────────────────────┼─────────────────────────┤
│ SEEDS        │ STINT TIMELINE  SOLID=DONE·OUTLINE=PLAN│ FUEL AND TYRES          │
├──────────────┼───────────────────────────────────────┼─────────────────────────┤
│ RACE TABLE   │ PARAMETERS (6 cards, 3×2)             │ AUDIT LOG               │
└──────────────┴───────────────────────────────────────┴─────────────────────────┘
```

## F.4 RACE tab panels

**World Builder** — `SYNTHETIC | REPLAY` (REPLAY disabled; tooltip "Needs historical timing data; not included"). Fields (right-aligned mono inputs, provenance badge beside each):
- Track (read-only "Daytona Road Course · 5.73 km · schematic") · Race length 1 h / 3 h / 6 h · Start clock · Cars 10 (read-only) · Our grid slot 1–10.
- CAR: fuel capacity, base burn, wear k/lap, pit-lane length, service mode (sequential/parallel, `UNVERIFIED` badge).
- RANDOM PROCESSES: σ grip, κ grip (shows "half-life 8.7 laps"), ρ grip–wear, multiplier model (exp-OU / GBM with an "experiment" tag), caution hazard /lap, P(dry→damp) /tick.
- PLANNER: paths (100/200/400/800), horizon laps, P(fail) limit, CVaR α, λ risk (default 0, label "0 = expected position only"), trigger z / cooldown, pause for planner (turning it off shows "non-deterministic" warning).
- Pre-race fields lock while running (lock icon; `RESET RACE` to change). Risk and planner fields stay live (`PUT /risk`, `PUT /planner`). Server 422 errors are shown inline under the field.

**Seeds** — "dev · 914" in lime mono; chips `weather s0` `caution s1` `grip s2` `wear s3` `fuel s4` `pit s5` `failure s6` `traffic s7`; `REROLL` (next seed in the same split); split selector `dev | val | test` (test disabled with tooltip "frozen settings required"); note "Paired scenarios: every strategy replays the same streams."

**Race Map** (SVG viewBox `0 0 1000 620`, geometry from `GET /track`):
- Track band: smoothed centreline, `--asphalt`, width 28, round joins; 1 px `--asphalt-edge` edges.
- Sector centre line 3 px: SC1 lime, SC2 blue, SC3 orange (85% opacity). Caption: "S1 lime · S2 blue · S3 orange · Schematic layout, lengths scaled to 5.73 km".
- Wetness tint toward `--wet` by `w` (per segment with offsets); debris marker on overridden segments; caution: band edge glows `--caution`.
- Pit road: dashed light-grey path, label `PIT ROAD`, box tick at `u = 200`, timing-line tick inside the lane; start/finish white tick across the band + `START / FINISH`; banking labels `18°` (S01), `31°` (S10, S11).
- Centre overlay: `LAP 46` (Barlow 700, 56 px) and a status line (`GREEN FLAG` / `CAUTION · FIELD BUNCHED` / `RAIN · WETNESS 0.42`).
- Cars: r = 12 circles; rivals `#2B3038` fill, `#6B7380` stroke, white mono number; **our car** `--opt` fill, dark bold number, 2 s expanding pulse ring. **Ghosts**: our car in the other two worlds as hollow rings (2.5 px, `--b0` / `--b1`). Retired cars disappear and are listed under the map with cause.
- Header chips `OPT` `B1` `B0`: click = choose the displayed world (map, race table, fuel panel); shift-click toggles that ghost.
- Hover tooltip: position, gap, laps down, last lap, compound and tyre age, wear and fuel (our car: belief mean ± sd; rivals: "hidden"), stops, current action or plan.
- Note: "Hover a car for state. Ghosts show the same car under each strategy. Rivals follow fixed synthetic policies."

**Position vs Lap** — x lap, y class position P1 (top) to P10. Our car in the three worlds: OPT 2.5 px lime, B1 and B0 1.75 px. Caution bands (`--caution` 12%) with `CAUTION` labels; pit stops as dots (forced stops as hollow dots); vertical cursor at the display lap; fork results as dashed lines. Chip `PAIRED SCENARIO`.

**Stint Timeline** — rows OPT / B1 / B0. Done stints: solid bars in the strategy colour with the lap count inside; current stint growing; planned stints: dashed outlines labelled `plan` (B0: DP plan; B1: projected next stop; OPT: committed `Plan`). `W` tag on wet stints. Right: "3 stops". Header `SOLID = DONE · OUTLINE = PLAN`.

**Decision** — title + trigger badge. Table: `CANDIDATE`, `MEAN`, `P10–P90`, `P(FAIL)` (tooltip with the Wilson 95% interval), `Δ VS B1` (negative = better, green; CI in tooltip). Infeasible rows greyed with a ⚠ marker. Chosen row: lime tint + 3 px lime left bar. Status line: "Committed lap 46 · plan: pit lap 46, fuel + 4 tyres" or "Kept plan — gain not significant". Histogram P1–P10 + DNF: chosen as lime filled bars, B1 as blue outlined bars; caption "Finishing position, OPT vs B1 · N 400 · rounds 50/100/200/400 · 740 ms · rank stability 93%". Pending: skeleton rows "Planning… 400 paths".

**Strategy Scoreboard** — cards `B0 STATIC` (orange), `B1 REACTIVE` (blue), `OPT DYNAMIC` (lime): big expected position from the latest `Projection` (`P7.2`), P10–P90 ("5–10"), "2 of 3 stops", next action ("next stop lap 96" / "pit now").

**Fuel and Tyres** (displayed world, our car) — semicircle gauge of the fuel belief ("38.2 kg of 82.0"); rows: `Burn (belief)` 2.66 kg/lap, `Burn (truth, hidden from strategy)` 2.71 kg/lap (dimmed, lock icon), `Laps to empty`, `Tyre wear (belief)` 19% ± 3, `Tyre temp` 92 °C, compound chip; badge `BURN: ASSUMED`.

**Race Table** — `POS`, `CAR`, `GAP` ("+1 LAP" when down), `LAST`, `TYRE` (laps), `STOPS`; our row lime-tinted; `pit` in `LAST` while in the lane; DNF rows greyed at the bottom with cause. Click a row to highlight the car.

**Parameters** — six cards (3 × 2): `GRIP X`, `WEAR RATE Y`, `FUEL BURN Z`, `WEATHER`, `CAUTION HAZARD`, `PIT STOP`. Each: title, provenance badge, model in a mono box (e.g. `exp-OU · d ln X = κ(θ − ln X)dt + σ dW`), sparkline of belief mean with ±2σ band (lime 20%) and the truth as a white dashed line labelled "truth (hidden)", one value line ("belief 0.982 ± 0.011").
- WEATHER: "Markov chain · per-tick P matrix" and "next 20 ticks from dry: dry 93.9% · damp 4.8% · wet 1.3%" (from the backend's `rainProb` and regime), regime strip.
- CAUTION HAZARD: "h(weather, night) · uncalibrated" and "0.4% per lap · now: green", hazard sparkline.
- PIT STOP: "service = fuel/2 kg·s⁻¹ + 16 s tyres (sequential) · lognormal 9% + 3% slow" and "full stop 84.5 s · net green 71.9 s · net caution 55.5 s".

**Audit Log** — newest first: `Lap 45  caution → OPT chose pit now, fuel + 4 tyres  Δ −1.4`; `Lap 40  grip z 2.3 → kept plan (gain not significant)`; `Lap 31  pit refused: lane closed`; `Lap 0  run start · seed dev-914`. Δ coloured. Click → modal with the decision (`GET /decisions/{id}`).

**Controls** — `INJECT CAUTION` (next step, all worlds), `INJECT RAIN` (wet for 15 ticks), `FUEL SPIKE` (our burn × 1.15 for 5 laps, all worlds), `FORK WHAT-IF` (modal: choose world, from-lap within the last 200 steps, and a plan — pit now / pit in n laps / no stop; result appears as a dashed line and a result card "Fork: pit lap 46 → P6 (parent P7)"). Each control confirms "applies at lap N in all worlds".

**Keyboard**: Space run/pause, 1/2/3/4 speed, S step, C caution, R rain.

## F.5 Animation

- For each car and displayed world find the lap record with `lapStart ≤ t_disp < lapStart + lapTime`.
- Normal lap: `φ = (t_disp − lapStart)/lapTime`, `s = τ⁻¹(φ)` using the τ curve from `RunInfo.init` (cars slow in corners and fly on the banking).
- In-lap: track 0 → 5,613 m over `[lapStart, t_entry)`; entry loss at the lane mouth; lane `u: 0 → 47` until `t_line` (lap ends inside the lane).
- Out-lap: lane `u: 47 → 200` until `t_box`; stationary at the box for `service_s`; lane `200 → 400` until `t_exit` (after exit loss); track 884 → 5,730 m for the rest of the lap (time-scaled with τ between `τ(884)` and 1).
- Caution laps: same mapping with the caution lap time; cars visibly close into the queue.
- Positions interpolate smoothly; never extrapolate beyond the last received record.

## F.6 TRACK tab

- Circuit overview with `Colour by: Effective grip | Segment type | Wetness`; incident zones as dashed orange outlines with level badges (`UNCALIBRATED`); sector ticks.
- Car-marker slider 0–5,730 m: "Lap 41.2% · segment S05 Infield Esses · sector SC2 · incident zone IZ2".
- Segment inspector: Segment, Type, Length, Lap distance, Elevation, Banking, Corner radius (solver; "—" for straights), Drawn min. radius (display only), Dry grip, Wet grip — each with its provenance badge.
- Surface conditions: **global** wetness, track temperature and rubber sliders; **per-segment** wetness offset and debris only (per-segment temperature/rubber are not supported). Read-outs: standing water (mm), hazard, **effective grip** (large orange number) — values from `POST /track/preview`, which uses the same grip function as the solver.
- Speed profile chart (v vs s with segment bands, braking zones visible) and diagnostics table (lap time, sector times, c_f, top speed and location, S04/S08 minima) labelled "illustrative model outputs".
- Toggle `Apply to running race` (off by default): sends the overrides as a `debris`/override injection to the active run.

## F.7 BENCHMARK tab

Config card: families (multi-select, incl. F10-adv marked "unpaired"), seeds per family (capped by split), split, rounds. `RUN BENCHMARK` with progress (done/total, ETA) from `GET /jobs/{id}`. Results:
- Table per family: n, mean ΔP OPT−B1 [boot 95% CI], OPT−B0 [CI], win/tie/loss %, P(finish) B0/B1/OPT, P(win), CVaR₀.₉₅, mean stops, p95 decision ms. CI excluding 0 in OPT's favour → lime; against → red; otherwise grey. Header note: "Performance is reported, not required."
- Forest plot: mean ΔP with CI whiskers per family around zero.
- Experiment cards (M13 §13.5) with their outputs; GBM card shows the clip fraction and an "invalid" badge when > 1%.
- Export CSV / JSON.

## F.8 ASSUMPTIONS tab

Every parameter: group, name, value, unit, range, provenance badge, owning module. Emergent diagnostics (M03 §3.5) labelled illustrative. Per-parameter `SENSITIVITY` button → tornado chart (`POST /sensitivity`). Limitations box (text from `00_PROJECT_RULES.md` and module notes): schematic track, class-level synthetic car, uncalibrated hazards, unverified rules, non-reactive synthetic rivals, relative results only, advisory only.

## F.9 Tests

1. Smoke (Testing Library): each tab renders with mocked API data; provenance badges render for all six tags; `SIMULATED DATA` is always visible.
2. Store: replaying a recorded stream fixture produces the expected position series, stint bars and audit-log entries.
3. Animation: for an in-lap/out-lap fixture the car's position passes through the lane stations in order and is stationary during service.
4. Playwright e2e (against a running backend): create a run, start at 20×, inject a caution; within one displayed lap the flag chip turns amber, the map shows caution, a decision appears with a trigger badge, an audit-log entry is added and a caution band appears on the position chart.
5. Layout: no overflow at 1440 × 900 and 1920 × 1080; Lighthouse accessibility ≥ 90.
