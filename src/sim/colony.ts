import { ColonyGrid } from './pathfinding';
import type { LiveWeather, WeatherCondition } from './realworld';
import {
  Ant,
  AntCaste,
  AntTask,
  Aphid,
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
  Debris,
  FallenAnt,
  FoodSource,
  GRID_H,
  GRID_W,
  Intruder,
  Particle,
  PayloadType,
  PlantSprout,
  Creature,
  CreatureKind,
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
/** sim seconds per day/night cycle when no real clock is available (tests / headless runs) */
const DAY_LENGTH = 200;

export type Season = 'Spring' | 'Summer' | 'Autumn' | 'Winter';

type CollapseCause = 'settling' | 'saturation' | 'rain' | 'drought' | 'thaw' | 'span' | 'abandoned' | 'footsteps' | 'anteater';

export interface Climate {
  tempC: number;
  /** 0..1 */
  humidity: number;
  rainMmH: number;
  snowCmH: number;
  /** 0..1 */
  cloud: number;
  windKmh: number;
  windDir: number;
}

/**
 * Ants are ectotherms: their pace follows temperature. Near-torpid below ~5 °C, rising steeply to an optimum
 * around 25-33 °C, then falling off as heat stress sets in. Returns a 0..1 work/speed multiplier.
 */
export function antActivity(tC: number): number {
  if (tC <= 3) return 0.06;
  if (tC < 12) return 0.06 + ((tC - 3) / 9) * 0.39;
  if (tC < 25) return 0.45 + ((tC - 12) / 13) * 0.55;
  if (tC <= 33) return 1;
  if (tC < 45) return 1 - ((tC - 33) / 12) * 0.75;
  return 0.25;
}
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
  AntTask.ALLOGROOMING,
  AntTask.HELPING_ECLOSION,
  AntTask.HUSKING_SEED,
  AntTask.TENDING_APHIDS,
  AntTask.CANNIBALIZING,
  AntTask.SEALING_ENTRANCE,
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
  public creatures: Creature[] = [];
  private creatureTimers: Record<CreatureKind, number> = { bird: 150, spider: 120, antlion: 200, anteater: 900, worm: 400, ladybug: 25 };
  public surfaceProps: SurfaceProp[] = [];
  public rootPolylines: Vec2[][] = [];
  public events: ColonyEvent[] = [];

  public simTime: number = 0;
  public timeOfDay: number = 0.3;
  public dayCount: number = 1;
  public weather: WeatherCondition = 'Clear';
  public windStrength: number = 0.35;
  private weatherTimer: number = 70;
  /** current (smoothed) outdoor climate, and the reading it is easing toward */
  public climate: Climate = { tempC: 21, humidity: 0.6, rainMmH: 0, snowCmH: 0, cloud: 0.2, windKmh: 8, windDir: 270 };
  private climateGoal: Climate = { ...this.climate };
  /** true once real weather for the player's location has arrived */
  public liveWeather = false;
  /** follow the player's real local clock for day and night (false = fast DAY_LENGTH cycle, for headless runs) */
  public realClock = typeof window !== 'undefined';
  /** local sunrise / sunset, minutes after local midnight */
  private sunriseMin = 6.5 * 60;
  private sunsetMin = 18.5 * 60;
  public latitude = 40;
  public season: Season = 'Autumn';
  /** soil-buffered temperature down in the nest, and the sun-baked ground temperature outside */
  public nestTempC = 20;
  public surfaceTempC = 21;
  /** 0..1 snow lying on the surface */
  public snowCover = 0;
  /** height (world px) of rainwater pooled in the bottom of the nest after a downpour */
  public floodDepth = 0;
  /** 0..1, how freshly the ground has been soaked (rises in rain, fades after) */
  public wetness = 0;
  private wasForageWeather = true;
  private nestBottomY = CASE_BOTTOM;
  private nestBottomVersion = -1;
  private foundedAt = Date.now();

  public entrancePos: Vec2 = { x: 700, y: SURFACE_BASE_Y };
  public middenPos: Vec2 = { x: 1290, y: SURFACE_BASE_Y };
  public tunnelsDugCells: number = 0;
  public soilDeposited: number = 0;
  /** ground height per column before any mound building (the mound's height is measured against this) */
  private baseGround: Float32Array | null = null;

  /** 0 = nothing planned, 1 = planned expansion, 2 = urgent repair of storm damage */
  public digPlan: Uint8Array = new Uint8Array(N_CELLS);
  private projects: DigProject[] = [];
  /** the colony is moving house: workers dig a new royal chamber, then the queen and brood relocate into it */
  private emigration: { newId: number; oldId: number; phase: 'digging' | 'moving'; t: number } | null = null;
  private emigrationCooldown = 400;
  private royalStress = 0;
  /** 0..1+: how badly a rival colony's war is going for us (drives emigration) */
  public warPressure = 0;
  /** the rival colony next door: tension builds until it declares war, then sends waves; we may counter-raid */
  public war = {
    phase: 'peace' as 'peace' | 'war',
    tension: 0.15,
    wave: 0,
    waves: 0,
    nextWave: 0,
    kills: 0,
    lost: 0,
    edge: 'left' as 'left' | 'right',
    raid: null as { x: number; t: number; spawned: boolean } | null,
    raidDone: false,
  };
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
  public counters = { pickups: 0, deliveries: 0, digs: 0, deposits: 0, larvaFeeds: 0, queenFeeds: 0, tandems: 0, rescues: 0, flights: 0, collapses: 0, backfills: 0 };
  /** sim time an ant last stood in each cell: galleries nobody uses stop being maintained */
  private lastVisit = new Float32Array(N_CELLS);
  private structTimer = 2;
  private maintenanceTimer = 0;
  private lastCollapseTime = -999;
  private lastCollapseLog = -999;
  private footstepTimer = 600 + Math.random() * 900;
  private frozen = false;
  private thawStress = 0;
  private backfillTargets: number[] = [];
  /** open gallery cells with soil directly above them (the ones that can cave in) */
  private roofCells: number[] = [];
  /** open (dug) cells in the nest right now */
  public openCells = 0;
  /** 0..1 ground tremor (collapses, footsteps) for the renderer */
  public shake = 0;
  public aphids: Aphid[] = [];
  public debris: Debris[] = [];
  private repleteTimer = 5;
  /** nuptial flight under way */
  public swarming = false;
  private queenlessTimer = 120;
  private lastFamineLog = -999;
  private sealTimer = 0;
  private sealed = false;
  private sealedCells: number[] = [];
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
    // treat the whole existing nest as freshly used so nothing falls in the moment the game opens
    this.lastVisit.fill(this.simTime);
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

    // 2. Rocks are scattered once the nest is carved (see scatterRocks)

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

    this.scatterRocks();
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

  /**
   * Paints one irregular stone into the grid and returns the cells it changed (so a boulder can be undone).
   * Rock cells are solid and not diggable: excavators tunnel around them and ants walk around them.
   */
  private paintRock(cx: number, cy: number, rx: number, ry: number, rot: number, seed: number, intoTunnels: boolean): { idx: number; prev: CellType }[] {
    const changed: { idx: number; prev: CellType }[] = [];
    const cos = Math.cos(-rot);
    const sin = Math.sin(-rot);
    const reach = Math.max(rx, ry) * 1.35;
    const minGx = Math.floor((cx - reach) / CELL_SIZE);
    const maxGx = Math.ceil((cx + reach) / CELL_SIZE);
    const minGy = Math.floor((cy - reach) / CELL_SIZE);
    const maxGy = Math.ceil((cy + reach) / CELL_SIZE);
    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        if (!this.grid.inBounds(gx, gy)) continue;
        const dx = (gx + 0.5) * CELL_SIZE - cx;
        const dy = (gy + 0.5) * CELL_SIZE - cy;
        const lx = (dx * cos - dy * sin) / rx;
        const ly = (dx * sin + dy * cos) / ry;
        const th = Math.atan2(ly, lx);
        // a lumpy outline: no two stones share a shape
        const edge = 0.86 * (1 + 0.2 * Math.sin(th * 2 + seed) + 0.13 * Math.sin(th * 3 + seed * 1.7) + 0.08 * Math.sin(th * 5 + seed * 2.3));
        if (Math.hypot(lx, ly) > edge) continue;
        const idx = this.grid.idx(gx, gy);
        const cur = this.grid.terrain[idx];
        if (cur === CellType.GLASS_WALL || cur === CellType.AIR || cur === CellType.PEBBLE || cur === CellType.ROOT) continue;
        if (cur === CellType.TUNNEL && !intoTunnels) continue;
        changed.push({ idx, prev: cur });
        this.grid.setTerrain(gx, gy, CellType.PEBBLE);
      }
    }
    return changed;
  }

  private undoRock(changed: { idx: number; prev: CellType }[]): void {
    for (const c of changed) this.grid.setTerrain(c.idx % GRID_W, Math.floor(c.idx / GRID_W), c.prev);
  }

  /**
   * Scatters stones through the soil. Most are embedded in the earth; a handful are boulders that stand inside
   * chambers and tunnels, so ants have to path around them. A boulder is dropped again if it would cut off any
   * chamber or entrance, or sit on food or the heart of a chamber.
   */
  private scatterRocks(): void {
    // 1. stones embedded in the soil (they never overwrite tunnels)
    for (let n = 0; n < 40; n++) {
      const px = CASE_LEFT + 50 + Math.random() * (CASE_RIGHT - CASE_LEFT - 100);
      const py = SURFACE_BASE_Y + 40 + Math.random() * (CASE_BOTTOM - SURFACE_BASE_Y - 80);
      const big = Math.random() < 0.18;
      const rx = big ? 24 + Math.random() * 16 : 9 + Math.random() * 14;
      const ry = rx * (0.5 + Math.random() * 0.35);
      this.paintRock(px, py, rx, ry, (Math.random() - 0.5) * 1.2, Math.random() * 20, false);
    }

    // 2. boulders in the way
    const cellOf = (x: number, y: number) => this.grid.worldToGrid(x, y);
    const reach = (from: { gx: number; gy: number }): Uint8Array => {
      const seen = new Uint8Array(GRID_W * GRID_H);
      const stack = [from.gy * GRID_W + from.gx];
      seen[stack[0]] = 1;
      while (stack.length) {
        const i = stack.pop()!;
        const x = i % GRID_W;
        const y = (i - x) / GRID_W;
        for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
          if (nx < 0 || ny < 0 || nx >= GRID_W || ny >= GRID_H) continue;
          const j = ny * GRID_W + nx;
          if (seen[j] || this.grid.terrain[j] !== CellType.TUNNEL) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
      return seen;
    };
    const home = this.chambers[this.chambers.length - 1];
    const start = cellOf(home.x, home.y);
    const baseline = reach(start);
    // every place that must stay reachable: the chamber hearts, and the two entrance shafts
    const must: number[] = [];
    const addMust = (x: number, y: number) => {
      const g = cellOf(x, y);
      const i = g.gy * GRID_W + g.gx;
      if (baseline[i]) must.push(i);
    };
    for (const c of this.chambers) addMust(c.x, c.y);
    addMust(700, this.entrancePos.y + 12);
    addMust(405, this.grid.surfaceY[Math.floor(405 / CELL_SIZE)] + 12);

    const protectedSpot = (idx: number): boolean => {
      const x = ((idx % GRID_W) + 0.5) * CELL_SIZE;
      const y = (Math.floor(idx / GRID_W) + 0.5) * CELL_SIZE;
      for (const c of this.chambers) {
        const nx = (x - c.x) / c.rx;
        const ny = (y - c.y) / c.ry;
        if (nx * nx + ny * ny < 0.62 * 0.62) return true; // the heart of a chamber stays clear for nurses, brood and the queen
      }
      for (const f of this.foods) if (Math.hypot(x - f.x, y - f.y) < f.radius + 10) return true;
      return Math.abs(x - 700) < 46 && y < 330; // the main shaft below the entrance
    };

    const tunnelCells: number[] = [];
    for (let gy = Math.floor((SURFACE_BASE_Y + 60) / CELL_SIZE); gy < GRID_H - 6; gy++) {
      for (let gx = 4; gx < GRID_W - 4; gx++) {
        const i = gy * GRID_W + gx;
        if (this.grid.terrain[i] === CellType.TUNNEL) tunnelCells.push(i);
      }
    }
    let placed = 0;
    for (let attempt = 0; attempt < 60 && placed < 9 && tunnelCells.length; attempt++) {
      const i = tunnelCells[Math.floor(Math.random() * tunnelCells.length)];
      const cx = ((i % GRID_W) + 0.5) * CELL_SIZE;
      const cy = (Math.floor(i / GRID_W) + 0.5) * CELL_SIZE;
      const rx = 9 + Math.random() * 7;
      const ry = rx * (0.6 + Math.random() * 0.3);
      const changed = this.paintRock(cx, cy, rx, ry, Math.random() * Math.PI, Math.random() * 20, true);
      let ok = changed.length >= 3 && !changed.some((c) => protectedSpot(c.idx));
      if (ok) {
        const after = reach(start);
        ok = must.every((m) => after[m] === 1);
      }
      if (ok) placed++;
      else this.undoRock(changed);
    }
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
      // personality: bell-shaped around the middle, so most ants are ordinary and a few are clearly bold/shy/lazy
      bold: this.trait(),
      industry: this.trait(),
      social: this.trait(),
    };
    if (caste === AntCaste.SOLDIER) ant.bold = Math.max(ant.bold ?? 0.5, 0.65);
    ant.speed *= 0.93 + (ant.industry ?? 0.5) * 0.14;
    this.ants.push(ant);
    return ant;
  }

  private trait(): number {
    return clamp((Math.random() + Math.random() + Math.random()) / 3 + (Math.random() - 0.5) * 0.15, 0, 1);
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

  /**
   * A person tapped the open air above the ground: a crumb of food drops from that spot. Returns false (and does
   * nothing) for taps at or below ground level, or when plenty of loose food is already lying about.
   */
  public dropFoodFromTap(x: number, y: number): boolean {
    const cx = clamp(x, CASE_LEFT + 32, CASE_RIGHT - 32);
    const gx = Math.floor(cx / CELL_SIZE);
    const ground = this.grid.surfaceY[gx];
    if (y > ground - 6) return false;
    if (this.foods.filter((f) => f.storedInChamberId === null && !f.large).length >= 14) return false;
    const r = Math.random();
    const type = r < 0.4 ? PayloadType.SEED : r < 0.7 ? PayloadType.HONEYDEW : PayloadType.PROTEIN;
    const amount = type === PayloadType.HONEYDEW ? 45 : type === PayloadType.PROTEIN ? 60 : 50;
    this.foods.push({
      id: this.allocId(),
      type,
      x: cx,
      y: Math.max(CASE_TOP + 8, y),
      amount,
      maxAmount: amount,
      radius: type === PayloadType.HONEYDEW ? 5.5 : type === PayloadType.PROTEIN ? 7.5 : 6,
      storedInChamberId: null,
      vy: 10,
      falling: true,
    });
    return true;
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
    this.stepClock(dt);
    if (!this.realClock && this.timeOfDay < prevTod) this.dayCount++;
    if (wasNight !== this.isNight()) {
      this.log(this.isNight() ? 'Night falls: most foragers head underground' : `Day ${this.dayCount} dawns: foragers stream out`);
    }

    this.stepWeather(dt);

    this.pherAccum += dt;
    if (this.pherAccum >= 0.12) {
      const c = this.climate;
      const dryness = clamp((1 - c.humidity) * 0.6 + clamp((this.surfaceTempC - 20) / 25, 0, 1) * 0.3 + clamp(c.windKmh / 50, 0, 1) * 0.4, 0, 1);
      this.grid.stepPheromonesAndMoisture(this.pherAccum, this.rainIntensity(), this.weather === 'Fog', dryness);
      this.pherAccum = 0;
    }

    this.updateFields(dt);
    this.stepDroplets(dt);
    this.stepEcosystem(dt);
    this.stepStormDamage(dt);
    this.stepStructure(dt);
    this.updateBroodClimate(dt);
    this.stepAphids(dt);
    this.stepRepletes(dt);
    this.stepDebris(dt);
    this.stepQueenless(dt);
    this.stepNuptialFlight(dt);
    this.stepEmigration(dt);
    this.stepEntranceSealing(dt);
    this.stepBrood(dt);
    this.stepQueenLaying(dt);
    this.planExpansion(dt);
    this.rebalanceLabour(dt);

    this.pathBudget = 10;
    this.buildHash();
    this.refreshClaims();
    this.stepWar(dt);
    this.stepCreatures(dt);
    this.stepIntruders(dt);
    this.stepAnts(dt);
    this.stepGroupTransport(dt);
    this.resolveEntityCrowding(dt);
    this.stepFallenAnts(dt);
    this.stepParticles(dt);
  }

  // ================================================================================================================
  // Real clock, seasons and weather
  // ================================================================================================================

  /** Live weather (or the cached last reading) for the player's location. */
  public applyLiveWeather(wx: LiveWeather, cached: boolean): void {
    const prev = this.weather;
    const first = !this.liveWeather;
    this.liveWeather = true;
    this.climateGoal = {
      tempC: wx.tempC,
      humidity: clamp(wx.humidity, 0, 1),
      rainMmH: Math.max(0, wx.rainMmH),
      snowCmH: Math.max(0, wx.snowCmH),
      cloud: clamp(wx.cloud, 0, 1),
      windKmh: Math.max(0, wx.windKmh),
      windDir: wx.windDir,
    };
    // the first reading replaces the made-up weather outright instead of easing out of it
    if (first) this.climate = { ...this.climateGoal };
    this.weather = wx.condition;
    this.latitude = wx.latitude;
    const minutes = (ms: number) => {
      const d = new Date(ms);
      return d.getHours() * 60 + d.getMinutes();
    };
    const rise = minutes(wx.sunrise);
    const set = minutes(wx.sunset);
    if (set - rise > 60) {
      this.sunriseMin = rise;
      this.sunsetMin = set;
    }
    if (!cached && prev !== this.weather) this.logWeatherChange(prev);
  }

  private logWeatherChange(prev: WeatherCondition): void {
    const w = this.weather;
    if (w === 'Heavy Rain' || w === 'Thunderstorm') this.log(`${w}: foragers shelter, nurses guard the brood from flooding`, 'danger');
    else if (w === 'Rain' || w === 'Drizzle') this.log('Rain begins: trails wash out and the mound starts to erode', 'danger');
    else if (w === 'Snow') this.log('Snow: the colony withdraws deep underground', 'danger');
    else if (prev === 'Rain' || prev === 'Heavy Rain' || prev === 'Thunderstorm' || prev === 'Drizzle') this.log('The rain has passed: damp soil, easy digging');
  }

  /** 0 dry .. ~1.2 thunderstorm */
  public rainIntensity(): number {
    switch (this.weather) {
      case 'Drizzle':
        return 0.25;
      case 'Rain':
        return 0.55;
      case 'Heavy Rain':
        return 1;
      case 'Thunderstorm':
        return 1.2;
      default:
        return 0;
    }
  }

  private seasonFor(date: Date, lat: number): Season {
    let m = date.getMonth(); // 0 = Jan
    if (lat < 0) m = (m + 6) % 12;
    return m <= 1 || m === 11 ? 'Winter' : m <= 4 ? 'Spring' : m <= 7 ? 'Summer' : 'Autumn';
  }

  /** typical mean temperature for the season, what deep soil settles toward */
  private seasonMeanC(): number {
    const tropics = Math.abs(this.latitude) < 23;
    if (tropics) return 25;
    return this.season === 'Summer' ? 21 : this.season === 'Winter' ? 4 : 13;
  }

  /** 0..1 egg-laying / brood-rearing drive through the year (queens shut down in winter, peak in summer) */
  public seasonalBreeding(): number {
    if (Math.abs(this.latitude) < 23) return 1;
    return this.season === 'Summer' ? 1 : this.season === 'Spring' ? 0.85 : this.season === 'Autumn' ? 0.45 : 0.18;
  }

  private stepClock(dt: number): void {
    if (!this.realClock) {
      this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH) % 1;
      return;
    }
    // Map the real local clock onto the sky: sunrise -> 0.2, sunset -> 0.7 (the renderer's horizon crossings).
    const now = new Date();
    const m = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const rise = this.sunriseMin;
    const set = this.sunsetMin;
    let t: number;
    if (m >= rise && m <= set) t = 0.2 + (0.5 * (m - rise)) / (set - rise);
    else {
      const nightLen = 1440 - (set - rise);
      const since = (m - set + 1440) % 1440;
      t = 0.7 + (0.5 * since) / nightLen;
    }
    this.timeOfDay = ((t % 1) + 1) % 1;
    this.dayCount = Math.max(1, Math.floor((now.getTime() - this.foundedAt) / 86400e3) + 1);
    this.season = this.seasonFor(now, this.latitude);
  }

  /** Daylight strength 0..1, matching the renderer's sun. */
  public daylight(): number {
    const sunElev = Math.sin((this.timeOfDay - 0.2) * Math.PI * 2);
    return clamp(sunElev * 0.85 + 0.35, 0, 1);
  }

  /** Made-up weather for when the real thing isn't available (offline, no location). */
  private stepSimulatedWeather(dt: number): void {
    this.weatherTimer -= dt;
    if (this.weatherTimer > 0) return;
    const prev = this.weather;
    const r = Math.random();
    const cold = this.season === 'Winter';
    this.weather = r < 0.42 ? 'Clear' : r < 0.6 ? 'Cloudy' : r < 0.7 ? 'Fog' : r < 0.82 ? 'Drizzle' : r < 0.93 ? 'Rain' : cold ? 'Snow' : 'Heavy Rain';
    this.weatherTimer = this.weather === 'Clear' || this.weather === 'Cloudy' ? 120 + Math.random() * 120 : 40 + Math.random() * 40;
    const base = this.seasonMeanC() + 6 * this.daylight() - 3;
    const g = this.climateGoal;
    g.tempC = this.weather === 'Snow' ? Math.min(base, -1) : base + (Math.random() - 0.5) * 4;
    g.cloud = this.weather === 'Clear' ? 0.1 : this.weather === 'Cloudy' ? 0.7 : 0.95;
    g.rainMmH = this.rainIntensity() * 5;
    g.snowCmH = this.weather === 'Snow' ? 0.4 : 0;
    g.humidity = this.weather === 'Clear' ? 0.5 : 0.9;
    g.windKmh = 4 + Math.random() * (this.weather === 'Heavy Rain' ? 40 : 18);
    g.windDir = Math.random() < 0.5 ? 270 : 90;
    if (this.weather !== prev) this.logWeatherChange(prev);
  }

  private stepWeather(dt: number): void {
    if (!this.liveWeather) this.stepSimulatedWeather(dt);

    // ease toward the latest reading so a 15-minute weather update doesn't snap
    const c = this.climate;
    const g = this.climateGoal;
    const k = 1 - Math.exp(-dt / 20);
    c.tempC += (g.tempC - c.tempC) * k;
    c.humidity += (g.humidity - c.humidity) * k;
    c.rainMmH += (g.rainMmH - c.rainMmH) * k;
    c.snowCmH += (g.snowCmH - c.snowCmH) * k;
    c.cloud += (g.cloud - c.cloud) * k;
    c.windKmh += (g.windKmh - c.windKmh) * k;
    c.windDir = g.windDir;

    // Sun bakes bare ground well above air temperature; soil buffers the nest toward the seasonal mean.
    const sun = this.daylight() * (1 - c.cloud * 0.8);
    this.surfaceTempC = c.tempC + sun * 11 - this.wetness * 2 - this.snowCover * 3;
    const nestGoal = clamp(0.4 * c.tempC + 0.6 * this.seasonMeanC(), 1, 30);
    this.nestTempC += (nestGoal - this.nestTempC) * (1 - Math.exp(-dt / 300));

    // wind: real speed and direction, with gusts (positive blows left -> right)
    const dirX = -Math.sin((c.windDir * Math.PI) / 180);
    const gust = 0.75 + 0.25 * Math.sin(this.simTime * 0.9) + 0.15 * Math.sin(this.simTime * 2.3);
    this.windStrength = (c.windKmh / 22) * (Math.abs(dirX) < 0.2 ? 0.2 * Math.sign(dirX || 1) : dirX) * gust;

    const rain = this.rainIntensity();
    this.wetness = clamp(this.wetness + (rain > 0 ? rain * dt * 0.02 : -dt * 0.0015), 0, 1);

    // snow settles on cold ground, melts when it warms
    if (this.weather === 'Snow' && this.surfaceTempC < 3) this.snowCover = Math.min(1, this.snowCover + dt * 0.004);
    else if (this.surfaceTempC > 1) this.snowCover = Math.max(0, this.snowCover - dt * 0.0012 * (this.surfaceTempC - 1));

    // downpours pool water in the bottom of the nest; it soaks away once the rain stops
    if (rain >= 1) this.floodDepth = Math.min(130, this.floodDepth + dt * (rain - 0.8) * 1.2);
    else this.floodDepth = Math.max(0, this.floodDepth - dt * (rain > 0 ? 0.25 : 0.7));

    const forage = this.forageWeather();
    if (forage !== this.wasForageWeather) {
      this.wasForageWeather = forage;
      if (!forage && this.weather !== 'Snow' && rain < 0.5) {
        this.log(this.surfaceTempC > 30 ? 'Too hot on the surface: foragers wait for cooler hours' : 'Too cold for foraging: the colony stays in', 'danger');
      }
    }

    if (rain > 0 && Math.random() < dt * 30 * rain) {
      const rx = CASE_LEFT + 16 + Math.random() * (CASE_RIGHT - CASE_LEFT - 32);
      this.droplets.push({
        id: this.allocId(),
        x: rx,
        y: CASE_TOP + 8,
        vy: 155 + Math.random() * 65 + rain * 60,
        radius: 1.3 + Math.random() * 1.1 + rain * 0.6,
        volume: 9,
        settled: false,
      });
    }

    if (this.weather === 'Snow' && Math.random() < dt * 14 && this.particles.length < 200) {
      this.particles.push({
        x: CASE_LEFT + 10 + Math.random() * (CASE_RIGHT - CASE_LEFT - 20),
        y: CASE_TOP + 6,
        vx: this.windStrength * 12,
        vy: 14 + Math.random() * 10,
        size: 1 + Math.random(),
        alpha: 0.9,
        life: 0,
        maxLife: 30,
        kind: 'snow',
        color: '#ffffff',
      });
    }

    if (this.weather === 'Fog' && Math.random() < dt * 2.4 && this.particles.length < 110) {
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

  /** Is it currently worth going out? (temperature window, no downpour, no snow, not a gale) */
  public forageWeather(): boolean {
    const t = this.surfaceTempC;
    return t >= 10 && t <= 40 && this.rainIntensity() < 0.5 && this.weather !== 'Snow' && this.snowCover < 0.3 && this.climate.windKmh < 45;
  }

  /** world y below which tunnels are under water */
  public floodLineY(): number {
    // water collects in the lowest galleries first
    if (this.nestBottomVersion !== this.grid.terrainVersion) {
      this.nestBottomVersion = this.grid.terrainVersion;
      let deepest = SURFACE_BASE_Y + 60;
      for (let gy = GRID_H - 2; gy > 0; gy--) {
        let hit = false;
        for (let gx = 0; gx < GRID_W; gx++) {
          if (this.grid.terrain[gy * GRID_W + gx] === CellType.TUNNEL) {
            hit = true;
            break;
          }
        }
        if (hit) {
          deepest = (gy + 1) * CELL_SIZE;
          break;
        }
      }
      this.nestBottomY = deepest;
    }
    return this.nestBottomY - this.floodDepth;
  }

  /** Temperature-driven pace for an ant at (x, y). */
  public activityAt(x: number, y: number): number {
    return Math.max(0.12, antActivity(this.tempAt(x, y)));
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
      // food follows the seasons: abundant in summer, scarce in winter, nothing falls in a snowstorm
      const seasonK = this.season === 'Summer' ? 0.85 : this.season === 'Spring' ? 1 : this.season === 'Autumn' ? 1.3 : 2.4;
      this.naturalFoodTimer = (5 + Math.random() * 6) * seasonK * (this.weather === 'Snow' ? 3 : 1);
      const surfaceFoods = this.foods.filter((f) => f.storedInChamberId === null);
      if (surfaceFoods.length < 14) {
        const r = Math.random();
        // rain drowns insects: right after a shower there are carcasses everywhere
        const prey = this.wetness > 0.2 && this.rainIntensity() < 0.5 ? 0.35 : 0.12;
        if (Math.random() < prey && !this.foods.some((f) => f.large)) {
          const rx = CASE_LEFT + 120 + Math.random() * (CASE_RIGHT - CASE_LEFT - 240);
          this.spawnSurfaceFood(PayloadType.PROTEIN, rx, false);
          const big = this.foods[this.foods.length - 1];
          big.large = true;
          big.amount = big.maxAmount = 110;
          big.radius = 11;
        } else if (r < 0.55) {
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

    for (const sp of this.sprouts) if ((sp.cut ?? 0) > 0) sp.cut = Math.max(0, (sp.cut ?? 0) - dt / 500);
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
        f.radius = f.large ? 11 : 2.8 + (f.amount / f.maxAmount) * 5;
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

  private stepBrood(stepDt: number): void {
    for (let i = this.brood.length - 1; i >= 0; i--) {
      const b = this.brood[i];
      // brood grows only as fast as its chamber's temperature allows (and stalls in a cold winter nest)
      const dt = stepDt * this.activityAt(b.x, b.y);
      b.wigglePhase += dt * (b.stage === BroodStage.LARVA ? 4.8 : 1.2);

      if (b.carriedByAntId === null) {
        const g = this.grid.worldToGrid(b.x, b.y + 3);
        if (this.grid.inBounds(g.gx, g.gy) && !this.grid.isSolid(g.gx, g.gy)) b.y += 18 * stepDt;
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

      if (b.trophic) {
        // trophic eggs are food, not offspring: they don't develop and spoil if nobody eats them
        b.progress += dt;
        if (b.progress > 90) this.brood.splice(i, 1);
        continue;
      }
      if (b.stage === BroodStage.EGG) {
        b.progress += dt * 3.2;
        if (b.progress >= 100) {
          b.stage = BroodStage.LARVA;
          b.progress = 0;
          b.nutrition = 50;
          // caste is decided by how the larva is fed: in the breeding season some are raised as winged sexuals
          if (!b.sexual) b.sexual = this.wantSexual() ?? undefined;
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
        b.progress = Math.min(100, b.progress + dt * 2.4);
        if (b.progress >= 100) {
          if (!this.tryHelpEclosion(b, stepDt)) continue;
          if (this.ants.length < MAX_COLONY) {
            const caste = b.sexual === 'gyne' ? AntCaste.GYNE : b.sexual === 'male' ? AntCaste.MALE : this.chooseNeededCaste();
            const a = this.spawnAnt(caste, b.x, b.y - 2, true);
            a.age = 0;
            if (b.sexual) this.log(`A winged ${b.sexual === 'gyne' ? 'young queen' : 'male'} has emerged`, 'good');
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
    // laying follows the seasons and the warmth of the royal chamber
    this.queenEggTimer -= dt * this.seasonalBreeding() * this.activityAt(queen.x, queen.y);
    if (this.queenEggTimer > 0) return;
    const stored = this.storedFoodCache;
    this.queenEggTimer = (stored > 120 ? 4.5 : stored > 40 ? 8 : 16) + this.brood.length * 0.06;
    if (queen.hunger > 80) return;
    if (stored < 12) {
      // short of food: lay a non-viable trophic egg for nurses to feed to the hungriest larva
      const hungry = this.brood.some((b) => b.stage === BroodStage.LARVA && b.nutrition < 40);
      const trophics = this.brood.filter((b) => b.trophic).length;
      if (hungry && trophics < 4 && queen.hunger < 60 && !BUSY_TASKS.has(queen.task)) {
        const egg = this.makeBrood(BroodStage.EGG, queen.x - Math.cos(queen.angle) * 14, queen.y - Math.sin(queen.angle) * 6, royal.id, 0, 100);
        egg.trophic = true;
        this.brood.push(egg);
        queen.task = AntTask.LAYING_EGG;
        queen.stateTimer = 1.6;
        queen.hunger = Math.min(100, queen.hunger + 3);
      }
      return;
    }
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
      } else if (this.openCells < 2600 && Math.random() < 0.25) {
        this.planGallery();
      }
    }
  }

  /**
   * Nest moving. Real colonies emigrate when the nest turns unsafe (flooding, extreme temperatures, a lost war):
   * scouts and diggers prepare a new royal chamber on safer ground, then the queen and brood move in.
   */
  private stepEmigration(dt: number): void {
    const queen = this.getQueen();
    if (!queen) return;
    this.emigrationCooldown -= dt;
    const royals = this.chambers.filter((c) => c.type === ChamberType.ROYAL);

    if (!this.emigration) {
      const royal = royals[0];
      if (!royal || this.emigrationCooldown > 0 || this.projects.length > 1) return;
      const t = this.tempAt(royal.x, royal.y);
      let stress = 0;
      if (this.chamberFlooded(royal)) stress += 1;
      if (t < 2 || t > 32) stress += 0.5;
      if (this.warPressure > 0.8) stress += 0.8;
      this.royalStress = stress > 0 ? this.royalStress + stress * dt : Math.max(0, this.royalStress - dt * 2);
      if (this.royalStress < 45) return;
      const why = this.chamberFlooded(royal) ? 'rising water' : this.warPressure > 0.8 ? 'the war' : 'the extreme temperatures';
      const maxY = this.floodDepth > 0 ? Math.min(CASE_BOTTOM - 60, this.floodLineY() - 40) : CASE_BOTTOM - 60;
      this.royalStress = 0;
      this.emigrationCooldown = 300;
      // first choice: an existing chamber on safer ground swaps roles with the endangered royal chamber
      const safe = this.chambers
        .filter((c) => c.type !== ChamberType.ROYAL && c.type !== ChamberType.NURSERY && c.type !== ChamberType.MIDDEN && !this.chamberFlooded(c) && c.rx >= 36)
        .filter((c) => {
          const tc = this.tempAt(c.x, c.y);
          return tc > 3 && tc < 31 && c.y - this.grid.surfaceY[clamp(Math.floor(c.x / CELL_SIZE), 0, GRID_W - 1)] > 50;
        })
        .sort((a, b) => b.rx - a.rx)[0];
      if (safe) {
        const oldType = safe.type;
        safe.type = ChamberType.ROYAL;
        royal.type = oldType;
        for (const fk of STATIC_FIELDS) this.fieldDirty[fk] = true;
        this.emigration = { newId: safe.id, oldId: royal.id, phase: 'moving', t: 0 };
        this.log(`The nest is no longer safe (${why}): the colony is moving the queen to the ${oldType.toLowerCase()}`, 'danger');
        return;
      }
      if (!this.planNewProject(ChamberType.ROYAL, Math.max(SURFACE_BASE_Y + 130, maxY))) return;
      const proj = this.projects[this.projects.length - 1];
      this.emigration = { newId: proj.id, oldId: royal.id, phase: 'digging', t: 0 };
      this.log(`The nest is no longer safe (${why}): workers begin digging a new royal chamber`, 'danger');
      return;
    }

    const em = this.emigration;
    em.t += dt;
    const fresh = this.chambers.find((c) => c.id === em.newId);
    if (em.phase === 'digging') {
      if (!fresh) {
        if (em.t > 1800 || !this.projects.some((p) => p.id === em.newId)) this.emigration = null; // gave up
        return;
      }
      // the new chamber is ready: it becomes the royal chamber, the old one is handed over to the brood
      const old = this.chambers.find((c) => c.id === em.oldId);
      if (old) old.type = ChamberType.NURSERY;
      for (const fk of STATIC_FIELDS) this.fieldDirty[fk] = true;
      em.phase = 'moving';
      em.t = 0;
      this.log('The colony is moving house: the queen is led to her new chamber', 'good');
      return;
    }
    if (!fresh || em.t > 900) {
      this.emigration = null;
      return;
    }
    if (this.isInsideChamber(queen, fresh, 1.0)) {
      this.emigration = null;
      this.emigrationCooldown = 1500;
      this.log('The queen has settled into her new royal chamber', 'good');
    }
  }

  /** Picks a site for a new chamber near the existing nest and plans the tunnel + chamber cells. */
  private planNewProject(type: ChamberType, maxY: number = CASE_BOTTOM - 60): boolean {
    let best: { x: number; y: number; rx: number; ry: number; tx: number; ty: number; score: number } | null = null;
    const depthBias = Math.min(1, this.chambers.length / 10);
    for (let attempt = 0; attempt < 70; attempt++) {
      const rx = 40 + Math.random() * 18;
      const ry = 20 + Math.random() * 8;
      const x = CASE_LEFT + 110 + Math.random() * (CASE_RIGHT - CASE_LEFT - 220);
      const y = SURFACE_BASE_Y + 110 + Math.random() * Math.max(10, maxY - SURFACE_BASE_Y - 110);
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
      if (a.replete !== undefined) continue;
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
      if (a.replete !== undefined || a.carriedById != null || a.carryingAntId != null || a.buried !== undefined) continue;
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
    const rain = this.rainIntensity();
    if (rain < 0.25) return;
    this.damageTimer -= dt;
    if (this.damageTimer > 0) return;
    // real rain lasts hours, not seconds: wear the nest down steadily rather than in a burst
    this.damageTimer = (14 + Math.random() * 22) / rain;
    // tunnel collapses are handled by the soil-stability model (stepStructure); rain here washes the mound down
    this.erodeMound();
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

  // ================================================================================================================
  // Wildlife: predators on the surface, an earthworm underground
  // ================================================================================================================

  private makeCreature(kind: CreatureKind, x: number, y: number, state: string, extra: Partial<Creature> = {}): Creature {
    const c: Creature = { id: this.allocId(), kind, x, y, vx: 0, vy: 0, dir: 1, state, timer: 0, phase: Math.random() * 6, hits: 0, tx: x, ...extra };
    this.creatures.push(c);
    return c;
  }

  /** Ants near (x, y) that can run, scatter away from it. */
  private scatterAnts(x: number, y: number, r: number, panic = 1): void {
    this.forAntsNear(x, y, r, (a) => {
      if (a.caste === AntCaste.QUEEN || a.caste === AntCaste.SOLDIER || a.flying || a.buried !== undefined || a.carriedById != null) return;
      if (!this.isOutside(a.x, a.y) || (a.bold ?? 0.5) > 0.88 / panic) return;
      const away = a.x >= x ? 1 : -1;
      const t = this.surfaceTarget(a.x + away * 80);
      this.goTo(a, t.x, t.y);
      a.task = AntTask.FLEEING;
    });
  }

  /** One surface ant within reach is caught; soldiers and bold foragers get a hit in before it dies. */
  private snatchAnt(x: number, y: number, reach: number): Ant | null {
    let victim: Ant | null = null;
    let best = reach;
    this.forAntsNear(x, y, reach + 8, (a) => {
      if (a.caste === AntCaste.QUEEN || a.flying || a.buried !== undefined || !this.isOutside(a.x, a.y)) return;
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < best) {
        best = d;
        victim = a;
      }
    });
    if (!victim) return null;
    const v = victim as Ant;
    this.killAnt(this.ants.indexOf(v), 'combat');
    return v;
  }

  private defendersNear(x: number, y: number, r: number): number {
    let n = 0;
    this.forAntsNear(x, y, r, (a) => {
      if (a.caste === AntCaste.SOLDIER || (a.bold ?? 0.5) > 0.6) n++;
    });
    return n;
  }

  private stepCreatures(dt: number): void {
    const day = !this.isNight();
    const mild = this.forageWeather() && this.season !== 'Winter';
    const has = (k: CreatureKind) => this.creatures.some((c) => c.kind === k);
    for (const k of Object.keys(this.creatureTimers) as CreatureKind[]) {
      this.creatureTimers[k] -= dt;
      if (this.creatureTimers[k] > 0 || this.ants.length < 15) continue;
      this.creatureTimers[k] = k === 'ladybug' ? 120 + Math.random() * 200 : 600 + Math.random() * 900;
      if (has(k)) continue;
      if (k === 'ladybug') {
        if (day && mild && this.aphids.length > 0) {
          const fromLeft = Math.random() < 0.5;
          const x = fromLeft ? CASE_LEFT + 20 : CASE_RIGHT - 20;
          const target = this.aphids[Math.floor(Math.random() * this.aphids.length)].x;
          this.makeCreature('ladybug', x, CASE_TOP + 90, 'flying', { dir: fromLeft ? 1 : -1, tx: target, life: 1500 + Math.random() * 1500 });
          this.log('A ladybird lands among the plants');
        }
        continue;
      }
      const surfaceAnts = this.ants.filter((a) => this.isOutside(a.x, a.y));
      if (k === 'bird' && day && mild) {
        const fromLeft = Math.random() < 0.5;
        const target = surfaceAnts.length ? surfaceAnts[Math.floor(Math.random() * surfaceAnts.length)].x : CASE_LEFT + 200 + Math.random() * 900;
        const c = this.makeCreature('bird', fromLeft ? CASE_LEFT + 10 : CASE_RIGHT - 10, CASE_TOP + 40, 'arriving', { dir: fromLeft ? 1 : -1, tx: clamp(target, CASE_LEFT + 80, CASE_RIGHT - 80) });
        this.log('A bird swoops down looking for a meal', 'danger');
        void c;
      } else if (k === 'spider' && mild && this.sprouts.length > 0) {
        const hosts = this.sprouts.filter((s) => s.kind !== 'moss' && Math.abs(s.x - this.entrancePos.x) > 90 && Math.abs(s.x - SIDE_ENTRANCE_X) > 60);
        if (hosts.length) {
          const h = hosts[Math.floor(Math.random() * hosts.length)];
          this.makeCreature('spider', h.x, this.surfaceTarget(h.x).y, 'waiting', { life: 900 + Math.random() * 900 });
          this.log('A spider spins a web beside the foraging trail', 'danger');
        }
      } else if (k === 'antlion' && this.season !== 'Winter') {
        const x = CASE_LEFT + 140 + Math.random() * (CASE_RIGHT - CASE_LEFT - 280);
        if (Math.abs(x - this.entrancePos.x) > 110 && Math.abs(x - SIDE_ENTRANCE_X) > 80) {
          this.makeCreature('antlion', x, this.surfaceTarget(x).y, 'lurking', { life: 2000 + Math.random() * 1500 });
          this.log('An antlion has dug a sand pit on the foraging ground', 'danger');
        }
      } else if (k === 'anteater' && day && mild) {
        const fromLeft = Math.random() < 0.5;
        this.makeCreature('anteater', fromLeft ? CASE_LEFT + 24 : CASE_RIGHT - 24, this.surfaceTarget(fromLeft ? CASE_LEFT + 24 : CASE_RIGHT - 24).y, 'approach', {
          dir: fromLeft ? 1 : -1,
          tx: this.entrancePos.x + (fromLeft ? -34 : 34),
        });
        this.log('An anteater lumbers out of the undergrowth', 'danger');
      } else if (k === 'worm' && this.season !== 'Winter' && !this.frozen && (this.wetness > 0.05 || Math.random() < 0.5)) {
        const x = CASE_LEFT + 140 + Math.random() * (CASE_RIGHT - CASE_LEFT - 280);
        const y = this.grid.surfaceY[clamp(Math.floor(x / CELL_SIZE), 0, GRID_W - 1)] + 70 + Math.random() * 260;
        const g = this.grid.worldToGrid(x, y);
        if (this.canExcavate(this.grid.idx(g.gx, g.gy)) && y < CASE_BOTTOM - 70) {
          const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
          this.makeCreature('worm', x, y, 'burrowing', { dir, left: 140 + Math.random() * 180, trail: [] });
          this.log('An earthworm is tunnelling through the soil', 'good');
        }
      }
    }

    for (let i = this.creatures.length - 1; i >= 0; i--) {
      const c = this.creatures[i];
      c.phase += dt;
      c.timer -= dt;
      let gone = false;
      if (c.kind === 'bird') gone = this.stepBird(c, dt);
      else if (c.kind === 'spider') gone = this.stepSpider(c, dt);
      else if (c.kind === 'antlion') gone = this.stepAntlion(c, dt);
      else if (c.kind === 'anteater') gone = this.stepAnteater(c, dt);
      else if (c.kind === 'ladybug') gone = this.stepLadybug(c, dt);
      else gone = this.stepWorm(c, dt);
      if (gone) this.creatures.splice(i, 1);
    }
  }

  private stepBird(c: Creature, dt: number): boolean {
    const ground = this.surfaceTarget(c.x).y;
    if (c.state === 'arriving') {
      const dx = c.tx - c.x;
      c.dir = dx >= 0 ? 1 : -1;
      c.x += Math.sign(dx) * Math.min(Math.abs(dx), 150 * dt);
      const want = Math.abs(dx) < 120 ? ground - 4 : CASE_TOP + 60;
      c.y += (want - c.y) * Math.min(1, dt * 1.6);
      if (Math.abs(dx) < 3 && Math.abs(c.y - (ground - 4)) < 6) {
        c.state = 'pecking';
        c.timer = 14 + Math.random() * 10;
        c.y = ground - 4;
        c.vx = 0;
      }
      this.scatterAnts(c.x, c.y, 120, 1.3);
      return false;
    }
    if (c.state === 'pecking') {
      c.y = this.surfaceTarget(c.x).y - 4;
      // hops along the ground toward the nearest foragers
      c.vx = 0;
      let nearest: Ant | null = null;
      let best = 160;
      this.forAntsNear(c.x, c.y, 160, (a) => {
        if (!this.isOutside(a.x, a.y)) return;
        const d = Math.abs(a.x - c.x);
        if (d < best) {
          best = d;
          nearest = a;
        }
      });
      if (nearest) {
        const n = nearest as Ant;
        c.dir = n.x >= c.x ? 1 : -1;
        if (Math.abs(n.x - c.x) > 14) {
          c.x += c.dir * 32 * dt;
          c.vx = c.dir * 32;
        }
      }
      this.scatterAnts(c.x, c.y, 90, 1.3);
      if (Math.floor(c.phase * 0.62) !== Math.floor((c.phase - dt) * 0.62)) {
        const got = Math.random() < 0.35 ? this.snatchAnt(c.x + c.dir * 8, c.y + 4, 20) : null;
        if (got) this.log('A bird snatched a forager', 'danger');
        this.spark(c.x + c.dir * 8, c.y + 4, '#fcd34d');
      }
      c.hits += this.defendersNear(c.x, c.y, 30) > 2 ? dt * 0.6 : 0;
      if (c.timer <= 0 || c.hits > 4) {
        c.state = 'leaving';
        c.dir = c.x < (CASE_LEFT + CASE_RIGHT) / 2 ? -1 : 1;
        if (c.hits > 4) this.log('Soldiers drove the bird off', 'good');
      }
      return false;
    }
    c.x += c.dir * 170 * dt;
    c.y -= 70 * dt;
    return c.x < CASE_LEFT - 30 || c.x > CASE_RIGHT + 30 || c.y < CASE_TOP - 40;
  }

  private stepSpider(c: Creature, dt: number): boolean {
    c.life = (c.life ?? 600) - dt;
    c.y = this.surfaceTarget(c.x).y;
    // foragers wander into the web; the spider darts out and wraps one now and then
    c.vy = Math.max(0, c.vy - dt);
    if (c.state === 'waiting') {
      if (c.vy <= 0 && Math.random() < dt * 0.25) {
        const victim = this.snatchAnt(c.x, c.y - 8, 22);
        if (victim) {
          c.state = 'wrapping';
          c.timer = 4;
          c.vy = 40 + Math.random() * 40;
          this.log('A forager was caught in a spider web', 'danger');
        }
      }
    } else if (c.timer <= 0) c.state = 'waiting';
    c.hits += this.defendersNear(c.x, c.y, 36) >= 5 ? dt * 0.5 : 0;
    if (c.hits > 3) {
      this.log('A crowd of ants drove the spider away', 'good');
      return true;
    }
    return c.life <= 0;
  }

  private stepAntlion(c: Creature, dt: number): boolean {
    c.life = (c.life ?? 600) - dt;
    c.y = this.surfaceTarget(c.x).y;
    if (c.state === 'flinging' && c.timer <= 0) c.state = 'lurking';
    c.vy = Math.max(0, c.vy - dt);
    if (c.vy <= 0 && Math.random() < dt * 0.3) {
      const a = this.snatchAnt(c.x, c.y, 9);
      if (a) {
        c.state = 'flinging';
        c.timer = 2.2;
        c.vy = 30 + Math.random() * 40;
        this.log('An ant slid into the antlion pit', 'danger');
      }
    }
    return c.life <= 0;
  }

  /**
   * A ladybird patrols the plants and eats aphids. It is harmless to the ants and they ignore it (it is not a threat,
   * so nobody attacks it); it only costs the colony some of its honeydew herd, which slowly breeds back.
   */
  private stepLadybug(c: Creature, dt: number): boolean {
    c.life = (c.life ?? 600) - dt;
    const ground = this.surfaceTarget(c.x).y - 1;
    if (c.state === 'flying') {
      const dx = c.tx - c.x;
      c.dir = dx >= 0 ? 1 : -1;
      c.x += Math.sign(dx) * Math.min(Math.abs(dx), 70 * dt);
      c.y += (ground - c.y) * Math.min(1, dt * 0.9);
      if (Math.abs(dx) < 2 && c.y > ground - 3) {
        c.state = 'roaming';
        c.timer = 3;
      }
      return false;
    }
    if (c.life <= 0 || this.season === 'Winter') {
      c.state = 'leaving';
    }
    if (c.state === 'leaving') {
      c.x += c.dir * 60 * dt;
      c.y -= 30 * dt;
      return c.x < CASE_LEFT - 20 || c.x > CASE_RIGHT + 20 || c.y < CASE_TOP;
    }
    if (c.state === 'eating') {
      if (c.timer <= 0) c.state = 'roaming';
      return false;
    }
    // choose a hunting target: the nearest aphid, as long as a breeding stock is left
    let target: Aphid | null = null;
    let best = 260;
    c.vy = Math.max(0, c.vy - dt);
    if (this.aphids.length > 6 && c.vy <= 0) {
      for (const a of this.aphids) {
        const d = Math.abs(a.x - c.x);
        if (d < best) {
          best = d;
          target = a;
        }
      }
    }
    let goalY = ground;
    if (target) {
      const t = target as Aphid;
      const dx = t.x - c.x;
      c.dir = dx >= 0 ? 1 : -1;
      goalY = Math.abs(dx) < 14 ? t.y : ground;
      if (Math.abs(dx) > 3) c.x += c.dir * 11 * dt;
      else if (Math.abs(c.y - t.y) < 3) {
        c.state = 'eating';
        c.timer = 3 + Math.random() * 2;
        c.vy = 35 + Math.random() * 35; // full for a while
        this.aphids.splice(this.aphids.indexOf(t), 1);
        this.spark(t.x, t.y, '#ef4444');
      }
    } else {
      // wander: walk, turn around now and then, stop to preen
      if (c.timer <= 0) {
        c.timer = 4 + Math.random() * 8;
        c.dir = Math.random() < 0.5 ? 1 : -1;
        c.vx = Math.random() < 0.3 ? 0 : 8;
      }
      c.x += c.dir * c.vx * dt;
      if (c.x < CASE_LEFT + 60) c.dir = 1;
      if (c.x > CASE_RIGHT - 60) c.dir = -1;
    }
    c.y += (goalY - c.y) * Math.min(1, dt * 3);
    return false;
  }

  private stepAnteater(c: Creature, dt: number): boolean {
    const ground = this.surfaceTarget(c.x).y;
    c.y = ground;
    const edgeX = c.dir > 0 ? CASE_RIGHT + 40 : CASE_LEFT - 40;
    if (c.state === 'approach') {
      const dx = c.tx - c.x;
      c.dir = dx >= 0 ? 1 : -1;
      c.x += Math.sign(dx) * Math.min(Math.abs(dx), 24 * dt);
      c.vx = c.dir * 24;
      if (Math.abs(dx) < 2) {
        c.state = 'digging';
        c.timer = 22;
        c.vx = 0;
      }
      this.scatterAnts(c.x, c.y, 70, 1.2);
      return false;
    }
    if (c.state === 'digging') {
      this.shake = Math.max(this.shake, 0.35);
      this.scatterAnts(c.x, c.y, 60, 1.2);
      if (Math.floor(c.phase * 0.5) !== Math.floor((c.phase - dt) * 0.5)) {
        // long sticky tongue flicks out at the foragers streaming from the nest
        const got = Math.random() < 0.6 ? this.snatchAnt(c.x + c.dir * 40, c.y, 34) : null;
        if (got) this.log('The anteater licked up an ant', 'danger');
      }
      if (Math.floor(c.phase * 0.25) !== Math.floor((c.phase - dt) * 0.25)) {
        // claws rake the mound over the entrance
        const gx0 = Math.floor((c.x + c.dir * 18) / CELL_SIZE);
        for (let gx = gx0 - 2; gx <= gx0 + 2; gx++) {
          const sg = Math.floor(this.grid.surfaceY[clamp(gx, 0, GRID_W - 1)] / CELL_SIZE);
          for (let gy = sg + 1; gy < sg + 7; gy++) {
            const i = gy * GRID_W + gx;
            if (this.grid.terrain[i] === CellType.TUNNEL && Math.random() < 0.3) {
              this.collapseAt(gx, gy, 'anteater', this.cellInUse(i), 2);
              this.lastCollapseTime = this.simTime;
              break;
            }
          }
        }
        this.shake = Math.max(this.shake, 0.7);
      }
      c.hits += this.defendersNear(c.x + c.dir * 20, c.y, 30) >= 4 ? dt * 0.4 : 0;
      if (c.timer <= 0 || c.hits > 3) {
        c.state = 'leaving';
        c.dir = c.x < (CASE_LEFT + CASE_RIGHT) / 2 ? -1 : 1;
        this.log(c.hits > 3 ? 'Biting soldiers drove the anteater away' : 'The anteater wanders off', c.hits > 3 ? 'good' : undefined);
      }
      return false;
    }
    c.x += c.dir * 30 * dt;
    c.vx = c.dir * 30;
    return Math.abs(c.x - edgeX) < 4 || c.x < CASE_LEFT + 6 || c.x > CASE_RIGHT - 6;
  }

  private stepWorm(c: Creature, dt: number): boolean {
    const trail = (c.trail ??= []);
    if (c.state === 'burrowing') {
      const step = 7 * dt;
      c.x += c.dir * step;
      c.y += Math.sin(c.phase * 0.7) * 3 * dt;
      c.left = (c.left ?? 0) - step;
      const gx = Math.floor(c.x / CELL_SIZE);
      const gy = Math.floor(c.y / CELL_SIZE);
      // the burrow is about two cells tall
      for (let oy = -1; oy <= 0; oy++) {
        if (!this.grid.inBounds(gx, gy + oy)) continue;
        const i = this.grid.idx(gx, gy + oy);
        if (this.canExcavate(i)) {
          this.grid.setTerrain(gx, gy + oy, CellType.TUNNEL);
          this.grid.updateSurfaceColumn(gx);
          this.fieldDirty.dig = true;
        }
      }
      if (gx < 12 || gx > GRID_W - 12 || this.grid.terrain[this.grid.idx(gx, gy)] === CellType.PEBBLE) c.left = 0;
      if (trail.length === 0 || Math.hypot(trail[0].x - c.x, trail[0].y - c.y) > 4) {
        trail.unshift({ x: c.x, y: c.y });
        if (trail.length > 9) trail.pop();
      }
      // ants that meet it just stop and feel it with their antennae
      if (Math.random() < dt * 2) this.scatterWormEncounter(c);
      if ((c.left ?? 0) <= 0) {
        c.state = 'leaving';
        c.timer = 6;
      }
      return false;
    }
    // slips off down a side shaft: the body shrinks away into the burrow
    if (trail.length > 0 && Math.random() < dt * 2.5) trail.pop();
    return trail.length === 0 || c.timer <= -8;
  }

  private scatterWormEncounter(c: Creature): void {
    this.forAntsNear(c.x, c.y, 18, (a) => {
      if (a.caste === AntCaste.QUEEN || a.payload !== PayloadType.NONE || BUSY_TASKS.has(a.task) || a.flying || a.buried !== undefined) return;
      a.task = AntTask.GREETING;
      a.stateTimer = 1.5 + Math.random() * 1.5;
      a.angle = Math.atan2(c.y - a.y, c.x - a.x);
      this.stopMoving(a);
    });
  }

  private makeRival(x: number, behavior: Intruder['behavior'], edge: 'left' | 'right', opts: { holdPost?: number } = {}): void {
    const p = this.surfaceTarget(x);
    const maxHp = 55;
    this.intruders.push({
      id: this.allocId(),
      x: p.x,
      y: p.y - 1,
      vx: 0,
      vy: 0,
      angle: edge === 'left' ? 0 : Math.PI,
      hp: maxHp,
      maxHp,
      legPhase: Math.random() * Math.PI * 2,
      species: 'rival_ant',
      aggression: 1,
      attackCooldown: 0,
      behavior,
      carryingFoodAmount: 0,
      targetFoodId: null,
      homeEdge: edge,
      path: [],
      pathIndex: 0,
      lastPathTime: -10,
      warrior: true,
      holdPost: opts.holdPost,
    });
  }

  private stepWar(dt: number): void {
    const w = this.war;
    const season = this.season === 'Summer' ? 1.3 : this.season === 'Spring' ? 1 : this.season === 'Autumn' ? 0.8 : 0;
    if (w.phase === 'peace') {
      this.warPressure = Math.max(0, this.warPressure - dt / 600);
      if (this.ants.length > 25 && !this.isNight()) w.tension += (dt * season) / 1800;
      if (w.tension < 1) return;
      w.phase = 'war';
      w.wave = 0;
      w.waves = 3 + Math.floor(Math.random() * 3);
      w.nextWave = 8;
      w.kills = 0;
      w.lost = 0;
      w.raid = null;
      w.raidDone = false;
      w.edge = Math.random() < 0.5 ? 'left' : 'right';
      this.log('The neighbouring colony has declared war!', 'danger');
      return;
    }

    const warriors = this.intruders.filter((m) => m.warrior && m.holdPost === undefined).length;
    w.nextWave -= dt;
    if (w.wave < w.waves && w.nextWave <= 0 && warriors < 10) {
      const n = 3 + w.wave + Math.floor(Math.random() * 2);
      const edge = w.edge;
      const sign = edge === 'left' ? 1 : -1;
      const x0 = edge === 'left' ? CASE_LEFT + 78 : CASE_RIGHT - 78;
      for (let k = 0; k < n; k++) {
        const behavior: Intruder['behavior'] = k === 0 ? 'infiltrating_brood' : k % 3 === 1 ? 'hunting_ants' : 'raiding_food';
        this.makeRival(x0 + sign * k * 10, behavior, edge);
      }
      w.wave++;
      w.nextWave = 70 + Math.random() * 40;
      this.log(w.wave === w.waves ? `Final assault: ${n} enemy soldiers storm in` : `Wave ${w.wave} of the war: ${n} enemy soldiers advance`, 'danger');
    }

    // counter-raid: our soldiers march out against the rival nest
    const raid = w.raid;
    if (!raid && !w.raidDone && w.wave >= 2) {
      const soldiers = this.ants.filter((a) => a.caste === AntCaste.SOLDIER && !this.isAlate(a) && (a.hp ?? 0) > 20);
      if (soldiers.length >= 3) {
        const x = w.edge === 'left' ? CASE_LEFT + 78 : CASE_RIGHT - 78;
        w.raid = { x, t: 0, spawned: false };
        for (const a of soldiers.slice(0, 8)) a.warBand = true;
        this.log('Soldiers march out to strike back at the rival nest', 'good');
      } else w.raidDone = true;
    }
    if (w.raid) {
      const r = w.raid;
      r.t += dt;
      const band = this.ants.filter((a) => a.warBand);
      if (!r.spawned && band.some((a) => Math.abs(a.x - r.x) < 170 && this.isOutside(a.x, a.y))) {
        r.spawned = true;
        const sign = w.edge === 'left' ? -1 : 1;
        for (let k = 0; k < 4; k++) this.makeRival(r.x + sign * k * 9, 'hunting_ants', w.edge, { holdPost: r.x });
        this.log('The raiders reach the rival nest: its defenders swarm out', 'danger');
      }
      const defenders = this.intruders.filter((m) => m.holdPost !== undefined).length;
      const won = r.spawned && defenders === 0;
      if (won || r.t > 220 || band.length === 0) {
        for (const a of band) a.warBand = false;
        w.raid = null;
        w.raidDone = true;
        if (won) {
          this.dropFoodAt(this.entrancePos.x + 60, this.surfaceTarget(this.entrancePos.x + 60).y - 1, PayloadType.PROTEIN, 70);
          this.log('The raid succeeded: the soldiers return with captured spoils', 'good');
          w.kills += 2;
        } else this.log('The raid fell apart', 'danger');
      }
    }

    // the war ends once every wave is spent and the field is clear
    if (w.wave >= w.waves && warriors === 0 && !w.raid) {
      const defeat = w.lost > w.kills * 1.2 + 2;
      if (defeat) {
        this.warPressure = 1.2;
        let plundered = 0;
        for (const f of this.foods) if (f.storedInChamberId !== null) {
          const take = f.amount * 0.25;
          f.amount -= take;
          plundered += take;
        }
        this.log(`The colony lost the war: ${Math.round(plundered)} units of stored food were plundered`, 'danger');
        w.tension = 0.3;
      } else {
        this.log(`The rival colony is beaten back (${w.kills} enemy soldiers fell, ${w.lost} of ours)`, 'good');
        w.tension = 0;
      }
      w.phase = 'peace';
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
      if (!m.warrior && (m.age > 80 || (m.age > 20 && this.countAntsNear(m.x, m.y, 26) >= (m.species === 'beetle' ? 7 : 5)))) m.behavior = 'retreating';
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
        } else if (m.holdPost !== undefined) {
          // defenders mill about their own nest entrance
          goalX = m.holdPost + Math.sin(this.simTime * 0.6 + m.id) * 22;
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
        // a straight line jams on boulders and tunnel corners, so follow a real route and re-plan as the prey moves
        if ((!m.path || (m.pathIndex ?? 0) >= m.path.length) && this.pathBudget > 0 && this.simTime - (m.lastPathTime ?? -10) > 0.5) {
          this.pathBudget--;
          m.lastPathTime = this.simTime;
          const route = this.grid.findPath({ x: m.x, y: m.y }, directTarget, { maxIterations: 2500 });
          m.path = route.length > 10 ? route.slice(0, 10) : route;
          m.pathIndex = 0;
        }
        const wp = m.path && (m.pathIndex ?? 0) < m.path.length ? m.path[m.pathIndex ?? 0] : directTarget;
        this.moveIntruderToward(m, wp.x, wp.y, speed, dt);
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

      this.unstickIntruder(m, dt, goalX, directTarget !== null || fieldKey !== null);

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
          if (m.warrior && this.war.phase === 'war') this.war.kills++;
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

  /**
   * Watchdog for invaders that have a destination but are going nowhere (wedged behind a stone, a lip of soil or each
   * other). After a few seconds it forgets its route and hops to the nearest open ground toward the goal; if that
   * does not help either, it gives up and heads home.
   */
  private unstickIntruder(m: Intruder, dt: number, goalX: number, underground: boolean): void {
    const idle = m.warrior && m.holdPost !== undefined && !m.roamed;
    const fighting = m.attackCooldown > 0 || this.countAntsNear(m.x, m.y, 16) > 0;
    const sx = m.stuckX ?? m.x;
    const sy = m.stuckY ?? m.y;
    if (idle || fighting || Math.hypot(m.x - sx, m.y - sy) > 4 || (!underground && Math.abs(goalX - m.x) <= 6)) {
      m.stuckX = m.x;
      m.stuckY = m.y;
      m.stuckFor = 0;
      return;
    }
    m.stuckFor = (m.stuckFor ?? 0) + dt;
    if (m.stuckFor < 3) return;
    m.path = [];
    m.pathIndex = 0;
    m.lastPathTime = -10;
    const g = this.grid.worldToGrid(m.x + (goalX >= m.x ? 12 : -12), m.y - 6);
    const hop = this.grid.findNearestNavigable(g.gx, g.gy, 6);
    if (hop) {
      const w = this.grid.gridToWorld(hop.gx, hop.gy);
      m.x = w.x;
      m.y = w.y;
    }
    m.stuckX = m.x;
    m.stuckY = m.y;
    m.stuckFor = (m.stuckFor ?? 0) > 9 ? 0 : 1.5;
    m.stuckStrikes = (m.stuckStrikes ?? 0) + 1;
    if (m.stuckStrikes >= 3 && !m.warrior) m.behavior = 'retreating';
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
      if (this.pinned(a)) continue;
      this.forAntsNear(a.x, a.y, 11, (b) => {
        if (b.id <= a.id || this.pinned(b)) return;
        if (a.trophallaxisPartnerId === b.id) return;
        // tandem pairs and carriers are supposed to touch
        if (a.tandemLeaderId === b.id || b.tandemLeaderId === a.id || a.carryingAntId === b.id || b.carryingAntId === a.id) return;
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
      this.forAntsNear(m.x, m.y, standoff, (a) => {
        if (!this.pinned(a)) nudgePair(a, m, standoff, 0.65);
      });
    }
  }

  /** ants whose position is dictated by something else (carried, buried, airborne, gripping prey, hanging replete) */
  private pinned(a: Ant): boolean {
    return a.carriedById != null || a.buried !== undefined || !!a.flying || a.replete !== undefined || a.task === AntTask.GROUP_TRANSPORT;
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

  private killAnt(index: number, cause: 'age' | 'combat' | 'starvation' | 'buried'): void {
    const ant = this.ants[index];
    this.releasePayload(ant);
    this.unlinkAnt(ant);
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
    if (cause === 'combat' && this.war.phase === 'war') this.war.lost++;
    // nestmates stop to inspect the body (ants recognise death by the fatty acids a corpse gives off) before the
    // undertakers carry it off; they don't dawdle in the middle of a fight
    if (this.intruders.length === 0) {
      let paused = 0;
      this.forAntsNear(fx, fy, 30, (a) => {
        if (a.id === ant.id || a.caste === AntCaste.QUEEN || a.payload !== PayloadType.NONE || a.carriedById != null || a.buried !== undefined || a.flying || BUSY_TASKS.has(a.task)) return;
        a.task = AntTask.GREETING;
        a.stateTimer = 2 + Math.random() * 2.5;
        a.angle = Math.atan2(fy - a.y, fx - a.x);
        this.stopMoving(a);
        return ++paused >= 4;
      });
    }
    this.ants.splice(index, 1);
    if (ant.caste === AntCaste.QUEEN) this.log('The queen has died! The colony cannot raise new workers', 'danger');
    else if (cause === 'buried') this.log('A buried worker suffocated before it could be dug out', 'danger');
    else if (cause === 'combat') this.log(`${/^[aeiou]/i.test(ant.caste) ? 'An' : 'A'} ${ant.caste.toLowerCase()} fell defending the colony`, 'danger');
    else if (cause === 'starvation') this.log(this.storedFoodCache < 10 ? 'A worker starved: the stores are empty' : 'A worker starved', 'danger');
  }

  /** Drop whatever is carried (brood goes back on the floor, food lands where the ant stands). */
  private releasePayload(ant: Ant): void {
    if (ant.payloadId !== null) {
      if (ant.payload === PayloadType.DEBRIS) {
        const d = this.debris.find((dd) => dd.id === ant.payloadId);
        if (d) d.carriedById = null;
      } else if (ant.payload === PayloadType.REFUSE) {
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

  private stepAnts(stepDt: number): void {
    const isNight = this.isNight();
    const goodWeather = this.forageWeather();
    // When the larder is bare, hungry colonies gamble on marginal weather (but never a downpour, snow or frost).
    const desperate =
      this.storedFoodCache < 15 && this.rainIntensity() < 1 && this.weather !== 'Snow' && this.surfaceTempC > 7 && this.surfaceTempC < 44;
    const floodY = this.floodLineY();
    for (let i = this.ants.length - 1; i >= 0; i--) {
      const ant = this.ants[i];
      // Ectotherms: everything an ant does (walking, working, burning food, even ageing) runs at the pace the
      // local temperature allows. Wading through floodwater slows them further.
      let act = this.activityAt(ant.x, ant.y);
      if (this.floodDepth > 0 && ant.y > floodY && !this.isOutside(ant.x, ant.y)) act *= 0.45;
      const dt = stepDt * act;
      {
        const vg = this.grid.worldToGrid(ant.x, ant.y);
        this.lastVisit[this.grid.idx(vg.gx, vg.gy)] = this.simTime;
      }
      // A third of the foragers are the night shift; the rest stay in after dark. Bad weather keeps everyone in.
      const nerve = ant.bold ?? 0.5;
      const braveEnough = nerve > 0.72 && this.rainIntensity() < 0.5 && this.weather !== 'Snow' && this.surfaceTempC > 5 && this.surfaceTempC < 42;
      const night = (isNight && !(ant.id % 3 === 0 || nerve > 0.7)) || (!goodWeather && !desperate && !braveEnough);
      ant.age += dt;
      ant.greetCooldown = Math.max(0, ant.greetCooldown - dt);
      ant.signalCooldown = Math.max(0, (ant.signalCooldown ?? 0) - dt);
      ant.attackCd = Math.max(0, (ant.attackCd ?? 0) - dt);
      ant.antennaPhase += dt * (ant.task === AntTask.TROPHALLAXIS || ant.task === AntTask.GREETING || ant.task === AntTask.SIGNALING_FOOD ? 18 : 8);
      if (ant.isCallow) {
        ant.callowTimer -= dt;
        if (ant.callowTimer <= 0) ant.isCallow = false;
      }

      // shut in by bad weather the colony goes quiescent and burns far less food (how real nests ride out storms)
      const quiescence = goodWeather || desperate ? 1 : 0.3;
      ant.hunger = clamp(ant.hunger + dt * quiescence * (ant.caste === AntCaste.QUEEN ? 0.22 : ant.task === AntTask.IDLE ? 0.06 : 0.11), 0, 100);
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

      // --- special states: carried, buried, airborne, living honeypot ------------------------------------------
      if (ant.carriedById != null) {
        this.stepCarried(ant);
        if (ant.carriedById != null) continue;
      }
      if (ant.buried !== undefined) {
        if (!this.stepBuried(ant, i, dt) || ant.buried !== undefined) continue;
      }
      if (ant.flying) {
        this.stepFlying(ant, i, stepDt);
        continue;
      }
      if (ant.replete !== undefined) {
        this.stepReplete(ant, dt);
        continue;
      }
      if (ant.task === AntTask.GROUP_TRANSPORT && ant.targetId != null && this.foods.some((f) => f.id === ant.targetId && f.large)) {
        continue; // moved with the prey in stepGroupTransport
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

      if (fight !== 'moving' && (this.stepRescuer(ant, dt) || this.stepTandem(ant, dt))) {
        this.syncCarried(ant);
        continue;
      }
      if (fight !== 'moving' && this.stepCarryingNestmate(ant)) {
        this.moveAnt(ant, dt);
        continue;
      }

      if (fight !== 'moving') {
        // --- casual greeting between passing nestmates -----------------------------------------------------------
        if (ant.payload === PayloadType.NONE && ant.greetCooldown <= 0 && Math.random() < dt * (0.15 + (ant.social ?? 0.5) * 0.5) && this.intruders.length === 0) {
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
            // ...or one grooms the other clean (allogrooming), especially foragers back from outside
            const groom = !share && Math.random() < ((ant.excursion ?? 0) === 0 && ant.caste === AntCaste.WORKER ? 0.45 : 0.25);
            for (const [p, q] of [[ant, o], [o, ant]] as const) {
              p.task = share ? AntTask.TROPHALLAXIS : groom ? AntTask.ALLOGROOMING : AntTask.GREETING;
              p.stateTimer = share ? 1.8 : groom ? 2.6 : 0.7;
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

        if (this.isAlate(ant)) this.stepAlate(ant, dt);
        else if (this.tryCluster(ant)) {
          /* overwintering */
        } else if (ant.caste === AntCaste.WORKER) this.stepForager(ant, dt, night);
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
    const nerve = ant.bold ?? 0.5;
    if (!soldier && big && !inside && bestD > 16 && nerve < 0.85) {
      // flee from big predators out in the open; shy ants bolt from further away
      if (bestD > 30 + (1 - nerve) * 36) return 'none';
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
      // queens sleep in fewer, longer bouts than workers' hundreds of short naps
      if (Math.random() < 0.15) {
        ant.stateTimer = 15 + Math.random() * 25;
        this.stopMoving(ant);
        return;
      }
      ant.stateTimer = 3 + Math.random() * 4;
      this.goTo(ant, royal.x + (Math.random() - 0.5) * royal.rx * 0.7, royal.y + royal.ry * 0.3);
    }
  }

  // ================================================================================================================
  // Soil stability: tunnels settle, slump and cave in for the reasons real nests do
  // ================================================================================================================

  /** Has an ant been near this cell recently, or does the chamber around it hold brood or food? */
  private cellInUse(i: number): boolean {
    const gx = i % GRID_W;
    const gy = (i - gx) / GRID_W;
    const recent = this.simTime - 240;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const x = gx + dx;
        const y = gy + dy;
        if (x < 0 || y < 0 || x >= GRID_W || y >= GRID_H) continue;
        if (this.lastVisit[y * GRID_W + x] > recent) return true;
      }
    }
    const wx = (gx + 0.5) * CELL_SIZE;
    const wy = (gy + 0.5) * CELL_SIZE;
    const c = this.chambers.find((ch) => Math.hypot((wx - ch.x) / ch.rx, (wy - ch.y) / ch.ry) < 1.15);
    if (!c) return false;
    if (c.type === ChamberType.ROYAL) return true;
    return this.brood.some((b) => b.chamberId === c.id) || this.foods.some((f) => f.storedInChamberId === c.id);
  }

  /** Width of the open space this cell's roof has to span (wide unsupported roofs sag). */
  private roofSpan(gx: number, gy: number): number {
    let n = 1;
    for (let x = gx - 1; x >= 0 && n < 16 && this.grid.terrain[gy * GRID_W + x] === CellType.TUNNEL; x--) n++;
    for (let x = gx + 1; x < GRID_W && n < 16 && this.grid.terrain[gy * GRID_W + x] === CellType.TUNNEL; x++) n++;
    return n;
  }

  private stepStructure(dt: number): void {
    // a heavy animal (or a person) crossing the ground above shakes shallow galleries loose
    this.shake = Math.max(0, this.shake - dt * 1.5);
    this.footstepTimer -= dt;
    if (this.footstepTimer <= 0) {
      this.footstepTimer = 900 + Math.random() * 1500;
      // (no giant footsteps: the colony's only visitors are wildlife)
    }

    this.structTimer -= dt;
    if (this.structTimer > 0) return;
    this.structTimer = 1;

    // freeze-thaw: ice lenses heave the soil apart; when it thaws the loosened ceilings crumble
    if (this.surfaceTempC < -0.5) this.frozen = true;
    else if (this.frozen && this.surfaceTempC > 1.5) {
      this.frozen = false;
      this.thawStress = 1;
      this.log('Thaw: frost-loosened soil starts crumbling into the shallow tunnels', 'danger');
    }
    this.thawStress = Math.max(0, this.thawStress - 1 / 900);

    this.maintenanceTimer -= 1;
    if (this.maintenanceTimer <= 0) {
      this.maintenanceTimer = 10;
      this.surveyNest();
    }

    if (this.simTime - this.lastCollapseTime < 4) return;
    // the colony can only take so much at once: with a big repair backlog only neglected galleries keep falling
    const overloaded = this.repairCount > 50;
    const rain = this.rainIntensity();
    const drought = this.climate.humidity < 0.4 && this.wetness < 0.05 && this.surfaceTempC > 26;
    const queen = this.getQueen();
    const royal = this.chambers.filter((c) => c.type === ChamberType.ROYAL);
    // assess every roofed gallery cell; each has a small chance per second of giving way
    let total = 0;
    const risks: { i: number; r: number; cause: CollapseCause; inUse: boolean; stress: number }[] = [];
    for (const i of this.roofCells) {
      if (this.grid.terrain[i] !== CellType.TUNNEL) continue;
      const roof = this.grid.terrain[i - GRID_W];
      if (roof !== CellType.TOPSOIL && roof !== CellType.SUBSOIL && roof !== CellType.DEEP_CLAY && roof !== CellType.ROOT) continue;
      const gx = i % GRID_W;
      const gy = (i - gx) / GRID_W;
      const depth = gy * CELL_SIZE - this.grid.surfaceY[gx];
      if (depth < 6) continue;
      const wx = (gx + 0.5) * CELL_SIZE;
      const wy = (gy + 0.5) * CELL_SIZE;
      if (royal.some((c) => Math.hypot((wx - c.x) / c.rx, (wy - c.y) / c.ry) < 1.25)) continue;
      if (queen && Math.hypot(queen.x - wx, queen.y - wy) < 30) continue;

      const moist = this.grid.moisture[i - GRID_W];
      // loose topsoil and roots hold least; dense clay best, until it is waterlogged
      const soilK = roof === CellType.TOPSOIL ? 1.6 : roof === CellType.DEEP_CLAY ? (moist > 0.75 ? 1.2 : 0.5) : roof === CellType.ROOT ? 0.7 : 1;
      const shallow = depth < 50 ? 1.6 : depth < 110 ? 1.15 : 1;
      let stress = 1;
      let cause: CollapseCause = 'settling';
      let top = 0;
      const add = (v: number, c: CollapseCause) => {
        if (v <= 0) return;
        stress += v;
        if (v > top && v > 0.8) {
          top = v;
          cause = c;
        }
      };
      // saturated soil loses its cohesion; rain soaking down from the surface hits the upper galleries hardest
      add(moist > 0.55 ? (moist - 0.55) * 7 : 0, 'saturation');
      add(rain * (depth < 160 ? 6 : 1.5), 'rain');
      add(drought && depth < 80 && moist < 0.15 ? 2.2 : 0, 'drought');
      add(this.thawStress * (depth < 100 ? 7 : 1), 'thaw');
      const span = this.roofSpan(gx, gy);
      add(span > 6 ? (span - 6) * 0.35 : 0, 'span');
      const inUse = this.cellInUse(i);
      // nobody maintains an abandoned gallery: it silts up and slumps far sooner
      let neglect = 1;
      if (!inUse) {
        neglect = 4;
        if (stress < 2) cause = 'abandoned';
      } else if (overloaded) continue;
      const r = 0.00006 * soilK * shallow * stress * neglect;
      total += r;
      risks.push({ i, r, cause, inUse, stress });
    }
    if (total <= 0 || Math.random() > 1 - Math.exp(-total)) return;
    let pick = Math.random() * total;
    for (const c of risks) {
      pick -= c.r;
      if (pick > 0) continue;
      const gx = c.i % GRID_W;
      this.collapseAt(gx, (c.i - gx) / GRID_W, c.cause, c.inUse, 2 + Math.floor(Math.random() * Math.min(6, 1 + c.stress)));
      break;
    }
  }

  /** The roof over (gx, gy) falls in, filling up to `size` open cells; used galleries are flagged for repair. */
  private collapseAt(gx: number, gy: number, cause: CollapseCause, inUse: boolean, size: number): number {
    const queue: number[] = [gy * GRID_W + gx];
    const seen = new Set<number>(queue);
    let filled = 0;
    while (queue.length && filled < size) {
      const i = queue.shift()!;
      const cx = i % GRID_W;
      const cy = (i - cx) / GRID_W;
      if (this.grid.terrain[i] !== CellType.TUNNEL) continue;
      if (this.cellOccupied(cx, cy)) {
        // the fall usually just sends ants scrambling, but sometimes it lands right on one
        if (Math.random() > 0.3) continue;
        this.buryAntsAt(cx, cy);
      }
      const depth = cy * CELL_SIZE - this.grid.surfaceY[cx];
      this.grid.setTerrain(cx, cy, depth < 40 ? CellType.TOPSOIL : CellType.SUBSOIL);
      this.grid.moisture[i] = Math.max(this.grid.moisture[i], this.grid.moisture[i - GRID_W] ?? 0);
      if (inUse) {
        this.digPlan[i] = 2;
        this.repairCount++;
      }
      filled++;
      // debris spreads sideways along the gallery first, then down
      for (const n of [i - 1, i + 1, i + GRID_W, i - 1 + GRID_W, i + 1 + GRID_W]) {
        if (n >= 0 && n < N_CELLS && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    if (filled === 0) return 0;
    // just under the surface the ground above sags into the void: a small sinkhole
    const depth = gy * CELL_SIZE - this.grid.surfaceY[gx];
    if (depth < 24 && cause !== 'abandoned') {
      const sg = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
      for (const x of [gx - 1, gx, gx + 1]) {
        const si = sg * GRID_W + x;
        if (this.grid.terrain[si] === CellType.TOPSOIL && !this.cellOccupied(x, sg)) {
          this.grid.setTerrain(x, sg, CellType.AIR);
          this.grid.updateSurfaceColumn(x);
        }
      }
    }
    this.lastCollapseTime = this.simTime;
    this.counters.collapses++;
    this.fieldDirty.dig = true;
    for (const fk of STATIC_FIELDS) this.fieldDirty[fk] = true;
    const w = this.grid.gridToWorld(gx, gy);
    this.spawnCrumbs(w.x, w.y, '#4a3828', 4 + filled * 2);
    this.shake = Math.max(this.shake, Math.min(0.6, filled * 0.08));
    if (this.simTime - this.lastCollapseLog > 25 || filled >= 5) {
      this.lastCollapseLog = this.simTime;
      const msg: Record<CollapseCause, string> = {
        settling: 'A tunnel roof settled and slumped in',
        saturation: 'Waterlogged soil lost its grip: a gallery caved in',
        rain: 'Rain soaked through and a shallow tunnel collapsed',
        drought: 'Bone-dry soil crumbled and blocked a tunnel',
        thaw: 'Frost-heaved soil gave way as it thawed',
        span: 'A wide chamber roof sagged and fell',
        abandoned: 'A disused gallery silted up and fell in',
        footsteps: 'Heavy footsteps overhead caved in a shallow tunnel',
        anteater: 'The anteater\'s claws caved in the entrance tunnel',
      };
      this.log(msg[cause] + (inUse ? ': excavators move in to clear it' : ''), inUse ? 'danger' : 'info');
    }
    return filled;
  }

  /** Something heavy walks across the case lid / ground: shallow galleries under its feet crush. */
  private footsteps(): void {
    const x = CASE_LEFT + 80 + Math.random() * (CASE_RIGHT - CASE_LEFT - 160);
    const gx0 = Math.floor(x / CELL_SIZE);
    let hit = 0;
    for (let gx = gx0 - 6; gx <= gx0 + 6; gx++) {
      if (gx < 10 || gx >= GRID_W - 10) continue;
      const sg = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
      for (let gy = sg + 1; gy < sg + 9 && gy < GRID_H - 2; gy++) {
        const i = gy * GRID_W + gx;
        if (this.grid.terrain[i] !== CellType.TUNNEL || Math.random() > 0.35) continue;
        hit += this.collapseAt(gx, gy, 'footsteps', this.cellInUse(i), 2);
        this.lastCollapseTime = -999;
      }
    }
    this.lastCollapseTime = this.simTime;
    this.shake = 1;
    for (let k = 0; k < 14; k++) this.spawnCrumbs(x + (Math.random() - 0.5) * 70, this.surfaceTarget(x).y - 2, '#6b5640', 1);
    if (hit > 0) this.log('Heavy footsteps overhead! Shallow tunnels are crushed', 'danger');
    else this.log('The ground trembles under heavy footsteps overhead');
  }

  /**
   * Every few seconds: count the open nest, list neglected galleries that excavators can backfill with spoil, and
   * let the colony give up chambers nobody has used in a long time (they slump shut and are struck off).
   */
  private surveyNest(): void {
    let open = 0;
    const cands: number[] = [];
    const old = this.simTime - 400;
    this.roofCells = [];
    for (let i = GRID_W; i < N_CELLS - GRID_W; i++) {
      if (this.grid.terrain[i] !== CellType.TUNNEL) continue;
      open++;
      const roof = this.grid.terrain[i - GRID_W];
      if (roof !== CellType.TUNNEL && roof !== CellType.AIR && roof !== CellType.GLASS_WALL && roof !== CellType.PEBBLE) this.roofCells.push(i);
      if (this.lastVisit[i] > old || this.digPlan[i]) continue;
      const gx = i % GRID_W;
      const gy = (i - gx) / GRID_W;
      if (gy * CELL_SIZE - this.grid.surfaceY[gx] < 40) continue;
      if (cands.length < 400 && Math.random() < 0.3 && !this.cellInUse(i)) cands.push(i);
    }
    this.openCells = open;
    this.backfillTargets = cands.slice(0, 40);

    for (let k = this.chambers.length - 1; k >= 0; k--) {
      const c = this.chambers[k];
      if (c.type === ChamberType.ROYAL) continue;
      if (this.chambers.filter((o) => o.type === c.type).length <= 1) continue;
      let total = 0;
      let solid = 0;
      for (let gy = Math.floor((c.y - c.ry) / CELL_SIZE); gy <= Math.ceil((c.y + c.ry) / CELL_SIZE); gy++) {
        for (let gx = Math.floor((c.x - c.rx) / CELL_SIZE); gx <= Math.ceil((c.x + c.rx) / CELL_SIZE); gx++) {
          if (!this.grid.inBounds(gx, gy)) continue;
          const w = this.grid.gridToWorld(gx, gy);
          if (((w.x - c.x) / c.rx) ** 2 + ((w.y - c.y) / c.ry) ** 2 > 0.8) continue;
          total++;
          if (this.grid.terrain[gy * GRID_W + gx] !== CellType.TUNNEL) solid++;
        }
      }
      if (total > 0 && solid / total > 0.6 && !this.cellInUse(this.grid.idx(Math.floor(c.x / CELL_SIZE), Math.floor(c.y / CELL_SIZE)))) {
        this.chambers.splice(k, 1);
        for (const fk of STATIC_FIELDS) this.fieldDirty[fk] = true;
        this.log(`The colony abandoned a fallen-in ${c.type.toLowerCase()}`);
      }
    }
  }

  /** Real excavators often dump spoil into old, unused galleries instead of hauling it all the way up. */
  private tryBackfill(ant: Ant): boolean {
    if (ant.backfill === undefined) {
      if (this.backfillTargets.length === 0 || Math.random() > 0.5) {
        ant.backfill = -1;
        return false;
      }
      let best = -1;
      let bestD = 220;
      for (const i of this.backfillTargets) {
        const w = this.grid.gridToWorld(i % GRID_W, Math.floor(i / GRID_W));
        const d = Math.abs(w.x - ant.x) + Math.abs(w.y - ant.y);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      ant.backfill = best;
      if (best >= 0) this.backfillTargets.splice(this.backfillTargets.indexOf(best), 1);
    }
    const i = ant.backfill;
    if (i < 0) return false;
    if (this.grid.terrain[i] !== CellType.TUNNEL) {
      // it already fell in: take the soil up to the mound after all
      ant.backfill = -1;
      return false;
    }
    const gx = i % GRID_W;
    const gy = (i - gx) / GRID_W;
    const w = this.grid.gridToWorld(gx, gy);
    ant.task = AntTask.BACKFILLING;
    if (Math.hypot(w.x - ant.x, w.y - ant.y) > 9) {
      this.goPath(ant, w.x, w.y, 'backfill:' + i);
      if (ant.path.length === 0 && !ant.targetPos) ant.backfill = -1;
      return true;
    }
    // pack the pellets into the dead gallery, starting at the far end from the ant
    let placed = 0;
    for (const n of [i, i + 1, i - 1, i + GRID_W, i - GRID_W]) {
      if (placed >= Math.max(1, ant.payloadValue)) break;
      const nx = n % GRID_W;
      const ny = (n - nx) / GRID_W;
      if (this.grid.terrain[n] !== CellType.TUNNEL || this.digPlan[n] || this.cellOccupied(nx, ny)) continue;
      this.grid.setTerrain(nx, ny, CellType.SUBSOIL);
      placed++;
    }
    if (placed > 0) {
      this.counters.backfills++;
      this.spawnCrumbs(w.x, w.y, '#7c5836', 2);
      for (const fk of STATIC_FIELDS) this.fieldDirty[fk] = true;
    }
    ant.payload = PayloadType.NONE;
    ant.payloadValue = 0;
    ant.backfill = undefined;
    this.busy(ant, AntTask.GROOMING, 0.6);
    return true;
  }

  // ================================================================================================================
  // Extended real-ant behaviours
  // ================================================================================================================

  private isAlate(a: Ant): boolean {
    return a.caste === AntCaste.GYNE || a.caste === AntCaste.MALE;
  }

  private antById(id: number | null | undefined): Ant | undefined {
    if (id == null) return undefined;
    return this.ants.find((a) => a.id === id);
  }

  /** Clears every social link an ant holds (called when it dies or its errand is cancelled). */
  private unlinkAnt(ant: Ant): void {
    const carrier = this.antById(ant.carriedById);
    if (carrier) carrier.carryingAntId = null;
    const carried = this.antById(ant.carryingAntId);
    if (carried) {
      carried.carriedById = null;
      carried.task = AntTask.IDLE;
      carried.stateTimer = 4;
    }
    const leader = this.antById(ant.tandemLeaderId);
    if (leader) leader.tandemFollowerId = null;
    const follower = this.antById(ant.tandemFollowerId);
    if (follower) follower.tandemLeaderId = null;
    for (const a of this.aphids) if (a.tenderId === ant.id) a.tenderId = null;
    for (const d of this.debris) if (d.carriedById === ant.id) d.carriedById = null;
    ant.carriedById = null;
    ant.carryingAntId = null;
    ant.tandemLeaderId = null;
    ant.tandemFollowerId = null;
  }

  // --- tandem running ----------------------------------------------------------------------------------------------
  /**
   * A forager that found food teaches one nestmate the way: the follower keeps tapping the leader's gaster with
   * its antennae and the leader stops and waits whenever that contact breaks (Temnothorax-style tandem running).
   */
  private startTandem(leader: Ant): void {
    if (!leader.recruitFoodPos || leader.tandemFollowerId != null) return;
    let follower: Ant | null = null;
    this.forAntsNear(leader.x, leader.y, 60, (m) => {
      if (
        m.id !== leader.id &&
        m.caste === AntCaste.WORKER &&
        m.payload === PayloadType.NONE &&
        !m.recruitFoodPos &&
        m.tandemLeaderId == null &&
        m.carriedById == null &&
        !BUSY_TASKS.has(m.task)
      ) {
        follower = m;
        return true;
      }
    });
    if (!follower) return;
    const f = follower as Ant;
    leader.tandemFollowerId = f.id;
    leader.tandemTimer = 90;
    f.tandemLeaderId = leader.id;
    this.counters.tandems++;
  }

  /** Returns true if the ant is busy with a tandem run this step. */
  private stepTandem(ant: Ant, dt: number): boolean {
    if (ant.tandemLeaderId != null) {
      const leader = this.antById(ant.tandemLeaderId);
      if (!leader || leader.tandemFollowerId !== ant.id) {
        ant.tandemLeaderId = null;
        return false;
      }
      ant.task = AntTask.TANDEM_FOLLOWING;
      // stay at the leader's gaster
      const bx = leader.x - Math.cos(leader.angle) * 6;
      const by = leader.y - Math.sin(leader.angle) * 6;
      if (Math.hypot(bx - ant.x, by - ant.y) > 3) this.goTo(ant, bx, by);
      else this.stopMoving(ant);
      this.moveAnt(ant, dt);
      return true;
    }
    if (ant.tandemFollowerId != null) {
      const follower = this.antById(ant.tandemFollowerId);
      const rp = ant.recruitFoodPos;
      ant.tandemTimer = (ant.tandemTimer ?? 0) - dt;
      if (!follower || !rp || ant.tandemTimer <= 0 || ant.payload !== PayloadType.NONE) {
        if (follower) follower.tandemLeaderId = null;
        ant.tandemFollowerId = null;
        return false;
      }
      ant.task = AntTask.TANDEM_LEADING;
      if (Math.abs(ant.x - rp.x) < 14 && this.isOutside(ant.x, ant.y)) {
        // arrived: the follower has learned the route
        follower.recruitFoodPos = { x: rp.x, y: rp.y };
        follower.tandemLeaderId = null;
        ant.tandemFollowerId = null;
        return false;
      }
      // contact lost: wait for the follower to catch up and touch the gaster again
      if (Math.hypot(follower.x - ant.x, follower.y - ant.y) > 16) {
        this.stopMoving(ant);
        ant.pace = 0;
        return true;
      }
      if (this.isOutside(ant.x, ant.y)) {
        const t = this.surfaceTarget(rp.x);
        if (!ant.targetPos || Math.abs(ant.targetPos.x - t.x) > 4) this.goTo(ant, t.x, t.y);
      } else this.go(ant, 'surface');
      // tandem leaders walk slowly so the follower can keep up
      this.moveAnt(ant, dt * 0.6);
      return true;
    }
    return false;
  }

  // --- aphid farming -----------------------------------------------------------------------------------------------
  private seedAphids(): void {
    if (this.aphids.length > 0 || this.sprouts.length === 0) return;
    const hosts = this.sprouts.filter((s) => s.kind === 'clover' || s.kind === 'fern' || s.kind === 'grass');
    for (let k = 0; k < Math.min(4, hosts.length); k++) {
      const h = hosts[Math.floor(Math.random() * hosts.length)];
      for (let n = 0; n < 2 + Math.floor(Math.random() * 3); n++) {
        this.aphids.push({
          id: this.allocId(),
          x: h.x + (Math.random() - 0.5) * 6,
          y: h.y - 3 - Math.random() * Math.max(4, h.height * 0.6),
          honeydew: Math.random() * 6,
          tenderId: null,
          phase: Math.random() * 6.28,
        });
      }
    }
  }

  private stepAphids(dt: number): void {
    this.seedAphids();
    // aphids feed on plant sap and excrete honeydew; warm growing weather means more of it, winter none
    const rate = this.season === 'Winter' ? 0 : 0.35 * antActivity(this.surfaceTempC) * (this.rainIntensity() > 0.5 ? 0.3 : 1);
    // the herd breeds back (slowly) when it is small, so a hungry ladybird can't wipe it out for good
    if (rate > 0 && this.aphids.length > 0 && this.aphids.length < 16 && Math.random() < dt / 60) {
      const parent = this.aphids[Math.floor(Math.random() * this.aphids.length)];
      this.aphids.push({ ...parent, id: this.allocId(), x: parent.x + (Math.random() - 0.5) * 8, honeydew: 0, tenderId: null, phase: Math.random() * 6.28 });
    }
    for (const a of this.aphids) {
      a.honeydew = Math.min(12, a.honeydew + rate * dt);
      a.phase += dt;
      if (a.tenderId != null && !this.antById(a.tenderId)) a.tenderId = null;
    }
  }

  /** Foragers milk aphids: stroking them with their antennae until they release a honeydew droplet. */
  private tryTendAphids(ant: Ant): boolean {
    if (this.aphids.length === 0) return false;
    let best: Aphid | null = null;
    let bestD = 160;
    for (const a of this.aphids) {
      if (a.honeydew < 8 || (a.tenderId != null && a.tenderId !== ant.id)) continue;
      const d = Math.abs(a.x - ant.x) + Math.abs(a.y - ant.y);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    if (!best) return false;
    const a = best as Aphid;
    a.tenderId = ant.id;
    ant.task = AntTask.TENDING_APHIDS;
    if (Math.hypot(a.x - ant.x, a.y - ant.y) < 9) {
      // milk it: the droplet becomes the ant's load
      const drop = Math.min(10, a.honeydew);
      a.honeydew -= drop;
      a.tenderId = null;
      ant.payload = PayloadType.HONEYDEW;
      ant.payloadValue = drop;
      ant.recruitFoodPos = { x: a.x, y: a.y };
      this.busy(ant, AntTask.TENDING_APHIDS, 2.2);
      return true;
    }
    this.goTo(ant, a.x, a.y);
    return true;
  }

  // --- seed husking ------------------------------------------------------------------------------------------------
  /** Harvester ants strip the husks off stored seeds and dump the chaff on the midden. */
  private tryHuskSeed(ant: Ant): boolean {
    const g = this.nearestChamber(ChamberType.GRANARY, ant.x, ant.y);
    if (!g || !this.isInsideChamber(ant, g, 1.0)) return false;
    const seed = this.foods.find((f) => f.storedInChamberId === g.id && f.type === PayloadType.SEED && !f.husked && f.amount > 4);
    if (!seed) return false;
    if (Math.hypot(seed.x - ant.x, seed.y - ant.y) > 9) {
      ant.task = AntTask.HUSKING_SEED;
      this.goTo(ant, seed.x, seed.y);
      return true;
    }
    seed.husked = true;
    this.spawnCrumbs(seed.x, seed.y - 2, '#c9a86a', 4);
    this.busy(ant, AntTask.HUSKING_SEED, 3);
    ant.payload = PayloadType.CHAFF;
    ant.payloadValue = 0;
    return true;
  }

  private fungusStock(): number {
    const c = this.getChamber(ChamberType.FUNGUS);
    if (!c) return 0;
    let n = 0;
    for (const f of this.foods) if (f.storedInChamberId === c.id) n += f.amount;
    return n;
  }

  /** Leaf-cutters snip fragments off living plants and haul them down to be chewed into the fungus's compost. */
  private tryCutLeaf(ant: Ant, dt: number): boolean {
    if (ant.id % 8 !== 4 || !this.getChamber(ChamberType.FUNGUS)) return false;
    if (ant.leafTimer === undefined && this.fungusStock() > 90) return false;
    let plant: PlantSprout | null = null;
    let bestD = 260;
    for (const s of this.sprouts) {
      if (s.kind === 'moss' || (s.cut ?? 0) > 0.7) continue;
      const d = Math.abs(s.x - ant.x);
      if (d < bestD) {
        bestD = d;
        plant = s;
      }
    }
    if (!plant) {
      ant.leafTimer = undefined;
      return false;
    }
    const pl = plant as PlantSprout;
    ant.task = AntTask.CUTTING_LEAF;
    if (Math.abs(pl.x - ant.x) > 5) {
      ant.leafTimer = undefined;
      const t = this.surfaceTarget(pl.x);
      this.goTo(ant, t.x, t.y);
      return true;
    }
    if (ant.leafTimer === undefined) ant.leafTimer = 3 + Math.random() * 2.5;
    this.stopMoving(ant);
    ant.leafTimer -= dt;
    if (Math.random() < dt * 6) this.spawnCrumbs(ant.x, ant.y - 2, '#5fae45', 1);
    if (ant.leafTimer <= 0) {
      ant.leafTimer = undefined;
      pl.cut = Math.min(1, (pl.cut ?? 0) + 0.12);
      ant.payload = PayloadType.LEAF;
      ant.payloadValue = 1;
    }
    return true;
  }

  private carryLeaf(ant: Ant): void {
    ant.task = AntTask.CARRYING_LEAF;
    const fc = this.nearestChamber(ChamberType.FUNGUS, ant.x, ant.y);
    if (!fc) {
      this.releasePayload(ant);
      return;
    }
    const d = this.go(ant, 'fungus');
    if (d <= 0.5 || this.isInsideChamber(ant, fc, 0.6)) {
      const bed = this.foods.filter((f) => f.storedInChamberId === fc.id).sort((a, b) => a.amount - b.amount)[0];
      if (bed) bed.amount = Math.min(bed.maxAmount, bed.amount + 7);
      else
        this.foods.push({ id: this.allocId(), type: PayloadType.FUNGUS, x: fc.x, y: fc.y + 10, amount: 8, maxAmount: 50, radius: 7, storedInChamberId: fc.id });
      ant.payload = PayloadType.NONE;
      ant.payloadValue = 0;
      ant.task = AntTask.TENDING_FUNGUS;
      this.busy(ant, AntTask.TENDING_FUNGUS, 3 + Math.random() * 3);
    }
  }

  private carryChaff(ant: Ant): void {
    ant.task = AntTask.CARRYING_CHAFF;
    const d = this.go(ant, 'midden');
    if (d <= 0.5 || (this.isOutside(ant.x, ant.y) && Math.abs(ant.x - this.middenPos.x) < 26)) {
      this.spawnCrumbs(ant.x, ant.y, '#c9a86a', 3);
      ant.payload = PayloadType.NONE;
      ant.task = AntTask.FORAGING_SCOUT;
      this.stopMoving(ant);
    }
  }

  // --- repletes ----------------------------------------------------------------------------------------------------
  /**
   * Honeypot repletes: a few workers hang still in the granary and act as living storage jars, swelling with
   * liquid food when the colony has a surplus and regurgitating it back when stores run short.
   */
  private stepRepletes(dt: number): void {
    this.repleteTimer -= dt;
    if (this.repleteTimer > 0) return;
    this.repleteTimer = 4;
    const g = this.getChamber(ChamberType.GRANARY);
    if (!g) return;
    const repletes = this.ants.filter((a) => a.replete !== undefined);
    const workers = this.ants.filter((a) => a.caste === AntCaste.WORKER || a.caste === AntCaste.NURSE).length;
    const want = workers >= 40 ? Math.min(6, Math.floor(workers * 0.05)) : 0;
    if (repletes.length < want && this.storedFoodCache > 140) {
      // recruit a young, idle nurse: repletes are chosen while still soft-bodied enough to stretch
      let pick: Ant | null = null;
      for (const a of this.ants) {
        if (a.caste !== AntCaste.NURSE || a.payload !== PayloadType.NONE || a.targetId != null || a.carriedById != null) continue;
        if (!pick || a.age < pick.age) pick = a;
      }
      if (pick) {
        pick.replete = 0;
        pick.task = AntTask.REPLETE;
        this.stopMoving(pick);
        this.log('A young worker becomes a replete: a living honeypot for the granary', 'good');
      }
    }
    const piles = this.foods.filter((f) => f.storedInChamberId === g.id && f.type !== PayloadType.SEED);
    if (this.storedFoodCache > 160 && piles.length > 0) {
      // surplus liquid food is pumped into the emptiest replete
      const r = repletes.filter((a) => (a.replete ?? 0) < 1).sort((a, b) => (a.replete ?? 0) - (b.replete ?? 0))[0];
      const pile = piles.reduce((a, b) => (a.amount > b.amount ? a : b));
      if (r && pile.amount > 6) {
        pile.amount -= 6;
        r.replete = Math.min(1, (r.replete ?? 0) + 0.08);
      }
    } else if (this.storedFoodCache < 25) {
      // lean times: repletes regurgitate their stores back into the granary
      const r = repletes.filter((a) => (a.replete ?? 0) > 0.05).sort((a, b) => (b.replete ?? 0) - (a.replete ?? 0))[0];
      if (r) {
        r.replete = Math.max(0, (r.replete ?? 0) - 0.1);
        this.dropFoodAt(r.x, r.y + 3, PayloadType.HONEYDEW, 7.5);
        const f = this.foods[this.foods.length - 1];
        if (f && f.type === PayloadType.HONEYDEW) f.storedInChamberId = g.id;
        r.task = AntTask.TROPHALLAXIS;
        r.stateTimer = 2;
      }
    }
  }

  private stepReplete(ant: Ant, dt: number): void {
    const g = this.nearestChamber(ChamberType.GRANARY, ant.x, ant.y);
    ant.hunger = Math.max(0, ant.hunger - dt * 0.2); // feeds itself from its own crop
    if (g && !this.isInsideChamber(ant, g, 0.7)) {
      ant.task = AntTask.REPLETE;
      this.go(ant, 'granary');
      this.moveAnt(ant, dt * 0.5);
      return;
    }
    ant.stateTimer -= dt;
    if (ant.task === AntTask.TROPHALLAXIS && ant.stateTimer > 0) return;
    // hang from the granary ceiling, barely moving
    ant.task = AntTask.REPLETE;
    this.stopMoving(ant);
    ant.vx = 0;
    ant.vy = 0;
  }

  // --- cooperative transport ---------------------------------------------------------------------------------------
  /** A big carcass is too heavy for one ant: several grip it and drag it home together. */
  private tryGroupTransport(ant: Ant): boolean {
    let prey: FoodSource | null = null;
    let bestD = 160;
    for (const f of this.foods) {
      if (!f.large || f.storedInChamberId !== null || f.falling) continue;
      const d = Math.abs(f.x - ant.x) + Math.abs(f.y - ant.y) * 2;
      if (d < bestD) {
        bestD = d;
        prey = f;
      }
    }
    if (!prey) return false;
    const p = prey as FoodSource;
    const carriers = this.ants.filter((a) => a.targetId === p.id && a.task === AntTask.GROUP_TRANSPORT && a.id !== ant.id);
    if (carriers.length >= 4) return false;
    ant.task = AntTask.GROUP_TRANSPORT;
    if (Math.hypot(p.x - ant.x, p.y - ant.y) < p.radius + 6) {
      ant.targetId = p.id;
      this.stopMoving(ant);
    } else this.goTo(ant, p.x, p.y - 1);
    return true;
  }

  private stepGroupTransport(dt: number): void {
    for (const f of this.foods) {
      if (!f.large || f.storedInChamberId !== null || f.falling) continue;
      const team = this.ants.filter((a) => a.targetId === f.id && a.task === AntTask.GROUP_TRANSPORT && a.carriedById == null);
      if (team.length === 0) continue;
      const home = Math.abs(f.x - this.entrancePos.x) < Math.abs(f.x - SIDE_ENTRANCE_X) ? this.entrancePos.x : SIDE_ENTRANCE_X;
      const dir = Math.sign(home - f.x);
      // one ant alone just tugs on it; two or more make headway, faster the more help there is
      const speed = team.length >= 2 ? 5 + team.length * 3.5 : 0;
      f.x += dir * speed * dt * this.activityAt(f.x, f.y);
      f.y = this.surfaceTarget(f.x).y - 2;
      team.forEach((a, k) => {
        const ang = (k / Math.max(1, team.length)) * Math.PI * 2 + 0.5;
        a.x = f.x + Math.cos(ang) * (f.radius + 2.5);
        a.y = Math.min(f.y + 2, f.y + Math.sin(ang) * 3);
        a.angle = Math.atan2(f.y - a.y, f.x - a.x);
        a.vx = dir * speed;
        a.vy = 0;
      });
      if (Math.abs(f.x - home) < CRATER_MAIN + 4) {
        // at the entrance it is cut up into loads one ant can carry down
        const pieces = Math.max(2, Math.round(f.amount / 20));
        for (let k = 0; k < pieces; k++) this.dropFoodAt(home + (Math.random() - 0.5) * 14, f.y, PayloadType.PROTEIN, f.amount / pieces);
        f.amount = 0;
        for (const a of team) {
          a.targetId = null;
          a.task = AntTask.FORAGING_SCOUT;
        }
        this.log('A team dragged a large insect home and is cutting it up', 'good');
      }
    }
  }

  // --- eclosion help -----------------------------------------------------------------------------------------------
  /** Callows can't free themselves easily: nurses chew open the cocoon and pull the new adult out. */
  private tryHelpEclosion(b: BroodItem, dt: number): boolean {
    b.ecloseWait = (b.ecloseWait ?? 0) + dt;
    if (b.ecloseWait < 27) {
      let helper: Ant | null = null;
      this.forAntsNear(b.x, b.y, 14, (a) => {
        if (a.caste === AntCaste.NURSE && a.payload === PayloadType.NONE && a.replete === undefined && (!BUSY_TASKS.has(a.task) || a.task === AntTask.GROOMING)) {
          helper = a;
          return true;
        }
      });
      if (helper) {
        const h = helper as Ant;
        this.busy(h, AntTask.HELPING_ECLOSION, 2.6);
        h.angle = Math.atan2(b.y - h.y, b.x - h.x);
        b.ecloseWait = 27.4; // freed in ~2.6 s of chewing and pulling
      }
    }
    // with help it is out in moments; alone it struggles for half a minute
    return b.ecloseWait >= 30;
  }

  // --- rescue ------------------------------------------------------------------------------------------------------
  /** Buries an ant standing under a cave-in; nestmates hear it and dig it out (Cataglyphis-style rescue). */
  private buryAntsAt(gx: number, gy: number): void {
    const wx = (gx + 0.5) * CELL_SIZE;
    const wy = (gy + 0.5) * CELL_SIZE;
    this.forAntsNear(wx, wy, 8, (a) => {
      if (a.caste === AntCaste.QUEEN || a.buried !== undefined || a.carriedById != null || this.isAlate(a)) return;
      this.releasePayload(a);
      this.unlinkAnt(a);
      a.buried = 45;
      a.task = AntTask.BURIED;
      this.stopMoving(a);
      this.log('A worker is buried by the cave-in: nestmates rush to dig it out', 'danger');
      return true;
    });
  }

  /** Returns false if the ant suffocated (and was removed). */
  private stepBuried(ant: Ant, index: number, dt: number): boolean {
    ant.buried = (ant.buried ?? 0) - dt;
    ant.task = AntTask.BURIED;
    ant.vx = 0;
    ant.vy = 0;
    const g = this.grid.worldToGrid(ant.x, ant.y);
    const free = this.grid.isNavigable(g.gx, g.gy);
    if (free) {
      ant.buried = undefined;
      ant.task = AntTask.GROOMING;
      ant.stateTimer = 3;
      return true;
    }
    if (ant.buried <= 0) {
      this.killAnt(index, 'buried');
      return false;
    }
    // trapped ants emit a distress signal that draws nestmates
    this.grid.depositPheromone(this.grid.alarmPheromone, ant.x, ant.y, 0.15 * dt * 10, 1);
    let rescuers = 0;
    this.forAntsNear(ant.x, ant.y, 70, (m) => {
      if (rescuers >= 3) return true;
      if (m.id === ant.id || m.caste === AntCaste.QUEEN || this.isAlate(m) || m.buried !== undefined || m.carriedById != null) return;
      if (m.payload !== PayloadType.NONE || m.replete !== undefined) return;
      if (BUSY_TASKS.has(m.task) && m.task !== AntTask.IDLE) return;
      rescuers++;
      if (m.task !== AntTask.RESCUING) {
        m.task = AntTask.RESCUING;
        m.targetId = ant.id;
        m.stateTimer = 2.5 + Math.random();
      }
    });
    return true;
  }

  /** Rescuers walk to the buried ant and dig away the soil pinning it. */
  private stepRescuer(ant: Ant, dt: number): boolean {
    if (ant.task !== AntTask.RESCUING) return false;
    const victim = this.antById(ant.targetId);
    if (!victim || victim.buried === undefined) {
      ant.task = AntTask.FORAGING_SCOUT;
      ant.targetId = null;
      return false;
    }
    if (Math.hypot(victim.x - ant.x, victim.y - ant.y) > 11) {
      const vg = this.grid.worldToGrid(victim.x, victim.y);
      const open = this.grid.findNearestNavigable(vg.gx, vg.gy, 6);
      if (!open) {
        ant.task = AntTask.FORAGING_SCOUT;
        ant.targetId = null;
        return false;
      }
      const w = this.grid.gridToWorld(open.gx, open.gy);
      if (!ant.targetPos || Math.abs(ant.targetPos.x - w.x) + Math.abs(ant.targetPos.y - w.y) > 4) this.goTo(ant, w.x, w.y);
      this.moveAnt(ant, dt);
      if (Math.hypot(w.x - ant.x, w.y - ant.y) > 4) return true;
    }
    // dig and pull
    this.stopMoving(ant);
    ant.angle = Math.atan2(victim.y - ant.y, victim.x - ant.x);
    ant.stateTimer -= dt;
    if (Math.random() < dt * 3) this.spawnCrumbs(victim.x, victim.y, '#4a3828', 1);
    if (ant.stateTimer <= 0) {
      const vg = this.grid.worldToGrid(victim.x, victim.y);
      for (let k = 0; k < 9; k++) {
        const cx = vg.gx + (k % 3) - 1;
        const cy = vg.gy + Math.floor(k / 3) - 1;
        if (!this.grid.inBounds(cx, cy)) continue;
        const i = this.grid.idx(cx, cy);
        if (this.canExcavate(i) && (k === 4 || this.digPlan[i] === 2)) {
          this.grid.setTerrain(cx, cy, CellType.TUNNEL);
          this.digPlan[i] = 0;
        }
      }
      this.counters.rescues++;
      this.log('Nestmates dug a buried worker out alive', 'good');
      ant.task = AntTask.GROOMING;
      ant.stateTimer = 1.5;
      ant.targetId = null;
    }
    return true;
  }

  // --- social carrying of injured nestmates ------------------------------------------------------------------------
  private tryCarryInjured(ant: Ant): boolean {
    if (ant.payload !== PayloadType.NONE || ant.carryingAntId != null || this.intruders.length > 0) return false;
    let hurt: Ant | null = null;
    this.forAntsNear(ant.x, ant.y, 40, (m) => {
      if (m.id === ant.id || m.caste === AntCaste.QUEEN || this.isAlate(m) || m.carriedById != null || m.buried !== undefined) return;
      if ((m.hp ?? 24) < (m.maxHp ?? 24) * 0.4 && this.isOutside(m.x, m.y) && m.task !== AntTask.CARRYING_NESTMATE) {
        hurt = m;
        return true;
      }
    });
    if (!hurt) return false;
    const h = hurt as Ant;
    ant.task = AntTask.CARRYING_NESTMATE;
    if (Math.hypot(h.x - ant.x, h.y - ant.y) < 8) {
      this.releasePayload(h);
      this.unlinkAnt(h);
      h.carriedById = ant.id;
      h.task = AntTask.BEING_CARRIED;
      ant.carryingAntId = h.id;
      this.stopMoving(ant);
    } else this.goTo(ant, h.x, h.y);
    return true;
  }

  /** Returns true while the ant is busy carrying a nestmate. */
  private stepCarryingNestmate(ant: Ant): boolean {
    if (ant.carryingAntId == null) return false;
    const h = this.antById(ant.carryingAntId);
    if (!h) {
      ant.carryingAntId = null;
      return false;
    }
    ant.task = AntTask.CARRYING_NESTMATE;
    const d = this.go(ant, 'granary');
    if (d <= 0.5 || (!this.isOutside(ant.x, ant.y) && d < 6)) {
      h.carriedById = null;
      h.x = ant.x + Math.cos(ant.angle) * 5;
      h.y = ant.y;
      this.busy(h, AntTask.IDLE, 25);
      ant.carryingAntId = null;
      ant.task = AntTask.FORAGING_SCOUT;
    }
    return true;
  }

  private stepCarried(ant: Ant): void {
    const c = this.antById(ant.carriedById);
    if (!c || c.carryingAntId !== ant.id) {
      ant.carriedById = null;
      return;
    }
    // carried in the mandibles, in front of the carrier's head
    ant.x = c.x + Math.cos(c.angle) * 5;
    ant.y = c.y + Math.sin(c.angle) * 5 - 1;
    ant.angle = c.angle + Math.PI * 0.5;
    ant.vx = c.vx;
    ant.vy = c.vy;
    ant.task = AntTask.BEING_CARRIED;
  }

  // --- trail clearing ----------------------------------------------------------------------------------------------
  private stepDebris(dt: number): void {
    // gusts and downpours scatter grit and bits of leaf across the ground
    const blow = clamp((this.climate.windKmh - 18) / 30, 0, 1) + this.rainIntensity() * 0.5;
    if (blow > 0 && this.debris.length < 8 && Math.random() < dt * 0.05 * blow) {
      const x = CASE_LEFT + 60 + Math.random() * (CASE_RIGHT - CASE_LEFT - 120);
      this.debris.push({ id: this.allocId(), x, y: this.surfaceTarget(x).y - 1, carriedById: null, size: 0.7 + Math.random() * 0.8 });
    }
    for (const d of this.debris) {
      if (d.carriedById != null) {
        const a = this.antById(d.carriedById);
        if (!a || a.payload !== PayloadType.DEBRIS) d.carriedById = null;
        else {
          d.x = a.x + Math.cos(a.angle) * 4;
          d.y = a.y + Math.sin(a.angle) * 4 - 1.5;
        }
      } else {
        d.y = this.surfaceTarget(d.x).y - 1;
      }
    }
  }

  private trailStrength(x: number, y: number): number {
    const g = this.grid.worldToGrid(x, y);
    return this.grid.foodPheromone[this.grid.idx(g.gx, g.gy)] + this.grid.foodPheromone[this.grid.idx(g.gx, Math.max(0, g.gy - 1))];
  }

  /** Workers on a busy trail pick up obstacles and carry them off to the side. */
  private tryClearTrail(ant: Ant): boolean {
    if (ant.payload === PayloadType.DEBRIS) {
      ant.task = AntTask.CLEARING_TRAIL;
      const d = this.debris.find((dd) => dd.id === ant.payloadId);
      const tx = ant.targetPos?.x ?? ant.x;
      if (!d || Math.abs(ant.x - tx) < 6) {
        if (d) {
          d.carriedById = null;
          d.x = ant.x;
        }
        ant.payload = PayloadType.NONE;
        ant.payloadId = null;
        ant.task = AntTask.FORAGING_SCOUT;
        this.stopMoving(ant);
      }
      return true;
    }
    const d = this.debris.find((dd) => dd.carriedById == null && Math.abs(dd.x - ant.x) < 50 && this.trailStrength(dd.x, dd.y) > 0.08);
    if (!d) return false;
    ant.task = AntTask.CLEARING_TRAIL;
    if (Math.abs(d.x - ant.x) < 6) {
      d.carriedById = ant.id;
      ant.payload = PayloadType.DEBRIS;
      ant.payloadId = d.id;
      // haul it off the trail: whichever side has less scent
      const off = this.trailStrength(d.x - 45, d.y) < this.trailStrength(d.x + 45, d.y) ? -45 : 45;
      const t = this.surfaceTarget(clamp(d.x + off, CASE_LEFT + 30, CASE_RIGHT - 30));
      this.goTo(ant, t.x, t.y);
    } else {
      const t = this.surfaceTarget(d.x);
      this.goTo(ant, t.x, t.y);
    }
    return true;
  }

  // --- famine responses --------------------------------------------------------------------------------------------
  /** Starving colonies recycle their own eggs: nurses eat them to stay alive (real colonies do this routinely). */
  private tryCannibalizeEgg(ant: Ant): boolean {
    if (this.storedFoodCache > 2 || ant.hunger < 85) return false;
    const egg = this.brood.find((b) => b.stage === BroodStage.EGG && b.carriedByAntId === null && Math.hypot(b.x - ant.x, b.y - ant.y) < 40);
    if (!egg) return false;
    if (Math.hypot(egg.x - ant.x, egg.y - ant.y) < 9) {
      this.brood.splice(this.brood.indexOf(egg), 1);
      ant.hunger = Math.max(0, ant.hunger - 45);
      this.busy(ant, AntTask.CANNIBALIZING, 2);
      if (this.simTime - this.lastFamineLog > 60) {
        this.lastFamineLog = this.simTime;
        this.log('Famine: nurses are eating eggs to survive', 'danger');
      }
    } else {
      ant.task = AntTask.CANNIBALIZING;
      this.approachBrood(ant, egg);
    }
    return true;
  }

  /** Trophic eggs are fed straight to hungry larvae. Returns true if the nurse took one. */
  private tryFeedTrophicEgg(ant: Ant): boolean {
    const egg = this.brood.find((b) => b.trophic && b.carriedByAntId === null && !this.claimedBrood.has(b.id));
    if (!egg) return false;
    const larva = this.hungriestLarva(ant, 60);
    if (!larva) return false;
    this.claimedBrood.add(egg.id);
    ant.task = AntTask.FEEDING_LARVA;
    if (Math.hypot(egg.x - ant.x, egg.y - ant.y) < 9) {
      this.brood.splice(this.brood.indexOf(egg), 1);
      ant.payload = PayloadType.PROTEIN;
      ant.payloadValue = 3;
      ant.targetId = larva.id;
      this.claimedBrood.add(larva.id);
    } else this.approachBrood(ant, egg);
    return true;
  }

  /** In a queenless colony some workers' ovaries develop and they lay unfertilised (male) eggs. */
  private stepQueenless(dt: number): void {
    if (this.getQueen()) return;
    this.queenlessTimer -= dt;
    if (this.queenlessTimer > 0) return;
    this.queenlessTimer = 90 + Math.random() * 60;
    const nursery = this.chambers.find((c) => c.type === ChamberType.NURSERY);
    const layer = this.ants.find((a) => a.caste === AntCaste.NURSE && a.payload === PayloadType.NONE);
    if (!nursery || !layer || this.brood.length >= MAX_BROOD || this.storedFoodCache < 20) return;
    const egg = this.makeBrood(BroodStage.EGG, layer.x, layer.y, nursery.id, 0, 100);
    egg.sexual = 'male';
    this.brood.push(egg);
    this.busy(layer, AntTask.LAYING_EGG, 1.6);
    this.log('Queenless workers have begun laying male eggs');
  }

  // --- alates & the nuptial flight ---------------------------------------------------------------------------------
  /** Should the next pupa-to-be be reared as a winged sexual? Only big, well-fed colonies in the warm season. */
  private wantSexual(): 'gyne' | 'male' | null {
    if (!this.getQueen()) return null;
    if (this.season !== 'Summer' && this.season !== 'Spring') return null;
    if (this.ants.length < 55 || this.storedFoodCache < 60) return null;
    const alates = this.ants.filter((a) => this.isAlate(a)).length + this.brood.filter((b) => b.sexual).length;
    if (alates >= 8) return null;
    if (Math.random() > 0.3) return null;
    return Math.random() < 0.4 ? 'gyne' : 'male';
  }

  private flightWeather(): boolean {
    // the classic trigger: a warm, humid, calm day just after rain
    return (
      this.forageWeather() &&
      this.wetness > 0.12 &&
      this.surfaceTempC >= 18 &&
      this.climate.windKmh < 20 &&
      this.climate.humidity > 0.55 &&
      this.daylight() > 0.35
    );
  }

  private stepNuptialFlight(dt: number): void {
    const alates = this.ants.filter((a) => this.isAlate(a) && !a.flying);
    if (alates.length === 0) {
      this.swarming = false;
      return;
    }
    const waitedLong = alates.some((a) => a.age > 900) && this.forageWeather() && this.surfaceTempC >= 20 && this.daylight() > 0.4;
    if (!this.swarming && alates.length >= 2 && (this.flightWeather() || waitedLong)) {
      this.swarming = true;
      this.log('Nuptial flight! Winged queens and males pour out of the nest', 'good');
    }
    if (this.swarming && !this.forageWeather()) this.swarming = false;
  }

  private stepAlate(ant: Ant, dt: number): void {
    if (ant.hunger > 70 && this.storedFoodCache > 3) {
      this.goEat(ant);
      return;
    }
    if (!this.swarming) {
      // wait in the upper chambers, fed by workers, until the weather is right
      ant.task = AntTask.WAITING_TO_SWARM;
      ant.stateTimer -= dt;
      if (ant.stateTimer <= 0) this.seekRest(ant, 'granary', 10 + Math.random() * 20);
      return;
    }
    ant.task = AntTask.NUPTIAL_FLIGHT;
    if (!this.isOutside(ant.x, ant.y)) {
      this.go(ant, 'surface');
      return;
    }
    // climb to a high point (a grass blade or the mound top) and take off
    if (ant.targetId == null) {
      const s = this.sprouts.length ? this.sprouts[Math.floor(Math.random() * this.sprouts.length)] : null;
      ant.targetId = -1;
      const tx = s && Math.abs(s.x - ant.x) < 200 ? s.x : ant.x + (Math.random() - 0.5) * 60;
      const t = this.surfaceTarget(tx);
      this.goTo(ant, t.x, t.y);
      ant.stateTimer = 8 + Math.random() * 8;
    }
    ant.stateTimer -= dt;
    const arrived = !ant.targetPos || Math.hypot(ant.targetPos.x - ant.x, ant.targetPos.y - ant.y) < 6;
    if (arrived || ant.stateTimer <= 0) {
      ant.flying = true;
      ant.vx = (Math.random() - 0.5) * 20;
      ant.vy = -30 - Math.random() * 15;
      this.stopMoving(ant);
    }
  }

  /** Returns false when the alate has flown out of the case (and was removed). */
  private stepFlying(ant: Ant, index: number, dt: number): boolean {
    ant.task = AntTask.NUPTIAL_FLIGHT;
    ant.vx += (this.windStrength * 30 - ant.vx) * dt * 0.8 + (Math.random() - 0.5) * 60 * dt;
    ant.vy += (-36 - ant.vy) * dt * 1.5;
    ant.x += ant.vx * dt;
    ant.y += ant.vy * dt;
    ant.angle = Math.atan2(ant.vy, ant.vx);
    ant.gaitPhase += dt * 40;
    if (ant.y < CASE_TOP + 6 || ant.x < CASE_LEFT + 4 || ant.x > CASE_RIGHT - 4) {
      this.unlinkAnt(ant);
      this.ants.splice(index, 1);
      this.counters.flights++;
      return false;
    }
    return true;
  }

  // --- overwintering & weather shelter -----------------------------------------------------------------------------
  /** In the cold the whole colony packs together deep in the nest around the queen and barely moves. */
  private tryCluster(ant: Ant): boolean {
    if (this.nestTempC >= 8 && !(this.season === 'Winter' && this.surfaceTempC < 6)) return false;
    if (ant.caste === AntCaste.SOLDIER && ant.id % 3 === 0) return false; // a few guards stay posted
    if (ant.caste === AntCaste.NURSE) return false; // nurses stay with the (now dormant) brood
    if (ant.payload !== PayloadType.NONE) return false;
    ant.task = AntTask.CLUSTERING;
    const d = this.go(ant, 'royal');
    if (d <= 0.5 || d >= INF) this.busy(ant, AntTask.IDLE, 30 + Math.random() * 40);
    return true;
  }

  /** Plug the entrances while it storms or snows, and dig them open again once it's fine. */
  private stepEntranceSealing(dt: number): void {
    const bad = this.rainIntensity() >= 0.55 || this.weather === 'Snow' || this.surfaceTempC < 3;
    this.sealTimer += bad ? dt : -dt;
    this.sealTimer = clamp(this.sealTimer, -60, 60);
    if (!this.sealed && this.sealTimer > 40) {
      // only once every forager is home
      if (this.ants.some((a) => this.isOutside(a.x, a.y) && a.caste !== AntCaste.QUEEN && !a.flying)) return;
      for (const ex of [this.entrancePos.x, SIDE_ENTRANCE_X]) {
        for (let n = 0; n < 2; n++) {
          const i = this.findEntrancePlugCell(ex);
          if (i < 0) break;
          this.grid.setTerrain(i % GRID_W, Math.floor(i / GRID_W), CellType.TOPSOIL);
          this.sealedCells.push(i);
        }
      }
      if (this.sealedCells.length) {
        this.sealed = true;
        this.log('Workers plug the entrances with soil against the weather');
        const sealer = this.ants.find((a) => a.caste === AntCaste.EXCAVATOR);
        if (sealer) this.busy(sealer, AntTask.SEALING_ENTRANCE, 3);
      }
    } else if (this.sealed && this.sealTimer < -20) {
      this.sealed = false;
      for (const i of this.sealedCells) if (this.canExcavate(i)) this.digPlan[i] = 2;
      this.sealedCells = [];
      this.fieldDirty.dig = true;
      this.log('Fair weather: excavators reopen the entrances');
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
    if (ant.payload === PayloadType.CHAFF) {
      this.carryChaff(ant);
      return;
    }
    if (ant.payload === PayloadType.DEBRIS) {
      this.tryClearTrail(ant);
      return;
    }
    if (ant.payload === PayloadType.LEAF) {
      this.carryLeaf(ant);
      return;
    }

    if (isFoodPayload(ant.payload)) {
      ant.task = AntTask.RETURNING_WITH_FOOD;
      if (onSurface && ant.pheromoneDropTimer <= 0) {
        ant.pheromoneDropTimer = 0.12;
        // successful foragers mark the way back so nestmates can follow it out; the richer the find
        // (sugary honeydew > fresh protein > seeds), the stronger the trail and the faster it builds
        const quality = ant.payload === PayloadType.HONEYDEW ? 1.3 : ant.payload === PayloadType.PROTEIN ? 1.1 : 0.8;
        this.grid.depositPheromone(this.grid.foodPheromone, ant.x, ant.y, (ant.recruitFoodPos ? 0.6 : 0.25) * quality, 1);
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
      // harvester work: strip husks off stored seeds
      if (ant.id % 4 === 1 && this.tryHuskSeed(ant)) return;
      // pick up any food lying inside the nest (e.g. a dead intruder) on the way
      const loose = this.foods.find((f) => f.storedInChamberId === null && !f.falling && !f.large && f.amount > 1 && Math.abs(f.x - ant.x) < 28 && Math.abs(f.y - ant.y) < 16);
      if (loose) {
        if (this.tryPickFood(ant, loose)) return;
        this.goTo(ant, loose.x, loose.y);
        return;
      }
      if ((ant.restCooldown = (ant.restCooldown ?? 30) - dt) <= 0 && Math.random() < 0.3) {
        ant.restCooldown = (60 + Math.random() * 80) * (0.6 + (ant.industry ?? 0.5) * 0.8);
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

    // injured nestmates are carried home; big prey is dragged home by a team; trails are kept clear
    if (this.tryCarryInjured(ant)) return;
    if (this.tryGroupTransport(ant)) return;
    if (ant.id % 5 === 0 && this.tryClearTrail(ant)) return;
    // a share of the foragers are herders that milk the colony's aphids
    if (ant.id % 3 === 1 && this.tryTendAphids(ant)) return;
    // ...and a few are leaf-cutters feeding the fungus garden
    if (this.tryCutLeaf(ant, dt)) return;

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
      if (f.storedInChamberId !== null || f.falling || f.large || f.amount <= 1) continue;
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
      // ...and sometimes personally leads one of them out there in a tandem run
      if (Math.random() < 0.35) this.startTandem(ant);
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

    // 4. choose a new errand (famine first: eat eggs to survive, hand out trophic eggs)
    if (this.tryCannibalizeEgg(ant)) return;
    if (this.storedFoodCache < 20 && this.tryFeedTrophicEgg(ant)) return;
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

  /** Temperature at a point, by depth below the ground (sun-warmed near the top, soil-buffered deep down). */
  public tempAt(x: number, y: number): number {
    const gx = clamp(Math.floor(x / CELL_SIZE), 0, GRID_W - 1);
    const depth = y - this.grid.surfaceY[gx];
    if (depth < 20) return this.surfaceTempC;
    if (depth < 120) return this.surfaceTempC + (this.nestTempC - this.surfaceTempC) * ((depth - 20) / 100);
    return this.nestTempC;
  }

  private chamberFlooded(c: Chamber): boolean {
    return this.floodDepth > 0 && c.y + c.ry * 0.3 > this.floodLineY();
  }

  /**
   * Brood thermoregulation: real nurses shuttle brood up to shallow, sun-warmed chambers on cool sunny days and
   * back down when the top of the nest overheats or cools at night. Brood is also carried above rising floodwater.
   * Returns how well a chamber suits brood right now (lower is better), or Infinity if it is unusable.
   */
  private broodChamberCost(c: Chamber): number {
    if (this.chamberFlooded(c)) return Infinity;
    if (c.type !== ChamberType.NURSERY) {
      // only when every nursery is under water does the brood go into whatever dry chamber is highest
      if (c.type === ChamberType.MIDDEN) return Infinity;
      const dryNursery = this.chambers.some((n) => n.type === ChamberType.NURSERY && !this.chamberFlooded(n));
      return dryNursery ? Infinity : 40 + c.y * 0.01;
    }
    return Math.abs(this.tempAt(c.x, c.y) - 28) * 2;
  }

  private bestBroodCost = 0;
  private bestBroodCostTimer = 0;

  private inNursery(b: BroodItem): boolean {
    const c = this.chambers.find((ch) => ch.id === b.chamberId);
    if (!c) return false;
    const cost = this.broodChamberCost(c);
    if (cost === Infinity) return false;
    // hysteresis: only move brood when another chamber is clearly (several degrees) better
    if (cost > this.bestBroodCost + 8) return false;
    return Math.abs(b.x - c.x) < c.rx + 6 && Math.abs(b.y - c.y) < c.ry + 10;
  }

  private bestNursery(ant: Ant): Chamber | undefined {
    // prefer the nearest well-tempered, dry nursery that isn't crowded
    let best: Chamber | undefined;
    let bestScore = Infinity;
    for (const c of this.chambers) {
      const cost = this.broodChamberCost(c);
      if (cost === Infinity || cost > this.bestBroodCost + 8) continue;
      const load = this.brood.reduce((n, b) => n + (b.chamberId === c.id ? 1 : 0), 0);
      const score = Math.hypot(c.x - ant.x, c.y - ant.y) + load * 12 + cost * 10;
      if (score < bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  private updateBroodClimate(dt: number): void {
    this.bestBroodCostTimer -= dt;
    if (this.bestBroodCostTimer > 0) return;
    this.bestBroodCostTimer = 8;
    let best = Infinity;
    for (const c of this.chambers) best = Math.min(best, this.broodChamberCost(c));
    this.bestBroodCost = best === Infinity ? 0 : best;
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
      if (this.tryBackfill(ant)) return;
      ant.task = AntTask.CARRYING_SOIL;
      const d = this.go(ant, 'mound');
      const cell = this.grid.worldToGrid(ant.x, ant.y);
      if (d <= 2.5 && this.grid.terrain[this.grid.idx(cell.gx, cell.gy)] === CellType.AIR) {
        this.counters.deposits++;
        for (let k = 0; k < Math.max(1, ant.payloadValue); k++) this.depositSoil(ant.x + (k % 2 === 0 ? 0 : (ant.x >= this.entrancePos.x ? 6 : -6)));
        ant.payload = PayloadType.NONE;
        ant.payloadValue = 0;
        ant.backfill = undefined;
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
    // damp soil is soft and holds together: real colonies dig far more after rain; dry crumbly soil is slow going
    const moist = this.grid.moisture[pick];
    ant.stateTimer = (1.1 + Math.random() * 1.0) * (1.25 - Math.min(0.6, moist * 0.7));
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
    if (wasRepair && this.repairCount === 0) this.log('Caved-in tunnels cleared and repaired', 'good');
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
    if (ant.warBand) {
      const raid = this.war.raid;
      if (!raid) ant.warBand = false;
      else {
        ant.task = AntTask.PATROLLING;
        if (!onSurface) {
          if (this.go(ant, 'surface') >= INF) ant.warBand = false;
          return;
        }
        ant.stateTimer -= dt;
        if (ant.stateTimer <= 0 || !ant.targetPos) {
          ant.stateTimer = 2.5;
          const t = this.surfaceTarget(raid.x + ((ant.id % 5) - 2) * 9);
          this.goTo(ant, t.x, t.y);
        }
        return;
      }
    }
    const guard = ant.id % 3 !== 0 && !(night && ant.id % 2 === 0) && this.forageWeather();
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
      const work = ant.industry ?? 0.5;
      pauseRate *= 1.6 - work * 1.2;
      base *= 0.94 + work * 0.12;
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
    ant.x = clamp(nx, CASE_LEFT + 28, CASE_RIGHT - 28);
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
        if (p.kind === 'snow') {
          p.vx = this.windStrength * 12 + Math.sin(this.simTime * 1.7 + i) * 6;
          const gx = clamp(Math.floor(p.x / CELL_SIZE), 0, GRID_W - 1);
          if (p.y >= this.grid.surfaceY[gx] - 1 || p.x < CASE_LEFT + 6 || p.x > CASE_RIGHT - 6) p.life = p.maxLife;
        }
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
        climate: this.climate,
        liveWeather: this.liveWeather,
        sunriseMin: this.sunriseMin,
        sunsetMin: this.sunsetMin,
        latitude: this.latitude,
        nestTempC: this.nestTempC,
        snowCover: this.snowCover,
        floodDepth: this.floodDepth,
        wetness: this.wetness,
        foundedAt: this.foundedAt,
        aphids: this.aphids,
        debris: this.debris,
        sealed: this.sealed,
        sealedCells: this.sealedCells,
        swarming: this.swarming,
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
      const known: WeatherCondition[] = ['Clear', 'Cloudy', 'Fog', 'Drizzle', 'Rain', 'Heavy Rain', 'Thunderstorm', 'Snow'];
      this.weather = known.includes(data.weather) ? data.weather : 'Clear';
      this.weatherTimer = Number(data.weatherTimer) || 35;
      if (data.climate && Number.isFinite(data.climate.tempC)) {
        this.climate = { ...this.climate, ...data.climate };
        this.climateGoal = { ...this.climate };
      }
      this.liveWeather = false; // re-confirmed by the next live reading (cached reading arrives on start)
      if (Number.isFinite(data.sunriseMin) && Number.isFinite(data.sunsetMin)) {
        this.sunriseMin = data.sunriseMin;
        this.sunsetMin = data.sunsetMin;
      }
      if (Number.isFinite(data.latitude)) this.latitude = data.latitude;
      if (Number.isFinite(data.nestTempC)) this.nestTempC = data.nestTempC;
      this.snowCover = Number(data.snowCover) || 0;
      this.floodDepth = Number(data.floodDepth) || 0;
      this.wetness = Number(data.wetness) || 0;
      if (Number.isFinite(data.foundedAt)) this.foundedAt = data.foundedAt;
      if (Array.isArray(data.aphids)) this.aphids = data.aphids;
      if (Array.isArray(data.debris)) this.debris = data.debris.map((d: Debris) => ({ ...d, carriedById: null }));
      this.sealed = !!data.sealed;
      this.sealedCells = Array.isArray(data.sealedCells) ? data.sealedCells : [];
      this.swarming = !!data.swarming;
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
