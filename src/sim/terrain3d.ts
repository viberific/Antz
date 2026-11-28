import * as THREE from 'three';
import { AntColonySimulation } from './colony';
import {
  MaterialBank,
  SOIL_BACK_Z,
  SOIL_FRONT_Z,
  TANK_HALF_DEPTH,
  WORLD_SCALE,
  simToWorldX,
  simToWorldY,
} from './materials3d';
import {
  CASE_BOTTOM,
  CASE_LEFT,
  CASE_RIGHT,
  CASE_TOP,
  CELL_SIZE,
  CellType,
  GRID_H,
  GRID_W,
} from './types';

const MAX_GRANULES = 44000;
const SOLID_FRONT_Z = SOIL_FRONT_Z - 0.035;
const CURVED_RIM_Z = SOLID_FRONT_Z - 0.055;
const CURVED_DEEP_Z = SOIL_BACK_Z - 0.14; // Half-depth concave cavern dome recess
const ISO_LEVEL = 0.5;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function srgbToLin(c: number): number {
  return c <= 0.04045 ? c * (1 / 12.92) : Math.pow((c + 0.055) / 1.055, 2.4);
}

const _col = new THREE.Color();

/**
 * A reusable, growable typed-array buffer for rebuilding meshes.
 *
 * The soil mesh is rebuilt every second or so while ants dig, with ~150k vertices. Building it in plain JS arrays
 * produced hundreds of MB of garbage a minute, and on memory-tight Android phones Chrome killed the tab. These keep
 * their storage between rebuilds; only the exact-size copy handed to the GPU is new each time.
 */
class ScratchF32 {
  private buf: Float32Array;
  public length = 0;
  constructor(initial = 4096) {
    this.buf = new Float32Array(initial);
  }
  public reset(): void {
    this.length = 0;
  }
  private grow(need: number): void {
    let cap = this.buf.length;
    while (cap < need) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  public push2(a: number, b: number): void {
    if (this.length + 2 > this.buf.length) this.grow(this.length + 2);
    const o = this.length;
    this.buf[o] = a;
    this.buf[o + 1] = b;
    this.length = o + 2;
  }
  public push3(a: number, b: number, c: number): void {
    if (this.length + 3 > this.buf.length) this.grow(this.length + 3);
    const o = this.length;
    this.buf[o] = a;
    this.buf[o + 1] = b;
    this.buf[o + 2] = c;
    this.length = o + 3;
  }
  public get(i: number): number {
    return this.buf[i];
  }
  /** An exact-size copy that the geometry can own. */
  public take(): Float32Array {
    return this.buf.slice(0, this.length);
  }
}

class ScratchU32 {
  private buf: Uint32Array;
  public length = 0;
  constructor(initial = 4096) {
    this.buf = new Uint32Array(initial);
  }
  public reset(): void {
    this.length = 0;
  }
  public push6(a: number, b: number, c: number, d: number, e: number, f: number): void {
    if (this.length + 6 > this.buf.length) {
      let cap = this.buf.length;
      while (cap < this.length + 6) cap *= 2;
      const next = new Uint32Array(cap);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
    }
    const o = this.length;
    this.buf[o] = a;
    this.buf[o + 1] = b;
    this.buf[o + 2] = c;
    this.buf[o + 3] = d;
    this.buf[o + 4] = e;
    this.buf[o + 5] = f;
    this.length = o + 6;
  }
  public take(): Uint32Array {
    return this.buf.slice(0, this.length);
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function deterministicRand(gx: number, gy: number, salt: number): number {
  const n = Math.sin(gx * 12.9898 + gy * 78.233 + salt * 37.719) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Maps smoothed cavity distance (in cells from nearest solid wall) to concave Z depth.
 * Quarter-ellipse profile produces steep cylindrical walls near rims and deep arched cavern domes.
 */
export function cavityDepthToZ(depthCells: number): number {
  const t = clamp(depthCells / 3.4, 0, 1);
  const arch = Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)));
  return CURVED_RIM_Z - arch * (CURVED_RIM_Z - CURVED_DEEP_Z);
}

/**
 * Returns rich dark-brown soil sRGB values (converted cleanly to linear on setRGB).
 */
function granuleColorSrgb(type: CellType, moisture: number, gy: number, tint: number): [number, number, number] {
  const mDark = 1 - Math.min(0.32, moisture * 0.28);
  const v = 0.82 + tint * 0.34;
  if (type === CellType.TOPSOIL) {
    return [0.15 * mDark * v, 0.088 * mDark * v, 0.052 * mDark * v];
  }
  if (type === CellType.SUBSOIL) {
    const depthMix = Math.min(1, Math.max(0, (gy - 48) / 60));
    const r = (0.215 - depthMix * 0.045) * mDark * v;
    const g = (0.128 - depthMix * 0.03) * mDark * v;
    const b = (0.072 - depthMix * 0.018) * mDark * v;
    return [r, g, b];
  }
  if (type === CellType.DEEP_CLAY) {
    return [0.135 * mDark * v, 0.078 * mDark * v, 0.046 * mDark * v];
  }
  if (type === CellType.PEBBLE) {
    // the stone itself is a separate mesh; the soil under and around it stays earth-coloured so it leaves no grey haze
    return [0.13 * v, 0.078 * v, 0.046 * v];
  }
  if (type === CellType.ROOT) {
    return [0.18 * mDark * v, 0.105 * mDark * v, 0.06 * mDark * v];
  }
  return [0.16 * v, 0.095 * v, 0.055 * v];
}

const ROCK_PALETTE: [number, number, number][] = [
  [0.34, 0.33, 0.32], // granite
  [0.43, 0.36, 0.29], // sandstone
  [0.23, 0.23, 0.25], // basalt
  [0.3, 0.32, 0.35], // slate
  [0.38, 0.34, 0.3], // limestone
];

/** Smooth 3D value-ish noise from a few sines: cheap, deterministic, no tables. */
function rockNoise(x: number, y: number, z: number, seed: number): number {
  return (
    Math.sin(x * 3.1 + seed) * Math.sin(y * 2.7 + seed * 1.3) * 0.5 +
    Math.sin(z * 3.7 + x * 1.9 + seed * 0.7) * 0.3 +
    Math.sin((x + y + z) * 5.3 + seed * 2.1) * 0.2
  );
}

/**
 * Finds each connected cluster of rock cells and builds a lumpy stone that fills exactly that footprint: the outline
 * follows the cells, the face is a faceted dome that stands slightly proud of the soil. All stones share one mesh.
 */
function buildRockGeometry(sim: AntColonySimulation, rockSubdiv: 1 | 2 = 2): THREE.BufferGeometry | null {
  const grid = sim.grid;
  const seen = new Uint8Array(GRID_W * GRID_H);
  const half = CELL_SIZE * WORLD_SCALE * 0.5;
  const BINS = 24;
  const positions: number[] = [];
  const colors: number[] = [];
  const unit = new THREE.IcosahedronGeometry(1, rockSubdiv);
  const up = unit.attributes.position;
  const col = new THREE.Color();
  let rockIndex = 0;

  for (let start = 0; start < GRID_W * GRID_H; start++) {
    if (seen[start] || grid.terrain[start] !== CellType.PEBBLE) continue;
    // flood fill (8-way, so diagonal neighbours join one stone)
    const cells: number[] = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      const x = i % GRID_W;
      const y = (i - x) / GRID_W;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const j = ny * GRID_W + nx;
          if (seen[j] || grid.terrain[j] !== CellType.PEBBLE) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    }

    const pts = cells.map((i) => {
      const gx = i % GRID_W;
      const gy = (i - gx) / GRID_W;
      return { x: simToWorldX((gx + 0.5) * CELL_SIZE), y: simToWorldY((gy + 0.5) * CELL_SIZE) };
    });
    let cx = 0;
    let cy = 0;
    for (const p of pts) {
      cx += p.x;
      cy += p.y;
    }
    cx /= pts.length;
    cy /= pts.length;

    // radial outline: how far the cells reach in each direction
    const raw = new Float32Array(BINS);
    for (const p of pts) {
      const a = Math.atan2(p.y - cy, p.x - cx);
      const b = (((Math.round((a / (Math.PI * 2)) * BINS) % BINS) + BINS) % BINS) | 0;
      raw[b] = Math.max(raw[b], Math.hypot(p.x - cx, p.y - cy) + half * 1.05);
    }
    const minR = half * 1.15;
    for (let b = 0; b < BINS; b++) {
      if (raw[b] > 0) continue;
      // an empty direction: borrow from the nearest filled ones
      let l = 1;
      while (raw[(b - l + BINS) % BINS] === 0 && l < BINS) l++;
      let r = 1;
      while (raw[(b + r) % BINS] === 0 && r < BINS) r++;
      raw[b] = (raw[(b - l + BINS) % BINS] + raw[(b + r) % BINS]) * 0.5 * 0.9;
    }
    const prof = new Float32Array(BINS);
    for (let b = 0; b < BINS; b++) {
      const sm = (raw[(b + BINS - 1) % BINS] + raw[b] * 2 + raw[(b + 1) % BINS]) / 4;
      prof[b] = Math.max(minR, sm, raw[b] * 0.92);
    }
    let meanR = 0;
    for (let b = 0; b < BINS; b++) meanR += prof[b];
    meanR /= BINS;

    const seed = (rockIndex * 7.31 + cx * 3.1 + cy * 5.7) % 100;
    const depth = clamp(meanR * 0.5, 0.07, 0.26);
    const zc = SOIL_FRONT_Z + 0.07 - depth;
    const base = ROCK_PALETTE[rockIndex % ROCK_PALETTE.length];
    const tint = 0.9 + (deterministicRand(rockIndex, 3, 7) - 0.5) * 0.3;
    rockIndex++;

    for (let v = 0; v < up.count; v++) {
      const ux = up.getX(v);
      const uy = up.getY(v);
      const uz = up.getZ(v);
      const theta = Math.atan2(uy, ux);
      const f = (((theta / (Math.PI * 2)) * BINS) % BINS + BINS) % BINS;
      const b0 = Math.floor(f) % BINS;
      const r = prof[b0] + (prof[(b0 + 1) % BINS] - prof[b0]) * (f - Math.floor(f));
      const n = rockNoise(ux, uy, uz, seed) * 0.13;
      const m = 1 + n;
      positions.push(cx + ux * r * m, cy + uy * r * m, zc + (uz > 0 ? uz * depth * (1 + n * 0.8) : uz * depth));
      // lit from the top front, darker underneath, with a little grain
      const grain = (deterministicRand(Math.round(ux * 60), Math.round(uy * 60 + uz * 40), seed) - 0.5) * 0.14;
      const shade = clamp((0.8 + uy * 0.2 + uz * 0.16 + n * 0.5 + grain) * tint, 0.35, 1.25);
      col.setRGB(base[0] * shade, base[1] * shade, base[2] * shade, THREE.SRGBColorSpace);
      colors.push(col.r, col.g, col.b);
    }
  }
  unit.dispose();
  if (positions.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

export class FormicariumEnvironment3D {
  public readonly group = new THREE.Group();

  private readonly solidMesh: THREE.Mesh;
  private readonly curvedCavernMesh: THREE.Mesh;
  private readonly curvedCavernMat: THREE.MeshStandardMaterial;
  private granuleMesh: THREE.InstancedMesh;
  private readonly granuleGeo: THREE.IcosahedronGeometry;
  private readonly granuleMat: THREE.Material;
  private granuleCap: number;
  private readonly backEarthMesh: THREE.Mesh;
  private readonly backEarthCanvas: HTMLCanvasElement;
  private readonly backEarthCtx: CanvasRenderingContext2D;
  private readonly backEarthTex: THREE.CanvasTexture;

  private readonly rootMeshes: THREE.Mesh[] = [];
  private rockMesh: THREE.Mesh | null = null;
  private readonly disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  private smoothSoilField = new Float32Array(GRID_W * GRID_H);
  private smoothAirField = new Float32Array(GRID_W * GRID_H);
  // scratch storage reused by every rebuildTerrain() (see ScratchF32)
  private readonly sPositions = new ScratchF32(1 << 18);
  private readonly sNormals = new ScratchF32(1 << 18);
  private readonly sUvs = new ScratchF32(1 << 17);
  private readonly sColors = new ScratchF32(1 << 18);
  private readonly sCPositions = new ScratchF32(1 << 15);
  private readonly sCUvs = new ScratchF32(1 << 14);
  private readonly sCColors = new ScratchF32(1 << 15);
  private readonly sCIndices = new ScratchU32(1 << 15);
  private readonly fieldA = new Float32Array(GRID_W * GRID_H);
  private readonly fieldB = new Float32Array(GRID_W * GRID_H);
  private readonly airA = new Float32Array(GRID_W * GRID_H);
  private readonly airB = new Float32Array(GRID_W * GRID_H);
  private readonly cornerWx = new Float32Array(GRID_W * GRID_H);
  private readonly cornerWy = new Float32Array(GRID_W * GRID_H);
  private readonly cornerZ0 = new Float32Array(GRID_W * GRID_H);
  private readonly cornerR = new Float32Array(GRID_W * GRID_H);
  private readonly cornerG = new Float32Array(GRID_W * GRID_H);
  private readonly cornerB = new Float32Array(GRID_W * GRID_H);
  private readonly curvedVertexMap = new Int32Array((GRID_W + 1) * (GRID_H + 1));
  private lastRebuildTime = -10;
  private builtTerrainVersion = -1;
  private lastBackTexTime = -10;

  constructor(
    sim: AntColonySimulation,
    bank: MaterialBank,
    maxAnisotropy: number,
    isSoftwareGl: boolean,
    rockSubdiv: 1 | 2 = 2,
    initialGranuleCap = 12000,
    deferBuild = false
  ) {
    const leftX = simToWorldX(CASE_LEFT);
    const rightX = simToWorldX(CASE_RIGHT);
    const topY = simToWorldY(CASE_TOP);
    const botY = simToWorldY(CASE_BOTTOM);
    const width = rightX - leftX;
    const height = topY - botY;
    const centerX = (leftX + rightX) * 0.5;
    const centerY = (topY + botY) * 0.5;

    // No enclosure: the soil cross-section stands free against the open sky.


    // 4. Deep dark-brown fallback shadow mask behind curved caverns (prevents any crevice light bleed)
    this.backEarthCanvas = document.createElement('canvas');
    this.backEarthCanvas.width = GRID_W;
    this.backEarthCanvas.height = GRID_H;
    this.backEarthCtx = this.backEarthCanvas.getContext('2d')!;
    this.backEarthTex = new THREE.CanvasTexture(this.backEarthCanvas);
    this.backEarthTex.colorSpace = THREE.SRGBColorSpace;
    this.backEarthTex.anisotropy = maxAnisotropy;
    this.backEarthTex.magFilter = THREE.LinearFilter;
    this.disposables.push(this.backEarthTex);

    const soilAreaW = GRID_W * CELL_SIZE * WORLD_SCALE;
    const backEarthMat = new THREE.MeshStandardMaterial({
      map: this.backEarthTex,
      alphaTest: 0.5,
      roughness: 0.98,
      metalness: 0.0,
    });
    const backEarthGeo = new THREE.PlaneGeometry(soilAreaW, GRID_H * CELL_SIZE * WORLD_SCALE);
    this.backEarthMesh = new THREE.Mesh(backEarthGeo, backEarthMat);
    this.backEarthMesh.position.set(0, simToWorldY(GRID_H * CELL_SIZE * 0.5), CURVED_DEEP_Z - 0.08);
    this.backEarthMesh.receiveShadow = true;
    this.group.add(this.backEarthMesh);
    this.disposables.push(backEarthGeo, backEarthMat);

    // 5. Solid Deformed Dark-Brown Soil Mass Underneath Exposed Granules
    this.solidMesh = new THREE.Mesh(new THREE.BufferGeometry(), bank.soilWallMat);
    this.solidMesh.castShadow = !isSoftwareGl;
    this.solidMesh.receiveShadow = true;
    this.group.add(this.solidMesh);

    // 6. Smooth Concave Curved Cavern & Cylindrical Tunnel Back Walls
    this.curvedCavernMat = new THREE.MeshStandardMaterial({
      map: bank.soilGrainTex,
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0,
      flatShading: false,
    });
    this.curvedCavernMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.curvedCavernMat);
    this.curvedCavernMesh.castShadow = !isSoftwareGl;
    this.curvedCavernMesh.receiveShadow = true;
    this.group.add(this.curvedCavernMesh);
    this.disposables.push(this.curvedCavernMat);

    // 7. Densely Populated Exposed-Surface Tiny Dark-Brown Soil Spheres (1 draw call, grows dynamically if dug)
    this.granuleGeo = new THREE.IcosahedronGeometry(1, 0);
    this.granuleMat = bank.soilFrontMat;
    this.granuleCap = Math.min(MAX_GRANULES, Math.max(4096, initialGranuleCap));
    this.granuleMesh = this.makeGranuleMesh(this.granuleCap);
    this.group.add(this.granuleMesh);
    this.disposables.push(this.granuleGeo);

    if (!deferBuild) {
      this.buildRocksAndRoots(sim, bank, isSoftwareGl, rockSubdiv);
      this.buildInitialTerrain(sim);
    }
  }

  public buildRocksAndRoots(
    sim: AntColonySimulation,
    bank: MaterialBank,
    isSoftwareGl: boolean,
    rockSubdiv: 1 | 2 = 2
  ): void {
    // 8. 3D Subterranean Roots
    for (const poly of sim.rootPolylines) {
      if (poly.length < 2) continue;
      const pts = poly.map(
        (p, idx) =>
          new THREE.Vector3(
            simToWorldX(p.x),
            simToWorldY(p.y),
            0.12 + Math.sin(idx * 0.7 + p.x * 0.02) * 0.22
          )
      );
      const curve = new THREE.CatmullRomCurve3(pts);
      const tubeGeo = new THREE.TubeGeometry(curve, Math.max(6, pts.length * 2), 0.048, 5, false);
      const rootMesh = new THREE.Mesh(tubeGeo, bank.rootMat);
      rootMesh.castShadow = !isSoftwareGl;
      rootMesh.receiveShadow = true;
      this.group.add(rootMesh);
      this.rootMeshes.push(rootMesh);
      this.disposables.push(tubeGeo);
    }

    // 9. Rocks: one sculpted stone per cluster of rock cells, so what you see is exactly what blocks the ants
    const rockGeo = buildRockGeometry(sim, rockSubdiv);
    if (rockGeo) {
      const rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.04, flatShading: true });
      this.rockMesh = new THREE.Mesh(rockGeo, rockMat);
      this.rockMesh.castShadow = !isSoftwareGl;
      this.rockMesh.receiveShadow = true;
      this.rockMesh.frustumCulled = false;
      this.group.add(this.rockMesh);
      this.disposables.push(rockGeo, rockMat);
    }
  }

  public buildInitialTerrain(sim: AntColonySimulation): void {
    this.builtTerrainVersion = sim.grid.terrainVersion;
    this.rebuildTerrain(sim);
    this.updateBackEarthTexture(sim);
    sim.grid.dirtVisualDirty = false;
    this.lastRebuildTime = sim.simTime;
    this.lastBackTexTime = sim.simTime;
  }

  private makeGranuleMesh(cap: number): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(this.granuleGeo, this.granuleMat, cap);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = false; // sub-ant-sized grains: shadows cost a full extra pass for no visible gain
    im.receiveShadow = true;
    return im;
  }

  private growGranuleMesh(): void {
    const nextCap = Math.min(MAX_GRANULES, Math.round(this.granuleCap * 1.5));
    if (nextCap <= this.granuleCap) return;
    const old = this.granuleMesh;
    const next = this.makeGranuleMesh(nextCap);
    (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    if (old.instanceColor && next.instanceColor) {
      (next.instanceColor.array as Float32Array).set(old.instanceColor.array as Float32Array);
    }
    this.group.remove(old);
    old.dispose();
    this.granuleMesh = next;
    this.granuleCap = nextCap;
    this.group.add(next);
  }

  /**
   * Bilinearly samples the curved cavern/tunnel back-wall Z position at world simulation coordinates
   * so ants and brood walking on chamber walls hug the concave curvature cleanly.
   */
  public sampleCavernBackZ(sim: AntColonySimulation, sx: number, sy: number): number {
    const fx = clamp(sx / CELL_SIZE - 0.5, 0, GRID_W - 1.001);
    const fy = clamp(sy / CELL_SIZE - 0.5, 0, GRID_H - 1.001);
    const gx0 = Math.floor(fx);
    const gy0 = Math.floor(fy);
    const gx1 = Math.min(GRID_W - 1, gx0 + 1);
    const gy1 = Math.min(GRID_H - 1, gy0 + 1);
    const tx = fx - gx0;
    const ty = fy - gy0;
    const cd = sim.grid.cavityDepth;
    const d00 = cd[gy0 * GRID_W + gx0];
    const d10 = cd[gy0 * GRID_W + gx1];
    const d01 = cd[gy1 * GRID_W + gx0];
    const d11 = cd[gy1 * GRID_W + gx1];
    const dTop = d00 * (1 - tx) + d10 * tx;
    const dBot = d01 * (1 - tx) + d11 * tx;
    const d = Math.max(0.5, dTop * (1 - ty) + dBot * ty);
    return cavityDepthToZ(d);
  }

  /** bumps whenever the smoothed soil contour is rebuilt */
  public fieldVersion = 0;

  /**
   * Sim-space y of the visible (smoothed) ground surface at sim x, scanning down from the sky. Returns NaN where
   * there is no ground within `maxY` (e.g. straight down an entrance shaft).
   */
  public groundYAt(sx: number, maxY: number): number {
    const fx = sx / CELL_SIZE - 0.5;
    const step = 0.2;
    let fy = Math.floor(CASE_TOP / CELL_SIZE) + 1;
    const end = maxY / CELL_SIZE - 0.5;
    let prev = this.sampleField(this.smoothSoilField, fx, fy);
    while (fy < end) {
      const nfy = fy + step;
      const v = this.sampleField(this.smoothSoilField, fx, nfy);
      if (v >= ISO_LEVEL) {
        const t = clamp((ISO_LEVEL - prev) / Math.max(1e-6, v - prev), 0, 1);
        return (fy + t * step + 0.5) * CELL_SIZE;
      }
      prev = v;
      fy = nfy;
    }
    return NaN;
  }

  private sampleField(f: Float32Array, fx: number, fy: number): number {
    const leftGx = Math.floor(CASE_LEFT / CELL_SIZE);
    const rightGx = Math.floor(CASE_RIGHT / CELL_SIZE);
    const topGy = Math.floor(CASE_TOP / CELL_SIZE);
    const bottomGy = Math.floor(CASE_BOTTOM / CELL_SIZE);
    const cx = clamp(fx, leftGx, rightGx - 0.001);
    const cy = clamp(fy, topGy, bottomGy - 0.001);
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(rightGx, x0 + 1);
    const y1 = Math.min(bottomGy, y0 + 1);
    const tx = cx - x0;
    const ty = cy - y0;
    const a = f[y0 * GRID_W + x0] * (1 - tx) + f[y0 * GRID_W + x1] * tx;
    const b = f[y1 * GRID_W + x0] * (1 - tx) + f[y1 * GRID_W + x1] * tx;
    return a * (1 - ty) + b * ty;
  }

  /**
   * Samples the continuous smooth Marching Squares soil contour and concave cavern back wall
   * so ants and intruders walk and tilt fluidly along curved 3D geometry instead of flat grid chunks.
   */
  public sampleSurfaceContact(
    sim: AntColonySimulation,
    sx: number,
    sy: number,
    zLane: number,
    outPos: THREE.Vector3,
    outUp: THREE.Vector3
  ): void {
    const fx = sx / CELL_SIZE - 0.5;
    const fy = sy / CELL_SIZE - 0.5;
    const s = this.sampleField(this.smoothSoilField, fx, fy);
    const airBlend = clamp(this.sampleField(this.smoothAirField, fx, fy) * 1.7, 0, 1);

    const h = 0.85;
    const dsDx =
      (this.sampleField(this.smoothSoilField, fx + h, fy) -
        this.sampleField(this.smoothSoilField, fx - h, fy)) /
      (2 * h);
    const dsDy =
      (this.sampleField(this.smoothSoilField, fx, fy + h) -
        this.sampleField(this.smoothSoilField, fx, fy - h)) /
      (2 * h);

    // Outward 2D normal pointing from solid earth into open air/tunnel
    const wnx = -dsDx;
    const wny = dsDy;
    const gradMag = Math.hypot(wnx, wny);
    const wallW = smoothstep(0.06, 0.34, gradMag);

    let ux = 0;
    let uy = 1;
    let wx = simToWorldX(sx);
    let wy = simToWorldY(sy);

    if (wallW > 1e-4 && gradMag > 1e-4) {
      ux = wnx / gradMag;
      uy = wny / gradMag;
      const cellsFromIso = (s - 0.45) / Math.max(0.24, gradMag);
      const pullCells = clamp(cellsFromIso, -1.1, 1.3) * wallW;
      const shift = pullCells * CELL_SIZE * WORLD_SCALE;
      wx += ux * shift;
      wy += uy * shift;
    }

    const zBack = this.sampleCavernBackZ(sim, sx, sy);
    const eps = CELL_SIZE * 0.75;
    const dWorld = 2 * eps * WORLD_SCALE;
    const dzDx = (this.sampleCavernBackZ(sim, sx + eps, sy) - this.sampleCavernBackZ(sim, sx - eps, sy)) / dWorld;
    const dzDy = (this.sampleCavernBackZ(sim, sx, sy - eps) - this.sampleCavernBackZ(sim, sx, sy + eps)) / dWorld;
    const bLen = Math.hypot(dzDx, dzDy, 1) || 1;
    const bnx = -dzDx / bLen;
    const bny = -dzDy / bLen;
    const bnz = 1 / bLen;

    const airW = smoothstep(0.24, 0.62, airBlend);
    const extZ = clamp(zLane, SOIL_BACK_Z + 0.10, SOLID_FRONT_Z - 0.13);
    // Tunnel walls are studded with decorative soil granules that stand up to ~0.042 off the wall. Walkers ride just
    // above that gravel layer, otherwise feet and bellies sink into the pebbles and ants look snagged on them.
    const WALK_CLEARANCE = 0.056;
    const tunnelWallZ = Math.max(zBack + WALK_CLEARANCE, clamp(zLane, zBack + WALK_CLEARANCE, SOLID_FRONT_Z - 0.12));
    const undergroundZ = (zBack + WALK_CLEARANCE) * (1 - wallW) + tunnelWallZ * wallW;
    const wz = clamp(undergroundZ * (1 - airW) + extZ * airW, SOIL_BACK_Z - 0.14, SOLID_FRONT_Z - 0.09);

    const wallNz = 0.16 * (1 - airW);
    outUp.set(
      bnx * (1 - wallW) + ux * wallW,
      bny * (1 - wallW) + uy * wallW,
      bnz * (1 - wallW) + wallNz * wallW
    );
    if (outUp.lengthSq() < 1e-6) {
      outUp.set(0, 1, 0);
    } else {
      outUp.normalize();
    }
    outPos.set(wx, wy, wz);
  }

  public update(sim: AntColonySimulation, elapsedTime: number): void {
    // Rebuilding the soil mesh is expensive (tens of ms). Real digging changes a cell or two at a time, so batch the
    // edits up; moisture-only changes (rain soaking in) can wait much longer.
    const terrainChanged = sim.grid.terrainVersion !== this.builtTerrainVersion;
    const due = terrainChanged ? elapsedTime - this.lastRebuildTime > 1.2 : elapsedTime - this.lastRebuildTime > 8;
    if (sim.grid.dirtVisualDirty && due) {
      this.builtTerrainVersion = sim.grid.terrainVersion;
      this.rebuildTerrain(sim);
      this.updateBackEarthTexture(sim);
      sim.grid.dirtVisualDirty = false;
      this.lastRebuildTime = elapsedTime;
      this.lastBackTexTime = elapsedTime;
    } else if (elapsedTime - this.lastBackTexTime > 2.5) {
      this.updateBackEarthTexture(sim);
      this.lastBackTexTime = elapsedTime;
    }
  }

  private updateBackEarthTexture(sim: AntColonySimulation): void {
    const img = this.backEarthCtx.createImageData(GRID_W, GRID_H);
    const data = img.data;
    const terrain = sim.grid.terrain;
    const moisture = sim.grid.moisture;

    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        const i = gy * GRID_W + gx;
        const p = i * 4;
        const t = terrain[i];
        const m = moisture[i];
        const j = (deterministicRand(gx, gy, 3) - 0.5) * 6;

        if (t === CellType.AIR || t === CellType.GLASS_WALL) {
          data[p] = 0;
          data[p + 1] = 0;
          data[p + 2] = 0;
          data[p + 3] = 0;
          continue;
        }

        const isTunnel = t === CellType.TUNNEL;
        const mDark = 1 - Math.min(0.32, m * 0.28);
        const tunnelFade = isTunnel ? 0.45 : 0.72;
        const depthRatio = Math.min(1, Math.max(0, (gy - 38) / 90));
        data[p] = Math.max(5, Math.min(255, (30 - depthRatio * 10) * mDark * tunnelFade + j));
        data[p + 1] = Math.max(3, Math.min(255, (17 - depthRatio * 6) * mDark * tunnelFade + j * 0.6));
        data[p + 2] = Math.max(2, Math.min(255, (10 - depthRatio * 4) * mDark * tunnelFade + j * 0.4));
        data[p + 3] = 255;
      }
    }

    this.backEarthCtx.putImageData(img, 0, 0);
    this.backEarthTex.needsUpdate = true;
  }

  private rebuildTerrain(sim: AntColonySimulation): void {
    sim.grid.updateCavityDepthField();
    const terrain = sim.grid.terrain;
    const moisture = sim.grid.moisture;
    const cavityDepth = sim.grid.cavityDepth;

    const leftGx = Math.floor(CASE_LEFT / CELL_SIZE);
    const rightGx = Math.floor(CASE_RIGHT / CELL_SIZE);
    const topGy = Math.floor(CASE_TOP / CELL_SIZE);
    const bottomGy = Math.floor(CASE_BOTTOM / CELL_SIZE);
    const minGx = leftGx + 1;
    const maxGx = rightGx - 1;
    const minGy = topGy + 1;
    const maxGy = bottomGy - 1;

    const isSolid = (gx: number, gy: number) => {
      if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
      const t = terrain[gy * GRID_W + gx];
      return t !== CellType.AIR && t !== CellType.TUNNEL && t !== CellType.GLASS_WALL;
    };

    const hasNeighborTunnel = (gx: number, gy: number) => {
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (ox === 0 && oy === 0) continue;
          const nx = gx + ox;
          const ny = gy + oy;
          if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H) {
            if (terrain[ny * GRID_W + nx] === CellType.TUNNEL) return true;
          }
        }
      }
      return false;
    };

    // --- 1. Build smoothed scalar soil occupancy & air-exposure fields ---
    const len = GRID_W * GRID_H;
    const { fieldA, fieldB, airA, airB } = this;

    for (let gy = minGy; gy <= maxGy; gy++) {
      const row = gy * GRID_W;
      for (let gx = minGx; gx <= maxGx; gx++) {
        const i = row + gx;
        const t = terrain[i];
        if (t === CellType.AIR) {
          fieldA[i] = 0.0;
          airA[i] = 1.0;
        } else if (t === CellType.TUNNEL) {
          // Negative bias keeps narrow tunnels comfortably open and organic after smoothing
          fieldA[i] = -0.35;
          airA[i] = 0.0;
        } else if (t === CellType.GLASS_WALL) {
          fieldA[i] = 0.0;
          airA[i] = 0.0;
        } else {
          fieldA[i] = 1.0;
          airA[i] = 0.0;
        }
      }
    }

    const blurPass = (
      src: Float32Array,
      dst: Float32Array,
      centerW: number,
      orthoW: number,
      diagW: number,
      topAirVal: number
    ) => {
      const totalW = centerW + orthoW * 4 + diagW * 4;
      for (let gy = minGy; gy <= maxGy; gy++) {
        const row = gy * GRID_W;
        for (let gx = minGx; gx <= maxGx; gx++) {
          let sum = 0;
          for (let oy = -1; oy <= 1; oy++) {
            const ny = gy + oy;
            for (let ox = -1; ox <= 1; ox++) {
              const nx = gx + ox;
              const w = ox === 0 && oy === 0 ? centerW : ox === 0 || oy === 0 ? orthoW : diagW;
              if (ny <= topGy) {
                sum += topAirVal * w;
              } else {
                const cx = clamp(nx, minGx, maxGx);
                const cy = clamp(ny, minGy, maxGy);
                sum += src[cy * GRID_W + cx] * w;
              }
            }
          }
          dst[row + gx] = sum / totalW;
        }
      }
    };

    // Two gentle Gaussian passes turn grid stair-steps into smooth curvy contours
    blurPass(fieldA, fieldB, 4, 2, 1, 0.0);
    blurPass(fieldB, fieldA, 8, 2, 1, 0.0);
    blurPass(airA, airB, 4, 2, 1, 1.0);
    blurPass(airB, airA, 8, 2, 1, 1.0);

    // Mirror perimeter samples onto tank glass boundary ring so earth seals cleanly to side/bottom glass
    const mirrorBoundary = (f: Float32Array, topVal: number) => {
      for (let gx = leftGx; gx <= rightGx; gx++) {
        const cx = clamp(gx, minGx, maxGx);
        f[topGy * GRID_W + gx] = topVal;
        f[bottomGy * GRID_W + gx] = f[maxGy * GRID_W + cx];
      }
      for (let gy = minGy; gy <= maxGy; gy++) {
        f[gy * GRID_W + leftGx] = f[gy * GRID_W + minGx];
        f[gy * GRID_W + rightGx] = f[gy * GRID_W + maxGx];
      }
      f[bottomGy * GRID_W + leftGx] = f[maxGy * GRID_W + minGx];
      f[bottomGy * GRID_W + rightGx] = f[maxGy * GRID_W + maxGx];
    };
    mirrorBoundary(fieldA, 0.0);
    mirrorBoundary(airA, 1.0);
    this.smoothSoilField = fieldA;
    this.smoothAirField = airA;
    this.fieldVersion++;

    const sampleSimX = (gx: number) =>
      gx <= leftGx ? CASE_LEFT : gx >= rightGx ? CASE_RIGHT : (gx + 0.5) * CELL_SIZE;
    const sampleSimY = (gy: number) =>
      gy <= topGy ? CASE_TOP : gy >= bottomGy ? CASE_BOTTOM : (gy + 0.5) * CELL_SIZE;

    const sampleSmooth = (f: Float32Array, fx: number, fy: number): number => {
      const cx = clamp(fx, leftGx, rightGx - 0.001);
      const cy = clamp(fy, topGy, bottomGy - 0.001);
      const x0 = Math.floor(cx);
      const y0 = Math.floor(cy);
      const x1 = Math.min(rightGx, x0 + 1);
      const y1 = Math.min(bottomGy, y0 + 1);
      const tx = cx - x0;
      const ty = cy - y0;
      const a = f[y0 * GRID_W + x0] * (1 - tx) + f[y0 * GRID_W + x1] * tx;
      const b = f[y1 * GRID_W + x0] * (1 - tx) + f[y1 * GRID_W + x1] * tx;
      return a * (1 - ty) + b * ty;
    };

    const frontZAt = (wx: number, wy: number): number =>
      SOLID_FRONT_Z +
      Math.sin(wx * 5.2 + wy * 3.1) * 0.014 +
      Math.cos(wx * 11.3 - wy * 8.7) * 0.008;

    const soilColorAtSim = (sx: number, sy: number): [number, number, number] => {
      const gx = clamp(Math.floor(sx / CELL_SIZE), minGx, maxGx);
      const gy = clamp(Math.floor(sy / CELL_SIZE), minGy, maxGy);
      const idx = gy * GRID_W + gx;
      let t = terrain[idx];
      if (t === CellType.AIR || t === CellType.TUNNEL || t === CellType.GLASS_WALL) {
        t = gy < 52 ? CellType.TOPSOIL : gy > 105 ? CellType.DEEP_CLAY : CellType.SUBSOIL;
      }
      const m = moisture[idx];
      const tint =
        0.5 +
        0.3 * Math.sin(sx * 0.19 + sy * 0.13) +
        0.2 * Math.cos(sx * 0.43 - sy * 0.37);
      const [sr, sg, sb] = granuleColorSrgb(t, m, gy, tint);
      _col.setRGB(sr, sg, sb, THREE.SRGBColorSpace);
      return [_col.r, _col.g, _col.b];
    };

    // --- PART A: Smooth Marching Squares Cross-Section + Multi-Ring Rounded Tunnel Bevels ---
    const positions = this.sPositions;
    const normals = this.sNormals;
    const uvs = this.sUvs;
    const colors = this.sColors;
    positions.reset();
    normals.reset();
    uvs.reset();
    colors.reset();

    const pushTri = (
      ax: number, ay: number, az: number, au: number, av: number,
      bx: number, by: number, bz: number, bu: number, bv: number,
      cx: number, cy: number, cz: number, cu: number, cv: number,
      na: [number, number, number],
      nb: [number, number, number],
      nc: [number, number, number],
      ca: [number, number, number],
      cb: [number, number, number],
      cc: [number, number, number]
    ) => {
      positions.push3(ax, ay, az);
      positions.push3(bx, by, bz);
      positions.push3(cx, cy, cz);
      normals.push3(na[0], na[1], na[2]);
      normals.push3(nb[0], nb[1], nb[2]);
      normals.push3(nc[0], nc[1], nc[2]);
      uvs.push2(au, av);
      uvs.push2(bu, bv);
      uvs.push2(cu, cv);
      colors.push3(ca[0], ca[1], ca[2]);
      colors.push3(cb[0], cb[1], cb[2]);
      colors.push3(cc[0], cc[1], cc[2]);
    };

    const FRONT_N: [number, number, number] = [0, 0, 1];

    interface ContourPt {
      sx: number;
      sy: number;
      wx: number;
      wy: number;
      z0: number;
      col: [number, number, number];
    }

    const pushFrontTri = (a: ContourPt, b: ContourPt, c: ContourPt) => {
      pushTri(
        a.wx, a.wy, a.z0, a.wx * 0.25, a.wy * 0.25,
        b.wx, b.wy, b.z0, b.wx * 0.25, b.wy * 0.25,
        c.wx, c.wy, c.z0, c.wx * 0.25, c.wy * 0.25,
        FRONT_N, FRONT_N, FRONT_N,
        a.col, b.col, c.col
      );
    };

    interface BevelSample {
      wx: number[];
      wy: number[];
      wz: number[];
      nx: number[];
      ny: number[];
      nz: number[];
      col: [number, number, number][];
      airBlend: number;
    }

    const makeBevelProfile = (pt: ContourPt): BevelSample => {
      const fx = pt.sx / CELL_SIZE - 0.5;
      const fy = pt.sy / CELL_SIZE - 0.5;
      const dsDx = sampleSmooth(fieldA, fx + 0.55, fy) - sampleSmooth(fieldA, fx - 0.55, fy);
      const dsDy = sampleSmooth(fieldA, fx, fy + 0.55) - sampleSmooth(fieldA, fx, fy - 0.55);

      // Outward into open tunnel/air = (-dsDx, +dsDy) in world XY
      let nx = -dsDx;
      let ny = dsDy;
      const onLeftEdge = pt.sx <= CASE_LEFT + 1.5;
      const onRightEdge = pt.sx >= CASE_RIGHT - 1.5;
      const onBottomEdge = pt.sy >= CASE_BOTTOM - 1.5;
      if (onLeftEdge || onRightEdge) nx = 0;
      if (onBottomEdge) ny = 0;
      const nLen = Math.hypot(nx, ny);
      if (nLen > 1e-4) {
        nx /= nLen;
        ny /= nLen;
      } else {
        nx = 0;
        ny = 1;
      }

      const airBlend = clamp(sampleSmooth(airA, fx, fy) * 1.7, 0, 1);
      const zCavern = this.sampleCavernBackZ(sim, pt.sx, pt.sy);
      const zTunnelBack = Math.min(CURVED_RIM_Z - 0.1, zCavern - 0.04);
      const zBack = zTunnelBack * (1 - airBlend) + SOIL_BACK_Z * airBlend;
      const tuckShift = airBlend < 0.5 ? 0.056 : 0.044;

      const c0 = pt.col;
      const c1: [number, number, number] = [c0[0] * 0.94, c0[1] * 0.94, c0[2] * 0.94];
      const c2: [number, number, number] = [c0[0] * 0.82, c0[1] * 0.82, c0[2] * 0.82];
      const c3: [number, number, number] = [c0[0] * 0.60, c0[1] * 0.60, c0[2] * 0.60];

      return {
        wx: [pt.wx, pt.wx + nx * 0.021, pt.wx + nx * 0.044, pt.wx + nx * tuckShift],
        wy: [pt.wy, pt.wy + ny * 0.021, pt.wy + ny * 0.044, pt.wy + ny * tuckShift],
        wz: [pt.z0, pt.z0 - 0.04, pt.z0 - 0.112, zBack],
        nx: [0, nx * 0.54, nx * 0.9, nx * 0.96],
        ny: [0, ny * 0.54, ny * 0.9, ny * 0.96],
        nz: [1, 0.84, 0.436, 0.28],
        col: [c0, c1, c2, c3],
        airBlend,
      };
    };

    // Granule accumulation counter (writes directly into typed GPU buffers, growing dynamically if needed)
    let granuleCount = 0;
    let gMatArr = this.granuleMesh.instanceMatrix.array as Float32Array;
    let gColArr = this.granuleMesh.instanceColor!.array as Float32Array;
    const pushSphere = (
      wx: number,
      wy: number,
      wz: number,
      r: number,
      cr: number,
      cg: number,
      cb: number
    ) => {
      if (granuleCount >= MAX_GRANULES) return;
      if (granuleCount >= this.granuleCap) {
        this.growGranuleMesh();
        gMatArr = this.granuleMesh.instanceMatrix.array as Float32Array;
        gColArr = this.granuleMesh.instanceColor!.array as Float32Array;
      }
      const m = granuleCount * 16;
      gMatArr[m] = r;
      gMatArr[m + 1] = 0;
      gMatArr[m + 2] = 0;
      gMatArr[m + 3] = 0;
      gMatArr[m + 4] = 0;
      gMatArr[m + 5] = r;
      gMatArr[m + 6] = 0;
      gMatArr[m + 7] = 0;
      gMatArr[m + 8] = 0;
      gMatArr[m + 9] = 0;
      gMatArr[m + 10] = r;
      gMatArr[m + 11] = 0;
      gMatArr[m + 12] = wx;
      gMatArr[m + 13] = wy;
      gMatArr[m + 14] = wz;
      gMatArr[m + 15] = 1;

      const c = granuleCount * 3;
      gColArr[c] = srgbToLin(cr);
      gColArr[c + 1] = srgbToLin(cg);
      gColArr[c + 2] = srgbToLin(cb);
      granuleCount++;
    };

    const pushContourBevelAndGranules = (a: ContourPt, b: ContourPt, cellGx: number, cellGy: number, segIdx: number) => {
      const pa = makeBevelProfile(a);
      const pb = makeBevelProfile(b);

      // Emit 3-ring rounded fillet strip from A -> B (CCW: A_i -> A_{i+1} -> B_{i+1}, A_i -> B_{i+1} -> B_i)
      for (let r = 0; r < 3; r++) {
        const na0: [number, number, number] = [pa.nx[r], pa.ny[r], pa.nz[r]];
        const na1: [number, number, number] = [pa.nx[r + 1], pa.ny[r + 1], pa.nz[r + 1]];
        const nb0: [number, number, number] = [pb.nx[r], pb.ny[r], pb.nz[r]];
        const nb1: [number, number, number] = [pb.nx[r + 1], pb.ny[r + 1], pb.nz[r + 1]];

        const ua = (pa.wx[r] + pa.wy[r]) * 0.25;
        const ub = (pb.wx[r] + pb.wy[r]) * 0.25;
        const vr0 = r * 0.35;
        const vr1 = (r + 1) * 0.35;

        pushTri(
          pa.wx[r], pa.wy[r], pa.wz[r], ua, vr0,
          pa.wx[r + 1], pa.wy[r + 1], pa.wz[r + 1], ua, vr1,
          pb.wx[r + 1], pb.wy[r + 1], pb.wz[r + 1], ub, vr1,
          na0, na1, nb1,
          pa.col[r], pa.col[r + 1], pb.col[r + 1]
        );
        pushTri(
          pa.wx[r], pa.wy[r], pa.wz[r], ua, vr0,
          pb.wx[r + 1], pb.wy[r + 1], pb.wz[r + 1], ub, vr1,
          pb.wx[r], pb.wy[r], pb.wz[r], ub, vr0,
          na0, nb1, nb0,
          pa.col[r], pb.col[r + 1], pb.col[r]
        );
      }

      // Place tiny dark-brown dirt granules directly anchored on the emitted smooth bevel quads
      const canUseDeepGround = pa.airBlend >= 0.72 && pb.airBlend >= 0.72;
      const count = canUseDeepGround ? 7 : 3;
      const cGy = clamp(cellGy, minGy, maxGy);
      const cGx = clamp(cellGx, minGx, maxGx);
      const cIdx = cGy * GRID_W + cGx;
      const cellType = terrain[cIdx];
      const m = moisture[cIdx];

      for (let k = 0; k < count; k++) {
        const salt = segIdx * 31 + k * 7;
        const tSeg = clamp((k + 0.15 + deterministicRand(cellGx, cellGy, salt) * 0.7) / count, 0.04, 0.96);
        const [gr, gg, gb] = granuleColorSrgb(
          cellType === CellType.AIR || cellType === CellType.TUNNEL
            ? cGy < 52
              ? CellType.TOPSOIL
              : cGy > 105
              ? CellType.DEEP_CLAY
              : CellType.SUBSOIL
            : cellType,
          m,
          cGy,
          deterministicRand(cellGx, cellGy, salt + 1)
        );
        const rad = 0.020 + deterministicRand(cellGx, cellGy, salt + 2) * 0.013;

        let r = 0;
        let subT = 0.5;
        if (canUseDeepGround) {
          if (k === 0) {
            r = 0;
            subT = 0.25 + deterministicRand(cellGx, cellGy, salt + 3) * 0.65;
          } else if (k === 1) {
            r = 1;
            subT = 0.2 + deterministicRand(cellGx, cellGy, salt + 3) * 0.7;
          } else {
            r = 2;
            subT = clamp((k - 2 + deterministicRand(cellGx, cellGy, salt + 3) * 0.85) / 5, 0.06, 0.94);
          }
        } else {
          r = k % 2;
          subT = 0.12 + deterministicRand(cellGx, cellGy, salt + 3) * 0.78;
        }

        const rNext = r + 1;
        const wxA = pa.wx[r] * (1 - tSeg) + pb.wx[r] * tSeg;
        const wyA = pa.wy[r] * (1 - tSeg) + pb.wy[r] * tSeg;
        const wzA = pa.wz[r] * (1 - tSeg) + pb.wz[r] * tSeg;
        const wxB = pa.wx[rNext] * (1 - tSeg) + pb.wx[rNext] * tSeg;
        const wyB = pa.wy[rNext] * (1 - tSeg) + pb.wy[rNext] * tSeg;
        const wzB = pa.wz[rNext] * (1 - tSeg) + pb.wz[rNext] * tSeg;

        const nxA = pa.nx[r] * (1 - tSeg) + pb.nx[r] * tSeg;
        const nyA = pa.ny[r] * (1 - tSeg) + pb.ny[r] * tSeg;
        const nzA = pa.nz[r] * (1 - tSeg) + pb.nz[r] * tSeg;
        const nxB = pa.nx[rNext] * (1 - tSeg) + pb.nx[rNext] * tSeg;
        const nyB = pa.ny[rNext] * (1 - tSeg) + pb.ny[rNext] * tSeg;
        const nzB = pa.nz[rNext] * (1 - tSeg) + pb.nz[rNext] * tSeg;

        let nx = nxA * (1 - subT) + nxB * subT;
        let ny = nyA * (1 - subT) + nyB * subT;
        let nz = nzA * (1 - subT) + nzB * subT;
        const nLen = Math.hypot(nx, ny, nz) || 1;
        nx /= nLen;
        ny /= nLen;
        nz /= nLen;

        // Sink center slightly into the mesh so each grain is visibly attached and never floats
        const embed = rad * 0.35;
        const wx = wxA * (1 - subT) + wxB * subT - nx * embed;
        const wy = wyA * (1 - subT) + wyB * subT - ny * embed;
        let wz = wzA * (1 - subT) + wzB * subT - nz * embed;
        if (canUseDeepGround) {
          wz = clamp(wz, SOIL_BACK_Z + rad * 0.35, SOLID_FRONT_Z - rad * 0.25);
        } else {
          wz = Math.min(wz, SOLID_FRONT_Z - rad * 0.25);
        }

        const shade = canUseDeepGround
          ? wz < -0.08
            ? 0.7
            : wz < 0.2
            ? 0.84
            : wz < 0.45
            ? 0.93
            : 1.0
          : 0.98 - (r + subT) * 0.1;
        pushSphere(wx, wy, wz, rad, gr * shade, gg * shade, gb * shade);
      }
    };

    const { cornerWx, cornerWy, cornerZ0, cornerR, cornerG, cornerB } = this;

    const getCornerPt = (i: number): ContourPt => ({
      sx: sampleSimX(i % GRID_W),
      sy: sampleSimY((i - (i % GRID_W)) / GRID_W),
      wx: cornerWx[i],
      wy: cornerWy[i],
      z0: cornerZ0[i],
      col: [cornerR[i], cornerG[i], cornerB[i]],
    });

    const pushFrontQuadIdx = (iBL: number, iBR: number, iTR: number, iTL: number) => {
      const blx = cornerWx[iBL], bly = cornerWy[iBL], blz = cornerZ0[iBL];
      const brx = cornerWx[iBR], bry = cornerWy[iBR], brz = cornerZ0[iBR];
      const trx = cornerWx[iTR], try_ = cornerWy[iTR], trz = cornerZ0[iTR];
      const tlx = cornerWx[iTL], tly = cornerWy[iTL], tlz = cornerZ0[iTL];

      const blr = cornerR[iBL], blg = cornerG[iBL], blb = cornerB[iBL];
      const brr = cornerR[iBR], brg = cornerG[iBR], brb = cornerB[iBR];
      const trr = cornerR[iTR], trg = cornerG[iTR], trb = cornerB[iTR];
      const tlr = cornerR[iTL], tlg = cornerG[iTL], tlb = cornerB[iTL];

      positions.push3(blx, bly, blz);
      positions.push3(brx, bry, brz);
      positions.push3(trx, try_, trz);
      positions.push3(blx, bly, blz);
      positions.push3(trx, try_, trz);
      positions.push3(tlx, tly, tlz);

      for (let k = 0; k < 6; k++) normals.push3(0, 0, 1);

      uvs.push2(blx * 0.25, bly * 0.25);
      uvs.push2(brx * 0.25, bry * 0.25);
      uvs.push2(trx * 0.25, try_ * 0.25);
      uvs.push2(blx * 0.25, bly * 0.25);
      uvs.push2(trx * 0.25, try_ * 0.25);
      uvs.push2(tlx * 0.25, tly * 0.25);

      colors.push3(blr, blg, blb);
      colors.push3(brr, brg, brb);
      colors.push3(trr, trg, trb);
      colors.push3(blr, blg, blb);
      colors.push3(trr, trg, trb);
      colors.push3(tlr, tlg, tlb);
    };

    const interpContourPt = (pA: ContourPt, pB: ContourPt, vA: number, vB: number): ContourPt => {
      const denom = vB - vA;
      const t = Math.abs(denom) < 1e-6 ? 0.5 : clamp((ISO_LEVEL - vA) / denom, 0.02, 0.98);
      const sx = pA.sx + (pB.sx - pA.sx) * t;
      const sy = pA.sy + (pB.sy - pA.sy) * t;
      const wx = simToWorldX(sx);
      const wy = simToWorldY(sy);
      return {
        sx,
        sy,
        wx,
        wy,
        z0: frontZAt(wx, wy),
        col: [
          pA.col[0] + (pB.col[0] - pA.col[0]) * t,
          pA.col[1] + (pB.col[1] - pA.col[1]) * t,
          pA.col[2] + (pB.col[2] - pA.col[2]) * t,
        ],
      };
    };

    // Precompute dual sample grid corners into reusable flat typed arrays (zero per-corner heap objects)
    for (let gy = topGy; gy <= bottomGy; gy++) {
      const sy = sampleSimY(gy);
      const wy = simToWorldY(sy);
      const row = gy * GRID_W;
      const cGy = clamp(gy, minGy, maxGy);
      const cRow = cGy * GRID_W;
      for (let gx = leftGx; gx <= rightGx; gx++) {
        const sx = sampleSimX(gx);
        const wx = simToWorldX(sx);
        const i = row + gx;
        cornerWx[i] = wx;
        cornerWy[i] = wy;
        cornerZ0[i] = frontZAt(wx, wy);

        const cGx = clamp(gx, minGx, maxGx);
        const idx = cRow + cGx;
        let t = terrain[idx];
        if (t === CellType.AIR || t === CellType.TUNNEL || t === CellType.GLASS_WALL) {
          t = cGy < 52 ? CellType.TOPSOIL : cGy > 105 ? CellType.DEEP_CLAY : CellType.SUBSOIL;
        }
        const m = moisture[idx];
        const tint =
          0.5 +
          0.3 * Math.sin(sx * 0.19 + sy * 0.13) +
          0.2 * Math.cos(sx * 0.43 - sy * 0.37);
        const [sr, sg, sb] = granuleColorSrgb(t, m, cGy, tint);
        cornerR[i] = srgbToLin(sr);
        cornerG[i] = srgbToLin(sg);
        cornerB[i] = srgbToLin(sb);
      }
    }

    // Emit Marching Squares front cross-section + smooth bevel contour across tank
    for (let gy = topGy; gy < bottomGy; gy++) {
      let gx = leftGx;
      while (gx < rightGx) {
        const iTL = gy * GRID_W + gx;
        const iTR = iTL + 1;
        const iBR = iTL + GRID_W + 1;
        const iBL = iTL + GRID_W;

        const vTL = fieldA[iTL];
        const vTR = fieldA[iTR];
        const vBR = fieldA[iBR];
        const vBL = fieldA[iBL];

        const mask =
          (vTL >= ISO_LEVEL ? 8 : 0) |
          (vTR >= ISO_LEVEL ? 4 : 0) |
          (vBR >= ISO_LEVEL ? 2 : 0) |
          (vBL >= ISO_LEVEL ? 1 : 0);

        if (mask === 0) {
          gx++;
          continue;
        }

        if (mask === 15) {
          // Merge up to 3 consecutive interior solid cells into one quad to cut vertex & shadow-pass load ~3x
          // while preserving smooth front ripple and soil strata color variation.
          let runEnd = gx + 1;
          const maxRun = Math.min(rightGx, gx + 3);
          while (runEnd < maxRun) {
            const rTL = gy * GRID_W + runEnd;
            if (
              fieldA[rTL] >= ISO_LEVEL &&
              fieldA[rTL + 1] >= ISO_LEVEL &&
              fieldA[rTL + GRID_W + 1] >= ISO_LEVEL &&
              fieldA[rTL + GRID_W] >= ISO_LEVEL
            ) {
              runEnd++;
            } else {
              break;
            }
          }
          const endTL = gy * GRID_W + runEnd;
          pushFrontQuadIdx(iBL, endTL + GRID_W, endTL, iTL);
          gx = runEnd;
          continue;
        }

        const pTL = getCornerPt(iTL);
        const pTR = getCornerPt(iTR);
        const pBR = getCornerPt(iBR);
        const pBL = getCornerPt(iBL);

        const eTop = (vTL >= ISO_LEVEL) !== (vTR >= ISO_LEVEL) ? interpContourPt(pTL, pTR, vTL, vTR) : pTL;
        const eRight = (vTR >= ISO_LEVEL) !== (vBR >= ISO_LEVEL) ? interpContourPt(pTR, pBR, vTR, vBR) : pTR;
        const eBottom = (vBR >= ISO_LEVEL) !== (vBL >= ISO_LEVEL) ? interpContourPt(pBR, pBL, vBR, vBL) : pBR;
        const eLeft = (vBL >= ISO_LEVEL) !== (vTL >= ISO_LEVEL) ? interpContourPt(pBL, pTL, vBL, vTL) : pBL;

        switch (mask) {
          case 1:
            pushFrontTri(pBL, eBottom, eLeft);
            pushContourBevelAndGranules(eBottom, eLeft, gx, gy, 0);
            break;
          case 2:
            pushFrontTri(eBottom, pBR, eRight);
            pushContourBevelAndGranules(eRight, eBottom, gx, gy, 0);
            break;
          case 4:
            pushFrontTri(eRight, pTR, eTop);
            pushContourBevelAndGranules(eTop, eRight, gx, gy, 0);
            break;
          case 8:
            pushFrontTri(eLeft, eTop, pTL);
            pushContourBevelAndGranules(eLeft, eTop, gx, gy, 0);
            break;
          case 3:
            pushFrontTri(pBL, pBR, eRight);
            pushFrontTri(pBL, eRight, eLeft);
            pushContourBevelAndGranules(eRight, eLeft, gx, gy, 0);
            break;
          case 6:
            pushFrontTri(eBottom, pBR, pTR);
            pushFrontTri(eBottom, pTR, eTop);
            pushContourBevelAndGranules(eTop, eBottom, gx, gy, 0);
            break;
          case 12:
            pushFrontTri(eLeft, eRight, pTR);
            pushFrontTri(eLeft, pTR, pTL);
            pushContourBevelAndGranules(eLeft, eRight, gx, gy, 0);
            break;
          case 9:
            pushFrontTri(pBL, eBottom, eTop);
            pushFrontTri(pBL, eTop, pTL);
            pushContourBevelAndGranules(eBottom, eTop, gx, gy, 0);
            break;
          case 7:
            pushFrontTri(pBL, pBR, pTR);
            pushFrontTri(pBL, pTR, eTop);
            pushFrontTri(pBL, eTop, eLeft);
            pushContourBevelAndGranules(eTop, eLeft, gx, gy, 0);
            break;
          case 11:
            pushFrontTri(pBL, pBR, eRight);
            pushFrontTri(pBL, eRight, eTop);
            pushFrontTri(pBL, eTop, pTL);
            pushContourBevelAndGranules(eRight, eTop, gx, gy, 0);
            break;
          case 13:
            pushFrontTri(pBL, eBottom, eRight);
            pushFrontTri(pBL, eRight, pTR);
            pushFrontTri(pBL, pTR, pTL);
            pushContourBevelAndGranules(eBottom, eRight, gx, gy, 0);
            break;
          case 14:
            pushFrontTri(eBottom, pBR, pTR);
            pushFrontTri(eBottom, pTR, pTL);
            pushFrontTri(eBottom, pTL, eLeft);
            pushContourBevelAndGranules(eLeft, eBottom, gx, gy, 0);
            break;
          case 5: {
            const centerSolid = 0.25 * (vTL + vTR + vBR + vBL) >= ISO_LEVEL;
            if (centerSolid) {
              pushFrontTri(pBL, eBottom, eRight);
              pushFrontTri(pBL, eRight, pTR);
              pushFrontTri(pBL, pTR, eTop);
              pushFrontTri(pBL, eTop, eLeft);
              pushContourBevelAndGranules(eBottom, eRight, gx, gy, 0);
              pushContourBevelAndGranules(eTop, eLeft, gx, gy, 1);
            } else {
              pushFrontTri(pBL, eBottom, eLeft);
              pushFrontTri(eRight, pTR, eTop);
              pushContourBevelAndGranules(eBottom, eLeft, gx, gy, 0);
              pushContourBevelAndGranules(eTop, eRight, gx, gy, 1);
            }
            break;
          }
          case 10: {
            const centerSolid = 0.25 * (vTL + vTR + vBR + vBL) >= ISO_LEVEL;
            if (centerSolid) {
              pushFrontTri(eBottom, pBR, eRight);
              pushFrontTri(eBottom, eRight, eTop);
              pushFrontTri(eBottom, eTop, pTL);
              pushFrontTri(eBottom, pTL, eLeft);
              pushContourBevelAndGranules(eRight, eTop, gx, gy, 0);
              pushContourBevelAndGranules(eLeft, eBottom, gx, gy, 1);
            } else {
              pushFrontTri(eBottom, pBR, eRight);
              pushFrontTri(eLeft, eTop, pTL);
              pushContourBevelAndGranules(eRight, eBottom, gx, gy, 0);
              pushContourBevelAndGranules(eLeft, eTop, gx, gy, 1);
            }
            break;
          }
        }
        gx++;
      }
    }

    // Seal outer left/right/bottom tank glass edges so orbiting sideways reveals solid earth behind side glass
    const pushSideWallSpan = (
      x: number,
      yTop: number,
      yBot: number,
      zFTop: number,
      zFBot: number,
      nx: number,
      colTop: [number, number, number],
      colBot: [number, number, number]
    ) => {
      const nSide: [number, number, number] = [nx, 0, 0];
      const cBTop: [number, number, number] = [colTop[0] * 0.62, colTop[1] * 0.62, colTop[2] * 0.62];
      const cBBot: [number, number, number] = [colBot[0] * 0.62, colBot[1] * 0.62, colBot[2] * 0.62];
      if (nx < 0) {
        pushTri(x, yBot, zFBot, 0, 0, x, yTop, zFTop, 0, 1, x, yTop, SOIL_BACK_Z, 1, 1, nSide, nSide, nSide, colBot, colTop, cBTop);
        pushTri(x, yBot, zFBot, 0, 0, x, yTop, SOIL_BACK_Z, 1, 1, x, yBot, SOIL_BACK_Z, 1, 0, nSide, nSide, nSide, colBot, cBTop, cBBot);
      } else {
        pushTri(x, yTop, zFTop, 0, 1, x, yBot, zFBot, 0, 0, x, yBot, SOIL_BACK_Z, 1, 0, nSide, nSide, nSide, colTop, colBot, cBBot);
        pushTri(x, yTop, zFTop, 0, 1, x, yBot, SOIL_BACK_Z, 1, 0, x, yTop, SOIL_BACK_Z, 1, 1, nSide, nSide, nSide, colTop, cBBot, cBTop);
      }
    };

    for (let gy = topGy; gy < bottomGy; gy++) {
      // Left tank glass border
      const vLT = fieldA[gy * GRID_W + leftGx];
      const vLB = fieldA[(gy + 1) * GRID_W + leftGx];
      if (vLT >= ISO_LEVEL || vLB >= ISO_LEVEL) {
        const pTop = getCornerPt(gy * GRID_W + leftGx);
        const pBot = getCornerPt((gy + 1) * GRID_W + leftGx);
        const aTop = vLT >= ISO_LEVEL ? pTop : interpContourPt(pTop, pBot, vLT, vLB);
        const aBot = vLB >= ISO_LEVEL ? pBot : interpContourPt(pTop, pBot, vLT, vLB);
        pushSideWallSpan(aTop.wx, aTop.wy, aBot.wy, aTop.z0, aBot.z0, -1, aTop.col, aBot.col);
      }
      // Right tank glass border
      const vRT = fieldA[gy * GRID_W + rightGx];
      const vRB = fieldA[(gy + 1) * GRID_W + rightGx];
      if (vRT >= ISO_LEVEL || vRB >= ISO_LEVEL) {
        const pTop = getCornerPt(gy * GRID_W + rightGx);
        const pBot = getCornerPt((gy + 1) * GRID_W + rightGx);
        const aTop = vRT >= ISO_LEVEL ? pTop : interpContourPt(pTop, pBot, vRT, vRB);
        const aBot = vRB >= ISO_LEVEL ? pBot : interpContourPt(pTop, pBot, vRT, vRB);
        pushSideWallSpan(aTop.wx, aTop.wy, aBot.wy, aTop.z0, aBot.z0, 1, aTop.col, aBot.col);
      }
    }

    const nBot: [number, number, number] = [0, -1, 0];
    for (let gx = leftGx; gx < rightGx; gx++) {
      const pL = getCornerPt(bottomGy * GRID_W + gx);
      const pR = getCornerPt(bottomGy * GRID_W + (gx + 1));
      const cBL: [number, number, number] = [pL.col[0] * 0.62, pL.col[1] * 0.62, pL.col[2] * 0.62];
      const cBR: [number, number, number] = [pR.col[0] * 0.62, pR.col[1] * 0.62, pR.col[2] * 0.62];
      pushTri(pR.wx, pR.wy, pR.z0, 1, 0, pL.wx, pL.wy, pL.z0, 0, 0, pL.wx, pL.wy, SOIL_BACK_Z, 0, 1, nBot, nBot, nBot, pR.col, pL.col, cBL);
      pushTri(pR.wx, pR.wy, pR.z0, 1, 0, pL.wx, pL.wy, SOIL_BACK_Z, 0, 1, pR.wx, pR.wy, SOIL_BACK_Z, 1, 1, nBot, nBot, nBot, pR.col, cBL, cBR);
    }

    // --- PART B: Indexed Smooth Concave Curved Cavern & Cylindrical Tunnel Back Shell ---
    const curvedVertexDepth = (vx: number, vy: number): number => {
      let sum = 0;
      let count = 0;
      let hasSolid = false;
      for (let oy = -1; oy <= 0; oy++) {
        for (let ox = -1; ox <= 0; ox++) {
          const cx = vx + ox;
          const cy = vy + oy;
          if (cx < 0 || cx >= GRID_W || cy < 0 || cy >= GRID_H) continue;
          const idx = cy * GRID_W + cx;
          const t = terrain[idx];
          if (t === CellType.TUNNEL) {
            sum += cavityDepth[idx];
            count++;
          } else if (t === CellType.AIR) {
            sum += 0.9;
            count++;
          } else if (t !== CellType.GLASS_WALL) {
            hasSolid = true;
            count++;
          }
        }
      }
      if (count === 0) return 0;
      const avg = sum / count;
      return hasSolid ? avg * 0.45 : avg;
    };

    const stride = GRID_W + 1;
    const vCount = (GRID_W + 1) * (GRID_H + 1);
    const curvedVertexMap = this.curvedVertexMap;
    curvedVertexMap.fill(-1, 0, vCount);
    const cPositions = this.sCPositions;
    const cUvs = this.sCUvs;
    const cColors = this.sCColors;
    const cIndices = this.sCIndices;
    cPositions.reset();
    cUvs.reset();
    cColors.reset();
    cIndices.reset();

    const ensureCurvedVertex = (vx: number, vy: number, m: number): number => {
      const key = vy * stride + vx;
      const existing = curvedVertexMap[key];
      if (existing !== -1) return existing;

      const idx = cPositions.length / 3;
      curvedVertexMap[key] = idx;

      const d = curvedVertexDepth(vx, vy);
      const baseX = simToWorldX(vx * CELL_SIZE);
      const baseY = simToWorldY(vy * CELL_SIZE);
      const edgeLock = vx <= leftGx + 1 || vx >= rightGx - 1 || vy >= bottomGy - 1 ? 0.12 : 1.0;
      const dx = (deterministicRand(vx, vy, 61) - 0.5) * 0.018 * edgeLock;
      const dy = (deterministicRand(vx, vy, 62) - 0.5) * 0.018 * edgeLock;
      const dz = (deterministicRand(vx, vy, 63) - 0.5) * 0.024;
      cPositions.push3(baseX + dx, baseY + dy, cavityDepthToZ(d) + dz);
      cUvs.push2(vx * 0.06, (GRID_H - vy) * 0.06);

      const depthShade = clamp(0.82 - d * 0.075, 0.44, 0.85);
      const [sr, sg, sb] = granuleColorSrgb(
        vy < 52 ? CellType.TOPSOIL : vy > 105 ? CellType.DEEP_CLAY : CellType.SUBSOIL,
        m,
        vy,
        deterministicRand(vx, vy, 71)
      );
      _col.setRGB(sr * depthShade, sg * depthShade, sb * depthShade, THREE.SRGBColorSpace);
      cColors.push3(_col.r, _col.g, _col.b);
      return idx;
    };

    const cellW = CELL_SIZE * WORLD_SCALE;
    for (let gy = 1; gy < GRID_H - 1; gy++) {
      for (let gx = 1; gx < GRID_W - 1; gx++) {
        const idx = gy * GRID_W + gx;
        const t = terrain[idx];
        const m = moisture[idx];

        const emitCurvedShell = t === CellType.TUNNEL || (isSolid(gx, gy) && hasNeighborTunnel(gx, gy));
        if (emitCurvedShell) {
          const iBL = ensureCurvedVertex(gx, gy + 1, m);
          const iBR = ensureCurvedVertex(gx + 1, gy + 1, m);
          const iTR = ensureCurvedVertex(gx + 1, gy, m);
          const iTL = ensureCurvedVertex(gx, gy, m);
          cIndices.push6(iBL, iBR, iTR, iBL, iTR, iTL);

          if (t === CellType.TUNNEL) {
            const cellDepth = cavityDepth[idx];
            const backShade = clamp(0.84 - cellDepth * 0.07, 0.48, 0.88);

            // Place 3 spheres using exact barycentric coordinates on the rendered curved cavern triangles
            for (let k = 0; k < 3; k++) {
              const useTri0 = k % 2 === 0;
              const ia = iBL;
              const ib = useTri0 ? iBR : iTR;
              const ic = useTri0 ? iTR : iTL;

              const ax = cPositions.get(ia * 3);
              const ay = cPositions.get(ia * 3 + 1);
              const az = cPositions.get(ia * 3 + 2);
              const bx = cPositions.get(ib * 3);
              const by = cPositions.get(ib * 3 + 1);
              const bz = cPositions.get(ib * 3 + 2);
              const cx = cPositions.get(ic * 3);
              const cy = cPositions.get(ic * 3 + 1);
              const cz = cPositions.get(ic * 3 + 2);

              let u = deterministicRand(gx, gy, 11 + k * 5);
              let v = deterministicRand(gx, gy, 12 + k * 5);
              if (u + v > 1) {
                u = 1 - u;
                v = 1 - v;
              }
              let w0 = 1 - u - v;
              // Keep slightly inside triangle interior and compute triangle normal
              w0 = w0 * 0.82 + 0.06;
              const w1 = u * 0.82 + 0.06;
              const w2 = 1 - w0 - w1;

              const e1x = bx - ax;
              const e1y = by - ay;
              const e1z = bz - az;
              const e2x = cx - ax;
              const e2y = cy - ay;
              const e2z = cz - az;
              let nx = e1y * e2z - e1z * e2y;
              let ny = e1z * e2x - e1x * e2z;
              let nz = e1x * e2y - e1y * e2x;
              if (nz < 0) {
                nx = -nx;
                ny = -ny;
                nz = -nz;
              }
              const nLen = Math.hypot(nx, ny, nz) || 1;
              nx /= nLen;
              ny /= nLen;
              nz /= nLen;

              const rad = 0.021 + deterministicRand(gx, gy, 13 + k * 5) * 0.013;
              const offset = rad * 0.25;
              const px = ax * w0 + bx * w1 + cx * w2 + nx * offset;
              const py = ay * w0 + by * w1 + cy * w2 + ny * offset;
              const pz = az * w0 + bz * w1 + cz * w2 + nz * offset;

              const [r, g, b] = granuleColorSrgb(
                gy > 105 ? CellType.DEEP_CLAY : CellType.SUBSOIL,
                m,
                gy,
                deterministicRand(gx, gy, 14 + k * 5)
              );
              pushSphere(px, py, pz, rad, r * backShade, g * backShade, b * backShade);
            }
          }
        }
        void cellW;
      }
    }

    const solidGeo = new THREE.BufferGeometry();
    solidGeo.setAttribute('position', new THREE.BufferAttribute(positions.take(), 3));
    solidGeo.setAttribute('normal', new THREE.BufferAttribute(normals.take(), 3));
    solidGeo.setAttribute('uv', new THREE.BufferAttribute(uvs.take(), 2));
    solidGeo.setAttribute('color', new THREE.BufferAttribute(colors.take(), 3));
    solidGeo.computeBoundingSphere();

    this.solidMesh.geometry.dispose();
    this.solidMesh.geometry = solidGeo;

    const curvedGeo = new THREE.BufferGeometry();
    curvedGeo.setAttribute('position', new THREE.BufferAttribute(cPositions.take(), 3));
    curvedGeo.setAttribute('uv', new THREE.BufferAttribute(cUvs.take(), 2));
    curvedGeo.setAttribute('color', new THREE.BufferAttribute(cColors.take(), 3));
    curvedGeo.setIndex(new THREE.BufferAttribute(cIndices.take(), 1));
    curvedGeo.computeVertexNormals();
    curvedGeo.computeBoundingSphere();

    this.curvedCavernMesh.geometry.dispose();
    this.curvedCavernMesh.geometry = curvedGeo;

    this.granuleMesh.count = granuleCount;
    this.granuleMesh.instanceMatrix.needsUpdate = true;
    if (this.granuleMesh.instanceColor) {
      this.granuleMesh.instanceColor.needsUpdate = true;
    }
    this.granuleMesh.computeBoundingSphere();
  }

  public dispose(): void {
    this.solidMesh.geometry.dispose();
    this.curvedCavernMesh.geometry.dispose();
    this.granuleMesh.geometry.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
