# Rideline

A live 3D map of Saskatoon Transit buses, built from Saskatoon Transit's free GTFS Realtime feeds.

## Run it

You need Node.js 18 or newer. There is nothing to install.

```bash
cd ~/Projects/rideline
node server.js
```

Then open http://localhost:8787 in your browser.

The first time you run it, the server takes about 30 seconds to download Saskatoon's main roads, parks and lakes from OpenStreetMap. It saves them to `data/osm.json`. Reload the page once that finishes.

| Command | What it does |
|---|---|
| `node server.js` | Live feed (the default) |
| `node server.js --replay` | Replays the saved snapshot from Oct 10 2026 at 18:00, with no internet needed |
| `node server.js --refresh-osm` | Downloads the OpenStreetMap layer again |
| `PORT=9000 node server.js` | Uses a different port |
| `http://localhost:8787/?lite` | Turns off shadows, for slower machines |

The **Demo** button in the app moves the saved snapshot's buses along their real routes. It's useful for testing when the feed is down or at night when few buses run, and it's labelled as simulated on screen.

## Where the data comes from

- **Live feeds** (no key needed), fetched every 15 seconds:
  `https://saskprdtmgtfs.sasktrpcloud.com/TMGTFSRealTimeWebService/` + `Vehicle/VehiclePositions.pb`, `TripUpdate/TripUpdates.pb`, `Alert/Alerts.pb`
- **Static schedule:** `data/google_transit.zip`, from the City of Saskatoon open data portal.
- **Map:** OpenStreetMap contributors (ODbL).

## Update the schedule (the current one ends 2027-01-02)

1. Download a fresh `google_transit.zip` from the Saskatoon open data portal into `data/`.
2. Run `python3 tools/build_static.py`.

The server prints a warning once the schedule has expired.

## How the numbers are worked out

| Number | How it's calculated |
|---|---|
| Buses in service | Vehicles in the Vehicle Positions feed |
| Delay | `time - scheduled_time` at the bus's next stop (the feed has no `delay` field) |
| Speed | The feed's m/s value × 3.6. Shown as n/a when the feed doesn't send it (about 1 in 3 buses) |
| Next stops and ETAs | The Trip Updates feed, joined to the vehicle on `trip_id` (or `affected_trip_id` for modified trips) |

- **Bus heading** comes from the feed's bearing. When that's missing, the app uses the direction of travel along the route shape.
- **Bus positions are drawn about 18 seconds behind the newest GPS fix.** That delay lets buses glide between updates along the real route shape instead of jumping.
- **Fields the feed doesn't provide are shown as n/a, never invented.** Occupancy is one of these: the feed always sends `NO_DATA_AVAILABLE`.

## Files

| File | What's in it |
|---|---|
| `server.js` | Feed polling, merging and the HTTP server, with no dependencies |
| `lib/gtfsrt.js` | Small protobuf decoder for GTFS Realtime, including `modified_trip` |
| `lib/osm.js` | OpenStreetMap download and cache |
| `tools/build_static.py` | Turns GTFS into `data/static.json` and `data/index.json` |
| `public/` | The 3D page (Three.js r160 is bundled in `public/vendor`) |
