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

/**
 * Sustainable colony size: roughly what the surface food supply can feed. A larger cap just overshoots, starves the
 * brood and cycles back down.
 */
const MAX_COLONY = 150;

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

  public simTime: number = 0;
  public timeOfDay: number = 0.34;
  public dayCount: number = 1;
  public weather: 'Clear' | 'Misty' | 'Light Rain' = 'Clear';
  public windStrength: number = 0.35;
  private weatherTimer: number = 38;

  public entrancePos: Vec2 = { x: 700, y: SURFACE_BASE_Y };
  public middenPos: Vec2 = { x: 1290, y: SURFACE_BASE_Y };
  public tunnelsDugCells: number = 0;

  private nextId: number = 1;
  private nestFieldDirty: boolean = true;
  private nestFieldTimer: number = 0;
  private pathBudgetThisTick: number = 0;
  private naturalFoodTimer: number = 7;
  private intruderTimer: number = 10;
  private fungusTimer: number = 8;
  private queenEggTimer: number = 4;
  private labourTimer: number = 5;

  private static readonly SAVE_KEY = 'formicarium_colony_v1';

  constructor() {
    this.grid = new ColonyGrid();
    if (!this.loadState()) {
      this.initWorld();
      this.saveState();
    }
  }

  private allocId(): number {
    return this.nextId++;
  }

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

    this.spawnSurfaceFood(PayloadType.SEED, 250, false);
    this.spawnSurfaceFood(PayloadType.HONEYDEW, 540, false);
    this.spawnSurfaceFood(PayloadType.SEED, 910, false);
    this.spawnSurfaceFood(PayloadType.PROTEIN, 1085, false);
    this.spawnSurfaceFood(PayloadType.HONEYDEW, 1185, false);

    for (let x = 540; x <= 700; x += 8) {
      const gx = Math.floor(x / CELL_SIZE);
      this.grid.depositPheromone(this.grid.foodPheromone, x, this.grid.surfaceY[gx] - 3, 0.55, 1);
    }

    // 7. Initial Brood
    for (let i = 0; i < 6; i++) {
      this.brood.push({
        id: this.allocId(),
        stage: BroodStage.EGG,
        x: royal.x + 14 + (Math.random() - 0.5) * 26,
        y: royal.y + 14 + (Math.random() - 0.5) * 8,
        progress: Math.random() * 60,
        nutrition: 90,
        carriedByAntId: null,
        chamberId: royal.id,
        wigglePhase: Math.random() * Math.PI * 2,
      });
    }
    for (let i = 0; i < 8; i++) {
      this.brood.push({
        id: this.allocId(),
        stage: BroodStage.LARVA,
        x: nursery.x + (Math.random() - 0.5) * 55,
        y: nursery.y + 14 + (Math.random() - 0.5) * 8,
        progress: Math.random() * 75,
        nutrition: 45 + Math.random() * 45,
        carriedByAntId: null,
        chamberId: nursery.id,
        wigglePhase: Math.random() * Math.PI * 2,
      });
    }
    for (let i = 0; i < 6; i++) {
      this.brood.push({
        id: this.allocId(),
        stage: BroodStage.PUPA,
        x: nursery.x + (Math.random() - 0.5) * 48,
        y: nursery.y + 10 + (Math.random() - 0.5) * 10,
        progress: 25 + Math.random() * 65,
        nutrition: 100,
        carriedByAntId: null,
        chamberId: nursery.id,
        wigglePhase: Math.random() * Math.PI * 2,
      });
    }

    // Collect all valid subterranean tunnel coordinates for guaranteed safe spawning
    const tunnelPositions: Vec2[] = [];
    for (let gy = 38; gy < GRID_H - 12; gy++) {
      for (let gx = 12; gx < GRID_W - 12; gx++) {
        if (this.grid.terrain[this.grid.idx(gx, gy)] === CellType.TUNNEL) {
          tunnelPositions.push(this.grid.gridToWorld(gx, gy));
        }
      }
    }
    const pickTunnelPos = (): Vec2 => {
      if (tunnelPositions.length > 0) {
        return tunnelPositions[Math.floor(Math.random() * tunnelPositions.length)];
      }
      return { x: royal.x, y: royal.y };
    };

    // 8. Spawn Queen & Specialized Castes strictly inside navigable space
    this.spawnAnt(AntCaste.QUEEN, royal.x - 10, royal.y + 8);
    for (let i = 0; i < 30; i++) {
      const onSurface = i < 18;
      if (onSurface) {
        const sx = 240 + Math.random() * 940;
        const sy = this.grid.surfaceY[Math.floor(sx / CELL_SIZE)] - 1.5;
        this.spawnAnt(AntCaste.WORKER, sx, sy);
      } else {
        const p = pickTunnelPos();
        this.spawnAnt(AntCaste.WORKER, p.x, p.y);
      }
    }
    for (let i = 0; i < 14; i++) {
      const target = i < 6 ? royal : nursery;
      this.spawnAnt(AntCaste.NURSE, target.x + (Math.random() - 0.5) * 32, target.y + (Math.random() - 0.5) * 12);
    }
    for (let i = 0; i < 13; i++) {
      const p = pickTunnelPos();
      this.spawnAnt(AntCaste.EXCAVATOR, p.x, p.y);
    }
    for (let i = 0; i < 9; i++) {
      const nearEnt = i < 6;
      if (nearEnt) {
        const sx = 640 + Math.random() * 120;
        const sy = this.grid.surfaceY[Math.floor(sx / CELL_SIZE)] - 1.5;
        this.spawnAnt(AntCaste.SOLDIER, sx, sy);
      } else {
        this.spawnAnt(AntCaste.SOLDIER, royal.x + (Math.random() - 0.5) * 36, royal.y + 4);
      }
    }

    // The founding ants span a range of ages. If they were all born at t=0 they would also all die together,
    // wiping out every nurse at once and starving the brood (a generation cliff).
    for (const a of this.ants) {
      if (a.caste !== AntCaste.QUEEN) a.age = Math.random() * 0.75 * a.maxAge;
    }

    // 9. Atmospheric floating dust motes
    for (let i = 0; i < 65; i++) {
      this.particles.push({
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
      });
    }

    this.grid.recomputeNestField(royal.x, royal.y);
    this.nestFieldDirty = false;
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
    const baseSpeed =
      caste === AntCaste.QUEEN
        ? 11
        : caste === AntCaste.SOLDIER
        ? 33
        : caste === AntCaste.WORKER
        ? 37 + Math.random() * 6
        : caste === AntCaste.EXCAVATOR
        ? 31 + Math.random() * 5
        : 29 + Math.random() * 4;

    const ant: Ant = {
      id: this.allocId(),
      caste,
      x: sx,
      y: sy,
      vx: 0,
      vy: 0,
      angle: Math.random() * Math.PI * 2,
      targetAngle: Math.random() * Math.PI * 2,
      speed: baseSpeed,
      energy: 75 + Math.random() * 25,
      hunger: 10 + Math.random() * 25,
      hydration: 80 + Math.random() * 20,
      age: 0,
      // Workers live tens of minutes (not ~5): long enough for a colony to be a stable, watchable thing.
      maxAge: caste === AntCaste.QUEEN ? 999999 : 1500 + Math.random() * 1500,
      isCallow,
      callowTimer: isCallow ? 22 : 0,
      task:
        caste === AntCaste.QUEEN
          ? AntTask.IDLE
          : caste === AntCaste.WORKER
          ? AntTask.FORAGING_SCOUT
          : caste === AntCaste.NURSE
          ? AntTask.MOVING_BROOD
          : caste === AntCaste.EXCAVATOR
          ? AntTask.EXCAVATING
          : AntTask.PATROLLING,
      payload: PayloadType.NONE,
      payloadValue: 0,
      payloadId: null,
      stateTimer: 0.4 + Math.random() * 1.5,
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
      prevX: x,
      prevY: y,
      greetCooldown: 4 + Math.random() * 8,
      recruitFoodPos: null,
      signalCooldown: 0,
    };
    this.ants.push(ant);
    return ant;
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

  public step(rawDt: number): void {
    const dt = Math.min(0.05, rawDt);
    if (dt <= 0) return;

    this.simTime += dt;
    this.pathBudgetThisTick = 0;

    // 1. Dynamic Circadian Cycle & Shifting Weather/Wind
    const dayLength = 135;
    const prevTod = this.timeOfDay;
    this.timeOfDay = (this.timeOfDay + dt / dayLength) % 1;
    if (this.timeOfDay < prevTod) {
      this.dayCount++;
    }

    this.windStrength = 0.3 + 0.45 * Math.sin(this.simTime * 0.14) + 0.25 * Math.cos(this.simTime * 0.37);

    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      const r = Math.random();
      this.weather = r < 0.52 ? 'Clear' : r < 0.78 ? 'Misty' : 'Light Rain';
      this.weatherTimer = this.weather === 'Clear' ? 38 + Math.random() * 35 : 18 + Math.random() * 18;
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

    // 2. Pheromones & Moisture percolation
    this.grid.stepPheromonesAndMoisture(dt, this.weather);

    this.nestFieldTimer += dt;
    if (this.nestFieldDirty && this.nestFieldTimer > 1.1) {
      const royal = this.getChamber(ChamberType.ROYAL);
      if (royal) {
        this.grid.recomputeNestField(royal.x, royal.y);
      }
      this.nestFieldDirty = false;
      this.nestFieldTimer = 0;
    }

    // 3. Droplets & Falling/Natural Foods
    this.stepDroplets(dt);
    this.stepEcosystem(dt);

    // 4. Brood development
    this.stepBrood(dt);

    // 5. Predatory Insects attacking the nest
    this.stepIntruders(dt);

    // 6. Autonomous Ant Colony, Crowding Avoidance & Necrophoresis
    this.stepAnts(dt);
    this.resolveEntityCrowding(dt);
    this.stepFallenAnts(dt);

    // 7. Particles
    this.stepParticles(dt);
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
      this.naturalFoodTimer = 6 + Math.random() * 7;
      const surfaceFoods = this.foods.filter((f) => f.storedInChamberId === null);
      if (surfaceFoods.length < 10) {
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

  private stepBrood(dt: number): void {
    for (let i = this.brood.length - 1; i >= 0; i--) {
      const b = this.brood[i];
      b.wigglePhase += dt * (b.stage === BroodStage.LARVA ? 4.8 : 1.2);

      if (b.carriedByAntId === null) {
        const g = this.grid.worldToGrid(b.x, b.y + 3);
        if (this.grid.inBounds(g.gx, g.gy) && !this.grid.isSolid(g.gx, g.gy)) {
          b.y += 18 * dt;
        }
      }

      if (b.stage === BroodStage.EGG) {
        b.progress += dt * 3.5;
        if (b.progress >= 100) {
          b.stage = BroodStage.LARVA;
          b.progress = 0;
          b.nutrition = 45;
        }
      } else if (b.stage === BroodStage.LARVA) {
        b.nutrition = Math.max(0, b.nutrition - dt * 1.05);
        if (b.nutrition > 18) {
          b.progress += dt * (1.8 + (b.nutrition / 100) * 1.9);
        }
        if (b.progress >= 100) {
          b.stage = BroodStage.PUPA;
          b.progress = 0;
        }
      } else if (b.stage === BroodStage.PUPA) {
        b.progress += dt * 2.6;
        if (b.progress >= 100) {
          if (this.ants.length < MAX_COLONY) {
            const caste = this.chooseNeededCaste();
            this.spawnAnt(caste, b.x, b.y - 2, true);
          }
          this.brood.splice(i, 1);
        }
      }
    }
  }

  private chooseNeededCaste(): AntCaste {
    let nurses = 0;
    let excavators = 0;
    let soldiers = 0;
    for (const a of this.ants) {
      if (a.caste === AntCaste.NURSE) nurses++;
      else if (a.caste === AntCaste.EXCAVATOR) excavators++;
      else if (a.caste === AntCaste.SOLDIER) soldiers++;
    }
    const total = Math.max(1, this.ants.length);
    if (nurses / total < 0.22) return AntCaste.NURSE;
    if (soldiers / total < 0.14) return AntCaste.SOLDIER;
    if (excavators / total < 0.18) return AntCaste.EXCAVATOR;
    return AntCaste.WORKER;
  }

  private stepIntruders(dt: number): void {
    this.intruderTimer -= dt;
    if (this.intruderTimer <= 0) {
      this.intruderTimer = 20 + Math.random() * 18;
      if (this.intruders.length < 3) {
        const homeEdge: 'left' | 'right' = Math.random() < 0.5 ? 'left' : 'right';
        // Crawl out directly from under the left or right surface rock outcrop crevice in guaranteed open AIR
        const creviceX = homeEdge === 'left' ? CASE_LEFT + 78 : CASE_RIGHT - 78;
        const spawnR = Math.random();

        const makeSpawnPos = (px: number): Vec2 => {
          const gx = clamp(Math.floor(px / CELL_SIZE), 12, GRID_W - 13);
          const sy = this.grid.surfaceY[gx] - 3;
          const g = this.grid.worldToGrid(px, sy);
          if (this.grid.isSolid(g.gx, g.gy) || !this.grid.isNavigable(g.gx, g.gy)) {
            const safe = this.grid.findNearestNavigable(g.gx, g.gy, 6);
            if (safe) return this.grid.gridToWorld(safe.gx, safe.gy);
          }
          return { x: px, y: sy };
        };

        if (spawnR < 0.58) {
          // Spawn a coordinated rival ant raiding party (2-3 marauders) emerging from the rock shelter
          const squadSize = 2 + (Math.random() < 0.45 ? 1 : 0);
          for (let s = 0; s < squadSize; s++) {
            const pos = makeSpawnPos(creviceX + (homeEdge === 'left' ? s * 11 : -s * 11));
            this.intruders.push({
              id: this.allocId(),
              x: pos.x,
              y: pos.y,
              vx: 0,
              vy: 0,
              angle: homeEdge === 'left' ? 0 : Math.PI,
              hp: 46,
              maxHp: 46,
              legPhase: Math.random() * Math.PI * 2,
              species: 'rival_ant',
              aggression: 1,
              attackCooldown: 0,
              behavior: s === 0 ? 'hunting_ants' : 'raiding_food',
              carryingFoodAmount: 0,
              targetFoodId: null,
              homeEdge,
              path: [],
              pathIndex: 0,
              lastPathTime: -10,
            });
          }
        } else {
          const pos = makeSpawnPos(creviceX);
          const r = Math.random();
          const species: Intruder['species'] =
            r < 0.3 ? 'beetle' : r < 0.56 ? 'earwig' : r < 0.8 ? 'mite' : 'centipede';
          const maxHp =
            species === 'beetle' ? 72 : species === 'centipede' ? 62 : species === 'earwig' ? 54 : 38;
          const behavior: Intruder['behavior'] =
            species === 'beetle' || species === 'earwig'
              ? 'raiding_food'
              : species === 'mite'
              ? 'infiltrating_brood'
              : 'hunting_ants';
          this.intruders.push({
            id: this.allocId(),
            x: pos.x,
            y: pos.y,
            vx: 0,
            vy: 0,
            angle: homeEdge === 'left' ? 0 : Math.PI,
            hp: maxHp,
            maxHp,
            legPhase: 0,
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
        }
      }
    }

    const granary = this.getChamber(ChamberType.GRANARY);
    const nursery = this.getChamber(ChamberType.NURSERY);

    for (let i = this.intruders.length - 1; i >= 0; i--) {
      const m = this.intruders[i];
      m.legPhase += dt * (m.species === 'centipede' ? 24 : m.species === 'rival_ant' ? 22 : m.species === 'mite' ? 20 : 16);
      m.attackCooldown = Math.max(0, m.attackCooldown - dt);

      const carrying = (m.carryingFoodAmount ?? 0) > 0;
      const retreating = m.hp < m.maxHp * 0.28 || carrying;
      if (retreating) m.behavior = 'retreating';

      const prevX = m.x;
      const prevY = m.y;

      const baseSpeed =
        m.hp < m.maxHp * 0.28
          ? 38
          : m.species === 'rival_ant'
          ? 31
          : m.species === 'mite'
          ? 25
          : m.species === 'centipede'
          ? 24
          : m.species === 'earwig'
          ? 22
          : 19;

      const rockShelterX =
        (m.homeEdge ?? (m.x < 700 ? 'left' : 'right')) === 'left' ? CASE_LEFT + 72 : CASE_RIGHT - 72;
      const shelterGx = clamp(Math.floor(rockShelterX / CELL_SIZE), 12, GRID_W - 13);
      const shelterPos = { x: rockShelterX, y: this.grid.surfaceY[shelterGx] - 3 };

      let goalX = this.entrancePos.x;
      let wantShaft = false;

      if (retreating) {
        goalX = rockShelterX;
      } else if (m.species === 'rival_ant' || m.species === 'beetle' || m.species === 'earwig') {
        let targetFood =
          m.targetFoodId != null
            ? this.foods.find((f) => f.id === m.targetFoodId && f.storedInChamberId === null && !f.falling && f.amount > 1)
            : undefined;
        if (!targetFood && m.behavior !== 'hunting_ants') {
          let bestD = Infinity;
          for (const f of this.foods) {
            if (f.storedInChamberId === null && !f.falling && f.amount > 1) {
              const d = Math.abs(f.x - m.x);
              if (d < bestD) {
                bestD = d;
                targetFood = f;
              }
            }
          }
          m.targetFoodId = targetFood ? targetFood.id : null;
        }
        if (targetFood) {
          goalX = targetFood.x;
          if (Math.hypot(targetFood.x - m.x, targetFood.y - m.y) < 12) {
            const stolen = Math.min(targetFood.amount, 12);
            targetFood.amount -= stolen;
            m.carryingFoodAmount = stolen;
            m.targetFoodId = null;
            m.path = [];
          }
        } else if (m.species === 'rival_ant') {
          // Rival raiders target surface ants cleanly without stalling over deep subterranean tunnels
          let prey: Ant | undefined;
          let bestD = 220;
          for (const a of this.ants) {
            if (a.caste === AntCaste.QUEEN) continue;
            const ag = this.grid.worldToGrid(a.x, a.y);
            if (a.y > this.grid.surfaceY[ag.gx] + 10) continue;
            const d = Math.hypot(a.x - m.x, a.y - m.y);
            if (d < bestD) {
              bestD = d;
              prey = a;
            }
          }
          goalX = prey ? prey.x : this.entrancePos.x;
          wantShaft = !prey;
        } else {
          goalX = this.entrancePos.x;
          wantShaft = true;
        }
      } else if (m.species === 'mite') {
        goalX = this.entrancePos.x;
        wantShaft = true;
      } else {
        let prey: Ant | undefined;
        let bestD = 180;
        for (const a of this.ants) {
          if (a.caste === AntCaste.QUEEN) continue;
          const ag = this.grid.worldToGrid(a.x, a.y);
          if (a.y > this.grid.surfaceY[ag.gx] + 12) continue;
          const d = Math.hypot(a.x - m.x, a.y - m.y);
          if (d < bestD) {
            bestD = d;
            prey = a;
          }
        }
        goalX = prey ? prey.x : this.entrancePos.x;
        wantShaft = !prey;
      }

      const mg = this.grid.worldToGrid(m.x, m.y);
      const inTunnel = this.grid.terrain[this.grid.idx(mg.gx, mg.gy)] === CellType.TUNNEL || m.y > this.grid.surfaceY[mg.gx] + 6;
      const shouldUseTunnelAStar = (inTunnel || (!retreating && wantShaft && Math.abs(m.x - this.entrancePos.x) < 28));

      if (shouldUseTunnelAStar) {
        const deepGoal = retreating
          ? shelterPos
          : m.species === 'mite' && nursery
          ? { x: nursery.x, y: nursery.y }
          : granary
          ? { x: granary.x, y: granary.y }
          : { x: this.entrancePos.x - 10, y: 340 };

        if ((!m.path || m.path.length === 0 || (m.pathIndex ?? 0) >= m.path.length) && this.simTime - (m.lastPathTime ?? -10) > 0.9 && this.pathBudgetThisTick < 3) {
          this.pathBudgetThisTick++;
          m.lastPathTime = this.simTime;
          m.path = this.grid.findPath({ x: m.x, y: m.y }, deepGoal);
          m.pathIndex = 0;
        }

        const path = m.path ?? [];
        const pIdx = m.pathIndex ?? 0;
        const wp = pIdx < path.length ? path[pIdx] : deepGoal;
        const dx = wp.x - m.x;
        const dy = wp.y - m.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 7 && pIdx < path.length) {
          m.pathIndex = pIdx + 1;
        }
        const a = Math.atan2(dy, dx);
        const step = Math.min(dist, baseSpeed * 0.78 * dt);
        const nx = clamp(m.x + Math.cos(a) * step, CASE_LEFT + 16, CASE_RIGHT - 16);
        const ny = clamp(m.y + Math.sin(a) * step, CASE_TOP + 14, CASE_BOTTOM - 14);
        const ng = this.grid.worldToGrid(nx, ny);
        if (!this.grid.isSolid(ng.gx, ng.gy) && this.grid.isNavigable(ng.gx, ng.gy)) {
          m.x = nx;
          m.y = ny;
        } else {
          const gX = this.grid.worldToGrid(nx, m.y);
          const gY = this.grid.worldToGrid(m.x, ny);
          if (!this.grid.isSolid(gX.gx, gX.gy)) m.x = nx;
          else if (!this.grid.isSolid(gY.gx, gY.gy)) m.y = ny;
          else m.path = [];
        }
        m.angle = a;
      } else {
        m.path = [];
        const dir = goalX >= m.x ? 1 : -1;
        const nx = clamp(m.x + dir * baseSpeed * dt, CASE_LEFT + 16, CASE_RIGHT - 16);
        const gx = clamp(Math.floor(nx / CELL_SIZE), 0, GRID_W - 1);
        const surfY = this.grid.surfaceY[gx] - 2.5;
        const ny = m.y + (surfY - m.y) * Math.min(1, dt * 10);
        const ng = this.grid.worldToGrid(nx, ny);
        if (!this.grid.isSolid(ng.gx, ng.gy)) {
          m.x = nx;
          m.y = ny;
        } else {
          // Step cleanly over steep surface bumps without jamming into the tunnel lip
          m.x = nx;
          m.y = surfY - 2.5;
        }
        m.angle = dir > 0 ? 0 : Math.PI;
      }

      // Hard guarantee no intruder ever remains wedged inside solid soil or a tunnel edge
      const checkMg = this.grid.worldToGrid(m.x, m.y);
      if (this.grid.isSolid(checkMg.gx, checkMg.gy) || !this.grid.isNavigable(checkMg.gx, checkMg.gy)) {
        const safe = this.grid.findNearestNavigable(checkMg.gx, checkMg.gy, 6);
        if (safe) {
          const w = this.grid.gridToWorld(safe.gx, safe.gy);
          m.x = w.x;
          m.y = w.y;
          m.path = [];
        }
      }

      m.vx = (m.x - prevX) / Math.max(0.001, dt);
      m.vy = (m.y - prevY) / Math.max(0.001, dt);

      this.grid.depositPheromone(this.grid.alarmPheromone, m.x, m.y, 0.55 * dt * 10, 2);

      // Combat strike against colony ants (natural mandible standoff range)
      if (m.hp >= m.maxHp * 0.28 && m.attackCooldown <= 0) {
        const nearbyAnt = this.ants.find((a) => a.caste !== AntCaste.QUEEN && Math.hypot(a.x - m.x, a.y - m.y) < 15.5);
        if (nearbyAnt) {
          m.attackCooldown = m.species === 'rival_ant' ? 0.85 : m.species === 'centipede' ? 1.0 : 1.45;
          nearbyAnt.hunger = Math.min(95, nearbyAnt.hunger + (m.species === 'rival_ant' ? 7 : 6));
          if (m.carryingFoodAmount && m.carryingFoodAmount > 0 && nearbyAnt.caste === AntCaste.SOLDIER) {
            this.foods.push({
              id: this.allocId(),
              type: PayloadType.SEED,
              x: m.x,
              y: m.y,
              amount: m.carryingFoodAmount,
              maxAmount: 30,
              radius: 5,
              storedInChamberId: null,
            });
            m.carryingFoodAmount = 0;
          }
          this.particles.push({
            x: (m.x + nearbyAnt.x) * 0.5,
            y: (m.y + nearbyAnt.y) * 0.5,
            vx: (Math.random() - 0.5) * 28,
            vy: -16 - Math.random() * 14,
            size: 1.4,
            alpha: 0.7,
            life: 0,
            maxLife: 0.35,
            kind: 'spark',
            color: '#f59e0b',
          });
        }
      }

      const backInRocks = retreating && Math.abs(m.x - rockShelterX) < 12 && m.y <= SURFACE_BASE_Y + 22;
      if (m.hp <= 0 || backInRocks) {
        if (m.hp <= 0) {
          // Keep dropped protein/seed clear of narrow entrance shafts so bottlenecks never clog
          let dropX = m.x;
          let dropY = m.y;
          const mGx = clamp(Math.floor(m.x / CELL_SIZE), 0, GRID_W - 1);
          const nearMain = Math.abs(m.x - this.entrancePos.x) < 38;
          const nearSide = Math.abs(m.x - 405) < 28;
          if ((nearMain || nearSide) && m.y > this.grid.surfaceY[mGx] - 6) {
            const entX = nearMain ? this.entrancePos.x : 405;
            const side = m.x >= entX ? 1 : -1;
            dropX = clamp(entX + side * (nearMain ? 48 : 34), CASE_LEFT + 32, CASE_RIGHT - 32);
            const dGx = clamp(Math.floor(dropX / CELL_SIZE), 0, GRID_W - 1);
            dropY = this.grid.surfaceY[dGx] - 3;
          }
          if (m.carryingFoodAmount && m.carryingFoodAmount > 0) {
            this.foods.push({
              id: this.allocId(),
              type: PayloadType.SEED,
              x: dropX - 6,
              y: dropY,
              amount: m.carryingFoodAmount,
              maxAmount: 30,
              radius: 5,
              storedInChamberId: null,
            });
          }
          this.foods.push({
            id: this.allocId(),
            type: PayloadType.PROTEIN,
            x: dropX,
            y: dropY,
            amount: m.species === 'rival_ant' ? 24 : 38,
            maxAmount: 48,
            radius: 5,
            storedInChamberId: null,
          });
        }
        this.intruders.splice(i, 1);
      }
    }
  }

  /**
   * Soft pairwise separation & deterministic tangential passing dodge so ants, rival ants,
   * and soil predators never interpenetrate, freeze head-on, or wedge inside one another.
   */
  private resolveEntityCrowding(dt: number): void {
    const canOccupy = (px: number, py: number): boolean => {
      if (px <= CASE_LEFT + 12 || px >= CASE_RIGHT - 12 || py <= CASE_TOP + 12 || py >= CASE_BOTTOM - 12) {
        return false;
      }
      const g = this.grid.worldToGrid(px, py);
      return !this.grid.isSolid(g.gx, g.gy) && this.grid.isNavigable(g.gx, g.gy);
    };

    const nudgePair = (
      a: { id: number; x: number; y: number },
      b: { id: number; x: number; y: number },
      minDist: number,
      strength: number,
      allowDodge: boolean
    ) => {
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.hypot(dx, dy);
      if (dist >= minDist) return;

      if (dist < 0.05) {
        const ang = ((a.id * 2.39996 + b.id * 1.17) % (Math.PI * 2));
        dx = Math.cos(ang);
        dy = Math.sin(ang);
        dist = 1;
      } else {
        dx /= dist;
        dy /= dist;
      }

      const overlap = minDist - dist;
      // Keep the shove well below walking speed (~37 u/s) so a few neighbours can never pin an ant in place;
      // ants should ease around each other (tangential dodge) rather than get bulldozed backwards.
      const push = Math.min(0.9 * dt * 60, overlap * strength * Math.min(1, dt * 18));
      const sign = a.id < b.id ? 1 : -1;
      const dodge = allowDodge ? push * 0.9 * sign : 0;

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

    // 1. Ant vs Ant separation
    const nAnts = this.ants.length;
    for (let i = 0; i < nAnts; i++) {
      const a = this.ants[i];
      for (let j = i + 1; j < nAnts; j++) {
        const b = this.ants[j];
        if (Math.abs(a.x - b.x) > 12 || Math.abs(a.y - b.y) > 12) continue;
        if (a.trophallaxisPartnerId === b.id || b.trophallaxisPartnerId === a.id) continue;
        const minDist = a.caste === AntCaste.QUEEN || b.caste === AntCaste.QUEEN ? 10.5 : 7.5;
        nudgePair(a, b, minDist, 0.55, true);
      }
    }

    // 2. Intruder vs Intruder separation
    const nIntr = this.intruders.length;
    for (let i = 0; i < nIntr; i++) {
      const a = this.intruders[i];
      for (let j = i + 1; j < nIntr; j++) {
        const b = this.intruders[j];
        if (Math.abs(a.x - b.x) > 16 || Math.abs(a.y - b.y) > 16) continue;
        const large =
          a.species === 'beetle' ||
          a.species === 'centipede' ||
          b.species === 'beetle' ||
          b.species === 'centipede';
        nudgePair(a, b, large ? 13.5 : 10.5, 0.65, true);
      }
    }

    // 3. Ant vs Intruder combat standoff (face-to-face bite distance without merging inside torsos)
    for (let i = 0; i < nIntr; i++) {
      const m = this.intruders[i];
      const standoff = m.species === 'rival_ant' || m.species === 'mite' ? 9.0 : 12.0;
      for (let j = 0; j < nAnts; j++) {
        const a = this.ants[j];
        if (Math.abs(a.x - m.x) > 15 || Math.abs(a.y - m.y) > 15) continue;
        nudgePair(a, m, standoff, 0.65, true);
      }
    }
  }

  private stepFallenAnts(dt: number): void {
    for (let i = this.fallenAnts.length - 1; i >= 0; i--) {
      const f = this.fallenAnts[i];
      if (f.carriedByAntId !== null) continue;
      // Corpses at the midden are broken down quickly; any left lying elsewhere desiccate and get dismantled
      // by passers-by far more slowly, so they can never pile up without bound.
      f.decayTimer -= dt * (f.atMidden ? 1 : 0.12);
      if (f.decayTimer <= 0) {
        this.fallenAnts.splice(i, 1);
      }
    }
  }

  /**
   * Colonies reallocate labour when a task is short-handed. If nurses run low (they age out like everyone else)
   * a worker switches to brood care, otherwise larvae starve and the colony cannot renew itself.
   */
  private rebalanceLabour(dt: number): void {
    this.labourTimer -= dt;
    if (this.labourTimer > 0) return;
    this.labourTimer = 4 + Math.random() * 3;

    let nurses = 0;
    let total = 0;
    for (const a of this.ants) {
      if (a.caste === AntCaste.QUEEN) continue;
      total++;
      if (a.caste === AntCaste.NURSE) nurses++;
    }
    const needed = Math.max(3, Math.round(total * 0.14));
    if (nurses >= needed || total < 6) return;

    // Prefer an unladen worker that is already inside the nest, else any unladen worker.
    let pick: Ant | null = null;
    let pickInside = false;
    for (const a of this.ants) {
      if (a.caste !== AntCaste.WORKER || a.payload !== PayloadType.NONE || a.payloadId !== null || a.recruitFoodPos) continue;
      const inside = a.y > this.grid.surfaceY[clamp(Math.floor(a.x / CELL_SIZE), 0, GRID_W - 1)] + 14;
      if (!pick || (inside && !pickInside)) {
        pick = a;
        pickInside = inside;
      }
      if (inside) break;
    }
    if (pick) {
      pick.caste = AntCaste.NURSE;
      pick.task = AntTask.MOVING_BROOD;
      pick.path = [];
      pick.targetPos = null;
      pick.speed = 29 + Math.random() * 4;
    }
  }

  private stepAnts(dt: number): void {
    this.rebalanceLabour(dt);
    const granary = this.getChamber(ChamberType.GRANARY);
    const nursery = this.getChamber(ChamberType.NURSERY);
    const royal = this.getChamber(ChamberType.ROYAL);

    // Queen egg laying
    if (royal) {
      const storedFood = this.foods
        .filter((f) => f.storedInChamberId !== null)
        .reduce((acc, f) => acc + f.amount, 0);
      this.queenEggTimer -= dt;
      if (this.queenEggTimer <= 0) {
        this.queenEggTimer = storedFood > 60 ? 5.2 : 10.5;
        if (this.brood.length < 44 && this.ants.length + this.brood.length < MAX_COLONY && storedFood > 15) {
          const queen = this.ants.find((a) => a.caste === AntCaste.QUEEN);
          if (queen) {
            queen.task = AntTask.LAYING_EGG;
            queen.stateTimer = 1.4;
            this.brood.push({
              id: this.allocId(),
              stage: BroodStage.EGG,
              x: queen.x - Math.cos(queen.angle) * 14,
              y: queen.y - Math.sin(queen.angle) * 14,
              progress: 0,
              nutrition: 100,
              carriedByAntId: null,
              chamberId: royal.id,
              wigglePhase: Math.random() * Math.PI * 2,
            });
          }
        }
      }
    }

    for (let i = this.ants.length - 1; i >= 0; i--) {
      const ant = this.ants[i];
      ant.age += dt;
      ant.greetCooldown = Math.max(0, ant.greetCooldown - dt);
      ant.signalCooldown = Math.max(0, (ant.signalCooldown ?? 0) - dt);
      ant.antennaPhase += dt * (ant.task === AntTask.TROPHALLAXIS || ant.task === AntTask.GREETING || ant.task === AntTask.SIGNALING_FOOD ? 18 : 8);

      if (ant.isCallow) {
        ant.callowTimer -= dt;
        if (ant.callowTimer <= 0) ant.isCallow = false;
      }

      // Natural end of life -> becomes FallenAnt for Necrophoresis undertakers
      if (ant.caste !== AntCaste.QUEEN && ant.age > ant.maxAge) {
        if (ant.payloadId !== null) {
          if (ant.payload === PayloadType.REFUSE) {
            const carriedFa = this.fallenAnts.find((f) => f.id === ant.payloadId);
            if (carriedFa) carriedFa.carriedByAntId = null;
          } else {
            const b = this.brood.find((br) => br.id === ant.payloadId);
            if (b) b.carriedByAntId = null;
          }
        }
        let fx = ant.x;
        let fy = ant.y;
        const fgx = clamp(Math.floor(ant.x / CELL_SIZE), 0, GRID_W - 1);
        const surfY = this.grid.surfaceY[fgx];
        if ((Math.abs(ant.x - this.entrancePos.x) < 28 || Math.abs(ant.x - 405) < 22) && ant.y > surfY - 4 && ant.y < surfY + 60) {
          const entX = Math.abs(ant.x - this.entrancePos.x) < 28 ? this.entrancePos.x : 405;
          const side = ant.id % 2 === 0 ? 1 : -1;
          fx = clamp(entX + side * 46, CASE_LEFT + 32, CASE_RIGHT - 32);
          const nGx = clamp(Math.floor(fx / CELL_SIZE), 0, GRID_W - 1);
          fy = this.grid.surfaceY[nGx] - 2;
        }
        this.fallenAnts.push({
          id: this.allocId(),
          x: fx,
          y: fy,
          angle: ant.angle,
          carriedByAntId: null,
          atMidden: false,
          decayTimer: 22,
        });
        this.ants.splice(i, 1);
        continue;
      }

      ant.hunger = clamp(ant.hunger + dt * (ant.caste === AntCaste.QUEEN ? 0.2 : 0.12), 0, 100);
      ant.hydration = clamp(ant.hydration - dt * 0.25, 0, 100);

      if (ant.hunger > 72 && ant.caste !== AntCaste.QUEEN && ant.payload === PayloadType.NONE) {
        const stored = this.foods.find(
          (f) => f.storedInChamberId !== null && f.amount > 2 && Math.hypot(f.x - ant.x, f.y - ant.y) < 38
        );
        if (stored) {
          stored.amount = Math.max(0, stored.amount - 5);
          ant.hunger = Math.max(0, ant.hunger - 48);
          ant.energy = Math.min(100, ant.energy + 35);
        }
      }

      // Resting: in a real colony a large share of workers are idle at any moment. Rest only happens inside a
      // chamber (never in traffic lanes), never while carrying, and is cut short when intruders show up.
      if (ant.task === AntTask.IDLE && ant.caste !== AntCaste.QUEEN) {
        ant.stateTimer -= dt;
        ant.vx = 0;
        ant.vy = 0;
        ant.path = [];
        ant.targetPos = null;
        const alarmed = this.intruderNear(ant, 110) && Math.random() < dt * 1.5;
        if (ant.stateTimer <= 0 || alarmed) this.endRest(ant);
        continue;
      }
      // Walking home to a chamber to rest
      if (ant.task === AntTask.SEEKING_REST && ant.caste !== AntCaste.QUEEN) {
        const ch = this.chambers.find((c) => c.id === ant.restChamberId);
        ant.stateTimer -= dt;
        const giveUp = !ch || ant.stateTimer <= 0 || this.intruderNear(ant, 90) || ant.payload !== PayloadType.NONE;
        if (giveUp) {
          this.endRest(ant);
          continue;
        }
        if (this.isInsideChamber(ant, ch, 0.55)) {
          ant.task = AntTask.IDLE;
          ant.stateTimer = this.napDuration(ant);
          ant.path = [];
          ant.targetPos = null;
          continue;
        }
        if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.0 && this.pathBudgetThisTick < 4) {
          this.pathBudgetThisTick++;
          ant.lastPathCalcTime = this.simTime;
          ant.path = this.grid.findPath(
            { x: ant.x, y: ant.y },
            { x: ch.x + (Math.random() - 0.5) * ch.rx * 0.9, y: ch.y + (Math.random() - 0.5) * ch.ry * 0.5 }
          );
          ant.pathIndex = 0;
        }
        this.moveAnt(ant, dt);
        continue;
      }

      if (ant.caste !== AntCaste.QUEEN) {
        ant.restCooldown = (ant.restCooldown ?? 10 + Math.random() * 60) - dt;
        if (ant.restCooldown <= 0 && this.isCalmAndUnladen(ant)) {
          const here = this.chambers.find((c) => this.isInsideChamber(ant, c, 1.0));
          if (here && Math.random() < dt * 1.5) {
            // already in a chamber: just settle down
            ant.task = AntTask.IDLE;
            ant.stateTimer = this.napDuration(ant);
            ant.path = [];
            ant.targetPos = null;
            continue;
          }
          if (!here && Math.random() < dt * 0.12 && this.chambers.length > 0) {
            // decide to head home for a rest
            const ch = this.chambers[Math.floor(Math.random() * this.chambers.length)];
            ant.task = AntTask.SEEKING_REST;
            ant.restChamberId = ch.id;
            ant.stateTimer = 40; // give up if we cannot get there
            ant.path = [];
            ant.targetPos = null;
            ant.lastPathCalcTime = -10;
            continue;
          }
        }
      }

      // Handle transient social, grooming, fungus-tending, and food-signaling states
      if (ant.task === AntTask.SIGNALING_FOOD) {
        ant.stateTimer -= dt;
        ant.vx = 0;
        ant.vy = 0;
        const foodTarget = ant.recruitFoodPos;
        if (foodTarget) {
          let recruited = 0;
          for (const mate of this.ants) {
            if (
              mate.id !== ant.id &&
              mate.caste === AntCaste.WORKER &&
              mate.payload === PayloadType.NONE &&
              !mate.recruitFoodPos &&
              mate.task !== AntTask.SIGNALING_FOOD &&
              mate.task !== AntTask.DEFENDING &&
              Math.hypot(mate.x - ant.x, mate.y - ant.y) < 58
            ) {
              mate.recruitFoodPos = { x: foodTarget.x, y: foodTarget.y };
              mate.task = AntTask.FOLLOWING_FOOD_TRAIL;
              mate.path = [];
              mate.targetPos = null;
              recruited++;
              if (recruited >= 3) break;
            }
          }
        }
        if (ant.stateTimer <= 0) {
          ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
          ant.path = [];
          ant.targetPos = null;
        }
        continue;
      }

      if (ant.task === AntTask.TROPHALLAXIS || ant.task === AntTask.GREETING) {
        ant.stateTimer -= dt;
        const partner = this.ants.find((o) => o.id === ant.trophallaxisPartnerId);
        if (partner) {
          ant.targetAngle = Math.atan2(partner.y - ant.y, partner.x - ant.x);
          ant.angle = lerpAngle(ant.angle, ant.targetAngle, Math.min(1, dt * 10));
        }
        if (ant.stateTimer <= 0 || !partner) {
          ant.trophallaxisPartnerId = null;
          ant.task =
            ant.caste === AntCaste.QUEEN
              ? AntTask.IDLE
              : ant.caste === AntCaste.NURSE
              ? AntTask.MOVING_BROOD
              : AntTask.FORAGING_SCOUT;
        }
        continue;
      }

      if (ant.task === AntTask.GROOMING || ant.task === AntTask.TENDING_FUNGUS) {
        ant.stateTimer -= dt;
        if (ant.stateTimer <= 0) {
          ant.task =
            ant.caste === AntCaste.NURSE
              ? AntTask.MOVING_BROOD
              : ant.caste === AntCaste.EXCAVATOR
              ? AntTask.EXCAVATING
              : AntTask.FORAGING_SCOUT;
        }
        continue;
      }

      // Occasional antennal greeting between unladen nestmates passing close by (never inside entrance throats!)
      const nearEntranceBottleneck =
        Math.abs(ant.x - this.entrancePos.x) < 48 || Math.abs(ant.x - 405) < 36;
      if (
        !nearEntranceBottleneck &&
        ant.caste !== AntCaste.QUEEN &&
        ant.payload === PayloadType.NONE &&
        ant.greetCooldown <= 0 &&
        this.intruders.length === 0 &&
        Math.random() < 0.015
      ) {
        const other = this.ants.find(
          (o) =>
            o.id !== ant.id &&
            o.caste !== AntCaste.QUEEN &&
            o.greetCooldown <= 0 &&
            o.task !== AntTask.TROPHALLAXIS &&
            o.task !== AntTask.GREETING &&
            o.task !== AntTask.SIGNALING_FOOD &&
            Math.hypot(o.x - ant.x, o.y - ant.y) < 9
        );
        if (other) {
          ant.task = AntTask.GREETING;
          ant.stateTimer = 0.55;
          ant.greetCooldown = 14;
          ant.trophallaxisPartnerId = other.id;
          other.task = AntTask.GREETING;
          other.stateTimer = 0.55;
          other.greetCooldown = 14;
          other.trophallaxisPartnerId = ant.id;
          continue;
        }
      }

      if (ant.caste === AntCaste.QUEEN) {
        this.stepQueen(ant, dt, royal);
      } else if (ant.caste === AntCaste.WORKER) {
        this.stepForager(ant, dt, granary);
      } else if (ant.caste === AntCaste.NURSE) {
        this.stepNurse(ant, dt, royal, nursery, granary);
      } else if (ant.caste === AntCaste.EXCAVATOR) {
        this.stepExcavator(ant, dt, royal);
      } else if (ant.caste === AntCaste.SOLDIER) {
        this.stepSoldier(ant, dt, royal);
      }

      this.moveAnt(ant, dt);

      if (ant.payloadId !== null) {
        if (ant.payload === PayloadType.REFUSE) {
          const fa = this.fallenAnts.find((f) => f.id === ant.payloadId);
          if (fa) {
            fa.x = ant.x + Math.cos(ant.angle) * 7;
            fa.y = ant.y + Math.sin(ant.angle) * 7;
            fa.angle = ant.angle + 0.4;
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
    }
  }

  private stepQueen(ant: Ant, dt: number, royal: Chamber | undefined): void {
    ant.stateTimer -= dt;
    if (ant.task === AntTask.LAYING_EGG && ant.stateTimer <= 0) {
      ant.task = AntTask.IDLE;
    }
    if (!royal) return;

    if (ant.stateTimer <= 0) {
      ant.stateTimer = 2.5 + Math.random() * 3.5;
      ant.targetPos = {
        x: royal.x + (Math.random() - 0.5) * 44,
        y: royal.y + (Math.random() - 0.5) * 14,
      };
    }

    if (Math.hypot(ant.x - royal.x, ant.y - royal.y) > 48) {
      ant.targetPos = { x: royal.x, y: royal.y + 4 };
    }
  }

  private isOnExteriorSurface(x: number, y: number): boolean {
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

  private getSurfaceExitTarget(nearX: number): Vec2 {
    const useMain = Math.abs(nearX - this.entrancePos.x) <= Math.abs(nearX - 405) + 80;
    const entX = useMain ? this.entrancePos.x : 405;
    const side = nearX >= entX ? 1 : -1;
    const exitX = clamp(entX + side * (useMain ? 44 : 32), CASE_LEFT + 36, CASE_RIGHT - 36);
    const gx = clamp(Math.floor(exitX / CELL_SIZE), 0, GRID_W - 1);
    return { x: exitX, y: this.grid.surfaceY[gx] - 3 };
  }

  private findDigFrontierTarget(ant: Ant): Vec2 | null {
    // Prefer expanding around existing chambers or deep subsoil frontiers
    for (let attempt = 0; attempt < 24; attempt++) {
      const rx = 14 + Math.floor(Math.random() * (GRID_W - 28));
      const ry = 42 + Math.floor(Math.random() * (GRID_H - 54));
      if (this.grid.terrain[this.grid.idx(rx, ry)] !== CellType.TUNNEL) continue;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          if (this.grid.isDiggable(rx + ox, ry + oy) && (ry + oy) * CELL_SIZE > this.grid.surfaceY[rx + ox] + 24) {
            return this.grid.gridToWorld(rx, ry);
          }
        }
      }
    }
    const royal = this.getChamber(ChamberType.ROYAL);
    return royal ? { x: royal.x + (Math.random() - 0.5) * 32, y: royal.y + 4 } : null;
  }

  private stepForager(ant: Ant, dt: number, granary: Chamber | undefined): void {
    ant.pheromoneDropTimer -= dt;
    const onSurface = this.isOnExteriorSurface(ant.x, ant.y);

    // Engage rival raiding ants or evade large soil predators
    if (this.intruders.length > 0 && ant.payload === PayloadType.NONE) {
      const threat = this.intruders.find(
        (m) => m.hp >= m.maxHp * 0.28 && Math.hypot(m.x - ant.x, m.y - ant.y) < 42
      );
      if (threat) {
        this.grid.depositPheromone(this.grid.alarmPheromone, ant.x, ant.y, 0.55, 2);
        const nearEntrance = Math.abs(threat.x - this.entrancePos.x) < 130;
        const fightRival = threat.species === 'rival_ant' || threat.species === 'mite' || nearEntrance;
        if (fightRival) {
          ant.task = AntTask.DEFENDING;
          const dist = Math.hypot(threat.x - ant.x, threat.y - ant.y);
          if (dist < 16) {
            ant.stateTimer -= dt;
            if (ant.stateTimer <= 0) {
              ant.stateTimer = 0.55;
              threat.hp -= 5;
              this.particles.push({
                x: (ant.x + threat.x) * 0.5,
                y: (ant.y + threat.y) * 0.5,
                vx: (Math.random() - 0.5) * 18,
                vy: -10 - Math.random() * 10,
                size: 1.1,
                alpha: 0.7,
                life: 0,
                maxLife: 0.22,
                kind: 'spark',
                color: '#fef08a',
              });
            }
            ant.targetAngle = Math.atan2(threat.y - ant.y, threat.x - ant.x);
          } else {
            ant.targetPos = { x: threat.x, y: threat.y };
          }
          return;
        }
        ant.task = AntTask.FLEEING;
        const awayDir = ant.x >= threat.x ? 1 : -1;
        const fleeX = clamp(ant.x + awayDir * 48, CASE_LEFT + 26, CASE_RIGHT - 26);
        const fgx = Math.floor(fleeX / CELL_SIZE);
        ant.targetPos = { x: fleeX, y: this.grid.surfaceY[clamp(fgx, 0, GRID_W - 1)] - 2 };
        return;
      }
    }

    // 0. Necrophoresis: Carry fallen ant out to surface Midden
    if (ant.payload === PayloadType.REFUSE) {
      ant.task = AntTask.NECROPHORESIS;
      if (onSurface && Math.hypot(ant.x - this.middenPos.x, ant.y - this.middenPos.y) < 28) {
        const fa = this.fallenAnts.find((f) => f.id === ant.payloadId);
        if (fa) {
          fa.carriedByAntId = null;
          fa.atMidden = true;
          fa.x = this.middenPos.x + (Math.random() - 0.5) * 18;
          fa.y = this.middenPos.y;
        }
        ant.payload = PayloadType.NONE;
        ant.payloadId = null;
        ant.path = [];
        ant.task = AntTask.FORAGING_SCOUT;
        return;
      }
      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.2 && this.pathBudgetThisTick < 3) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        const goal = onSurface ? this.middenPos : this.getSurfaceExitTarget(ant.x);
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, goal);
        ant.pathIndex = 0;
      }
      return;
    }

    // 1. Carrying food home to Granary (laying invisible chemical foodPheromone)
    if (ant.payload === PayloadType.SEED || ant.payload === PayloadType.HONEYDEW || ant.payload === PayloadType.PROTEIN) {
      ant.task = AntTask.RETURNING_WITH_FOOD;
      if (ant.pheromoneDropTimer <= 0) {
        ant.pheromoneDropTimer = 0.14;
        this.grid.depositPheromone(this.grid.foodPheromone, ant.x, ant.y, 0.52, 1);
      }

      if (granary) {
        const distGranary = Math.hypot(ant.x - granary.x, ant.y - granary.y);
        if (distGranary < 34) {
          const existing = this.foods.find(
            (f) => f.storedInChamberId === granary.id && f.type === ant.payload && f.amount < f.maxAmount - 4
          );
          if (existing) {
            existing.amount = Math.min(existing.maxAmount, existing.amount + ant.payloadValue);
          } else if (this.foods.filter((f) => f.storedInChamberId === granary.id).length < 10) {
            this.foods.push({
              id: this.allocId(),
              type: ant.payload,
              x: granary.x + (Math.random() - 0.5) * 52,
              y: granary.y + 8 + Math.random() * 8,
              amount: ant.payloadValue,
              maxAmount: 50,
              radius: 5,
              storedInChamberId: granary.id,
            });
          }
          ant.payload = PayloadType.NONE;
          ant.payloadValue = 0;
          ant.hunger = Math.max(0, ant.hunger - 18);
          ant.path = [];
          ant.targetPos = null;
          // Scout performs antennal food signaling inside granary/entrance if source had more food!
          if (ant.recruitFoodPos && (ant.signalCooldown ?? 0) <= 0) {
            ant.task = AntTask.SIGNALING_FOOD;
            ant.stateTimer = 1.6;
            ant.signalCooldown = 12;
          } else {
            ant.task = AntTask.FORAGING_SCOUT;
          }
          return;
        }

        if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.0 && this.pathBudgetThisTick < 4) {
          this.pathBudgetThisTick++;
          ant.lastPathCalcTime = this.simTime;
          ant.path = this.grid.findPath(
            { x: ant.x, y: ant.y },
            { x: granary.x + (Math.random() - 0.5) * 18, y: granary.y + 6 },
            { preferHomePheromone: true }
          );
          ant.pathIndex = 0;
        }
      }
      return;
    }

    if (ant.pheromoneDropTimer <= 0) {
      ant.pheromoneDropTimer = 0.2;
      this.grid.depositPheromone(this.grid.homePheromone, ant.x, ant.y, 0.24, 1);
    }

    // Check for fallen nestmate needing undertaker
    // Undertaking is done by a specialist minority of foragers, not by every worker that walks past a corpse.
    const fallen =
      ant.id % 5 === 0
        ? this.fallenAnts.find(
            (f) => !f.atMidden && f.carriedByAntId === null && Math.hypot(f.x - ant.x, f.y - ant.y) < 18
          )
        : undefined;
    if (fallen) {
      fallen.carriedByAntId = ant.id;
      ant.payload = PayloadType.REFUSE;
      ant.payloadId = fallen.id;
      ant.path = [];
      ant.task = AntTask.NECROPHORESIS;
      return;
    }

    // Check near surface food (must have landed)
    const nearFood = this.foods.find(
      (f) => f.storedInChamberId === null && !f.falling && f.amount > 1 && Math.hypot(f.x - ant.x, f.y - ant.y) < 16
    );
    if (nearFood) {
      const take = Math.min(nearFood.amount, 8);
      nearFood.amount -= take;
      ant.pauseTimer = 0.35 + Math.random() * 0.4; // antennate the find before hauling it off
      ant.payload = nearFood.type;
      ant.payloadValue = take;
      ant.recruitFoodPos = nearFood.amount > 4 ? { x: nearFood.x, y: nearFood.y } : null;
      ant.path = [];
      ant.targetPos = null;
      ant.task = AntTask.RETURNING_WITH_FOOD;
      this.grid.depositPheromone(this.grid.foodPheromone, ant.x, ant.y, 0.9, 2);
      return;
    }

    // If inside subterranean tunnels or the entrance shaft throat, NEVER switch to straight-line surface roaming!
    // Follow A* cleanly out past the entrance rim until actually standing in AIR on the exterior surface.
    if (!onSurface) {
      // If recruited toward a discovered food source, route straight there via A*
      if (ant.recruitFoodPos) {
        ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
        if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.1 && this.pathBudgetThisTick < 4) {
          this.pathBudgetThisTick++;
          ant.lastPathCalcTime = this.simTime;
          ant.path = this.grid.findPath(
            { x: ant.x, y: ant.y },
            ant.recruitFoodPos,
            { preferFoodPheromone: true }
          );
          ant.pathIndex = 0;
        }
        return;
      }

      // Occasionally tend the fungus garden briefly if passing nearby, else exit to forage
      const fungusCh = this.getChamber(ChamberType.FUNGUS);
      if (fungusCh && Math.hypot(ant.x - fungusCh.x, ant.y - fungusCh.y) < 28 && Math.random() < 0.08) {
        ant.task = AntTask.TENDING_FUNGUS;
        ant.stateTimer = 1.4;
        return;
      }

      ant.task = AntTask.FORAGING_SCOUT;
      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 0.9 && this.pathBudgetThisTick < 4) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, this.getSurfaceExitTarget(ant.x));
        ant.pathIndex = 0;
      }
      return;
    }

    // --- Below here, ant is guaranteed on exterior surface (AIR) ---

    if (ant.recruitFoodPos) {
      const stillThere = this.foods.some(
        (f) => f.storedInChamberId === null && !f.falling && f.amount > 1 && Math.hypot(f.x - ant.recruitFoodPos!.x, f.y - ant.recruitFoodPos!.y) < 30
      );
      if (!stillThere) {
        ant.recruitFoodPos = null;
      } else {
        ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
        ant.targetPos = { x: ant.recruitFoodPos.x, y: ant.recruitFoodPos.y };
        return;
      }
    }

    if (ant.hydration < 62) {
      const drop = this.droplets.find((d) => d.settled && Math.hypot(d.x - ant.x, d.y - ant.y) < 55);
      if (drop) {
        ant.task = AntTask.DRINKING_DEW;
        ant.targetPos = { x: drop.x, y: drop.y };
        if (Math.hypot(drop.x - ant.x, drop.y - ant.y) < 8) {
          ant.hydration = 100;
          drop.volume = Math.max(0, drop.volume - 2);
        }
        return;
      }
    }

    const visibleFood = this.foods.find(
      (f) => f.storedInChamberId === null && !f.falling && f.amount > 1 && Math.hypot(f.x - ant.x, f.y - ant.y) < 110
    );
    if (visibleFood) {
      ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
      ant.targetPos = { x: visibleFood.x, y: visibleFood.y };
      return;
    }

    // Follow invisible chemical foodPheromone gradient across surface
    const gL = this.grid.worldToGrid(ant.x - 18, ant.y);
    const gR = this.grid.worldToGrid(ant.x + 18, ant.y);
    const pL = this.grid.foodPheromone[this.grid.idx(gL.gx, gL.gy)] +
      this.grid.foodPheromone[this.grid.idx(gL.gx, Math.max(0, gL.gy - 1))];
    const pR = this.grid.foodPheromone[this.grid.idx(gR.gx, gR.gy)] +
      this.grid.foodPheromone[this.grid.idx(gR.gx, Math.max(0, gR.gy - 1))];

    ant.stateTimer -= dt;
    if (pL > 0.05 || pR > 0.05) {
      ant.task = AntTask.FOLLOWING_FOOD_TRAIL;
      // Commit to a direction for a while. Re-deciding every tick made ants flip left/right and shuffle in place
      // wherever both sides smelled alike (old, fading trails around food that was already carried off).
      ant.trailCommit = (ant.trailCommit ?? 0) - dt;
      if (ant.trailDir === undefined || ant.trailCommit <= 0) {
        const hi = Math.max(pL, pR);
        const clearlyRight = pR > pL + hi * 0.15;
        const clearlyLeft = pL > pR + hi * 0.15;
        ant.trailDir = clearlyRight ? 1 : clearlyLeft ? -1 : Math.cos(ant.angle) >= 0 ? 1 : -1;
        ant.trailCommit = 1.2 + Math.random() * 1.4;
      }
      const dir = ant.trailDir;
      const tx = clamp(ant.x + dir * 34, CASE_LEFT + 28, CASE_RIGHT - 28);
      const gx = clamp(Math.floor(tx / CELL_SIZE), 0, GRID_W - 1);
      ant.targetPos = { x: tx, y: this.grid.surfaceY[gx] - 2 };
    } else if (ant.stateTimer <= 0 || !ant.targetPos) {
      ant.task = AntTask.FORAGING_SCOUT;
      ant.stateTimer = 2.4 + Math.random() * 3.2;
      if (ant.hunger > 65 && granary) {
        if (this.pathBudgetThisTick < 3) {
          this.pathBudgetThisTick++;
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: granary.x, y: granary.y });
          ant.pathIndex = 0;
        }
      } else {
        const roamX = clamp(ant.x + (Math.random() - 0.5) * 320, CASE_LEFT + 44, CASE_RIGHT - 44);
        const gx = Math.floor(roamX / CELL_SIZE);
        ant.targetPos = { x: roamX, y: this.grid.surfaceY[gx] - 2 };
      }
    }
  }

  private stepNurse(
    ant: Ant,
    dt: number,
    royal: Chamber | undefined,
    nursery: Chamber | undefined,
    granary: Chamber | undefined
  ): void {
    // 1. Carrying brood item -> deliver to Nursery (or reposition gently inside Nursery)
    if (ant.payloadId !== null && nursery) {
      ant.task = AntTask.MOVING_BROOD;
      const d = Math.hypot(ant.x - nursery.x, ant.y - nursery.y);
      if (d < 34) {
        const b = this.brood.find((br) => br.id === ant.payloadId);
        if (b) {
          b.carriedByAntId = null;
          b.chamberId = nursery.id;
          b.x = nursery.x + (Math.random() - 0.5) * 44;
          b.y = nursery.y + 10;
        }
        ant.payloadId = null;
        ant.payload = PayloadType.NONE;
        ant.path = [];
        ant.targetPos = null;
        return;
      }
      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.0 && this.pathBudgetThisTick < 4) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: nursery.x, y: nursery.y + 6 });
        ant.pathIndex = 0;
      }
      return;
    }

    // 2. Deterministically pick up any eggs waiting in the Royal Chamber
    if (royal && nursery) {
      const strayEgg = this.brood.find(
        (b) => b.carriedByAntId === null && b.stage === BroodStage.EGG && b.chamberId === royal.id && b.progress > 6
      );
      if (strayEgg) {
        ant.task = AntTask.MOVING_BROOD;
        if (Math.hypot(strayEgg.x - ant.x, strayEgg.y - ant.y) < 16) {
          strayEgg.carriedByAntId = ant.id;
          ant.payloadId = strayEgg.id;
          ant.payload = PayloadType.EGG;
          ant.path = [];
          return;
        }
        if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 0.9 && this.pathBudgetThisTick < 4) {
          this.pathBudgetThisTick++;
          ant.lastPathCalcTime = this.simTime;
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: strayEgg.x, y: strayEgg.y });
          ant.pathIndex = 0;
        }
        return;
      }
    }

    // 3. Feed hungry larvae (fetching nutrition from Granary first if needed)
    const hungryLarva = this.brood.find(
      (b) => b.carriedByAntId === null && b.stage === BroodStage.LARVA && b.nutrition < 78
    );
    if (hungryLarva) {
      if (ant.hunger < 65) {
        ant.task = AntTask.FEEDING_LARVA;
        const d = Math.hypot(hungryLarva.x - ant.x, hungryLarva.y - ant.y);
        if (d < 12) {
          hungryLarva.nutrition = Math.min(100, hungryLarva.nutrition + 34);
          ant.hunger += 9;
          ant.task = AntTask.GROOMING;
          ant.stateTimer = 0.85;
          return;
        }
        if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.1 && this.pathBudgetThisTick < 4) {
          this.pathBudgetThisTick++;
          ant.lastPathCalcTime = this.simTime;
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: hungryLarva.x, y: hungryLarva.y });
          ant.pathIndex = 0;
        }
        return;
      } else if (granary) {
        if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.2 && this.pathBudgetThisTick < 3) {
          this.pathBudgetThisTick++;
          ant.lastPathCalcTime = this.simTime;
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: granary.x, y: granary.y });
          ant.pathIndex = 0;
        }
        return;
      }
    }

    // 4. Dedicated Queen Care Retinue: feed and groom the Queen
    const queen = this.ants.find((a) => a.caste === AntCaste.QUEEN);
    if (queen && ((queen.hunger > 18 && ant.hunger < 55) || ant.id % 3 === 0)) {
      const dq = Math.hypot(queen.x - ant.x, queen.y - ant.y);
      if (dq < 18) {
        if (queen.hunger > 15 && ant.hunger < 60) {
          ant.task = AntTask.TROPHALLAXIS;
          ant.stateTimer = 1.4;
          ant.trophallaxisPartnerId = queen.id;
          queen.task = AntTask.TROPHALLAXIS;
          queen.stateTimer = 1.4;
          queen.trophallaxisPartnerId = ant.id;
          queen.hunger = Math.max(0, queen.hunger - 26);
          ant.hunger += 12;
        } else {
          ant.task = AntTask.GROOMING;
          ant.stateTimer = 1.2;
          ant.targetAngle = Math.atan2(queen.y - ant.y, queen.x - ant.x);
        }
        return;
      }
      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.5 && this.pathBudgetThisTick < 3) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: queen.x, y: queen.y });
        ant.pathIndex = 0;
      }
      ant.task = AntTask.TENDING_QUEEN;
      return;
    }

    // 5. Groom & tend specific brood items in Nursery (never wander empty tunnels!)
    const anyBrood = this.brood.find((b) => b.carriedByAntId === null && b.chamberId === nursery?.id);
    if (anyBrood) {
      ant.task = AntTask.FEEDING_LARVA;
      if (Math.hypot(anyBrood.x - ant.x, anyBrood.y - ant.y) < 14) {
        anyBrood.nutrition = Math.min(100, anyBrood.nutrition + 8);
        ant.task = AntTask.GROOMING;
        ant.stateTimer = 0.9;
        return;
      }
      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.4 && this.pathBudgetThisTick < 3) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: anyBrood.x, y: anyBrood.y });
        ant.pathIndex = 0;
      }
      return;
    }

    ant.stateTimer -= dt;
    if (ant.stateTimer <= 0 || !ant.targetPos) {
      ant.stateTimer = 2.0 + Math.random() * 2.0;
      const ch = nursery ?? royal;
      if (ch) {
        ant.task = ch === royal ? AntTask.TENDING_QUEEN : AntTask.FEEDING_LARVA;
        const dest = { x: ch.x + (Math.random() - 0.5) * 40, y: ch.y + (Math.random() - 0.5) * 14 };
        if (Math.hypot(dest.x - ant.x, dest.y - ant.y) > 60 && this.pathBudgetThisTick < 3) {
          this.pathBudgetThisTick++;
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, dest);
          ant.pathIndex = 0;
        } else {
          ant.targetPos = dest;
        }
      }
    }
  }

  private depositSoilGranuleAt(worldX: number): void {
    let gx = clamp(
      Math.floor(worldX / CELL_SIZE),
      Math.floor(CASE_LEFT / CELL_SIZE) + 4,
      Math.floor(CASE_RIGHT / CELL_SIZE) - 4
    );

    if (Math.abs(gx * CELL_SIZE - this.entrancePos.x) < 48) {
      gx += gx * CELL_SIZE >= this.entrancePos.x ? 8 : -8;
    }
    if (Math.abs(gx * CELL_SIZE - 405) < 36) {
      gx += gx * CELL_SIZE >= 405 ? 6 : -6;
    }

    for (let step = 0; step < 6; step++) {
      const currGy = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
      const leftGy = Math.floor(this.grid.surfaceY[gx - 1] / CELL_SIZE);
      const rightGy = Math.floor(this.grid.surfaceY[gx + 1] / CELL_SIZE);

      if (leftGy > currGy && Math.abs((gx - 1) * CELL_SIZE - this.entrancePos.x) >= 48 && Math.abs((gx - 1) * CELL_SIZE - 405) >= 36) {
        gx -= 1;
      } else if (rightGy > currGy && Math.abs((gx + 1) * CELL_SIZE - this.entrancePos.x) >= 48 && Math.abs((gx + 1) * CELL_SIZE - 405) >= 36) {
        gx += 1;
      } else {
        break;
      }
    }

    const surfGy = Math.floor(this.grid.surfaceY[gx] / CELL_SIZE);
    const placeGy = surfGy - 1;
    if (placeGy > Math.floor((CASE_TOP + 64) / CELL_SIZE) && this.grid.inBounds(gx, placeGy)) {
      const belowT = this.grid.terrain[this.grid.idx(gx, surfGy)];
      if (this.grid.terrain[this.grid.idx(gx, placeGy)] === CellType.AIR && belowT !== CellType.TUNNEL) {
        this.grid.setTerrain(gx, placeGy, CellType.SUBSOIL);
        this.grid.updateSurfaceProfile();

        const newSurfY = this.grid.surfaceY[gx];
        const wx = (gx + 0.5) * CELL_SIZE;
        for (const other of this.ants) {
          if (Math.abs(other.x - wx) < 11 && other.y >= newSurfY - 5 && other.y <= newSurfY + 9) {
            other.y = newSurfY - 1.5;
          }
        }
        for (const f of this.foods) {
          if (f.storedInChamberId === null && !f.falling && Math.abs(f.x - wx) < 10 && f.y >= newSurfY - 4) {
            f.y = newSurfY - 3;
          }
        }

        for (let k = 0; k < 3; k++) {
          this.particles.push({
            x: wx + (Math.random() - 0.5) * 6,
            y: newSurfY - 3,
            vx: (Math.random() - 0.5) * 18,
            vy: -8 - Math.random() * 12,
            size: 1.1 + Math.random() * 1.1,
            alpha: 0.9,
            life: 0,
            maxLife: 0.42,
            kind: 'crumb',
            color: '#8c623d',
          });
        }
      }
    }
  }

  private stepExcavator(ant: Ant, dt: number, royal: Chamber | undefined): void {
    const onSurface = this.isOnExteriorSurface(ant.x, ant.y);

    if (ant.payload === PayloadType.SOIL) {
      ant.task = AntTask.CARRYING_SOIL;

      if (!ant.targetPos || ant.targetPos.y > SURFACE_BASE_Y + 12) {
        const useMain = Math.abs(ant.x - this.entrancePos.x) < Math.abs(ant.x - 405) + 120;
        const entX = useMain ? this.entrancePos.x : 405;
        const side = (ant.id + Math.floor(this.simTime * 0.1)) % 2 === 0 ? 1 : -1;
        const offset = (useMain ? 48 : 36) + ((ant.id * 19 + Math.floor(ant.age * 3)) % 46);
        const dropX = clamp(entX + side * offset, CASE_LEFT + 30, CASE_RIGHT - 30);
        const gx = Math.floor(dropX / CELL_SIZE);
        ant.targetPos = { x: dropX, y: this.grid.surfaceY[clamp(gx, 0, GRID_W - 1)] - 3 };
      }

      const dropX = ant.targetPos.x;
      const gxCurr = clamp(Math.floor(ant.x / CELL_SIZE), 0, GRID_W - 1);
      const surfYCurr = this.grid.surfaceY[gxCurr];

      // Only drop soil once cleanly past the flared entrance funnel rim!
      if (onSurface && (Math.abs(ant.x - dropX) < 14 || Math.abs(ant.x - this.entrancePos.x) > 48)) {
        const nearDrop = Math.abs(ant.x - dropX) < 14 && Math.abs(ant.y - surfYCurr) < 14;
        const nearMoundEdge =
          (Math.abs(ant.x - this.entrancePos.x) > 48 && Math.abs(ant.x - this.entrancePos.x) < 104) ||
          (Math.abs(ant.x - 405) > 36 && Math.abs(ant.x - 405) < 76);
        if (nearDrop || (nearMoundEdge && Math.abs(ant.x - dropX) < 24)) {
          this.depositSoilGranuleAt(ant.x);
          ant.pauseTimer = 0.3 + Math.random() * 0.3;
          ant.payload = PayloadType.NONE;
          ant.path = [];
          ant.targetPos = null;
          ant.task = AntTask.EXCAVATING;
          return;
        }
      }

      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.0 && this.pathBudgetThisTick < 4) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        const gx = clamp(Math.floor(dropX / CELL_SIZE), 0, GRID_W - 1);
        const goal = onSurface ? { x: dropX, y: this.grid.surfaceY[gx] - 3 } : this.getSurfaceExitTarget(ant.x);
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, goal);
        ant.pathIndex = 0;
      }
      return;
    }

    ant.task = AntTask.EXCAVATING;
    ant.stateTimer -= dt;

    // If on exterior surface without soil payload, immediately re-enter the nest to dig!
    if (onSurface) {
      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.0 && this.pathBudgetThisTick < 3) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        const dest = this.findDigFrontierTarget(ant) ?? (royal ? { x: royal.x, y: royal.y + 4 } : null);
        if (dest) {
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, dest);
          ant.pathIndex = 0;
        }
      }
      return;
    }

    const g = this.grid.worldToGrid(ant.x, ant.y);
    let bestGx = -1;
    let bestGy = -1;
    let bestScore = -999;

    const desiredDugBudget = 340 + this.ants.length * 8;

    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = g.gx + dx;
        const ny = g.gy + dy;
        if (!this.grid.isDiggable(nx, ny)) continue;
        const wy = ny * CELL_SIZE;
        const wx = nx * CELL_SIZE;
        if (wy < this.grid.surfaceY[nx] + 24) continue;
        if (wx < CASE_LEFT + 34 || wx > CASE_RIGHT - 34 || wy > CASE_BOTTOM - 30) continue;

        let score = 0;
        let tunnelNeighbors = 0;
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            if (this.grid.inBounds(nx + ox, ny + oy) && this.grid.terrain[this.grid.idx(nx + ox, ny + oy)] === CellType.TUNNEL) {
              tunnelNeighbors++;
            }
          }
        }
        if (tunnelNeighbors >= 2 && tunnelNeighbors <= 5) score += 2.6;
        if (ny > 64 && ny < 128) score += 0.8;
        if (this.tunnelsDugCells > desiredDugBudget) score -= 2.2;

        score += Math.random() * 1.1;
        if (score > bestScore) {
          bestScore = score;
          bestGx = nx;
          bestGy = ny;
        }
      }
    }

    if (bestGx !== -1 && bestScore > 1.6 && ant.stateTimer <= 0) {
      this.grid.setTerrain(bestGx, bestGy, CellType.TUNNEL);
      this.tunnelsDugCells++;
      this.nestFieldDirty = true;
      ant.payload = PayloadType.SOIL;
      ant.stateTimer = 1.1 + Math.random() * 0.8;
      ant.path = [];
      ant.targetPos = null;
      const w = this.grid.gridToWorld(bestGx, bestGy);
      for (let k = 0; k < 3; k++) {
        this.particles.push({
          x: w.x,
          y: w.y,
          vx: (Math.random() - 0.5) * 24,
          vy: 10 + Math.random() * 25,
          size: 1.2 + Math.random() * 1.4,
          alpha: 0.85,
          life: 0,
          maxLife: 0.45,
          kind: 'crumb',
          color: '#7c5836',
        });
      }
      return;
    }

    // If excavation budget is temporarily saturated, help tend the Fungus Garden instead of idling!
    if (this.tunnelsDugCells > desiredDugBudget) {
      const fungusCh = this.getChamber(ChamberType.FUNGUS);
      if (fungusCh) {
        if (Math.hypot(ant.x - fungusCh.x, ant.y - fungusCh.y) < 32) {
          ant.task = AntTask.TENDING_FUNGUS;
          ant.stateTimer = 1.8;
          return;
        }
        if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 1.4 && this.pathBudgetThisTick < 3) {
          this.pathBudgetThisTick++;
          ant.lastPathCalcTime = this.simTime;
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, { x: fungusCh.x, y: fungusCh.y + 6 });
          ant.pathIndex = 0;
        }
        return;
      }
    }

    if ((ant.path.length === 0 && !ant.targetPos) || ant.stateTimer <= -2.0) {
      ant.stateTimer = 1.8 + Math.random() * 1.8;
      const dest = this.findDigFrontierTarget(ant);
      if (dest && this.pathBudgetThisTick < 3) {
        this.pathBudgetThisTick++;
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, dest);
        ant.pathIndex = 0;
      }
    }
  }

  private stepSoldier(ant: Ant, dt: number, royal: Chamber | undefined): void {
    const onSurface = this.isOnExteriorSurface(ant.x, ant.y);

    if (this.intruders.length > 0) {
      let target = this.intruders[0];
      let bestDist = Math.hypot(target.x - ant.x, target.y - ant.y);
      for (let idx = 1; idx < this.intruders.length; idx++) {
        const cand = this.intruders[idx];
        const d = Math.hypot(cand.x - ant.x, cand.y - ant.y);
        if (d < bestDist) {
          bestDist = d;
          target = cand;
        }
      }
      ant.task = AntTask.DEFENDING;
      if (bestDist < 18) {
        ant.stateTimer -= dt;
        if (ant.stateTimer <= 0) {
          ant.stateTimer = 0.4;
          target.hp -= 10;
          this.particles.push({
            x: (ant.x + target.x) * 0.5,
            y: (ant.y + target.y) * 0.5,
            vx: (Math.random() - 0.5) * 20,
            vy: -12 - Math.random() * 12,
            size: 1.2,
            alpha: 0.75,
            life: 0,
            maxLife: 0.25,
            kind: 'spark',
            color: '#fef08a',
          });
        }
        ant.targetAngle = Math.atan2(target.y - ant.y, target.x - ant.x);
        return;
      }
      if (ant.path.length === 0 && this.simTime - ant.lastPathCalcTime > 0.7 && this.pathBudgetThisTick < 5) {
        this.pathBudgetThisTick++;
        ant.lastPathCalcTime = this.simTime;
        const goal = !onSurface && target.y <= SURFACE_BASE_Y + 25 ? this.getSurfaceExitTarget(target.x) : { x: target.x, y: target.y };
        ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, goal);
        ant.pathIndex = 0;
      }
      return;
    }

    ant.task = AntTask.PATROLLING;
    ant.stateTimer -= dt;
    if (ant.stateTimer <= 0 || (!ant.targetPos && ant.path.length === 0)) {
      ant.stateTimer = 3.2 + Math.random() * 3.0;
      const guardEntrance = ant.id % 3 !== 0;
      if (guardEntrance) {
        const side = (ant.id % 2 === 0 ? 1 : -1) * (38 + Math.random() * 58);
        const px = clamp(this.entrancePos.x + side, CASE_LEFT + 40, CASE_RIGHT - 40);
        const gx = Math.floor(px / CELL_SIZE);
        const dest = { x: px, y: this.grid.surfaceY[clamp(gx, 0, GRID_W - 1)] - 2 };
        if (!onSurface || Math.hypot(ant.x - dest.x, ant.y - dest.y) > 48) {
          if (this.pathBudgetThisTick < 3) {
            this.pathBudgetThisTick++;
            ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, onSurface ? dest : this.getSurfaceExitTarget(px));
            ant.pathIndex = 0;
          }
        } else {
          ant.targetPos = dest;
        }
      } else if (royal) {
        const dest = {
          x: royal.x + (Math.random() - 0.5) * 80,
          y: royal.y + (Math.random() - 0.5) * 20,
        };
        if (onSurface && this.pathBudgetThisTick < 2) {
          this.pathBudgetThisTick++;
          ant.path = this.grid.findPath({ x: ant.x, y: ant.y }, dest);
          ant.pathIndex = 0;
        } else {
          ant.targetPos = dest;
        }
      }
    }
  }

  private isInsideChamber(ant: Ant, c: Chamber, radiusFrac: number): boolean {
    const dx = (ant.x - c.x) / c.rx;
    const dy = (ant.y - c.y) / c.ry;
    return dx * dx + dy * dy < radiusFrac;
  }

  /** Is any intruder close enough that this ant would notice it (alarm is local, not colony-wide)? */
  private intruderNear(ant: Ant, radius: number): boolean {
    for (const m of this.intruders) {
      if (Math.abs(m.x - ant.x) < radius && Math.abs(m.y - ant.y) < radius) return true;
    }
    return false;
  }

  /** Unladen, calm and not mid-way through something that matters: may consider a rest. */
  private isCalmAndUnladen(ant: Ant): boolean {
    if (ant.payload !== PayloadType.NONE || ant.payloadId !== null || ant.recruitFoodPos) return false;
    if (this.intruderNear(ant, 150)) return false;
    return !(
      ant.task === AntTask.DEFENDING ||
      ant.task === AntTask.FLEEING ||
      ant.task === AntTask.EXCAVATING ||
      ant.task === AntTask.CARRYING_SOIL ||
      ant.task === AntTask.NECROPHORESIS ||
      ant.task === AntTask.SIGNALING_FOOD
    );
  }

  /** Naps are skewed short with the occasional long one; busy castes nap less. */
  private napDuration(ant: Ant): number {
    const scale = ant.caste === AntCaste.SOLDIER ? 0.7 : ant.caste === AntCaste.EXCAVATOR ? 0.8 : 1;
    return (5 + Math.random() * Math.random() * 36) * scale;
  }

  /** Back to the caste's normal work after a rest (or after giving up on reaching one). */
  private endRest(ant: Ant): void {
    ant.task =
      ant.caste === AntCaste.NURSE
        ? AntTask.MOVING_BROOD
        : ant.caste === AntCaste.EXCAVATOR
        ? AntTask.EXCAVATING
        : ant.caste === AntCaste.SOLDIER
        ? AntTask.PATROLLING
        : AntTask.FORAGING_SCOUT;
    ant.restCooldown = 45 + Math.random() * 90;
    ant.path = [];
    ant.targetPos = null;
  }

  /**
   * Locomotion pace: ants never walk at one steady speed. Pace eases toward a task-dependent target with a slow
   * individual ebb and flow, slows for sharp turns, and drops to zero for brief stops (a scout sampling the air,
   * an ant antennating food it just found).
   */
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
    const stepDist = ant.speed * speedFactor * pace * dt;

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
      } else if (ny < surfY - 14) {
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

  private sanitizeAntPositions(): void {
    for (const ant of this.ants) {
      const g = this.grid.worldToGrid(ant.x, ant.y);
      if (this.grid.isSolid(g.gx, g.gy) || !this.grid.isNavigable(g.gx, g.gy)) {
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

  public saveState(): void {
    try {
      // Run-length encode terrain & quantized moisture for compact fast localStorage persistence
      const terrainRle: number[] = [];
      let prevT = this.grid.terrain[0];
      let countT = 1;
      for (let i = 1; i < this.grid.terrain.length; i++) {
        const t = this.grid.terrain[i];
        if (t === prevT) {
          countT++;
        } else {
          terrainRle.push(prevT, countT);
          prevT = t;
          countT = 1;
        }
      }
      terrainRle.push(prevT, countT);

      const moistRle: number[] = [];
      let prevM = Math.round(this.grid.moisture[0] * 20);
      let countM = 1;
      for (let i = 1; i < this.grid.moisture.length; i++) {
        const m = Math.round(this.grid.moisture[i] * 20);
        if (m === prevM) {
          countM++;
        } else {
          moistRle.push(prevM, countM);
          prevM = m;
          countM = 1;
        }
      }
      moistRle.push(prevM, countM);

      const compactAnts = this.ants.map((a) => ({
        ...a,
        path: [], // Recomputed dynamically as needed
        pathIndex: 0,
      }));

      const payload = {
        v: 1,
        simTime: this.simTime,
        timeOfDay: this.timeOfDay,
        dayCount: this.dayCount,
        weather: this.weather,
        windStrength: this.windStrength,
        weatherTimer: this.weatherTimer,
        tunnelsDugCells: this.tunnelsDugCells,
        nextId: this.nextId,
        entrancePos: this.entrancePos,
        middenPos: this.middenPos,
        chambers: this.chambers,
        ants: compactAnts,
        brood: this.brood,
        foods: this.foods,
        fallenAnts: this.fallenAnts,
        intruders: this.intruders,
        droplets: this.droplets,
        sprouts: this.sprouts,
        surfaceProps: this.surfaceProps,
        rootPolylines: this.rootPolylines,
        terrainRle,
        moistRle,
      };
      localStorage.setItem(AntColonySimulation.SAVE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore storage quota or private browsing errors cleanly
    }
  }

  public loadState(): boolean {
    try {
      const raw = localStorage.getItem(AntColonySimulation.SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1 || !Array.isArray(data.terrainRle) || !Array.isArray(data.ants) || data.ants.length === 0) {
        return false;
      }

      // Decode RLE terrain
      let tIdx = 0;
      for (let i = 0; i < data.terrainRle.length; i += 2) {
        const val = data.terrainRle[i];
        const count = data.terrainRle[i + 1];
        for (let c = 0; c < count && tIdx < this.grid.terrain.length; c++) {
          this.grid.terrain[tIdx++] = val;
        }
      }

      // Decode RLE moisture
      if (Array.isArray(data.moistRle)) {
        let mIdx = 0;
        for (let i = 0; i < data.moistRle.length; i += 2) {
          const val = data.moistRle[i] / 20;
          const count = data.moistRle[i + 1];
          for (let c = 0; c < count && mIdx < this.grid.moisture.length; c++) {
            this.grid.moisture[mIdx++] = val;
          }
        }
      }

      this.simTime = Number(data.simTime) || 0;
      this.timeOfDay = Number(data.timeOfDay) ?? 0.34;
      this.dayCount = Number(data.dayCount) || 1;
      this.weather = data.weather || 'Clear';
      this.windStrength = Number(data.windStrength) || 0.35;
      this.weatherTimer = Number(data.weatherTimer) || 35;
      this.tunnelsDugCells = Number(data.tunnelsDugCells) || 0;
      this.nextId = Number(data.nextId) || 1000;
      this.entrancePos = data.entrancePos || { x: 700, y: SURFACE_BASE_Y };
      this.middenPos = data.middenPos || { x: 1290, y: SURFACE_BASE_Y };
      this.chambers = data.chambers || [];
      this.ants = data.ants || [];
      this.brood = data.brood || [];
      this.foods = data.foods || [];
      this.fallenAnts = data.fallenAnts || [];
      this.intruders = data.intruders || [];
      this.droplets = data.droplets || [];
      this.sprouts = data.sprouts || [];
      this.surfaceProps = data.surfaceProps || [];
      this.rootPolylines = data.rootPolylines || [];

      this.particles = [];
      for (let i = 0; i < 65; i++) {
        this.particles.push({
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
        });
      }

      this.grid.updateSurfaceProfile();
      this.flareEntranceMouths();
      this.grid.dirtVisualDirty = true;

      // Upgrade existing saved colonies with left/right rocky edge outcrops & clear stale entrance targets
      if (!this.surfaceProps.some((p) => p.kind === 'outcrop')) {
        const leftGx = Math.floor((CASE_LEFT + 64) / CELL_SIZE);
        const rightGx = Math.floor((CASE_RIGHT - 64) / CELL_SIZE);
        this.surfaceProps.push(
          {
            kind: 'outcrop',
            x: CASE_LEFT + 64,
            y: this.grid.surfaceY[leftGx],
            width: 78,
            height: 35,
            angle: 0.03,
            seed: 31.7,
          },
          {
            kind: 'outcrop',
            x: CASE_RIGHT - 64,
            y: this.grid.surfaceY[rightGx],
            width: 78,
            height: 36,
            angle: -0.03,
            seed: 62.4,
          }
        );
      }
      for (const ant of this.ants) {
        ant.path = [];
        ant.targetPos = null;
      }
      for (const m of this.intruders) {
        m.path = [];
        m.pathIndex = 0;
        const mg = this.grid.worldToGrid(m.x, m.y);
        if (this.grid.isSolid(mg.gx, mg.gy) || !this.grid.isNavigable(mg.gx, mg.gy)) {
          const safe = this.grid.findNearestNavigable(mg.gx, mg.gy, 8);
          if (safe) {
            const w = this.grid.gridToWorld(safe.gx, safe.gy);
            m.x = w.x;
            m.y = w.y;
          }
        }
      }

      for (const sp of this.sprouts) {
        const gx = clamp(Math.floor(sp.x / CELL_SIZE), 0, GRID_W - 1);
        sp.y = this.grid.surfaceY[gx];
      }
      for (const fa of this.fallenAnts) {
        if (fa.carriedByAntId !== null && !this.ants.some((a) => a.id === fa.carriedByAntId)) {
          fa.carriedByAntId = null;
        }
        const fgx = clamp(Math.floor(fa.x / CELL_SIZE), 0, GRID_W - 1);
        const surfY = this.grid.surfaceY[fgx];
        if (!fa.atMidden && (Math.abs(fa.x - this.entrancePos.x) < 34 || Math.abs(fa.x - 405) < 26) && fa.y > surfY - 6 && fa.y < surfY + 66) {
          fa.x = clamp(this.middenPos.x + (Math.random() - 0.5) * 20, CASE_LEFT + 32, CASE_RIGHT - 32);
          fa.y = this.middenPos.y;
          fa.atMidden = true;
          fa.carriedByAntId = null;
        }
      }
      for (const fd of this.foods) {
        if (fd.storedInChamberId === null && !fd.falling) {
          const fgx = clamp(Math.floor(fd.x / CELL_SIZE), 0, GRID_W - 1);
          const surfY = this.grid.surfaceY[fgx];
          if ((Math.abs(fd.x - this.entrancePos.x) < 38 || Math.abs(fd.x - 405) < 28) && fd.y > surfY - 6) {
            const entX = Math.abs(fd.x - this.entrancePos.x) < 38 ? this.entrancePos.x : 405;
            const side = fd.x >= entX ? 1 : -1;
            fd.x = clamp(entX + side * 48, CASE_LEFT + 32, CASE_RIGHT - 32);
            const nGx = clamp(Math.floor(fd.x / CELL_SIZE), 0, GRID_W - 1);
            fd.y = this.grid.surfaceY[nGx] - 3;
          }
        }
      }

      const royal = this.getChamber(ChamberType.ROYAL);
      if (royal) {
        this.grid.recomputeNestField(royal.x, royal.y);
      }
      this.nestFieldDirty = false;
      this.sanitizeAntPositions();
      return true;
    } catch {
      return false;
    }
  }
}
