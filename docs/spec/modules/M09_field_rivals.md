# M09 — The field: ten cars and rival policies

| | |
|---|---|
| **Owns** | `packages/shared/config/field.json`, `packages/engine/src/strategy/rivals.ts` |
| **Depends on** | M01 (rival pre-draws), M07 (refuel helper), M08 (observation type) |
| **Used by** | M08, M12 (rival model in rollouts), frontend |
| **Gate** | 3 |
| **Audit fixes** | 3.4 (synthetic rivals labelled), Finding 12 (rollout rival model in M12), C12/15.2 (`fixedStint` units), R11 |

## 9.1 `field.json` (create exactly this)

Car models are generic GT3 types; **all performance numbers are synthetic and BoP-equalised**, not manufacturer data (`ASSUMED`). Our car is #12.

```json
{
  "ego": 12,
  "note": "class-level synthetic models; not manufacturer data",
  "cars": [
    { "no": 12, "label": "Our car · R8 LMS GT3-type", "paceFactor": 1.000, "gripSkill": 1.000, "wearMult": 1.00, "burnMult": 1.00, "wetSkill": 1.00, "grid": 6, "archetype": "ego" },
    { "no": 5,  "label": "911 GT3 R-type",     "paceFactor": 0.996, "gripSkill": 1.004, "wearMult": 1.05, "burnMult": 1.01, "wetSkill": 1.02, "grid": 1, "archetype": "reactive" },
    { "no": 45, "label": "Huracán GT3-type",   "paceFactor": 0.998, "gripSkill": 1.000, "wearMult": 0.97, "burnMult": 1.02, "wetSkill": 0.98, "grid": 2, "archetype": "fixedStint" },
    { "no": 9,  "label": "M4 GT3-type",        "paceFactor": 0.999, "gripSkill": 0.998, "wearMult": 1.00, "burnMult": 0.98, "wetSkill": 1.00, "grid": 3, "archetype": "aggressiveCaution" },
    { "no": 20, "label": "296 GT3-type",       "paceFactor": 1.001, "gripSkill": 1.002, "wearMult": 1.08, "burnMult": 1.00, "wetSkill": 1.01, "grid": 4, "archetype": "reactive" },
    { "no": 8,  "label": "AMG GT3-type",       "paceFactor": 1.002, "gripSkill": 0.999, "wearMult": 0.95, "burnMult": 1.03, "wetSkill": 0.99, "grid": 5, "archetype": "conservative" },
    { "no": 3,  "label": "Z06 GT3.R-type",     "paceFactor": 1.003, "gripSkill": 1.000, "wearMult": 1.02, "burnMult": 0.99, "wetSkill": 0.97, "grid": 7, "archetype": "fixedStint" },
    { "no": 48, "label": "Mustang GT3-type",   "paceFactor": 1.004, "gripSkill": 0.997, "wearMult": 1.00, "burnMult": 1.01, "wetSkill": 1.00, "grid": 8, "archetype": "aggressiveCaution" },
    { "no": 27, "label": "720S GT3-type",      "paceFactor": 1.005, "gripSkill": 1.001, "wearMult": 1.04, "burnMult": 1.00, "wetSkill": 1.03, "grid": 9, "archetype": "reactive" },
    { "no": 64, "label": "RC F GT3-type",      "paceFactor": 1.007, "gripSkill": 0.998, "wearMult": 0.98, "burnMult": 0.97, "wetSkill": 1.00, "grid": 10, "archetype": "conservative" }
  ]
}
```

- Start-of-race jitter (rivals only): `paceFactor × exp(0.002·rivalPaceN[c])`, `gripSkill × exp(0.002·rivalGripN[c])`.
- Rolling start: grid slot g starts with race time `0.6·(g − 1)` s at the line.
- `wearMult` multiplies `k_t`; `burnMult` multiplies `q_k`; `wetSkill` enters through the smooth `wetSkillFactor` (M04 §4.2).
- The World Builder can change our grid slot; rivals keep their relative order.

## 9.2 Rival policies (`rivals.ts`)

Rivals are world-side agents. Each uses **its own observation** (same observer as our car: noisy fuel gauge, tyre age, flags) and simple rules. They do **not** react to our strategy; the UI says so ("rivals follow fixed synthetic policies"). Thresholds are jittered once per race: `threshold × (1 + 0.1·(2·rivalPolicyU[c][i] − 1))`.

| Archetype | Rule |
|---|---|
| `reactive` | B1 rules (M10 §10.2) with jittered thresholds |
| `fixedStint` | Pit every `floor((capacity − reserveLaps·q̂)/q̂)` laps (= 29 at defaults); tyres every second stop; pits under caution (once the lane opens) only if within 6 laps of its next planned stop |
| `aggressiveCaution` | B1 rules, plus: pits under every caution once the lane opens if it has used ≥ 30% of its tank since the last stop |
| `conservative` | B1 rules with `reserveLaps = 2`; always takes tyres; never pits under caution unless fuel for < 8 laps remains |

All rivals use the refuel helper (M07 §7.4) and are subject to the same engine legality and forced stops as our car.

## 9.3 Tests

1. Field loads and validates; exactly one `ego`; grid slots are a permutation of 1–10.
2. `fixedStint` stint length = 29 laps at defaults (units check).
3. Rival actions are identical across the three worlds for the first 5 steps when our car's actions are identical (pairing).
4. No rival policy reads any truth field (same lint rule as strategies; rival policies live under `strategy/`).
