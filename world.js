// The 3D world: a strawberry-matcha cake floating in the deck's pink and green glow, with one pastry
// building per place. Everything is built from primitives at load, so there are no model files.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { SCHEDULE, upcoming } from './site.js';

const PAL = {
  ink: '#3F5A2A', body: '#4D5845', accent: '#A8487A', green: '#D9E8AD', pink: '#F2C1D6',
  cream: '#FFFBF5', card: '#FFFEFB', sand: '#F4ECDD', pinkwash: '#FBE6EF', leaf: '#9CB57B', wash: '#EEF4DA',
  // Pastry tones, kept in the same soft range as the deck palette
  sponge: '#F3DDB3', crust: '#E2B57A', dough: '#EBC690', berry: '#E7879F', matcha: '#C3D98F',
  custard: '#FFF2D6', glaze: '#F5B8CE', mochi: '#CFE3A0',
};
const TAU = Math.PI * 2;
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Layout. Units are about a meter; y is up. The plaza (a fruit tart) sits in the middle.
const ISLAND_R = 36;
const WALK_R = 32.5;
const PLAYER_R = 0.75;
const PLAZA = { x: 0, z: 5, r: 6.2, top: 0.34 };
const SPAWN = { x: 0, z: 9.4 };
const PLACES = {
  about: { name: 'About', x: 0, z: -12 },
  meetings: { name: 'Meetings', x: -19, z: -1 },
  argue: { name: 'Argue', x: 19, z: -1 },
  build: { name: 'Build', x: -14, z: 17 },
  join: { name: 'Join', x: 14, z: 17 },
};
// The macaron tower: one macaron per meeting in site.js SCHEDULE, oldest at the bottom
const TOWER_COLORS = ['#D9E8AD', '#F2C1D6', '#C9DC9C', '#EFB3C8'];
const TOWER = SCHEDULE.meetings.map((m, i, all) => ({
  ...m,
  label: new Date(`${m.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
  color: i === all.length - 1 ? '#FBE6EF' : TOWER_COLORS[i % TOWER_COLORS.length],
}));

let renderer, maxAniso = 4;
const colliders = []; // { x, z, r }
const hotspots = []; // meshes the pointer can hit
const ticks = []; // per-frame animations: fn(t, dt)
const stones = []; // the 0 to 5 vote stones: { k, x, z, mesh }

/* ---------- small helpers ---------- */

const matCache = new Map();
function M(color, opts = {}) {
  const key = String(color) + JSON.stringify(opts, (k, v) => (v?.isTexture ? v.uuid : v));
  if (!matCache.has(key)) matCache.set(key, new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...opts }));
  return matCache.get(key);
}

function add(parent, geo, mat, { p, r, s, shadow = true } = {}) {
  const m = new THREE.Mesh(geo, mat);
  if (p) m.position.set(...p);
  if (r) m.rotation.set(...r);
  if (s != null) typeof s === 'number' ? m.scale.setScalar(s) : m.scale.set(...s);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

function shade(hex, k) {
  return '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();
}

function canvasTex(w, h, draw, repeat) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = maxAniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

function wrapLines(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const toPlaza = (c) => { const dx = PLAZA.x - c.x, dz = PLAZA.z - c.z, l = Math.hypot(dx, dz); return { x: dx / l, z: dz / l }; };
// For a place's group turned to face the plaza: local +z points at the plaza, local +x is the viewer's right.
const facing = (c) => { const d = toPlaza(c); return Math.atan2(d.x, d.z); };
function local(c, lx, lz) {
  const d = toPlaza(c);
  return { x: c.x + d.z * lx + d.x * lz, z: c.z - d.x * lx + d.z * lz };
}
function placeGroup(scene, c) {
  const g = new THREE.Group();
  g.position.set(c.x, 0, c.z);
  g.rotation.y = facing(c);
  scene.add(g);
  return g;
}

/* ---------- shared shapes ---------- */

const G = {};
function makeShapes() {
  G.sphere = new THREE.SphereGeometry(1, 24, 16);
  G.ball = new THREE.SphereGeometry(1, 14, 10);
  G.dome = new THREE.SphereGeometry(1, 30, 8, 0, TAU, 0, Math.PI / 2);
  G.cyl = new THREE.CylinderGeometry(1, 1, 1, 40);
  G.cylLo = new THREE.CylinderGeometry(1, 1, 1, 12);
  G.capsule = new THREE.CapsuleGeometry(0.5, 1, 3, 8);
  G.sprinkle = new THREE.CylinderGeometry(0.5, 0.5, 1.6, 5);
  G.ring = new THREE.TorusGeometry(1, 0.085, 6, 36).rotateX(Math.PI / 2);
  G.circle = new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2);
  // A piped meringue kiss: the lathe's few sides read as piping ridges
  G.kiss = new THREE.LatheGeometry(
    [[0, 0], [0.78, 0], [0.86, 0.12], [0.8, 0.32], [0.66, 0.5], [0.5, 0.68], [0.33, 0.86], [0.18, 1.02], [0.07, 1.16], [0, 1.24]]
      .map(([x, y]) => new THREE.Vector2(x, y)), 12);
  G.berry = new THREE.LatheGeometry(
    [[0, 0], [0.18, 0.06], [0.36, 0.22], [0.5, 0.46], [0.55, 0.7], [0.5, 0.9], [0.36, 1.02], [0.16, 1.08], [0, 1.1]]
      .map(([x, y]) => new THREE.Vector2(x, y)), 24);
  G.calyx = new THREE.ConeGeometry(0.46, 0.16, 6);
}

const T = {};
function makeTextures() {
  T.seeds = canvasTex(128, 128, (x, w, h) => {
    x.fillStyle = PAL.berry; x.fillRect(0, 0, w, h);
    x.fillStyle = '#FFE9C2';
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      x.beginPath(); x.ellipse(c * 16 + (r % 2) * 8 + 4, r * 16 + 8, 1.6, 3, 0, 0, TAU); x.fill();
    }
  }, [3, 2]);
  T.stripes = canvasTex(256, 32, (x, w, h) => {
    for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? PAL.cream : PAL.pink; x.fillRect(i * w / 8, 0, w / 8, h); }
  });
  T.waffle = canvasTex(128, 128, (x, w, h) => {
    x.fillStyle = '#E9C38C'; x.fillRect(0, 0, w, h);
    x.strokeStyle = 'rgba(160,110,60,.35)'; x.lineWidth = 6;
    for (let i = -w; i < w * 2; i += 32) {
      x.beginPath(); x.moveTo(i, 0); x.lineTo(i + h, h); x.stroke();
      x.beginPath(); x.moveTo(i, h); x.lineTo(i + h, 0); x.stroke();
    }
  }, [3, 1]);
  T.kiwi = canvasTex(256, 256, (x, w) => {
    const c = w / 2;
    x.fillStyle = '#B5CF78'; x.beginPath(); x.arc(c, c, c, 0, TAU); x.fill();
    x.fillStyle = '#C9DD92'; x.beginPath(); x.arc(c, c, c * 0.8, 0, TAU); x.fill();
    x.fillStyle = '#F4F7E6'; x.beginPath(); x.ellipse(c, c, c * 0.24, c * 0.16, 0.4, 0, TAU); x.fill();
    x.fillStyle = PAL.ink;
    for (let i = 0; i < 18; i++) { const a = i / 18 * TAU; x.beginPath(); x.ellipse(c + Math.cos(a) * c * 0.38, c + Math.sin(a) * c * 0.38, 4, 7, a, 0, TAU); x.fill(); }
  });
  T.slice = canvasTex(256, 256, (x, w) => {
    const c = w / 2;
    x.fillStyle = '#EE8FA9'; x.beginPath(); x.arc(c, c, c, 0, TAU); x.fill();
    x.fillStyle = '#F6B7C8'; x.beginPath(); x.arc(c, c, c * 0.78, 0, TAU); x.fill();
    x.fillStyle = '#FCE3EA'; x.beginPath(); x.ellipse(c, c * 1.05, c * 0.34, c * 0.46, 0, 0, TAU); x.fill();
  });
}

function strawberry(parent, p, s = 1, tilt = 0) {
  const g = new THREE.Group();
  g.position.set(...p);
  g.scale.setScalar(s);
  g.rotation.z = tilt;
  add(g, G.berry, M('#ffffff', { map: T.seeds, roughness: 0.55 }));
  add(g, G.calyx, M(PAL.leaf), { p: [0, 1.1, 0] });
  add(g, G.cylLo, M(shade(PAL.leaf, 0.8)), { p: [0, 1.24, 0], s: [0.05, 0.22, 0.05] });
  parent.add(g);
  return g;
}

// A macaron with its base at y=0. r is the radius; h squashes it for stepping stones.
function macaron(parent, color, r = 1, h = 1, p = [0, 0, 0]) {
  const g = new THREE.Group();
  g.position.set(...p);
  const shell = M(color, { roughness: 0.7 });
  const foot = M(shade(color, 0.9), { roughness: 0.95 });
  add(g, G.dome, shell, { p: [0, 0.28 * r * h, 0], r: [Math.PI, 0, 0], s: [r, 0.28 * r * h, r] });
  add(g, G.ring, foot, { p: [0, 0.31 * r * h, 0], s: [r * 0.95, r * h, r * 0.95] });
  add(g, G.cyl, M(PAL.cream), { p: [0, 0.41 * r * h, 0], s: [r * 0.88, 0.2 * r * h, r * 0.88] });
  add(g, G.ring, foot, { p: [0, 0.51 * r * h, 0], s: [r * 0.95, r * h, r * 0.95] });
  add(g, G.dome, shell, { p: [0, 0.53 * r * h, 0], s: [r, 0.33 * r * h, r] });
  parent.add(g);
  return g;
}

/* ---------- the island ---------- */

function groundTexture() {
  const S = 2048;
  const px = (v) => (v / ISLAND_R + 1) / 2 * S;
  return canvasTex(S, S, (x) => {
    x.fillStyle = PAL.cream; x.fillRect(0, 0, S, S);
    const wash = (wx, wz, r, rgb, a) => {
      const g = x.createRadialGradient(px(wx), px(wz), 0, px(wx), px(wz), r / ISLAND_R * S / 2);
      g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
      x.fillStyle = g; x.fillRect(0, 0, S, S);
    };
    const G_ = '217,232,173', P_ = '242,193,214';
    wash(-26, 20, 22, G_, 0.75); wash(24, -22, 20, P_, 0.6); wash(-22, -20, 16, G_, 0.55); wash(26, 22, 16, P_, 0.5);
    wash(0, 30, 14, G_, 0.5); wash(4, -30, 12, G_, 0.45);
    for (const [id, c] of Object.entries(PLACES)) wash(c.x, c.z, 11, ['about', 'argue', 'join'].includes(id) ? P_ : G_, 0.55);
    // Sand paths from the plaza out to each place
    x.lineCap = 'round';
    for (const c of Object.values(PLACES)) {
      const d = toPlaza(c);
      const a = { x: PLAZA.x - d.x * (PLAZA.r - 1), z: PLAZA.z - d.z * (PLAZA.r - 1) };
      const b = { x: c.x + d.x * 5, z: c.z + d.z * 5 };
      const m = { x: (a.x + b.x) / 2 + d.z * 1.6, z: (a.z + b.z) / 2 - d.x * 1.6 };
      x.strokeStyle = 'rgba(236,222,196,.9)'; x.lineWidth = 2.8 / ISLAND_R * S / 2;
      x.beginPath(); x.moveTo(px(a.x), px(a.z)); x.quadraticCurveTo(px(m.x), px(m.z), px(b.x), px(b.z)); x.stroke();
      c.path = { a, m, b };
    }
    // The decks' dot grid
    x.fillStyle = 'rgba(63,90,42,.11)';
    for (let i = 14; i < S; i += 30) for (let j = 14; j < S; j += 30) { x.beginPath(); x.arc(i, j, 2.4, 0, TAU); x.fill(); }
  });
}

function buildIsland(scene) {
  const g = new THREE.Group();
  scene.add(g);
  const layers = [[0.9, PAL.cream, ISLAND_R], [2.6, PAL.sponge, ISLAND_R - 0.2], [0.55, PAL.pink, ISLAND_R - 0.1], [2.6, PAL.sponge, ISLAND_R - 0.2], [0.8, PAL.cream, ISLAND_R - 0.05]];
  let y = 0;
  for (const [h, color, r] of layers) {
    add(g, new THREE.CylinderGeometry(r, r * 0.995, h, 120), M(color), { p: [0, y - h / 2, 0], shadow: false });
    y -= h;
  }
  add(g, new THREE.CircleGeometry(ISLAND_R, 120).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.92 }), { p: [0, 0.012, 0], shadow: false });

  // Cream drips down the side
  const drips = new THREE.InstancedMesh(G.capsule, M(PAL.cream), 110);
  const o = new THREE.Object3D();
  for (let i = 0; i < drips.count; i++) {
    const a = i / drips.count * TAU + Math.random() * 0.03;
    const len = 0.8 + Math.random() ** 1.6 * 3.2;
    o.position.set(Math.sin(a) * (ISLAND_R - 0.05), -len / 2 + 0.1, Math.cos(a) * (ISLAND_R - 0.05));
    o.rotation.set(0, a, 0);
    o.scale.set(0.75 + Math.random() * 0.4, len / 2, 0.55);
    o.updateMatrix();
    drips.setMatrixAt(i, o.matrix);
  }
  drips.receiveShadow = true;
  g.add(drips);

  // Piped meringue kisses around the rim, a strawberry on every sixth
  const N = 96;
  const kisses = new THREE.InstancedMesh(G.kiss, M('#ffffff', { roughness: 0.75 }), N);
  for (let i = 0; i < N; i++) {
    const a = i / N * TAU;
    const s = 0.95 + (i % 2) * 0.12;
    o.position.set(Math.sin(a) * (ISLAND_R - 0.9), 0, Math.cos(a) * (ISLAND_R - 0.9));
    o.rotation.set(0, a * 3, 0);
    o.scale.set(s, s, s);
    o.updateMatrix();
    kisses.setMatrixAt(i, o.matrix);
    kisses.setColorAt(i, new THREE.Color(i % 2 ? PAL.pinkwash : PAL.cream));
    if (i % 6 === 3) strawberry(g, [o.position.x, 1.05 * s, o.position.z], 0.95, (Math.random() - 0.5) * 0.4);
  }
  kisses.castShadow = kisses.receiveShadow = true;
  g.add(kisses);

  // Path sprinkles: raised dots down the middle of each path
  const dots = [];
  for (const c of Object.values(PLACES)) {
    const { a, m, b } = c.path;
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.floor(len / 1.25);
    for (let i = 1; i < n; i++) {
      const t = i / n, u = 1 - t;
      dots.push([u * u * a.x + 2 * u * t * m.x + t * t * b.x, u * u * a.z + 2 * u * t * m.z + t * t * b.z, i % 2]);
    }
  }
  const dotMesh = new THREE.InstancedMesh(G.ball, M('#ffffff'), dots.length);
  dots.forEach(([dx, dz, k], i) => {
    o.position.set(dx, 0.02, dz); o.rotation.set(0, 0, 0); o.scale.set(0.2, 0.09, 0.2); o.updateMatrix();
    dotMesh.setMatrixAt(i, o.matrix);
    dotMesh.setColorAt(i, new THREE.Color(k ? PAL.pink : PAL.matcha));
  });
  dotMesh.receiveShadow = true;
  g.add(dotMesh);

  // Sprinkles lying on the frosting, kept off the places and the plaza
  const sprinkleColors = [PAL.pink, PAL.green, '#F7D9A8', PAL.leaf, '#E9A3BC', PAL.cream];
  const sprinkles = new THREE.InstancedMesh(G.sprinkle, M("#ffffff", { roughness: 0.5 }), 340);
  let placed = 0;
  for (let tries = 0; placed < sprinkles.count && tries < 6000; tries++) {
    const a = Math.random() * TAU, r = Math.sqrt(Math.random()) * (ISLAND_R - 2.5);
    const sx = Math.sin(a) * r, sz = Math.cos(a) * r;
    if (Math.hypot(sx - PLAZA.x, sz - PLAZA.z) < PLAZA.r + 1.5) continue;
    if (Object.values(PLACES).some((c) => Math.hypot(sx - c.x, sz - c.z) < 7.5)) continue;
    o.position.set(sx, 0.07, sz); o.rotation.set(Math.PI / 2, 0, Math.random() * TAU); o.scale.set(0.11, 0.15, 0.11); o.updateMatrix();
    sprinkles.setMatrixAt(placed, o.matrix);
    sprinkles.setColorAt(placed, new THREE.Color(sprinkleColors[placed % sprinkleColors.length]));
    placed++;
  }
  sprinkles.count = placed;
  sprinkles.receiveShadow = true;
  g.add(sprinkles);
}

/* ---------- the plaza: a fruit tart with a signpost ---------- */

function arrowGeo(w, h, tip) {
  const s = new THREE.Shape();
  const r = 0.14;
  s.moveTo(-w / 2 + r, -h / 2);
  s.lineTo(w / 2 - tip, -h / 2);
  s.lineTo(w / 2, 0);
  s.lineTo(w / 2 - tip, h / 2);
  s.lineTo(-w / 2 + r, h / 2);
  s.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
  s.lineTo(-w / 2, -h / 2 + r);
  s.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.14, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 3, curveSegments: 6 });
  geo.translate(0, 0, -0.07);
  return geo;
}

function buildPlaza(scene) {
  const g = new THREE.Group();
  g.position.set(PLAZA.x, 0, PLAZA.z);
  scene.add(g);
  add(g, G.cyl, M(PAL.crust), { p: [0, 0.16, 0], s: [PLAZA.r, 0.32, PLAZA.r] });
  const flutes = new THREE.InstancedMesh(G.ball, M(PAL.crust), 44);
  const o = new THREE.Object3D();
  for (let i = 0; i < 44; i++) {
    const a = i / 44 * TAU;
    o.position.set(Math.sin(a) * (PLAZA.r - 0.1), 0.26, Math.cos(a) * (PLAZA.r - 0.1));
    o.scale.set(0.42, 0.3, 0.42); o.updateMatrix(); flutes.setMatrixAt(i, o.matrix);
  }
  flutes.castShadow = flutes.receiveShadow = true;
  g.add(flutes);
  add(g, G.cyl, M(PAL.custard), { p: [0, 0.33, 0], s: [PLAZA.r - 0.45, 0.02, PLAZA.r - 0.45], shadow: false });
  // Flat fruit slices in two rings, so the middle stays walkable
  for (const [ring, n, s] of [[4.75, 16, 0.62], [3.2, 11, 0.5]]) {
    for (let i = 0; i < n; i++) {
      const a = i / n * TAU + ring;
      add(g, G.circle, M('#ffffff', { map: i % 2 ? T.kiwi : T.slice, roughness: 0.45 }),
        { p: [Math.sin(a) * ring, 0.345 + (i % 2) * 0.004, Math.cos(a) * ring], r: [0, a, 0], s: [s, 1, s], shadow: false });
    }
  }

  // Signpost: a pretzel-stick post with cookie arrows pointing at each place
  add(g, G.cylLo, M(PAL.crust), { p: [0, 3.2, 0], s: [0.2, 5.8, 0.2] });
  strawberry(g, [0, 6.05, 0], 0.8);
  colliders.push({ x: PLAZA.x, z: PLAZA.z, r: 0.5 });
  const ids = Object.keys(PLACES);
  ids.forEach((id, i) => {
    const c = PLACES[id];
    const dx = c.x - PLAZA.x, dz = c.z - PLAZA.z;
    const arm = new THREE.Group();
    arm.position.y = 1.9 + i * 0.78;
    arm.rotation.y = Math.atan2(-dz, dx);
    g.add(arm);
    const w = 2.7, h = 0.62, tip = 0.4;
    const board = add(arm, arrowGeo(w, h, tip), M(i % 2 ? '#F2D3A6' : '#F7DFC0', { roughness: 0.9 }), { p: [w / 2 - 0.05, 0, 0] });
    board.userData.place = id;
    hotspots.push(board);
    const tex = canvasTex(512, 128, (x, cw, ch) => {
      x.fillStyle = PAL.ink; x.font = '600 74px Fraunces'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(c.name, cw / 2 - 20, ch / 2 + 4);
    });
    const label = new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false });
    const plane = new THREE.PlaneGeometry(2.3, 0.575);
    add(arm, plane, label, { p: [w / 2 - 0.25, 0, 0.135], shadow: false });
    add(arm, plane, label, { p: [w / 2 - 0.25, 0, -0.135], r: [0, Math.PI, 0], shadow: false });
  });
}

/* ---------- the places ---------- */

function buildCafe(scene) {
  const c = PLACES.about;
  const g = placeGroup(scene, c);
  const R = 6;
  let y = 0;
  for (const [h, color, r] of [[2.1, PAL.sponge, R], [0.45, PAL.cream, R + 0.06], [0.28, PAL.berry, R + 0.03], [1.85, PAL.sponge, R], [0.7, PAL.cream, R + 0.18]]) {
    add(g, G.cyl, M(color), { p: [0, y + h / 2, 0], s: [r, h, r] });
    y += h;
  }
  const top = y;
  for (let i = 0; i < 14; i++) {
    const a = i / 14 * TAU + 0.11;
    const k = add(g, G.kiss, M(i % 2 ? PAL.pinkwash : PAL.cream), { p: [Math.sin(a) * (R - 0.55), top - 0.05, Math.cos(a) * (R - 0.55)], r: [0, a, 0], s: 0.9 });
    if (i % 2 === 0 && Math.abs(Math.sin(a / 2)) > 0.25) strawberry(g, [k.position.x, top + 1.0, k.position.z], 0.85, Math.sin(a) * 0.3);
  }
  strawberry(g, [-0.6, top - 0.1, -0.8], 2.7, 0.14);
  // A candle, slightly off-center
  add(g, G.cylLo, M(PAL.pink), { p: [2.3, top + 0.8, -1.6], s: [0.2, 1.6, 0.2] });
  add(g, G.cylLo, M(PAL.body), { p: [2.3, top + 1.68, -1.6], s: [0.03, 0.18, 0.03] });
  const flame = add(g, G.sphere, new THREE.MeshBasicMaterial({ color: '#FFD98A', toneMapped: false }), { p: [2.3, top + 1.95, -1.6], s: [0.15, 0.3, 0.15], shadow: false });
  ticks.push((t) => { flame.scale.y = 0.3 + Math.sin(t * 13) * 0.03 + Math.sin(t * 7.3) * 0.03; flame.rotation.z = Math.sin(t * 5) * 0.08; });

  // Front door, round windows, striped awning
  add(g, new RoundedBoxGeometry(2.3, 3.05, 0.3, 4, 0.12), M(PAL.cream), { p: [0, 1.5, R - 0.02] });
  add(g, new RoundedBoxGeometry(1.75, 2.6, 0.3, 4, 0.1), M(PAL.ink, { roughness: 0.6 }), { p: [0, 1.3, R + 0.08] });
  add(g, G.ball, M(PAL.pink), { p: [0.55, 1.3, R + 0.28], s: 0.12 });
  for (const a of [-0.62, 0.62]) {
    const wx = Math.sin(a) * (R + 0.02), wz = Math.cos(a) * (R + 0.02);
    add(g, new THREE.CircleGeometry(0.62, 32), M('#FFF0CC', { emissive: '#FFD9A0', emissiveIntensity: 0.55 }), { p: [wx, 3.65, wz], r: [0, a, 0], shadow: false });
    add(g, new THREE.TorusGeometry(0.66, 0.12, 10, 32), M(PAL.cream), { p: [wx, 3.65, wz], r: [0, a, 0] });
  }
  add(g, new THREE.PlaneGeometry(2.9, 1.2), M('#ffffff', { map: T.stripes, side: THREE.DoubleSide }), { p: [0, 3.35, R + 0.55], r: [0.95, 0, 0] });
  for (let i = 0; i < 8; i++) add(g, G.ball, M(i % 2 ? PAL.cream : PAL.pink), { p: [-1.3 + i * 0.37, 2.95, R + 0.98], s: 0.19 });

  // Cake topper with the club's name
  const topper = canvasTex(640, 220, (x, w, h) => {
    x.fillStyle = PAL.card; roundRect(x, 6, 6, w - 12, h - 12, 100); x.fill();
    x.strokeStyle = PAL.pink; x.lineWidth = 10; x.stroke();
    x.fillStyle = PAL.ink; x.font = '600 128px Fraunces'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('ExplorAI', w / 2, h / 2 + 8);
  });
  const sign = new THREE.Group();
  sign.position.set(0, top, R - 1.3);
  sign.rotation.x = -0.12;
  g.add(sign);
  add(sign, new RoundedBoxGeometry(3.3, 1.14, 0.12, 4, 0.5), M(PAL.card), { p: [0, 1.9, 0] });
  add(sign, new THREE.PlaneGeometry(3.24, 1.11), new THREE.MeshBasicMaterial({ map: topper, transparent: true, toneMapped: false }), { p: [0, 1.9, 0.07], shadow: false });
  for (const sx of [-1.1, 1.1]) add(sign, G.cylLo, M(PAL.cream), { p: [sx, 0.65, -0.02], s: [0.06, 1.4, 0.06] });

  colliders.push({ x: c.x, z: c.z, r: R + 0.35 });
  g.traverse((m) => { m.userData.place = 'about'; });
  hotspots.push(g);
  return { id: 'about', group: g, focus: { x: c.x, y: 2.5, z: c.z }, zoneAt: local(c, 0, 4), zone: 9.5, stand: local(c, 0, R + 2.6), labelAt: [c.x, top + 4.6, c.z] };
}

function buildMeetings(scene) {
  const c = PLACES.meetings;
  const g = placeGroup(scene, c);
  const ceramic = M('#FFF7F2', { roughness: 0.35 });
  add(g, G.cyl, ceramic, { p: [0, 0.13, 0], s: [1.7, 0.26, 1.7] });
  add(g, G.cyl, ceramic, { p: [0, 1.0, 0], s: [0.38, 1.6, 0.38] });
  add(g, G.cyl, ceramic, { p: [0, 1.88, 0], s: [3.5, 0.22, 3.5] });
  add(g, new THREE.TorusGeometry(3.5, 0.12, 10, 64).rotateX(Math.PI / 2), M(PAL.pink, { roughness: 0.4 }), { p: [0, 1.98, 0] });
  const labels = [];
  const glows = []; // { n, mats }
  let y = 2.0;
  TOWER.forEach((m, i) => {
    const mac = macaron(g, m.color, 2.2, 1, [Math.sin(i * 2.1) * 0.14, y, Math.cos(i * 1.7) * 0.14]);
    mac.rotation.set(Math.sin(i * 3.1) * 0.035, i * 0.9, Math.cos(i * 2.3) * 0.035);
    const mats = [];
    mac.traverse((o) => {
      o.userData.place = 'meetings';
      o.userData.meeting = m.n;
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.emissive = new THREE.Color(PAL.accent);
        o.material.emissiveIntensity = 0;
        mats.push(o.material);
      }
    });
    glows.push({ n: m.n, mats });
    labels.push({ n: m.n, at: local(c, 2.9, 0), y: y + 1, html: `<b>${m.label}</b>${m.title}` });
    y += 1.9;
  });
  // A toothpick flag on the top macaron when it is the next meeting
  const top = TOWER[TOWER.length - 1];
  const flagCanvas = document.createElement('canvas');
  flagCanvas.width = 256;
  flagCanvas.height = 128;
  const flagTex = new THREE.CanvasTexture(flagCanvas);
  flagTex.colorSpace = THREE.SRGBColorSpace;
  const flag = new THREE.Group();
  flag.position.set(0.4, y, 0.3);
  g.add(flag);
  add(flag, G.cylLo, M(PAL.crust), { p: [0, 0.9, 0], s: [0.05, 2.2, 0.05] });
  const cloth = add(flag, new THREE.PlaneGeometry(1.2, 0.6), new THREE.MeshBasicMaterial({ map: flagTex, side: THREE.DoubleSide, toneMapped: false }), { p: [0.63, 1.65, 0], shadow: false });
  let shown = null;
  // site.js refreshes `upcoming` every minute, so the glow and the flag follow it
  ticks.push((t) => {
    const n = upcoming?.n, word = upcoming?.live ? 'Now' : 'Next';
    for (const gl of glows) {
      const k = gl.n === n ? 0.1 + (Math.sin(t * 2.4) + 1) * 0.07 : 0;
      for (const mat of gl.mats) mat.emissiveIntensity = k;
    }
    flag.visible = !!top && n === top.n;
    if (flag.visible && shown !== word) {
      shown = word;
      const x = flagCanvas.getContext('2d');
      x.clearRect(0, 0, 256, 128);
      x.fillStyle = PAL.accent; roundRect(x, 0, 0, 256, 128, 26); x.fill();
      x.fillStyle = PAL.cream; x.font = '600 72px Fraunces'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(word, 128, 68);
      flagTex.needsUpdate = true;
    }
    cloth.rotation.y = Math.sin(t * 1.6) * 0.25;
  });

  colliders.push({ x: c.x, z: c.z, r: 3.7 });
  g.traverse((o) => { if (!o.userData.place) o.userData.place = 'meetings'; });
  hotspots.push(g);
  return { id: 'meetings', group: g, focus: { x: c.x, y: 4.5, z: c.z }, zoneAt: local(c, 0, 3), zone: 9, stand: local(c, 0, 6.4), labelAt: [c.x, y + 3.4, c.z], small: labels };
}

const lerpColor = (a, b, t) => new THREE.Color(a).lerp(new THREE.Color(b), t);
function voteColor(k) {
  const t = k / 5;
  return '#' + (t < 0.5 ? lerpColor('#F2C1D6', '#FBF4EC', t * 2) : lerpColor('#FBF4EC', '#D9E8AD', (t - 0.5) * 2)).getHexString();
}

function buildArgue(scene) {
  const c = PLACES.argue;
  const g = placeGroup(scene, c);
  // Six macaron stepping stones: the decks' 0 to 5 vote bar, laid on the ground
  for (let k = 0; k <= 5; k++) {
    const lx = (k - 2.5) * 2.15, lz = 1.4 + 0.18 * (k - 2.5) ** 2;
    const stone = macaron(g, voteColor(k), 0.95, 0.55, [lx, 0, lz]);
    const tex = canvasTex(256, 256, (x, w, h) => {
      x.fillStyle = k === 0 ? PAL.accent : PAL.ink; x.font = '600 190px Fraunces'; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText(String(k), w / 2, h / 2 + 12);
    });
    add(stone, new THREE.CircleGeometry(0.44, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthWrite: false }), { p: [0, 0.465, 0], shadow: false });
    stone.traverse((o) => { o.userData.place = 'argue'; o.userData.vote = k; });
    hotspots.push(stone);
    const at = local(c, lx, lz);
    stones.push({ k, x: at.x, z: at.z, group: stone });
  }
  // Ground-rule sign beside the stones
  const claim = canvasTex(1024, 680, (x, w, h) => {
    x.fillStyle = PAL.card; roundRect(x, 0, 0, w, h, 60); x.fill();
    x.fillStyle = PAL.accent; x.font = '700 34px "DM Sans"'; x.letterSpacing = '6px'; x.fillText('WHERE DO YOU STAND?', 70, 110); x.letterSpacing = '0px';
    x.fillStyle = PAL.ink; x.font = '600 82px Fraunces';
    wrapLines(x, '“AI is making us worse students.”', w - 140).forEach((line, i) => x.fillText(line, 70, 230 + i * 96));
    x.font = '700 30px "DM Sans"';
    x.fillStyle = PAL.accent; x.fillText('0 · totally disagree', 70, h - 70);
    x.fillStyle = PAL.ink; x.textAlign = 'right'; x.fillText('5 · totally agree', w - 70, h - 70);
  });
  const easel = new THREE.Group();
  easel.position.set(-8.1, 0, -0.4);
  easel.rotation.y = 0.55;
  g.add(easel);
  add(easel, new RoundedBoxGeometry(3.9, 2.6, 0.12, 4, 0.06), M(PAL.pink), { p: [0, 2.6, 0], r: [-0.08, 0, 0] });
  add(easel, new THREE.PlaneGeometry(3.7, 2.46), new THREE.MeshBasicMaterial({ map: claim, toneMapped: false }), { p: [0, 2.6, 0.068], r: [-0.08, 0, 0], shadow: false });
  for (const sx of [-1.4, 1.4]) add(easel, G.cylLo, M(PAL.crust), { p: [sx, 1.3, -0.1], r: [-0.08, 0, 0], s: [0.07, 2.6, 0.07] });
  add(easel, G.cylLo, M(PAL.crust), { p: [0, 1.35, -0.7], r: [0.45, 0, 0], s: [0.06, 2.9, 0.06] });
  colliders.push({ ...local(c, -8.1, -0.4), r: 1.3 });
  easel.traverse((o) => { o.userData.place = 'argue'; });
  hotspots.push(easel);

  // Tea table with two macaron stools
  const table = new THREE.Group();
  table.position.set(0, 0, -3.4);
  g.add(table);
  add(table, G.cyl, M(PAL.card), { p: [0, 2.3, 0], s: [2.2, 0.18, 2.2] });
  add(table, new THREE.TorusGeometry(2.2, 0.1, 8, 48).rotateX(Math.PI / 2), M(PAL.pink), { p: [0, 2.22, 0] });
  add(table, G.cyl, M(PAL.crust), { p: [0, 1.15, 0], s: [0.24, 2.2, 0.24] });
  add(table, G.cyl, M(PAL.crust), { p: [0, 0.08, 0], s: [0.95, 0.16, 0.95] });
  // Teapot
  const pot = new THREE.Group();
  pot.position.set(-0.6, 2.39, -0.2);
  table.add(pot);
  add(pot, G.sphere, M(PAL.pink, { roughness: 0.35 }), { p: [0, 0.62, 0], s: [0.82, 0.66, 0.82] });
  add(pot, G.dome, M(PAL.cream, { roughness: 0.35 }), { p: [0, 1.15, 0], s: [0.42, 0.22, 0.42] });
  add(pot, G.ball, M(PAL.berry), { p: [0, 1.42, 0], s: 0.12 });
  add(pot, G.cylLo, M(PAL.pink, { roughness: 0.35 }), { p: [0.92, 0.82, 0], r: [0, 0, -0.85], s: [0.11, 0.8, 0.11] });
  add(pot, new THREE.TorusGeometry(0.38, 0.07, 8, 20), M(PAL.pink, { roughness: 0.35 }), { p: [-0.82, 0.68, 0] });
  // Cups with matcha, and steam
  const steam = [];
  for (const [cx, cz] of [[0.95, 0.55], [0.55, -1.05]]) {
    add(table, G.cyl, M(PAL.cream), { p: [cx, 2.42, cz], s: [0.6, 0.04, 0.6] });
    add(table, new THREE.CylinderGeometry(0.4, 0.29, 0.45, 24), M(PAL.cream, { roughness: 0.35 }), { p: [cx, 2.66, cz] });
    add(table, G.cyl, M(PAL.matcha), { p: [cx, 2.86, cz], s: [0.36, 0.02, 0.36], shadow: false });
    add(table, new THREE.TorusGeometry(0.14, 0.04, 6, 14), M(PAL.cream), { p: [cx + 0.42, 2.68, cz] });
    for (let i = 0; i < 3; i++) {
      const puff = add(table, G.ball, new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.5, depthWrite: false }), { p: [cx, 3, cz], s: 0.12, shadow: false });
      steam.push({ puff, cx, cz, ph: i / 3 + cx });
    }
  }
  ticks.push((t) => {
    for (const s of steam) {
      const k = (t * 0.35 + s.ph) % 1;
      s.puff.position.set(s.cx + Math.sin(k * 6 + s.ph * 9) * 0.1, 2.95 + k * 1.4, s.cz);
      s.puff.scale.setScalar(0.1 + k * 0.18);
      s.puff.material.opacity = 0.55 * Math.sin(k * Math.PI);
    }
  });
  macaron(table, PAL.pink, 0.9, 1.05, [-2.9, 0, 0.3]);
  macaron(table, PAL.green, 0.9, 1.05, [2.9, 0, 0.3]);
  colliders.push({ ...local(c, 0, -3.4), r: 2.35 }, { ...local(c, -2.9, -3.1), r: 0.95 }, { ...local(c, 2.9, -3.1), r: 0.95 });
  table.traverse((o) => { o.userData.place = 'argue'; });
  hotspots.push(table);

  const lift = (k) => { for (const s of stones) s.group.userData.target = s.k === k ? 0.12 : 0; };
  ticks.push((t, dt) => {
    for (const s of stones) {
      const target = s.group.userData.target || 0;
      s.group.position.y += (target - s.group.position.y) * (1 - Math.exp(-10 * dt));
    }
  });
  const over = local(c, 0, -3.4);
  return { id: 'argue', group: g, focus: { ...local(c, 0, -1), y: 0.5 }, zoneAt: local(c, 0, 1.2), zone: 8.5, stand: local(c, 0, 5.4), labelAt: [over.x, 5.6, over.z], lift };
}

function buildBake(scene) {
  const c = PLACES.build;
  const g = placeGroup(scene, c);
  // A round little oven
  const oven = new THREE.Group();
  g.add(oven);
  add(oven, new RoundedBoxGeometry(4.4, 3.4, 3.2, 5, 0.6), M(PAL.pink, { roughness: 0.55 }), { p: [0, 2.1, 0] });
  for (const [lx, lz] of [[-1.7, -1.2], [1.7, -1.2], [-1.7, 1.2], [1.7, 1.2]]) add(oven, G.cylLo, M(PAL.cream), { p: [lx, 0.22, lz], s: [0.26, 0.44, 0.26] });
  add(oven, new RoundedBoxGeometry(3.2, 1.9, 0.1, 4, 0.2), M(PAL.cream), { p: [0, 1.85, 1.6] });
  const glass = add(oven, new RoundedBoxGeometry(2.8, 1.5, 0.1, 4, 0.18), M('#FFEFD2', { emissive: '#FFC98A', emissiveIntensity: 0.5, roughness: 0.3 }), { p: [0, 1.85, 1.64], shadow: false });
  ticks.push((t) => { glass.material.emissiveIntensity = 0.45 + Math.sin(t * 1.3) * 0.08; });
  add(oven, G.capsule, M(PAL.cream), { p: [0, 2.95, 1.86], r: [0, 0, Math.PI / 2], s: [0.22, 1.6, 0.22] });
  for (const lx of [-1.0, 1.0]) add(oven, G.cylLo, M(PAL.cream), { p: [lx, 2.95, 1.72], r: [Math.PI / 2, 0, 0], s: [0.06, 0.3, 0.06] });
  for (const [i, lx] of [-1.3, 0, 1.3].entries()) add(oven, G.cyl, M(i === 1 ? PAL.matcha : PAL.cream), { p: [lx, 3.42, 1.66], r: [Math.PI / 2, 0, 0], s: [0.2, 0.14, 0.2] });

  // The recipe card from Meetings 3 and 5, taped to a stand on top
  const recipe = canvasTex(768, 1000, (x, w, h) => {
    x.fillStyle = '#FFFDF7'; roundRect(x, 0, 0, w, h, 44); x.fill();
    x.fillStyle = PAL.accent; x.font = '700 30px "DM Sans"'; x.letterSpacing = '6px'; x.fillText('THE RECIPE', 64, 112); x.letterSpacing = '0px';
    const rows = [['Who', 'you, and who uses it'], ['What', '3 features max'], ['Why', 'the problem it solves'], ['How', 'step by step'], ['Looks', 'layout, colors, vibe']];
    rows.forEach(([k, v], i) => {
      const y = 230 + i * 158;
      x.fillStyle = i === 4 ? PAL.accent : PAL.ink; x.font = '600 66px Fraunces'; x.fillText(k, 64, y);
      x.fillStyle = PAL.body; x.font = '500 34px "DM Sans"'; x.fillText(v, 64, y + 52);
      if (i < 4) { x.strokeStyle = 'rgba(242,193,214,.9)'; x.setLineDash([10, 10]); x.lineWidth = 3; x.beginPath(); x.moveTo(64, y + 92); x.lineTo(w - 64, y + 92); x.stroke(); x.setLineDash([]); }
    });
  });
  const card = new THREE.Group();
  card.position.set(0, 3.78, 0.2);
  card.rotation.x = -0.22;
  oven.add(card);
  add(card, new RoundedBoxGeometry(2.55, 3.3, 0.06, 3, 0.03), M('#FFFDF7'), { p: [0, 1.66, 0] });
  add(card, new THREE.PlaneGeometry(2.5, 3.25), new THREE.MeshBasicMaterial({ map: recipe, toneMapped: false }), { p: [0, 1.66, 0.035], shadow: false });
  add(card, new THREE.BoxGeometry(1.0, 0.3, 0.02), new THREE.MeshStandardMaterial({ color: PAL.pink, transparent: true, opacity: 0.85 }), { p: [0, 3.3, 0.05], r: [0, 0, -0.05], shadow: false });
  add(card, G.cylLo, M(PAL.crust), { p: [0, 0.6, -0.5], r: [0.6, 0, 0], s: [0.05, 1.5, 0.05] });

  // Fresh out of the oven: cookies shaped like app windows, cooling on a rack
  const rack = new THREE.Group();
  rack.position.set(4.3, 0, 0.8);
  rack.rotation.y = -0.25;
  g.add(rack);
  const wire = M('#EADFCF', { roughness: 0.4, metalness: 0.3 });
  for (const [lx, lz] of [[-1.05, -0.75], [1.05, -0.75], [-1.05, 0.75], [1.05, 0.75]]) add(rack, G.cylLo, wire, { p: [lx, 0.45, lz], s: [0.05, 0.9, 0.05] });
  for (let i = 0; i < 7; i++) add(rack, G.cylLo, wire, { p: [-1.05 + i * 0.35, 0.9, 0], r: [Math.PI / 2, 0, 0], s: [0.035, 1.55, 0.035] });
  for (const lz of [-0.75, 0.75]) add(rack, G.cylLo, wire, { p: [0, 0.9, lz], r: [0, 0, Math.PI / 2], s: [0.04, 2.1, 0.04] });
  const icing = [PAL.cream, PAL.pinkwash, PAL.wash];
  for (let i = 0; i < 3; i++) {
    const ck = new THREE.Group();
    ck.position.set(-0.7 + i * 0.7, 0.98, (i - 1) * 0.12);
    ck.rotation.y = (i - 1) * 0.2;
    ck.scale.setScalar(0.62);
    rack.add(ck);
    add(ck, new RoundedBoxGeometry(1.25, 0.24, 1.0, 3, 0.1), M(PAL.dough), { p: [0, 0.12, 0] });
    add(ck, new RoundedBoxGeometry(1.1, 0.08, 0.86, 3, 0.04), M(icing[i]), { p: [0, 0.27, 0] });
    add(ck, new THREE.BoxGeometry(1.1, 0.04, 0.18), M(i === 1 ? PAL.green : PAL.pink), { p: [0, 0.31, -0.34] });
    [PAL.accent, PAL.leaf, PAL.cream].forEach((dot, j) => add(ck, G.ball, M(dot), { p: [-0.42 + j * 0.12, 0.34, -0.34], s: 0.04 }));
  }

  colliders.push({ ...local(c, 0, 0), r: 2.8 }, { ...local(c, 4.3, 0.8), r: 1.5 });
  g.traverse((o) => { o.userData.place = 'build'; });
  hotspots.push(g);
  return { id: 'build', group: g, focus: { ...local(c, 1.5, 0), y: 2 }, zoneAt: local(c, 1, 2.5), zone: 8, stand: local(c, 0.6, 5.2), labelAt: [c.x, 9.6, c.z] };
}

function iconLollipop(kind, swirl) {
  const a = document.querySelector(`[data-icon="${kind}"] path`);
  return canvasTex(512, 512, (x, w) => {
    const c = w / 2;
    x.fillStyle = swirl[0]; x.beginPath(); x.arc(c, c, c, 0, TAU); x.fill();
    const turns = 3.2, b = c / (turns * TAU);
    x.strokeStyle = swirl[1]; x.lineWidth = b * Math.PI; x.lineCap = 'round'; x.beginPath();
    for (let th = 0; th < turns * TAU; th += 0.05) { const r = b * th; x.lineTo(c + Math.cos(th) * r, c + Math.sin(th) * r); }
    x.stroke();
    x.fillStyle = PAL.card; x.beginPath(); x.arc(c, c, 120, 0, TAU); x.fill();
    if (!a) return;
    x.save(); x.translate(c - 72, c - 72); x.scale(144 / 24, 144 / 24);
    if (kind === 'instagram') {
      const grad = x.createLinearGradient(0, 24, 24, 0);
      [['0', '#FEDA75'], ['.3', '#FA7E1E'], ['.55', '#D62976'], ['.8', '#962FBF'], ['1', '#4F5BD5']].forEach(([o, col]) => grad.addColorStop(Number(o), col));
      x.fillStyle = grad;
    } else x.fillStyle = '#5865F2';
    x.fill(new Path2D(a.getAttribute('d')));
    x.restore();
  });
}

function buildJoin(scene) {
  const c = PLACES.join;
  const g = placeGroup(scene, c);
  // A big glazed donut lying flat, with a bite out of the side that faces the plaza. Walk in through the bite.
  const RR = 4.2, tube = 1.4, gap = 1.4, arc = TAU - gap;
  const yawRing = new THREE.Group();
  yawRing.rotation.y = gap / 2 - Math.PI / 2; // centers the bite on local +z
  g.add(yawRing);
  const ring = new THREE.Group(); // torus frame: the ring lies in x-y, z is up
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = tube * 0.8;
  ring.scale.z = 0.8;
  yawRing.add(ring);
  const gz = tube * 0.96, gUp = 0.55, gSquash = 0.62;
  add(ring, new THREE.TorusGeometry(RR, tube, 20, 72, arc), M(PAL.dough));
  add(ring, new THREE.TorusGeometry(RR, gz, 20, 72, arc), M(PAL.glaze, { roughness: 0.4 }), { p: [0, 0, gUp], s: [1, 1, gSquash] });
  // Bitten ends: rounded dough with a scallop of smaller bites, glaze on top
  for (const u of [0, arc]) {
    const ex = Math.cos(u) * RR, ey = Math.sin(u) * RR;
    add(ring, G.sphere, M(PAL.dough), { p: [ex, ey, 0], s: tube });
    add(ring, G.sphere, M(PAL.glaze, { roughness: 0.4 }), { p: [ex, ey, gUp], s: [gz, gz, gz * gSquash] });
    const tx = -Math.sin(u) * (u === 0 ? -1 : 1), ty = Math.cos(u) * (u === 0 ? -1 : 1);
    for (const k of [-0.7, 0.7]) add(ring, G.sphere, M(shade(PAL.dough, 1.04)), { p: [ex + tx * 0.75 + Math.cos(u) * k, ey + ty * 0.75 + Math.sin(u) * k, 0.1], s: 0.55 });
  }
  const sprinkles = new THREE.InstancedMesh(G.sprinkle, M('#ffffff', { roughness: 0.5 }), 230);
  const o = new THREE.Object3D();
  const cols = [PAL.cream, PAL.green, '#F7D9A8', PAL.leaf, PAL.accent];
  for (let i = 0; i < sprinkles.count; i++) {
    const u = 0.12 + Math.random() * (arc - 0.24);
    const v = Math.PI / 2 + (Math.random() - 0.5) * 1.9;
    const rr = gz + 0.02;
    o.position.set((RR + rr * Math.cos(v)) * Math.cos(u), (RR + rr * Math.cos(v)) * Math.sin(u), gUp + rr * Math.sin(v) * gSquash);
    o.rotation.set(Math.random() * TAU, Math.random() * TAU, 0);
    o.scale.set(0.1, 0.15, 0.1);
    o.updateMatrix();
    sprinkles.setMatrixAt(i, o.matrix);
    sprinkles.setColorAt(i, new THREE.Color(cols[i % cols.length]));
  }
  ring.add(sprinkles);
  // A sugar-cookie mat in the hole
  add(g, G.cyl, M('#FFF4E0'), { p: [0, 0.05, 0], s: [1.6, 0.1, 1.6] });
  add(g, new THREE.TorusGeometry(1.45, 0.07, 8, 40).rotateX(Math.PI / 2), M(PAL.pink), { p: [0, 0.11, 0] });
  // Colliders along the ring
  g.updateMatrixWorld(true);
  const wp = new THREE.Vector3();
  for (let u = 0; u <= arc + 1e-6; u += arc / 12) {
    ring.localToWorld(wp.set(Math.cos(u) * RR, Math.sin(u) * RR, 0));
    colliders.push({ x: wp.x, z: wp.z, r: tube * 0.92 });
  }

  // Lollipops for Instagram and Discord
  const pops = [];
  for (const [side, kind, swirl] of [[-1, 'instagram', [PAL.pink, PAL.pinkwash]], [1, 'discord', [PAL.green, PAL.wash]]]) {
    const pop = new THREE.Group();
    pop.position.set(side * 4.3, 0, 6.6);
    pop.rotation.y = -side * 0.35;
    g.add(pop);
    add(pop, G.cylLo, M(PAL.cream), { p: [0, 1.5, 0], s: [0.08, 3, 0.08] });
    const tex = iconLollipop(kind, swirl);
    const candy = add(pop, G.cyl, [M(swirl[0], { roughness: 0.3 }), M('#ffffff', { map: tex, roughness: 0.3 }), M('#ffffff', { map: tex, roughness: 0.3 })], { p: [0, 3.7, 0], r: [Math.PI / 2, 0, 0], s: [1.1, 0.3, 1.1] });
    pops.push(candy);
    colliders.push({ ...local(c, side * 4.3, 6.6), r: 0.5 });
  }
  ticks.push((t) => { pops.forEach((p, i) => { p.rotation.y = Math.sin(t * 0.8 + i * 2) * 0.12; }); });

  g.traverse((o2) => { o2.userData.place = 'join'; });
  hotspots.push(g);
  return { id: 'join', group: g, focus: { x: c.x, y: 0, z: c.z }, entry: local(c, 0, 7.5), zoneAt: local(c, 0, 1.5), zone: 8, stand: local(c, 0, 0), labelAt: [c.x, 6.2, c.z] };
}

/* ---------- scenery ---------- */

function softServe(scene, x, z, color, s) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  g.rotation.y = Math.random() * TAU;
  scene.add(g);
  add(g, new THREE.ConeGeometry(0.62, 1.9, 24).rotateX(Math.PI), M('#ffffff', { map: T.waffle }), { p: [0, 0.95, 0] });
  for (const [r, y] of [[0.68, 2.0], [0.55, 2.42], [0.4, 2.8]]) add(g, new THREE.TorusGeometry(r, 0.34 * r / 0.68 + 0.08, 10, 24).rotateX(Math.PI / 2), M(color, { roughness: 0.6 }), { p: [0, y, 0] });
  add(g, G.kiss, M(color, { roughness: 0.6 }), { p: [0, 2.9, 0], s: 0.5 });
  colliders.push({ x, z, r: 0.75 * s });
}

function cakePop(scene, x, z, color, s) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(s);
  scene.add(g);
  add(g, G.cylLo, M(PAL.cream), { p: [0, 1.3, 0], s: [0.07, 2.6, 0.07] });
  add(g, G.sphere, M(color, { roughness: 0.45 }), { p: [0, 3.1, 0], s: 0.78 });
  add(g, G.dome, M(PAL.cream, { roughness: 0.45 }), { p: [0, 3.25, 0], s: [0.72, 0.68, 0.72] });
  colliders.push({ x, z, r: 0.45 * s });
}

function cloud(parent, x, y, z, s) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  g.scale.setScalar(s);
  parent.add(g);
  const mat = M(PAL.cream, { emissive: PAL.cream, emissiveIntensity: 0.35, roughness: 1 });
  const puffs = [[0, 0, 0, 1.6], [1.5, -0.2, 0.3, 1.2], [-1.5, -0.25, -0.2, 1.15], [0.6, 0.7, -0.3, 1.1], [-0.7, 0.5, 0.4, 1.0], [2.6, -0.5, 0, 0.8], [-2.5, -0.5, 0.2, 0.75]];
  for (const [px, py, pz, r] of puffs) add(g, G.ball, mat, { p: [px, py, pz], s: [r, r * 0.82, r], shadow: false });
}

function buildScenery(scene) {
  const trees = [[-27, -13, PAL.matcha], [-9, -24, PAL.pink], [10, -23, PAL.matcha], [27, -14, PAL.pink], [-30, 6, PAL.pink], [30, 7, PAL.matcha], [-24, 26, PAL.matcha], [24, 27, PAL.pink], [-3, 29, PAL.pink], [5, 30, PAL.matcha], [-30, -2, PAL.cream], [31, -3, PAL.cream]];
  trees.forEach(([x, z, col], i) => softServe(scene, x, z, col, 1.35 + (i % 3) * 0.25));
  const pops = [[-7, -19, PAL.pink], [8, -18, PAL.green], [-25, 12, PAL.green], [26, 13, PAL.pink], [-8, 25, PAL.green], [9, 25, PAL.pink], [-15, -14, PAL.pink], [16, -15, PAL.green]];
  pops.forEach(([x, z, col], i) => cakePop(scene, x, z, col, 0.9 + (i % 2) * 0.2));
  // Little macarons lying around
  [[-6, 14, PAL.green], [4, 16, PAL.pink], [-22, -9, PAL.pink], [22, 6, PAL.green], [-4, -26, PAL.green], [17, 27, PAL.pink], [-18, 27, PAL.pink], [28, -7, PAL.green]]
    .forEach(([x, z, col], i) => {
      const m = macaron(scene, col, 0.6, 1, [x, 0, z]);
      m.rotation.y = i;
      colliders.push({ x, z, r: 0.65 });
    });

  // Whipped-cream clouds around and below the cake
  const sky = new THREE.Group();
  scene.add(sky);
  for (let i = 0; i < 18; i++) {
    const a = i / 18 * TAU + Math.random() * 0.2;
    const r = 44 + Math.random() * 30;
    const below = i % 3 !== 0;
    cloud(sky, Math.sin(a) * r, below ? -9 - Math.random() * 10 : 3 + Math.random() * 9, Math.cos(a) * r, 2.2 + Math.random() * 2.2);
  }
  ticks.push((t, dt) => { sky.rotation.y += dt * 0.006; });

  // Sprinkles drifting in the air
  const N = 170;
  const air = new THREE.InstancedMesh(G.sprinkle, new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6 }), N);
  const seeds = [];
  const cols = [PAL.pink, PAL.green, '#F7D9A8', PAL.accent, PAL.leaf, PAL.cream];
  for (let i = 0; i < N; i++) {
    const a = Math.random() * TAU, r = 6 + Math.random() * 42;
    seeds.push({ x: Math.sin(a) * r, z: Math.cos(a) * r, y: 1.5 + Math.random() * 15, ph: Math.random() * TAU, sp: 0.2 + Math.random() * 0.4 });
    air.setColorAt(i, new THREE.Color(cols[i % cols.length]));
  }
  scene.add(air);
  const o = new THREE.Object3D();
  ticks.push((t) => {
    for (let i = 0; i < N; i++) {
      const s = seeds[i];
      o.position.set(s.x + Math.sin(t * s.sp + s.ph) * 0.8, s.y + Math.sin(t * s.sp * 1.3 + s.ph) * 0.7, s.z + Math.cos(t * s.sp + s.ph) * 0.8);
      o.rotation.set(t * s.sp + s.ph, t * s.sp * 0.7, s.ph);
      o.scale.set(0.11, 0.17, 0.11);
      o.updateMatrix();
      air.setMatrixAt(i, o.matrix);
    }
    air.instanceMatrix.needsUpdate = true;
  });
}

/* ---------- the mochi you walk as ---------- */

function buildPlayer(scene) {
  const root = new THREE.Group();
  const bob = new THREE.Group();
  root.add(bob);
  scene.add(root);
  const skin = M(PAL.mochi, { roughness: 0.62 });
  add(bob, G.sphere, skin, { p: [0, 0.82, 0], s: [1, 0.82, 1] });
  const eye = M('#2C3B21', { roughness: 0.3 });
  for (const sx of [-0.3, 0.3]) {
    add(bob, G.ball, eye, { p: [sx, 0.98, 0.93], s: [0.085, 0.115, 0.05] });
    add(bob, G.ball, M('#F2A9C2', { roughness: 0.8 }), { p: [sx * 1.85, 0.82, 0.83], s: [0.16, 0.09, 0.05], shadow: false });
  }
  add(bob, G.cylLo, M(PAL.leaf), { p: [0, 1.75, 0], s: [0.045, 0.3, 0.045] });
  for (const side of [-1, 1]) add(bob, G.sphere, M(PAL.leaf, { roughness: 0.6 }), { p: [side * 0.2, 1.92, 0], r: [0, 0, side * -0.5], s: [0.24, 0.05, 0.12] });
  return { root, bob };
}

/* ---------- start ---------- */

export async function start(ui, { startAt } = {}) {
  await Promise.race([
    Promise.all(['600 64px Fraunces', '500 32px "DM Sans"', '700 32px "DM Sans"'].map((f) => document.fonts.load(f))),
    new Promise((r) => setTimeout(r, 2500)),
  ]);

  const canvas = document.getElementById('world');
  const small = () => matchMedia('(max-width: 760px)').matches; // same breakpoint as the CSS
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(PAL.cream, 85, 175);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);

  scene.add(new THREE.HemisphereLight('#FFF4EE', '#DCE9B8', 1.55));
  const sun = new THREE.DirectionalLight('#FFF0DE', 2.1);
  sun.position.set(-22, 42, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(small() ? 1024 : 2048, small() ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, near: 5, far: 110 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  sun.shadow.intensity = 0.6;
  scene.add(sun);
  const fill = new THREE.DirectionalLight('#FBE6EF', 0.6);
  fill.position.set(25, 18, -20);
  scene.add(fill);

  makeShapes();
  makeTextures();
  buildIsland(scene);
  buildPlaza(scene);
  const places = [buildCafe(scene), buildMeetings(scene), buildArgue(scene), buildBake(scene), buildJoin(scene)];
  const byId = Object.fromEntries(places.map((p) => [p.id, p]));
  for (const p of places) p.yaw = facing(PLACES[p.id]);
  buildScenery(scene);
  const player = buildPlayer(scene);

  /* labels */
  const layer = document.getElementById('labels');
  const labels = [];
  for (const p of places) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'label';
    el.tabIndex = -1;
    el.dataset.go = p.id;
    el.textContent = PLACES[p.id].name;
    layer.append(el);
    labels.push({ el, at: new THREE.Vector3(...p.labelAt), id: p.id });
  }
  for (const m of byId.meetings.small) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'label small';
    el.tabIndex = -1;
    el.innerHTML = m.html;
    el.addEventListener('click', () => { ui.open('meetings', 'nav'); ui.focusMeeting(m.n); });
    layer.append(el);
    labels.push({ el, at: new THREE.Vector3(m.at.x, m.y, m.at.z), small: true, n: m.n });
  }

  /* movement state */
  const clock = new THREE.Clock();
  const me = { x: SPAWN.x, z: SPAWN.z, y: PLAZA.top, vx: 0, vz: 0, face: 0, hop: 0, path: [], goalStone: null, stuck: 0 };
  player.root.rotation.y = me.face;
  let travel = null;
  const keys = new Set();

  const segHits = (a, b, cx, cz, r) => {
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1;
    const t = Math.max(0, Math.min(1, ((cx - a.x) * dx + (cz - a.z) * dz) / l2));
    return Math.hypot(a.x + dx * t - cx, a.z + dz * t - cz) < r;
  };
  const clear = (a, b) => colliders.every((c) => !segHits(a, b, c.x, c.z, c.r + PLAYER_R + 0.1));
  const waypoints = [];
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; waypoints.push({ x: PLAZA.x + Math.sin(a) * 9, z: PLAZA.z + Math.cos(a) * 9 }); }
  for (let i = 0; i < 16; i++) { const a = i / 16 * TAU; waypoints.push({ x: Math.sin(a) * 26, z: Math.cos(a) * 26 }); }
  // Each place's front door, on the line from the plaza (Join's is outside the bite)
  for (const p of places) {
    const d = toPlaza(PLACES[p.id]);
    waypoints.push(p.entry || { x: p.stand.x + d.x * 3, z: p.stand.z + d.z * 3 });
  }

  function pushOut(p) {
    for (const c of colliders) {
      const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz), min = c.r + PLAYER_R;
      // Push out a little past the route check's margin, so a route can always start from here
      if (d < min) { const k = d > 1e-4 ? (min + 0.15) / d : 0; p.x = c.x + (d > 1e-4 ? dx * k : min + 0.15); p.z = c.z + dz * k; }
    }
    const r = Math.hypot(p.x, p.z);
    if (r > WALK_R) { p.x *= WALK_R / r; p.z *= WALK_R / r; }
    return p;
  }

  function route(dest, goalStone = null) {
    const to = pushOut({ ...dest });
    const from = { x: me.x, z: me.z };
    me.goalStone = goalStone;
    me.stuck = 0;
    if (clear(from, to)) { me.path = [to]; return; }
    let best = null, bestLen = Infinity;
    const usable = waypoints.filter((w) => colliders.every((c) => Math.hypot(w.x - c.x, w.z - c.z) > c.r + PLAYER_R));
    for (const w of usable) {
      if (!clear(from, w) || !clear(w, to)) continue;
      const len = Math.hypot(w.x - from.x, w.z - from.z) + Math.hypot(to.x - w.x, to.z - w.z);
      if (len < bestLen) { best = [w, to]; bestLen = len; }
    }
    if (!best) {
      for (const w1 of usable) {
        if (!clear(from, w1)) continue;
        for (const w2 of usable) {
          if (w1 === w2 || !clear(w1, w2) || !clear(w2, to)) continue;
          const len = Math.hypot(w1.x - from.x, w1.z - from.z) + Math.hypot(w2.x - w1.x, w2.z - w1.z) + Math.hypot(to.x - w2.x, to.z - w2.z);
          if (len < bestLen) { best = [w1, w2, to]; bestLen = len; }
        }
      }
    }
    me.path = best || [to];
  }

  /* camera */
  const cam = { yaw: -0.5, pitch: 1.2, dist: 120, tYaw: 0, tPitch: 0.8, tDist: small() ? 58 : 46, x: SPAWN.x, y: 1, z: SPAWN.z };
  const view = { ox: 0, oy: 0 };
  let introUntil = REDUCE ? 0 : 2.8;
  if (REDUCE) Object.assign(cam, { yaw: cam.tYaw, pitch: cam.tPitch, dist: cam.tDist });
  const nearestAngle = (from, to) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from));

  function onResize() {
    const w = innerWidth, h = innerHeight;
    renderer.setPixelRatio(Math.min(devicePixelRatio, small() ? 1.75 : 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = small() ? 40 : 32;
    camera.updateProjectionMatrix();
  }
  addEventListener('resize', onResize);
  onResize();

  function goTo(id, { frame = true } = {}) {
    const p = byId[id];
    if (!p) return;
    travel = id;
    route(p.stand);
    if (frame) cam.tYaw = nearestAngle(cam.yaw, p.yaw);
    ui.hideHint();
  }
  ui.on('go', (id) => goTo(id));
  ui.on('vote', (k, from) => {
    byId.argue.lift(k);
    if (from === 'ui') {
      const s = stones.find((st) => st.k === k);
      if (s) { travel = 'argue'; route(s, k); cam.tYaw = nearestAngle(cam.yaw, byId.argue.yaw); }
    }
  });
  if (ui.vote != null) byId.argue.lift(ui.vote);

  if (startAt && byId[startAt]) {
    Object.assign(me, { x: byId[startAt].stand.x, z: byId[startAt].stand.z });
    me.face = byId[startAt].yaw + Math.PI;
    cam.tYaw = byId[startAt].yaw;
    cam.x = me.x; cam.z = me.z;
    ui.open(startAt, 'nav');
  } else {
    ui.open('about', 'welcome');
  }

  /* pointer: tap to walk, drag to look, pinch or wheel to zoom */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const pointers = new Map();
  const groundHit = new THREE.Vector3();
  let drag = null, pinch = null, hoverAt = null, hoverDirty = false;

  const marker = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.08, 8, 32).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: PAL.accent, transparent: true, opacity: 0, depthWrite: false }));
  scene.add(marker);
  let markerT = 9;

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    ndc.set((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(hotspots, true)[0];
    if (hit) {
      let o = hit.object;
      while (o && o.userData.place == null) o = o.parent;
      if (o) return { place: hit.object.userData.place ?? o.userData.place, meeting: hit.object.userData.meeting, vote: hit.object.userData.vote, point: hit.point };
    }
    if (raycaster.ray.intersectPlane(ground, groundHit) && Math.hypot(groundHit.x, groundHit.z) < ISLAND_R - 0.5) return { point: groundHit };
    return null;
  }

  function tap(clientX, clientY) {
    const hit = pick(clientX, clientY);
    if (!hit) return;
    ui.hideHint();
    if (hit.vote != null) {
      ui.open('argue', 'nav');
      const s = stones.find((st) => st.k === hit.vote);
      travel = 'argue';
      route(s, hit.vote);
    } else if (hit.place) {
      ui.open(hit.place, 'nav');
      goTo(hit.place);
      if (hit.meeting != null) ui.focusMeeting(hit.meeting);
    } else {
      travel = null;
      route({ x: hit.point.x, z: hit.point.z });
      marker.position.set(me.path[me.path.length - 1].x, 0.06 + groundY(me.path[me.path.length - 1].x, me.path[me.path.length - 1].z), me.path[me.path.length - 1].z);
      markerT = 0;
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { x0: e.clientX, y0: e.clientY, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: cam.tDist };
      drag = null;
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    hoverAt = { x: e.clientX, y: e.clientY };
    hoverDirty = true;
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    // The button came up somewhere we never heard about (a context menu, another window)
    if (e.pointerType === 'mouse' && e.buttons === 0) { release(e, true); return; }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      cam.tDist = THREE.MathUtils.clamp(pinch.dist * pinch.d / Math.max(20, Math.hypot(a.x - b.x, a.y - b.y)), 20, 80);
      return;
    }
    if (!drag) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    // A tap becomes a drag once the pointer is this far from where it went down; fingers wobble more
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > (e.pointerType === 'touch' ? 12 : 6)) drag.moved = true;
    if (drag.moved) {
      cam.tYaw -= dx * 0.0065;
      cam.tPitch = THREE.MathUtils.clamp(cam.tPitch + dy * 0.004, 0.4, 1.25);
      canvas.classList.add('drag');
      introUntil = 0;
    }
  });
  const release = (e, cancelled) => {
    if (!pointers.has(e.pointerId)) return;
    if (!cancelled && drag && !drag.moved && pointers.size === 1) tap(e.clientX, e.clientY);
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) drag = null;
    canvas.classList.remove('drag');
  };
  canvas.addEventListener('pointerup', (e) => release(e, false));
  canvas.addEventListener('pointercancel', (e) => release(e, true));
  canvas.addEventListener('lostpointercapture', (e) => release(e, true));
  canvas.addEventListener('pointerleave', () => { hoverAt = null; setHover(null); });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    cam.tDist = THREE.MathUtils.clamp(cam.tDist * (1 + e.deltaY * 0.0012), 20, 80);
    introUntil = 0;
  }, { passive: false });

  const KEYS = { ArrowUp: 'f', KeyW: 'f', ArrowDown: 'b', KeyS: 'b', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
  addEventListener('keydown', (e) => {
    if (e.key === 'Meta') keys.clear(); // macOS drops keyups while Cmd is down
    const k = KEYS[e.code];
    if (!k || ui.text || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest?.('#panel, input, textarea, select')) return;
    e.preventDefault();
    keys.add(k);
    me.path = [];
    me.goalStone = null;
    travel = null;
    ui.hideHint();
  });
  addEventListener('keyup', (e) => {
    if (e.key === 'Meta') keys.clear();
    const k = KEYS[e.code];
    if (k) keys.delete(k);
  });
  addEventListener('blur', () => keys.clear());

  /* per-frame */
  function groundY(x, z) {
    let y = Math.hypot(x - PLAZA.x, z - PLAZA.z) < PLAZA.r - 0.2 ? PLAZA.top : 0;
    for (const s of stones) if (Math.hypot(x - s.x, z - s.z) < 0.92) y = Math.max(y, 0.47 + s.group.position.y);
    return y;
  }

  const SPEED = 7.5;
  function movePlayer(dt) {
    let wx = 0, wz = 0, want = 0;
    if (keys.size) {
      const fx = -Math.sin(cam.yaw), fz = -Math.cos(cam.yaw);
      const rx = Math.cos(cam.yaw), rz = -Math.sin(cam.yaw);
      const kf = (keys.has('f') ? 1 : 0) - (keys.has('b') ? 1 : 0), kr = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0);
      wx = fx * kf + rx * kr; wz = fz * kf + rz * kr;
      const l = Math.hypot(wx, wz);
      if (l) { wx /= l; wz /= l; want = SPEED; }
    } else if (me.path.length) {
      const tgt = me.path[0];
      const dx = tgt.x - me.x, dz = tgt.z - me.z, d = Math.hypot(dx, dz);
      const last = me.path.length === 1;
      if (d < (last ? 0.12 : 0.7)) {
        me.path.shift();
        if (!me.path.length) { me.goalStone = null; if (travel) travel = null; }
      } else {
        wx = dx / d; wz = dz / d;
        want = last ? SPEED * THREE.MathUtils.clamp(d / 1.6, 0.3, 1) : SPEED;
      }
    }
    const k = 1 - Math.exp(-12 * dt);
    me.vx += (wx * want - me.vx) * k;
    me.vz += (wz * want - me.vz) * k;
    const bx = me.x, bz = me.z;
    me.x += me.vx * dt;
    me.z += me.vz * dt;
    pushOut(me);
    const moved = Math.hypot(me.x - bx, me.z - bz);
    if (me.path.length && moved < 0.25 * dt * SPEED * 0.2) {
      me.stuck += dt;
      if (me.stuck > 0.8) { me.path = []; me.goalStone = null; travel = null; }
    } else me.stuck = 0;
    const speed = Math.hypot(me.vx, me.vz);
    if (speed > 0.4) me.face = nearestAngle(me.face, Math.atan2(me.vx, me.vz));
    player.root.rotation.y += (me.face - player.root.rotation.y) * (1 - Math.exp(-12 * dt));
    me.y += (groundY(me.x, me.z) - me.y) * (1 - Math.exp(-16 * dt));
    player.root.position.set(me.x, me.y, me.z);
    // Hop while walking, breathe while standing
    const s = speed / SPEED;
    if (s > 0.08 && !REDUCE) {
      me.hop += dt * (7 + 6 * s);
      const sn = Math.abs(Math.sin(me.hop));
      player.bob.position.y = sn * 0.34 * Math.min(1, s * 1.4);
      const sy = 1 - 0.12 * Math.cos(2 * me.hop) * Math.min(1, s * 1.4);
      player.bob.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
    } else {
      me.hop = 0;
      player.bob.position.y *= 0.8;
      const sy = 1 + (REDUCE ? 0 : Math.sin(clock.elapsedTime * 2.2) * 0.025);
      player.bob.scale.set(1 / Math.sqrt(sy), sy, 1 / Math.sqrt(sy));
    }
    // Standing on a vote stone counts as a vote
    for (const st of stones) {
      if (Math.hypot(me.x - st.x, me.z - st.z) < 0.85 && ui.vote !== st.k && (me.goalStone == null || me.goalStone === st.k)) ui.setVote(st.k, 'world');
    }
  }

  function updateZones() {
    let left = null;
    for (const p of places) {
      const inside = Math.hypot(me.x - p.zoneAt.x, me.z - p.zoneAt.z) < p.zone;
      if (inside && !p.inside) {
        p.inside = true;
        if (!travel || travel === p.id) ui.open(p.id, 'zone');
      } else if (!inside && p.inside) {
        p.inside = false;
        ui.forget(p.id);
        if (ui.current === p.id && travel !== p.id) left = p.id;
      }
    }
    // Some zones overlap: leaving one hands the card to the nearest one you are still in
    if (left && ui.current === left) {
      const near = places.filter((p) => p.inside && ui.dismissed !== p.id)
        .sort((a, b) => Math.hypot(me.x - a.zoneAt.x, me.z - a.zoneAt.z) - Math.hypot(me.x - b.zoneAt.x, me.z - b.zoneAt.z))[0];
      if (near) ui.open(near.id, 'zone');
      else ui.close('zone');
    }
  }

  const v = new THREE.Vector3();
  let hoverId = null, frames = 0;
  function setHover(id) {
    canvas.classList.toggle('hover', !!id);
    if (id === hoverId) return;
    if (hoverId) byId[hoverId].group.userData.hover = false;
    if (id) byId[id].group.userData.hover = true;
    hoverId = id;
  }
  function updateHover() {
    // Raycast when the pointer moved, and now and then while the camera glides under a still pointer
    if (!hoverAt || drag?.moved || (!hoverDirty && ++frames % 12)) return;
    hoverDirty = false;
    setHover(pick(hoverAt.x, hoverAt.y)?.place || null);
  }

  function updateCamera(dt, t) {
    const lam = t < introUntil ? 1.6 : 6;
    const k = 1 - Math.exp(-lam * dt);
    cam.yaw += (cam.tYaw - cam.yaw) * k;
    cam.pitch += (cam.tPitch - cam.pitch) * k;
    cam.dist += (cam.tDist - cam.dist) * k;
    // Frame the place you are visiting along with the mochi
    // The pull grows as you get closer to the place whose card is open
    const here = byId[ui.current];
    let pull = 0;
    if (here) {
      const t = THREE.MathUtils.clamp((30 - Math.hypot(here.focus.x - me.x, here.focus.z - me.z)) / 20, 0, 1);
      pull = 0.55 * t * t * (3 - 2 * t);
    }
    const fx = me.x + (here ? here.focus.x - me.x : 0) * pull;
    const fz = me.z + (here ? here.focus.z - me.z : 0) * pull;
    const kf = 1 - Math.exp(-4 * dt);
    cam.x += (fx - cam.x) * kf;
    cam.z += (fz - cam.z) * kf;
    cam.y += ((here ? here.focus.y * pull / 0.55 : 0) + me.y + 1 - cam.y) * kf;
    const cp = Math.cos(cam.pitch);
    camera.position.set(cam.x + Math.sin(cam.yaw) * cp * cam.dist, cam.y + Math.sin(cam.pitch) * cam.dist, cam.z + Math.cos(cam.yaw) * cp * cam.dist);
    camera.lookAt(cam.x, cam.y, cam.z);
    camera.updateMatrixWorld(); // labels project with this frame's rotation
    scene.fog.near = cam.dist + 25;
    scene.fog.far = cam.dist + 120;
    // Keep the mochi centered in the space the card leaves free
    const open = document.querySelector('.station.on');
    let tx = 0, ty = 0;
    if (open) {
      const r = open.getBoundingClientRect();
      if (small()) ty = Math.min(innerHeight * 0.3, (innerHeight - r.top) / 2);
      else tx = Math.min(innerWidth * 0.25, (innerWidth - r.left) / 2);
    }
    view.ox += (tx - view.ox) * kf;
    view.oy += (ty - view.oy) * kf;
    if (Math.abs(view.ox) + Math.abs(view.oy) > 0.5) camera.setViewOffset(innerWidth, innerHeight, view.ox, view.oy, innerWidth, innerHeight);
    else camera.clearViewOffset();
  }

  let barBottom = 0;
  const measureBar = () => { barBottom = document.querySelector('.places').getBoundingClientRect().bottom + 6; };
  addEventListener('resize', measureBar);
  measureBar();

  function updateLabels() {
    const w = innerWidth, h = innerHeight;
    for (const l of labels) {
      if (l.small) {
        l.el.classList.toggle('show', ui.current === 'meetings');
        l.el.classList.toggle('next', l.n === upcoming?.n);
      }
      else {
        l.el.classList.toggle('on', ui.current === l.id);
        l.el.classList.toggle('hot', hoverId === l.id);
      }
      v.copy(l.at).project(camera);
      const off = v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2;
      l.el.hidden = off;
      if (off) continue;
      const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
      // Labels never slide under the top bar
      l.el.hidden = y - (l.small ? 16 : 44) < barBottom;
      if (l.el.hidden) continue;
      l.el.style.transform = l.small ? `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(12px,-50%)` : `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(-50%,-100%)`;
    }
  }

  let wasText = false;
  function frame() {
    requestAnimationFrame(frame);
    if (ui.text) { wasText = true; return; }
    if (wasText) { wasText = false; onResize(); clock.getDelta(); }
    const dt = Math.min(clock.getDelta(), 1 / 20);
    const t = clock.elapsedTime;
    movePlayer(dt);
    updateZones();
    updateHover();
    for (const fn of ticks) fn(t, dt);
    for (const p of places) {
      const target = p.group.userData.hover ? 1.025 : 1;
      p.group.scale.setScalar(p.group.scale.x + (target - p.group.scale.x) * (1 - Math.exp(-10 * dt)));
    }
    markerT += dt;
    marker.material.opacity = Math.max(0, 0.9 - markerT * 1.4);
    marker.scale.setScalar(0.6 + Math.min(1, markerT * 3) * 0.6);
    updateCamera(dt, t);
    updateLabels();
    renderer.render(scene, camera);
  }
  renderer.compile(scene, camera);
  frame();
  // Debug hooks for automated checks
  window.__world = { me, cam, places: byId, stones, camera, renderer, goTo, waypoints, colliders };
}
