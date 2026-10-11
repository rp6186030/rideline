# Rideline

A live 3D map of Saskatoon Transit buses, built from Saskatoon Transit's free GTFS Realtime feeds.

## Run it locally

### 1. Install Node.js

You need [Node.js](https://nodejs.org) 18 or newer. To check which version you have, run:

```bash
node --version
```

There are no other dependencies, so you don't need `npm install`.

### 2. Get the code

Clone the repo with git:

```bash
git clone https://github.com/rp6186030/rideline.git
cd rideline
```

Or, without git, click **Code → Download ZIP** on GitHub, unzip it, and open a terminal in the unzipped folder.

### 3. Start the server

```bash
node server.js
```

Then open http://localhost:8787 in your browser. Press `Ctrl+C` in the terminal to stop the server.

The schedule, the map layer and a saved snapshot are all included in `data/`, so it works straight away. You need an internet connection for the live bus feed. If you're offline, or few buses are running (late at night, for example), use `--replay` or the **Demo** button instead.

### Options

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

## License

The code is under the [MIT License](LICENSE). That covers the code only, not the data or bundled libraries:

| Part | License |
|---|---|
| `public/vendor/` (Three.js r160 and its addons) | MIT, © Three.js Authors |
| `data/osm.json` | © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/) |
| `data/google_transit.zip`, `data/snapshot/` and the files built from them | City of Saskatoon / Saskatoon Transit, under the City of Saskatoon Open Data Terms of Use |
