// Rideline: live 3D Saskatoon Transit dashboard.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { LineSegments2 } from './vendor/LineSegments2.js';
import { LineSegmentsGeometry } from './vendor/LineSegmentsGeometry.js';
import { LineMaterial } from './vendor/LineMaterial.js';

// ============================================================ constants & utils
const TZ = 'America/Regina';
const POLL_MS = 5000;           // client polls the local server
const RENDER_DELAY = 18;        // seconds; buses are drawn this far behind the newest fix so they glide between fixes
const LATE_SEC = 300;
const H0 = 9000;                // half-height of the view at zoom 1, metres
const ACCENT = '#F59E0B';
const LITE = new URLSearchParams(location.search).has('lite');   // ?lite = no shadows, for slower machines
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const fmtClock = (sec, withSec = false) => sec ? new Date(sec * 1000).toLocaleTimeString('en-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', ...(withSec ? { second: '2-digit' } : {}), hour12: false }) : 'n/a';
function fmtDelay(d, short = false) {
  if (d === null || d === undefined) return '<span class="na">n/a</span>';
  const a = Math.abs(d), m = Math.floor(a / 60), s = a % 60;
  const txt = m ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
  if (a < 60) return `<span class="ontime">${short ? 'on time' : 'On time'}</span>`;
  return d > 0 ? `<span class="${d > LATE_SEC ? 'late' : 'warn-txt'}">+${txt} late</span>` : `<span class="early">${txt} early</span>`;
}
const fmtIn = (eta, nowS) => { if (!eta) return 'n/a'; const m = Math.round((eta - nowS) / 60); return m <= 0 ? 'now' : `${m} min`; };
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, 2600); };

// ============================================================ renderer / scene
const container = $('#scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(LITE ? 1 : Math.min(devicePixelRatio, 1.5));
if (LITE || /firefox/i.test(navigator.userAgent)) document.body.classList.add('no-blur');   // Firefox re-blurs glass panels every frame
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = !LITE;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const DAY_BG = new THREE.Color('#F4EFE7'), NIGHT_BG = new THREE.Color('#0E1320'), SNOW_BG = new THREE.Color('#EEF1F4');
scene.background = DAY_BG.clone();

const camera = new THREE.OrthographicCamera(-H0, H0, H0, -H0, 1, 200000);
const CAM_DIST = 40000, POLAR = THREE.MathUtils.degToRad(52), AZ = THREE.MathUtils.degToRad(22);
camera.position.set(Math.sin(POLAR) * Math.sin(AZ) * CAM_DIST, Math.cos(POLAR) * CAM_DIST, Math.sin(POLAR) * Math.cos(AZ) * CAM_DIST);
camera.zoom = 1.15;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; controls.dampingFactor = 0.09;
controls.screenSpacePanning = false;
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
controls.minZoom = 0.6; controls.maxZoom = 90;
controls.minPolarAngle = 0.15; controls.maxPolarAngle = 1.25;
controls.zoomSpeed = 4;   // ~23% per mouse-wheel notch; also the exponent for two-finger touch pinch
controls.pinchZoomFactor = 3;   // a medium trackpad pinch is about 2x (see the patch in vendor/OrbitControls.js)
controls.zoomToCursor = true;

const hemi = new THREE.HemisphereLight('#FFF8EE', '#C9BBA0', 1.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#FFF1D6', 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

function resize() {
  const a = innerWidth / innerHeight;
  camera.left = -H0 * a; camera.right = H0 * a; camera.top = H0; camera.bottom = -H0;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  for (const m of lineMaterials) m.resolution.set(innerWidth, innerHeight);
}
addEventListener('resize', resize);

// ============================================================ data + projection
const STATIC = await fetch('data/static.json').then(r => r.json());
const [LAT0, LON0] = STATIC.origin, [KX, KY] = STATIC.k;
const proj = (lat, lon) => [(lon - LON0) * KX, -(lat - LAT0) * KY];   // [x, z] metres; north = -z
const ROUTES = new Map(STATIC.routes.map(r => [r.id, r]));
const STOPS = STATIC.stops.map(s => ({ ...s, xz: proj(s.lat, s.lon) }));
const STOP_BY_ID = new Map(STOPS.map(s => [s.id, s]));
const HUBS = STOPS.filter(s => s.hub);

// Preview mode: no Rideline server behind the page (e.g. the hosted link). Replays the saved
// 18:00 snapshot with buses moved along their real route shapes. Clearly labelled, never live.
const PREVIEW = new URLSearchParams(location.search).has('preview') ||
  !(await fetch('api/health', { cache: 'no-store' }).then(r => r.ok && (r.headers.get('content-type') || '').includes('json')).catch(() => false));
const PV = PREVIEW ? await fetch('data/preview.json').then(r => r.json()) : null;
const PV_T0 = Date.now() / 1000;
const hub = name => HUBS.find(h => h.name.toLowerCase().includes(name)) || HUBS[0];

// river centreline + distance function, used for bridges and to keep buildings out of the water
const RIVER = STATIC.river.map(p => proj(p[0], p[1]));
function riverDist(x, z) {
  let best = Infinity;
  for (let i = 0; i < RIVER.length - 1; i++) {
    const [ax, az] = RIVER[i], [bx, bz] = RIVER[i + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
    const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
    if (d < best) best = d;
  }
  return best;
}
const RIVER_HALF = 150, DECK = 9;
const deckY = (x, z) => { const d = riverDist(x, z); return d < 170 ? DECK : d < 300 ? DECK * (1 - smooth(170, 300, d)) : 0; };

// shapes in scene space, with cumulative distance for along-route interpolation
const SHAPES = {};
for (const [sid, pts] of Object.entries(STATIC.shapes)) {
  const P = pts.map(p => proj(p[0], p[1])), cum = [0];
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
  SHAPES[sid] = { P, cum, len: cum[cum.length - 1] };
}
function shapeProject(sh, x, z) {
  let best = { d: Infinity, s: 0 };
  for (let i = 0; i < sh.P.length - 1; i++) {
    const [ax, az] = sh.P[i], [bx, bz] = sh.P[i + 1];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1;
    const t = clamp(((x - ax) * dx + (z - az) * dz) / L2, 0, 1);
    const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
    if (d < best.d) best = { d, s: sh.cum[i] + t * Math.sqrt(L2) };
  }
  return best;
}
function shapePoint(sh, s) {
  const { P, cum } = sh;
  let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
  const seg = cum[i] - cum[i - 1] || 1, t = clamp((s - cum[i - 1]) / seg, 0, 1);
  return { x: lerp(P[i - 1][0], P[i][0], t), z: lerp(P[i - 1][1], P[i][1], t), dx: P[i][0] - P[i - 1][0], dz: P[i][1] - P[i - 1][1] };
}

// ============================================================ materials / seasons
const SEASONS = {
  summer: { ground: '#F3EEE4', park: '#B9D39A', tree: '#7FAE5B', tree2: '#5E9445', road: '#D6CCBC', bank: '#CFDDB0', snow: 0 },
  autumn: { ground: '#F0E7D6', park: '#D2C890', tree: '#E0913A', tree2: '#C4632B', road: '#D6CCBC', bank: '#D9CFA0', snow: 0 },
  winter: { ground: '#F5F6F7', park: '#EEF2F4', tree: '#6C8B74', tree2: '#E9EEF0', road: '#C9CDD2', bank: '#ECF0F2', snow: 0.35 },
  blizzard: { ground: '#F7F8F9', park: '#F1F4F6', tree: '#7D9585', tree2: '#F1F4F6', road: '#D7DBDF', bank: '#F1F4F6', snow: 1 },
};
let season = 'summer';
const M = {
  ground: new THREE.MeshLambertMaterial({ color: SEASONS.summer.ground }),
  bank: new THREE.MeshStandardMaterial({ color: SEASONS.summer.bank, roughness: 1 }),
  park: new THREE.MeshStandardMaterial({ color: SEASONS.summer.park, roughness: 1 }),
  lake: new THREE.MeshStandardMaterial({ color: '#8EC5D6', roughness: .4 }),
  tree: new THREE.MeshStandardMaterial({ color: SEASONS.summer.tree, flatShading: true, roughness: .9 }),
  trunk: new THREE.MeshStandardMaterial({ color: '#8A6A4A', roughness: 1 }),
  pier: new THREE.MeshStandardMaterial({ color: '#CFC6B8', roughness: .9 }),
  roof: new THREE.MeshStandardMaterial({ color: '#FFFFFF', roughness: .95 }),
  cloud: new THREE.MeshStandardMaterial({ color: '#FFFFFF', flatShading: true, transparent: true, opacity: .92, roughness: 1 }),
};

// window texture for building sides (emissive at night)
function windowTextures() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 128;
  const e = document.createElement('canvas'); e.width = 64; e.height = 128;
  const g = c.getContext('2d'), h = e.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 64, 128);
  h.fillStyle = '#000'; h.fillRect(0, 0, 64, 128);
  const r = rng(7);
  for (let y = 6; y < 124; y += 12) for (let x = 6; x < 60; x += 13) {
    g.fillStyle = 'rgba(70,80,95,.28)'; g.fillRect(x, y, 8, 6);
    if (r() < .55) { h.fillStyle = `rgba(255,${190 + (r() * 40 | 0)},110,${.7 + r() * .3})`; h.fillRect(x, y, 8, 6); }
  }
  const t1 = new THREE.CanvasTexture(c), t2 = new THREE.CanvasTexture(e);
  t1.colorSpace = THREE.SRGBColorSpace; t2.colorSpace = THREE.SRGBColorSpace;
  return [t1, t2];
}
const [wallTex, winTex] = windowTextures();
M.wall = new THREE.MeshStandardMaterial({ map: wallTex, emissiveMap: winTex, emissive: '#FFD58A', emissiveIntensity: 0, roughness: .9 });

// ============================================================ world
const world = new THREE.Group(); scene.add(world);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000), M.ground);
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; world.add(ground);

// ribbon geometry along a polyline in the xz plane
function ribbon(P, width, y, uScale = 1) {
  const pos = [], uv = [], idx = [];
  let u = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[Math.max(0, i - 1)], b = P[Math.min(P.length - 1, i + 1)];
    let dx = b[0] - a[0], dz = b[1] - a[1]; const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
    if (i) u += Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]) / uScale;
    const nx = -dz * width / 2, nz = dx * width / 2;
    pos.push(P[i][0] + nx, y, P[i][1] + nz, P[i][0] - nx, y, P[i][1] - nz);
    uv.push(u, 0, u, 1);
    if (i) { const k = i * 2; idx.push(k - 2, k, k - 1, k - 1, k, k + 1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}
function densify(P, step) {
  const out = [P[0]];
  for (let i = 1; i < P.length; i++) {
    const [ax, az] = P[i - 1], [bx, bz] = P[i], L = Math.hypot(bx - ax, bz - az), n = Math.ceil(L / step);
    for (let k = 1; k <= n; k++) out.push([lerp(ax, bx, k / n), lerp(az, bz, k / n)]);
  }
  return out;
}

// river: valley bank, water with flowing stripes
const riverDense = densify(RIVER, 60);
const bank = new THREE.Mesh(ribbon(riverDense, 620, 0.2), M.bank); bank.receiveShadow = true; world.add(bank);
const waterUniforms = { uTime: { value: 0 }, uNight: { value: 0 }, uIce: { value: 0 } };
const waterMat = new THREE.ShaderMaterial({
  uniforms: waterUniforms,
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
  fragmentShader: `varying vec2 vUv; uniform float uTime, uNight, uIce;
    void main(){
      float edge = smoothstep(0.0, 0.18, vUv.y) * smoothstep(1.0, 0.82, vUv.y);
      float w = sin(vUv.x * 0.9 - uTime * 1.4 + sin(vUv.y * 9.0) * 0.8) * 0.5 + 0.5;
      float w2 = sin(vUv.x * 2.3 - uTime * 2.1 + vUv.y * 4.0) * 0.5 + 0.5;
      vec3 deep = vec3(0.32, 0.62, 0.74), light = vec3(0.62, 0.84, 0.90), shore = vec3(0.78, 0.90, 0.88);
      vec3 c = mix(shore, mix(deep, light, w * 0.35 + w2 * 0.15), edge);
      c = mix(c, vec3(0.86, 0.92, 0.95) + w2 * 0.04, uIce);
      c *= mix(1.0, 0.32, uNight);
      gl_FragColor = vec4(c, 1.0);
      #include <colorspace_fragment>
    }`,
});
const water = new THREE.Mesh(ribbon(riverDense, RIVER_HALF * 2, 0.5, 40), waterMat); water.receiveShadow = false; world.add(water);

// line materials (screen-space width that grows when zoomed in)
const lineMaterials = [];
function lineMat(color, opacity = 1) {
  const m = new LineMaterial({ color, linewidth: 2, worldUnits: false, transparent: opacity < 1, opacity, depthWrite: false });
  m.resolution.set(innerWidth, innerHeight);
  lineMaterials.push(m);
  return m;
}
function segmentsFor(polys, yOff) {
  const arr = [];
  for (const P0 of polys) {
    const P = densify(P0, 70);
    let prevY = deckY(P[0][0], P[0][1]) + yOff;
    for (let i = 1; i < P.length; i++) {
      const y = deckY(P[i][0], P[i][1]) + yOff;
      arr.push(P[i - 1][0], prevY, P[i - 1][1], P[i][0], y, P[i][1]);
      prevY = y;
    }
  }
  return new Float32Array(arr);
}
function makeLines(polys, mat, yOff) {
  const g = new LineSegmentsGeometry(); g.setPositions(segmentsFor(polys, yOff));
  const l = new LineSegments2(g, mat); l.computeLineDistances?.(); return l;
}

// OpenStreetMap roads / parks / lakes (downloaded by the server on first run)
const roadLayers = [];   // {line, worldWidth, minPx}
const ROAD_W = { m: [26, 3.2], t: [22, 3], p: [17, 2.4], s: [13, 1.8], r: [10, 1.3], l: [9, 1.2] };
const roadMats = {};
let osmParks = [];
function buildOsm(osm) {
  const byClass = {};
  for (const r of osm.roads || []) (byClass[r.c] = byClass[r.c] || []).push(r.p.map(p => proj(p[0], p[1])));
  for (const [c, polys] of Object.entries(byClass)) {
    const mat = roadMats[c] = lineMat(SEASONS[season].road);
    const line = makeLines(polys, mat, 0.7 + (c === 'm' || c === 't' ? .2 : 0));
    line.renderOrder = 1;
    world.add(line);
    roadLayers.push({ line, mat, ww: ROAD_W[c][0], min: ROAD_W[c][1], polys });
  }
  osmParks = (osm.parks || []).map(p => ({ P: p.p.map(q => proj(q[0], q[1])), golf: p.g }));
  for (const pk of osmParks) {
    if (pk.P.length < 4) continue;
    const shape = new THREE.Shape(pk.P.map(([x, z]) => new THREE.Vector2(x, -z)));
    const m = new THREE.Mesh(new THREE.ShapeGeometry(shape), M.park);
    m.rotation.x = -Math.PI / 2; m.position.y = 0.3; m.receiveShadow = true; world.add(m);
  }
  for (const w of osm.water || []) {
    const P = w.p.map(q => proj(q[0], q[1])); if (P.length < 4) continue;
    const m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(P.map(([x, z]) => new THREE.Vector2(x, -z)))), M.lake);
    m.rotation.x = -Math.PI / 2; m.position.y = 0.4; world.add(m);
  }
}

// transit route lines (one object per route so a route can be highlighted)
const routeLines = new Map();   // routeId -> {line, mat}
const routeBase = [];
function buildRoutes(haveRoads) {
  const allPolys = [];
  for (const r of STATIC.routes) {
    const polys = r.shapes.filter(s => SHAPES[s]).map(s => SHAPES[s].P);
    if (!polys.length) continue;
    allPolys.push(...polys);
    const mat = lineMat(r.color, .55);
    const line = makeLines(polys, mat, 1.6);
    line.renderOrder = 3; line.userData = { type: 'route', id: r.id };
    world.add(line);
    routeLines.set(r.id, { line, mat });
  }
  if (!haveRoads) {   // without OSM roads, draw the bus network as the road layer
    const mat = roadMats.base = lineMat(SEASONS[season].road);
    const line = makeLines(allPolys, mat, 0.7); line.renderOrder = 1; world.add(line);
    routeBase.push({ line, mat, ww: 16, min: 2.4, polys: allPolys });
  }
}

// bridge piers where bus routes cross the river
function buildBridges() {
  const pierGeo = new THREE.BoxGeometry(10, DECK, 10); pierGeo.translate(0, DECK / 2, 0);
  const deckGeo = new THREE.BoxGeometry(1, 2, 1);
  for (const b of STATIC.bridges) {
    const dirX = Math.cos(b.a), dirZ = Math.sin(b.a);
    for (let k = -2; k <= 2; k++) {
      const p = new THREE.Mesh(pierGeo, M.pier);
      p.position.set(b.x + dirX * k * 55, 0.5, b.y + dirZ * k * 55); p.castShadow = true; world.add(p);
    }
    const d = new THREE.Mesh(deckGeo, M.pier);
    d.scale.set(360, 1, 30); d.position.set(b.x, DECK - 0.6, b.y); d.rotation.y = -b.a; d.castShadow = true; d.receiveShadow = true; world.add(d);
  }
}

// spatial hash helpers for placement
function makeHash(cell) { const m = new Map(); return { cell, add(x, z, v) { const k = Math.floor(x / cell) + ',' + Math.floor(z / cell); (m.get(k) || m.set(k, []).get(k)).push(v ?? [x, z]); }, near(x, z, r) { const out = []; const c0 = Math.floor((x - r) / cell), c1 = Math.floor((x + r) / cell), r0 = Math.floor((z - r) / cell), r1 = Math.floor((z + r) / cell); for (let i = c0; i <= c1; i++) for (let j = r0; j <= r1; j++) { const a = m.get(i + ',' + j); if (a) out.push(...a); } return out; } }; }
function pip(P, x, z) { let inside = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, zi] = P[i], [xj, zj] = P[j]; if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside; } return inside; }

// procedural low-poly city: buildings near stops, taller downtown; trees on the river valley and in parks
let buildingMesh = null, treeCrowns = null, treeTrunks = null;
function buildCity() {
  const r = rng(20261010);
  const stopHash = makeHash(400); for (const s of STOPS) stopHash.add(s.xz[0], s.xz[1]);
  const lineHash = makeHash(60);
  const addPolys = polys => { for (const P0 of polys) for (const [x, z] of densify(P0, 22)) lineHash.add(x, z); };
  addPolys(Object.values(SHAPES).map(s => s.P));
  for (const L of roadLayers) addPolys(L.polys);
  const parkBoxes = osmParks.map(p => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const [x, z] of p.P) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z); } return { ...p, a, b, c, d }; });
  const inPark = (x, z) => parkBoxes.some(p => x > p.a && x < p.b && z > p.c && z < p.d && pip(p.P, x, z));

  const cc = hub('city centre').xz, uni = hub('university').xz;
  const malls = HUBS.filter(h => /mall|confederation|lawson/i.test(h.name)).map(h => h.xz);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of STOPS) { minX = Math.min(minX, s.xz[0]); maxX = Math.max(maxX, s.xz[0]); minZ = Math.min(minZ, s.xz[1]); maxZ = Math.max(maxZ, s.xz[1]); }

  const items = [];   // [x, z, w, d, h, colorIdx]
  const CELL = 58;
  for (let x = minX - 300; x < maxX + 300; x += CELL) for (let z = minZ - 300; z < maxZ + 300; z += CELL) {
    const jx = x + (r() - .5) * 16, jz = z + (r() - .5) * 16;
    const nearStops = stopHash.near(jx, jz, 420);
    let ds = Infinity; for (const [sx, sz] of nearStops) ds = Math.min(ds, Math.hypot(sx - jx, sz - jz));
    if (ds > 420) continue;
    const dcc = Math.hypot(jx - cc[0], jz - cc[1]), duni = Math.hypot(jx - uni[0], jz - uni[1]);
    const dmall = Math.min(...malls.map(m => Math.hypot(jx - m[0], jz - m[1])), Infinity);
    const downtown = dcc < 900, campus = duni < 650, mall = dmall < 260;
    const p = downtown ? .92 : campus ? .55 : mall ? .5 : ds < 140 ? .72 : ds < 260 ? .6 : .38;
    if (r() > p) continue;
    if (riverDist(jx, jz) < RIVER_HALF + 120) continue;
    let near = false; for (const [lx, lz] of lineHash.near(jx, jz, 30)) if (Math.hypot(lx - jx, lz - jz) < (downtown ? 22 : 18)) { near = true; break; }
    if (near) continue;
    if (osmParks.length && inPark(jx, jz)) continue;
    let w, d, h, c;
    if (downtown) { w = 26 + r() * 22; d = 26 + r() * 22; h = 14 + Math.pow(r(), 1.7) * 95 * (1 - dcc / 1100); c = 5 + (r() * 3 | 0); }
    else if (campus) { w = 26 + r() * 26; d = 18 + r() * 18; h = 10 + r() * 22; c = 8; }
    else if (mall) { w = 40 + r() * 16; d = 40 + r() * 16; h = 7 + r() * 5; c = 9; }
    else { w = 12 + r() * 10; d = 12 + r() * 10; h = 5 + r() * (ds < 160 && r() < .2 ? 14 : 4); c = r() * 5 | 0; }
    items.push([jx, jz, w, d, Math.max(4, h), c]);
  }
  const COLORS = ['#EBDDCB', '#E5D4BF', '#DCC9B1', '#F1E8DA', '#D9C4A9', '#DCE1E7', '#CBD5DF', '#E8E3DA', '#D8C1A0', '#E9E1D4'].map(c => new THREE.Color(c));
  const geo = new THREE.BoxGeometry(1, 1, 1); geo.translate(0, .5, 0);
  buildingMesh = new THREE.InstancedMesh(geo, [M.wall, M.wall, M.roof, M.roof, M.wall, M.wall], items.length);
  const m4 = new THREE.Matrix4();
  items.forEach(([x, z, w, d, h, c], i) => { m4.makeScale(w, h, d).setPosition(x, 0, z); buildingMesh.setMatrixAt(i, m4); buildingMesh.setColorAt(i, COLORS[c]); });
  buildingMesh.castShadow = true; buildingMesh.receiveShadow = true;
  world.add(buildingMesh);

  // trees
  const trees = [];
  for (let i = 0; i < 9000 && trees.length < 5200; i++) {
    const k = r() * (riverDense.length - 1) | 0, [ax, az] = riverDense[k], [bx, bz] = riverDense[k + 1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz) || 1, side = r() < .5 ? -1 : 1, off = RIVER_HALF + 25 + r() * 260;
    const x = ax + dx * r() + (-dz / L) * off * side, z = az + dz * r() + (dx / L) * off * side;
    if (riverDist(x, z) < RIVER_HALF + 20) continue;
    let near = false; for (const [lx, lz] of lineHash.near(x, z, 20)) if (Math.hypot(lx - x, lz - z) < 14) { near = true; break; }
    if (!near) trees.push([x, z, 7 + r() * 9]);
  }
  for (const p of parkBoxes) {
    const area = (p.b - p.a) * (p.d - p.c), n = Math.min(160, area / 9000 * (p.golf ? .4 : 1));
    for (let i = 0; i < n * 2 && trees.length < 9000; i++) {
      const x = lerp(p.a, p.b, r()), z = lerp(p.c, p.d, r());
      if (pip(p.P, x, z) && riverDist(x, z) > RIVER_HALF + 15) trees.push([x, z, 6 + r() * 9]);
    }
  }
  const crown = new THREE.ConeGeometry(1, 1, 6); crown.translate(0, .5, 0);
  const trunk = new THREE.CylinderGeometry(.12, .16, 1, 5); trunk.translate(0, .5, 0);
  treeCrowns = new THREE.InstancedMesh(crown, M.tree, trees.length);
  treeTrunks = new THREE.InstancedMesh(trunk, M.trunk, trees.length);
  const tint = new THREE.Color();
  trees.forEach(([x, z, h], i) => {
    m4.makeScale(h * .42, h * .8, h * .42).setPosition(x, h * .28, z); treeCrowns.setMatrixAt(i, m4);
    m4.makeScale(h * .9, h * .32, h * .9).setPosition(x, 0, z); treeTrunks.setMatrixAt(i, m4);
    treeCrowns.setColorAt(i, tint.setHSL(0, 0, .82 + r() * .3));
  });
  treeCrowns.castShadow = true; treeCrowns.receiveShadow = true; treeTrunks.castShadow = true;
  world.add(treeCrowns, treeTrunks);
  console.log(`[rideline] city: ${items.length} buildings, ${trees.length} trees`);
}

// stops: screen-sized round markers (white dot, dark outline) drawn above trees and houses so they're always findable.
// Hubs are bigger and amber. When a route or bus is selected, that route's stops take its colour and the rest fade.
let stopPoints = null;
const STOP_INK = new THREE.Color('#1F2328'), STOP_FILL = new THREE.Color('#FFFFFF'), STOP_HUB = new THREE.Color(ACCENT);
const stopSizePx = zoom => clamp(3.2 + Math.log2(zoom) * 2.3, 3.2, 13);   // ~3 px for the whole city, ~10 px at street level
function buildStops() {
  const n = STOPS.length, geo = new THREE.BufferGeometry();
  const pos = new Float32Array(n * 3), fill = new Float32Array(n * 3), ring = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n);
  STOPS.forEach((s, i) => {
    pos.set([s.xz[0], 1.5, s.xz[1]], i * 3);
    (s.hub ? STOP_HUB : STOP_FILL).toArray(fill, i * 3); STOP_INK.toArray(ring, i * 3);
    size[i] = s.hub ? 1.7 : 1; alpha[i] = 1;
  });
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aFill', new THREE.BufferAttribute(fill, 3));
  geo.setAttribute('aRing', new THREE.BufferAttribute(ring, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geo.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uPx: { value: 6 }, uOpacity: { value: 1 } },
    vertexShader: `
      attribute vec3 aFill; attribute vec3 aRing; attribute float aSize; attribute float aAlpha;
      uniform float uPx; varying vec3 vFill; varying vec3 vRing; varying float vAlpha;
      void main() {
        vFill = aFill; vRing = aRing; vAlpha = aAlpha;
        gl_PointSize = uPx * aSize;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uOpacity; varying vec3 vFill; varying vec3 vRing; varying float vAlpha;
      void main() {
        float r = length(gl_PointCoord * 2.0 - 1.0), aa = fwidth(r);
        if (r > 1.0) discard;
        vec3 c = mix(vFill, vRing, smoothstep(0.56 - aa, 0.56 + aa, r));
        gl_FragColor = vec4(c, (1.0 - smoothstep(1.0 - aa * 1.5, 1.0, r)) * vAlpha * uOpacity);
      }`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  stopPoints = new THREE.Points(geo, mat);
  stopPoints.renderOrder = 8; stopPoints.frustumCulled = false;
  world.add(stopPoints);
}
let stopScaleKey = -1;
function scaleStops() {
  const key = Math.round(camera.zoom * 50) + renderer.getPixelRatio();
  if (key === stopScaleKey) return; stopScaleKey = key;
  stopPoints.material.uniforms.uPx.value = stopSizePx(camera.zoom) * renderer.getPixelRatio();
  stopPoints.material.uniforms.uOpacity.value = clamp(.45 + (camera.zoom - 1) * .3, .45, 1);   // faint across the whole city
}
function highlightStops(active) {
  const g = stopPoints.geometry, ring = g.attributes.aRing, size = g.attributes.aSize, alpha = g.attributes.aAlpha, c = new THREE.Color();
  STOPS.forEach((s, i) => {
    const rid = active.size ? s.routes.find(r => active.has(r)) : null;
    c.copy(rid ? new THREE.Color(ROUTES.get(rid)?.color || ACCENT) : STOP_INK).toArray(ring.array, i * 3);
    size.array[i] = (s.hub ? 1.7 : 1) * (rid ? 1.35 : 1);
    alpha.array[i] = active.size && !rid ? .3 : 1;
  });
  ring.needsUpdate = size.needsUpdate = alpha.needsUpdate = true;
}
// nearest stop within a few pixels of a screen point (markers are too small to hit with a ray)
function stopAtScreen(px, py) {
  const reach = Math.max(9, stopSizePx(camera.zoom) * .9);
  let best = null, bd = reach * reach;
  for (const s of STOPS) {
    v3.set(s.xz[0], 1.5, s.xz[1]).project(camera);
    const dx = (v3.x + 1) / 2 * innerWidth - px, dy = (1 - v3.y) / 2 * innerHeight - py, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// stop names, once zoomed in to street level: nearest the middle of the screen first, skipping any that would overlap
const STOP_LABEL_ZOOM = 16, STOP_LABEL_MAX = 40;
const stopLabelPool = [];
function updateStopLabels() {
  let used = 0;
  if (camera.zoom >= STOP_LABEL_ZOOM) {
    const cx = innerWidth / 2, cy = innerHeight / 2, cand = [];
    for (const s of STOPS) {
      if (s.hub || (selected?.type === 'stop' && selected.id === s.id)) continue;   // hubs and the selected stop have their own labels
      v3.set(s.xz[0], 1.5, s.xz[1]).project(camera);
      const x = (v3.x + 1) / 2 * innerWidth, y = (1 - v3.y) / 2 * innerHeight;
      if (x < 0 || y < 60 || x > innerWidth || y > innerHeight) continue;
      cand.push({ s, x, y, d: (x - cx) ** 2 + (y - cy) ** 2 });
    }
    cand.sort((a, b) => a.d - b.d);
    const placed = [];
    for (const c of cand) {
      if (used >= STOP_LABEL_MAX) break;
      const w = c.s.name.length * 6 + 14;
      if (placed.some(p => Math.abs(p.x - c.x) < (p.w + w) / 2 && Math.abs(p.y - c.y) < 20)) continue;
      placed.push({ x: c.x, y: c.y, w });
      let el = stopLabelPool[used];
      if (!el) { el = document.createElement('div'); el.className = 'lbl stopname'; $('#labels').appendChild(el); stopLabelPool.push(el); }
      if (el.textContent !== c.s.name) el.textContent = c.s.name;
      el.style.left = c.x + 'px'; el.style.top = c.y + 'px'; el.hidden = false;
      used++;
    }
  }
  for (let i = used; i < stopLabelPool.length; i++) stopLabelPool[i].hidden = true;
}

// landmarks at hubs: labels
const hubLabels = HUBS.map(h => {
  const el = document.createElement('div'); el.className = 'lbl hub';
  el.textContent = h.name.replace(/ Hub$/, '').replace('University-Place Riel', 'University').replace('Wildwood-Centre Mall', 'Centre Mall');
  $('#labels').appendChild(el); return { el, x: h.xz[0], z: h.xz[1] };
});

// clouds
const clouds = [];
function buildClouds() {
  const r = rng(99), g = new THREE.IcosahedronGeometry(1, 0);
  for (let i = 0; i < 14; i++) {
    const c = new THREE.Group();
    for (let k = 0; k < 4; k++) { const m = new THREE.Mesh(g, M.cloud); const s = 120 + r() * 160; m.scale.set(s * 1.4, s * .7, s); m.position.set((k - 1.5) * 170 + r() * 60, r() * 50, r() * 120); c.add(m); }
    c.position.set((r() - .5) * 22000, 1600 + r() * 600, (r() - .5) * 22000);
    c.userData.v = 18 + r() * 22;
    clouds.push(c); scene.add(c);
  }
}

// snow particles (follow the camera target)
const SNOW_N = 6000;
const snowGeo = new THREE.BufferGeometry();
const snowPos = new Float32Array(SNOW_N * 3), snowSeed = new Float32Array(SNOW_N);
{ const r = rng(5); for (let i = 0; i < SNOW_N; i++) { snowPos[i * 3] = (r() - .5); snowPos[i * 3 + 1] = r(); snowPos[i * 3 + 2] = (r() - .5); snowSeed[i] = r(); } }
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snowMat = new THREE.PointsMaterial({ color: '#FFFFFF', size: 2.6, sizeAttenuation: false, transparent: true, opacity: .9, depthWrite: false });
const snow = new THREE.Points(snowGeo, snowMat); snow.frustumCulled = false; snow.visible = false; scene.add(snow);

// ============================================================ buses
const buses = new Map();   // id -> record
const BUS_GEO = (() => {
  const body = new THREE.BoxGeometry(12, 2.6, 3); body.translate(0, 2.1, 0);
  const win = new THREE.BoxGeometry(11.2, .9, 3.06); win.translate(.2, 2.55, 0);
  const roof = new THREE.BoxGeometry(10, .35, 2.5); roof.translate(0, 3.55, 0);
  const wheel = new THREE.CylinderGeometry(.55, .55, 3.15, 10); wheel.rotateX(Math.PI / 2);
  const lamp = new THREE.BoxGeometry(.2, .45, .5);
  const hit = new THREE.BoxGeometry(14, 6, 6); hit.translate(0, 3, 0);
  return { body, win, roof, wheel, lamp, hit };
})();
const M_WIN = new THREE.MeshStandardMaterial({ color: '#26303B', roughness: .3, metalness: .2 });
const M_WHEEL = new THREE.MeshStandardMaterial({ color: '#22252A', roughness: .8 });
const M_LAMP = new THREE.MeshStandardMaterial({ color: '#FFF4D0', emissive: '#FFE7A3', emissiveIntensity: 0 });
const M_PIN = new THREE.MeshStandardMaterial({ color: '#EF4444', emissive: '#EF4444', emissiveIntensity: .25 });
const glowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,235,170,1)'); gr.addColorStop(1, 'rgba(255,235,170,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
const M_GLOW = new THREE.SpriteMaterial({ map: glowTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0 });
const GREY = new THREE.Color('#9AA0A6');
const hitMeshes = [];

function makeBus(b) {
  const g = new THREE.Group();
  const color = new THREE.Color(b.color || '#888');
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: .55, transparent: true, opacity: 0 });
  const winMat = M_WIN.clone(); winMat.transparent = true; winMat.opacity = 0;
  const roofMat = new THREE.MeshStandardMaterial({ color: '#F7F4EE', roughness: .7, transparent: true, opacity: 0 });
  const wheelMat = M_WHEEL.clone(); wheelMat.transparent = true; wheelMat.opacity = 0;
  const parts = [new THREE.Mesh(BUS_GEO.body, bodyMat), new THREE.Mesh(BUS_GEO.win, winMat), new THREE.Mesh(BUS_GEO.roof, roofMat)];
  for (const [x, z] of [[-3.8, 0], [3.8, 0]]) { const w = new THREE.Mesh(BUS_GEO.wheel, wheelMat); w.position.set(x, .55, z); parts.push(w); }
  for (const z of [-.8, .8]) { const l = new THREE.Mesh(BUS_GEO.lamp, M_LAMP); l.position.set(6.02, 1.4, z); parts.push(l); }
  parts.forEach(p => { p.castShadow = true; p.renderOrder = 6; g.add(p); });
  const glow = new THREE.Sprite(M_GLOW); glow.position.set(9, 1.4, 0); glow.scale.set(8, 8, 1); g.add(glow);
  const hit = new THREE.Mesh(BUS_GEO.hit, new THREE.MeshBasicMaterial({ visible: false }));
  hit.userData = { type: 'bus', id: b.id }; g.add(hit); hitMeshes.push(hit);
  const pin = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(1, 2.4, 10), M_PIN); cone.rotation.x = Math.PI; cone.position.y = 1.2;
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1.15, 14, 10), M_PIN); ball.position.y = 3;
  cone.renderOrder = ball.renderOrder = 7; pin.add(cone, ball); pin.position.y = 6; pin.visible = false; g.add(pin);
  scene.add(g);
  return { id: b.id, group: g, bodyMat, fadeMats: [bodyMat, winMat, roofMat, wheelMat], color, pin, samples: [], data: b, opacity: 0, target: 1, miss: 0, heading: b.bearing !== null ? Math.PI / 2 - THREE.MathUtils.degToRad(b.bearing) : 0, pos: new THREE.Vector3() };
}
function removeBus(rec) {
  scene.remove(rec.group);
  const i = hitMeshes.indexOf(rec.group.children.find(c => c.userData.type === 'bus')); if (i >= 0) hitMeshes.splice(i, 1);
  rec.fadeMats.forEach(m => m.dispose());
  buses.delete(rec.id);
}

let lastFeedTime = null, feedReceivedAt = 0, payload = null, serverSkew = 0;
function ingest(p) {
  payload = p;
  serverSkew = p.serverTime - Date.now() / 1000;
  if (p.feedTime && p.feedTime !== lastFeedTime) {
    lastFeedTime = p.feedTime; feedReceivedAt = Date.now() / 1000;
    const seen = new Set();
    for (const b of p.buses) {
      seen.add(b.id);
      let rec = buses.get(b.id);
      if (!rec) { rec = makeBus(b); buses.set(b.id, rec); }
      if (rec.data.routeId !== b.routeId) { rec.color.set(b.color); }
      rec.data = b; rec.miss = 0; rec.target = 1;
      const last = rec.samples[rec.samples.length - 1];
      if (!last || last.ts !== b.ts) {
        const [x, z] = proj(b.lat, b.lon);
        const t = Math.min(feedReceivedAt, feedReceivedAt - (p.feedTime - b.ts));
        const sh = SHAPES[b.shapeId];
        let s = null; if (sh) { const pr = shapeProject(sh, x, z); if (pr.d < 120) s = pr.s; }
        rec.samples.push({ t, x, z, s, ts: b.ts, shapeId: b.shapeId, bearing: b.bearing });
        if (rec.samples.length > 6) rec.samples.shift();
      }
    }
    for (const rec of buses.values()) if (!seen.has(rec.id)) { rec.miss++; if (rec.miss >= 2) rec.target = 0; }
  }
}

function busPosition(rec, rt) {
  const S = rec.samples;
  if (!S.length) return null;
  if (rt <= S[0].t || S.length === 1) return { x: S[0].x, z: S[0].z, h: null };
  for (let i = 0; i < S.length - 1; i++) {
    const a = S[i], b = S[i + 1];
    if (rt >= a.t && rt < b.t) {
      const f = (rt - a.t) / Math.max(.001, b.t - a.t);
      const straight = Math.hypot(b.x - a.x, b.z - a.z);
      const sh = SHAPES[a.shapeId];
      if (sh && a.shapeId === b.shapeId && a.s !== null && b.s !== null && b.s >= a.s && b.s - a.s < straight * 3 + 300 && straight > 1) {
        const p = shapePoint(sh, lerp(a.s, b.s, f));
        return { x: p.x, z: p.z, h: Math.atan2(-p.dz, p.dx) };
      }
      return { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), h: straight > 2 ? Math.atan2(-(b.z - a.z), b.x - a.x) : null };
    }
  }
  const l = S[S.length - 1]; return { x: l.x, z: l.z, h: null };
}
const angLerp = (a, b, t) => { let d = ((b - a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return a + d * t; };

// ============================================================ selection & camera
let selected = null;          // {type, id}
let follow = false;
let glide = null;
const selRing = new THREE.Mesh(new THREE.RingGeometry(.78, 1, 48), new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: .9, depthWrite: false, side: THREE.DoubleSide }));
selRing.rotation.x = -Math.PI / 2; selRing.visible = false; selRing.renderOrder = 10; scene.add(selRing);
const selLabel = document.createElement('div'); selLabel.className = 'lbl sel'; selLabel.hidden = true; $('#labels').appendChild(selLabel);

// orient: also glide the camera back to the default tilt and compass angle. keepMe: don't stop following "my location".
function flyTo(x, z, zoom, dur = 1.2, { orient = false, keepMe = false } = {}) {
  glide = { t0: performance.now(), dur: dur * 1000, from: controls.target.clone(), to: new THREE.Vector3(x, 0, z), z0: camera.zoom, z1: zoom ?? camera.zoom };
  if (orient) { glide.s0 = new THREE.Spherical().setFromVector3(camera.position.clone().sub(controls.target)); glide.s1 = new THREE.Spherical(CAM_DIST, POLAR, AZ); }
  if (!keepMe) setMeFollow(false);
}
function selectedXZ() {
  if (!selected) return null;
  if (selected.type === 'bus') { const r = buses.get(selected.id); return r ? [r.pos.x, r.pos.z] : null; }
  if (selected.type === 'stop') { const s = STOP_BY_ID.get(selected.id); return s && s.xz; }
  if (selected.type === 'route') {
    const r = ROUTES.get(selected.id); const sh = r && SHAPES[r.shapes[0]]; if (!sh) return null;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const sid of r.shapes) for (const [x, z] of (SHAPES[sid]?.P || [])) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, z); d = Math.max(d, z); }
    return [(a + b) / 2, (c + d) / 2, Math.max(b - a, d - c)];
  }
}
function select(type, id, { fly = true } = {}) {
  selected = type ? { type, id } : null;
  follow = type === 'bus';
  highlightRoutes();
  renderDetail(); renderTracker(); renderTable();
  document.body.classList.toggle('no-detail', !selected);
  if (!selected) { selRing.visible = false; selLabel.hidden = true; return; }
  const p = selectedXZ();
  if (p && fly) {
    if (type === 'route') flyTo(p[0], p[1], clamp(H0 * 1.6 / (p[2] || 4000), 1.2, 8));
    else flyTo(p[0], p[1], Math.max(camera.zoom, type === 'stop' ? 14 : 11));
  }
  if (type === 'stop') loadStopBoard();
}
function highlightRoutes() {
  let active = new Set();
  if (selected?.type === 'route') active.add(selected.id);
  if (selected?.type === 'bus') { const r = buses.get(selected.id); if (r) active.add(r.data.routeId); }
  if (selected?.type === 'stop') (STOP_BY_ID.get(selected.id)?.routes || []).forEach(r => active.add(r));
  for (const [id, { mat }] of routeLines) {
    const on = active.has(id);
    mat.opacity = active.size ? (on ? 1 : .1) : .55;
    mat.transparent = true;
    mat.userData.boost = on ? 1.7 : 1;
  }
  highlightStops(selected?.type === 'stop' ? new Set() : active);   // a stop's own routes would light up half the city
}

// picking
const raycaster = new THREE.Raycaster();
raycaster.params.Line2 = { threshold: 8 };
const ndc = new THREE.Vector2();
let downAt = null;
renderer.domElement.addEventListener('pointerdown', e => { downAt = [e.clientX, e.clientY]; closeMenus(); });
renderer.domElement.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5 || e.button !== 0) return;
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  raycaster.camera = camera;
  const hb = raycaster.intersectObjects(hitMeshes, false);
  if (hb.length) return select('bus', hb[0].object.userData.id);
  const hs = stopAtScreen(e.clientX, e.clientY);
  if (hs) return select('stop', hs.id);
  const lines = [...routeLines.values()].map(v => v.line).filter(l => l.material.opacity > .2);
  const hr = raycaster.intersectObjects(lines, false);
  if (hr.length) return select('route', hr[0].object.userData.id);
  select(null);
});
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), _hit = new THREE.Vector3();
renderer.domElement.addEventListener('dblclick', e => {
  ndc.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (raycaster.ray.intersectPlane(groundPlane, _hit)) { follow = false; flyTo(_hit.x, _hit.z, Math.min(controls.maxZoom, camera.zoom * 3), 0.6); }
});
addEventListener('keydown', e => {
  if (e.target.closest('input')) return;
  if (e.key === '+' || e.key === '=') zoomBy(2);
  if (e.key === '-' || e.key === '_') zoomBy(.5);
  if (e.key === 'h' || e.key === 'H') goHome();
});
controls.addEventListener('start', () => { if (follow && downAt) follow = false; glide = null; setMeFollow(false); });

// ============================================================ map controls: zoom, whole city, my location
const HOME = { x: 0, z: 400, zoom: 1.15 };
function zoomBy(f) {
  const z = clamp((glide ? glide.z1 : camera.zoom) * f, controls.minZoom, controls.maxZoom);   // stack quick clicks
  flyTo(controls.target.x, controls.target.z, z, 0.35, { keepMe: true });
}
function goHome() {
  follow = false;
  document.querySelectorAll('#areas .chip').forEach(c => c.classList.toggle('on', c.textContent === 'City'));
  flyTo(HOME.x, HOME.z, HOME.zoom, 1.2, { orient: true });
}
$('#zin').onclick = () => zoomBy(2);
$('#zout').onclick = () => zoomBy(.5);
$('#home').onclick = goHome;

// Live location: the browser's GPS/Wi-Fi fix, drawn as a dot plus a circle the size of the reported accuracy.
const ME_RANGE = 30000;   // metres from the city centre; further away than this there's nothing of ours to show
let meWatch = null, me = null, meFollow = false;
const meDot = document.createElement('div'); meDot.className = 'me-dot'; meDot.hidden = true; $('#labels').appendChild(meDot);
const meCircle = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ color: '#2563EB', transparent: true, opacity: .14, depthTest: false, depthWrite: false }));
meCircle.rotation.x = -Math.PI / 2; meCircle.renderOrder = 9; meCircle.visible = false; scene.add(meCircle);
function setMeFollow(on) {
  meFollow = on;
  const b = $('#locate');
  b.classList.toggle('on', meWatch !== null);
  b.classList.toggle('following', on);
  b.title = meWatch === null ? 'Show my location' : on ? 'Stop showing my location' : 'Centre on my location';
}
function stopLocate() {
  if (meWatch !== null) navigator.geolocation.clearWatch(meWatch);
  meWatch = null; me = null; meDot.hidden = true; meCircle.visible = false;
  $('#locate').classList.remove('wait');
  setMeFollow(false);
}
function centreOnMe() {
  if (Math.hypot(me.x - HOME.x, me.z - HOME.z) > ME_RANGE) { toast('You appear to be outside Saskatoon, so there’s nothing to centre on'); return; }
  follow = false;
  flyTo(me.x, me.z, Math.max(camera.zoom, 11), 1.2);
  setMeFollow(true);
}
$('#locate').onclick = () => {
  if (meWatch !== null) { if (meFollow) stopLocate(); else if (me) centreOnMe(); return; }
  if (!('geolocation' in navigator)) { toast('This browser can’t share your location'); return; }
  if (!isSecureContext) { toast('Your location only works over https:// or on localhost'); return; }
  $('#locate').classList.add('wait');
  let first = true;
  meWatch = navigator.geolocation.watchPosition(pos => {
    const [x, z] = proj(pos.coords.latitude, pos.coords.longitude);
    me = { x, z, acc: pos.coords.accuracy };
    meDot.hidden = false; meCircle.visible = true;
    meCircle.position.set(x, 1, z); meCircle.scale.setScalar(Math.max(5, me.acc));
    if (first) { first = false; $('#locate').classList.remove('wait'); centreOnMe(); }
  }, err => {
    if (err.code !== err.PERMISSION_DENIED && me) return;   // a missed update after a good fix: keep the last one
    toast(err.code === err.PERMISSION_DENIED ? 'Location permission was denied. Allow it in your browser’s site settings.' : 'Couldn’t get your location');
    stopLocate();
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  setMeFollow(false);
};

// ============================================================ day / night
let dayMode = 'auto', night = 0, nightTarget = 0;
function sunAltitude(date = new Date()) {
  const lat = 52.13 * Math.PI / 180, lon = -106.66;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0), N = (date - start) / 864e5;
  const decl = -23.44 * Math.PI / 180 * Math.cos(2 * Math.PI / 365 * (N + 10));
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
  const H = ((utcH + lon / 15 - 12) * 15) * Math.PI / 180;
  return Math.asin(Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(H)) * 180 / Math.PI;
}
function updateNightTarget() { nightTarget = dayMode === 'day' ? 0 : dayMode === 'night' ? 1 : smooth(4, -6, sunAltitude()); }
$('#daynight').onclick = () => { dayMode = { auto: 'day', day: 'night', night: 'auto' }[dayMode]; $('#daynight').textContent = dayMode[0].toUpperCase() + dayMode.slice(1); updateNightTarget(); };

// ============================================================ seasons
function setSeason(s) {
  season = s; const S = SEASONS[s];
  M.ground.color.set(S.ground); M.park.color.set(S.park); M.bank.color.set(S.bank); M.tree.color.set(S.tree);
  for (const m of Object.values(roadMats)) m.color.set(S.road);
  waterUniforms.uIce.value = s === 'winter' ? .55 : s === 'blizzard' ? .8 : 0;
  snow.visible = S.snow > 0; snowMat.opacity = S.snow > .5 ? .95 : .8; snowMat.size = S.snow > .5 ? 3.2 : 2.4;
  document.body.classList.toggle('blizzard', s === 'blizzard');
  $('#weather-btn').textContent = s[0].toUpperCase() + s.slice(1);
}
$('#weather-btn').onclick = e => { e.stopPropagation(); $('#weather-menu').hidden = !$('#weather-menu').hidden; };
$('#weather-menu').onclick = e => { const s = e.target.dataset.season; if (s) { setSeason(s); $('#weather-menu').hidden = true; } };
function closeMenus() { $('#weather-menu').hidden = true; $('#search-results').hidden = true; }
document.addEventListener('click', e => { if (!e.target.closest('.menu,.search')) closeMenus(); });

// ============================================================ areas
const AREAS = (() => {
  const cc = hub('city centre').xz, uni = hub('university').xz, north = hub('lawson').xz, south = hub('market mall').xz;
  const near = STATIC.bridges.filter(b => Math.hypot(b.x - cc[0], b.y - cc[1]) < 1800);
  const rc = near.length ? [near.reduce((a, b) => a + b.x, 0) / near.length, near.reduce((a, b) => a + b.y, 0) / near.length] : cc;
  return [
    ['City', [0, 400], 1.15], ['Downtown', cc, 9], ['University', uni, 9], ['River Crossings', rc, 6.5], ['North End', north, 4.2], ['South End', south, 4.2],
  ];
})();
for (const [name, xz, zoom] of AREAS) {
  const b = document.createElement('button'); b.className = 'chip'; b.textContent = name;
  b.onclick = () => {
    if (name === 'City') return goHome();
    follow = false; document.querySelectorAll('#areas .chip').forEach(c => c.classList.toggle('on', c === b)); flyTo(xz[0], xz[1], zoom);
  };
  $('#areas').appendChild(b);
}
// the area chips scroll sideways on narrow windows: fade the edge while more are hidden, and let a mouse wheel scroll them
const areasEl = $('#areas'), areasFade = () => areasEl.classList.toggle('more-right', areasEl.scrollLeft + areasEl.clientWidth < areasEl.scrollWidth - 2);
areasEl.addEventListener('scroll', areasFade, { passive: true });
areasEl.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { areasEl.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
addEventListener('resize', areasFade); areasFade();

// ============================================================ feed polling
let demo = PREVIEW;
let stopBoard = { feedTime: null, stops: {} }, stopBoardAt = 0;
function previewPayload() {
  const base = PV.live, now = Date.now() / 1000, el = now - PV_T0, shift = now - base.feedTime;
  const out = base.buses.map(b => {
    const sh = SHAPES[b.shapeId], o = { ...b, ts: Math.floor(now), next: b.next.map(n => ({ ...n, eta: n.eta + shift })) };
    if (sh && sh.len) {
      if (b._s0 === undefined) { const [x, z] = proj(b.lat, b.lon); b._s0 = shapeProject(sh, x, z).s; }
      const v = Math.max(6, b.speedKmh || 22) / 3.6, p = shapePoint(sh, (b._s0 + v * el) % sh.len);
      o.lon = LON0 + p.x / KX; o.lat = LAT0 - p.z / KY; o.bearing = (Math.atan2(p.dx, -p.dz) * 180 / Math.PI + 360) % 360;
    }
    delete o._s0; return o;
  });
  return { ...base, mode: 'demo', status: 'preview', serverTime: now, feedTime: Math.floor(now), buses: out, alerts: [] };
}
async function poll() {
  if (PREVIEW) { ingest(previewPayload()); renderStatus(); renderKpis(); renderDetail(); renderTracker(); renderTable(true); return; }
  try {
    const p = await fetch('api/live' + (demo ? '?demo=1' : ''), { cache: 'no-store' }).then(r => r.json());
    if ((p.mode === 'demo') !== demo) return;   // response from before a toggle
    ingest(p);
  } catch (e) {
    payload = { ...(payload || { buses: [], stats: null }), status: 'offline', error: 'Rideline server not reachable' };
  }
  renderStatus(); renderKpis(); renderDetail(); renderTracker(); renderTable(true);
}
async function loadStopBoard(force) {
  if (PREVIEW) {
    const shift = Date.now() / 1000 - PV.stops.feedTime, st = {};
    for (const [k, arr] of Object.entries(PV.stops.stops)) st[k] = arr.map(a => ({ ...a, eta: a.eta + shift }));
    stopBoard = { feedTime: Date.now() / 1000, stops: st }; stopBoardAt = Date.now(); renderDetail(); renderTable(true); return;
  }
  if (demo || (!force && Date.now() - stopBoardAt < 20000)) return;
  try { stopBoard = await fetch('api/stops', { cache: 'no-store' }).then(r => r.json()); stopBoardAt = Date.now(); renderDetail(); renderTable(true); } catch { /* keep last */ }
}
$('#demo-btn').onclick = () => {
  demo = !demo; $('#demo-btn').classList.toggle('on', demo);
  for (const rec of [...buses.values()]) removeBus(rec);
  lastFeedTime = null; payload = null; if (selected?.type === 'bus') select(null);
  toast(demo ? 'Demo mode: simulated movement of a saved snapshot' : 'Back to the live feed');
  poll();
};
const feedNow = () => (payload?.feedTime || Date.now() / 1000) + (Date.now() / 1000 - (feedReceivedAt || Date.now() / 1000));

// ============================================================ UI rendering
function renderStatus() {
  const el = $('#feed'), st = payload?.status || 'starting';
  el.className = 'feed ' + st;
  document.body.classList.toggle('feed-offline', st === 'offline');
  const age = payload?.feedTime ? Math.max(0, Math.round(Date.now() / 1000 + serverSkew - payload.feedTime)) : null;
  const txt = { ok: `Live · ${age ?? '?'}s ago`, stale: `Stale · ${age !== null ? Math.round(age / 60) + ' min' : '?'}`, offline: 'Feed offline', replay: 'Snapshot replay', demo: 'Demo · simulated', preview: 'Preview · simulated', starting: 'Connecting' }[st] || st;
  el.querySelector('span').textContent = txt;
  el.title = st === 'offline' ? (payload?.error || 'No data') + (buses.size ? ' · showing last known positions' : '') : st === 'replay' ? `Saved feed from ${fmtClock(payload?.feedTime)} (${new Date((payload?.feedTime || 0) * 1000).toLocaleDateString('en-CA', { timeZone: TZ })})` : st === 'demo' || st === 'preview' ? 'Positions are simulated along real routes from a saved 18:00 snapshot. Not live. Run the Rideline server on your Mac for live buses.' : `Vehicle feed time ${fmtClock(payload?.feedTime, true)}`;
  $('#attrib-mode').textContent = { ok: 'Live feed', stale: 'Live feed (stale)', offline: 'Feed offline', replay: 'Replaying saved snapshot', demo: 'DEMO: simulated positions', preview: 'PREVIEW: simulated from a saved snapshot, not live', starting: '' }[st] || '';
}
function renderKpis() {
  const s = payload?.stats;
  $('#k-buses').textContent = s ? s.inService : '–';
  $('#k-buses-sub').textContent = s ? `${s.late} running 5+ min late` : ' ';
  $('#k-delay').innerHTML = s && s.avgDelayMin !== null ? `${s.avgDelayMin > 0 ? '+' : ''}${s.avgDelayMin}<span class="unit">min</span>` : '<span class="na">n/a</span>';
  $('#k-delay-sub').textContent = s ? `across ${s.withDelayData} buses with trip data` : ' ';
  $('#k-routes').textContent = s ? s.routesActive : '–';
  $('#k-routes-sub').textContent = s ? `of ${STATIC.routes.length} in the schedule` : ' ';
}
const routeChip = (rid, extra = '') => { const r = ROUTES.get(rid); return r ? `<button class="rchip" data-route="${esc(rid)}" style="background:${r.color}" title="${esc(r.long)}">${esc(r.short)}</button>${extra}` : ''; };

function renderDetail() {
  const box = $('#detail'), body = $('#detail-body');
  if (!selected) { box.hidden = true; return; }
  box.hidden = false;
  const nowS = feedNow();
  if (selected.type === 'bus') {
    const rec = buses.get(selected.id);
    if (!rec) { body.innerHTML = '<div class="d-kicker">Bus</div><div class="d-title">No longer in the feed</div>'; return; }
    const b = rec.data, r = ROUTES.get(b.routeId), next = b.next[0];
    const age = Math.max(0, Math.round(Date.now() / 1000 + serverSkew - b.ts));
    body.innerHTML = `
      <div class="d-kicker">Bus ${esc(b.label)}${b.label !== b.id ? ` <span class="na">· vehicle id ${esc(b.id)}</span>` : ''}</div>
      <div class="d-title"><span class="badge" style="background:${b.color}">${esc(b.routeShort)}</span> ${esc(b.headsign || b.routeName)}</div>
      <div class="d-sub">${esc(b.routeName)}</div>
      <div class="stats">
        <div class="stat"><label>Speed</label><b>${b.speedKmh !== null ? b.speedKmh + ' km/h' : '<span class="na">n/a</span>'}</b></div>
        <div class="stat"><label>Delay</label><b>${fmtDelay(b.delay)}</b></div>
        <div class="stat"><label>Next stop</label><b style="font-size:13px">${next ? esc(next.name) : '<span class="na">n/a</span>'}</b></div>
        <div class="stat"><label>Next stop ETA</label><b>${next ? fmtClock(next.eta) + ` <small class="na">${fmtIn(next.eta, nowS)}</small>` : '<span class="na">n/a</span>'}</b></div>
        <div class="stat"><label>Last GPS fix</label><b>${payload?.mode === 'replay' ? fmtClock(b.ts, true) : age + 's ago'}</b></div>
        <div class="stat"><label>Heading</label><b>${b.bearing !== null ? Math.round(b.bearing) + '°' : '<span class="na">n/a</span>'}</b></div>
      </div>
      <div class="d-actions">
        <button class="chip ${follow ? 'on' : ''}" id="d-follow">${follow ? 'Following' : 'Follow'}</button>
        ${r ? `<button class="chip" data-route="${esc(r.id)}">Show route ${esc(r.short)}</button>` : ''}
      </div>`;
    $('#d-follow').onclick = () => { follow = !follow; renderDetail(); };
  } else if (selected.type === 'stop') {
    const s = STOP_BY_ID.get(selected.id);
    const arr = (stopBoard.stops || {})[s.id] || [];
    const bnow = stopBoard.feedTime ? stopBoard.feedTime + (Date.now() - stopBoardAt) / 1000 : nowS;
    body.innerHTML = `
      <div class="d-kicker">${s.hub ? 'Transit hub' : 'Bus stop'} · #${esc(s.id)}</div>
      <div class="d-title">${esc(s.name)}</div>
      <div class="d-sub">${s.wc === 1 ? '♿ Wheelchair accessible' : s.wc === 2 ? 'Not wheelchair accessible' : 'No wheelchair accessibility information'}</div>
      <div class="d-section"><h4>Routes serving this stop</h4><div class="chips">${s.routes.map(id => routeChip(id)).join('') || '<span class="na">None in schedule</span>'}</div></div>
      <div class="d-section"><h4>Next arrivals ${demo && !PREVIEW ? '<span class="na">(not available in demo)</span>' : PREVIEW ? '<span class="na">(snapshot, time-shifted)</span>' : ''}</h4>
        <ul class="list">${arr.length ? arr.map(a => `<li>${routeChip(a.routeId)}<span>${esc(a.headsign)}</span><span class="r">${fmtClock(a.eta)} · ${fmtIn(a.eta, bnow)} ${a.delay !== null && Math.abs(a.delay) >= 60 ? '· ' + fmtDelay(a.delay, true) : ''}</span></li>`).join('') : `<li class="na">${demo && !PREVIEW ? 'n/a' : 'No predicted arrivals in the feed right now'}</li>`}</ul></div>`;
  } else if (selected.type === 'route') {
    const r = ROUTES.get(selected.id);
    const onRoute = [...buses.values()].filter(x => x.data.routeId === r.id && x.target > 0).map(x => x.data);
    const delays = onRoute.map(b => b.delay).filter(d => d !== null);
    const nStops = STOPS.filter(s => s.routes.includes(r.id)).length;
    body.innerHTML = `
      <div class="d-kicker">Route</div>
      <div class="d-title"><span class="badge" style="background:${r.color}">${esc(r.short)}</span> ${esc(r.long)}</div>
      <div class="stats">
        <div class="stat"><label>Buses now</label><b>${onRoute.length}</b></div>
        <div class="stat"><label>Avg delay</label><b>${delays.length ? fmtDelay(Math.round(delays.reduce((a, b) => a + b, 0) / delays.length)) : '<span class="na">n/a</span>'}</b></div>
        <div class="stat"><label>Stops</label><b>${nStops}</b></div>
        <div class="stat"><label>Official colour</label><b><span class="swatch" style="background:${r.official}"></span> ${esc(r.official)}</b></div>
      </div>
      <div class="d-section"><h4>Buses on this route</h4><ul class="list">${onRoute.length ? onRoute.map(b => `<li data-bus="${esc(b.id)}" style="cursor:pointer"><b>Bus ${esc(b.label)}</b><span>${esc(b.headsign)}</span><span class="r">${fmtDelay(b.delay, true)}</span></li>`).join('') : '<li class="na">None in service right now</li>'}</ul></div>`;
  }
}
$('#detail').addEventListener('click', e => {
  const rb = e.target.closest('[data-route]'); if (rb) return select('route', rb.dataset.route);
  const bb = e.target.closest('[data-bus]'); if (bb) return select('bus', bb.dataset.bus);
});
$('#detail-close').onclick = () => select(null);

function renderTracker() {
  const box = $('#tracker');
  const rec = selected?.type === 'bus' && buses.get(selected.id);
  if (!rec) { box.hidden = true; return; }
  box.hidden = false;
  const b = rec.data, nowS = feedNow();
  box.style.setProperty('--route', b.color);
  $('#tracker-sub').textContent = `Bus ${b.label} · Route ${b.routeShort}`;
  $('#tracker-list').innerHTML = b.next.length ? b.next.map(n => `<li><span class="n" title="${esc(n.name)}">${esc(n.name)}</span><span class="t">${fmtClock(n.eta)}</span><span class="dl">${fmtDelay(n.delay, true)}</span></li>`).join('') : '<li class="na">No upcoming stops in the trip feed</li>';
}

// tables
let tab = 'buses', sort = { buses: ['route', 1], routes: ['route', 1], stops: ['eta', 1], alerts: ['header', 1] };
const TABLES = {
  buses: {
    cols: [['bus', 'Bus'], ['route', 'Route'], ['headsign', 'Headsign'], ['speed', 'Speed'], ['delay', 'Delay'], ['next', 'Next stop'], ['eta', 'ETA']],
    rows: () => [...buses.values()].filter(r => r.target > 0).map(r => r.data).map(b => ({ key: b.id, sel: selected?.type === 'bus' && selected.id === b.id, v: { bus: +b.label || b.label, route: +b.routeShort || b.routeShort, headsign: b.headsign, speed: b.speedKmh ?? -1, delay: b.delay ?? -1e9, next: b.next[0]?.name || '', eta: b.next[0]?.eta || 0 }, html: [`<b>${esc(b.label)}</b>`, routeChip(b.routeId), esc(b.headsign), b.speedKmh !== null ? b.speedKmh + ' km/h' : '<span class="na">n/a</span>', fmtDelay(b.delay, true), esc(b.next[0]?.name || 'n/a'), b.next[0] ? fmtClock(b.next[0].eta) : '<span class="na">n/a</span>'], on: () => select('bus', b.id) })),
  },
  routes: {
    cols: [['route', 'Route'], ['name', 'Name'], ['buses', 'Buses now'], ['delay', 'Avg delay'], ['late', '5+ min late']],
    rows: () => STATIC.routes.map(r => {
      const bs = [...buses.values()].filter(x => x.target > 0 && x.data.routeId === r.id).map(x => x.data);
      const ds = bs.map(b => b.delay).filter(d => d !== null), avg = ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : null;
      return { key: r.id, sel: selected?.type === 'route' && selected.id === r.id, v: { route: +r.short || r.short, name: r.long, buses: bs.length, delay: avg ?? -1e9, late: ds.filter(d => d > LATE_SEC).length }, html: [routeChip(r.id), esc(r.long), bs.length || '<span class="na">0</span>', avg !== null ? fmtDelay(avg, true) : '<span class="na">n/a</span>', ds.filter(d => d > LATE_SEC).length], on: () => select('route', r.id) };
    }),
  },
  stops: {
    cols: [['stop', 'Stop'], ['route', 'Next route'], ['headsign', 'To'], ['eta', 'ETA'], ['delay', 'Delay']],
    rows: () => {
      const q = $('#search').value.trim().toLowerCase();
      return Object.entries(stopBoard.stops || {}).map(([id, arr]) => {
        const s = STOP_BY_ID.get(id); if (!s || !arr.length) return null;
        if (q && !s.name.toLowerCase().includes(q)) return null;
        const a = arr[0];
        return { key: id, sel: selected?.type === 'stop' && selected.id === id, v: { stop: s.name, route: +a.routeShort || a.routeShort, headsign: a.headsign, eta: a.eta, delay: a.delay ?? -1e9 }, html: [esc(s.name), routeChip(a.routeId), esc(a.headsign), fmtClock(a.eta), fmtDelay(a.delay, true)], on: () => select('stop', id) };
      }).filter(Boolean);
    },
  },
  alerts: {
    cols: [['header', 'Alert'], ['routes', 'Routes'], ['effect', 'Effect'], ['until', 'Until']],
    rows: () => (payload?.alerts || []).map(a => ({ key: a.id, v: { header: a.header, routes: a.routes.join(','), effect: a.effect, until: a.end || 0 }, html: [`<span title="${esc(a.description)}">${esc(a.header || a.description || 'Alert')}</span>`, a.routes.map(s => `<b>${esc(s)}</b>`).join(' ') || '<span class="na">All</span>', esc(a.effect || 'n/a'), a.end ? new Date(a.end * 1000).toLocaleString('en-CA', { timeZone: TZ, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '<span class="na">n/a</span>'], on: () => toast(a.description || a.header) })),
  },
};
let tableRows = [];
function renderTable(passive = false) {
  if (passive && document.activeElement && document.activeElement.closest?.('#table')) return;
  const T = TABLES[tab], [key, dir] = sort[tab];
  $('#thead').innerHTML = '<tr>' + T.cols.map(([k, l]) => `<th data-k="${k}" class="${k === key ? 'sorted' + (dir > 0 ? ' asc' : '') : ''}">${l}</th>`).join('') + '</tr>';
  tableRows = T.rows();
  tableRows.sort((a, b) => { const x = a.v[key], y = b.v[key]; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true })) * dir; });
  const shown = tableRows.slice(0, 400);
  $('#tbody').innerHTML = shown.length ? shown.map((r, i) => `<tr data-i="${i}" class="${r.sel ? 'sel' : ''}">${r.html.map(h => `<td>${h}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${T.cols.length}" class="empty">${tab === 'alerts' ? 'No service alerts in the feed' : tab === 'stops' ? (demo && !PREVIEW ? 'Stop predictions are not available in demo mode' : 'No predicted arrivals yet') : 'No buses in the feed yet'}</td></tr>`;
  $('#t-buses').textContent = [...buses.values()].filter(r => r.target > 0).length || '';
  $('#t-routes').textContent = payload?.stats?.routesActive || '';
  $('#t-stops').textContent = Object.keys(stopBoard.stops || {}).length || '';
  $('#t-alerts').textContent = (payload?.alerts || []).length || '';
}
$('#thead').onclick = e => { const k = e.target.dataset.k; if (!k) return; sort[tab] = [k, sort[tab][0] === k ? -sort[tab][1] : 1]; renderTable(); };
$('#tbody').onclick = e => { if (e.target.closest('[data-route]')) return select('route', e.target.closest('[data-route]').dataset.route); const tr = e.target.closest('tr[data-i]'); if (tr) tableRows[+tr.dataset.i]?.on(); };
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  tab = b.dataset.tab; document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  $('#table').classList.remove('collapsed'); $('#table-toggle').textContent = '▾'; document.documentElement.style.setProperty('--table-h', '');
  if (tab === 'stops') loadStopBoard(true); renderTable();
});
$('#table-toggle').onclick = () => { const c = $('#table').classList.toggle('collapsed'); $('#table-toggle').textContent = c ? '▴' : '▾'; document.documentElement.style.setProperty('--table-h', c ? '44px' : ''); };
if (innerWidth < 760) { $('#table').classList.add('collapsed'); $('#table-toggle').textContent = '▴'; }

// search
function searchItems(q) {
  q = q.trim().toLowerCase(); if (!q) return [];
  const out = [];
  for (const r of STATIC.routes) if (r.short === q || ('route ' + r.short) === q || r.long.toLowerCase().includes(q) || ('route ' + r.short).startsWith(q)) out.push({ t: 'route', id: r.id, html: `${routeChip(r.id)} ${esc(r.long)}<small>Route</small>`, rank: r.short === q || ('route ' + r.short) === q ? 0 : 2 });
  for (const rec of buses.values()) { const b = rec.data; if (b.label.includes(q) || ('bus ' + b.label).startsWith(q)) out.push({ t: 'bus', id: b.id, html: `<b>Bus ${esc(b.label)}</b> ${routeChip(b.routeId)}<small>${esc(b.headsign)}</small>`, rank: b.label === q ? 0 : 1 }); }
  for (const s of STOPS) if (s.name.toLowerCase().includes(q) || s.id === q) out.push({ t: 'stop', id: s.id, html: `${esc(s.name)}<small>${s.hub ? 'Hub' : 'Stop #' + esc(s.id)}</small>`, rank: s.id === q ? 0 : 3 });
  return out.sort((a, b) => a.rank - b.rank).slice(0, 9);
}
let searchSel = [];
$('#search').addEventListener('input', () => {
  searchSel = searchItems($('#search').value);
  const box = $('#search-results');
  box.innerHTML = searchSel.map((s, i) => `<button data-i="${i}" class="${i ? '' : 'active'}">${s.html}</button>`).join('') || '<button disabled class="na">No matches</button>';
  box.hidden = !$('#search').value.trim();
  if (tab === 'stops') renderTable();
});
$('#search').addEventListener('keydown', e => { if (e.key === 'Enter' && searchSel[0]) { const s = searchSel[0]; select(s.t, s.id); closeMenus(); $('#search').blur(); } if (e.key === 'Escape') closeMenus(); });
$('#search-results').addEventListener('click', e => { const b = e.target.closest('button[data-i]'); if (!b) return; const s = searchSel[+b.dataset.i]; select(s.t, s.id); closeMenus(); });

// ============================================================ build world
resize();
let osm = await fetch('data/osm.json').then(r => r.json()).catch(() => ({ roads: [], missing: true }));
buildOsm(osm);
buildRoutes(!!(osm.roads && osm.roads.length));
buildBridges();
buildStops();
buildCity();
buildClouds();
controls.target.set(0, 0, 400);
camera.position.add(controls.target);
controls.update();
setSeason('summer');
updateNightTarget();
document.body.classList.add('no-detail');
if (PREVIEW) { $('#demo-btn').hidden = true; loadStopBoard(true); }
if (osm.missing) console.log('[rideline] OpenStreetMap layer not downloaded yet; reload the page after the server finishes downloading it.');

poll(); setInterval(poll, POLL_MS);
setInterval(() => { updateNightTarget(); if (tab === 'stops' || selected?.type === 'stop') loadStopBoard(); }, 30000);
setInterval(() => { $('#clock').textContent = new Date().toLocaleTimeString('en-CA', { timeZone: TZ, hour12: false }); renderStatus(); }, 1000);
$('#clock').textContent = new Date().toLocaleTimeString('en-CA', { timeZone: TZ, hour12: false });

// ============================================================ adaptive quality
// If frames run slower than ~40 fps for 2 s, step quality down: pixel ratio, then shadows, then trees and glass blur.
let qLevel = LITE ? 2 : 0, qFrames = [], qSince = 0;
function setQuality(level) {
  qLevel = level;
  if (level >= 1) renderer.setPixelRatio(1);
  if (level >= 2) { renderer.shadowMap.enabled = false; sun.castShadow = false; scene.traverse(o => { if (o.material) [].concat(o.material).forEach(m => m.needsUpdate = true); }); }
  if (level >= 3) { if (treeCrowns) treeCrowns.visible = treeTrunks.visible = false; document.body.classList.add('no-blur'); }
  renderer.setSize(innerWidth, innerHeight);
}
function adaptQuality(dt) {
  if (qLevel >= 3 || document.hidden || dt <= 0 || dt >= 1) return;
  qFrames.push(dt); if (qFrames.length > 120) qFrames.shift();
  qSince += dt;
  if (qSince < 2.5 || qFrames.length < 60) return;
  const sorted = [...qFrames].sort((a, b) => a - b), median = sorted[sorted.length >> 1];
  if (median > 1 / 40) { setQuality(qLevel + 1); qFrames = []; qSince = 0; toast('Lowered graphics quality for smoother motion'); }
}
if (LITE) setQuality(2);

// ============================================================ frame loop
const clock = new THREE.Clock();
const v3 = new THREE.Vector3();
let shadowKey = '';
// While the detail panel is open, shift the picture so the point being looked at sits in the middle of the map area
// that's still visible: left of the side panel on desktop, above the bottom sheet on phones.
const viewOff = { x: 0, y: 0 };
function updateViewOffset(rawDt) {
  let wx = 0, wy = 0;
  if (!document.body.classList.contains('no-detail')) {
    if (innerWidth > 760) wx = ($('#detail').offsetWidth + 12) / 2;
    else wy = innerHeight / 2 - ($('#topbar').getBoundingClientRect().bottom + $('#detail').getBoundingClientRect().top) / 2;
  }
  const k = Math.min(1, rawDt * 6);
  viewOff.x = Math.abs(wx - viewOff.x) < .5 ? wx : lerp(viewOff.x, wx, k);
  viewOff.y = Math.abs(wy - viewOff.y) < .5 ? wy : lerp(viewOff.y, wy, k);
  if (viewOff.x || viewOff.y) camera.setViewOffset(innerWidth, innerHeight, viewOff.x, viewOff.y, innerWidth, innerHeight);
  else if (camera.view?.enabled) camera.clearViewOffset();
}
function frame() {
  const rawDt = Math.min(1, clock.getDelta()), dt = Math.min(.1, rawDt), t = clock.elapsedTime;
  const nowS = Date.now() / 1000;

  updateViewOffset(rawDt);
  // camera glide / follow
  if (glide) {
    const k = clamp((performance.now() - glide.t0) / glide.dur, 0, 1), e = k < .5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    const tgt = glide.from.clone().lerp(glide.to, e), delta = tgt.sub(controls.target);
    controls.target.add(delta); camera.position.add(delta);
    camera.zoom = Math.exp(lerp(Math.log(glide.z0), Math.log(glide.z1), e)); camera.updateProjectionMatrix();
    if (glide.s1) {
      const s = new THREE.Spherical(CAM_DIST, lerp(glide.s0.phi, glide.s1.phi, e), angLerp(glide.s0.theta, glide.s1.theta, e));
      camera.position.setFromSpherical(s).add(controls.target);
    }
    if (k >= 1) glide = null;
  } else if (follow && selected?.type === 'bus') {
    const r = buses.get(selected.id);
    if (r) { v3.set(r.pos.x, 0, r.pos.z).sub(controls.target).multiplyScalar(Math.min(1, dt * 3)); controls.target.add(v3); camera.position.add(v3); }
  } else if (meFollow && me) {
    v3.set(me.x, 0, me.z).sub(controls.target).multiplyScalar(Math.min(1, dt * 3)); controls.target.add(v3); camera.position.add(v3);
  }
  controls.update();

  const ppm = renderer.domElement.clientHeight / (2 * H0 / camera.zoom);   // pixels per metre
  const busScale = Math.max(1.4, 30 / (12 * ppm));

  // day/night
  night = lerp(night, nightTarget, Math.min(1, rawDt * 1.5));
  document.body.classList.toggle('night', night > .5);
  const snowy = season === 'winter' || season === 'blizzard';
  scene.background.copy(snowy ? SNOW_BG : DAY_BG).lerp(NIGHT_BG, night);
  hemi.intensity = lerp(1.45, .28, night); hemi.color.set(night > .5 ? '#9DB0D8' : '#FFF6E8');
  sun.intensity = lerp(2.3, .35, night) * (season === 'blizzard' ? .55 : 1); sun.color.set(night > .5 ? '#AFC3FF' : '#FFF1D6');
  M.wall.emissiveIntensity = night * 1.1;
  M_LAMP.emissiveIntensity = night * 3; M_GLOW.opacity = night * .9;
  waterUniforms.uNight.value = night; waterUniforms.uTime.value = t;

  // sun + shadow camera follow the view
  const span = H0 / camera.zoom * 1.6;
  sun.target.position.copy(controls.target);
  sun.position.copy(controls.target).add(v3.set(-0.45, 1, 0.35).normalize().multiplyScalar(Math.max(4000, span * 2)));
  const key = Math.round(span / 50);
  if (key !== shadowKey) { shadowKey = key; const c = sun.shadow.camera; c.left = -span; c.right = span; c.top = span; c.bottom = -span; c.near = 10; c.far = Math.max(8000, span * 5); c.updateProjectionMatrix(); }

  // lines: world width with a pixel minimum
  for (const L of [...roadLayers, ...routeBase]) L.mat.linewidth = clamp(L.ww * ppm, L.min, 60);
  for (const { mat } of routeLines.values()) mat.linewidth = clamp(3.5 * ppm, 2.2, 6) * (mat.userData.boost || 1);
  scaleStops();

  // buses
  const rt = nowS - RENDER_DELAY;
  const offline = payload?.status === 'offline';
  for (const rec of [...buses.values()]) {
    rec.opacity = lerp(rec.opacity, rec.target, Math.min(1, rawDt * 2.5));
    if (rec.target === 0 && rec.opacity < .02) { if (selected?.type === 'bus' && selected.id === rec.id) select(null); removeBus(rec); continue; }
    const p = busPosition(rec, demo ? rt + RENDER_DELAY - POLL_MS / 1000 - 0.5 : rt);
    if (!p) continue;
    if (p.h !== null) rec.heading = angLerp(rec.heading, p.h, Math.min(1, dt * 6));
    else if (rec.samples.length === 1 && rec.data.bearing !== null) rec.heading = Math.PI / 2 - THREE.MathUtils.degToRad(rec.data.bearing);
    rec.pos.set(p.x, deckY(p.x, p.z) + .2, p.z);
    rec.group.position.copy(rec.pos);
    rec.group.rotation.y = rec.heading;
    rec.group.scale.setScalar(busScale);
    rec.bodyMat.color.copy(rec.color); if (offline) rec.bodyMat.color.lerp(GREY, .7);
    for (const m of rec.fadeMats) m.opacity = rec.opacity * (offline ? .6 : 1);
    const late = rec.data.delay !== null && rec.data.delay > LATE_SEC;
    rec.pin.visible = late && rec.opacity > .5;
    if (late) { rec.pin.position.y = 6 + Math.sin(t * 3 + rec.pos.x) * .6; rec.pin.rotation.y = -rec.heading; }
  }

  // selection ring + label
  const sp = selectedXZ();
  if (sp) {
    const isBus = selected.type === 'bus';
    const y = isBus ? buses.get(selected.id)?.pos.y ?? 0 : selected.type === 'stop' ? 1.2 : 0;
    const base = isBus ? 13 * busScale : selected.type === 'stop' ? Math.max(14, 9 / ppm) : 0;
    selRing.visible = selected.type !== 'route';
    selRing.position.set(sp[0], y + .6, sp[1]);
    const pulse = 1 + (t * .9 % 1) * .7; selRing.scale.setScalar(base * pulse); selRing.material.opacity = .95 * (1 - (t * .9 % 1));
    v3.set(sp[0], y + (isBus ? 9 * busScale : selected.type === 'stop' ? Math.max(10, 12 / ppm) : 0), sp[1]).project(camera);
    selLabel.hidden = v3.z > 1;
    selLabel.style.left = (v3.x + 1) / 2 * innerWidth + 'px'; selLabel.style.top = (1 - v3.y) / 2 * innerHeight + 'px';
    const r = isBus && buses.get(selected.id);
    selLabel.textContent = isBus ? (r ? `Bus ${r.data.label} · Route ${r.data.routeShort}` : '') : selected.type === 'stop' ? STOP_BY_ID.get(selected.id)?.name : `Route ${ROUTES.get(selected.id)?.short}`;
  } else { selRing.visible = false; selLabel.hidden = true; }
  if (me) {
    v3.set(me.x, 1, me.z).project(camera);
    meDot.style.left = (v3.x + 1) / 2 * innerWidth + 'px'; meDot.style.top = (1 - v3.y) / 2 * innerHeight + 'px';
  }
  updateStopLabels();
  for (const h of hubLabels) {
    v3.set(h.x, 30, h.z).project(camera);
    h.el.style.left = (v3.x + 1) / 2 * innerWidth + 'px'; h.el.style.top = (1 - v3.y) / 2 * innerHeight + 'px';
  }

  // clouds & snow
  for (const c of clouds) { c.position.x += c.userData.v * dt * 6; if (c.position.x > controls.target.x + 14000) c.position.x = controls.target.x - 14000; c.visible = season !== 'blizzard'; }
  if (snow.visible) {
    const W = H0 / camera.zoom * 3.2, Hh = Math.max(600, W * .5), fall = (season === 'blizzard' ? 2.2 : 0.8) * Hh * .12;
    snow.position.set(controls.target.x, 0, controls.target.z); snow.scale.set(W, Hh, W);
    const wind = season === 'blizzard' ? .06 : .012;
    for (let i = 0; i < SNOW_N; i++) {
      snowPos[i * 3 + 1] -= dt * fall / Hh * (.6 + snowSeed[i] * .8);
      snowPos[i * 3] += dt * wind * (.5 + snowSeed[i]);
      if (snowPos[i * 3 + 1] < 0) snowPos[i * 3 + 1] += 1;
      if (snowPos[i * 3] > .5) snowPos[i * 3] -= 1;
    }
    snowGeo.attributes.position.needsUpdate = true;
  }

  renderer.render(scene, camera);
  adaptQuality(rawDt);
  requestAnimationFrame(frame);
}
frame();
window.__rideline = { buses, STATIC, camera, controls, select, setSeason, renderer, scene, flyTo, frame };
