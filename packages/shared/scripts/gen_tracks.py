#!/usr/bin/env python3
"""Generate the schematic track configs (packages/shared/config/track.<id>.json) for the extra circuits.

Each circuit is described once below: its real lap length, the segments in driving order (name, type, length in
metres, solver corner radius and apex windows, grip) and a hand-drawn outline in the shared 1000 x 620 map frame,
split into the same segments. Corner radii and grips are ILLUSTRATIVE: the calibration step fits the car's peak
friction so that the reference lap matches the track's FITTED lap time (car overrides in configs.ts).

Run:  python3 packages/shared/scripts/gen_tracks.py
"""
import json
import math
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "config"
ILL = "ILLUSTRATIVE"


def P(v, prov=ILL, note=None):
    d = {"value": v, "provenance": prov}
    if note:
        d["note"] = note
    return d


def seg_len(pts):
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def offset_path(pts, d, centroid):
    """Offset an open polyline by d pixels towards the circuit's centroid."""
    out = []
    for i, p in enumerate(pts):
        a = pts[max(0, i - 1)]
        b = pts[min(len(pts) - 1, i + 1)]
        tx, ty = b[0] - a[0], b[1] - a[1]
        n = math.hypot(tx, ty) or 1
        nx, ny = -ty / n, tx / n
        # pick the side facing the centroid
        if (centroid[0] - p[0]) * nx + (centroid[1] - p[1]) * ny < 0:
            nx, ny = -nx, -ny
        out.append([round(p[0] + d * nx, 1), round(p[1] + d * ny, 1)])
    return out


def point_at(outline_pts, cum, s_px):
    for i in range(len(outline_pts) - 1):
        if cum[i + 1] >= s_px:
            w = (s_px - cum[i]) / ((cum[i + 1] - cum[i]) or 1)
            a, b = outline_pts[i], outline_pts[i + 1]
            return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w]
    return list(outline_pts[-1])


def build(t):
    L = t["length_m"]
    segs = t["segments"]
    assert abs(sum(s["len"] for s in segs) - L) < 1e-6, (t["id"], sum(s["len"] for s in segs), L)
    # closed outline of all drawn points; each segment lists its own points, the first one shared with the previous
    flat = []
    for j, s in enumerate(segs):
        pts = s["pts"] if j == 0 else s["pts"][1:]
        flat.extend(pts)
    centroid = (sum(p[0] for p in flat) / len(flat), sum(p[1] for p in flat) / len(flat))
    # re-split the drawn outline in proportion to the real segment lengths, so a car moves across the map at a
    # speed proportional to its real speed (the hand-drawn split only guides where each corner is drawn)
    ring = flat + [flat[0]] if flat[-1] != flat[0] else flat
    cum = [0.0]
    for i in range(len(ring) - 1):
        cum.append(cum[-1] + math.dist(ring[i], ring[i + 1]))
    total = cum[-1]
    drawn = []
    acc = 0.0
    for s in segs:
        a_px, b_px = acc / L * total, (acc + s["len"]) / L * total
        pts = [point_at(ring, cum, a_px)]
        pts += [list(ring[i]) for i in range(len(ring)) if a_px + 1 < cum[i] < b_px - 1]
        pts.append(point_at(ring, cum, b_px))
        drawn.append([[round(x, 1), round(y, 1)] for x, y in pts])
        acc += s["len"]
    drawn[-1][-1] = drawn[0][0]
    for j in range(len(drawn) - 1):
        drawn[j + 1][0] = drawn[j][-1]
    out_segs = []
    start = 0.0
    total_px = 0.0
    for j, s in enumerate(segs):
        s = {**s, "pts": drawn[j]}
        end = start + s["len"]
        r = s.get("r")
        seg = {
            "id": f"S{j + 1:02d}",
            "name": s["name"],
            "type": s["type"],
            "start_m": round(start),
            "end_m": round(end) if j < len(segs) - 1 else L,
            "elevation_m": P(s.get("elev", 0)),
            "banking_deg": P(s.get("bank", 0)),
            "cornerRadius_m": P(r, ILL, s.get("rnote")) if r else None,
            "drawnMinRadius_m": r if r else 0,
            "dryGrip": P(s.get("dry", 1.0)),
            "wetGrip": P(s.get("wet", 0.59)),
            "apex": [{"at": a, "window_m": w} for a, w in s.get("apex", [])],
            "points": s["pts"],
        }
        total_px += seg_len(s["pts"])
        out_segs.append(seg)
        start = end
    # the hand-drawn outline must be closed and each drawn segment must join the next
    assert segs[-1]["pts"][-1] == segs[0]["pts"][0], f"{t['id']} outline is not closed"
    for j in range(len(segs) - 1):
        assert segs[j]["pts"][-1] == segs[j + 1]["pts"][0], f"{t['id']} segment {j} does not join the next"

    mean_dry = sum((s["end_m"] - s["start_m"]) * s["dryGrip"]["value"] for s in out_segs) / L

    # pit lane: drawn parallel to the track from the entry to the exit, on the inside
    lane = t["pit"]
    outline = []
    for j, s in enumerate(out_segs):
        outline.extend(s["points"] if j == 0 else s["points"][1:])
    # sample the drawn track around the line from entry (before the line) to exit (after it)
    def xy_at(sm):
        sm %= L
        for s in out_segs:
            if s["start_m"] <= sm < s["end_m"] or s is out_segs[-1]:
                f = (sm - s["start_m"]) / (s["end_m"] - s["start_m"])
                pts = s["points"]
                cum = [0.0]
                for i in range(len(pts) - 1):
                    cum.append(cum[-1] + math.dist(pts[i], pts[i + 1]))
                return point_at(pts, cum, f * cum[-1])
        raise AssertionError
    span = (L - lane["entry"]) + lane["exit"]
    raw = [xy_at(lane["entry"] + span * k / 16) for k in range(17)]
    lane_pts = offset_path(raw, 16, centroid)

    sectors = []
    # sector boundaries at the segment starts nearest to a third and two thirds of the lap
    cuts = [0] + [min((s["start_m"] for s in out_segs[1:]), key=lambda x: abs(x - L * f)) for f in (1 / 3, 2 / 3)] + [L]
    for i in range(3):
        sectors.append({"id": f"SC{i + 1}", "from_m": cuts[i], "to_m": cuts[i + 1], "provenance": ILL})

    zones = []
    for k, (seg_idx, name, cats, level) in enumerate(t["zones"]):
        s = out_segs[seg_idx]
        zones.append({"id": f"IZ{k + 1}", "name": name, "from_m": max(0, s["start_m"] - 100), "to_m": s["end_m"], "categories": cats, "level": level, "provenance": "UNCALIBRATED"})

    cfg = {
        "id": t["id"],
        "name": t["name"],
        "country": t["country"],
        "lapLength_m": P(L, "REPORTED", t["length_note"]),
        "viewBox": [0, 0, 1000, 620],
        "meanDryGrip": round(mean_dry, 4),
        "segments": out_segs,
        "pitLane": {
            "entry_s_m": lane["entry"],
            "exit_s_m": lane["exit"],
            "laneLength_m": P(lane.get("length", 400), ILL),
            "timingLine_u_m": P(round(lane.get("length", 400) * (L - lane["entry"]) / span), ILL, "lane distance from pit entry to where the start/finish line crosses the lane"),
            "box_u_m": P(round(lane.get("length", 400) / 2), ILL),
            "speedLimit_kph": P(60, ILL, "assumed to apply under green and caution"),
            "entryLoss_s": P(2.0, ILL),
            "exitLoss_s": P(1.5, ILL),
            "points": lane_pts,
        },
        "sectors": sectors,
        "incidentZones": zones,
        "car": t["car"],
    }
    path = OUT / f"track.{t['id']}.json"
    path.write_text(json.dumps(cfg, indent=1, ensure_ascii=False) + "\n")
    ratios = [round(seg_len(s["points"]) / (s["end_m"] - s["start_m"]), 3) for s in out_segs]
    print(f"{t['id']}: {len(out_segs)} segments, L={L} m, drawn {total_px:.0f} px, px/m by segment {ratios}")


SEBRING = {
    "id": "sebring",
    "name": "Sebring International Raceway (schematic)",
    "country": "USA",
    "length_m": 6021,
    "length_note": "3.741 mi full course (2025 12 Hours of Sebring)",
    "segments": [
        {"name": "Start/Finish Straight", "type": "straight", "len": 560, "pts": [[300, 520], [420, 528], [540, 532], [610, 528]]},
        {"name": "Turn 1", "type": "infield_turn", "len": 260, "r": 70, "apex": [[0.5, 70]], "dry": 1.0, "pts": [[610, 528], [665, 512], [700, 478]]},
        {"name": "Turns 3–5 Esses", "type": "chicane", "len": 640, "r": 58, "apex": [[0.3, 50], [0.7, 50]], "dry": 0.99, "pts": [[700, 478], [712, 430], [758, 400], [774, 352], [808, 318]]},
        {"name": "Turn 7 Hairpin", "type": "infield_turn", "len": 300, "r": 22, "apex": [[0.5, 40]], "dry": 0.98, "wet": 0.56, "pts": [[808, 318], [842, 282], [828, 246], [790, 240]]},
        {"name": "Turns 8–10", "type": "infield_turn", "len": 620, "r": 85, "apex": [[0.35, 70], [0.8, 60]], "pts": [[790, 240], [730, 238], [680, 210], [628, 196]]},
        {"name": "Turns 11–13 (Tower)", "type": "infield_turn", "len": 700, "r": 65, "apex": [[0.4, 60], [0.85, 60]], "dry": 0.99, "pts": [[628, 196], [580, 162], [520, 148], [470, 140]]},
        {"name": "Ullman Straight", "type": "straight", "len": 1150, "dry": 1.02, "wet": 0.6, "pts": [[470, 140], [380, 140], [280, 142], [190, 148]]},
        {"name": "Turn 15", "type": "infield_turn", "len": 260, "r": 30, "apex": [[0.5, 40]], "dry": 0.98, "wet": 0.56, "pts": [[190, 148], [142, 168], [134, 214]]},
        {"name": "Turn 16 run", "type": "straight", "len": 560, "pts": [[134, 214], [168, 262], [208, 312], [238, 360]]},
        {"name": "Turn 17 Sunset Bend", "type": "infield_turn", "len": 971, "r": 150, "apex": [[0.5, 420]], "dry": 0.97, "wet": 0.55, "rnote": "long bumpy right-hander onto the front straight", "pts": [[238, 360], [252, 420], [270, 480], [300, 520]]},
    ],
    "pit": {"entry": 5900, "exit": 420},
    "zones": [(1, "Turn 1 braking", ["Braking-zone contact"], 2), (3, "Turn 7 hairpin", ["Spin", "Contact"], 2), (7, "Turn 15", ["Lock-up", "Contact"], 1), (9, "Sunset Bend", ["High-speed spin", "Debris"], 3)],
    "car": {"lapRef_s": P(120.0, "FITTED", "2025 12 Hours of Sebring GTD pole 1:59.131 and GTD Pro pole 1:59.225; race reference set 0.9 s slower")},
}

ROAD_ATLANTA = {
    "id": "road-atlanta",
    "name": "Michelin Raceway Road Atlanta (schematic)",
    "country": "USA",
    "length_m": 4088,
    "length_note": "2.540 mi, 12 turns (2025 Petit Le Mans)",
    "segments": [
        {"name": "Front Straight", "type": "straight", "len": 330, "pts": [[200, 430], [260, 430], [330, 428]]},
        {"name": "Turn 1 (uphill)", "type": "infield_turn", "len": 200, "r": 85, "apex": [[0.5, 60]], "elev": 8, "pts": [[330, 428], [372, 410], [392, 372]]},
        {"name": "Esses (Turns 2–5)", "type": "chicane", "len": 720, "r": 150, "apex": [[0.25, 60], [0.5, 60], [0.75, 60]], "elev": 12, "dry": 0.99, "pts": [[392, 372], [430, 330], [476, 352], [526, 318], [576, 344], [618, 322]]},
        {"name": "Turn 6", "type": "infield_turn", "len": 240, "r": 75, "apex": [[0.5, 60]], "pts": [[618, 322], [662, 300], [680, 262]]},
        {"name": "Turn 7", "type": "infield_turn", "len": 200, "r": 40, "apex": [[0.5, 40]], "dry": 0.98, "wet": 0.56, "pts": [[680, 262], [668, 226], [642, 214]]},
        {"name": "Back Straight", "type": "straight", "len": 900, "dry": 1.02, "wet": 0.6, "pts": [[642, 214], [720, 196], [800, 180], [872, 168]]},
        {"name": "Turn 10a/10b Chicane", "type": "chicane", "len": 250, "r": 40, "apex": [[0.35, 30], [0.7, 30]], "dry": 0.97, "wet": 0.55, "pts": [[872, 168], [906, 184], [918, 226], [896, 256]]},
        {"name": "Turn 11 (under the bridge)", "type": "infield_turn", "len": 450, "r": 300, "apex": [[0.5, 300]], "elev": -10, "pts": [[896, 256], [852, 300], [790, 352], [720, 410]]},
        {"name": "Turn 12", "type": "infield_turn", "len": 320, "r": 130, "apex": [[0.5, 120]], "elev": -14, "dry": 0.99, "pts": [[720, 410], [660, 458], [590, 478], [520, 482]]},
        {"name": "Front Stretch", "type": "straight", "len": 478, "pts": [[520, 482], [400, 480], [290, 468], [200, 430]]},
    ],
    "pit": {"entry": 3930, "exit": 380},
    "zones": [(1, "Turn 1", ["Braking-zone contact"], 2), (4, "Turn 7", ["Spin"], 1), (6, "Turn 10 chicane", ["Chicane contact", "Cutting"], 2), (7, "Turn 11 bridge", ["High-speed off", "Debris"], 3)],
    "car": {"lapRef_s": P(79.6, "FITTED", "2025 Petit Le Mans GTD pole 1:18.316, GTD Pro pole 1:18.523; fastest GT3 race laps about 1:20.0")},
}

WATKINS_GLEN = {
    "id": "watkins-glen",
    "name": "Watkins Glen International (schematic)",
    "country": "USA",
    "length_m": 5472,
    "length_note": "3.4 mi long course with the Boot",
    "segments": [
        {"name": "Front Straight", "type": "straight", "len": 450, "pts": [[740, 540], [748, 470], [752, 410]]},
        {"name": "Turn 1 (The 90)", "type": "infield_turn", "len": 200, "r": 45, "apex": [[0.5, 40]], "dry": 0.98, "wet": 0.56, "pts": [[752, 410], [760, 372], [736, 350]]},
        {"name": "The Esses", "type": "chicane", "len": 600, "r": 200, "apex": [[0.3, 80], [0.7, 80]], "elev": 18, "pts": [[736, 350], [700, 318], [712, 270], [682, 230]]},
        {"name": "Back Straight", "type": "straight", "len": 800, "dry": 1.02, "wet": 0.6, "pts": [[682, 230], [630, 180], [570, 130], [520, 100]]},
        {"name": "Bus Stop (Inner Loop)", "type": "chicane", "len": 300, "r": 35, "apex": [[0.35, 30], [0.7, 30]], "dry": 0.97, "wet": 0.55, "pts": [[520, 100], [486, 86], [462, 110], [432, 96]]},
        {"name": "Outer Loop", "type": "infield_turn", "len": 400, "r": 170, "apex": [[0.5, 150]], "pts": [[432, 96], [380, 106], [338, 150], [324, 196]]},
        {"name": "The Boot (Turns 5–8)", "type": "infield_turn", "len": 1150, "r": 85, "apex": [[0.2, 60], [0.5, 60], [0.8, 60]], "elev": -12, "dry": 0.99, "pts": [[324, 196], [300, 260], [244, 328], [196, 398], [222, 458], [300, 478]]},
        {"name": "Turns 9–10", "type": "infield_turn", "len": 700, "r": 120, "apex": [[0.35, 80], [0.8, 80]], "pts": [[300, 478], [380, 462], [450, 470], [512, 500]]},
        {"name": "Turn 11", "type": "infield_turn", "len": 300, "r": 60, "apex": [[0.5, 50]], "pts": [[512, 500], [552, 540], [600, 556]]},
        {"name": "Run to the line", "type": "straight", "len": 572, "pts": [[600, 556], [660, 560], [712, 556], [740, 540]]},
    ],
    "pit": {"entry": 5320, "exit": 380},
    "zones": [(1, "Turn 1 (The 90)", ["Braking-zone contact"], 2), (4, "Bus Stop", ["Chicane contact", "Cutting"], 2), (2, "The Esses", ["High-speed off"], 3), (8, "Turn 11", ["Spin"], 1)],
    "car": {"lapRef_s": P(105.5, "FITTED", "2025 Six Hours of the Glen GTD Pro pole 1:44.595, GTD pole 1:44.788; race reference set about 0.9 s slower")},
}

SPA = {
    "id": "spa",
    "name": "Circuit de Spa-Francorchamps (schematic)",
    "country": "Belgium",
    "length_m": 7004,
    "length_note": "7.004 km Grand Prix circuit",
    "segments": [
        {"name": "Start Straight", "type": "straight", "len": 260, "pts": [[260, 150], [222, 146], [186, 140]]},
        {"name": "La Source", "type": "infield_turn", "len": 160, "r": 22, "apex": [[0.5, 40]], "dry": 0.98, "wet": 0.56, "pts": [[186, 140], [140, 132], [130, 170], [150, 196]]},
        {"name": "Eau Rouge – Raidillon", "type": "infield_turn", "len": 560, "r": 150, "apex": [[0.55, 200]], "elev": 35, "pts": [[150, 196], [190, 236], [226, 286], [262, 262]]},
        {"name": "Kemmel Straight", "type": "straight", "len": 1050, "dry": 1.02, "wet": 0.6, "pts": [[262, 262], [360, 300], [460, 340], [562, 382]]},
        {"name": "Les Combes", "type": "chicane", "len": 340, "r": 42, "apex": [[0.3, 40], [0.7, 40]], "dry": 0.98, "pts": [[562, 382], [602, 392], [622, 430], [602, 460]]},
        {"name": "Bruxelles – Malmedy", "type": "infield_turn", "len": 560, "r": 55, "apex": [[0.3, 50], [0.75, 60]], "elev": -20, "pts": [[602, 460], [560, 478], [524, 452], [500, 488]]},
        {"name": "Pouhon", "type": "infield_turn", "len": 780, "r": 110, "apex": [[0.35, 160], [0.75, 160]], "elev": -25, "pts": [[500, 488], [516, 536], [566, 566], [640, 560]]},
        {"name": "Fagnes – Campus", "type": "chicane", "len": 760, "r": 70, "apex": [[0.3, 60], [0.7, 60]], "pts": [[640, 560], [690, 530], [712, 482], [748, 446]]},
        {"name": "Stavelot – Blanchimont", "type": "infield_turn", "len": 1820, "r": 300, "apex": [[0.1, 160], [0.75, 300]], "elev": 20, "dry": 1.01, "rnote": "long flat-out curves back up the hill", "pts": [[748, 446], [808, 424], [872, 392], [846, 330], [760, 280], [640, 228], [500, 190], [420, 176]]},
        {"name": "Bus Stop Chicane", "type": "chicane", "len": 360, "r": 22, "apex": [[0.35, 30], [0.7, 30]], "dry": 0.97, "wet": 0.55, "pts": [[420, 176], [380, 172], [360, 150], [330, 160]]},
        {"name": "Pit Straight", "type": "straight", "len": 354, "pts": [[330, 160], [296, 154], [260, 150]]},
    ],
    "pit": {"entry": 6700, "exit": 230},
    "zones": [(1, "La Source", ["Turn-1 contact", "Spin"], 2), (2, "Eau Rouge – Raidillon", ["High-speed crash", "Debris"], 3), (4, "Les Combes", ["Braking-zone contact"], 2), (9, "Bus Stop", ["Chicane contact", "Cutting"], 2)],
    "car": {"lapRef_s": P(137.8, "FITTED", "2025 24 Hours of Spa: best GT3 laps 2:17.0–2:17.9; reference set at 2:17.8")},
}

if __name__ == "__main__":
    for t in (SEBRING, ROAD_ATLANTA, WATKINS_GLEN, SPA):
        build(t)
