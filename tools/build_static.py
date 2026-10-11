#!/usr/bin/env python3
"""Build data/static.json (for the 3D page) and data/index.json (for the server)
from Saskatoon Transit's static GTFS zip.

Usage:  python3 tools/build_static.py [path/to/google_transit.zip]
Default zip path: data/google_transit.zip
Re-run whenever Saskatoon Transit publishes a new GTFS (the current one ends 2027-01-02).
Standard library only.
"""
import csv, io, json, math, os, sys, zipfile, collections, colorsys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIP = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data", "google_transit.zip")

LAT0, LON0 = 52.1300, -106.6600          # City Centre hub, scene origin
KX = math.cos(math.radians(LAT0)) * 111320.0
KY = 110540.0

# South Saskatchewan River centreline, OpenStreetMap (ODbL), ways 1296314129, 427247769,
# 1296314136, 760402882, simplified. (c) OpenStreetMap contributors.
RIVER = [[52.02544,-106.71236],[52.02652,-106.70881],[52.036,-106.70854],[52.03924,-106.70974],[52.04187,-106.71162],[52.04309,-106.71261],[52.04507,-106.71423],[52.0458,-106.71713],[52.05072,-106.71945],[52.0527,-106.72184],[52.06522,-106.7309],[52.07233,-106.73262],[52.07505,-106.73002],[52.07855,-106.72453],[52.08075,-106.71749],[52.08337,-106.71452],[52.08822,-106.70908],[52.09256,-106.70178],[52.09302,-106.7014],[52.09757,-106.6976],[52.10005,-106.69121],[52.10288,-106.68642],[52.10856,-106.68292],[52.11407,-106.67893],[52.11482,-106.6784],[52.11829,-106.67587],[52.12013,-106.67358],[52.12139,-106.67029],[52.12148,-106.66582],[52.12206,-106.66064],[52.12412,-106.65717],[52.1279,-106.65362],[52.13097,-106.64813],[52.13454,-106.64542],[52.137,-106.64525],[52.13972,-106.64304],[52.14205,-106.64246],[52.14612,-106.63862],[52.14872,-106.63688],[52.15089,-106.63504],[52.15441,-106.63457],[52.15687,-106.63341],[52.15991,-106.62834],[52.16002,-106.6244],[52.15889,-106.61781],[52.16108,-106.61328],[52.16311,-106.60959],[52.16748,-106.60787],[52.1716,-106.60603],[52.17328,-106.60517],[52.17584,-106.60446],[52.17848,-106.60238],[52.18062,-106.6016],[52.18293,-106.60131],[52.18507,-106.60244],[52.18717,-106.60684],[52.18876,-106.61002],[52.19077,-106.61257],[52.19346,-106.61332],[52.19538,-106.61364],[52.19822,-106.61678],[52.20022,-106.61686],[52.20172,-106.61487],[52.20465,-106.60847],[52.20906,-106.60549],[52.21312,-106.60176],[52.21739,-106.5945],[52.2186,-106.59135],[52.21861,-106.5908],[52.21864,-106.58783],[52.21477,-106.57845],[52.21462,-106.57045],[52.21526,-106.56575],[52.21735,-106.56137],[52.21972,-106.55869],[52.22306,-106.55828]]


def xy(lat, lon):
    return ((lon - LON0) * KX, -(lat - LAT0) * KY)


def dp(pts, eps):
    """Douglas-Peucker on [lat,lon] list, tolerance in metres."""
    if len(pts) < 3:
        return pts
    P = [xy(*p) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = P[a]; bx, by = P[b]
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy) or 1.0
        md, mi = 0.0, -1
        for i in range(a + 1, b):
            d = abs(dx * (ay - P[i][1]) - dy * (ax - P[i][0])) / L
            if d > md:
                md, mi = d, i
        if md > eps:
            keep[mi] = True
            stack += [(a, mi), (mi, b)]
    return [p for p, k in zip(pts, keep) if k]


def seg_intersect(p1, p2, p3, p4):
    (x1, y1), (x2, y2), (x3, y3), (x4, y4) = p1, p2, p3, p4
    d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
    if abs(d) < 1e-9:
        return None
    t = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d
    u = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
    if 0 <= t <= 1 and 0 <= u <= 1:
        return (x1 + t * (x2 - x1), y1 + t * (y2 - y1), math.atan2(y2 - y1, x2 - x1))
    return None


def route_palette(n):
    """Distinct, mid-saturation colours by golden-angle hue stepping. Official GTFS colours are
    41/55 navy, so they can't tell routes apart on a map; the official colour is kept too."""
    out = []
    for i in range(n):
        h = (i * 0.618033988749895 + 0.58) % 1.0
        r, g, b = colorsys.hls_to_rgb(h, 0.50, 0.58)
        out.append("%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255)))
    return out


def main():
    z = zipfile.ZipFile(ZIP)
    rd = lambda n: csv.DictReader(io.TextIOWrapper(z.open(n), encoding="utf-8-sig"))

    routes = list(rd("routes.txt"))
    def sort_key(r):
        s = r["route_short_name"].strip()
        return (0, int(s)) if s.isdigit() else (1, s)
    routes.sort(key=sort_key)
    pal = route_palette(len(routes))

    trips = {}
    route_shapes = collections.defaultdict(collections.Counter)
    for t in rd("trips.txt"):
        trips[t["trip_id"]] = [t["route_id"], t["shape_id"], t["trip_headsign"].strip(), t["direction_id"]]
        route_shapes[t["route_id"]][t["shape_id"]] += 1

    shapes_raw = collections.defaultdict(list)
    for s in rd("shapes.txt"):
        shapes_raw[s["shape_id"]].append((int(s["shape_pt_sequence"]), float(s["shape_pt_lat"]), float(s["shape_pt_lon"])))
    shapes = {}
    for sid, pts in shapes_raw.items():
        pts.sort()
        shapes[sid] = [[round(a, 5), round(b, 5)] for a, b in dp([[p[1], p[2]] for p in pts], 4.0)]

    stops = {s["stop_id"]: s for s in rd("stops.txt")}
    stop_routes = collections.defaultdict(set)
    trip_route = {k: v[0] for k, v in trips.items()}
    for st in rd("stop_times.txt"):
        r = trip_route.get(st["trip_id"])
        if r:
            stop_routes[st["stop_id"].strip()].add(r)

    # Bridges: where route shapes cross the river centreline, clustered within 150 m.
    river_xy = [xy(*p) for p in RIVER]
    hits = []
    for sid, pts in shapes.items():
        P = [xy(*p) for p in pts]
        for i in range(len(P) - 1):
            for j in range(len(river_xy) - 1):
                h = seg_intersect(P[i], P[i + 1], river_xy[j], river_xy[j + 1])
                if h:
                    hits.append(h)
    bridges = []
    for x, y, ang in hits:
        for b in bridges:
            if math.hypot(b["x"] - x, b["y"] - y) < 150:
                b["n"] += 1
                break
        else:
            bridges.append({"x": x, "y": y, "a": ang, "n": 1})
    bridges = [{"x": round(b["x"], 1), "y": round(b["y"], 1), "a": round(b["a"], 3), "n": b["n"]} for b in bridges]

    route_out = []
    for r, c in zip(routes, pal):
        s = r["route_short_name"].strip()
        route_out.append({
            "id": r["route_id"],
            "short": str(int(s)) if s.isdigit() else s,
            "long": r["route_long_name"].strip(),
            "color": "#" + c,
            "official": "#" + (r["route_color"] or "000080"),
            "shapes": [sid for sid, _ in route_shapes[r["route_id"]].most_common()],
        })

    stop_out = []
    for sid, s in stops.items():
        stop_out.append({
            "id": sid,
            "name": " ".join(s["stop_name"].split()),
            "lat": round(float(s["stop_lat"]), 6),
            "lon": round(float(s["stop_lon"]), 6),
            "hub": s.get("location_type", "").strip() == "1",
            "routes": sorted(stop_routes.get(sid, ())),
        })

    static = {
        "generated_from": os.path.basename(ZIP),
        "origin": [LAT0, LON0],
        "k": [KX, KY],
        "routes": route_out,
        "shapes": {sid: shapes[sid] for r in route_out for sid in r["shapes"] if sid in shapes},
        "stops": stop_out,
        "river": RIVER,
        "bridges": bridges,
        "service_end": max(c["end_date"] for c in rd("calendar.txt")),
    }
    index = {
        "trips": trips,
        "routes": {r["id"]: [r["short"], r["long"], r["color"]] for r in route_out},
        "stops": {s["id"]: s["name"] for s in stop_out},
        "service_end": static["service_end"],
    }
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "static.json"), "w") as f:
        json.dump(static, f, separators=(",", ":"))
    with open(os.path.join(ROOT, "data", "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    npts = sum(len(v) for v in static["shapes"].values())
    print(f"routes {len(route_out)}  shapes {len(static['shapes'])} ({npts} pts)  stops {len(stop_out)}  "
          f"trips {len(trips)}  bridges {len(bridges)}  service ends {static['service_end']}")


if __name__ == "__main__":
    main()
