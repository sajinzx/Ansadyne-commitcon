# Why OPT kept losing, and what fixed it

OPT (the Monte Carlo planner) was meant to beat B1 (the rule-based crew chief) and often didn't. Rebuilding the
benchmark as a command-line tool (`pnpm bench`) and tracing single races (`pnpm tsx packages/engine/scripts/trace.ts F2 3 1`)
showed that the planning maths was fine. The losses came from **five plumbing bugs and one missing rule**. Each one
made OPT pay for a pit stop it didn't need. In a 1-hour race a wasted green-flag stop costs about 60 s, which is
several places.

The team radio made most of these easy to see. A message like *"BOX BOX — lap 33 — 0.0 kg fuel, fresh DRY tyres"*
with 2 minutes left is plainly wrong.

| # | Symptom on the radio | Cause | Fix |
|---|---|---|---|
| 1 | Car pits, then on the next lap the planner panics ("stay" = 92% failure) and books another stop | The observation at the end of the in-lap still shows the **pre-service** fuel (the refuel lands with the out-lap), so the planner saw a car with 5 kg about to run dry | OPT doesn't plan on the in-lap observation. A stop on the out-lap is illegal anyway |
| 2 | "Pit, swap to slicks" decided, but the car leaves on wets, then pits again | `opt.ts` replaced the planned compound with "whatever suits the current wetness", so a deliberate swap was undone | OPT fits the compound its plan chose |
| 3 | A stop committed earlier still runs in the last laps with 0 kg of fuel and new tyres | A candidate's first stop is firm and could outlive its reason | Such a stop is dropped if the fuel already reaches the flag with the reserve, the tyres stay short of the cliff, and no driver change is needed. This check counts laps at **green** pace (counting at caution pace undercounted them and dropped stops that were needed) |
| 4 | OPT stays on slicks on a damp track for 5–7 laps after B1 switched to wets | OPT and its rollouts only swapped when slicks were undriveable (wetness > 0.5). B1 swaps at 0.30 | OPT, its rollouts and B1 now share the wet-in and wet-out thresholds. The planner times stops; it doesn't gamble on slicks in the rain |
| 5 | Wets → slicks → wets within three laps | "Swap compound" was offered whenever the track was even slightly wet | Hysteresis: slicks only once wetness is at or below the wet-out level; wets only on a wetting track |
| 6 | One stop for fuel under the caution, then a second stop two laps later for the driver change | Nobody planned around the **minimum drive time** (each driver must drive ≥ 20 min in a 1-hour race). Missing it puts the car behind every compliant finisher, and the rollouts didn't score that at all | All crews (B0, B1, OPT and the rollouts' base policy) now take the driver change at the last safe lap, or earlier under a caution. Rollouts classify a violating car last. Under a caution, OPT holds a stop for a lap or two so the fuel and driver change happen in one visit |

Smaller fixes: the fuel trigger no longer fires every 3 laps about a "planned stop" that falls after the flag.

## The effect, step by step (dev split, 40 seeds per family, 1-hour races)

Each fix was checked against the same 40 seeds, so the differences are paired. Negative = OPT finishes ahead of B1.

| Step | F1 calm | F2 early caution | F3 mid caution | F5 random | F6 rain | F7 high wear | F10 worst timing |
|---|---|---|---|---|---|---|---|
| before | +0.40 | −1.30\* | −0.30 | 0.00 | +0.13 | −0.90\* | −0.88\* |
| + fixes 1–3 | −0.23 | −0.03 | −0.10 | −0.20 | −0.38 | −0.85 | −0.10 |
| + fix 4 | −0.23 | −0.40 | −0.10 | −0.17 | −0.15 | −0.40 | −0.07 |
| + fix 6, B0/B1 drive-time aware | −0.20 | +0.17 | −0.35 | −0.03 | −0.03 | +0.17 | −0.13 |
| + fix 5, one-visit stops | −0.20 | −0.50 | −0.33 | 0.00 | −0.05 | −0.03 | −0.10 |

\* In the "before" row, B0 and B1 broke the drive-time rule whenever a 1-hour race needed no fuel stop, and paid the
penalty. OPT's extra stops happened to carry the driver change, so those "wins" were B1 losing on a rule it didn't
know about, not good strategy. Once every crew knew the rule (row 4), the true picture showed up, and fix 6 then
gave a real gain.

## Held-out result (validation split, 200 seeds per family, 1-hour races)

The validation seeds (5000+) were never used while tuning. See [bench/README.md](bench/README.md) for the full
table, the before/after comparison on the same seeds, and how to reproduce it.

## What still limits OPT

- **It's B1 plus timing.** After its first committed stop, OPT follows the B1 rules until the next decision. That
  keeps it safe, but it can't plan a two-stop race end to end.
- **Push mode does most of the work.** Most of the calm-race gain comes from "push to the stop" (more pace and fuel when
  the fuel allows). That's a real lever, but a modest one.
- **The rollouts are a simplified race.** Rivals are modelled by fuel windows and a covering rule, not by their full
  crew logic. Rain pace is rougher than in the engine.
- **1-hour races only.** The 3-hour and 6-hour formats weren't benchmarked at 200 seeds. They take about 6× longer per
  seed.
