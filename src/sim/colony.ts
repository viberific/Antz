import { ColonyGrid } from './pathfinding';
import {
  Ant,
  AntCaste,
  AntTask,
  BroodItem,
  BroodStage,
  CASE_BOTTOM,
  CASE_LEFT,
  CASE_RIGHT,
  CASE_TOP,
  CELL_SIZE,
  CellType,
  Chamber,
  ChamberType,
  FallenAnt,
  FoodSource,
  GRID_H,
  GRID_W,
  Intruder,
  Particle,
  PayloadType,
  PlantSprout,
  SURFACE_BASE_Y,
  SurfaceProp,
  Vec2,
  WaterDroplet,
} from './types';

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function lerpAngle(a: number, b: number, t: number): number {
  const diff = wrapAngle(b - a);
  return a + diff * t;
}

/** Sustainable colony size: roughly what the surface food supply (and the renderer) can carry. */
const MAX_COLONY = 160;
const MAX_BROOD = 60;
const SIDE_ENTRANCE_X = 405;
/** seconds per full day/night cycle */
const DAY_LENGTH = 200;
const INF = 1e6;
const N_CELLS = GRID_W * GRID_H;
/** world units: radius of the open crater kept clear around each entrance hole */
const CRATER_MAIN = 7;
const CRATER_SIDE = 6;

const HASH_CELL = 32;
const HASH_W = Math.ceil(1440 / HASH_CELL);
const HASH_H = Math.ceil(880 / HASH_CELL);

type FieldKey =
  | 'surface'
  | 'mound'
  | 'midden'
  | 'royal'
  | 'nursery'
  | 'granary'
  | 'fungus'
  | 'store'
  | 'dig'
  | 'threat';

const STATIC_FIELDS: FieldKey[] = ['surface', 'mound', 'midden', 'royal', 'nursery', 'granary', 'fungus', 'store'];

/** A planned excavation: a tunnel leading to (optionally) a new chamber. Cells to dig live in `digPlan`. */
interface DigProject {
  id: number;
  kind: 'chamber' | 'gallery';
  type: ChamberType;
  x: number;
  y: number;
  rx: number;
  ry: number;
  totalCells: number;
}

export interface ColonyEvent {
  time: number;
  text: string;
  kind: 'info' | 'danger' | 'good';
}

export interface ColonyStats {
  population: number;
  queenAlive: boolean;
  castes: Record<string, number>;
  eggs: number;
  larvae: number;
  pupae: number;
  storedFood: number;
  chambers: number;
  tunnelCells: number;
  moundSoil: number;
  intruders: number;
  day: number;
  isNight: boolean;
  weather: string;
  busy: Record<string, number>;
}

const isFoodPayload = (p: PayloadType) =>
  p === PayloadType.SEED || p === PayloadType.HONEYDEW || p === PayloadType.PROTEIN || p === PayloadType.FUNGUS;
const isBroodPayload = (p: PayloadType) => p === PayloadType.EGG || p === PayloadType.LARVA || p === PayloadType.PUPA;

/** tasks where the ant stands still for `stateTimer` seconds */
const BUSY_TASKS = new Set<AntTask>([
  AntTask.IDLE,
  AntTask.GREETING,
  AntTask.TROPHALLAXIS,
  AntTask.GROOMING,
  AntTask.TENDING_FUNGUS,
  AntTask.SIGNALING_FOOD,
  AntTask.EATING,
  AntTask.DRINKING_DEW,
]);

export class AntColonySimulation {
  public grid: ColonyGrid;
  public ants: Ant[] = [];
  public brood: BroodItem[] = [];
  public foods: FoodSource[] = [];
  public chambers: Chamber[] = [];
  public droplets: WaterDroplet[] = [];
  public intruders: Intruder[] = [];
  public fallenAnts: FallenAnt[] = [];
  public particles: Particle[] = [];
  public sprouts: PlantSprout[] = [];
  public surfaceProps: SurfaceProp[] = [];
  public rootPolylines: Vec2[][] = [];
  public events: ColonyEvent[] = [];

  public simTime: number = 0;
  public timeOfDay: number = 0.3;
  public dayCount: number = 1;
  public weather: 'Clear' | 'Misty' | 'Light Rain' = 'Clear';
  public windStrength: number = 0.35;
  private weatherTimer: number = 70;

  public entrancePos: Vec2 = { x: 700, y: SURFACE_BASE_Y };
  public middenPos: Vec2 = { x: 1290, y: SURFACE_BASE_Y };
  public tunnelsDugCells: number = 0;
  public soilDeposited: number = 0;
  /** ground height per column before any mound building (the mound's height is measured against this) */
  private baseGround: Float32Array | null = null;

  /** 0 = nothing planned, 1 = planned expansion, 2 = urgent repair of storm damage */
  public digPlan: Uint8Array = new Uint8Array(N_CELLS);
  private projects: DigProject[] = [];
  private planCount = 0;
  private repairCount = 0;

  private nextId: number = 1;
  private naturalFoodTimer: number = 4;
  private intruderTimer: number = 50;
  private fungusTimer: number = 8;
  private queenEggTimer: number = 3;
  private labourTimer: number = 3;
  private planTimer: number = 1;
  private damageTimer: number = 4;
  private pherAccum = 0;
  /** running totals, handy for tuning and debugging */
  public counters = { pickups: 0, deliveries: 0, digs: 0, deposits: 0, larvaFeeds: 0, queenFeeds: 0 };
  /** A* searches still allowed this step */
  private pathBudget = 0;

  // --- flow fields ------------------------------------------------------------------------------------------------
  private fields: Record<FieldKey, Float32Array>;
  private fieldDirty: Record<FieldKey, boolean>;
  private fieldAge: Record<FieldKey, number>;
  private fieldTerrainVersion = -1;

  // --- per-step caches --------------------------------------------------------------------------------------------
  private hashHead = new Int32Array(HASH_W * HASH_H);
  private hashNext = new Int32Array(1024);
  private storedFoodCache = 0;
  private claimedBrood = new Set<number>();
  private claimedDig = new Set<number>();
  private queenFeederId: number | null = null;

  private static readonly SAVE_KEY = 'formicarium_colony_v2';

  constructor() {
    this.grid = new ColonyGrid();
    const mk = () => new Float32Array(N_CELLS).fill(INF);
    this.fields = {
      surface: mk(),
      mound: mk(),
      midden: mk(),
      royal: mk(),
      nursery: mk(),
      granary: mk(),
      fungus: mk(),
      store: mk(),
      dig: mk(),
      threat: mk(),
    };
    this.fieldDirty = {} as Record<FieldKey, boolean>;
    this.fieldAge = {} as Record<FieldKey, number>;
    for (const k of Object.keys(this.fields) as FieldKey[]) {
      this.fieldDirty[k] = true;
      this.fieldAge[k] = 99;
    }
    try {
      localStorage.removeItem('formicarium_colony_v1'); // old format: its colonies were stuck and can't be upgraded
    } catch {
      /* storage unavailable */
    }
    if (!this.loadState()) {
      this.initWorld();
      this.saveState();
    }
    for (const k of Object.keys(this.fields) as FieldKey[]) this.rebuildField(k);
    this.fieldTerrainVersion = this.grid.terrainVersion;
  }

  private allocId(): number {
    return this.nextId++;
  }

  private log(text: string, kind: ColonyEvent['kind'] = 'info'): void {
    this.events.push({ time: this.simTime, text, kind });
    if (this.events.length > 8) this.events.shift();
  }

  // ================================================================================================================
  // World generation
  // ================================================================================================================

  private initWorld(): void {
    const leftGx = Math.floor(CASE_LEFT / CELL_SIZE);
    const rightGx = Math.floor(CASE_RIGHT / CELL_SIZE);
    const topGy = Math.floor(CASE_TOP / CELL_SIZE);
    const bottomGy = Math.floor(CASE_BOTTOM / CELL_SIZE);

    // 1. Stratified soil & glass enclosure
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (gx <= leftGx || gx >= rightGx || gy <= topGy || gy >= bottomGy) {
          this.grid.terrain[gy * GRID_W + gx] = CellType.GLASS_WALL;
          continue;
        }
        const wx = gx * CELL_SIZE;
        const wy = gy * CELL_SIZE;
        const contour =
          SURFACE_BASE_Y +
          Math.sin(wx * 0.0065) * 13 +
          Math.cos(wx * 0.017) * 6 +
          Math.sin(wx * 0.041) * 2.5;
        const distEntrance = Math.abs(wx - 700);
        const moundOffset = distEntrance < 92 ? -Math.cos((distEntrance / 92) * Math.PI * 0.5) * 7 : 0;
        const surfY = contour + moundOffset;

        if (wy < surfY) {
          this.grid.terrain[gy * GRID_W + gx] = CellType.AIR;
          this.grid.moisture[gy * GRID_W + gx] = 0.25;
        } else {
          const depth = wy - surfY;
          const wave = Math.sin(wx * 0.012 + wy * 0.004) * 18 + Math.cos(wx * 0.029) * 8;
          if (depth < 52 + wave * 0.4) {
            this.grid.terrain[gy * GRID_W + gx] = CellType.TOPSOIL;
            this.grid.moisture[gy * GRID_W + gx] = 0.42 + Math.random() * 0.1;
          } else if (depth < 290 + wave) {
            this.grid.terrain[gy * GRID_W + gx] = CellType.SUBSOIL;
            this.grid.moisture[gy * GRID_W + gx] = 0.48 + Math.random() * 0.1;
          } else {
            this.grid.terrain[gy * GRID_W + gx] = CellType.DEEP_CLAY;
            this.grid.moisture[gy * GRID_W + gx] = 0.58 + Math.random() * 0.12;
          }
        }
      }
    }

    // 2. Embedded river pebbles
    for (let p = 0; p < 55; p++) {
      const px = CASE_LEFT + 60 + Math.random() * (CASE_RIGHT - CASE_LEFT - 120);
      const py = SURFACE_BASE_Y + 45 + Math.random() * (CASE_BOTTOM - SURFACE_BASE_Y - 90);
      if (Math.abs(px - 700) < 120 && py < 660) continue;
      const rx = 6 + Math.random() * 14;
      const ry = 4 + Math.random() * 9;
      this.paintEllipse(px, py, rx, ry, CellType.PEBBLE, true);
    }

    // 3. Organic subterranean plant roots
    const rootOrigins = [190, 340, 560, 960, 1140, 1280];
    for (const rx0 of rootOrigins) {
      let rx = rx0;
      let ry = SURFACE_BASE_Y + 8;
      let angle = Math.PI * 0.5 + (Math.random() - 0.5) * 0.4;
      const steps = 24 + Math.floor(Math.random() * 28);
      const mainPoly: Vec2[] = [{ x: rx, y: ry - 6 }];
      for (let s = 0; s < steps; s++) {
        angle += (Math.random() - 0.5) * 0.32;
        angle = clamp(angle, Math.PI * 0.25, Math.PI * 0.75);
        rx += Math.cos(angle) * 7.2;
        ry += Math.sin(angle) * 7.2;
        if (ry > CASE_BOTTOM - 40) break;
        mainPoly.push({ x: rx, y: ry });
        const g = this.grid.worldToGrid(rx, ry);
        if (this.grid.terrain[this.grid.idx(g.gx, g.gy)] !== CellType.PEBBLE) {
          this.grid.terrain[this.grid.idx(g.gx, g.gy)] = CellType.ROOT;
        }
        if (s > 5 && Math.random() < 0.26) {
          let fx = rx;
          let fy = ry;
          let fa = angle + (Math.random() < 0.5 ? -0.58 : 0.58);
          const forkPoly: Vec2[] = [{ x: fx, y: fy }];
          for (let k = 0; k < 9; k++) {
            fx += Math.cos(fa) * 6;
            fy += Math.sin(fa) * 6;
            forkPoly.push({ x: fx, y: fy });
            const fg = this.grid.worldToGrid(fx, fy);
            if (this.grid.inBounds(fg.gx, fg.gy) && this.grid.terrain[this.grid.idx(fg.gx, fg.gy)] !== CellType.PEBBLE) {
              this.grid.terrain[this.grid.idx(fg.gx, fg.gy)] = CellType.ROOT;
            }
          }
          this.rootPolylines.push(forkPoly);
        }
      }
      this.rootPolylines.push(mainPoly);
    }

    // 4. Carve starting organic chambers and winding tunnels
    const granary: Chamber = { id: this.allocId(), type: ChamberType.GRANARY, x: 505, y: 385, rx: 56, ry: 28 };
    const nursery: Chamber = { id: this.allocId(), type: ChamberType.NURSERY, x: 875, y: 430, rx: 60, ry: 30 };
    const fungus: Chamber = { id: this.allocId(), type: ChamberType.FUNGUS, x: 470, y: 555, rx: 48, ry: 26 };
    const royal: Chamber = { id: this.allocId(), type: ChamberType.ROYAL, x: 735, y: 615, rx: 68, ry: 32 };
    this.chambers.push(granary, nursery, fungus, royal);

    for (const c of this.chambers) {
      this.carveOrganicChamber(c.x, c.y, c.rx, c.ry);
    }

    this.grid.updateSurfaceProfile();
    const entGx = Math.floor(700 / CELL_SIZE);
    this.entrancePos = { x: 700, y: this.grid.surfaceY[entGx] - 4 };
    this.middenPos = { x: 1290, y: this.grid.surfaceY[Math.floor(1290 / CELL_SIZE)] - 4 };

    this.carveTunnelPath([
      { x: 700, y: this.entrancePos.y - 6 },
      { x: 696, y: 270 },
      { x: 682, y: 320 },
      { x: 698, y: 375 },
      { x: 718, y: 455 },
      { x: 702, y: 540 },
      { x: royal.x - 10, y: royal.y },
    ], 10);

    this.carveTunnelPath([
      { x: 695, y: 372 },
      { x: 615, y: 392 },
      { x: granary.x + 25, y: granary.y + 4 },
    ], 9);

    this.carveTunnelPath([
      { x: 715, y: 440 },
      { x: 785, y: 448 },
      { x: nursery.x - 28, y: nursery.y + 4 },
    ], 9);

    this.carveTunnelPath([
      { x: granary.x, y: granary.y + 18 },
      { x: 482, y: 470 },
      { x: fungus.x, y: fungus.y },
    ], 9);

    this.carveTunnelPath([
      { x: fungus.x + 30, y: fungus.y + 6 },
      { x: 595, y: 595 },
      { x: royal.x - 36, y: royal.y + 4 },
    ], 9);

    this.carveTunnelPath([
      { x: 405, y: this.grid.surfaceY[Math.floor(405 / CELL_SIZE)] - 4 },
      { x: 412, y: 295 },
      { x: 445, y: 350 },
      { x: granary.x - 32, y: granary.y - 4 },
    ], 8);

    this.flareEntranceMouths();

    // 5. Surface flora, rocky edge outcrops & natural terrarium props
    for (let sx = CASE_LEFT + 112; sx < CASE_RIGHT - 112; sx += 9 + Math.random() * 12) {
      if (Math.abs(sx - 700) < 26 || Math.abs(sx - 405) < 18) continue;
      const gx = Math.floor(sx / CELL_SIZE);
      const sy = this.grid.surfaceY[gx];
      const r = Math.random();
      const kind = r < 0.52 ? 'moss' : r < 0.76 ? 'grass' : r < 0.90 ? 'clover' : 'fern';
      this.sprouts.push({
        x: sx,
        y: sy,
        height: kind === 'moss' ? 4 + Math.random() * 5.5 : kind === 'clover' ? 10 + Math.random() * 8 : 14 + Math.random() * 20,
        swayPhase: Math.random() * Math.PI * 2,
        kind,
        shade: 0.72 + Math.random() * 0.48,
      });
    }

    const propSpots: { kind: SurfaceProp['kind']; x: number; w: number; h: number; angle: number }[] = [
      { kind: 'outcrop', x: CASE_LEFT + 64, w: 78, h: 35, angle: 0.03 },
      { kind: 'outcrop', x: CASE_RIGHT - 64, w: 78, h: 36, angle: -0.03 },
      { kind: 'bark', x: 285, w: 96, h: 20, angle: -0.09 },
      { kind: 'stone', x: 1035, w: 46, h: 24, angle: 0.06 },
      { kind: 'stone', x: 565, w: 30, h: 16, angle: -0.08 },
      { kind: 'stone', x: 1175, w: 36, h: 18, angle: 0.04 },
      { kind: 'leaf', x: 175, w: 24, h: 9, angle: 0.12 },
      { kind: 'leaf', x: 475, w: 22, h: 8, angle: -0.14 },
      { kind: 'leaf', x: 840, w: 26, h: 9, angle: 0.08 },
      { kind: 'leaf', x: 1225, w: 20, h: 8, angle: -0.1 },
    ];
    for (let i = 0; i < propSpots.length; i++) {
      const p = propSpots[i];
      const gx = Math.floor(p.x / CELL_SIZE);
      this.surfaceProps.push({
        kind: p.kind,
        x: p.x,
        y: this.grid.surfaceY[gx],
        width: p.w,
        height: p.h,
        angle: p.angle,
        seed: i * 17.3 + 4.1,
      });
    }

    // 6. Seed initial foods & autonomous foraging targets
    this.foods.push(
      { id: this.allocId(), type: PayloadType.SEED, x: granary.x - 22, y: granary.y + 12, amount: 45, maxAmount: 50, radius: 7, storedInChamberId: granary.id },
      { id: this.allocId(), type: PayloadType.SEED, x: granary.x + 8, y: granary.y + 14, amount: 40, maxAmount: 50, radius: 6, storedInChamberId: granary.id },
      { id: this.allocId(), type: PayloadType.HONEYDEW, x: granary.x + 26, y: granary.y + 11, amount: 35, maxAmount: 45, radius: 6, storedInChamberId: granary.id },
      { id: this.allocId(), type: PayloadType.FUNGUS, x: fungus.x - 10, y: fungus.y + 10, amount: 30, maxAmount: 50, radius: 8, storedInChamberId: fungus.id },
      { id: this.allocId(), type: PayloadType.FUNGUS, x: fungus.x + 16, y: fungus.y + 11, amount: 28, maxAmount: 50, radius: 7, storedInChamberId: fungus.id }
    );

    this.grid.rebuildNav();
    this.baseGround = Float32Array.from(this.grid.surfaceY);

    this.spawnSurfaceFood(PayloadType.SEED, 250, false);
    this.spawnSurfaceFood(PayloadType.HONEYDEW, 540, false);
    this.spawnSurfaceFood(PayloadType.SEED, 910, false);
    this.spawnSurfaceFood(PayloadType.PROTEIN, 1085, false);
    this.spawnSurfaceFood(PayloadType.HONEYDEW, 1185, false);

    // Initial brood spread over the life cycle so the colony keeps renewing from the start
    for (let i = 0; i < 6; i++) {
      this.brood.push(this.makeBrood(BroodStage.EGG, royal.x + 14 + (Math.random() - 0.5) * 26, royal.y + 10, royal.id, Math.random() * 60, 90));
    }
    for (let i = 0; i < 8; i++) {
      this.brood.push(this.makeBrood(BroodStage.LARVA, nursery.x + (Math.random() - 0.5) * 30, nursery.y + 10, nursery.id, Math.random() * 75, 45 + Math.random() * 45));
    }
    for (let i = 0; i < 6; i++) {
      this.brood.push(this.makeBrood(BroodStage.PUPA, nursery.x + nursery.rx * 0.45 + (Math.random() - 0.5) * 16, nursery.y + 10, nursery.id, 25 + Math.random() * 65, 100));
    }

    const tunnelPositions: Vec2[] = [];
    for (let gy = 38; gy < GRID_H - 12; gy++) {
      for (let gx = 12; gx < GRID_W - 12; gx++) {
        if (this.grid.terrain[this.grid.idx(gx, gy)] === CellType.TUNNEL) tunnelPositions.push(this.grid.gridToWorld(gx, gy));
      }
    }
    const pickTunnelPos = (): Vec2 =>
      tunnelPositions.length > 0 ? tunnelPositions[Math.floor(Math.random() * tunnelPositions.length)] : { x: royal.x, y: royal.y };

    this.spawnAnt(AntCaste.QUEEN, royal.x - 10, royal.y + 8);
    for (let i = 0; i < 24; i++) {
      if (i < 12) {
        const sx = 240 + Math.random() * 940;
        this.spawnAnt(AntCaste.WORKER, sx, this.grid.surfaceY[Math.floor(sx / CELL_SIZE)] - 1.5);
      } else {
        const p = pickTunnelPos();
        this.spawnAnt(AntCaste.WORKER, p.x, p.y);
      }
    }
    for (let i = 0; i < 12; i++) {
      const target = i < 4 ? royal : nursery;
      this.spawnAnt(AntCaste.NURSE, target.x + (Math.random() - 0.5) * 32, target.y + (Math.random() - 0.5) * 12);
    }
    for (let i = 0; i < 12; i++) {
      const p = pickTunnelPos();
      this.spawnAnt(AntCaste.EXCAVATOR, p.x, p.y);
    }
    for (let i = 0; i < 8; i++) {
      if (i < 5) {
        const sx = 640 + Math.random() * 120;
        this.spawnAnt(AntCaste.SOLDIER, sx, this.grid.surfaceY[Math.floor(sx / CELL_SIZE)] - 1.5);
      } else {
        this.spawnAnt(AntCaste.SOLDIER, royal.x + (Math.random() - 0.5) * 36, royal.y + 4);
      }
    }
    // Founders span a range of ages so they don't all die in the same minute (a generation cliff).
    for (const a of this.ants) {
      if (a.caste !== AntCaste.QUEEN) a.age = Math.random() * 0.6 * a.maxAge;
    }

    for (let i = 0; i < 65; i++) this.particles.push(this.makeDustMote());

    // Give the diggers something to do from the first minute: a deeper nursery off the royal chamber
    this.planNewProject(ChamberType.NURSERY);
    this.log('A young colony settles into the formicarium', 'good');
  }

  private makeBrood(stage: BroodStage, x: number, y: number, chamberId: number, progress: number, nutrition: number): BroodItem {
    return {
      id: this.allocId(),
      stage,
      x,
      y,
      progress,
      nutrition,
      carriedByAntId: null,
      chamberId,
      wigglePhase: Math.random() * Math.PI * 2,
    };
  }

  private makeDustMote(): Particle {
    return {
      x: CASE_LEFT + 20 + Math.random() * (CASE_RIGHT - CASE_LEFT - 40),
      y: CASE_TOP + 10 + Math.random() * (SURFACE_BASE_Y - CASE_TOP + 20),
      vx: (Math.random() - 0.5) * 5,
      vy: -1.5 + Math.random() * 3,
      size: 0.7 + Math.random() * 2.0,
      alpha: 0.14 + Math.random() * 0.42,
      life: Math.random() * 100,
      maxLife: 99999,
      kind: 'dust',
      color: '#f5e6c8',
    };
  }

  private paintEllipse(cx: number, cy: number, rx: number, ry: number, type: CellType, onlyInSoil: boolean): void {
    const minGx = Math.floor((cx - rx) / CELL_SIZE);
    const maxGx = Math.ceil((cx + rx) / CELL_SIZE);
    const minGy = Math.floor((cy - ry) / CELL_SIZE);
    const maxGy = Math.ceil((cy + ry) / CELL_SIZE);

    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        if (!this.grid.inBounds(gx, gy)) continue;
        const wx = (gx + 0.5) * CELL_SIZE;
        const wy = (gy + 0.5) * CELL_SIZE;
        const dx = (wx - cx) / rx;
        const dy = (wy - cy) / ry;
        if (dx * dx + dy * dy <= 1) {
          const cur = this.grid.terrain[this.grid.idx(gx, gy)];
          if (cur === CellType.GLASS_WALL) continue;
          if (onlyInSoil && (cur === CellType.AIR || cur === CellType.TUNNEL)) continue;
          this.grid.setTerrain(gx, gy, type);
        }
      }
    }
  }

  private carveOrganicChamber(cx: number, cy: number, rx: number, ry: number): void {
    const minGx = Math.floor((cx - rx - 6) / CELL_SIZE);
    const maxGx = Math.ceil((cx + rx + 6) / CELL_SIZE);
    const minGy = Math.floor((cy - ry - 6) / CELL_SIZE);
    const maxGy = Math.ceil((cy + ry + 6) / CELL_SIZE);

    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        if (!this.grid.inBounds(gx, gy)) continue;
        const wx = (gx + 0.5) * CELL_SIZE;
        const wy = (gy + 0.5) * CELL_SIZE;
        const angle = Math.atan2(wy - cy, wx - cx);
        const wobble = 1 + 0.08 * Math.sin(angle * 5 + cx) + 0.05 * Math.cos(angle * 3 - cy);
        const dx = (wx - cx) / (rx * wobble);
        const dy = (wy - cy) / (ry * wobble);
        if (dx * dx + dy * dy <= 1) {
          const cur = this.grid.terrain[this.grid.idx(gx, gy)];
          if (cur !== CellType.GLASS_WALL && cur !== CellType.AIR) {
            this.grid.setTerrain(gx, gy, CellType.TUNNEL);
          }
        }
      }
    }
  }

  private carveTunnelPath(points: Vec2[], radiusPx: number): void {
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / 4));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const px = a.x + (b.x - a.x) * t + Math.sin(t * Math.PI * 2 + i) * 3;
        const py = a.y + (b.y - a.y) * t;
        this.paintEllipse(px, py, radiusPx, radiusPx * 0.9, CellType.TUNNEL, true);
      }
    }
  }

  /**
   * Carves a wide, shallow conical funnel into both nest entrances so the terrain transitions
   * gently (~22-30 deg slope) from vertical tunnel shaft to trumpet arch to flat exterior ground.
   */
  private flareEntranceMouths(): void {
    const entrances: [number, boolean][] = [
      [this.entrancePos.x, true],
      [405, false],
    ];
    for (const [entX, isMain] of entrances) {
      const entGx = clamp(Math.floor(entX / CELL_SIZE), 14, GRID_W - 15);
      const sampleOff = isMain ? 10 : 8;
      const baseGroundY =
        (this.grid.surfaceY[clamp(entGx - sampleOff, 4, GRID_W - 5)] +
          this.grid.surfaceY[clamp(entGx + sampleOff, 4, GRID_W - 5)]) *
        0.5;

      const rimRadius = isMain ? 46 : 34;
      const centerRadius = isMain ? 11 : 9;
      const funnelDepth = isMain ? 15 : 12;
      const minGx = clamp(Math.floor((entX - rimRadius - 8) / CELL_SIZE), 10, GRID_W - 11);
      const maxGx = clamp(Math.ceil((entX + rimRadius + 8) / CELL_SIZE), 10, GRID_W - 11);
      const topAirGy = Math.floor((CASE_TOP + 12) / CELL_SIZE);

      for (let gx = minGx; gx <= maxGx; gx++) {
        const wx = (gx + 0.5) * CELL_SIZE;
        const dx = Math.abs(wx - entX);
        if (dx > rimRadius) continue;

        const t = clamp((dx - centerRadius) / (rimRadius - centerRadius), 0, 1);
        const smooth = t * t * (3 - 2 * t);
        const targetFloorY = (baseGroundY + funnelDepth) * (1 - smooth) + (baseGroundY - 1.5) * smooth;
        const floorGy = Math.floor(targetFloorY / CELL_SIZE);

        for (let gy = topAirGy; gy < floorGy; gy++) {
          if (this.grid.terrain[this.grid.idx(gx, gy)] !== CellType.GLASS_WALL) {
            this.grid.setTerrain(gx, gy, CellType.AIR);
          }
        }
        if (dx > centerRadius) {
          const fillBottomGy = Math.min(GRID_H - 12, floorGy + 3);
          for (let gy = floorGy; gy <= fillBottomGy; gy++) {
            const cur = this.grid.terrain[this.grid.idx(gx, gy)];
            if (cur === CellType.AIR) {
              this.grid.setTerrain(gx, gy, CellType.TOPSOIL);
            }
          }
        }
      }

      // Curved trumpet-bell shaft widening smoothly up into the conical funnel
      const throatTopY = baseGroundY + funnelDepth - 2;
      const throatBotY = baseGroundY + 54;
      for (let y = throatTopY; y <= throatBotY; y += 3) {
        const u = clamp((y - throatTopY) / Math.max(1, throatBotY - throatTopY), 0, 1);
        const rx = centerRadius + (isMain ? 15 : 11) * Math.pow(1 - u, 1.6);
        this.paintEllipse(entX, y, rx, 5.5, CellType.TUNNEL, true);
      }

      this.grid.updateSurfaceProfile();

      // Angle-of-repose smoothing around the outer apron: no sheer >1-cell jumps
      for (let pass = 0; pass < 4; pass++) {
        for (let gx = Math.max(12, entGx - 14); gx <= Math.min(GRID_W - 13, entGx + 14); gx++) {
          if (Math.abs(gx - entGx) <= 2) continue;
          const gy = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
          const minNeighborGy = Math.min(
            Math.floor(this.grid.surfaceY[gx - 1] / CELL_SIZE),
            Math.floor(this.grid.surfaceY[gx + 1] / CELL_SIZE)
          );
          if (gy < minNeighborGy - 1 && this.grid.isDiggable(gx, gy)) {
            this.grid.setTerrain(gx, gy, CellType.AIR);
          }
        }
        this.grid.updateSurfaceProfile();
      }
    }

    const mainEntGx = clamp(Math.floor(this.entrancePos.x / CELL_SIZE), 2, GRID_W - 3);
    this.entrancePos.y = this.grid.surfaceY[mainEntGx] - 4;
  }

  public spawnAnt(caste: AntCaste, x: number, y: number, isCallow: boolean = false): Ant {
    let sx = clamp(x, CASE_LEFT + 14, CASE_RIGHT - 14);
    let sy = clamp(y, CASE_TOP + 14, CASE_BOTTOM - 14);
    const sg = this.grid.worldToGrid(sx, sy);
    if (!this.grid.isNavigable(sg.gx, sg.gy)) {
      const safe = this.grid.findNearestNavigable(sg.gx, sg.gy, 28);
      if (safe) {
        const w = this.grid.gridToWorld(safe.gx, safe.gy);
        sx = w.x;
        sy = w.y;
      }
    }
    const maxHp = caste === AntCaste.QUEEN ? 220 : caste === AntCaste.SOLDIER ? 60 : 24;
    const ant: Ant = {
      id: this.allocId(),
      caste,
      x: sx,
      y: sy,
      vx: 0,
      vy: 0,
      angle: Math.random() * Math.PI * 2,
      targetAngle: Math.random() * Math.PI * 2,
      speed: this.casteSpeed(caste),
      energy: 75 + Math.random() * 25,
      hunger: 10 + Math.random() * 25,
      hydration: 80 + Math.random() * 20,
      age: 0,
      maxAge: caste === AntCaste.QUEEN ? 1e9 : 1500 + Math.random() * 1500,
      isCallow,
      callowTimer: isCallow ? 25 : 0,
      task: caste === AntCaste.QUEEN ? AntTask.IDLE : AntTask.FORAGING_SCOUT,
      payload: PayloadType.NONE,
      payloadValue: 0,
      payloadId: null,
      stateTimer: 0,
      pheromoneDropTimer: Math.random() * 0.25,
      gaitPhase: Math.random() * Math.PI * 2,
      antennaPhase: Math.random() * Math.PI * 2,
      path: [],
      pathIndex: 0,
      targetPos: null,
      targetChamberId: null,
      trophallaxisPartnerId: null,
      lastPathCalcTime: -10,
      stuckTimer: 0,
      prevX: sx,
      prevY: sy,
      greetCooldown: 4 + Math.random() * 8,
      recruitFoodPos: null,
      signalCooldown: 0,
      hp: maxHp,
      maxHp,
      targetId: null,
      digIdx: -1,
      excursion: 0,
      restCooldown: 20 + Math.random() * 60,
    };
    this.ants.push(ant);
    return ant;
  }

  private casteSpeed(caste: AntCaste): number {
    return caste === AntCaste.QUEEN
      ? 11
      : caste === AntCaste.SOLDIER
      ? 33
      : caste === AntCaste.WORKER
      ? 37 + Math.random() * 6
      : caste === AntCaste.EXCAVATOR
      ? 31 + Math.random() * 5
      : 29 + Math.random() * 4;
  }

  public spawnSurfaceFood(
    type: PayloadType.SEED | PayloadType.HONEYDEW | PayloadType.PROTEIN,
    x: number,
    fallFromCanopy: boolean = true
  ): void {
    const cx = clamp(x, CASE_LEFT + 32, CASE_RIGHT - 32);
    const gx = Math.floor(cx / CELL_SIZE);
    const sy = this.grid.surfaceY[gx] - 3;
    const amount = type === PayloadType.HONEYDEW ? 45 : type === PayloadType.PROTEIN ? 60 : 50;
    this.foods.push({
      id: this.allocId(),
      type,
      x: cx,
      y: fallFromCanopy ? CASE_TOP + 18 : sy,
      amount,
      maxAmount: amount,
      radius: type === PayloadType.HONEYDEW ? 5.5 : type === PayloadType.PROTEIN ? 7.5 : 6,
      storedInChamberId: null,
      vy: fallFromCanopy ? 25 + Math.random() * 25 : 0,
      falling: fallFromCanopy,
    });
  }

  // ================================================================================================================
  // Main step
  // ================================================================================================================

  public isNight(): boolean {
    return Math.sin((this.timeOfDay - 0.2) * Math.PI * 2) < -0.5;
  }

  public step(rawDt: number): void {
    const dt = Math.min(0.1, rawDt);
    if (dt <= 0) return;
    this.simTime += dt;

    const prevTod = this.timeOfDay;
    const wasNight = this.isNight();
    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH) % 1;
    if (this.timeOfDay < prevTod) this.dayCount++;
    if (wasNight !== this.isNight()) {
      this.log(this.isNight() ? 'Night falls: foragers head underground' : `Day ${this.dayCount} dawns: foragers stream out`);
    }

    this.windStrength = 0.3 + 0.45 * Math.sin(this.simTime * 0.14) + 0.25 * Math.cos(this.simTime * 0.37);
    this.stepWeather(dt);

    this.pherAccum += dt;
    if (this.pherAccum >= 0.12) {
      this.grid.stepPheromonesAndMoisture(this.pherAccum, this.weather);
      this.pherAccum = 0;
    }

    this.updateFields(dt);
    this.stepDroplets(dt);
    this.stepEcosystem(dt);
    this.stepStormDamage(dt);
    this.stepBrood(dt);
    this.stepQueenLaying(dt);
    this.planExpansion(dt);
    this.rebalanceLabour(dt);

    this.pathBudget = 10;
    this.buildHash();
    this.refreshClaims();
    this.stepIntruders(dt);
    this.stepAnts(dt);
    this.resolveEntityCrowding(dt);
    this.stepFallenAnts(dt);
    this.stepParticles(dt);
  }

  private stepWeather(dt: number): void {
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      const prev = this.weather;
      const r = Math.random();
      this.weather = r < 0.5 ? 'Clear' : r < 0.72 ? 'Misty' : 'Light Rain';
      this.weatherTimer = this.weather === 'Clear' ? 70 + Math.random() * 60 : 30 + Math.random() * 25;
      if (this.weather !== prev) {
        if (this.weather === 'Light Rain') this.log('Rain begins: the mound and shallow tunnels are at risk', 'danger');
        else if (prev === 'Light Rain') this.log('The rain has passed');
      }
    }

    if (this.weather === 'Light Rain' && Math.random() < dt * 13) {
      const rx = CASE_LEFT + 16 + Math.random() * (CASE_RIGHT - CASE_LEFT - 32);
      this.droplets.push({
        id: this.allocId(),
        x: rx,
        y: CASE_TOP + 8,
        vy: 155 + Math.random() * 65,
        radius: 1.6 + Math.random() * 1.1,
        volume: 9,
        settled: false,
      });
    }

    if (this.weather === 'Misty' && Math.random() < dt * 2.4 && this.particles.length < 110) {
      const fromLeft = this.windStrength >= 0;
      this.particles.push({
        x: fromLeft ? CASE_LEFT + 18 : CASE_RIGHT - 18,
        y: SURFACE_BASE_Y - 12 - Math.random() * 45,
        vx: (fromLeft ? 1 : -1) * (10 + Math.random() * 14),
        vy: (Math.random() - 0.5) * 2,
        size: 16 + Math.random() * 24,
        alpha: 0.08 + Math.random() * 0.08,
        life: 0,
        maxLife: 9 + Math.random() * 6,
        kind: 'fog',
        color: '#dbeafe',
      });
    }
  }

  private stepDroplets(dt: number): void {
    for (let i = this.droplets.length - 1; i >= 0; i--) {
      const d = this.droplets[i];
      if (!d.settled) {
        d.vy = Math.min(280, d.vy + 230 * dt);
        d.x = clamp(d.x + this.windStrength * 14 * dt, CASE_LEFT + 12, CASE_RIGHT - 12);
        d.y += d.vy * dt;
        const gx = Math.floor(d.x / CELL_SIZE);
        const surfY = this.grid.surfaceY[clamp(gx, 0, GRID_W - 1)];
        if (d.y >= surfY - d.radius) {
          d.y = surfY - d.radius;
          d.settled = true;
          const g = this.grid.worldToGrid(d.x, surfY + 2);
          const idx = this.grid.idx(g.gx, g.gy);
          this.grid.moisture[idx] = Math.min(1, this.grid.moisture[idx] + 0.38);
          this.grid.dirtVisualDirty = true;

          // Subtle splash mist droplets
          if (Math.random() < 0.45) {
            this.particles.push({
              x: d.x,
              y: d.y - 1,
              vx: (Math.random() - 0.5) * 26,
              vy: -14 - Math.random() * 14,
              size: 1.0,
              alpha: 0.5,
              life: 0,
              maxLife: 0.35,
              kind: 'mist',
              color: '#bae6fd',
            });
          }
        }
      } else {
        d.volume -= dt * 1.4;
        d.radius = Math.max(0.8, 1.2 + d.volume * 0.14);
        if (d.volume <= 0) {
          this.droplets.splice(i, 1);
        }
      }
    }
  }

  private stepEcosystem(dt: number): void {
    // Wind-blown seeds & dripping plant honeydew appear dynamically
    this.naturalFoodTimer -= dt;
    if (this.naturalFoodTimer <= 0) {
      // Supply sized so a full-grown colony can sustain itself; the queen still throttles laying when stores run low.
      this.naturalFoodTimer = 5 + Math.random() * 6;
      const surfaceFoods = this.foods.filter((f) => f.storedInChamberId === null);
      if (surfaceFoods.length < 14) {
        const r = Math.random();
        if (r < 0.55) {
          // Wind-blown seed drifting from canopy
          const rx = CASE_LEFT + 70 + Math.random() * (CASE_RIGHT - CASE_LEFT - 140);
          this.spawnSurfaceFood(PayloadType.SEED, rx, true);
        } else if (r < 0.88 && this.sprouts.length > 0) {
          // Honeydew bead forming on a clover or fern sprout!
          const plant = this.sprouts[Math.floor(Math.random() * this.sprouts.length)];
          this.spawnSurfaceFood(PayloadType.HONEYDEW, plant.x, false);
        } else {
          const rx = CASE_LEFT + 90 + Math.random() * (CASE_RIGHT - CASE_LEFT - 180);
          this.spawnSurfaceFood(PayloadType.PROTEIN, rx, false);
        }
      }
    }

    // Update falling seeds with wind drift
    for (const f of this.foods) {
      if (f.falling) {
        f.vy = Math.min(90, (f.vy ?? 20) + 45 * dt);
        f.x = clamp(f.x + (this.windStrength * 22 + Math.sin(this.simTime * 3 + f.id) * 10) * dt, CASE_LEFT + 28, CASE_RIGHT - 28);
        f.y += f.vy * dt;
        const gx = Math.floor(f.x / CELL_SIZE);
        const surfY = this.grid.surfaceY[clamp(gx, 0, GRID_W - 1)] - 3;
        if (f.y >= surfY) {
          f.y = surfY;
          f.falling = false;
          f.vy = 0;
        }
      }
    }

    // Fungus garden blooms when soil is hydrated
    this.fungusTimer -= dt;
    if (this.fungusTimer <= 0) {
      this.fungusTimer = 8.5;
      const fungusChamber = this.getChamber(ChamberType.FUNGUS);
      if (fungusChamber) {
        const g = this.grid.worldToGrid(fungusChamber.x, fungusChamber.y + 18);
        const m = this.grid.moisture[this.grid.idx(g.gx, g.gy)];
        const existing = this.foods.filter((f) => f.storedInChamberId === fungusChamber.id);
        if (m > 0.32 && existing.length < 4) {
          this.foods.push({
            id: this.allocId(),
            type: PayloadType.FUNGUS,
            x: fungusChamber.x + (Math.random() - 0.5) * 44,
            y: fungusChamber.y + 10 + Math.random() * 6,
            amount: 22,
            maxAmount: 48,
            radius: 7,
            storedInChamberId: fungusChamber.id,
          });
        } else {
          for (const f of existing) {
            f.amount = Math.min(f.maxAmount, f.amount + 3.8 * m);
          }
        }
      }
    }

    for (let i = this.foods.length - 1; i >= 0; i--) {
      const f = this.foods[i];
      if (f.amount <= 0.5) {
        this.foods.splice(i, 1);
      } else {
        f.radius = 2.8 + (f.amount / f.maxAmount) * 5;
      }
    }
  }

  // ================================================================================================================
  // Flow fields (shared navigation)
  // ================================================================================================================

  private updateFields(dt: number): void {
    for (const k of Object.keys(this.fieldAge) as FieldKey[]) this.fieldAge[k] += dt;
    if (this.grid.terrainVersion !== this.fieldTerrainVersion) {
      this.fieldTerrainVersion = this.grid.terrainVersion;
      for (const k of STATIC_FIELDS) this.fieldDirty[k] = true;
      this.fieldDirty.dig = true;
    }
    if (this.intruders.length > 0 || this.fieldDirty.threat) {
      if (this.fieldAge.threat > 0.35) this.rebuildField('threat');
    }
    if (this.fieldAge.store > 2) this.fieldDirty.store = true;
    // Rebuild at most one stale field per step to keep the cost flat.
    if (this.fieldDirty.dig && this.fieldAge.dig > 0.5) {
      this.rebuildField('dig');
      return;
    }
    let oldest: FieldKey | null = null;
    for (const k of STATIC_FIELDS) {
      if (this.fieldDirty[k] && this.fieldAge[k] > 1.5 && (!oldest || this.fieldAge[k] > this.fieldAge[oldest])) oldest = k;
    }
    if (oldest) this.rebuildField(oldest);
  }

  private chamberSources(types: ChamberType[]): number[] {
    const out: number[] = [];
    for (const c of this.chambers) {
      if (!types.includes(c.type)) continue;
      const minGx = Math.floor((c.x - c.rx) / CELL_SIZE);
      const maxGx = Math.ceil((c.x + c.rx) / CELL_SIZE);
      const minGy = Math.floor((c.y - c.ry) / CELL_SIZE);
      const maxGy = Math.ceil((c.y + c.ry) / CELL_SIZE);
      for (let gy = minGy; gy <= maxGy; gy++) {
        for (let gx = minGx; gx <= maxGx; gx++) {
          if (!this.grid.inBounds(gx, gy)) continue;
          const w = this.grid.gridToWorld(gx, gy);
          const dx = (w.x - c.x) / c.rx;
          const dy = (w.y - c.y) / c.ry;
          if (dx * dx + dy * dy < 0.45 && this.grid.nav[this.grid.idx(gx, gy)]) out.push(this.grid.idx(gx, gy));
        }
      }
    }
    return out;
  }

  /** Walkable cells resting on the exterior ground, filtered by world x. */
  private surfaceSources(filter: (wx: number) => boolean): number[] {
    const out: number[] = [];
    for (let gx = 10; gx < GRID_W - 10; gx++) {
      const wx = (gx + 0.5) * CELL_SIZE;
      if (!filter(wx)) continue;
      const gy = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE) - 1;
      if (gy < 1 || gy >= GRID_H - 1) continue;
      const i = this.grid.idx(gx, gy);
      // real ground underfoot (not the open mouth of a tunnel)
      if (this.grid.terrain[i + GRID_W] === CellType.TUNNEL && Math.abs(wx - this.entrancePos.x) > 60 && Math.abs(wx - SIDE_ENTRANCE_X) > 50) continue;
      if (this.grid.terrain[i] === CellType.AIR && this.grid.nav[i]) out.push(i);
    }
    return out;
  }

  public moundRadius(): number {
    return 70 + Math.min(150, Math.sqrt(this.soilDeposited) * 6);
  }

  private rebuildField(k: FieldKey): void {
    const f = this.fields[k];
    let sources: number[] = [];
    let costs: number[] | undefined;
    const ex = this.entrancePos.x;
    switch (k) {
      case 'surface':
        sources = this.surfaceSources((wx) => Math.abs(wx - ex) > 50 && Math.abs(wx - SIDE_ENTRANCE_X) > 38 && wx > CASE_LEFT + 60 && wx < CASE_RIGHT - 60);
        break;
      case 'mound': {
        const r = this.moundRadius();
        sources = this.surfaceSources((wx) => {
          const dm = Math.abs(wx - ex);
          const ds = Math.abs(wx - SIDE_ENTRANCE_X);
          return ds > 60 && dm >= CRATER_MAIN + 4 && dm <= CRATER_MAIN + 30 + r * 0.15;
        });
        break;
      }
      case 'midden':
        sources = this.surfaceSources((wx) => Math.abs(wx - this.middenPos.x) < 24);
        break;
      case 'royal':
        sources = this.chamberSources([ChamberType.ROYAL]);
        break;
      case 'nursery':
        sources = this.chamberSources([ChamberType.NURSERY]);
        break;
      case 'granary':
        sources = this.chamberSources([ChamberType.GRANARY]);
        break;
      case 'fungus':
        sources = this.chamberSources([ChamberType.FUNGUS]);
        break;
      case 'store':
        // wherever food actually lies in the nest (a drained granary is no use to a hungry ant)
        for (const fd of this.foods) {
          if (fd.storedInChamberId === null || fd.amount < 1) continue;
          const fg = this.grid.worldToGrid(fd.x, fd.y);
          const near = this.grid.findNearestNavigable(fg.gx, fg.gy, 3);
          if (near) sources.push(this.grid.idx(near.gx, near.gy));
        }
        break;
      case 'dig': {
        costs = [];
        const plan = this.digPlan;
        const nav = this.grid.nav;
        for (let i = GRID_W; i < N_CELLS - GRID_W; i++) {
          if (!nav[i]) continue;
          let best = 0;
          const n4 = [i - 1, i + 1, i - GRID_W, i + GRID_W];
          for (const j of n4) {
            const p = plan[j];
            if (p > best && this.canExcavate(j)) best = p;
          }
          if (best > 0) {
            sources.push(i);
            costs.push(best === 2 ? 0 : 18);
          }
        }
        break;
      }
      case 'threat':
        for (const m of this.intruders) {
          if (m.hp <= 0) continue;
          const g = this.grid.worldToGrid(m.x, m.y);
          const near = this.grid.findNearestNavigable(g.gx, g.gy, 3);
          if (near) sources.push(this.grid.idx(near.gx, near.gy));
        }
        break;
    }
    if (sources.length === 0) f.fill(INF);
    else this.grid.buildFlowField(f, sources, costs);
    this.fieldDirty[k] = false;
    this.fieldAge[k] = 0;
  }

  private antCell(ant: { x: number; y: number }): number {
    const g = this.grid.worldToGrid(ant.x, ant.y);
    let i = this.grid.idx(g.gx, g.gy);
    if (!this.grid.nav[i]) {
      const n = this.grid.findNearestNavigable(g.gx, g.gy, 2);
      if (n) i = this.grid.idx(n.gx, n.gy);
    }
    return i;
  }

  private fieldDist(k: FieldKey, x: number, y: number): number {
    return this.fields[k][this.antCell({ x, y })];
  }

  /** Builds a short downhill route on a flow field. Returns the remaining cost at the ant's cell. */
  private go(ant: Ant, k: FieldKey): number {
    if (ant.navKey !== k) {
      ant.navKey = k;
      ant.path = [];
      ant.pathIndex = 0;
    }
    ant.targetPos = null;
    const f = this.fields[k];
    let i = this.antCell(ant);
    let d = f[i];
    const path: Vec2[] = [];
    if (d >= INF) {
      // freshly dug cells aren't on the field until its next refresh: step to a neighbour that is
      const j = this.nearestOnField(f, i, 3);
      if (j < 0) return INF;
      if (ant.path.length > 0 && ant.pathIndex < ant.path.length) return f[j] + 1;
      i = j;
      d = f[j] + 1;
      const jx = j % GRID_W;
      path.push(this.grid.gridToWorld(jx, (j - jx) / GRID_W));
    } else if (ant.path.length > 0 && ant.pathIndex < ant.path.length) return d;
    let cur = i;
    for (let s = 0; s < 4; s++) {
      const nxt = this.grid.descend(f, cur);
      if (nxt < 0) break;
      cur = nxt;
      const gx = cur % GRID_W;
      path.push(this.grid.gridToWorld(gx, (cur - gx) / GRID_W));
      if (f[cur] <= 0) break;
    }
    ant.path = path;
    ant.pathIndex = 0;
    return d;
  }

  private nearestOnField(f: Float32Array, i: number, r: number): number {
    const cx = i % GRID_W;
    const cy = (i - cx) / GRID_W;
    let best = -1;
    let bestD = INF;
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
        const j = y * GRID_W + x;
        if (!this.grid.nav[j] || f[j] >= INF) continue;
        const dd = f[j] + Math.abs(x - cx) + Math.abs(y - cy);
        if (dd < bestD) {
          bestD = dd;
          best = j;
        }
      }
    }
    return best;
  }

  /**
   * Steer to a point. Out on the open ground the ant walks the terrain contour (over mounds, around the entrance
   * pits) instead of beelining through them; elsewhere (inside one chamber) it heads straight there.
   */
  private goTo(ant: Ant, x: number, y: number): void {
    const gx = clamp(Math.floor(ant.x / CELL_SIZE), 0, GRID_W - 1);
    const tgx = clamp(Math.floor(x / CELL_SIZE), 0, GRID_W - 1);
    const antOnGround = ant.y <= this.grid.surfaceY[gx] + 3 && this.grid.terrain[this.grid.idx(gx, clamp(Math.floor(ant.y / CELL_SIZE), 0, GRID_H - 1))] === CellType.AIR;
    const targetOnGround = y <= this.grid.surfaceY[tgx] + 6;
    if (antOnGround && targetOnGround && Math.abs(x - ant.x) > 10) {
      const key = 'contour';
      const tgt = ant.targetPos;
      if (ant.navKey !== key || !tgt || Math.abs(tgt.x - x) > 14) {
        ant.navKey = key;
        ant.path = [];
        ant.pathIndex = 0;
      }
      ant.targetPos = { x, y };
      if (ant.path.length === 0 || ant.pathIndex >= ant.path.length) {
        // a proper grid route copes with bumps, pits and the entrance craters; the contour walk is the fallback
        if (this.pathBudget > 0) {
          this.pathBudget--;
          const route = this.grid.findPath({ x: ant.x, y: ant.y }, { x, y }, { maxIterations: 2500 });
          if (route.length > 0) {
            ant.path = route.length > 14 ? route.slice(0, 14) : route;
            ant.pathIndex = 0;
            return;
          }
        }
        const dir = x >= ant.x ? 1 : -1;
        const path: Vec2[] = [];
        let px = ant.x;
        for (let s = 0; s < 5; s++) {
          px += dir * CELL_SIZE;
          if ((dir > 0 && px > x) || (dir < 0 && px < x)) px = x;
          const c = clamp(Math.floor(px / CELL_SIZE), 0, GRID_W - 1);
          path.push({ x: px, y: this.grid.surfaceY[c] - 2 });
          if (px === x) break;
        }
        ant.path = path;
        ant.pathIndex = 0;
      }
      return;
    }
    if (ant.navKey !== 'direct') {
      ant.navKey = 'direct';
      ant.path = [];
      ant.pathIndex = 0;
    }
    ant.targetPos = { x, y };
  }

  /**
   * Route to one specific spot (a particular larva, a particular chamber) with A*. Flow fields only know the
   * *nearest* chamber of each kind, which is wrong once the nest has several nurseries.
   */
  private goPath(ant: Ant, x: number, y: number, key: string): void {
    if (ant.navKey !== key) {
      ant.navKey = key;
      ant.path = [];
      ant.pathIndex = 0;
    }
    ant.targetPos = null;
    if (ant.path.length > 0 && ant.pathIndex < ant.path.length) return;
    if (this.pathBudget <= 0) return;
    this.pathBudget--;
    const route = this.grid.findPath({ x: ant.x, y: ant.y }, { x, y }, { maxIterations: 6000 });
    if (route.length === 0) {
      ant.targetPos = { x, y };
      return;
    }
    ant.path = route.length > 24 ? route.slice(0, 24) : route;
    ant.pathIndex = 0;
  }

  private stopMoving(ant: Ant): void {
    ant.path = [];
    ant.pathIndex = 0;
    ant.targetPos = null;
    ant.navKey = undefined;
  }

  private surfaceTarget(x: number): Vec2 {
    const cx = clamp(x, CASE_LEFT + 40, CASE_RIGHT - 40);
    return { x: cx, y: this.grid.surfaceY[clamp(Math.floor(cx / CELL_SIZE), 0, GRID_W - 1)] - 2 };
  }

  // ================================================================================================================
  // Spatial hash & claims
  // ================================================================================================================

  private buildHash(): void {
    this.hashHead.fill(-1);
    if (this.hashNext.length < this.ants.length) this.hashNext = new Int32Array(this.ants.length * 2);
    for (let i = 0; i < this.ants.length; i++) {
      const a = this.ants[i];
      const hx = clamp(Math.floor(a.x / HASH_CELL), 0, HASH_W - 1);
      const hy = clamp(Math.floor(a.y / HASH_CELL), 0, HASH_H - 1);
      const h = hy * HASH_W + hx;
      this.hashNext[i] = this.hashHead[h];
      this.hashHead[h] = i;
    }
  }

  /** Calls `cb` for every ant within `r` of (x, y). Return true from cb to stop early. */
  private forAntsNear(x: number, y: number, r: number, cb: (a: Ant) => boolean | void): void {
    const x0 = clamp(Math.floor((x - r) / HASH_CELL), 0, HASH_W - 1);
    const x1 = clamp(Math.floor((x + r) / HASH_CELL), 0, HASH_W - 1);
    const y0 = clamp(Math.floor((y - r) / HASH_CELL), 0, HASH_H - 1);
    const y1 = clamp(Math.floor((y + r) / HASH_CELL), 0, HASH_H - 1);
    const r2 = r * r;
    for (let hy = y0; hy <= y1; hy++) {
      for (let hx = x0; hx <= x1; hx++) {
        let i = this.hashHead[hy * HASH_W + hx];
        while (i !== -1) {
          const a = this.ants[i];
          if (a) {
            const dx = a.x - x;
            const dy = a.y - y;
            if (dx * dx + dy * dy <= r2 && cb(a)) return;
          }
          i = this.hashNext[i];
        }
      }
    }
  }

  private refreshClaims(): void {
    this.claimedBrood.clear();
    this.claimedDig.clear();
    this.queenFeederId = null;
    const queen = this.getQueen();
    for (const a of this.ants) {
      if (a.targetId != null) {
        if (queen && a.targetId === queen.id) this.queenFeederId = a.id;
        else this.claimedBrood.add(a.targetId);
      }
      if ((a.digIdx ?? -1) >= 0) this.claimedDig.add(a.digIdx!);
    }
    let stored = 0;
    for (const f of this.foods) if (f.storedInChamberId !== null) stored += f.amount;
    this.storedFoodCache = stored;
  }

  public getQueen(): Ant | undefined {
    return this.ants.find((a) => a.caste === AntCaste.QUEEN);
  }

  // ================================================================================================================
  // Brood & queen
  // ================================================================================================================

  private stepBrood(dt: number): void {
    for (let i = this.brood.length - 1; i >= 0; i--) {
      const b = this.brood[i];
      b.wigglePhase += dt * (b.stage === BroodStage.LARVA ? 4.8 : 1.2);

      if (b.carriedByAntId === null) {
        const g = this.grid.worldToGrid(b.x, b.y + 3);
        if (this.grid.inBounds(g.gx, g.gy) && !this.grid.isSolid(g.gx, g.gy)) b.y += 18 * dt;
        const own = this.grid.worldToGrid(b.x, b.y);
        if (this.grid.isSolid(own.gx, own.gy)) {
          // buried by a collapse: pop it back into the nearest open space
          const safe = this.grid.findNearestNavigable(own.gx, own.gy, 6);
          if (safe) {
            const w = this.grid.gridToWorld(safe.gx, safe.gy);
            b.x = w.x;
            b.y = w.y;
          }
        }
      }

      if (b.stage === BroodStage.EGG) {
        b.progress += dt * 3.2;
        if (b.progress >= 100) {
          b.stage = BroodStage.LARVA;
          b.progress = 0;
          b.nutrition = 50;
        }
      } else if (b.stage === BroodStage.LARVA) {
        b.nutrition = Math.max(0, b.nutrition - dt * 0.7);
        if (b.nutrition > 15) b.progress += dt * (1.4 + (b.nutrition / 100) * 1.8);
        b.starve = b.nutrition <= 0 ? (b.starve ?? 0) + dt : 0;
        if ((b.starve ?? 0) > 40) {
          this.brood.splice(i, 1);
          this.log('A neglected larva starved', 'danger');
          continue;
        }
        if (b.progress >= 100) {
          b.stage = BroodStage.PUPA;
          b.progress = 0;
        }
      } else {
        b.progress += dt * 2.4;
        if (b.progress >= 100) {
          if (this.ants.length < MAX_COLONY) {
            const caste = this.chooseNeededCaste();
            const a = this.spawnAnt(caste, b.x, b.y - 2, true);
            a.age = 0;
          }
          this.brood.splice(i, 1);
        }
      }
    }
  }

  private chooseNeededCaste(): AntCaste {
    let soldiers = 0;
    for (const a of this.ants) if (a.caste === AntCaste.SOLDIER) soldiers++;
    const total = Math.max(1, this.ants.length);
    if (soldiers / total < (this.intruders.length > 0 ? 0.18 : 0.13)) return AntCaste.SOLDIER;
    // Young workers start as nurses (age polyethism); the labour balancer moves them on as they mature.
    return AntCaste.NURSE;
  }

  private stepQueenLaying(dt: number): void {
    const queen = this.getQueen();
    if (!queen) return;
    const royal = this.nearestChamber(ChamberType.ROYAL, queen.x, queen.y);
    if (!royal) return;
    this.queenEggTimer -= dt;
    if (this.queenEggTimer > 0) return;
    const stored = this.storedFoodCache;
    this.queenEggTimer = (stored > 120 ? 4.5 : stored > 40 ? 8 : 16) + this.brood.length * 0.06;
    if (queen.hunger > 80 || stored < 12) return;
    if (this.brood.length >= MAX_BROOD || this.ants.length + this.brood.length >= MAX_COLONY + 10) return;
    if (BUSY_TASKS.has(queen.task) && queen.task !== AntTask.IDLE) return;
    queen.task = AntTask.LAYING_EGG;
    queen.stateTimer = 1.6;
    queen.hunger = Math.min(100, queen.hunger + 2.5);
    this.brood.push(
      this.makeBrood(BroodStage.EGG, queen.x - Math.cos(queen.angle) * 14, queen.y - Math.sin(queen.angle) * 6, royal.id, 0, 100)
    );
  }

  // ================================================================================================================
  // Colony planning: expansion, labour
  // ================================================================================================================

  private canExcavate(i: number): boolean {
    const t = this.grid.terrain[i];
    return t === CellType.TOPSOIL || t === CellType.SUBSOIL || t === CellType.DEEP_CLAY || t === CellType.ROOT;
  }

  private markPlan(gx: number, gy: number, level: 1 | 2): boolean {
    if (!this.grid.inBounds(gx, gy)) return false;
    const i = this.grid.idx(gx, gy);
    if (!this.canExcavate(i)) return false;
    if (gx * CELL_SIZE < CASE_LEFT + 30 || gx * CELL_SIZE > CASE_RIGHT - 30 || gy * CELL_SIZE > CASE_BOTTOM - 24) return false;
    if (level === 1 && gy * CELL_SIZE < this.grid.surfaceY[gx] + 24) return false;
    if (this.digPlan[i] < level) this.digPlan[i] = level;
    return true;
  }

  private planExpansion(dt: number): void {
    this.planTimer -= dt;
    if (this.planTimer > 0) return;
    this.planTimer = 3;

    // recount outstanding work, dropping cells that were dug (or can no longer be dug)
    let plan = 0;
    let repair = 0;
    for (let i = 0; i < N_CELLS; i++) {
      const p = this.digPlan[i];
      if (!p) continue;
      if (!this.canExcavate(i)) {
        this.digPlan[i] = 0;
        continue;
      }
      if (p === 2) repair++;
      else plan++;
    }
    if (plan + repair !== this.planCount + this.repairCount) this.fieldDirty.dig = true;
    this.planCount = plan;
    this.repairCount = repair;

    // projects become real chambers once mostly hollowed out
    for (let k = this.projects.length - 1; k >= 0; k--) {
      const p = this.projects[k];
      let remaining = 0;
      let total = 0;
      for (let gy = Math.floor((p.y - p.ry) / CELL_SIZE); gy <= Math.ceil((p.y + p.ry) / CELL_SIZE); gy++) {
        for (let gx = Math.floor((p.x - p.rx) / CELL_SIZE); gx <= Math.ceil((p.x + p.rx) / CELL_SIZE); gx++) {
          if (!this.grid.inBounds(gx, gy)) continue;
          const w = this.grid.gridToWorld(gx, gy);
          const dx = (w.x - p.x) / p.rx;
          const dy = (w.y - p.y) / p.ry;
          if (dx * dx + dy * dy > 0.8) continue;
          total++;
          if (this.grid.terrain[this.grid.idx(gx, gy)] !== CellType.TUNNEL) remaining++;
        }
      }
      if (total === 0 || remaining / total < 0.2) {
        this.projects.splice(k, 1);
        if (p.kind === 'chamber') {
          this.chambers.push({ id: p.id, type: p.type, x: p.x, y: p.y, rx: p.rx, ry: p.ry });
          for (const fk of STATIC_FIELDS) this.fieldDirty[fk] = true;
          this.log(`Excavators finished a new ${p.type.toLowerCase()}`, 'good');
        } else {
          this.log('A new gallery tunnel was completed', 'good');
        }
      }
    }

    // Keep one project on the go while the colony needs room (and always a little slow digging)
    if (this.projects.length === 0 && plan < 8) {
      const pop = this.ants.length + this.brood.length;
      const nurseries = this.chambers.filter((c) => c.type === ChamberType.NURSERY).length;
      const granaries = this.chambers.filter((c) => c.type === ChamberType.GRANARY).length;
      const piles = this.foods.filter((f) => f.storedInChamberId !== null).length;
      if (this.chambers.length < 13) {
        let type = ChamberType.NURSERY;
        if (this.brood.length > nurseries * 22) type = ChamberType.NURSERY;
        else if (piles > granaries * 9 || this.storedFoodCache > granaries * 380) type = ChamberType.GRANARY;
        else if (pop > this.chambers.length * 30) type = this.chambers.length % 2 === 0 ? ChamberType.NURSERY : ChamberType.GRANARY;
        else type = Math.random() < 0.5 ? ChamberType.NURSERY : ChamberType.GRANARY;
        if (Math.random() < 0.3 || !this.planNewProject(type)) this.planGallery();
      } else if (this.tunnelsDugCells < 3500 && Math.random() < 0.25) {
        this.planGallery();
      }
    }
  }

  /** Picks a site for a new chamber near the existing nest and plans the tunnel + chamber cells. */
  private planNewProject(type: ChamberType): boolean {
    let best: { x: number; y: number; rx: number; ry: number; tx: number; ty: number; score: number } | null = null;
    const depthBias = Math.min(1, this.chambers.length / 10);
    for (let attempt = 0; attempt < 70; attempt++) {
      const rx = 40 + Math.random() * 18;
      const ry = 20 + Math.random() * 8;
      const x = CASE_LEFT + 110 + Math.random() * (CASE_RIGHT - CASE_LEFT - 220);
      const y = SURFACE_BASE_Y + 110 + Math.random() * (CASE_BOTTOM - SURFACE_BASE_Y - 170);
      let tooClose = false;
      for (const c of this.chambers.concat(this.projects as unknown as Chamber[])) {
        if (Math.abs(c.x - x) < c.rx + rx + 36 && Math.abs(c.y - y) < c.ry + ry + 40) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) continue;
      // the site must be solid diggable earth with a margin around it
      let ok = true;
      let cells = 0;
      let bad = 0;
      for (let gy = Math.floor((y - ry - 12) / CELL_SIZE); gy <= Math.ceil((y + ry + 12) / CELL_SIZE) && ok; gy++) {
        for (let gx = Math.floor((x - rx - 12) / CELL_SIZE); gx <= Math.ceil((x + rx + 12) / CELL_SIZE); gx++) {
          if (!this.grid.inBounds(gx, gy)) {
            ok = false;
            break;
          }
          const t = this.grid.terrain[this.grid.idx(gx, gy)];
          if (t === CellType.TUNNEL || t === CellType.AIR || t === CellType.GLASS_WALL) {
            ok = false;
            break;
          }
          cells++;
          if (t === CellType.PEBBLE) bad++;
        }
      }
      if (!ok || bad > cells * 0.06) continue;
      // nearest existing tunnel to connect from
      const g = this.grid.worldToGrid(x, y);
      let found: { gx: number; gy: number } | null = null;
      for (let r = 4; r <= 36 && !found; r++) {
        for (let k = 0; k < 24 && !found; k++) {
          const a = (k / 24) * Math.PI * 2;
          const gx = g.gx + Math.round(Math.cos(a) * r);
          const gy = g.gy + Math.round(Math.sin(a) * r * 0.8);
          if (!this.grid.inBounds(gx, gy)) continue;
          if (this.grid.terrain[this.grid.idx(gx, gy)] === CellType.TUNNEL && gy * CELL_SIZE > this.grid.surfaceY[gx] + 30) {
            found = { gx, gy };
          }
        }
      }
      if (!found) continue;
      const t = this.grid.gridToWorld(found.gx, found.gy);
      if (this.lineHitsPebble(t.x, t.y, x, y)) continue;
      const dist = Math.hypot(t.x - x, t.y - y);
      const score = dist - depthBias * (y - SURFACE_BASE_Y) * 0.35 + Math.random() * 60;
      if (!best || score < best.score) best = { x, y, rx, ry, tx: t.x, ty: t.y, score };
    }
    if (!best) return false;

    const tunnel = this.wigglyLine(best.tx, best.ty, best.x, best.y);
    let marked = 0;
    for (const p of tunnel) marked += this.planDisc(p.x, p.y, 7.5);
    const minGx = Math.floor((best.x - best.rx - 4) / CELL_SIZE);
    const maxGx = Math.ceil((best.x + best.rx + 4) / CELL_SIZE);
    const minGy = Math.floor((best.y - best.ry - 4) / CELL_SIZE);
    const maxGy = Math.ceil((best.y + best.ry + 4) / CELL_SIZE);
    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const w = this.grid.gridToWorld(gx, gy);
        const ang = Math.atan2(w.y - best.y, w.x - best.x);
        const wob = 1 + 0.08 * Math.sin(ang * 5 + best.x) + 0.05 * Math.cos(ang * 3 - best.y);
        const dx = (w.x - best.x) / (best.rx * wob);
        const dy = (w.y - best.y) / (best.ry * wob);
        if (dx * dx + dy * dy <= 1 && this.markPlan(gx, gy, 1)) marked++;
      }
    }
    this.projects.push({ id: this.allocId(), kind: 'chamber', type, x: best.x, y: best.y, rx: best.rx, ry: best.ry, totalCells: marked });
    this.fieldDirty.dig = true;
    this.log(`Workers began digging toward a new ${type.toLowerCase()}`);
    return true;
  }

  /** A long winding side gallery (real nests are full of them). */
  private planGallery(): boolean {
    for (let attempt = 0; attempt < 40; attempt++) {
      // start from a random deep tunnel cell
      const gx = 14 + Math.floor(Math.random() * (GRID_W - 28));
      const gy = 50 + Math.floor(Math.random() * (GRID_H - 64));
      if (this.grid.terrain[this.grid.idx(gx, gy)] !== CellType.TUNNEL) continue;
      const s = this.grid.gridToWorld(gx, gy);
      const ang = (Math.random() < 0.5 ? 0 : Math.PI) + (Math.random() - 0.3) * 1.1;
      const len = 90 + Math.random() * 120;
      const ex = clamp(s.x + Math.cos(ang) * len, CASE_LEFT + 60, CASE_RIGHT - 60);
      const ey = clamp(s.y + Math.abs(Math.sin(ang)) * len * 0.6 + 10, SURFACE_BASE_Y + 80, CASE_BOTTOM - 50);
      if (this.lineHitsPebble(s.x, s.y, ex, ey)) continue;
      // don't run straight into existing tunnels further along
      let crosses = false;
      for (let t = 0.35; t <= 1; t += 0.08) {
        const c = this.grid.worldToGrid(s.x + (ex - s.x) * t, s.y + (ey - s.y) * t);
        if (this.grid.terrain[this.grid.idx(c.gx, c.gy)] === CellType.TUNNEL) crosses = true;
      }
      if (crosses) continue;
      let marked = 0;
      for (const p of this.wigglyLine(s.x, s.y, ex, ey)) marked += this.planDisc(p.x, p.y, 7);
      marked += this.planDisc(ex, ey, 11);
      if (marked < 10) continue;
      this.projects.push({ id: this.allocId(), kind: 'gallery', type: ChamberType.NURSERY, x: ex, y: ey, rx: 9, ry: 9, totalCells: marked });
      this.fieldDirty.dig = true;
      this.log('Excavators started a new side gallery');
      return true;
    }
    return false;
  }

  private planDisc(cx: number, cy: number, r: number): number {
    let n = 0;
    for (let gy = Math.floor((cy - r) / CELL_SIZE); gy <= Math.ceil((cy + r) / CELL_SIZE); gy++) {
      for (let gx = Math.floor((cx - r) / CELL_SIZE); gx <= Math.ceil((cx + r) / CELL_SIZE); gx++) {
        const w = this.grid.gridToWorld(gx, gy);
        if ((w.x - cx) ** 2 + ((w.y - cy) / 0.9) ** 2 <= r * r && this.markPlan(gx, gy, 1)) n++;
      }
    }
    return n;
  }

  private wigglyLine(x0: number, y0: number, x1: number, y1: number): Vec2[] {
    const pts: Vec2[] = [];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const nx = -(y1 - y0) / Math.max(1, len);
    const ny = (x1 - x0) / Math.max(1, len);
    const amp = Math.min(22, len * 0.12) * (Math.random() < 0.5 ? -1 : 1);
    const phase = Math.random() * Math.PI;
    const steps = Math.max(2, Math.ceil(len / 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const off = Math.sin(t * Math.PI) * amp + Math.sin(t * Math.PI * 3 + phase) * 4;
      pts.push({ x: x0 + (x1 - x0) * t + nx * off, y: y0 + (y1 - y0) * t + ny * off });
    }
    return pts;
  }

  private lineHitsPebble(x0: number, y0: number, x1: number, y1: number): boolean {
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 4);
    for (let s = 0; s <= steps; s++) {
      const t = s / Math.max(1, steps);
      const g = this.grid.worldToGrid(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      const c = this.grid.terrain[this.grid.idx(g.gx, g.gy)];
      if (c === CellType.PEBBLE || c === CellType.GLASS_WALL) return true;
    }
    return false;
  }

  /**
   * Response-threshold style labour allocation: workers switch between nursing, digging and foraging as demand
   * shifts. Young ants nurse first, older ones move outdoors (age polyethism).
   */
  private rebalanceLabour(dt: number): void {
    this.labourTimer -= dt;
    if (this.labourTimer > 0) return;
    this.labourTimer = 2.5;

    let nurses = 0;
    let diggers = 0;
    let foragers = 0;
    for (const a of this.ants) {
      if (a.caste === AntCaste.NURSE) nurses++;
      else if (a.caste === AntCaste.EXCAVATOR) diggers++;
      else if (a.caste === AntCaste.WORKER) foragers++;
    }
    const workers = nurses + diggers + foragers;
    if (workers < 4) return;
    const larvae = this.brood.filter((b) => b.stage !== BroodStage.PUPA).length;
    const wantNurses = clamp(Math.round(4 + this.brood.length * 0.35 + larvae * 0.15), Math.max(4, Math.round(workers * 0.14)), Math.round(workers * 0.4));
    const work = this.planCount + this.repairCount * 3;
    const wantDiggers = work > 0 ? clamp(Math.round(3 + Math.sqrt(work) * 1.2 + this.repairCount * 0.4), 3, Math.round(workers * 0.3)) : 2;
    const wantForagers = workers - wantNurses - wantDiggers;

    const deficits: [AntCaste, number][] = [
      [AntCaste.NURSE, wantNurses - nurses],
      [AntCaste.EXCAVATOR, wantDiggers - diggers],
      [AntCaste.WORKER, wantForagers - foragers],
    ];
    deficits.sort((a, b) => b[1] - a[1]);
    const [needCaste, need] = deficits[0];
    if (need <= 0) return;
    // take from the caste with the biggest surplus
    const surplus = deficits.filter(([c, d]) => d < 0 && c !== needCaste).sort((a, b) => a[1] - b[1]);
    if (surplus.length === 0) return;
    const fromCaste = surplus[0][0];
    // nurses are recruited from the youngest, foragers from the oldest
    let pick: Ant | null = null;
    for (const a of this.ants) {
      if (a.caste !== fromCaste || a.payload !== PayloadType.NONE || a.payloadId !== null || a.isCallow) continue;
      if (a.targetId != null || a.task === AntTask.DEFENDING) continue;
      if (!pick) pick = a;
      else if (needCaste === AntCaste.NURSE ? a.age < pick.age : a.age > pick.age) pick = a;
    }
    if (!pick) return;
    pick.caste = needCaste;
    pick.speed = this.casteSpeed(needCaste);
    pick.task = needCaste === AntCaste.NURSE ? AntTask.MOVING_BROOD : needCaste === AntCaste.EXCAVATOR ? AntTask.EXCAVATING : AntTask.FORAGING_SCOUT;
    pick.digIdx = -1;
    pick.payloadValue = 0;
    this.stopMoving(pick);
  }

  // ================================================================================================================
  // Weather damage
  // ================================================================================================================

  private stepStormDamage(dt: number): void {
    if (this.weather !== 'Light Rain') return;
    this.damageTimer -= dt;
    if (this.damageTimer > 0) return;
    this.damageTimer = 2.2 + Math.random() * 3;
    if (Math.random() < 0.6) this.erodeMound();
    else this.collapseShallowTunnel();
  }

  /** Rain washes soil down the steep faces of the mound; some runs back into the entrance crater and plugs it. */
  private erodeMound(): void {
    const ents: [number, number][] = [
      [this.entrancePos.x, CRATER_MAIN],
      [SIDE_ENTRANCE_X, CRATER_SIDE],
    ];
    for (let tries = 0; tries < 14; tries++) {
      const [ex, crater] = ents[0];
      const off = (crater + Math.random() * (this.moundRadius() + 20)) * (Math.random() < 0.5 ? -1 : 1);
      const gx = clamp(Math.floor((ex + off) / CELL_SIZE), 12, GRID_W - 13);
      const top = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
      const dir = Math.random() < 0.5 ? -1 : 1;
      const ngx = gx + dir;
      const ntop = Math.floor(this.grid.surfaceY[ngx] / CELL_SIZE);
      if (ntop - top < 2) continue;
      const ti = this.grid.idx(gx, top);
      if (!this.canExcavate(ti) || this.grid.terrain[this.grid.idx(gx, top + 1)] === CellType.TUNNEL) continue;
      const wx = (ngx + 0.5) * CELL_SIZE;
      const intoCrater = Math.abs(wx - ex) < crater;
      this.grid.setTerrain(gx, top, CellType.AIR);
      this.grid.updateSurfaceColumn(gx);
      if (intoCrater) {
        // mud slides into the entrance throat
        const plug = this.findEntrancePlugCell(ex);
        if (plug >= 0) {
          const pgx = plug % GRID_W;
          const pgy = (plug - pgx) / GRID_W;
          this.grid.setTerrain(pgx, pgy, CellType.SUBSOIL);
          this.digPlan[plug] = 2;
          this.grid.updateSurfaceColumn(pgx);
          this.evictFrom(pgx, pgy);
          this.log('Rain washed mud into a nest entrance!', 'danger');
        }
      } else {
        const nGy = ntop - 1;
        if (nGy > 4) {
          this.grid.setTerrain(ngx, nGy, CellType.SUBSOIL);
          this.grid.updateSurfaceColumn(ngx);
          this.evictFrom(ngx, nGy);
        }
      }
      this.spawnCrumbs((gx + 0.5) * CELL_SIZE, top * CELL_SIZE, '#5b4530', 3);
      this.fieldDirty.dig = true;
      return;
    }
  }

  private findEntrancePlugCell(ex: number): number {
    const egx = Math.floor(ex / CELL_SIZE);
    for (let k = 0; k < 6; k++) {
      const gx = egx + (k % 3) - 1;
      const surf = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
      for (let gy = surf; gy < surf + 12 && gy < GRID_H - 2; gy++) {
        const i = this.grid.idx(gx, gy);
        if (this.grid.terrain[i] === CellType.TUNNEL || this.grid.terrain[i] === CellType.AIR) {
          if (!this.cellOccupied(gx, gy)) return i;
          break;
        }
      }
    }
    return -1;
  }

  /** Soaked ceilings of shallow tunnels slump in; the debris must be dug out again. */
  private collapseShallowTunnel(): void {
    for (let tries = 0; tries < 40; tries++) {
      const gx = 14 + Math.floor(Math.random() * (GRID_W - 28));
      const surf = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
      const gy = surf + 3 + Math.floor(Math.random() * 10);
      if (!this.grid.inBounds(gx, gy)) continue;
      if (this.grid.terrain[this.grid.idx(gx, gy)] !== CellType.TUNNEL) continue;
      // only beneath wet soil, and never inside the royal chamber
      const above = this.grid.idx(gx, Math.max(0, gy - 2));
      if (this.grid.moisture[above] < 0.4 && Math.random() < 0.6) continue;
      if (this.chambers.some((c) => c.type === ChamberType.ROYAL && Math.hypot((gx * CELL_SIZE - c.x) / c.rx, (gy * CELL_SIZE - c.y) / c.ry) < 1.3)) continue;
      let n = 0;
      const blob = 2 + Math.floor(Math.random() * 4);
      for (let k = 0; k < 9 && n < blob; k++) {
        const cx = gx + (k % 3) - 1;
        const cy = gy + Math.floor(k / 3) - 1;
        const i = this.grid.idx(cx, cy);
        if (this.grid.terrain[i] !== CellType.TUNNEL || this.cellOccupied(cx, cy)) continue;
        this.grid.setTerrain(cx, cy, CellType.SUBSOIL);
        this.digPlan[i] = 2;
        n++;
      }
      if (n > 0) {
        this.spawnCrumbs(gx * CELL_SIZE, gy * CELL_SIZE, '#4a3828', 6);
        this.fieldDirty.dig = true;
        this.log('A soaked tunnel ceiling caved in', 'danger');
        return;
      }
    }
  }

  private cellOccupied(gx: number, gy: number): boolean {
    const x0 = gx * CELL_SIZE - 3;
    const x1 = (gx + 1) * CELL_SIZE + 3;
    const y0 = gy * CELL_SIZE - 3;
    const y1 = (gy + 1) * CELL_SIZE + 3;
    const inside = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
    let hit = false;
    this.forAntsNear((gx + 0.5) * CELL_SIZE, (gy + 0.5) * CELL_SIZE, 10, (a) => {
      if (inside(a.x, a.y)) hit = true;
      return hit;
    });
    if (hit) return true;
    for (const b of this.brood) if (inside(b.x, b.y)) return true;
    for (const f of this.foods) if (inside(f.x, f.y)) return true;
    return false;
  }

  /** Lift anything sitting where a fresh clod of earth just landed. */
  private evictFrom(gx: number, gy: number): void {
    const surf = this.grid.surfaceY[gx];
    const wx = (gx + 0.5) * CELL_SIZE;
    for (const a of this.ants) {
      if (Math.abs(a.x - wx) < 6 && a.y >= gy * CELL_SIZE - 3 && a.y <= (gy + 1) * CELL_SIZE + 3) {
        if (a.y < surf + 8) a.y = surf - 1.5;
      }
    }
    for (const f of this.foods) {
      if (f.storedInChamberId === null && !f.falling && Math.abs(f.x - wx) < 8 && f.y >= surf - 4) f.y = surf - 3;
    }
  }

  private spawnCrumbs(x: number, y: number, color: string, n: number): void {
    for (let k = 0; k < n; k++) {
      this.particles.push({
        x: x + (Math.random() - 0.5) * 6,
        y,
        vx: (Math.random() - 0.5) * 22,
        vy: -6 - Math.random() * 16,
        size: 1.1 + Math.random() * 1.2,
        alpha: 0.9,
        life: 0,
        maxLife: 0.5,
        kind: 'crumb',
        color,
      });
    }
  }

  // ================================================================================================================
  // Intruders
  // ================================================================================================================

  private spawnIntruders(): void {
    const homeEdge: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
    const creviceX = homeEdge === 'left' ? CASE_LEFT + 78 : CASE_RIGHT - 78;
    const make = (species: Intruder['species'], behavior: Intruder['behavior'], dx: number) => {
      const maxHp =
        species === 'beetle' ? 120 : species === 'centipede' ? 95 : species === 'earwig' ? 80 : species === 'mite' ? 30 : 45;
      const p = this.surfaceTarget(creviceX + dx);
      this.intruders.push({
        id: this.allocId(),
        x: p.x,
        y: p.y - 1,
        vx: 0,
        vy: 0,
        angle: homeEdge === 'left' ? 0 : Math.PI,
        hp: maxHp,
        maxHp,
        legPhase: Math.random() * Math.PI * 2,
        species,
        aggression: 1,
        attackCooldown: 0,
        behavior,
        carryingFoodAmount: 0,
        targetFoodId: null,
        homeEdge,
        path: [],
        pathIndex: 0,
        lastPathTime: -10,
      });
    };
    const r = Math.random();
    if (r < 0.4) {
      const squad = 2 + (Math.random() < 0.5 ? 1 : 0);
      for (let s = 0; s < squad; s++) make('rival_ant', s === 0 ? 'hunting_ants' : 'raiding_food', (homeEdge === 'left' ? 1 : -1) * s * 11);
      this.log('A raiding party of rival ants approaches!', 'danger');
    } else {
      const r2 = Math.random();
      const species: Intruder['species'] = r2 < 0.28 ? 'beetle' : r2 < 0.52 ? 'earwig' : r2 < 0.8 ? 'mite' : 'centipede';
      const behavior: Intruder['behavior'] =
        species === 'beetle' || species === 'earwig' ? 'raiding_food' : species === 'mite' ? 'infiltrating_brood' : 'hunting_ants';
      make(species, behavior, 0);
      const name = species === 'mite' ? 'A brood mite' : species === 'centipede' ? 'A hunting centipede' : species === 'earwig' ? 'An earwig' : 'A beetle';
      this.log(`${name} crawls out of the rocks!`, 'danger');
    }
  }

  private stepIntruders(dt: number): void {
    this.intruderTimer -= dt;
    if (this.intruderTimer <= 0) {
      this.intruderTimer = 40 + Math.random() * 45;
      if (this.intruders.length < 3 && this.ants.length > 12) this.spawnIntruders();
    }

    for (let i = this.intruders.length - 1; i >= 0; i--) {
      const m = this.intruders[i];
      m.legPhase += dt * (m.species === 'centipede' ? 24 : m.species === 'rival_ant' ? 22 : m.species === 'mite' ? 20 : 16);
      m.attackCooldown = Math.max(0, m.attackCooldown - dt);
      m.age = (m.age ?? 0) + dt;
      const shelterXHome = (m.homeEdge ?? 'left') === 'left' ? CASE_LEFT + 72 : CASE_RIGHT - 72;
      if (Math.abs(m.x - shelterXHome) > 70) m.roamed = true;
      // invaders lose their nerve after a while (or when the alarm brings a crowd of defenders)
      if (m.age > 80 || (m.age > 20 && this.countAntsNear(m.x, m.y, 26) >= (m.species === 'beetle' ? 7 : 5))) m.behavior = 'retreating';
      const prevX = m.x;
      const prevY = m.y;

      const carrying = (m.carryingFoodAmount ?? 0) > 0;
      if (m.hp < m.maxHp * 0.3 || carrying || m.behavior === 'retreating') m.behavior = 'retreating';
      const retreating = m.behavior === 'retreating';
      const speed =
        (carrying ? 0.6 : 1) *
        (retreating && m.hp < m.maxHp * 0.3 ? 36 : m.species === 'rival_ant' ? 31 : m.species === 'mite' ? 24 : m.species === 'centipede' ? 26 : m.species === 'earwig' ? 22 : 19) *
        0.85;

      const g = this.grid.worldToGrid(m.x, m.y);
      const underground = m.y > this.grid.surfaceY[g.gx] + 8 || this.grid.terrain[this.grid.idx(g.gx, g.gy)] === CellType.TUNNEL;
      const shelterX = (m.homeEdge ?? 'left') === 'left' ? CASE_LEFT + 72 : CASE_RIGHT - 72;

      // pick where to go
      let fieldKey: FieldKey | null = null;
      let goalX = this.entrancePos.x;
      let directTarget: Vec2 | null = null;
      if (retreating) {
        if (underground) fieldKey = 'surface';
        else goalX = shelterX;
      } else {
        let prey: Ant | null = null;
        if (m.behavior === 'hunting_ants') {
          let bestD = 200;
          this.forAntsNear(m.x, m.y, 200, (a) => {
            if (a.caste === AntCaste.QUEEN) return;
            const d = Math.abs(a.x - m.x) + Math.abs(a.y - m.y);
            if (d < bestD && (underground || this.isOutside(a.x, a.y))) {
              bestD = d;
              prey = a;
            }
          });
        }
        let food: FoodSource | undefined;
        if (m.behavior === 'raiding_food' && !underground) {
          let bestD = 420;
          for (const f of this.foods) {
            if (f.storedInChamberId !== null || f.falling || f.amount < 2) continue;
            const d = Math.abs(f.x - m.x);
            if (d < bestD) {
              bestD = d;
              food = f;
            }
          }
        }
        if (prey) {
          const p = prey as Ant;
          if (underground) directTarget = { x: p.x, y: p.y };
          else goalX = p.x;
        } else if (food) {
          goalX = food.x;
          if (Math.abs(food.x - m.x) < 10 && Math.abs(food.y - m.y) < 12) {
            const stolen = Math.min(food.amount, 8);
            food.amount -= stolen;
            m.carryingFoodAmount = stolen;
          }
        } else {
          // raid inside the nest
          const key: FieldKey = m.species === 'mite' || m.species === 'centipede' ? 'nursery' : 'granary';
          if (underground || Math.abs(m.x - this.entrancePos.x) < 22 || Math.abs(m.x - SIDE_ENTRANCE_X) < 18) fieldKey = key;
          else goalX = Math.abs(m.x - SIDE_ENTRANCE_X) < Math.abs(m.x - this.entrancePos.x) * 0.6 ? SIDE_ENTRANCE_X : this.entrancePos.x;
          if (underground) {
            // steal from the granary / prey on brood once there
            if (key === 'granary') {
              const pile = this.foods.find((f) => f.storedInChamberId !== null && f.amount > 2 && Math.abs(f.x - m.x) < 12 && Math.abs(f.y - m.y) < 12);
              if (pile && m.attackCooldown <= 0) {
                const stolen = Math.min(pile.amount, 10);
                pile.amount -= stolen;
                m.carryingFoodAmount = stolen;
                this.log(`Intruder stole food from the granary`, 'danger');
              }
            } else {
              const b = this.brood.find((br) => br.carriedByAntId === null && Math.abs(br.x - m.x) < 11 && Math.abs(br.y - m.y) < 11);
              if (b && m.attackCooldown <= 0) {
                m.attackCooldown = 1.2;
                b.nutrition -= 30;
                b.progress = Math.max(0, b.progress - 15);
                if (b.nutrition < -20 || b.stage === BroodStage.EGG) {
                  this.brood.splice(this.brood.indexOf(b), 1);
                  this.log(`${m.species === 'mite' ? 'A mite' : 'The centipede'} devoured some brood!`, 'danger');
                }
              }
            }
          }
        }
      }

      // movement
      if (fieldKey) {
        const f = this.fields[fieldKey];
        const ci = this.antCell(m);
        if (!m.path || (m.pathIndex ?? 0) >= m.path.length) {
          const nxt = this.grid.descend(f, ci);
          const nxt2 = nxt >= 0 ? this.grid.descend(f, nxt) : -1;
          m.path = [];
          for (const c of [nxt, nxt2]) {
            if (c < 0) break;
            const gx = c % GRID_W;
            m.path.push(this.grid.gridToWorld(gx, (c - gx) / GRID_W));
          }
          m.pathIndex = 0;
          if (m.path.length === 0 && f[ci] <= 0.5 && fieldKey === 'surface') {
            // reached open ground: walk home along the surface next step
            m.y = this.grid.surfaceY[g.gx] - 3;
          }
        }
        const wp = m.path && (m.pathIndex ?? 0) < m.path.length ? m.path[m.pathIndex ?? 0] : directTarget;
        if (wp) this.moveIntruderToward(m, wp.x, wp.y, speed, dt);
      } else if (directTarget) {
        m.path = [];
        this.moveIntruderToward(m, directTarget.x, directTarget.y, speed, dt);
      } else {
        m.path = [];
        const dir = goalX >= m.x ? 1 : -1;
        if (Math.abs(goalX - m.x) > 2) {
          const nx = clamp(m.x + dir * speed * dt, CASE_LEFT + 16, CASE_RIGHT - 16);
          const surfY = this.grid.surfaceY[clamp(Math.floor(nx / CELL_SIZE), 0, GRID_W - 1)] - 2.5;
          m.x = nx;
          m.y = m.y + (surfY - m.y) * Math.min(1, dt * 10);
          m.angle = dir > 0 ? 0 : Math.PI;
        }
      }

      const cg = this.grid.worldToGrid(m.x, m.y);
      if (this.grid.isSolid(cg.gx, cg.gy) || !this.grid.isNavigable(cg.gx, cg.gy)) {
        const safe = this.grid.findNearestNavigable(cg.gx, cg.gy, 8);
        if (safe) {
          const w = this.grid.gridToWorld(safe.gx, safe.gy);
          m.x = w.x;
          m.y = w.y;
          m.path = [];
        }
      }
      m.vx = (m.x - prevX) / dt;
      m.vy = (m.y - prevY) / dt;
      this.grid.depositPheromone(this.grid.alarmPheromone, m.x, m.y, 0.5 * dt * 10, 2);

      // bite the nearest ant in reach
      if (m.attackCooldown <= 0 && m.hp >= m.maxHp * 0.3) {
        let victim: Ant | null = null;
        let bestD = 14;
        this.forAntsNear(m.x, m.y, 14, (a) => {
          const d = Math.hypot(a.x - m.x, a.y - m.y);
          if (d < bestD) {
            bestD = d;
            victim = a;
          }
        });
        if (victim) {
          const v = victim as Ant;
          m.attackCooldown = m.species === 'rival_ant' ? 0.8 : m.species === 'centipede' ? 0.9 : m.species === 'mite' ? 1.1 : 1.15;
          const dmg = m.species === 'centipede' ? 9 : m.species === 'beetle' ? 7 : m.species === 'earwig' ? 7 : m.species === 'mite' ? 3 : 6;
          v.hp = (v.hp ?? 24) - dmg * (v.caste === AntCaste.QUEEN ? 0.5 : 1);
          v.lastHitTime = this.simTime;
          this.spark((m.x + v.x) * 0.5, (m.y + v.y) * 0.5, '#f59e0b');
          // a soldier's counter-bite can make a raider drop its loot
          if (carrying && v.caste === AntCaste.SOLDIER && Math.random() < 0.35) {
            this.dropFoodAt(m.x, m.y, PayloadType.SEED, m.carryingFoodAmount ?? 0);
            m.carryingFoodAmount = 0;
          }
        }
      }

      const escaped = retreating && !underground && Math.abs(m.x - shelterX) < 12 && (m.roamed || m.age > 25);
      if (m.hp <= 0 || escaped) {
        if (m.hp <= 0) {
          if ((m.carryingFoodAmount ?? 0) > 0) this.dropFoodAt(m.x - 5, m.y, PayloadType.SEED, m.carryingFoodAmount ?? 0);
          this.dropFoodAt(m.x, m.y, PayloadType.PROTEIN, m.species === 'rival_ant' || m.species === 'mite' ? 22 : 40);
          const name = m.species === 'rival_ant' ? 'a rival ant' : m.species === 'earwig' ? 'an earwig' : `a ${m.species}`;
          this.log(`Defenders killed ${name}; its body becomes food`, 'good');
        } else if ((m.carryingFoodAmount ?? 0) > 0) {
          this.log('A raider escaped with stolen food', 'danger');
        } else {
          this.log(`The ${m.species === 'rival_ant' ? 'rival ant' : m.species} was driven off`, 'good');
        }
        this.intruders.splice(i, 1);
        this.fieldDirty.threat = true;
      }
    }
  }

  private countAntsNear(x: number, y: number, r: number): number {
    let n = 0;
    this.forAntsNear(x, y, r, () => {
      n++;
    });
    return n;
  }

  private moveIntruderToward(m: Intruder, tx: number, ty: number, speed: number, dt: number): void {
    const dx = tx - m.x;
    const dy = ty - m.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 1) {
      m.pathIndex = (m.pathIndex ?? 0) + 1;
      return;
    }
    if (dist < 4 && m.path && (m.pathIndex ?? 0) < m.path.length) m.pathIndex = (m.pathIndex ?? 0) + 1;
    const a = Math.atan2(dy, dx);
    const step = Math.min(dist, speed * dt);
    const nx = m.x + Math.cos(a) * step;
    const ny = m.y + Math.sin(a) * step;
    const ng = this.grid.worldToGrid(nx, ny);
    if (this.grid.isNavigable(ng.gx, ng.gy)) {
      m.x = nx;
      m.y = ny;
    } else {
      const gX = this.grid.worldToGrid(nx, m.y);
      const gY = this.grid.worldToGrid(m.x, ny);
      if (this.grid.isNavigable(gX.gx, gX.gy)) m.x = nx;
      else if (this.grid.isNavigable(gY.gx, gY.gy)) m.y = ny;
      else m.path = [];
    }
    m.angle = lerpAngle(m.angle, a, Math.min(1, dt * 10));
  }

  private dropFoodAt(x: number, y: number, type: FoodSource['type'], amount: number): void {
    if (amount <= 0.5) return;
    let dx = x;
    let dy = y;
    const gx = clamp(Math.floor(x / CELL_SIZE), 0, GRID_W - 1);
    const onSurface = y <= this.grid.surfaceY[gx] + 6;
    // keep the entrance throats clear
    for (const [ex, r] of [[this.entrancePos.x, 40], [SIDE_ENTRANCE_X, 30]] as const) {
      if (onSurface && Math.abs(x - ex) < r) {
        dx = ex + (x >= ex ? 1 : -1) * (r + 6);
        dy = this.surfaceTarget(dx).y - 1;
      }
    }
    this.foods.push({
      id: this.allocId(),
      type,
      x: dx,
      y: dy,
      amount,
      maxAmount: Math.max(30, amount),
      radius: 5,
      storedInChamberId: null,
    });
  }

  private spark(x: number, y: number, color: string): void {
    if (this.particles.length > 220) return;
    this.particles.push({
      x,
      y,
      vx: (Math.random() - 0.5) * 24,
      vy: -12 - Math.random() * 12,
      size: 1.2,
      alpha: 0.75,
      life: 0,
      maxLife: 0.28,
      kind: 'spark',
      color,
    });
  }

  // ================================================================================================================
  // Crowding
  // ================================================================================================================

  private resolveEntityCrowding(dt: number): void {
    const canOccupy = (px: number, py: number): boolean => {
      if (px <= CASE_LEFT + 12 || px >= CASE_RIGHT - 12 || py <= CASE_TOP + 12 || py >= CASE_BOTTOM - 12) return false;
      const g = this.grid.worldToGrid(px, py);
      return this.grid.isNavigable(g.gx, g.gy);
    };
    const nudgePair = (
      a: { id: number; x: number; y: number },
      b: { id: number; x: number; y: number },
      minDist: number,
      strength: number
    ) => {
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= minDist) return;
      if (dist < 0.05) {
        const ang = (a.id * 2.39996 + b.id * 1.17) % (Math.PI * 2);
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        dist = 1;
      } else {
        dx /= dist;
        dy /= dist;
      }
      const overlap = minDist - dist;
      const push = Math.min(0.9 * dt * 60, overlap * strength * Math.min(1, dt * 18));
      const sign = a.id < b.id ? 1 : -1;
      const dodge = push * 0.9 * sign;
      const ax = a.x - dx * push - dy * dodge;
      const ay = a.y - dy * push + dx * dodge;
      if (canOccupy(ax, ay)) {
        a.x = ax;
        a.y = ay;
      }
      const bx = b.x + dx * push + dy * dodge;
      const by = b.y + dy * push - dx * dodge;
      if (canOccupy(bx, by)) {
        b.x = bx;
        b.y = by;
      }
    };

    for (let i = 0; i < this.ants.length; i++) {
      const a = this.ants[i];
      if (BUSY_TASKS.has(a.task) && a.task !== AntTask.IDLE) continue;
      this.forAntsNear(a.x, a.y, 11, (b) => {
        if (b.id <= a.id) return;
        if (a.trophallaxisPartnerId === b.id) return;
        const minDist = a.caste === AntCaste.QUEEN || b.caste === AntCaste.QUEEN ? 10.5 : 7.0;
        nudgePair(a, b, minDist, 0.5);
      });
    }
    for (let i = 0; i < this.intruders.length; i++) {
      const m = this.intruders[i];
      for (let j = i + 1; j < this.intruders.length; j++) {
        const o = this.intruders[j];
        if (Math.abs(m.x - o.x) > 16 || Math.abs(m.y - o.y) > 16) continue;
        nudgePair(m, o, 12, 0.65);
      }
      const standoff = m.species === 'rival_ant' || m.species === 'mite' ? 9.0 : 12.0;
      this.forAntsNear(m.x, m.y, standoff, (a) => nudgePair(a, m, standoff, 0.65));
    }
  }

  private stepFallenAnts(dt: number): void {
    for (let i = this.fallenAnts.length - 1; i >= 0; i--) {
      const f = this.fallenAnts[i];
      if (f.carriedByAntId !== null) continue;
      f.decayTimer -= dt * (f.atMidden ? 1 : 0.1);
      if (f.decayTimer <= 0) this.fallenAnts.splice(i, 1);
    }
  }

  // ================================================================================================================
  // Ants
  // ================================================================================================================

  private killAnt(index: number, cause: 'age' | 'combat' | 'starvation'): void {
    const ant = this.ants[index];
    this.releasePayload(ant);
    let fx = ant.x;
    let fy = ant.y;
    const gx = clamp(Math.floor(ant.x / CELL_SIZE), 0, GRID_W - 1);
    const surfY = this.grid.surfaceY[gx];
    for (const [ex, r] of [[this.entrancePos.x, 30], [SIDE_ENTRANCE_X, 24]] as const) {
      if (Math.abs(ant.x - ex) < r && ant.y > surfY - 4 && ant.y < surfY + 60) {
        fx = clamp(ex + (ant.id % 2 === 0 ? 1 : -1) * (r + 18), CASE_LEFT + 32, CASE_RIGHT - 32);
        fy = this.surfaceTarget(fx).y;
      }
    }
    this.fallenAnts.push({ id: this.allocId(), x: fx, y: fy, angle: ant.angle, carriedByAntId: null, atMidden: false, decayTimer: 25 });
    this.ants.splice(index, 1);
    if (ant.caste === AntCaste.QUEEN) this.log('The queen has died! The colony cannot raise new workers', 'danger');
    else if (cause === 'combat') this.log(`A ${ant.caste.toLowerCase()} fell defending the colony`, 'danger');
    else if (cause === 'starvation') this.log(this.storedFoodCache < 10 ? 'A worker starved: the stores are empty' : 'A worker starved', 'danger');
  }

  /** Drop whatever is carried (brood goes back on the floor, food lands where the ant stands). */
  private releasePayload(ant: Ant): void {
    if (ant.payloadId !== null) {
      if (ant.payload === PayloadType.REFUSE) {
        const fa = this.fallenAnts.find((f) => f.id === ant.payloadId);
        if (fa) fa.carriedByAntId = null;
      } else {
        const b = this.brood.find((br) => br.id === ant.payloadId);
        if (b) b.carriedByAntId = null;
      }
    } else if (isFoodPayload(ant.payload) && ant.payloadValue > 0) {
      this.dropFoodAt(ant.x, ant.y, ant.payload as FoodSource['type'], ant.payloadValue);
    }
    ant.payload = PayloadType.NONE;
    ant.payloadId = null;
    ant.payloadValue = 0;
    ant.targetId = null;
    ant.digIdx = -1;
  }

  private stepAnts(dt: number): void {
    const night = this.isNight();
    for (let i = this.ants.length - 1; i >= 0; i--) {
      const ant = this.ants[i];
      ant.age += dt;
      ant.greetCooldown = Math.max(0, ant.greetCooldown - dt);
      ant.signalCooldown = Math.max(0, (ant.signalCooldown ?? 0) - dt);
      ant.attackCd = Math.max(0, (ant.attackCd ?? 0) - dt);
      ant.antennaPhase += dt * (ant.task === AntTask.TROPHALLAXIS || ant.task === AntTask.GREETING || ant.task === AntTask.SIGNALING_FOOD ? 18 : 8);
      if (ant.isCallow) {
        ant.callowTimer -= dt;
        if (ant.callowTimer <= 0) ant.isCallow = false;
      }

      ant.hunger = clamp(ant.hunger + dt * (ant.caste === AntCaste.QUEEN ? 0.22 : ant.task === AntTask.IDLE ? 0.06 : 0.11), 0, 100);
      ant.hydration = clamp(ant.hydration - dt * 0.2, 0, 100);
      if (ant.hunger >= 100) ant.hp = (ant.hp ?? 24) - dt * 0.6;
      else if (ant.hunger < 60 && this.simTime - (ant.lastHitTime ?? -99) > 6) ant.hp = Math.min(ant.maxHp ?? 24, (ant.hp ?? 24) + dt * 0.8);

      if ((ant.hp ?? 1) <= 0) {
        this.killAnt(i, ant.hunger >= 100 ? 'starvation' : 'combat');
        continue;
      }
      if (ant.caste !== AntCaste.QUEEN && ant.age > ant.maxAge) {
        this.killAnt(i, 'age');
        continue;
      }

      if (ant.caste === AntCaste.QUEEN) {
        this.stepQueen(ant, dt);
        this.moveAnt(ant, dt);
        continue;
      }

      // --- timed stationary activities -------------------------------------------------------------------------
      if (ant.task === AntTask.EXCAVATING && (ant.digIdx ?? -1) >= 0) {
        ant.stateTimer -= dt;
        ant.vx = 0;
        ant.vy = 0;
        if (ant.stateTimer <= 0) this.finishDig(ant);
        continue;
      }
      if (BUSY_TASKS.has(ant.task)) {
        ant.stateTimer -= dt;
        ant.vx = 0;
        ant.vy = 0;
        if (ant.trophallaxisPartnerId != null) {
          const p = this.ants.find((o) => o.id === ant.trophallaxisPartnerId);
          if (p) ant.angle = lerpAngle(ant.angle, Math.atan2(p.y - ant.y, p.x - ant.x), Math.min(1, dt * 8));
        }
        const alarmed = ant.task === AntTask.IDLE && this.intruderNear(ant, ant.caste === AntCaste.SOLDIER ? 220 : 90);
        const dawn = ant.task === AntTask.IDLE && ant.caste === AntCaste.WORKER && !night && ant.stateTimer > 4 && Math.random() < dt * 0.3;
        if (ant.stateTimer <= 0 || alarmed || dawn) {
          if (ant.task === AntTask.IDLE) ant.restCooldown = 40 + Math.random() * 80;
          ant.task = AntTask.FORAGING_SCOUT;
          ant.trophallaxisPartnerId = null;
        }
        if (ant.payloadId !== null) this.syncCarried(ant);
        continue;
      }

      // --- defence comes first ---------------------------------------------------------------------------------
      const fight = this.handleThreat(ant, dt);
      if (fight === 'hold') {
        ant.vx = 0;
        ant.vy = 0;
        continue;
      }

      if (fight !== 'moving') {
        // --- casual greeting between passing nestmates -----------------------------------------------------------
        if (ant.payload === PayloadType.NONE && ant.greetCooldown <= 0 && Math.random() < dt * 0.4 && this.intruders.length === 0) {
          let other: Ant | null = null;
          this.forAntsNear(ant.x, ant.y, 9, (o) => {
            if (o.id !== ant.id && o.caste !== AntCaste.QUEEN && o.greetCooldown <= 0 && !BUSY_TASKS.has(o.task) && o.payload === PayloadType.NONE) {
              other = o;
              return true;
            }
          });
          if (other) {
            const o = other as Ant;
            // Trophallaxis if one is hungry and the other well fed, otherwise a quick antennal greeting
            const share = Math.abs(ant.hunger - o.hunger) > 35;
            for (const [p, q] of [[ant, o], [o, ant]] as const) {
              p.task = share ? AntTask.TROPHALLAXIS : AntTask.GREETING;
              p.stateTimer = share ? 1.8 : 0.7;
              p.greetCooldown = 18 + Math.random() * 10;
              p.trophallaxisPartnerId = q.id;
              this.stopMoving(p);
            }
            if (share) {
              const avg = (ant.hunger + o.hunger) / 2;
              ant.hunger = avg;
              o.hunger = avg;
            }
            continue;
          }
          ant.greetCooldown = 3;
        }

        if (ant.caste === AntCaste.WORKER) this.stepForager(ant, dt, night);
        else if (ant.caste === AntCaste.NURSE) this.stepNurse(ant, dt);
        else if (ant.caste === AntCaste.EXCAVATOR) this.stepExcavator(ant, dt);
        else if (ant.caste === AntCaste.SOLDIER) this.stepSoldier(ant, dt, night);
        if (BUSY_TASKS.has(ant.task) || (ant.task === AntTask.EXCAVATING && (ant.digIdx ?? -1) >= 0)) {
          this.syncCarried(ant);
          continue;
        }
      }

      // keep contour walks going between behaviour decisions
      if (ant.navKey === 'contour' && ant.targetPos && ant.pathIndex >= ant.path.length) this.goTo(ant, ant.targetPos.x, ant.targetPos.y);
      this.moveAnt(ant, dt);
      this.syncCarried(ant);
    }
  }

  private syncCarried(ant: Ant): void {
    if (ant.payloadId === null) return;
    if (ant.payload === PayloadType.REFUSE) {
      const fa = this.fallenAnts.find((f) => f.id === ant.payloadId);
      if (fa) {
        fa.x = ant.x + Math.cos(ant.angle) * 7;
        fa.y = ant.y + Math.sin(ant.angle) * 7;
        fa.angle = ant.angle + 0.4;
      } else {
        ant.payloadId = null;
        ant.payload = PayloadType.NONE;
      }
    } else {
      const b = this.brood.find((br) => br.id === ant.payloadId);
      if (b) {
        b.x = ant.x + Math.cos(ant.angle) * 7;
        b.y = ant.y + Math.sin(ant.angle) * 7;
      } else {
        ant.payloadId = null;
        ant.payload = PayloadType.NONE;
      }
    }
  }

  private busy(ant: Ant, task: AntTask, seconds: number): void {
    ant.task = task;
    ant.stateTimer = seconds;
    this.stopMoving(ant);
  }

  private intruderNear(ant: { x: number; y: number }, radius: number): boolean {
    for (const m of this.intruders) {
      if (Math.abs(m.x - ant.x) < radius && Math.abs(m.y - ant.y) < radius) return true;
    }
    return false;
  }

  /**
   * Alarm response. Soldiers converge on any intruder near or inside the nest; other workers fight what is right
   * next to them (or anything that got inside), but flee large predators out on the open surface.
   */
  private handleThreat(ant: Ant, dt: number): 'none' | 'moving' | 'hold' {
    if (this.intruders.length === 0) return 'none';
    const soldier = ant.caste === AntCaste.SOLDIER;
    const radius = soldier ? 320 : ant.caste === AntCaste.NURSE ? 45 : 60;
    let target: Intruder | null = null;
    let bestD = radius;
    for (const m of this.intruders) {
      if (m.hp <= 0) continue;
      const d = Math.hypot(m.x - ant.x, m.y - ant.y);
      if (d < bestD) {
        bestD = d;
        target = m;
      }
    }
    if (!target) return 'none';
    const m = target as Intruder;
    if (!soldier && ant.payload !== PayloadType.NONE && bestD > 18) return 'none';
    if (ant.hunger > 85 && bestD > 18) return 'none';
    const g = this.grid.worldToGrid(m.x, m.y);
    const inside = m.y > this.grid.surfaceY[g.gx] + 8;
    const big = m.species === 'beetle' || m.species === 'centipede' || m.species === 'earwig';
    if (!soldier && big && !inside && bestD > 16) {
      // flee from big predators out in the open
      if (bestD > 45) return 'none';
      const away = ant.x >= m.x ? 1 : -1;
      if (ant.task !== AntTask.FLEEING || !ant.targetPos || Math.sign(ant.targetPos.x - ant.x) !== away) {
        const t = this.surfaceTarget(ant.x + away * 90);
        this.goTo(ant, t.x, t.y);
      }
      ant.task = AntTask.FLEEING;
      return 'moving';
    }
    if (ant.payload !== PayloadType.NONE && ant.payloadId === null && !isFoodPayload(ant.payload)) this.releasePayload(ant);
    ant.task = AntTask.DEFENDING;
    this.grid.depositPheromone(this.grid.alarmPheromone, ant.x, ant.y, 0.4, 1);
    const reach = (soldier ? 16 : 14) + (big ? 3 : 0);
    if (bestD < reach) {
      ant.angle = lerpAngle(ant.angle, Math.atan2(m.y - ant.y, m.x - ant.x), Math.min(1, dt * 10));
      if ((ant.attackCd ?? 0) <= 0) {
        ant.attackCd = soldier ? 0.45 : 0.65;
        m.hp -= soldier ? 9 : 3.5;
        this.spark((ant.x + m.x) * 0.5, (ant.y + m.y) * 0.5, '#fef08a');
      }
      this.stopMoving(ant);
      return 'hold';
    }
    // close and in the open: charge straight in; otherwise route through the tunnels
    if (bestD < 22 || (bestD < 60 && this.isOutside(ant.x, ant.y) && !inside)) this.goTo(ant, m.x, m.y);
    else if (this.go(ant, 'threat') >= INF) return 'none';
    return 'moving';
  }

  private stepQueen(ant: Ant, dt: number): void {
    ant.stateTimer -= dt;
    if (ant.task === AntTask.LAYING_EGG || ant.task === AntTask.TROPHALLAXIS) {
      if (ant.stateTimer > 0) {
        this.stopMoving(ant);
        ant.vx = 0;
        ant.vy = 0;
        return;
      }
      ant.task = AntTask.IDLE;
      ant.trophallaxisPartnerId = null;
    }
    const royal = this.nearestChamber(ChamberType.ROYAL, ant.x, ant.y);
    if (!royal) return;
    if (!this.isInsideChamber(ant, royal, 1.0)) {
      this.go(ant, 'royal');
      return;
    }
    if (ant.stateTimer <= 0) {
      ant.stateTimer = 3 + Math.random() * 4;
      this.goTo(ant, royal.x + (Math.random() - 0.5) * royal.rx * 0.7, royal.y + royal.ry * 0.3);
    }
  }

  // --- foragers ---------------------------------------------------------------------------------------------------

  private stepForager(ant: Ant, dt: number, night: boolean): void {
    ant.pheromoneDropTimer -= dt;
    const onSurface = this.isOutside(ant.x, ant.y);

    if (ant.payload === PayloadType.REFUSE) {
      this.carryRefuse(ant);
      return;
    }

    if (isFoodPayload(ant.payload)) {
      ant.task = AntTask.RETURNING_WITH_FOOD;
      if (onSurface && ant.pheromoneDropTimer <= 0) {
        ant.pheromoneDropTimer = 0.12;
        // successful foragers mark the way back so nestmates can follow it out
        this.grid.depositPheromone(this.grid.foodPheromone, ant.x, ant.y, ant.recruitFoodPos ? 0.6 : 0.25, 1);
      }
      const d = this.go(ant, 'granary');
      const g = this.nearestChamber(ChamberType.GRANARY, ant.x, ant.y);
      if (g && (d <= 0.5 || this.isInsideChamber(ant, g, 0.6))) this.storeFood(ant, g);
      return;
    }

    if (ant.hunger > 70 && this.storedFoodCache > 3) {
      this.goEat(ant);
      return;
    }

    // undertakers: a minority of workers clear corpses to the midden
    if (ant.id % 4 === 0 && this.fallenAnts.length > 0) {
      const corpse = this.fallenAnts.find((f) => !f.atMidden && f.carriedByAntId === null && Math.abs(f.x - ant.x) < 50 && Math.abs(f.y - ant.y) < 30);
      if (corpse) {
        ant.task = AntTask.NECROPHORESIS;
        if (Math.hypot(corpse.x - ant.x, corpse.y - ant.y) < 9) {
          corpse.carriedByAntId = ant.id;
          ant.payload = PayloadType.REFUSE;
          ant.payloadId = corpse.id;
          this.stopMoving(ant);
        } else this.goTo(ant, corpse.x, corpse.y);
        return;
      }
    }

    if (!onSurface) {
      ant.excursion = 0;
      if (night && !ant.recruitFoodPos) {
        this.seekRest(ant, 'granary', 8 + Math.random() * 14);
        return;
      }
      // pick up any food lying inside the nest (e.g. a dead intruder) on the way
      const loose = this.foods.find((f) => f.storedInChamberId === null && !f.falling && f.amount > 1 && Math.abs(f.x - ant.x) < 28 && Math.abs(f.y - ant.y) < 16);
      if (loose) {
        if (this.tryPickFood(ant, loose)) return;
        this.goTo(ant, loose.x, loose.y);
        return;
      }
      if ((ant.restCooldown = (ant.restCooldown ?? 30) - dt) <= 0 && Math.random() < 0.3) {
        ant.restCooldown = 60 + Math.random() * 80;
        this.seekRest(ant, 'granary', 5 + Math.random() * 10);
        return;
      }
      ant.task = ant.recruitFoodPos ? AntTask.FOLLOWING_FOOD_TRAIL : AntTask.FORAGING_SCOUT;
      if (this.go(ant, 'surface') >= INF) this.seekRest(ant, 'granary', 6);
      return;
    }

    // ---- out on the surface ----
    ant.excursion = (ant.excursion ?? 0) + dt;
    if (night && ant.excursion > 6) ant.excursion = 999;
    if (ant.excursion > 70 + (ant.id % 7) * 8) {
      // tired or dark: head home empty-handed
      ant.recruitFoodPos = null;
      ant.task = AntTask.SEEKING_REST;
      const d = this.go(ant, 'granary');
      if (d <= 0.5) {
        ant.excursion = 0;
        this.busy(ant, AntTask.IDLE, 6 + Math.random() * 10);
      }
      return;
    }

    if (ant.hydration < 55) {
      const drop = this.droplets.find((dd) => dd.settled && Math.abs(dd.x - ant.x) < 60 && Math.abs(dd.y - ant.y) < 20);
      if (drop) {
        if (Math.hypot(drop.x - ant.x, drop.y - ant.y) < 7) {
          ant.hydration = 100;
          drop.volume = Math.max(0, drop.volume - 2);
          this.busy(ant, AntTask.DRINKING_DEW, 1.2);
        } else {
          ant.task = AntTask.FORAGING_SCOUT;
          this.goTo(ant, drop.x, drop.y);
        }
        return;
      }
    }

    // food in sight
    let food: FoodSource | null = null;
    let bestD = 140;
    for (const f of this.foods) {
      if (f.storedInChamberId !== null || f.falling || f.amount <= 1) continue;
      const d = Math.abs(f.x - ant.x) + Math.abs(f.y - ant.y) * 2;
      if (d < bestD) {
        bestD = d;
        food = f;
      }
    }
    if (food) {
      ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
      if (!this.tryPickFood(ant, food)) this.goTo(ant, food.x, food.y - 1);
      return;
    }

    if (ant.recruitFoodPos) {
      const rp = ant.recruitFoodPos;
      const still = this.foods.some((f) => f.storedInChamberId === null && f.amount > 1 && Math.abs(f.x - rp.x) < 30);
      if (!still || Math.abs(rp.x - ant.x) < 10) ant.recruitFoodPos = null;
      else {
        ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
        const t = this.surfaceTarget(rp.x);
        this.goTo(ant, t.x, t.y);
        return;
      }
    }

    // sniff for a trail either side
    const pAt = (x: number) => {
      const g = this.grid.worldToGrid(x, ant.y);
      return this.grid.foodPheromone[this.grid.idx(g.gx, g.gy)] + this.grid.foodPheromone[this.grid.idx(g.gx, Math.max(0, g.gy - 1))];
    };
    const pL = pAt(ant.x - 18);
    const pR = pAt(ant.x + 18);
    ant.stateTimer -= dt;
    if (pL > 0.06 || pR > 0.06) {
      ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
      ant.trailCommit = (ant.trailCommit ?? 0) - dt;
      if (ant.trailDir === undefined || ant.trailCommit <= 0) {
        // Outbound ants follow a trail *away from home* (they keep track of where the nest is), which brings them
        // to the food at its far end rather than shuttling up and down it.
        const home = Math.abs(ant.x - this.entrancePos.x) < Math.abs(ant.x - SIDE_ENTRANCE_X) ? this.entrancePos.x : SIDE_ENTRANCE_X;
        const awayDir = ant.x >= home ? 1 : -1;
        const ahead = awayDir > 0 ? pR : pL;
        ant.trailDir = ahead > 0.03 ? awayDir : pR > pL ? 1 : -1;
        ant.trailCommit = 2 + Math.random() * 2;
      }
      if (!ant.targetPos || ant.navKey !== 'contour' || Math.sign(ant.targetPos.x - ant.x) !== ant.trailDir || Math.abs(ant.targetPos.x - ant.x) < 12) {
        const t = this.surfaceTarget(ant.x + ant.trailDir * 70);
        this.goTo(ant, t.x, t.y);
      }
      return;
    }
    if (ant.stateTimer <= 0 || !ant.targetPos) {
      ant.task = AntTask.FORAGING_SCOUT;
      ant.stateTimer = 2.5 + Math.random() * 3.5;
      // correlated random walk: mostly keep going the same way
      const keep = Math.cos(ant.angle) >= 0 ? 1 : -1;
      const dir = Math.random() < 0.75 ? keep : -keep;
      const t = this.surfaceTarget(ant.x + dir * (60 + Math.random() * 160));
      this.goTo(ant, t.x, t.y);
    }
  }

  private tryPickFood(ant: Ant, food: FoodSource): boolean {
    if (Math.hypot(food.x - ant.x, food.y - ant.y) > 10) return false;
    this.counters.pickups++;
    const take = Math.min(food.amount, 10);
    food.amount -= take;
    ant.payload = food.type;
    ant.payloadValue = take;
    ant.recruitFoodPos = food.amount > 6 && food.storedInChamberId === null ? { x: food.x, y: food.y } : null;
    ant.pauseTimer = 0.4 + Math.random() * 0.4; // antennate the find before hauling it off
    ant.task = AntTask.RETURNING_WITH_FOOD;
    this.stopMoving(ant);
    this.grid.depositPheromone(this.grid.foodPheromone, ant.x, ant.y, 0.9, 2);
    return true;
  }

  private storeFood(ant: Ant, granary: Chamber): void {
    this.counters.deliveries++;
    const type = ant.payload as FoodSource['type'];
    const piles = this.foods.filter((f) => f.storedInChamberId === granary.id);
    const pile = piles.find((f) => f.type === type && f.amount < f.maxAmount - 2);
    if (pile) pile.amount = Math.min(pile.maxAmount, pile.amount + ant.payloadValue);
    else if (piles.length < 12) {
      const fx = granary.x + (Math.random() - 0.5) * granary.rx * 1.2;
      this.foods.push({
        id: this.allocId(),
        type,
        x: fx,
        y: this.chamberFloorY(granary, fx) - 3,
        amount: ant.payloadValue,
        maxAmount: 60,
        radius: 5,
        storedInChamberId: granary.id,
      });
    } else {
      const smallest = piles.reduce((a, b) => (a.amount < b.amount ? a : b));
      smallest.amount = Math.min(smallest.maxAmount + 20, smallest.amount + ant.payloadValue);
    }
    ant.payload = PayloadType.NONE;
    ant.payloadValue = 0;
    ant.hunger = Math.max(0, ant.hunger - 8);
    if (ant.recruitFoodPos && (ant.signalCooldown ?? 0) <= 0) {
      // waggle and antennate nestmates to recruit them to the find
      ant.signalCooldown = 10;
      const rp = ant.recruitFoodPos;
      let recruited = 0;
      this.forAntsNear(ant.x, ant.y, 70, (mate) => {
        if (mate.caste === AntCaste.WORKER && mate.id !== ant.id && mate.payload === PayloadType.NONE && !mate.recruitFoodPos && !BUSY_TASKS.has(mate.task)) {
          mate.recruitFoodPos = { x: rp.x, y: rp.y };
          mate.task = AntTask.FOLLOWING_FOOD_TRAIL;
          recruited++;
        }
        return recruited >= 6;
      });
      this.busy(ant, AntTask.SIGNALING_FOOD, 1.6);
    } else {
      ant.task = AntTask.FORAGING_SCOUT;
      this.stopMoving(ant);
    }
  }

  /** Lowest open point beneath a spot inside a chamber (so piles and brood rest on the floor). */
  private chamberFloorY(c: Chamber, x: number): number {
    const gx = clamp(Math.floor(x / CELL_SIZE), 0, GRID_W - 1);
    let gy = Math.floor(c.y / CELL_SIZE);
    while (gy < GRID_H - 2 && !this.grid.isSolid(gx, gy + 1) && gy * CELL_SIZE < c.y + c.ry + 12) gy++;
    return (gy + 1) * CELL_SIZE;
  }

  private takeFromStore(ant: Ant, amount: number): FoodSource | null {
    let best: FoodSource | null = null;
    let bestD = 60;
    for (const f of this.foods) {
      if (f.storedInChamberId === null || f.amount < 1) continue;
      const d = Math.abs(f.x - ant.x) + Math.abs(f.y - ant.y);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) return null;
    const take = Math.min(best.amount, amount);
    best.amount -= take;
    this.storedFoodCache -= take;
    return best;
  }

  private goEat(ant: Ant): void {
    ant.task = AntTask.STORING_FOOD;
    const d = this.go(ant, 'store');
    if (d <= 0.5 || d >= INF) {
      const src = this.takeFromStore(ant, 4);
      if (src) {
        ant.hunger = Math.max(0, ant.hunger - 55);
        ant.energy = Math.min(100, ant.energy + 30);
        this.busy(ant, AntTask.EATING, 1.5);
      } else ant.hunger = Math.max(0, ant.hunger - 5); // nibble crumbs, try again later
    }
  }

  private carryRefuse(ant: Ant): void {
    ant.task = AntTask.NECROPHORESIS;
    const d = this.go(ant, 'midden');
    if (d <= 0.5 || (this.isOutside(ant.x, ant.y) && Math.abs(ant.x - this.middenPos.x) < 26)) {
      const fa = this.fallenAnts.find((f) => f.id === ant.payloadId);
      if (fa) {
        fa.carriedByAntId = null;
        fa.atMidden = true;
        fa.x = this.middenPos.x + (Math.random() - 0.5) * 22;
        fa.y = this.surfaceTarget(fa.x).y + 1;
      }
      ant.payload = PayloadType.NONE;
      ant.payloadId = null;
      ant.task = AntTask.FORAGING_SCOUT;
      this.stopMoving(ant);
    }
  }

  private seekRest(ant: Ant, k: FieldKey, nap: number): void {
    ant.task = AntTask.SEEKING_REST;
    const d = this.go(ant, k);
    if (d <= 0.5 || d >= INF) this.busy(ant, AntTask.IDLE, nap);
  }

  // --- nurses -----------------------------------------------------------------------------------------------------

  private nurseryStageX(c: Chamber, stage: BroodStage, id: number): number {
    const off = stage === BroodStage.EGG ? -0.45 : stage === BroodStage.PUPA ? 0.45 : 0;
    return c.x + c.rx * off + (((id * 37) % 100) / 100 - 0.5) * c.rx * 0.35;
  }

  private stepNurse(ant: Ant, dt: number): void {
    const queen = this.getQueen();

    // 1. carrying brood to the nursery
    if (isBroodPayload(ant.payload)) {
      ant.task = AntTask.MOVING_BROOD;
      const b = this.brood.find((br) => br.id === ant.payloadId);
      if (!b) {
        ant.payload = PayloadType.NONE;
        ant.payloadId = null;
        return;
      }
      const ch = this.bestNursery(ant);
      if (!ch) return;
      if (this.isInsideChamber(ant, ch, 0.85)) {
        const sx = this.nurseryStageX(ch, b.stage, b.id);
        if (Math.abs(ant.x - sx) > 7) this.goTo(ant, sx, ch.y + ch.ry * 0.3);
        else {
          b.carriedByAntId = null;
          b.chamberId = ch.id;
          b.x = ant.x + Math.cos(ant.angle) * 5;
          b.y = ant.y;
          ant.payload = PayloadType.NONE;
          ant.payloadId = null;
          ant.targetId = null;
          this.busy(ant, AntTask.GROOMING, 0.8);
        }
      } else this.goPath(ant, ch.x, ch.y + ch.ry * 0.3, 'chamber:' + ch.id);
      return;
    }

    // 2. carrying food for a larva or the queen
    if (isFoodPayload(ant.payload)) {
      const isQueenRun = queen && ant.targetId === queen.id;
      if (isQueenRun && queen) {
        ant.task = AntTask.TENDING_QUEEN;
        if (Math.hypot(queen.x - ant.x, queen.y - ant.y) < 15) {
          queen.hunger = Math.max(0, queen.hunger - ant.payloadValue * 11);
          this.counters.queenFeeds++;
          ant.payload = PayloadType.NONE;
          ant.payloadValue = 0;
          ant.targetId = null;
          this.busy(ant, AntTask.TROPHALLAXIS, 2);
          ant.trophallaxisPartnerId = queen.id;
          queen.task = AntTask.TROPHALLAXIS;
          queen.stateTimer = 2;
          queen.trophallaxisPartnerId = ant.id;
          return;
        }
        const royal = this.nearestChamber(ChamberType.ROYAL, queen.x, queen.y);
        if (royal && this.isInsideChamber(ant, royal, 1.0)) this.goTo(ant, queen.x, queen.y);
        else this.go(ant, 'royal');
        return;
      }
      let larva = this.brood.find((b) => b.id === ant.targetId && b.stage === BroodStage.LARVA && b.carriedByAntId === null);
      if (!larva || larva.nutrition > 85) {
        larva = this.hungriestLarva(ant, 85) ?? undefined;
        ant.targetId = larva ? larva.id : null;
      }
      if (!larva) {
        // nobody needs it any more: eat it
        ant.hunger = Math.max(0, ant.hunger - ant.payloadValue * 8);
        ant.payload = PayloadType.NONE;
        ant.payloadValue = 0;
        return;
      }
      ant.task = AntTask.FEEDING_LARVA;
      if (Math.hypot(larva.x - ant.x, larva.y - ant.y) < 9) {
        // regurgitate just what this larva needs, keep the rest for its neighbours
        this.counters.larvaFeeds++;
        const give = Math.min(ant.payloadValue, Math.max(1, Math.ceil((100 - larva.nutrition) / 12)));
        larva.nutrition = Math.min(100, larva.nutrition + give * 12);
        ant.payloadValue -= give;
        if (ant.payloadValue <= 0.01) {
          ant.payload = PayloadType.NONE;
          ant.payloadValue = 0;
        }
        ant.targetId = null;
        this.busy(ant, AntTask.GROOMING, 1.3);
        return;
      }
      this.approachBrood(ant, larva);
      return;
    }

    // 3. continue an errand already claimed
    if (ant.targetId != null) {
      if (queen && ant.targetId === queen.id) {
        this.fetchFood(ant, AntTask.TENDING_QUEEN);
        return;
      }
      const b = this.brood.find((br) => br.id === ant.targetId);
      if (!b || b.carriedByAntId !== null) ant.targetId = null;
      else if (b.stage === BroodStage.LARVA && b.nutrition < 75 && this.inNursery(b)) {
        this.fetchFood(ant, AntTask.FEEDING_LARVA);
        return;
      } else if (!this.inNursery(b)) {
        ant.task = AntTask.MOVING_BROOD;
        if (Math.hypot(b.x - ant.x, b.y - ant.y) < 9) {
          b.carriedByAntId = ant.id;
          ant.payloadId = b.id;
          ant.payload = b.stage === BroodStage.EGG ? PayloadType.EGG : b.stage === BroodStage.LARVA ? PayloadType.LARVA : PayloadType.PUPA;
          this.stopMoving(ant);
        } else this.approachBrood(ant, b);
        return;
      } else ant.targetId = null;
    }

    // 4. choose a new errand
    const stray = this.brood.find((b) => b.carriedByAntId === null && !this.claimedBrood.has(b.id) && !this.inNursery(b) && (b.stage !== BroodStage.EGG || b.progress > 4));
    if (stray && this.bestNursery(ant)) {
      ant.targetId = stray.id;
      this.claimedBrood.add(stray.id);
      return;
    }
    if (queen && queen.hunger > 55 && this.queenFeederId === null && this.storedFoodCache > 3) {
      ant.targetId = queen.id;
      this.queenFeederId = ant.id;
      return;
    }
    if (this.storedFoodCache > 3) {
      const hungriest = this.hungriestLarva(ant, 70);
      if (hungriest) {
        ant.targetId = hungriest.id;
        this.claimedBrood.add(hungriest.id);
        return;
      }
    }
    if (ant.hunger > 70 && this.storedFoodCache > 3) {
      this.goEat(ant);
      return;
    }

    // 5. idle care: groom brood (pupae near eclosion get the most attention), attend the queen, or rest
    ant.stateTimer -= dt;
    if (ant.stateTimer > 0 && (ant.path.length > 0 || ant.targetPos)) return;
    ant.stateTimer = 3 + Math.random() * 3;
    const r = Math.random();
    if (r < 0.5 && this.brood.length > 0) {
      const pool = this.brood.filter((b) => b.carriedByAntId === null && this.inNursery(b));
      if (pool.length > 0) {
        const b = pool.reduce((best, c) => (c.stage === BroodStage.PUPA && c.progress > best.progress ? c : best), pool[Math.floor(Math.random() * pool.length)]);
        ant.task = AntTask.FEEDING_LARVA;
        if (Math.hypot(b.x - ant.x, b.y - ant.y) < 10) this.busy(ant, AntTask.GROOMING, 1.2 + Math.random());
        else this.approachBrood(ant, b);
        return;
      }
    }
    if ((r < 0.8 || (queen && queen.hunger > 40)) && queen) {
      ant.task = AntTask.TENDING_QUEEN;
      const royal = this.nearestChamber(ChamberType.ROYAL, queen.x, queen.y);
      if (royal && this.isInsideChamber(ant, royal, 1.0)) {
        if (Math.hypot(queen.x - ant.x, queen.y - ant.y) < 18) {
          if (queen.hunger > 20 && ant.hunger < 60 && queen.task !== AntTask.LAYING_EGG) {
            // the retinue feeds the queen mouth-to-mouth from their own crop
            this.counters.queenFeeds++;
            queen.hunger = Math.max(0, queen.hunger - 30);
            ant.hunger = Math.min(100, ant.hunger + 15);
            this.busy(ant, AntTask.TROPHALLAXIS, 1.8);
            ant.trophallaxisPartnerId = queen.id;
            queen.task = AntTask.TROPHALLAXIS;
            queen.stateTimer = 1.8;
            queen.trophallaxisPartnerId = ant.id;
          } else this.busy(ant, AntTask.GROOMING, 1.5 + Math.random() * 1.5);
        } else this.goTo(ant, queen.x + Math.cos(ant.id) * 14, queen.y);
      } else this.go(ant, 'royal');
      return;
    }
    this.seekRest(ant, 'nursery', 4 + Math.random() * 8);
  }

  /** Most underfed unclaimed larva (ties broken by distance). */
  private hungriestLarva(ant: Ant, below: number): BroodItem | null {
    let best: BroodItem | null = null;
    let bestScore = Infinity;
    for (const b of this.brood) {
      if (b.stage !== BroodStage.LARVA || b.carriedByAntId !== null || this.claimedBrood.has(b.id) || b.nutrition > below) continue;
      const score = b.nutrition * 4 + Math.abs(b.x - ant.x) + Math.abs(b.y - ant.y);
      if (score < bestScore) {
        bestScore = score;
        best = b;
      }
    }
    if (best) this.claimedBrood.add(best.id);
    return best;
  }

  private fetchFood(ant: Ant, label: AntTask): void {
    ant.task = label;
    const d = this.go(ant, 'store');
    if (d <= 0.5 || d >= INF) {
      const src = this.takeFromStore(ant, 9);
      if (src) {
        ant.payload = src.type;
        ant.payloadValue = 9;
        ant.pauseTimer = 0.5;
        this.stopMoving(ant);
      } else ant.targetId = null;
    }
  }

  private inNursery(b: BroodItem): boolean {
    const c = this.chambers.find((ch) => ch.id === b.chamberId);
    if (!c || c.type !== ChamberType.NURSERY) return false;
    return Math.abs(b.x - c.x) < c.rx + 6 && Math.abs(b.y - c.y) < c.ry + 10;
  }

  private bestNursery(ant: Ant): Chamber | undefined {
    // prefer the nearest nursery that isn't crowded
    let best: Chamber | undefined;
    let bestScore = Infinity;
    for (const c of this.chambers) {
      if (c.type !== ChamberType.NURSERY) continue;
      const load = this.brood.reduce((n, b) => n + (b.chamberId === c.id ? 1 : 0), 0);
      const score = Math.hypot(c.x - ant.x, c.y - ant.y) + load * 12;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  /** Reach a brood item: by flow field to its chamber, then straight to it. */
  private approachBrood(ant: Ant, b: BroodItem): void {
    const c = this.chambers.find((ch) => ch.id === b.chamberId);
    if (c && this.isInsideChamber(ant, c, 1.0)) {
      this.goTo(ant, b.x, b.y);
      return;
    }
    if (Math.hypot(b.x - ant.x, b.y - ant.y) < 30) {
      this.goTo(ant, b.x, b.y);
      return;
    }
    this.goPath(ant, b.x, b.y, 'brood:' + b.id);
  }

  // --- excavators -------------------------------------------------------------------------------------------------

  private stepExcavator(ant: Ant, dt: number): void {
    if (ant.payload === PayloadType.SOIL) {
      ant.task = AntTask.CARRYING_SOIL;
      const d = this.go(ant, 'mound');
      const cell = this.grid.worldToGrid(ant.x, ant.y);
      if (d <= 2.5 && this.grid.terrain[this.grid.idx(cell.gx, cell.gy)] === CellType.AIR) {
        this.counters.deposits++;
        for (let k = 0; k < Math.max(1, ant.payloadValue); k++) this.depositSoil(ant.x + (k % 2 === 0 ? 0 : (ant.x >= this.entrancePos.x ? 6 : -6)));
        ant.payload = PayloadType.NONE;
        ant.payloadValue = 0;
        ant.pauseTimer = 0.3 + Math.random() * 0.3;
        ant.task = AntTask.EXCAVATING;
        this.stopMoving(ant);
      } else if (d >= INF) {
        // walled in (a collapse cut the way out): wait for the diggers to reopen it
        ant.pauseTimer = 1;
      }
      return;
    }
    if (ant.payload !== PayloadType.NONE) {
      this.releasePayload(ant);
      return;
    }
    if (ant.hunger > 72 && this.storedFoodCache > 3) {
      this.goEat(ant);
      return;
    }
    if (this.planCount + this.repairCount === 0 && ant.payloadValue > 0) {
      ant.payload = PayloadType.SOIL;
      return;
    }
    if (this.planCount + this.repairCount === 0) {
      // nothing to dig: tend the fungus garden for a while
      const d = this.go(ant, 'fungus');
      ant.task = AntTask.SEEKING_REST;
      if (d <= 0.5 || d >= INF) this.busy(ant, Math.random() < 0.6 ? AntTask.TENDING_FUNGUS : AntTask.IDLE, 5 + Math.random() * 6);
      return;
    }
    const d = this.go(ant, 'dig');
    ant.task = this.repairCount > 0 ? AntTask.REPAIRING : AntTask.EXCAVATING;
    if (d >= INF) {
      ant.task = AntTask.EXCAVATING;
      return;
    }
    if (d > 0.5 && !(ant.path.length === 0 && d < 30)) return;
    // at the dig face: choose an adjacent planned cell
    const g = this.grid.worldToGrid(ant.x, ant.y);
    let pick = -1;
    let pickLevel = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const gx = g.gx + ox;
        const gy = g.gy + oy;
        if (!this.grid.inBounds(gx, gy)) continue;
        const i = this.grid.idx(gx, gy);
        const lvl = this.digPlan[i];
        if (!lvl || !this.canExcavate(i) || this.claimedDig.has(i)) continue;
        if (lvl > pickLevel || (lvl === pickLevel && Math.random() < 0.5)) {
          pick = i;
          pickLevel = lvl;
        }
      }
    }
    if (pick < 0) {
      // stale field (someone else dug here): look again shortly
      this.fieldDirty.dig = true;
      if (d <= 0.5) ant.pauseTimer = 0.4;
      return;
    }
    ant.digIdx = pick;
    this.claimedDig.add(pick);
    ant.task = pickLevel === 2 ? AntTask.REPAIRING : AntTask.EXCAVATING;
    const px = (pick % GRID_W) + 0.5;
    const py = Math.floor(pick / GRID_W) + 0.5;
    ant.angle = Math.atan2(py * CELL_SIZE - ant.y, px * CELL_SIZE - ant.x);
    ant.stateTimer = 1.1 + Math.random() * 1.0;
    this.stopMoving(ant);
    // keep the EXCAVATING label while chewing so the renderer animates the mandibles
    ant.task = AntTask.EXCAVATING;
  }

  private finishDig(ant: Ant): void {
    const i = ant.digIdx ?? -1;
    ant.digIdx = -1;
    ant.task = AntTask.EXCAVATING;
    if (i < 0 || !this.digPlan[i] || !this.canExcavate(i)) {
      if (ant.payloadValue > 0) ant.payload = PayloadType.SOIL;
      return;
    }
    const gx = i % GRID_W;
    const gy = (i - gx) / GRID_W;
    const wasRepair = this.digPlan[i] === 2;
    this.grid.setTerrain(gx, gy, CellType.TUNNEL);
    this.digPlan[i] = 0;
    if (wasRepair) this.repairCount = Math.max(0, this.repairCount - 1);
    else this.planCount = Math.max(0, this.planCount - 1);
    this.tunnelsDugCells++;
    this.counters.digs++;
    this.grid.updateSurfaceColumn(gx);
    this.fieldDirty.dig = true;
    ant.payloadValue += 1;
    // a forager-sized pellet is small: chew out a second cell before making the trip up to the mound
    if (ant.payloadValue >= 2 || this.planCount + this.repairCount <= 1) ant.payload = PayloadType.SOIL;
    const w = this.grid.gridToWorld(gx, gy);
    this.spawnCrumbs(w.x, w.y, '#7c5836', 3);
    if (wasRepair && this.repairCount === 0) this.log('Storm damage repaired', 'good');
  }

  /** Drop a pellet of soil on the mound; it rolls down until the slope is stable (angle of repose). */
  /** The undisturbed ground height the world was generated with (before any mound was built). */
  private naturalGroundY(wx: number): number {
    const gx = clamp(Math.floor(wx / CELL_SIZE), 0, GRID_W - 1);
    if (this.baseGround) return this.baseGround[gx];
    return SURFACE_BASE_Y + Math.sin(wx * 0.0065) * 13 + Math.cos(wx * 0.017) * 6 + Math.sin(wx * 0.041) * 2.5;
  }

  private depositSoil(worldX: number): void {
    // all spoil goes on the main mound; the side entrance is kept as a plain hole
    const ex = this.entrancePos.x;
    const crater = CRATER_MAIN;
    const outward = worldX >= ex ? 1 : -1;
    const minGx = Math.floor((CASE_LEFT + 40) / CELL_SIZE);
    const maxGx = Math.floor((CASE_RIGHT - 40) / CELL_SIZE);
    // the mound may roof over the flared mouth of the shaft; only the central hole itself stays open
    const inCrater = (gx: number) => Math.abs((gx + 0.5) * CELL_SIZE - ex) < crater;
    let gx = clamp(Math.floor(worldX / CELL_SIZE), minGx, maxGx);
    for (let k = 0; k < 20 && inCrater(gx); k++) gx += outward;
    const maxHeightCells = Math.min(17, 6 + Math.floor(Math.sqrt(this.soilDeposited) * 0.5));
    // the mound spreads wider as it grows
    const falloff = 0.07 * (400 / (400 + this.soilDeposited));
    let settled = false;
    let rolledOut = false;
    for (let step = 0; step < 60; step++) {
      const top = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
      const baseTop = Math.floor(this.naturalGroundY((gx + 0.5) * CELL_SIZE) / CELL_SIZE);
      const outTop = Math.floor(this.grid.surfaceY[clamp(gx + outward, minGx, maxGx)] / CELL_SIZE);
      const inTop = Math.floor(this.grid.surfaceY[clamp(gx - outward, minGx, maxGx)] / CELL_SIZE);
      // the allowed height falls away from the hole, so the top of the mound is a rounded dome, not a mesa
      const distCols = Math.max(0, Math.abs((gx + 0.5) * CELL_SIZE - ex) - crater) / CELL_SIZE;
      const cap = Math.max(1, maxHeightCells - Math.floor(distCols * distCols * falloff));
      const tooTall = baseTop - top >= cap;
      // a pellet first fills any hollow toward the hole (the flared funnel), then rolls down the outer flank while
      // the next column is lower: the mound settles into a cone around a narrow entrance
      if (!rolledOut && !tooTall && inTop - top >= 1 && !inCrater(gx - outward)) gx -= outward;
      // a one-cell step is stable (angle of repose); a pellet only tumbles down a steeper drop
      else if ((outTop - top >= 2 || tooTall) && gx + outward >= minGx && gx + outward <= maxGx) {
        gx += outward;
        rolledOut = true;
      }
      else {
        settled = true;
        break;
      }
    }
    if (!settled && Math.abs((gx + 0.5) * CELL_SIZE - ex) > 260) return; // spread too thin to notice
    const surfGy = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
    const placeGy = surfGy - 1;
    if (placeGy <= Math.floor((CASE_TOP + 64) / CELL_SIZE)) return;
    if (this.grid.terrain[this.grid.idx(gx, placeGy)] !== CellType.AIR) return;
    this.grid.setTerrain(gx, placeGy, CellType.SUBSOIL);
    this.grid.updateSurfaceColumn(gx);
    this.evictFrom(gx, placeGy);
    this.soilDeposited++;
    this.raiseEntranceShaft(ex, crater);
    if (this.soilDeposited % 150 === 0) this.log(`The mound keeps growing (${this.soilDeposited} loads of soil)`, 'good');
    this.spawnCrumbs((gx + 0.5) * CELL_SIZE, this.grid.surfaceY[gx] - 3, '#8c623d', 3);
  }

  /**
   * As the mound rises around the hole, extend the entrance shaft up through it (an ant hill's entrance is a tunnel
   * running up through the mound, not an open pit). Shaft cells are open tunnel, so ants climb them freely and
   * surface walkers can step across the top of the hole.
   */
  private raiseEntranceShaft(ex: number, crater: number): void {
    const g0 = Math.floor((ex - crater) / CELL_SIZE);
    const g1 = Math.floor((ex + crater) / CELL_SIZE);
    const leftTop = Math.floor(this.grid.surfaceY[g0 - 1] / CELL_SIZE);
    const rightTop = Math.floor(this.grid.surfaceY[g1 + 1] / CELL_SIZE);
    const rimGy = Math.max(leftTop, rightTop);
    for (let gx = g0; gx <= g1; gx++) {
      for (let gy = rimGy; gy < GRID_H - 2; gy++) {
        const i = this.grid.idx(gx, gy);
        const t = this.grid.terrain[i];
        if (t === CellType.AIR) this.grid.setTerrain(gx, gy, CellType.TUNNEL);
        else break;
      }
      this.grid.updateSurfaceColumn(gx);
    }
  }

  // --- soldiers ---------------------------------------------------------------------------------------------------

  private stepSoldier(ant: Ant, dt: number, night: boolean): void {
    if (ant.hunger > 72 && this.storedFoodCache > 3) {
      this.goEat(ant);
      return;
    }
    const onSurface = this.isOutside(ant.x, ant.y);
    const guard = ant.id % 3 !== 0 && !(night && ant.id % 2 === 0);
    ant.task = AntTask.PATROLLING;
    ant.stateTimer -= dt;
    if (guard) {
      if (!onSurface) {
        if (this.go(ant, 'surface') >= INF) this.seekRest(ant, 'royal', 8);
        return;
      }
      if (ant.stateTimer <= 0 || !ant.targetPos) {
        ant.stateTimer = 3 + Math.random() * 4;
        const side = (ant.id % 2 === 0 ? 1 : -1) * (CRATER_MAIN + 20 + Math.random() * 70);
        const t = this.surfaceTarget(this.entrancePos.x + side);
        this.goTo(ant, t.x, t.y);
        if (Math.random() < 0.2) ant.pauseTimer = 1 + Math.random() * 2;
      }
      return;
    }
    const royal = this.nearestChamber(ChamberType.ROYAL, ant.x, ant.y);
    if (!royal) return;
    if (!this.isInsideChamber(ant, royal, 1.0)) {
      this.go(ant, 'royal');
      return;
    }
    if (ant.stateTimer <= 0 || !ant.targetPos) {
      ant.stateTimer = 3 + Math.random() * 3;
      if (Math.random() < 0.35) this.busy(ant, AntTask.IDLE, 4 + Math.random() * 6);
      else this.goTo(ant, royal.x + (Math.random() - 0.5) * royal.rx * 1.4, royal.y + (Math.random() - 0.2) * royal.ry * 0.6);
    }
  }

  // ================================================================================================================
  // Helpers kept from the original locomotion model
  // ================================================================================================================

  private nearestChamber(type: ChamberType, x: number, y: number): Chamber | undefined {
    let best: Chamber | undefined;
    let bestD = Infinity;
    for (const c of this.chambers) {
      if (c.type !== type) continue;
      const d = Math.abs(c.x - x) + Math.abs(c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /** Out in the open air above ground (as opposed to inside a tunnel), including over the entrance holes. */
  public isOutside(x: number, y: number): boolean {
    const g = this.grid.worldToGrid(x, y);
    return this.grid.terrain[this.grid.idx(g.gx, g.gy)] === CellType.AIR;
  }

  public isOnExteriorSurface(x: number, y: number): boolean {
    const g = this.grid.worldToGrid(x, y);
    const t = this.grid.terrain[this.grid.idx(g.gx, g.gy)];
    const b1 = Math.min(GRID_H - 1, g.gy + 1);
    const b2 = Math.min(GRID_H - 1, g.gy + 2);
    const overTunnel =
      this.grid.terrain[this.grid.idx(g.gx, b1)] === CellType.TUNNEL ||
      this.grid.terrain[this.grid.idx(g.gx, b2)] === CellType.TUNNEL;
    return (
      t === CellType.AIR &&
      !overTunnel &&
      Math.abs(x - this.entrancePos.x) > 36 &&
      Math.abs(x - 405) > 26 &&
      y <= this.grid.surfaceY[g.gx] + 6
    );
  }

  private isInsideChamber(ant: Ant, c: Chamber, radiusFrac: number): boolean {
    const dx = (ant.x - c.x) / c.rx;
    const dy = (ant.y - c.y) / c.ry;
    return dx * dx + dy * dy < radiusFrac;
  }

  private updatePace(ant: Ant, dt: number, turnErr: number): number {
    let target: number;
    if ((ant.pauseTimer ?? 0) > 0) {
      ant.pauseTimer = (ant.pauseTimer ?? 0) - dt;
      target = 0;
    } else {
      let base = 0.9;
      let pauseRate = 0;
      switch (ant.task) {
        case AntTask.FORAGING_SCOUT:
          base = 0.82;
          pauseRate = 0.22;
          break;
        case AntTask.PATROLLING:
          base = 0.7;
          pauseRate = 0.3;
          break;
        case AntTask.EXCAVATING:
          base = 0.72;
          pauseRate = 0.2;
          break;
        case AntTask.MOVING_BROOD:
        case AntTask.FEEDING_LARVA:
        case AntTask.TENDING_QUEEN:
          base = 0.85;
          pauseRate = 0.1;
          break;
        case AntTask.DEFENDING:
        case AntTask.FLEEING:
          base = 1.15;
          break;
        case AntTask.FOLLOWING_FOOD_TRAIL:
          base = 1.0;
          break;
        case AntTask.RETURNING_WITH_FOOD:
          base = 0.95;
          break;
        default:
          break;
      }
      const ebb = 1 + 0.16 * Math.sin(this.simTime * (0.9 + (ant.id % 7) * 0.13) + ant.id * 1.9);
      target = base * ebb;
      if (pauseRate > 0 && ant.payload === PayloadType.NONE && Math.random() < pauseRate * dt) {
        ant.pauseTimer = 0.25 + Math.random() * 0.9;
      }
    }
    target *= 1 - 0.5 * Math.min(1, turnErr / (Math.PI * 0.6));
    const cur = ant.pace ?? 1;
    ant.pace = cur + (target - cur) * Math.min(1, dt * (target > cur ? 6 : 10));
    return ant.pace;
  }

  /**
   * If the ant is blocked by a wall in its direction of travel and the face is climbable (open space overhead
   * and an open cell beside the wall top within `MAX_CLIMB_CELLS`), returns the y to crawl up to; else null.
   */
  private findFaceClimb(
    ant: Ant,
    stepDist: number,
    moveTarget: Vec2 | null,
    isOpen: (px: number, py: number) => boolean
  ): number | null {
    const MAX_CLIMB_CELLS = 3;
    // Don't climb away from a goal that is mostly *below* us (e.g. a path heading down a shaft);
    // a goal that is mostly sideways with a wall in between is exactly when we should climb.
    if (moveTarget) {
      const dy = moveTarget.y - ant.y;
      if (dy > CELL_SIZE && dy > Math.abs(moveTarget.x - ant.x)) return null;
    }
    const heading = Math.cos(ant.angle);
    if (Math.abs(heading) < 0.25) return null; // mostly vertical travel: normal vertical logic handles it
    const dirX = heading >= 0 ? 1 : -1;
    const cg = this.grid.worldToGrid(ant.x, ant.y);
    const openCell = (gx: number, gy: number) => !this.grid.isSolid(gx, gy) && this.grid.isNavigable(gx, gy);
    // the wall must really be right ahead of us
    if (openCell(cg.gx + dirX, cg.gy)) return null;
    for (let k = 1; k <= MAX_CLIMB_CELLS; k++) {
      if (!openCell(cg.gx, cg.gy - k)) return null; // blocked overhead: not a climbable face
      if (openCell(cg.gx + dirX, cg.gy - k)) {
        const climbY = ant.y - Math.max(2.6, stepDist * 1.1);
        return isOpen(ant.x, climbY) ? climbY : null;
      }
    }
    return null;
  }

  private moveAnt(ant: Ant, dt: number): void {
    let moveTarget: Vec2 | null = null;
    const followingPath = ant.path.length > 0 && ant.pathIndex < ant.path.length;

    if (followingPath) {
      moveTarget = ant.path[ant.pathIndex];
      if (Math.hypot(moveTarget.x - ant.x, moveTarget.y - ant.y) < 4.5) {
        ant.pathIndex++;
        if (ant.pathIndex >= ant.path.length) {
          ant.path = [];
          moveTarget = null;
        } else {
          moveTarget = ant.path[ant.pathIndex];
        }
      }
    } else if (ant.targetPos) {
      moveTarget = ant.targetPos;
      if (Math.hypot(moveTarget.x - ant.x, moveTarget.y - ant.y) < 7) {
        ant.targetPos = null;
      }
    }

    if (moveTarget) {
      ant.targetAngle = Math.atan2(moveTarget.y - ant.y, moveTarget.x - ant.x);
    } else {
      ant.targetAngle += (Math.random() - 0.5) * 1.4 * dt;
    }

    const wanderScale = followingPath ? 0.1 : 1.0;
    // two incommensurate sine weaves: ants never walk ruler-straight
    const wander =
      (Math.sin(this.simTime * 3.1 + ant.id * 1.7) * 0.22 + Math.sin(this.simTime * 1.3 + ant.id * 0.9) * 0.1) *
      wanderScale;
    const turnRate = followingPath ? 14.0 : 7.5;
    const turnErr = Math.abs(wrapAngle(ant.targetAngle + wander - ant.angle));
    ant.angle = lerpAngle(ant.angle, ant.targetAngle + wander, Math.min(1, dt * turnRate));

    const speedFactor = ant.payload !== PayloadType.NONE ? 0.84 : 1.0;
    const pace = this.updatePace(ant, dt, turnErr);
    // Rolling around a tunnel corner onto the back wall is a much longer walk in 3D than in the 2D sim: slow down to match.
    const stepDist = (ant.speed * speedFactor * pace * dt) / clamp(ant.surfaceStretch ?? 1, 1, 3.5);

    let nx = ant.x + Math.cos(ant.angle) * stepDist;
    let ny = ant.y + Math.sin(ant.angle) * stepDist;

    const isOpen = (px: number, py: number) => {
      const g = this.grid.worldToGrid(px, py);
      return !this.grid.isSolid(g.gx, g.gy) && this.grid.isNavigable(g.gx, g.gy);
    };

    let climbing = false;
    if (!isOpen(nx, ny)) {
      const gStepUp = this.grid.worldToGrid(nx, ant.y - CELL_SIZE);
      const stepUpY = Math.min(ant.y - Math.max(2.4, stepDist * 1.25), (gStepUp.gy + 0.78) * CELL_SIZE);
      const stepUp2Y = ant.y - CELL_SIZE * 1.35;
      const straightUpY = ant.y - Math.max(2.6, stepDist * 1.25);

      // Real ants scale vertical faces. If a wall blocks the way forward and its top is within a few cells,
      // crawl up it. (Sliding along a wall we are heading straight into means "don't move" - that is how
      // ants used to freeze at the foot of soil mounds.)
      const climbY = this.findFaceClimb(ant, stepDist, moveTarget, isOpen);
      if (climbY !== null) {
        nx = ant.x;
        ny = climbY;
        climbing = true;
      } else if (isOpen(nx, ant.y)) {
        ny = ant.y;
      } else if (isOpen(ant.x, ny)) {
        nx = ant.x;
      } else if (isOpen(nx, stepUpY)) {
        ny = stepUpY;
      } else if (isOpen(nx, stepUp2Y)) {
        ny = stepUp2Y;
      } else if (moveTarget && moveTarget.y < ant.y - 1 && isOpen(ant.x, straightUpY)) {
        // Climb vertically inside the entrance throat until clearing the crater shoulder
        nx = ant.x;
        ny = straightUpY;
      } else {
        const ng = this.grid.worldToGrid(nx, ny);
        const surfY = this.grid.surfaceY[clamp(ng.gx, 0, GRID_W - 1)];
        if (ant.y <= surfY + 24 && Math.abs(ny - surfY) < 28 && isOpen(nx, surfY - 2.5)) {
          ny = Math.max(surfY - 2.5, ant.y - Math.max(2.8, stepDist * 1.35));
          if (!isOpen(nx, ny)) {
            nx = ant.x;
          }
        } else {
          const currG = this.grid.worldToGrid(ant.x, ant.y);
          const openAngles: number[] = [];
          for (let oy = -1; oy <= 1; oy++) {
            for (let ox = -1; ox <= 1; ox++) {
              if (ox === 0 && oy === 0) continue;
              if (!this.grid.isSolid(currG.gx + ox, currG.gy + oy) && this.grid.isNavigable(currG.gx + ox, currG.gy + oy)) {
                openAngles.push(Math.atan2(oy, ox));
              }
            }
          }
          if (openAngles.length > 0) {
            if (moveTarget) {
              const desired = Math.atan2(moveTarget.y - ant.y, moveTarget.x - ant.x);
              let bestA = openAngles[0];
              let bestDiff = Math.abs(wrapAngle(bestA - desired));
              for (let i = 1; i < openAngles.length; i++) {
                const diff = Math.abs(wrapAngle(openAngles[i] - desired));
                if (diff < bestDiff) {
                  bestDiff = diff;
                  bestA = openAngles[i];
                }
              }
              ant.angle = bestA;
            } else {
              ant.angle = openAngles[Math.floor(Math.random() * openAngles.length)];
            }
          } else {
            ant.angle = wrapAngle(ant.angle + Math.PI);
          }
          nx = ant.x;
          ny = ant.y;
          if (!moveTarget) {
            ant.targetPos = null;
          }
        }
      }
    }

    const finalG = this.grid.worldToGrid(nx, ny);
    const cellT = this.grid.terrain[this.grid.idx(finalG.gx, finalG.gy)];
    if (cellT === CellType.AIR) {
      const surfY = this.grid.surfaceY[finalG.gx];
      const belowT = this.grid.inBounds(finalG.gx, finalG.gy + 1)
        ? this.grid.terrain[this.grid.idx(finalG.gx, finalG.gy + 1)]
        : CellType.AIR;
      // Only seat walkers onto surface contour when roaming freely (never pull down an active A* climb out of a tunnel)
      // (not while scaling a face: the column we are in is lower than the wall we are climbing)
      if (climbing) {
        // keep the climb height
      } else if (ant.path.length === 0 && belowT !== CellType.TUNNEL && ny <= surfY + 3) {
        ny = surfY - 1.5;
      } else if (ny < surfY - 14 && !this.grid.isNavigable(finalG.gx, finalG.gy)) {
        // floating in open air (not clinging to a wall or mound face): settle back onto the ground
        ny = surfY - 2.0;
      }
    }

    const prevX = ant.x;
    const prevY = ant.y;
    const moved = Math.hypot(nx - prevX, ny - prevY);
    ant.x = clamp(nx, CASE_LEFT + 14, CASE_RIGHT - 14);
    ant.y = clamp(ny, CASE_TOP + 14, CASE_BOTTOM - 14);

    const checkG = this.grid.worldToGrid(ant.x, ant.y);
    if (this.grid.isSolid(checkG.gx, checkG.gy) || !this.grid.isNavigable(checkG.gx, checkG.gy)) {
      if (isOpen(prevX, prevY)) {
        ant.x = prevX;
        ant.y = prevY;
      } else {
        const safe =
          this.grid.findNearestNavigable(checkG.gx, checkG.gy, 6) ??
          this.grid.findNearestNavigable(checkG.gx, checkG.gy, 24);
        if (safe) {
          const w = this.grid.gridToWorld(safe.gx, safe.gy);
          ant.x = w.x;
          ant.y = w.y;
          ant.path = [];
        }
      }
    }

    ant.vx = (ant.x - prevX) / Math.max(0.001, dt);
    ant.vy = (ant.y - prevY) / Math.max(0.001, dt);
    ant.gaitPhase += moved * 0.95;

    if (pace < 0.25) {
      ant.stuckTimer = 0; // deliberately stopped, not stuck
    } else if (Math.hypot(ant.x - ant.prevX, ant.y - ant.prevY) < 0.3 * dt * 20) {
      ant.stuckTimer += dt;
      if (ant.stuckTimer > 0.8) {
        const hadPath = ant.path.length > 0;
        ant.path = [];
        ant.targetPos = null;
        ant.stuckTimer = 0;
        if (hadPath) {
          // The route was planned against terrain that has since changed (e.g. a fresh soil deposit). Re-plan from
          // right here immediately rather than turning around and walking away from the goal.
          ant.lastPathCalcTime = -10;
        } else {
          ant.angle = wrapAngle(ant.angle + Math.PI * (0.55 + Math.random() * 0.6));
        }
      }
    } else {
      ant.stuckTimer = 0;
    }
    ant.prevX = ant.x;
    ant.prevY = ant.y;
  }

  private stepParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += dt;
      if (p.kind === 'dust') {
        p.x += (p.vx + this.windStrength * 4 + Math.sin(this.simTime * 0.6 + i) * 3) * dt;
        p.y += (p.vy + Math.cos(this.simTime * 0.5 + i * 1.3) * 2) * dt;
        if (p.x < CASE_LEFT + 12) p.x = CASE_RIGHT - 16;
        if (p.x > CASE_RIGHT - 12) p.x = CASE_LEFT + 16;
        if (p.y < CASE_TOP + 12) p.y = SURFACE_BASE_Y - 12;
        if (p.y > SURFACE_BASE_Y + 12) p.y = CASE_TOP + 14;
      } else {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.kind === 'crumb') p.vy += 80 * dt;
        if (p.life >= p.maxLife) {
          this.particles.splice(i, 1);
        }
      }
    }
  }

  public getChamber(type: ChamberType): Chamber | undefined {
    return this.chambers.find((c) => c.type === type);
  }

  public getStats(): ColonyStats {
    const castes: Record<string, number> = {};
    const busy: Record<string, number> = {};
    for (const a of this.ants) {
      castes[a.caste] = (castes[a.caste] ?? 0) + 1;
      busy[a.task] = (busy[a.task] ?? 0) + 1;
    }
    let eggs = 0;
    let larvae = 0;
    let pupae = 0;
    for (const b of this.brood) {
      if (b.stage === BroodStage.EGG) eggs++;
      else if (b.stage === BroodStage.LARVA) larvae++;
      else pupae++;
    }
    return {
      population: this.ants.length,
      queenAlive: !!this.getQueen(),
      castes,
      eggs,
      larvae,
      pupae,
      storedFood: Math.round(this.storedFoodCache),
      chambers: this.chambers.length,
      tunnelCells: this.tunnelsDugCells,
      moundSoil: this.soilDeposited,
      intruders: this.intruders.length,
      day: this.dayCount,
      isNight: this.isNight(),
      weather: this.weather,
      busy,
    };
  }

  private sanitizeAntPositions(): void {
    for (const ant of this.ants) {
      const g = this.grid.worldToGrid(ant.x, ant.y);
      if (!this.grid.isNavigable(g.gx, g.gy)) {
        const safe = this.grid.findNearestNavigable(g.gx, g.gy, 32);
        if (safe) {
          const w = this.grid.gridToWorld(safe.gx, safe.gy);
          ant.x = w.x;
          ant.y = w.y;
          ant.prevX = w.x;
          ant.prevY = w.y;
        }
      }
    }
  }

  // ================================================================================================================
  // Persistence
  // ================================================================================================================

  private static rle(arr: ArrayLike<number>, quant = 1): number[] {
    const out: number[] = [];
    let prev = Math.round(arr[0] * quant);
    let count = 1;
    for (let i = 1; i < arr.length; i++) {
      const v = Math.round(arr[i] * quant);
      if (v === prev) count++;
      else {
        out.push(prev, count);
        prev = v;
        count = 1;
      }
    }
    out.push(prev, count);
    return out;
  }

  private static unrle(data: number[], target: { length: number; [i: number]: number }, quant = 1): void {
    let idx = 0;
    for (let i = 0; i < data.length; i += 2) {
      const v = data[i] / quant;
      for (let c = 0; c < data[i + 1] && idx < target.length; c++) target[idx++] = v;
    }
  }

  public saveState(): void {
    try {
      const payload = {
        v: 2,
        simTime: this.simTime,
        timeOfDay: this.timeOfDay,
        dayCount: this.dayCount,
        weather: this.weather,
        weatherTimer: this.weatherTimer,
        tunnelsDugCells: this.tunnelsDugCells,
        soilDeposited: this.soilDeposited,
        nextId: this.nextId,
        entrancePos: this.entrancePos,
        middenPos: this.middenPos,
        chambers: this.chambers,
        projects: this.projects,
        ants: this.ants.map((a) => ({ ...a, path: [], pathIndex: 0, targetPos: null, navKey: undefined })),
        brood: this.brood,
        foods: this.foods,
        fallenAnts: this.fallenAnts,
        intruders: this.intruders.map((m) => ({ ...m, path: [], pathIndex: 0 })),
        sprouts: this.sprouts,
        surfaceProps: this.surfaceProps,
        rootPolylines: this.rootPolylines,
        events: this.events,
        terrainRle: AntColonySimulation.rle(this.grid.terrain),
        moistRle: AntColonySimulation.rle(this.grid.moisture, 20),
        planRle: AntColonySimulation.rle(this.digPlan),
        baseGround: this.baseGround ? Array.from(this.baseGround) : null,
      };
      localStorage.setItem(AntColonySimulation.SAVE_KEY, JSON.stringify(payload));
    } catch {
      // storage unavailable or full: the colony simply won't persist
    }
  }

  public loadState(): boolean {
    try {
      const raw = localStorage.getItem(AntColonySimulation.SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || data.v !== 2 || !Array.isArray(data.terrainRle) || !Array.isArray(data.ants) || data.ants.length === 0) return false;

      AntColonySimulation.unrle(data.terrainRle, this.grid.terrain);
      if (Array.isArray(data.moistRle)) AntColonySimulation.unrle(data.moistRle, this.grid.moisture, 20);
      if (Array.isArray(data.planRle)) AntColonySimulation.unrle(data.planRle, this.digPlan);

      this.simTime = Number(data.simTime) || 0;
      this.timeOfDay = Number.isFinite(data.timeOfDay) ? data.timeOfDay : 0.3;
      this.dayCount = Number(data.dayCount) || 1;
      this.weather = data.weather || 'Clear';
      this.weatherTimer = Number(data.weatherTimer) || 35;
      this.tunnelsDugCells = Number(data.tunnelsDugCells) || 0;
      this.soilDeposited = Number(data.soilDeposited) || 0;
      this.nextId = Number(data.nextId) || 100000;
      this.entrancePos = data.entrancePos || { x: 700, y: SURFACE_BASE_Y };
      this.middenPos = data.middenPos || { x: 1290, y: SURFACE_BASE_Y };
      this.chambers = data.chambers || [];
      this.projects = data.projects || [];
      this.ants = data.ants || [];
      this.brood = data.brood || [];
      this.foods = data.foods || [];
      this.fallenAnts = data.fallenAnts || [];
      this.intruders = data.intruders || [];
      this.sprouts = data.sprouts || [];
      this.surfaceProps = data.surfaceProps || [];
      this.rootPolylines = data.rootPolylines || [];
      this.events = data.events || [];
      if (Array.isArray(data.baseGround) && data.baseGround.length === GRID_W) this.baseGround = Float32Array.from(data.baseGround);
      this.droplets = [];
      this.particles = [];
      for (let i = 0; i < 65; i++) this.particles.push(this.makeDustMote());

      this.grid.updateSurfaceProfile();
      this.grid.rebuildNav();
      this.grid.dirtVisualDirty = true;

      const ids = new Set(this.ants.map((a) => a.id));
      for (const ant of this.ants) {
        ant.path = [];
        ant.pathIndex = 0;
        ant.targetPos = null;
        ant.digIdx = -1;
        if (ant.payloadId !== null && isBroodPayload(ant.payload) && !this.brood.some((b) => b.id === ant.payloadId)) {
          ant.payloadId = null;
          ant.payload = PayloadType.NONE;
        }
      }
      for (const b of this.brood) if (b.carriedByAntId !== null && !ids.has(b.carriedByAntId)) b.carriedByAntId = null;
      for (const fa of this.fallenAnts) if (fa.carriedByAntId !== null && !ids.has(fa.carriedByAntId)) fa.carriedByAntId = null;
      for (const sp of this.sprouts) sp.y = this.grid.surfaceY[clamp(Math.floor(sp.x / CELL_SIZE), 0, GRID_W - 1)];
      this.sanitizeAntPositions();
      return true;
    } catch {
      return false;
    }
  }
}
