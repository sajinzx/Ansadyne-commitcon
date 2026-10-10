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

## Other circuits

Four more circuits use the same car. For each one the reference lap is FITTED to public 2025 timing, the layout is schematic with real lap lengths, and the per-lap quantities (fuel burn, tyre wear, background caution rate, traffic encounters) are scaled by the lap-length ratio to Daytona. Corner radii are ILLUSTRATIVE; the calibration fits peak friction to each reference lap (μ_peak 1.46–1.58, against 1.37 at Daytona).

| Circuit | Lap length | Reference lap | Basis |
|---|---|---|---|
| Sebring International Raceway | 6,021 m (3.741 mi) | 2:00.0 | 2025 12 Hours of Sebring: GTD pole 1:59.131, GTD Pro pole 1:59.225 [5] |
| Michelin Raceway Road Atlanta | 4,088 m (2.540 mi) | 1:19.6 | 2025 Petit Le Mans: GTD pole 1:18.316, GTD Pro pole 1:18.523 [6]; fastest GT3 race laps about 1:20.0 [7] |
| Watkins Glen International | 5,472 m (3.4 mi, with the Boot) | 1:45.5 | 2025 Six Hours of the Glen: GTD Pro pole 1:44.595, GTD pole 1:44.788 [8] |
| Circuit de Spa-Francorchamps | 7,004 m | 2:17.8 | 2025 24 Hours of Spa: best GT3 laps 2:17.0–2:17.9 [9] |

Pole times are single qualifying laps on low fuel, so the race reference is set about 0.8–1 s slower. Drive-time rules and the field are the same on every circuit.

## Sources

1. [IMSA WeatherTech SportsCar Championship, Rolex 24 at Daytona 2025, Race unofficial results (24 hours)](https://imsa.results.alkamelcloud.com/Results/25_2025/02_Daytona%20International%20Speedway/01_IMSA%20WeatherTech%20SportsCar%20Championship/202501251340_Race/24_Hour%2024/03_Results_Race_Unofficial.PDF) — class laps and best laps.
2. [Racing-Reference, 2025 Rolex 24 at Daytona race summary](https://www.racing-reference.info/loopdata/2025-01/TU) — "Cautions: 14 for 102 laps", 781 laps.
3. [Sportscar365, Michelin IMSA Insider: pit stop math](https://sportscar365.com/imsa/iwsc/michelin-imsa-insider-pit-stop-math/) — GTD fuel stint of about 60 minutes, 45-minute minimum drive time for GTD drivers.
4. [Frontstretch, IMSA unveils new drive time rules (2016)](https://frontstretch.com/2016/12/16/imsa-unveils-new-drive-time-rules) — 4 h in any 6 h limit at the Rolex 24, minimum drive times by event.
5. [2025 12 Hours of Sebring (Wikipedia)](https://en.wikipedia.org/wiki/2025_12_Hours_of_Sebring) — class pole times, circuit length.
6. [2025 Petit Le Mans (Wikipedia)](https://en.wikipedia.org/wiki/2025_Petit_Le_Mans) — class pole times, circuit length.
7. [Motorsport.com, Petit Le Mans 2025 fastest laps](https://www.motorsport.com/imsa/results/2025/petit-le-mans-656887/?st=FL) — GT3 race laps.
8. [RACER, MSR Acura takes Glen 6 Hour pole (2025)](https://racer.com/2025/06/21/MSR-Acura-Glen-6-Hour-pole) — GTD Pro and GTD pole times.
9. [SRO, 24H Spa 2025 result list](https://www.intercontinentalgtchallenge.com/images/results/145/GTWCEU_GT3%2024H%20Spa_BT_ResultList_1-0.pdf) — best lap times.
