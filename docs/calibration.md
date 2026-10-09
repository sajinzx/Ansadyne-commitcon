# Calibration against public IMSA data

PITWALL's model is synthetic, but four quantities that drive pit strategy are now fitted to public data from the Rolex 24 at Daytona. Everything else keeps its original provenance tag.

| Quantity | Before | Now | Provenance | Basis |
|---|---|---|---|---|
| Reference lap (41 kg, new dry tyres) | 107.0 s | **107.2 s** | FITTED | 2025 Rolex 24 class fastest laps: GTD 1:47.217 (Kirchhöfer), GTD Pro 1:47.156 (Snow), official IMSA results [1] |
| Caution starts | 0.004 per lap background | **0.0135 per lap background** + incident-caused cautions of the 10 simulated cars | FITTED | 2025 Rolex 24: 14 cautions for 102 laps in 781 overall laps, i.e. 1.79 cautions per 100 leader laps [2] |
| Caution length | 3–7 laps, mean 4.65 | **4–10 laps, mean 7.06** | FITTED | same race: 102 caution laps / 14 cautions = 7.3 laps per caution [2] |
| Multi-class traffic | 35% of laps, mean 0.6 s | **50% of laps, mean 1.2 s** (mean loss 0.6 s, variance 1.08 s²) | FITTED | GT cars are passed by GTP and LMP2 cars; sized so the average green GTD lap sits about 1.5 s above the class best, consistent with 719–723 laps for the GTD and GTD Pro winners in 24 h [1] |

Checks against public numbers that were not changed:

| Quantity | Model | Public reference |
|---|---|---|
| Fuel stint | 82 kg / 2.65 kg per lap ≈ 31 laps ≈ 56 min at race pace | GTD cars run "approximately 60 minutes on a full load of fuel" [3] |
| Minimum drive time | 45 min per driver in 3 h and 6 h races (see drivers) | IMSA sprint-race minimum of 45 min for Silver/Bronze drivers [4], 45 min for GTD drivers [3] |
| Maximum drive time | no driver more than 4 h in any 6 h | IMSA rule cited for the Rolex 24 [4] |

How the caution rate was split: the real race has about 60 cars, our model 10. Incidents and failures of the 10 simulated cars cause roughly 0.4 cautions per 100 laps at default rates, so the background rate (0.0135 per lap, before wet and night multipliers) stands for the rest of the field and brings the total to about 1.8 per 100 laps.

What is still not calibrated: incident and failure rates per car, tyre wear rates and the wear cliff, pit-lane length and loss, weather transition probabilities, rival pace spread. These stay `ASSUMED`, `ILLUSTRATIVE` or `UNCALIBRATED`, and the Assumptions tab's sensitivity tool shows how much each one moves the result.

## Sources

1. [IMSA WeatherTech SportsCar Championship, Rolex 24 at Daytona 2025, Race unofficial results (24 hours)](https://imsa.results.alkamelcloud.com/Results/25_2025/02_Daytona%20International%20Speedway/01_IMSA%20WeatherTech%20SportsCar%20Championship/202501251340_Race/24_Hour%2024/03_Results_Race_Unofficial.PDF) — class laps and best laps.
2. [Racing-Reference, 2025 Rolex 24 at Daytona race summary](https://www.racing-reference.info/loopdata/2025-01/TU) — "Cautions: 14 for 102 laps", 781 laps.
3. [Sportscar365, Michelin IMSA Insider: pit stop math](https://sportscar365.com/imsa/iwsc/michelin-imsa-insider-pit-stop-math/) — GTD fuel stint of about 60 minutes, 45-minute minimum drive time for GTD drivers.
4. [Frontstretch, IMSA unveils new drive time rules (2016)](https://frontstretch.com/2016/12/16/imsa-unveils-new-drive-time-rules) — 4 h in any 6 h limit at the Rolex 24, minimum drive times by event.
