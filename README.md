# PITWALL — The Impossible Pit Stop

Race simulator and adaptive pit-strategy engine for the Daytona International Speedway road course, with a live strategy dashboard.

Ten GT3-class cars race a synthetic event; our car (#12) runs under three strategies side by side on identical random streams:

- **B0** — static plan from offline dynamic programming
- **B1** — reactive crew-chief rules
- **OPT** — adaptive Monte Carlo planner that estimates hidden car state and replans on cautions, weather and wear

The full specification lives in [`docs/spec`](docs/spec/README.md). Implementation follows it gate by gate.

> All numbers are synthetic, labelled by provenance (`REPORTED`, `ILLUSTRATIVE`, `ASSUMED`, `UNCALIBRATED`, `UNVERIFIED`, `FITTED`). Results compare strategies under stated assumptions; they are not predictions of real races. Advisory only.
