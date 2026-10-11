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

module.exports = { loadOsm, dp };
