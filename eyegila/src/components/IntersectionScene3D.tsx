/**
 * 3D intersection simulation — vehicles + pedestrian crossings.
 *
 * Coordinate system (Three.js, Y-up):
 *   +X = East   –X = West
 *   +Z = South  –Z = North
 *
 * Approach mapping (right-hand PH traffic, vehicles entering from outside):
 *   0 = southbound  (enters from –Z)
 *   1 = westbound   (enters from +X)
 *   2 = northbound  (enters from +Z)
 *   3 = eastbound   (enters from –X)
 *
 * Pedestrian crossings (4 crosswalks, one per arm):
 *   N arm (z = –XWALK): peds walk E–W; WALK when NS vehicles are RED
 *   S arm (z = +XWALK): peds walk W–E; WALK when NS vehicles are RED
 *   E arm (x = +XWALK): peds walk N–S; WALK when EW vehicles are RED
 *   W arm (x = –XWALK): peds walk S–N; WALK when EW vehicles are RED
 */
import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { TimingChunk } from '@/services/timing';
import type { Street } from '@/types';
import type { VehicleType, TypeFractions } from './IntersectionCanvas';

// ─── Layout constants ─────────────────────────────────────────────────────────

const BOX          = 7.5;   // half-width of intersection box (m)
const ARM          = 48;    // arm length from box edge (m)
const ROAD_W       = 15;    // total road width (two lanes bi-directional)
const LANE         = ROAD_W / 4;
const AMBER_S      = 3;
const ALL_RED      = 3;
const XWALK_OFFSET = 2.5;   // m past stop line where crosswalk is centred
const PED_SPEED    = 1.2;   // m/s (DPWH pedestrian walking speed)
const PED_SCALE       = 1.0;   // Quaternius models export at ~1:1 m scale
const TRICYCLE_GREEN  = 0x16a34a;

// ─── Approach ↔ direction mapping ────────────────────────────────────────────

const DIR_TO_APP: Record<string, number> = {
  southbound: 0, westbound: 1, northbound: 2, eastbound: 3,
};

// ─── Vehicle params ───────────────────────────────────────────────────────────

interface VParams { len: number; spd: number; dec: number; gap: number }

const VPARAMS: Record<VehicleType, VParams> = {
  MC:    { len: 2.0,  spd: 22, dec: 7.5, gap: 1.5 },
  CAR:   { len: 4.4,  spd: 18, dec: 6.0, gap: 2.0 },
  JEP:   { len: 6.5,  spd: 14, dec: 5.0, gap: 2.5 },
  BUS:   { len: 11.0, spd: 11, dec: 3.5, gap: 3.5 },
  TRUCK: { len: 8.5,  spd: 11, dec: 3.5, gap: 3.0 },
};

const VEH_TYPES: VehicleType[] = ['MC', 'CAR', 'JEP', 'BUS', 'TRUCK'];
const DEFAULT_MIX: TypeFractions = { MC: 0.50, CAR: 0.30, JEP: 0.15, BUS: 0.03, TRUCK: 0.02 };

function sampleType(mix: TypeFractions): VehicleType {
  let r = Math.random(), cum = 0;
  for (const t of VEH_TYPES) { cum += mix[t]; if (r < cum) return t; }
  return 'CAR';
}

// ─── Crosswalk definitions ────────────────────────────────────────────────────

interface CwDef {
  startX: number; startZ: number;  // position at road edge where peds begin
  dx: number;     dz: number;      // unit direction of travel
  rotY: number;                    // Y-rotation to face direction of travel
  blockedApp: number;              // vehicle approach that blocks this crossing (0=NS, 1=EW)
}

const XWALK_POS = BOX + XWALK_OFFSET;  // 10.0 m from centre

const CW_DEFS: CwDef[] = [
  // N arm — peds walk east (+X); model default faces -Z, so +π/2 turns it to face +X
  { startX: -ROAD_W / 2, startZ: -XWALK_POS, dx:  1, dz:  0, rotY:  Math.PI / 2, blockedApp: 0 },
  // S arm — peds walk west (-X); -π/2 faces -X
  { startX:  ROAD_W / 2, startZ:  XWALK_POS, dx: -1, dz:  0, rotY: -Math.PI / 2, blockedApp: 0 },
  // E arm — peds walk south (+Z); π faces +Z
  { startX:  XWALK_POS, startZ: -ROAD_W / 2, dx:  0, dz:  1, rotY:  Math.PI,     blockedApp: 1 },
  // W arm — peds walk north (-Z); 0 = default -Z facing
  { startX: -XWALK_POS, startZ:  ROAD_W / 2, dx:  0, dz: -1, rotY:  0,           blockedApp: 1 },
];

// ─── Shared geometry helpers ──────────────────────────────────────────────────

function makeMat(color: number, emissive = 0, emInt = 0.0, opacity = 1): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, emissive, emissiveIntensity: emInt,
    transparent: opacity < 1, opacity });
}

function bx(w: number, h: number, d: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function addBox(
  g: THREE.Group, w: number, h: number, d: number,
  px: number, py: number, pz: number,
  color: number, emissive = 0, emInt = 0.0,
): void {
  const m = mesh(bx(w, h, d), makeMat(color, emissive, emInt));
  m.position.set(px, py, pz);
  g.add(m);
}

function addCyl(
  g: THREE.Group, rTop: number, rBot: number, h: number, segs: number,
  px: number, py: number, pz: number,
  color: number, rotZ = 0,
): void {
  const m = mesh(new THREE.CylinderGeometry(rTop, rBot, h, segs), makeMat(color));
  m.position.set(px, py, pz);
  if (rotZ) m.rotation.z = rotZ;
  g.add(m);
}

function addSphere(
  g: THREE.Group, r: number, segs: number,
  px: number, py: number, pz: number,
  color: number, emissive = 0, emInt = 0.0,
): void {
  const m = mesh(new THREE.SphereGeometry(r, segs, Math.ceil(segs * 0.7)), makeMat(color, emissive, emInt));
  m.position.set(px, py, pz);
  g.add(m);
}

// ─── Vehicle box models ───────────────────────────────────────────────────────
// All models face local +X. Origin at ground-centre of vehicle.

function makeMotorcycle(color = 0x1e293b): THREE.Group {
  const g = new THREE.Group();
  const c = color, grey = 0x374151, black = 0x0f172a, chrome = 0x94a3b8, amber = 0xfef3c7;
  addBox(g, 1.6, 0.38, 0.5,  0, 0.48, 0, c);
  addBox(g, 0.9, 0.38, 0.52, 0.1, 0.8, 0, c);
  addBox(g, 0.7, 0.28, 0.48, 0.05, 1.0, 0, c);
  addBox(g, 0.88, 0.10, 0.45, -0.18, 1.08, 0, 0x0f172a);
  addBox(g, 0.22, 0.52, 0.50, 0.82, 0.80, 0, grey);
  addBox(g, 0.40, 0.10, 0.38, 0.76, 0.55, 0, grey);
  addBox(g, 0.08, 0.07, 0.80, 0.62, 1.14, 0, chrome);
  addBox(g, 0.10, 0.18, 0.28, 0.96, 0.92, 0, amber, amber, 0.6);
  addBox(g, 0.08, 0.12, 0.22, -0.96, 0.88, 0, 0xdc2626, 0xdc2626, 0.4);
  const wGeo = new THREE.CylinderGeometry(0.30, 0.30, 0.14, 12);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  const hGeo = new THREE.CylinderGeometry(0.11, 0.11, 0.16, 8);
  for (const [x, z] of [[0.68, 0.33], [0.68, -0.33], [-0.68, 0.33], [-0.68, -0.33]]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.30, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.30, z); g.add(h);
  }
  return g;
}

function makeCar(color = 0x1d4ed8): THREE.Group {
  const g = new THREE.Group();
  const chrome = 0xb0b8c8, black = 0x0f172a, glass = 0x1e3a5f;
  addBox(g, 4.1, 0.80, 1.68, 0, 0.60, 0, color);
  addBox(g, 4.1, 0.25, 1.62, 0, 1.05, 0, color);
  addBox(g, 2.10, 0.70, 1.54, -0.22, 1.47, 0, color);
  addBox(g, 0.08, 0.60, 1.42, 0.82, 1.42, 0, glass);
  addBox(g, 0.08, 0.55, 1.36, -1.26, 1.40, 0, glass);
  for (const z of [0.78, -0.78]) addBox(g, 1.80, 0.50, 0.04, -0.22, 1.46, z, glass);
  addBox(g, 0.22, 0.50, 1.65, 2.16, 0.38, 0, chrome);
  addBox(g, 0.22, 0.48, 1.65, -2.16, 0.36, 0, chrome);
  addBox(g, 0.08, 0.28, 1.40, 2.18, 0.70, 0, black);
  for (const z of [0.68, -0.68]) addBox(g, 0.12, 0.20, 0.38, 2.14, 0.82, z, 0xfef9c3, 0xfef9c3, 0.5);
  for (const z of [0.68, -0.68]) addBox(g, 0.10, 0.18, 0.34, -2.14, 0.82, z, 0xdc2626, 0xdc2626, 0.4);
  const wGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.20, 14);
  const hGeo = new THREE.CylinderGeometry(0.13, 0.13, 0.22, 8);
  const wMat = makeMat(black); const hMat = makeMat(0x94a3b8);
  for (const [x, z] of [[1.28, 0.88], [1.28, -0.88], [-1.28, 0.88], [-1.28, -0.88]]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.32, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.32, z); g.add(h);
  }
  return g;
}

function makeJeepney(color = 0xf1f5f9): THREE.Group {
  const g = new THREE.Group();
  const chrome = 0xc8d0dc, black = 0x0f172a, glass = 0x172554;
  addBox(g, 5.80, 1.20, 1.98, -0.30, 0.80, 0, color);
  addBox(g, 1.10, 0.65, 1.92, 2.65, 1.73, 0, color);
  addBox(g, 5.60, 0.75, 1.90, -0.30, 1.60, 0, 0xe8ecf0);
  addBox(g, 5.60, 0.14, 2.36, -0.40, 2.10, 0, 0xd0d4dc);
  addBox(g, 0.20, 1.10, 1.96, 3.10, 0.96, 0, chrome);
  for (const y of [0.55, 0.78, 1.01, 1.24]) addBox(g, 0.22, 0.06, 1.90, 3.10, y, 0, 0x6b7280);
  for (const z of [-0.65, 0, 0.65]) addBox(g, 0.22, 0.95, 0.06, 3.10, 0.78, z, 0x6b7280);
  addBox(g, 0.16, 0.30, 2.25, 3.22, 0.30, 0, chrome);
  for (const z of [-0.72, 0, 0.72]) addBox(g, 0.22, 0.28, 0.06, 3.14, 0.30, z, 0x94a3b8);
  addCyl(g, 0.06, 0.04, 0.28, 6, 3.22, 0.60, 0, chrome);
  addSphere(g, 0.13, 8, 3.22, 0.80, 0, chrome);
  for (const z of [1.01, -1.01]) {
    addBox(g, 4.80, 0.40, 0.04, -0.30, 0.82, z, 0xdc2626);
    addBox(g, 4.80, 0.16, 0.04, -0.30, 0.54, z, 0xf59e0b);
    for (const x of [-1.0, 1.0]) addBox(g, 0.38, 0.28, 0.04, x, 1.50, z, 0x1e40af);
  }
  addBox(g, 0.08, 0.56, 1.82, 3.16, 1.72, 0, glass);
  for (const z of [0.96, -0.96]) {
    for (const x of [-1.8, -0.6, 0.6]) addBox(g, 0.80, 0.55, 0.04, x, 1.60, z, glass);
  }
  for (const z of [0.68, -0.68]) {
    addBox(g, 0.12, 0.20, 0.22, 3.24, 1.05, z, 0xfef9c3, 0xfef9c3, 0.7);
    addCyl(g, 0.14, 0.14, 0.02, 10, 3.24, 1.05, z, chrome);
  }
  for (const z of [0.68, -0.68]) addBox(g, 0.10, 0.22, 0.28, -3.18, 0.88, z, 0xdc2626, 0xdc2626, 0.5);
  addBox(g, 0.16, 0.28, 2.10, -3.20, 0.30, 0, chrome);
  const wGeo = new THREE.CylinderGeometry(0.41, 0.41, 0.22, 14);
  const hGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.24, 8);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  for (const [x, y, z] of [
    [2.10, 0.41,  1.08], [2.10, 0.41, -1.08],
    [-1.65, 0.41,  1.18], [-1.65, 0.41, -1.18],
    [-1.65, 0.41,  0.70], [-1.65, 0.41, -0.70],
  ] as [number, number, number][]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, y, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, y, z); g.add(h);
  }
  return g;
}

function makeBus(color = 0xffd700): THREE.Group {
  const g = new THREE.Group();
  const black = 0x0f172a, glass = 0x172554, chrome = 0x94a3b8;
  addBox(g, 10.6, 2.80, 2.48, -0.20, 1.58, 0, color);
  addBox(g, 10.4, 0.22, 2.52, -0.20, 3.08, 0, 0x166534);
  addBox(g, 0.24, 2.60, 2.44, 5.34, 1.68, 0, 0x14532d);
  addBox(g, 0.10, 1.50, 2.20, 5.36, 2.42, 0, glass);
  addBox(g, 0.10, 0.50, 1.90, 5.36, 3.28, 0, 0xfef3c7, 0xfef3c7, 0.4);
  addBox(g, 0.28, 0.50, 2.55, 5.50, 0.40, 0, chrome);
  addBox(g, 0.20, 2.60, 2.44, -5.50, 1.68, 0, 0x14532d);
  addBox(g, 0.10, 1.20, 2.10, -5.52, 2.60, 0, glass);
  for (let i = 0; i < 7; i++) {
    for (const z of [1.26, -1.26]) addBox(g, 1.05, 0.80, 0.04, 3.80 - i * 1.32, 2.40, z, glass);
  }
  for (const z of [1.26, -1.26]) {
    addBox(g, 9.80, 0.32, 0.04, -0.20, 0.70, z, 0xfbbf24);
    addBox(g, 9.80, 0.12, 0.04, -0.20, 0.44, z, 0xfef08a);
  }
  for (const z of [0.82, -0.82]) addBox(g, 0.12, 0.22, 0.38, 5.50, 1.20, z, 0xfef9c3, 0xfef9c3, 0.6);
  for (const z of [0.82, -0.82]) addBox(g, 0.12, 0.36, 0.36, -5.52, 1.28, z, 0xdc2626, 0xdc2626, 0.5);
  const wGeo = new THREE.CylinderGeometry(0.54, 0.54, 0.28, 14);
  const hGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.30, 8);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  for (const [x, z] of [
    [4.20, 1.32], [4.20, -1.32],
    [-3.60, 1.44], [-3.60, -1.44], [-3.60, 0.84], [-3.60, -0.84],
  ]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.54, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.54, z); g.add(h);
  }
  return g;
}

function makeTruck(color = 0x92400e): THREE.Group {
  const g = new THREE.Group();
  const black = 0x0f172a, glass = 0x172554, chrome = 0x94a3b8;
  addBox(g, 5.20, 2.50, 2.18, -1.45, 1.50, 0, 0xe8ecf0);
  addBox(g, 5.18, 0.12, 2.20, -1.45, 2.78, 0, 0xd1d5db);
  for (const z of [1.10, -1.10]) addBox(g, 5.10, 2.30, 0.04, -1.45, 1.50, z, 0xf8fafc);
  addBox(g, 0.10, 2.50, 2.10, -4.08, 1.50, 0, 0xd1d5db);
  addBox(g, 2.60, 2.00, 2.14, 1.85, 1.15, 0, color);
  addBox(g, 2.58, 0.18, 2.16, 1.85, 2.22, 0, 0x78350f);
  addBox(g, 0.10, 1.20, 1.92, 3.13, 1.72, 0, glass);
  for (const z of [1.08, -1.08]) addBox(g, 1.80, 0.90, 0.04, 1.50, 1.62, z, glass);
  addBox(g, 0.24, 0.52, 2.20, 3.24, 0.46, 0, chrome);
  addBox(g, 0.10, 0.60, 1.88, 3.20, 1.10, 0, black);
  for (let i = 0; i < 4; i++) addBox(g, 0.12, 0.06, 1.85, 3.22, 0.82 + i * 0.16, 0, 0x4b5563);
  for (const z of [0.80, -0.80]) addBox(g, 0.12, 0.22, 0.36, 3.28, 1.26, z, 0xfef9c3, 0xfef9c3, 0.6);
  for (const z of [0.80, -0.80]) addBox(g, 0.12, 0.30, 0.32, -4.12, 1.30, z, 0xdc2626, 0xdc2626, 0.5);
  const wGeo = new THREE.CylinderGeometry(0.50, 0.50, 0.26, 12);
  const hGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.28, 8);
  const wMat = makeMat(black); const hMat = makeMat(chrome);
  for (const [x, z] of [
    [2.50, 1.16], [2.50, -1.16],
    [-2.60, 1.26], [-2.60, -1.26], [-2.60, 0.74], [-2.60, -0.74],
  ]) {
    const w = new THREE.Mesh(wGeo, wMat); w.rotation.x = Math.PI / 2; w.position.set(x, 0.50, z); w.castShadow = true; g.add(w);
    const h = new THREE.Mesh(hGeo, hMat); h.rotation.x = Math.PI / 2; h.position.set(x, 0.50, z); g.add(h);
  }
  return g;
}

const VEHICLE_MAKERS: Record<VehicleType, (c: number) => THREE.Group> = {
  MC:    makeMotorcycle,
  CAR:   makeCar,
  JEP:   makeJeepney,
  BUS:   makeBus,
  TRUCK: makeTruck,
};

const VEH_COLORS: Record<VehicleType, number[]> = {
  MC:    [0x1e293b, 0x7c3aed, 0xdc2626, 0x0369a1, 0x374151, 0xf97316],
  CAR:   [0x1d4ed8, 0xdc2626, 0xffffff, 0x166534, 0x374151, 0x92400e, 0x6d28d9],
  JEP:   [0xf1f5f9, 0xfef3c7, 0xfcfcfc, 0xe0e7ef],
  BUS:   [0xffd700, 0x15803d, 0xff8c00, 0xfff8dc],
  TRUCK: [0x92400e, 0x374151, 0xfef3c7, 0x0f172a, 0x166534],
};

function pickColor(type: VehicleType): number {
  const list = VEH_COLORS[type];
  return list[Math.floor(Math.random() * list.length)];
}

// ─── Traffic-light pole ───────────────────────────────────────────────────────

interface TLRefs {
  group: THREE.Group;
  matR: THREE.MeshLambertMaterial;
  matA: THREE.MeshLambertMaterial;
  matG: THREE.MeshLambertMaterial;
  ptR: THREE.PointLight;
  ptA: THREE.PointLight;
  ptG: THREE.PointLight;
}

function makeTrafficLight(): TLRefs {
  const g = new THREE.Group();
  const darkMat = makeMat(0x1a1f2e);
  const poleMat = makeMat(0x4b5563);

  addBox(g, 0.6, 0.12, 0.6, 0, 0.06, 0, 0x374151);
  addCyl(g, 0.09, 0.11, 5.0, 8, 0, 2.56, 0, 0x374151);

  const arm = mesh(new THREE.CylinderGeometry(0.055, 0.055, 2.2, 6), poleMat);
  arm.rotation.z = Math.PI / 2; arm.position.set(-1.1, 5.10, 0); g.add(arm);

  const housing = mesh(bx(0.50, 1.55, 0.42), darkMat);
  housing.position.set(-2.20, 5.10, 0); g.add(housing);

  addBox(g, 0.68, 0.08, 0.54, -2.20, 5.95, 0, 0x111827);
  for (const y of [4.72, 5.10]) addBox(g, 0.50, 0.06, 0.42, -2.20, y, 0, 0x111827);

  const lensGeo = new THREE.SphereGeometry(0.155, 12, 10);

  // Store materials so setTLPhase can mutate them in-place (no per-frame allocation)
  const matR = makeMat(0x7f1d1d, 0, 0, 0.85);
  const matA = makeMat(0x78350f, 0, 0, 0.85);
  const matG = makeMat(0x14532d, 0, 0, 0.85);

  const lensR = mesh(lensGeo, matR);
  lensR.position.set(-2.20, 5.60, 0.20); lensR.scale.z = 0.55; g.add(lensR);

  const lensA = mesh(lensGeo, matA);
  lensA.position.set(-2.20, 5.13, 0.20); lensA.scale.z = 0.55; g.add(lensA);

  const lensG = mesh(lensGeo, matG);
  lensG.position.set(-2.20, 4.66, 0.20); lensG.scale.z = 0.55; g.add(lensG);

  const ptR = new THREE.PointLight(0xef4444, 0, 12, 2); ptR.position.set(-2.20, 5.60, 0.6); g.add(ptR);
  const ptA = new THREE.PointLight(0xf59e0b, 0, 12, 2); ptA.position.set(-2.20, 5.13, 0.6); g.add(ptA);
  // Fixed: was (0x22c55e, 0, 10, 10, 2) — PointLight only takes 4 args, 5th was silently dropped
  // leaving decay=10 which killed the glow radius. Correct decay is 2 (physically-based).
  const ptG = new THREE.PointLight(0x22c55e, 0, 12, 2); ptG.position.set(-2.20, 4.66, 0.6); g.add(ptG);

  return { group: g, matR, matA, matG, ptR, ptA, ptG };
}

type SignalPhase = 'red' | 'amber' | 'green';

function setTLPhase(tl: TLRefs, phase: SignalPhase, blink = false): void {
  const showAmber = phase === 'amber' || (phase === 'red' && blink);
  const isRed   = phase === 'red' && !blink;
  const isGreen = phase === 'green';

  // Mutate existing materials — avoids allocating 12 new objects every frame
  tl.matR.color.setHex(isRed ? 0xef4444 : 0x7f1d1d);
  tl.matR.emissive.setHex(isRed ? 0xef4444 : 0x000000);
  tl.matR.emissiveIntensity = isRed ? 0.6 : 0;

  tl.matA.color.setHex(showAmber ? 0xf59e0b : 0x78350f);
  tl.matA.emissive.setHex(showAmber ? 0xf59e0b : 0x000000);
  tl.matA.emissiveIntensity = showAmber ? 0.6 : 0;

  tl.matG.color.setHex(isGreen ? 0x22c55e : 0x14532d);
  tl.matG.emissive.setHex(isGreen ? 0x22c55e : 0x000000);
  tl.matG.emissiveIntensity = isGreen ? 0.6 : 0;

  tl.ptR.intensity = isRed ? 2.5 : 0;
  tl.ptA.intensity = showAmber ? 2.0 : 0;
  tl.ptG.intensity = isGreen ? 3.0 : 0;
}

// ─── Phase logic ──────────────────────────────────────────────────────────────

function approachPhase(
  appIdx: number, t: number,
  g0: number, g1: number,
  signalOff: boolean, blinkOn: boolean,
): SignalPhase {
  if (signalOff) return blinkOn ? 'amber' : 'red';
  const cycle = g0 + ALL_RED + g1 + ALL_RED;
  if (cycle <= 0 || !isFinite(cycle)) return 'red';
  const tMod = ((t % cycle) + cycle) % cycle;
  const isNS = appIdx === 0 || appIdx === 2;
  if (isNS) {
    if (tMod < g0 - AMBER_S) return 'green';
    if (tMod < g0)            return 'amber';
    return 'red';
  } else {
    const p1Start = g0 + ALL_RED;
    const p1End   = p1Start + g1;
    if (tMod >= p1Start && tMod < p1End - AMBER_S) return 'green';
    if (tMod >= p1End - AMBER_S && tMod < p1End)   return 'amber';
    return 'red';
  }
}

function pedCanWalk(cwId: number, t: number, g0: number, g1: number, signalOff: boolean): boolean {
  if (signalOff) return false;
  const blockedApp = CW_DEFS[cwId].blockedApp;
  // Pedestrian WALK = the blocking vehicle phase is fully RED (not green, not amber)
  return approachPhase(blockedApp, t, g0, g1, false, false) === 'red';
}

// ─── Road scene ───────────────────────────────────────────────────────────────

function buildRoadScene(scene: THREE.Scene): void {
  // Ground
  const ground = mesh(new THREE.PlaneGeometry(200, 200), makeMat(0x111827));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

  // NS road
  const nsRoad = mesh(new THREE.PlaneGeometry(ROAD_W, ARM * 2 + BOX * 2), makeMat(0x1e2433));
  nsRoad.rotation.x = -Math.PI / 2; nsRoad.position.y = 0.01; scene.add(nsRoad);

  // EW road
  const ewRoad = mesh(new THREE.PlaneGeometry(ARM * 2 + BOX * 2, ROAD_W), makeMat(0x1e2433));
  ewRoad.rotation.x = -Math.PI / 2; ewRoad.position.y = 0.01; scene.add(ewRoad);

  // Intersection box overlay
  const box3d = mesh(new THREE.PlaneGeometry(ROAD_W, ROAD_W), makeMat(0x1e2d3d));
  box3d.rotation.x = -Math.PI / 2; box3d.position.y = 0.015; scene.add(box3d);

  // Lane dashes
  addDashes(scene, 0, 0.02, -(BOX + ARM / 2), 0, 1, 0.15, ARM / 2, 2.8, 1.4, 0x374151);
  addDashes(scene, 0, 0.02,  (BOX + ARM / 2), 0, 1, 0.15, ARM / 2, 2.8, 1.4, 0x374151);
  addDashes(scene, -(BOX + ARM / 2), 0.02, 0, 1, 0, 0.15, ARM / 2, 2.8, 1.4, 0x374151);
  addDashes(scene,  (BOX + ARM / 2), 0.02, 0, 1, 0, 0.15, ARM / 2, 2.8, 1.4, 0x374151);

  // Stop lines
  const slMat = makeMat(0xe5e7eb);
  for (const [x, z, w, h, d] of [
    [0, -(BOX + 0.2), ROAD_W * 0.45, 0.25, 0.1],
    [ (BOX + 0.2), 0,  0.1, 0.25, ROAD_W * 0.45],
    [0,  (BOX + 0.2), ROAD_W * 0.45, 0.25, 0.1],
    [-(BOX + 0.2), 0,  0.1, 0.25, ROAD_W * 0.45],
  ] as [number, number, number, number, number][]) {
    const sl = mesh(new THREE.BoxGeometry(w, h, d), slMat);
    sl.position.set(x, 0.02, z);
    scene.add(sl);
  }

  // Road edge lines
  const edgeMat = makeMat(0xfbbf24);
  for (const [x, z, w, d] of [
    [ ROAD_W / 2, 0, 0.12, ARM * 2 + BOX * 2],
    [-ROAD_W / 2, 0, 0.12, ARM * 2 + BOX * 2],
    [0,  ROAD_W / 2, ARM * 2 + BOX * 2, 0.12],
    [0, -ROAD_W / 2, ARM * 2 + BOX * 2, 0.12],
  ] as [number, number, number, number][]) {
    const edge = mesh(new THREE.BoxGeometry(w, 0.06, d), edgeMat);
    edge.position.set(x, 0.04, z);
    scene.add(edge);
  }

  // Sidewalk corners
  const swMat = makeMat(0x374151);
  for (const [x, z] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const corner = mesh(new THREE.BoxGeometry(8, 0.15, 8), swMat);
    corner.position.set(x * (BOX + 4), 0.07, z * (BOX + 4));
    scene.add(corner);
  }

  // Zebra crosswalk markings (4 arms)
  // Stripes run perpendicular to the pedestrian's walking direction.
  // NS arm crossings (peds walk E–W): stripes run N–S (along Z), spaced in X.
  // EW arm crossings (peds walk N–S): stripes run E–W (along X), spaced in Z.
  const xwMat = new THREE.MeshLambertMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0.88 });
  const stripeCount = Math.floor(ROAD_W / 0.85);
  const startOff = -((stripeCount - 1) / 2) * 0.85;
  for (let i = 0; i < stripeCount; i++) {
    const off = startOff + i * 0.85;

    // N arm (z = –XWALK_POS): stripes along Z, spaced in X
    const sN = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.04, 3.2), xwMat);
    sN.position.set(off, 0.026, -XWALK_POS); scene.add(sN);

    // S arm
    const sS = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.04, 3.2), xwMat);
    sS.position.set(off, 0.026,  XWALK_POS); scene.add(sS);

    // E arm (x = +XWALK_POS): stripes along X, spaced in Z
    const sE = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.04, 0.52), xwMat);
    sE.position.set( XWALK_POS, 0.026, off); scene.add(sE);

    // W arm
    const sW = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.04, 0.52), xwMat);
    sW.position.set(-XWALK_POS, 0.026, off); scene.add(sW);
  }
}

function addDashes(
  scene: THREE.Scene,
  cx: number, cy: number, cz: number,
  dx: number, _dy: number, dz: number,
  totalLength: number, dashLen: number, gapLen: number,
  color: number,
): void {
  const period = dashLen + gapLen;
  const count  = Math.floor(totalLength / period);
  const mat    = makeMat(color);
  for (let i = 0; i < count; i++) {
    const offset = -totalLength / 2 + i * period + dashLen / 2;
    const m = mesh(new THREE.BoxGeometry(
      0.14 + Math.abs(dz) * dashLen,
      0.06,
      0.14 + Math.abs(dx) * dashLen,
    ), mat);
    m.position.set(cx + dx * offset, cy, cz + dz * offset);
    scene.add(m);
  }
}

// ─── Simulation state types ───────────────────────────────────────────────────

interface Veh {
  id: number;
  type: VehicleType;
  app: number;
  dist: number;   // distance ahead of stop line (positive = queued)
  speed: number;
  obj: THREE.Group;
}

interface Ped {
  id: number;
  cwId: number;       // crosswalk index (0–3)
  progress: number;   // 0 = start edge, 1 = far edge
  obj: THREE.Group;
  mixer: THREE.AnimationMixer;
  walkAction: THREE.AnimationAction | null;
}

const APP_ROT: number[] = [
  -Math.PI / 2,   // 0 southbound
   Math.PI,       // 1 westbound
   Math.PI / 2,   // 2 northbound
   0,             // 3 eastbound
];

function placeVehicle(v: Veh): void {
  const p = VPARAMS[v.type];
  const d = v.dist + p.len / 2;
  switch (v.app) {
    case 0: v.obj.position.set( LANE, 0, -(BOX + d)); break;
    case 1: v.obj.position.set( BOX + d, 0, -LANE);   break;
    case 2: v.obj.position.set(-LANE, 0,  BOX + d);   break;
    case 3: v.obj.position.set(-(BOX + d), 0,  LANE); break;
  }
}

function placePed(p: Ped): void {
  const cw = CW_DEFS[p.cwId];
  p.obj.position.set(
    cw.startX + cw.dx * p.progress * ROAD_W,
    0,
    cw.startZ + cw.dz * p.progress * ROAD_W,
  );
}

// ─── GLB model helpers ───────────────────────────────────────────────────────

function cloneGLBWithColor(gltf: GLTF, hexColor: number): THREE.Group {
  const obj = gltf.scene.clone(true) as THREE.Group;
  obj.traverse((child) => {
    const m = child as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    m.material = mats.map((mat) => {
      const clone = (mat as THREE.Material).clone();
      if ('color' in clone) (clone as THREE.MeshStandardMaterial).color.setHex(hexColor);
      return clone;
    });
    m.castShadow = true;
  });
  return obj;
}

// ─── React component ──────────────────────────────────────────────────────────

export interface IntersectionScene3DProps {
  timing: TimingChunk;
  streets: Street[];
  signalOff: boolean;
  volumePcuHr: number;
  typeMix: Record<string, TypeFractions>;
  showBefore?: boolean;
  signalStatus?: string;
  existingCycleS?: number | null;
  existingGreenSplits?: Record<string, number> | null;
  paused?: boolean;
  speed?: number;
  height?: number;
}

export function IntersectionScene3D({
  timing, streets, signalOff, volumePcuHr, typeMix,
  showBefore = false, signalStatus, existingCycleS, existingGreenSplits,
  paused = false, speed = 1, height = 480,
}: IntersectionScene3DProps) {
  const mountRef = useRef<HTMLDivElement>(null);

  // Refs let us change pause/speed without tearing down the whole WebGL scene
  const pausedRef = useRef(false);
  const speedRef  = useRef(1);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { speedRef.current  = speed;  }, [speed]);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    let disposed  = false;
    let cleanupFn: (() => void) | undefined;

    // Load all GLB models concurrently; simulation starts once every request settles.
    const loader = new GLTFLoader();
    type MKey = 'car' | 'car2' | 'suv' | 'taxi' | 'sportsCar' | 'sportsCar2' | 'policeCar'
              | 'truck' | 'scooter' | 'tricycle'
              | 'man' | 'man2' | 'manSleeves' | 'manSuit';
    const MODEL_URLS: Record<MKey, string> = {
      car:        '/models/Car.glb',
      car2:       '/models/Car-unqqkULtRU.glb',
      suv:        '/models/SUV.glb',
      taxi:       '/models/Taxi.glb',
      sportsCar:  '/models/Sports%20Car.glb',
      sportsCar2: '/models/Sports%20Car-1mkmFkAz5v.glb',
      policeCar:  '/models/Police%20Car.glb',
      truck:      '/models/Truck.glb',
      scooter:    '/models/Scooter.glb',
      tricycle:   '/models/philippine_tricycle.glb',
      man:        '/models/Man.glb',
      man2:       '/models/Man-fjHyMd5Wxw.glb',
      manSleeves: '/models/Man%20in%20Long%20Sleeves.glb',
      manSuit:    '/models/Man%20in%20Suit.glb',
    };
    const gltfs: Partial<Record<MKey, GLTF>> = {};
    const TOTAL = Object.keys(MODEL_URLS).length;
    let loadedCount = 0;

    function tryStart() {
      loadedCount++;
      if (loadedCount >= TOTAL && !disposed) cleanupFn = run(el, gltfs);
    }

    for (const [key, url] of Object.entries(MODEL_URLS) as [MKey, string][]) {
      loader.load(url,
        (g) => { gltfs[key] = g; tryStart(); },
        undefined,
        () => tryStart(),
      );
    }

    return () => {
      disposed = true;
      cleanupFn?.();
    };

    // ── Inner setup (runs once all GLTFs are settled) ────────────────────────
    function run(container: HTMLDivElement, gltfs: Partial<Record<string, GLTF>>): () => void {
      // Renderer
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.setClearColor(0x0a0f1a);
      container.appendChild(renderer.domElement);

      const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 800);
      let theta = Math.PI * 0.35, phi = Math.PI * 0.30, radius = 130;

      function updateCamera() {
        camera.position.set(
          radius * Math.sin(phi) * Math.sin(theta),
          radius * Math.cos(phi),
          radius * Math.sin(phi) * Math.cos(theta),
        );
        camera.lookAt(0, 2, 0);
      }
      updateCamera();

      const resize = () => {
        const w = container.clientWidth, h = container.clientHeight;
        renderer.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const ro = new ResizeObserver(resize);
      ro.observe(container);
      resize();

      // Mouse orbit
      let dragging = false, lastMX = 0, lastMY = 0;
      const onMouseDown = (e: MouseEvent) => { dragging = true; lastMX = e.clientX; lastMY = e.clientY; };
      const onMouseUp   = () => { dragging = false; };
      const onMouseMove = (e: MouseEvent) => {
        if (!dragging) return;
        theta -= (e.clientX - lastMX) * 0.008;
        phi    = Math.max(0.15, Math.min(Math.PI / 2 - 0.05, phi - (e.clientY - lastMY) * 0.006));
        lastMX = e.clientX; lastMY = e.clientY;
        updateCamera();
      };
      const onWheel = (e: WheelEvent) => {
        radius = Math.max(50, Math.min(220, radius + e.deltaY * 0.08));
        updateCamera();
        e.preventDefault();
      };
      renderer.domElement.addEventListener('mousedown', onMouseDown);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('mousemove', onMouseMove);
      renderer.domElement.addEventListener('wheel', onWheel, { passive: false });

      // Scene
      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x0a0f1a, 0.006);
      scene.add(new THREE.AmbientLight(0x1e2d45, 2.2));
      const sun = new THREE.DirectionalLight(0xfdf4dc, 2.5);
      sun.position.set(40, 80, 30);
      sun.castShadow = true;
      sun.shadow.mapSize.setScalar(2048);
      sun.shadow.camera.near = 1; sun.shadow.camera.far = 300;
      const sc = 90; Object.assign(sun.shadow.camera, { left: -sc, right: sc, top: sc, bottom: -sc });
      scene.add(sun);
      scene.add(new THREE.DirectionalLight(0x3b6ca8, 0.6).position.set(-30, 20, -40));

      buildRoadScene(scene);

      // Traffic lights — one per corner, arm points toward intersection centre.
      // arm direction (local -X) → world (-cos ry, 0, sin ry); correct ry per corner:
      //   NE (+x, -z): arm → SW (-1/√2, 0, +1/√2)  → ry = π/4
      //   SE (+x, +z): arm → NW (-1/√2, 0, -1/√2)  → ry = -π/4
      //   SW (-x, +z): arm → NE (+1/√2, 0, -1/√2)  → ry = -3π/4
      //   NW (-x, -z): arm → SE (+1/√2, 0, +1/√2)  → ry = 3π/4
      const tlConfigs = [
        { x:  BOX + 2.0, z: -(BOX + 2.0), rotY:  Math.PI / 4 },          // NE — SB
        { x:  BOX + 2.0, z:  BOX + 2.0,   rotY: -Math.PI / 4 },          // SE — WB
        { x: -(BOX + 2.0), z:  BOX + 2.0, rotY: -3 * Math.PI / 4 },      // SW — NB
        { x: -(BOX + 2.0), z: -(BOX + 2.0), rotY: 3 * Math.PI / 4 },     // NW — EB
      ];
      const tls: TLRefs[] = tlConfigs.map(cfg => {
        const tl = makeTrafficLight();
        tl.group.position.set(cfg.x, 0, cfg.z);
        tl.group.rotation.y = cfg.rotY;
        scene.add(tl.group);
        return tl;
      });

      // Signal-off flag: before-state uses intersection signal_status;
      // after-state (Webster timing) uses the signalOff prop from the timing chunk.
      const effectiveSignalOff = showBefore
        ? (signalStatus !== 'fixed_time' && signalStatus !== 'actuated')
        : signalOff;

      // Phase green times — before mode uses existing splits, after uses Webster splits
      const approachGreen: (number | undefined)[] = [undefined, undefined, undefined, undefined];
      const splits = showBefore ? (existingGreenSplits ?? null) : timing.green_splits;
      if (splits) {
        for (const s of streets) {
          const ai = DIR_TO_APP[s.arm_direction];
          if (ai !== undefined) {
            const g = splits[String(s.id)];
            if (g !== undefined) approachGreen[ai] = g;
          }
        }
      }
      const effectiveCycle = (showBefore ? existingCycleS : null) ?? timing.cycle_length ?? 90;
      const rawG0 = approachGreen[0] ?? approachGreen[2] ?? effectiveCycle * 0.55;
      const rawG1 = approachGreen[1] ?? approachGreen[3] ?? effectiveCycle * 0.45;
      const g0 = Math.max(isFinite(rawG0) ? rawG0 : 45, 5);
      const g1 = Math.max(isFinite(rawG1) ? rawG1 : 35, 5);

      // Vehicle pool
      const vehicles: Veh[] = [];
      let nextVehId = 0;
      const nextSpawn: number[] = [0, 0, 0, 0].map(() => 0);
      const perApproachVolume = Math.max(volumePcuHr / 4, 150);

      const avgMix: TypeFractions = { ...DEFAULT_MIX };
      const mixVals = Object.values(typeMix);
      if (mixVals.length > 0) {
        for (const t of VEH_TYPES) avgMix[t] = mixVals.reduce((s, m) => s + (m[t] ?? 0), 0) / mixVals.length;
      }

      // Pedestrian pool
      const peds: Ped[] = [];
      let nextPedId = 0;
      // Track whether each crosswalk was walkable last tick (to detect phase transitions)
      const cwWalkablePrev: boolean[] = [false, false, false, false];
      // Stagger spawn offsets per crosswalk
      const pedSpawnCooldown: number[] = [0, 0, 0, 0];

      // Pedestrian model pool — pick randomly from available man GLBs
      const pedGLTFs = (['man', 'man2', 'manSleeves', 'manSuit'] as const)
        .map(k => gltfs[k]).filter(Boolean) as GLTF[];

      function spawnPed(cwId: number): void {
        if (pedGLTFs.length === 0) return;
        const src = pedGLTFs[Math.floor(Math.random() * pedGLTFs.length)];
        const obj = skeletonClone(src.scene) as THREE.Group;
        obj.scale.setScalar(PED_SCALE);
        // atan2(dx, dz) gives the Y rotation that aligns local +Z with movement direction
        const cw = CW_DEFS[cwId];
        obj.rotation.y = Math.atan2(cw.dx, cw.dz);

        const mixer = new THREE.AnimationMixer(obj);
        const clip = src.animations.find(a => /walk/i.test(a.name)) ?? src.animations[0] ?? null;
        let walkAction: THREE.AnimationAction | null = null;
        if (clip) { walkAction = mixer.clipAction(clip); walkAction.play(); }

        const ped: Ped = { id: nextPedId++, cwId, progress: 0, obj, mixer, walkAction };
        placePed(ped);
        scene.add(obj);
        peds.push(ped);
      }

      // ── Vehicle GLB pool with per-model scale + facing correction ──────────────
      // GLB models export at varying scales and can face +X or +Z.
      // We measure each model's bounding box, normalise to target length, and
      // detect the facing axis: Z-elongated → faces +Z → needs +π/2 offset so
      // the model aligns with APP_ROT (which was designed for +X-facing models).
      const GLB_TARGET_LEN: Partial<Record<string, number>> = {
        car: 4.4, car2: 4.4, suv: 4.6, taxi: 4.4,
        sportsCar: 4.2, sportsCar2: 4.2, policeCar: 4.8,
        truck: 8.5, scooter: 1.8, tricycle: 2.2,
      };
      type GLBEntry = { gltf: GLTF; scale: number; rotOffset: number };
      function makeEntry(key: string): GLBEntry | null {
        const gltf = gltfs[key as keyof typeof gltfs];
        if (!gltf) return null;
        const target = GLB_TARGET_LEN[key];
        if (!target) return { gltf, scale: 1, rotOffset: 0 };
        const box  = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        const facingZ = size.z > size.x;           // model is elongated along Z → faces +Z
        const major   = Math.max(size.x, size.z);
        const scale   = major > 0.01 ? target / major : 1;
        const rotOffset = facingZ ? Math.PI / 2 : 0;
        return { gltf, scale, rotOffset };
      }
      function buildPool(keys: readonly string[]): GLBEntry[] {
        return keys.map(makeEntry).filter((e): e is GLBEntry => e !== null);
      }

      const CAR_POOL   = buildPool(['car', 'car2', 'suv', 'taxi', 'sportsCar', 'sportsCar2', 'policeCar']);
      const MC_POOL    = buildPool(['scooter', 'tricycle']);
      const TRUCK_POOL = buildPool(['truck']);

      function pickEntry(pool: GLBEntry[]): GLBEntry { return pool[Math.floor(Math.random() * pool.length)]; }

      function spawnVehicle(app: number) {
        const type = sampleType(avgMix);

        let obj: THREE.Group;
        let pool: GLBEntry[] | null = null;
        if      (type === 'CAR'   && CAR_POOL.length)   pool = CAR_POOL;
        else if (type === 'MC'    && MC_POOL.length)     pool = MC_POOL;
        else if (type === 'TRUCK' && TRUCK_POOL.length)  pool = TRUCK_POOL;

        if (pool) {
          const { gltf: src, scale, rotOffset } = pickEntry(pool);
          const isTricycle = src === gltfs['tricycle'];
          obj = cloneGLBWithColor(src, isTricycle ? TRICYCLE_GREEN : pickColor(type));
          obj.scale.setScalar(scale);
          obj.rotation.y = APP_ROT[app] + rotOffset;
        } else {
          obj = VEHICLE_MAKERS[type](pickColor(type));
          obj.rotation.y = APP_ROT[app];
        }

        scene.add(obj);

        const tail = vehicles
          .filter(v => v.app === app)
          .reduce((mx, v) => Math.max(mx, v.dist + VPARAMS[v.type].len / 2), 0);
        const p    = VPARAMS[type];
        const dist = Math.max(tail + p.gap + p.len / 2, ARM - p.len / 2);
        vehicles.push({ id: nextVehId++, type, app, dist, speed: 0, obj });
      }

      // Pre-populate: fill each approach arm with vehicles so the scene isn't empty on load
      for (let app = 0; app < 4; app++) {
        for (let i = 0; i < 10; i++) spawnVehicle(app);
      }

      let simTime = 0, blinkOn = true, lastT = performance.now();

      // pausedRef and speedRef are stable ref objects from the component scope.
      // Reading .current inside animate always gets the latest value without a remount.

      function update(dt: number) {
        simTime += dt;
        blinkOn  = Math.floor(simTime) % 2 === 0;

        // Update traffic lights
        for (let ai = 0; ai < 4; ai++) {
          const phase = approachPhase(ai, simTime, g0, g1, effectiveSignalOff, blinkOn);
          setTLPhase(tls[ai], phase, effectiveSignalOff && !blinkOn);
        }

        // Vehicle spawning
        for (let app = 0; app < 4; app++) {
          nextSpawn[app] -= dt;
          if (nextSpawn[app] <= 0) {
            if (vehicles.filter(v => v.app === app).length < 18) spawnVehicle(app);
            const rate = perApproachVolume / 3600;
            nextSpawn[app] = -Math.log(Math.random() + 0.001) / rate;
          }
        }

        // Vehicle physics
        for (let i = vehicles.length - 1; i >= 0; i--) {
          const v = vehicles[i];
          const p = VPARAMS[v.type];
          const phase = approachPhase(v.app, simTime, g0, g1, effectiveSignalOff, blinkOn);
          // Signal-off: alternate NS/EW priority every 10 sim-s to prevent all four approaches
          // entering the box at the same time. Vehicles already past the stop line always clear.
          const gapAxis = Math.floor(simTime / 10) % 2; // 0 = N-S, 1 = E-W
          const canGo = phase === 'green'
            || (effectiveSignalOff && (v.dist < 0 || v.app % 2 === gapAxis));

          let gapAhead = Infinity;
          for (const other of vehicles) {
            if (other === v || other.app !== v.app) continue;
            const gap = (other.dist - VPARAMS[other.type].len / 2) - (v.dist + p.len / 2);
            if (gap > -0.5 && gap < gapAhead) gapAhead = gap;
          }

          let target = 0;
          if (v.dist > 0) {
            if (canGo && gapAhead > p.gap) target = p.spd;
          } else {
            target = p.spd * 0.8;
          }
          if (gapAhead < p.gap + 0.5) target = Math.min(target, Math.max(0, (gapAhead - p.gap) * 3));

          if (v.speed < target) v.speed = Math.min(target, v.speed + p.dec * 0.4 * dt);
          else                   v.speed = Math.max(target, v.speed - p.dec * dt);
          v.speed = Math.max(0, v.speed);
          v.dist -= v.speed * dt;

          if (v.dist < -(ARM + p.len)) {
            scene.remove(v.obj);
            v.obj.traverse(c => { if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).geometry.dispose(); });
            vehicles.splice(i, 1);
            continue;
          }
          placeVehicle(v);
        }

        // Pedestrian crossings
        if (pedGLTFs.length > 0) {
          for (let cwId = 0; cwId < 4; cwId++) {
            const canWalk = pedCanWalk(cwId, simTime, g0, g1, effectiveSignalOff);
            const wasWalkable = cwWalkablePrev[cwId];

            // Spawn 1–2 peds at the start of each WALK phase
            if (canWalk && !wasWalkable) {
              const count = peds.filter(p => p.cwId === cwId).length;
              const toSpawn = Math.floor(Math.random() * 2) + 1;
              for (let k = 0; k < toSpawn && count + k < 3; k++) {
                pedSpawnCooldown[cwId] = k * 0.8; // slight stagger
              }
            }

            if (canWalk && pedSpawnCooldown[cwId] > 0) {
              pedSpawnCooldown[cwId] -= dt;
              if (pedSpawnCooldown[cwId] <= 0) {
                const count = peds.filter(p => p.cwId === cwId).length;
                if (count < 3) spawnPed(cwId);
              }
            }

            cwWalkablePrev[cwId] = canWalk;
          }

          // Move and update pedestrians
          for (let i = peds.length - 1; i >= 0; i--) {
            const p = peds[i];
            const canWalk = pedCanWalk(p.cwId, simTime, g0, g1, effectiveSignalOff);

            if (canWalk) {
              p.progress += (PED_SPEED / ROAD_W) * dt;
              if (p.walkAction && !p.walkAction.isRunning()) p.walkAction.play();
            } else {
              // Stop in place at red; pause walk animation
              if (p.walkAction && p.walkAction.isRunning()) p.walkAction.stop();
            }

            p.mixer.update(dt);
            placePed(p);

            if (p.progress >= 1) {
              scene.remove(p.obj);
              peds.splice(i, 1);
            }
          }
        }
      }

      let rafId = 0;
      function animate(now: number) {
        rafId = requestAnimationFrame(animate);
        const rawDt = Math.min((now - lastT) / 1000, 0.1);
        lastT = now;
        if (!pausedRef.current) update(rawDt * speedRef.current);
        renderer.render(scene, camera);
      }
      rafId = requestAnimationFrame(animate);

      return () => {
        cancelAnimationFrame(rafId);
        ro.disconnect();
        renderer.domElement.removeEventListener('mousedown', onMouseDown);
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('mousemove', onMouseMove);
        renderer.domElement.removeEventListener('wheel', onWheel);
        renderer.dispose();
        if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
      };
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timing.id, signalOff, showBefore]);

  return (
    <div
      ref={mountRef}
      style={{ width: '100%', height, borderRadius: 8, cursor: 'grab', background: '#0a0f1a' }}
    />
  );
}
