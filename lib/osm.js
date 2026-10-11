// Downloads main roads, parks and lakes for Saskatoon from OpenStreetMap (Overpass API)
// once, simplifies them, and caches to data/osm.json. Data (c) OpenStreetMap contributors, ODbL.
'use strict';
const fs = require('fs');

const BBOX = '52.04,-106.80,52.23,-106.52';
const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const QUERIES = {
  roads: `way[highway~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link)$"](${BBOX});`,
  parks: `way[leisure~"^(park|golf_course|nature_reserve)$"](${BBOX});`,
  water: `way[natural=water](${BBOX});`,
};
const CLASS = { motorway: 'm', trunk: 't', primary: 'p', secondary: 's', tertiary: 'r', motorway_link: 'l', trunk_link: 'l', primary_link: 'l' };

const sleep = ms => new Promise(r => setTimeout(r, ms));

function dp(pts, eps) {
  if (pts.length < 3) return pts;
  const k = Math.cos(52.13 * Math.PI / 180);
  const P = pts.map(p => [p.lon * k * 111320, p.lat * 110540]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop();
    const [ax, ay] = P[a], [bx, by] = P[b];
    const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dx * (ay - P[i][1]) - dy * (ax - P[i][0])) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const r5 = c => [+c.lat.toFixed(5), +c.lon.toFixed(5)];

async function overpass(q, log) {
  const body = 'data=' + encodeURIComponent('[out:json][timeout:120];' + q + 'out geom;');
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Rideline/1.0 (personal transit viz)' }, signal: AbortSignal.timeout(150000) });
      const text = await res.text();
      if (res.ok && text[0] === '{') return JSON.parse(text).elements || [];
      lastErr = new Error(`${url} -> HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
    log(`  OpenStreetMap request failed (${lastErr.message}), retrying in ${10 * (attempt + 1)}s`);
    await sleep(10000 * (attempt + 1));
  }
  throw lastErr;
}

async function loadOsm(file, { refresh = false, log = console.log } = {}) {
  if (!refresh && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* re-download */ }
  }
  log('Downloading Saskatoon roads, parks and lakes from OpenStreetMap (first run only, ~30s)...');
  const roads = await overpass(QUERIES.roads, log);
  await sleep(2000);
  const parks = await overpass(QUERIES.parks, log);
  await sleep(2000);
  const water = await overpass(QUERIES.water, log);
  const closed = g => g.length > 3;
  const out = {
    attribution: '(c) OpenStreetMap contributors, ODbL',
    fetched: new Date().toISOString(),
    roads: roads.filter(w => w.geometry && CLASS[w.tags.highway]).map(w => ({ c: CLASS[w.tags.highway], b: w.tags.bridge ? 1 : 0, n: w.tags.name || '', p: dp(w.geometry, 8).map(r5) })),
    parks: parks.filter(w => w.geometry && closed(w.geometry)).map(w => ({ n: w.tags.name || '', g: w.tags.leisure === 'golf_course' ? 1 : 0, p: dp(w.geometry, 10).map(r5) })),
    water: water.filter(w => w.geometry && closed(w.geometry) && w.tags.water !== 'river').map(w => ({ p: dp(w.geometry, 10).map(r5) })),
  };
  fs.writeFileSync(file, JSON.stringify(out));
  log(`  cached ${out.roads.length} roads, ${out.parks.length} parks, ${out.water.length} lakes/ponds to ${file}`);
  return out;
}

// ---------- real city layer (trial): every residential street, plus real building footprints in a central area ----------
// Buildings are limited to CITY_BBOX for now (downtown, Riversdale, City Park, Nutana, the university) to keep the
// download and the 3D mesh small; widen it once the look and performance are right.
const CITY_BBOX = '52.108,-106.700,52.148,-106.615';
const CITY_QUERIES = {
  streets: `way[highway~"^(residential|unclassified|living_street)$"](${BBOX});`,
  buildings: `(way[building](${CITY_BBOX});relation[building][type=multipolygon](${CITY_BBOX}););`,   // union, or only the last set is output
};

// Height in metres from OSM tags, or 0 when the tags don't say (the browser then estimates it from the building type).
function tagHeight(t) {
  const num = v => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
  const h = num(t.height);
  if (h && h >= 2 && h < 300) return h;
  const lv = num(t['building:levels']);
  if (lv && lv > 0 && lv < 80) return lv * 3.2 + (num(t['roof:levels']) || 0) * 2.5 + 1;
  return 0;
}

// Join a relation's outer member ways into closed rings.
function outerRings(rel) {
  const parts = (rel.members || []).filter(m => m.type === 'way' && m.role === 'outer' && m.geometry?.length > 1).map(m => m.geometry.slice());
  const same = (a, b) => a.lat === b.lat && a.lon === b.lon, rings = [];
  while (parts.length) {
    let ring = parts.shift();
    for (let grew = true; grew && !same(ring[0], ring[ring.length - 1]);) {
      grew = false;
      for (let i = 0; i < parts.length; i++) {
        const q = parts[i], end = ring[ring.length - 1];
        if (same(end, q[0])) ring = ring.concat(q.slice(1));
        else if (same(end, q[q.length - 1])) ring = ring.concat(q.slice(0, -1).reverse());
        else continue;
        parts.splice(i, 1); grew = true; break;
      }
    }
    if (ring.length > 3 && same(ring[0], ring[ring.length - 1])) rings.push(ring);
  }
  return rings;
}

const ringArea = g => {   // m², shoelace on a local projection
  const k = Math.cos(52.13 * Math.PI / 180) * 111320; let a = 0;
  for (let i = 0, j = g.length - 1; i < g.length; j = i++) a += (g[j].lon * k) * (g[i].lat * 110540) - (g[i].lon * k) * (g[j].lat * 110540);
  return Math.abs(a / 2);
};

async function loadCity(file, { refresh = false, log = console.log } = {}) {
  if (!refresh && fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* re-download */ }
  }
  log('Downloading Saskatoon streets and building footprints from OpenStreetMap (first run only, ~1 min)...');
  const streets = await overpass(CITY_QUERIES.streets, log);
  await sleep(2000);
  const els = await overpass(CITY_QUERIES.buildings, log);
  const types = [], typeIdx = t => { const i = types.indexOf(t); return i >= 0 ? i : types.push(t) - 1; };
  const buildings = [];
  const add = (ring, tags) => {
    if (['construction', 'ruins', 'no'].includes(tags.building) || ringArea(ring) < 12) return;
    const g = dp(ring.slice(0, -1), 0.5);   // drop the closing point; 0.5 m simplification keeps house shapes
    if (g.length < 3) return;
    // [type, height in dm (0 = unknown), lat0, lon0, then deltas], coordinates in millionths of a degree (~0.1 m)
    const row = [typeIdx(tags.building), Math.round(tagHeight(tags) * 10)];
    let plat = 0, plon = 0;
    for (const c of g) { const la = Math.round(c.lat * 1e6), lo = Math.round(c.lon * 1e6); row.push(la - plat, lo - plon); plat = la; plon = lo; }
    buildings.push(row);
  };
  for (const e of els) {
    if (e.type === 'way' && e.geometry?.length > 3) add(e.geometry, e.tags || {});
    else if (e.type === 'relation') for (const ring of outerRings(e)) add(ring, e.tags || {});
  }
  const out = {
    attribution: '(c) OpenStreetMap contributors, ODbL',
    fetched: new Date().toISOString(),
    buildingBbox: CITY_BBOX.split(',').map(Number),
    streets: streets.filter(w => w.geometry).map(w => ({ n: w.tags.name || '', p: dp(w.geometry, 4).map(r5) })),
    types, buildings,
  };
  fs.writeFileSync(file, JSON.stringify(out));
  log(`  cached ${out.streets.length} streets and ${buildings.length} buildings to ${file}`);
  return out;
}

module.exports = { loadOsm, loadCity, dp };
