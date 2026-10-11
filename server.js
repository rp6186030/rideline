#!/usr/bin/env node
// Rideline server: fetches Saskatoon Transit GTFS Realtime feeds, merges them with the
// static GTFS, and serves one JSON API plus the 3D page. Zero npm dependencies. Node 18+.
//
//   node server.js              live feeds (default)
//   node server.js --replay     use the saved snapshots in data/snapshot (no internet needed)
//   node server.js --refresh-osm   re-download OpenStreetMap roads/parks
//   PORT=9000 node server.js    change port (default 8787)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { decodeFeed } = require('./lib/gtfsrt');
const { loadOsm, loadCity } = require('./lib/osm');

const ROOT = __dirname;
const PORT = +process.env.PORT || 8787;
const ARGS = new Set(process.argv.slice(2));
const REPLAY = ARGS.has('--replay');
const FEED_BASE = 'https://saskprdtmgtfs.sasktrpcloud.com/TMGTFSRealTimeWebService/';
const FEEDS = {
  vehicles: FEED_BASE + 'Vehicle/VehiclePositions.pb',
  trips: FEED_BASE + 'TripUpdate/TripUpdates.pb',
  alerts: FEED_BASE + 'Alert/Alerts.pb',
};
const POLL_MS = 15000;        // feed fetch interval
const ALERT_POLL_MS = 60000;
const LATE_SEC = 300;         // "late" threshold for warnings

const log = (...a) => console.log(new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Regina', hour12: false }), ...a);

// ---------- static data ----------
const INDEX = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/index.json'), 'utf8'));
const STATIC = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/static.json'), 'utf8'));
const [LAT0, LON0] = STATIC.origin, [KX, KY] = STATIC.k;
const toXY = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KY];
const SHAPES_XY = {};
for (const [sid, pts] of Object.entries(STATIC.shapes)) {
  const P = pts.map(p => toXY(p[0], p[1]));
  const cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  SHAPES_XY[sid] = { P, cum, len: cum[cum.length - 1] };
}
const serviceEnd = INDEX.service_end;
if (serviceEnd) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Regina' }).replace(/-/g, '');
  if (today > serviceEnd) log(`WARNING: static GTFS ended ${serviceEnd}. Download a fresh google_transit.zip into data/ and run: python3 tools/build_static.py`);
}

// ---------- feed fetching ----------
const state = {
  vehicles: null, trips: null, alerts: null,     // decoded feeds
  vehiclesAt: 0, tripsAt: 0, alertsAt: 0,          // when last fetched OK (ms)
  lastError: null, lastAttempt: 0,
  merged: null, stopBoard: null,
};

async function getFeed(name) {
  if (REPLAY) {
    const file = path.join(ROOT, 'data/snapshot', name === 'vehicles' ? 'VehiclePositions.pb' : name === 'trips' ? 'TripUpdates.pb' : 'Alerts.pb');
    if (!fs.existsSync(file)) return { header: {}, entities: [] };
    return decodeFeed(fs.readFileSync(file));
  }
  const res = await fetch(FEEDS[name], { headers: { 'User-Agent': 'Rideline/1.0' }, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`${name} feed HTTP ${res.status}`);
  return decodeFeed(Buffer.from(await res.arrayBuffer()));
}

async function poll() {
  state.lastAttempt = Date.now();
  const [v, t] = await Promise.allSettled([getFeed('vehicles'), getFeed('trips')]);
  const errs = [];
  if (v.status === 'fulfilled') { state.vehicles = v.value; state.vehiclesAt = Date.now(); } else errs.push(v.reason.message);
  if (t.status === 'fulfilled') { state.trips = t.value; state.tripsAt = Date.now(); } else errs.push(t.reason.message);
  if (Date.now() - state.alertsAt > ALERT_POLL_MS) {
    try { state.alerts = await getFeed('alerts'); state.alertsAt = Date.now(); }
    catch (e) { if (!state.alerts) state.alerts = { header: {}, entities: [] }; }
  }
  state.lastError = errs.length ? errs.join('; ') : null;
  if (errs.length) log('feed error:', state.lastError);
  if (state.vehicles) {
    state.merged = merge(state.vehicles, state.trips);
    state.stopBoard = buildStopBoard(state.trips);
  }
}

// ---------- merge ----------
const tripKey = td => (td && (td.tripId || (td.modified && td.modified.affectedTripId))) || '';
const evTime = s => (s.arrival && s.arrival.time) || (s.departure && s.departure.time) || 0;
function evDelay(s) {
  const e = s.arrival && s.arrival.time ? s.arrival : s.departure;
  if (!e) return null;
  if (e.delay !== undefined) return e.delay;
  if (e.time && e.scheduledTime) return e.time - e.scheduledTime;
  return null;
}

function routeInfo(routeId) {
  const r = INDEX.routes[routeId];
  return r ? { routeId, routeShort: r[0], routeName: r[1], color: r[2] } : { routeId: routeId || '', routeShort: '?', routeName: 'Unknown route', color: '#888888' };
}

function merge(vFeed, tFeed) {
  const now = vFeed.header.timestamp || Math.floor(Date.now() / 1000);
  const tuByTrip = new Map();
  if (tFeed) for (const e of tFeed.entities) if (e.tripUpdate) tuByTrip.set(tripKey(e.tripUpdate.trip), e.tripUpdate);

  const buses = [];
  for (const e of vFeed.entities) {
    const v = e.vehicle;
    if (!v || !v.position || !v.position.lat) continue;
    const tid = tripKey(v.trip);
    const trip = INDEX.trips[tid];
    const routeId = (v.trip && v.trip.routeId) || (trip && trip[0]) || '';
    const tu = tuByTrip.get(tid);
    let delay = null, next = [];
    if (tu) {
      const upcoming = tu.stops.filter(s => evTime(s) >= now - 30);
      const ref = upcoming[0] || tu.stops[tu.stops.length - 1];
      if (ref) delay = evDelay(ref);
      if (tu.delay !== undefined && delay === null) delay = tu.delay;
      next = upcoming.slice(0, 6).map(s => ({ stopId: s.stopId, name: INDEX.stops[s.stopId] || s.stopId, eta: evTime(s), delay: evDelay(s) }));
    }
    const p = v.position;
    buses.push({
      id: (v.vehicle && v.vehicle.id) || e.id,
      label: (v.vehicle && v.vehicle.label) || e.id,
      tripId: tid,
      ...routeInfo(routeId),
      headsign: trip ? trip[2] : '',
      shapeId: trip ? trip[1] : null,
      lat: p.lat, lon: p.lon,
      bearing: p.bearing !== undefined ? p.bearing : null,
      speedKmh: p.speed !== undefined ? Math.round(p.speed * 3.6) : null,
      ts: v.timestamp || now,
      delay,
      next,
    });
  }
  const delays = buses.map(b => b.delay).filter(d => d !== null);
  const routes = new Set(buses.map(b => b.routeId).filter(Boolean));
  return {
    feedTime: now,
    tripsFeedTime: tFeed ? tFeed.header.timestamp : null,
    stats: {
      inService: buses.length,
      avgDelayMin: delays.length ? +(delays.reduce((a, b) => a + b, 0) / delays.length / 60).toFixed(1) : null,
      withDelayData: delays.length,
      late: delays.filter(d => d > LATE_SEC).length,
      routesActive: routes.size,
    },
    buses,
  };
}

function buildStopBoard(tFeed) {
  if (!tFeed) return { feedTime: null, stops: {} };
  const now = tFeed.header.timestamp || Math.floor(Date.now() / 1000);
  const board = {}, seen = new Set();
  for (const e of tFeed.entities) {
    const tu = e.tripUpdate; if (!tu) continue;
    const tid = tripKey(tu.trip);
    const trip = INDEX.trips[tid];
    const r = routeInfo((tu.trip && tu.trip.routeId) || (trip && trip[0]));
    for (const s of tu.stops) {
      const t = evTime(s);
      if (!s.stopId || t < now - 30) continue;
      const key = tid + '|' + s.stopId + '|' + t;
      if (seen.has(key)) continue;
      seen.add(key);
      (board[s.stopId] = board[s.stopId] || []).push({ routeId: r.routeId, routeShort: r.routeShort, headsign: trip ? trip[2] : '', eta: t, delay: evDelay(s), vehicle: tu.vehicle ? tu.vehicle.label || tu.vehicle.id : null });
    }
  }
  for (const k in board) board[k] = board[k].sort((a, b) => a.eta - b.eta).slice(0, 4);
  return { feedTime: now, stops: board };
}

function alertsOut() {
  if (!state.alerts) return [];
  const EFFECT = ['', 'No service', 'Reduced service', 'Significant delays', 'Detour', 'Additional service', 'Modified service', 'Other effect', 'Unknown effect', 'Stop moved', 'No effect', 'Accessibility issue'];
  return state.alerts.entities.filter(e => e.alert).map(e => {
    const a = e.alert;
    const routes = [...new Set(a.entities.map(x => x.routeId).filter(Boolean))].map(id => routeInfo(id).routeShort);
    return { id: e.id, header: a.header || '', description: a.description || '', effect: EFFECT[a.effect] || '', routes, stops: a.entities.map(x => x.stopId).filter(Boolean).length, start: (a.periods[0] || {}).start || null, end: (a.periods[0] || {}).end || null };
  });
}

// ---------- demo mode: snapshot buses moved along their real route shapes ----------
let demoBase = null;
function project(shape, x, y) {
  let best = { d: Infinity, s: 0 };
  const { P, cum } = shape;
  for (let i = 0; i < P.length - 1; i++) {
    const [ax, ay] = P[i], [bx, by] = P[i + 1];
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L2));
    const d = Math.hypot(x - ax - t * dx, y - ay - t * dy);
    if (d < best.d) best = { d, s: cum[i] + t * Math.sqrt(L2) };
  }
  return best.s;
}
function pointAt(shape, s) {
  const { P, cum } = shape;
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1, t = (s - cum[i - 1]) / seg;
  const x = P[i - 1][0] + t * (P[i][0] - P[i - 1][0]), y = P[i - 1][1] + t * (P[i][1] - P[i - 1][1]);
  return { lon: LON0 + x / KX, lat: LAT0 - y / KY, bearing: (Math.atan2(P[i][0] - P[i - 1][0], -(P[i][1] - P[i - 1][1])) * 180 / Math.PI + 360) % 360 };
}
function demoSnapshot() {
  if (!demoBase) {
    const v = decodeFeed(fs.readFileSync(path.join(ROOT, 'data/snapshot/VehiclePositions.pb')));
    const t = decodeFeed(fs.readFileSync(path.join(ROOT, 'data/snapshot/TripUpdates.pb')));
    const m = merge(v, t);
    m.buses.forEach(b => { const sh = SHAPES_XY[b.shapeId]; b._s0 = sh ? project(sh, ...toXY(b.lat, b.lon)) : 0; b._v = Math.max(6, (b.speedKmh || 22)) / 3.6; });
    demoBase = { m, t0: Date.now() / 1000, feedTime: m.feedTime };
  }
  const now = Math.floor(Date.now() / 1000), el = now - demoBase.t0, shift = now - demoBase.feedTime;
  const buses = demoBase.m.buses.map(b => {
    const sh = SHAPES_XY[b.shapeId];
    const out = { ...b, ts: now, next: b.next.map(n => ({ ...n, eta: n.eta + shift })) };
    delete out._s0; delete out._v;
    if (sh && sh.len > 0) { const p = pointAt(sh, (b._s0 + b._v * el) % sh.len); out.lat = p.lat; out.lon = p.lon; out.bearing = p.bearing; }
    return out;
  });
  return { ...demoBase.m, buses, feedTime: now };
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(req, res, status, body, type) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    body = zlib.gzipSync(body);
  }
  res.writeHead(status, headers); res.end(body);
}
const json = (req, res, obj, status = 200) => send(req, res, status, Buffer.from(JSON.stringify(obj)), TYPES['.json']);

function liveStatus() {
  const now = Date.now();
  if (REPLAY) return 'replay';
  if (!state.vehiclesAt) return state.lastAttempt ? 'offline' : 'starting';
  if (now - state.vehiclesAt > 3 * POLL_MS + 5000) return 'offline';
  if (state.merged && now / 1000 - state.merged.feedTime > 120) return 'stale';
  return 'ok';
}

let OSM = null;
let CITY = null;   // { raw, gz } of data/city.json, compressed once because it's a few MB

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/live') {
      if (url.searchParams.get('demo') === '1') return json(req, res, { mode: 'demo', status: 'demo', serverTime: Date.now() / 1000, ...demoSnapshot(), alerts: [] });
      return json(req, res, { mode: REPLAY ? 'replay' : 'live', status: liveStatus(), error: state.lastError, serverTime: Date.now() / 1000, lastFetch: state.vehiclesAt / 1000 || null, ...(state.merged || { buses: [], stats: null, feedTime: null }), alerts: alertsOut() });
    }
    if (url.pathname === '/api/stops') return json(req, res, state.stopBoard || { feedTime: null, stops: {} });
    if (url.pathname === '/api/health') return json(req, res, { ok: true, status: liveStatus(), error: state.lastError, buses: state.merged ? state.merged.buses.length : 0 });
    if (url.pathname === '/data/static.json') return send(req, res, 200, fs.readFileSync(path.join(ROOT, 'data/static.json')), TYPES['.json']);
    if (url.pathname === '/data/osm.json') return OSM ? json(req, res, OSM) : json(req, res, { roads: [], parks: [], water: [], missing: true });
    if (url.pathname === '/data/city.json') {
      if (!CITY) return json(req, res, { streets: [], buildings: [], missing: true });
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gz ? CITY.gz : CITY.raw);
    }
    let p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(ROOT, 'public', p));
    if (!file.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(req, res, 404, Buffer.from('Not found'), 'text/plain');
    send(req, res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream');
  } catch (e) {
    log('request error', req.url, e.message);
    json(req, res, { error: e.message }, 500);
  }
});

server.listen(PORT, () => {
  log(`Rideline running at http://localhost:${PORT}  (${REPLAY ? 'REPLAY of saved snapshot' : 'live Saskatoon Transit feed'})`);
  poll().catch(e => log('poll failed', e.message));
  setInterval(() => poll().catch(e => log('poll failed', e.message)), POLL_MS);
  loadOsm(path.join(ROOT, 'data/osm.json'), { refresh: ARGS.has('--refresh-osm'), log })
    .then(o => { OSM = o; })
    .catch(e => log('OpenStreetMap download failed, the map will show transit data only:', e.message))
    .then(() => loadCity(path.join(ROOT, 'data/city.json'), { refresh: ARGS.has('--refresh-osm'), log }))
    .then(c => { if (c) { const raw = Buffer.from(JSON.stringify(c)); CITY = { raw, gz: zlib.gzipSync(raw) }; } })
    .catch(e => log('OpenStreetMap streets/buildings download failed, using the simplified city:', e.message));
});
