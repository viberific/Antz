import { AntCaste, AntTask, CASE_LEFT, CASE_RIGHT, CELL_SIZE, ChamberType, GRID_H, GRID_W } from './types';
import { SIDE_ENTRANCE_X, type AntColonySimulation } from './colony';

export type HotspotKind = 'pathway' | 'chamber' | 'entrance' | 'enemies' | 'weather';

/** A place worth looking at, in sim coordinates. */
export interface Hotspot {
  x: number;
  y: number;
  /** summed interest of the scene */
  score: number;
  /** a threat (predator, raid, fight, collapse): the camera responds faster */
  danger: boolean;
  /** desired camera distance in 3D world units for macro framing */
  dist: number;
  /** which main area of the colony this scene focuses on */
  kind: HotspotKind;
}

interface Candidate extends Hotspot {
  id: string;
}

const MIN_HOLD = 10;
const MAX_HOLD = 22;
const SCAN_INTERVAL = 0.5;

const TASK_WEIGHT: Partial<Record<AntTask, number>> = {
  [AntTask.IDLE]: 0.05,
  [AntTask.SEEKING_REST]: 0.1,
  [AntTask.CLUSTERING]: 0.15,
  [AntTask.DEFENDING]: 3.2,
  [AntTask.LAYING_EGG]: 3.8,
  [AntTask.HELPING_ECLOSION]: 4.5,
  [AntTask.RESCUING]: 4.5,
  [AntTask.BURIED]: 5.0,
  [AntTask.NUPTIAL_FLIGHT]: 4.2,
  [AntTask.GROUP_TRANSPORT]: 3.6,
  [AntTask.CARRYING_NESTMATE]: 2.8,
  [AntTask.TANDEM_LEADING]: 2.8,
  [AntTask.SIGNALING_FOOD]: 2.8,
  [AntTask.CANNIBALIZING]: 2.6,
  [AntTask.TENDING_QUEEN]: 2.2,
  [AntTask.TROPHALLAXIS]: 2.2,
  [AntTask.TENDING_APHIDS]: 2.4,
  [AntTask.CUTTING_LEAF]: 2.4,
  [AntTask.EXCAVATING]: 2.0,
  [AntTask.REPAIRING]: 3.2,
  [AntTask.SEALING_ENTRANCE]: 3.2,
  [AntTask.FEEDING_LARVA]: 1.9,
  [AntTask.MOVING_BROOD]: 1.9,
  [AntTask.HUSKING_SEED]: 1.6,
  [AntTask.TENDING_FUNGUS]: 1.8,
  [AntTask.FOLLOWING_FOOD_TRAIL]: 1.1,
  [AntTask.RETURNING_WITH_FOOD]: 1.1,
};

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Directs the float (`drift`) camera across the five main areas of the colony:
 * - Pathways (active scent trails, surface foraging routes, tunnel traffic corridors)
 * - Chambers (royal, nursery, granary, fungus garden, midden, active expansion fronts)
 * - Entrances (main & side nest openings, mounds, guards, incoming/outgoing streams)
 * - Enemies (invading raiders, rival ants, beetles, mites, centipedes, surface predators)
 * - Weather event damage (storm collapses, urgent repairs, buried workers, flooding, sealed/plugged entrances)
 */
export class ActivityDirector {
  private current: Candidate | null = null;
  private held = 0;
  private clock = 0;
  private sinceScan = 99;
  private readonly visited = new Map<string, number>();
  private readonly catVisited = new Map<HotspotKind, number>();

  public reset(): void {
    this.current = null;
    this.held = 0;
    this.sinceScan = 99;
  }

  public update(sim: AntColonySimulation, dt: number, holdSwitch = false): Hotspot | null {
    this.clock += dt;
    this.held += dt;
    this.sinceScan += dt;
    if (this.sinceScan < SCAN_INTERVAL) return this.current;
    this.sinceScan = 0;

    const candidates = this.gatherCandidates(sim);
    if (candidates.length === 0) return this.current;

    // Track the scene we are currently watching as participants move
    if (this.current) {
      const exact = candidates.find((c) => c.id === this.current!.id);
      const near =
        exact ??
        candidates.find(
          (c) =>
            c.kind === this.current!.kind &&
            Math.hypot(c.x - this.current!.x, c.y - this.current!.y) < 110
        );
      if (near) {
        this.current = near;
        this.visited.set(near.id, this.clock);
        this.catVisited.set(near.kind, this.clock);
      } else if (!holdSwitch) {
        this.current = null;
      }
    }

    if (holdSwitch && this.current) {
      return this.current;
    }

    // Score candidates with both per-scene novelty and category rotation
    let best: Candidate | null = null;
    let bestAdj = 0;
    for (const c of candidates) {
      const adj = c.score * this.novelty(c);
      if (adj > bestAdj) {
        bestAdj = adj;
        best = c;
      }
    }

    if (best) {
      const curAdj = this.current ? this.current.score * this.novelty(this.current) : 0;
      const far = this.current ? Math.hypot(best.x - this.current.x, best.y - this.current.y) > 95 : true;
      const take =
        !this.current ||
        (this.held > MIN_HOLD && far && bestAdj > curAdj * 1.15) ||
        (this.held > MAX_HOLD && (far || best.id !== this.current.id)) ||
        (best.danger && !this.current.danger && this.held > 2.5 && best.score >= 9.5 && bestAdj >= curAdj * 0.9);
      if (take) {
        this.current = best;
        this.held = 0;
        this.visited.set(best.id, this.clock);
        this.catVisited.set(best.kind, this.clock);
      }
    }

    return this.current;
  }

  private novelty(c: Candidate): number {
    const tScene = this.visited.get(c.id);
    const sceneFresh = tScene === undefined ? 1 : 1 - 0.8 * Math.exp(-(this.clock - tScene) / 65);
    const tCat = this.catVisited.get(c.kind);
    const catSpan = c.danger ? 14 : 28;
    const catFloor = c.danger ? 0.3 : 0.52;
    const catFresh = tCat === undefined ? 1 : 1 - catFloor * Math.exp(-(this.clock - tCat) / catSpan);
    return sceneFresh * catFresh;
  }

  private gatherCandidates(sim: AntColonySimulation): Candidate[] {
    const out: Candidate[] = [];
    this.gatherEnemies(sim, out);
    this.gatherWeatherDamage(sim, out);
    this.gatherEntrances(sim, out);
    this.gatherChambers(sim, out);
    this.gatherPathways(sim, out);
    return out;
  }

  private gatherEnemies(sim: AntColonySimulation, out: Candidate[]): void {
    // Cluster nearby intruders so raiding parties are framed together
    const used = new Uint8Array(sim.intruders.length);
    for (let i = 0; i < sim.intruders.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const root = sim.intruders[i];
      let sx = root.x;
      let sy = root.y;
      let count = 1;
      let agg = root.aggression > 0 ? 1 : 0;
      for (let j = i + 1; j < sim.intruders.length; j++) {
        if (used[j]) continue;
        const o = sim.intruders[j];
        if (Math.hypot(o.x - root.x, o.y - root.y) < 110) {
          used[j] = 1;
          sx += o.x;
          sy += o.y;
          count++;
          if (o.aggression > 0) agg++;
        }
      }
      const cx = sx / count;
      const cy = sy / count;
      let defenders = 0;
      for (const a of sim.ants) {
        if (a.task === AntTask.DEFENDING && Math.hypot(a.x - cx, a.y - cy) < 80) defenders++;
      }
      const score = (agg > 0 ? 10.5 : 5.5) + (count - 1) * 3.0 + Math.min(9, defenders * 1.8);
      out.push({
        id: `enemies:intruder:${root.id}`,
        kind: 'enemies',
        x: cx,
        y: cy,
        score,
        danger: agg > 0 || defenders > 0,
        dist: count > 1 ? 2.65 : 2.15,
      });
    }

    for (const c of sim.creatures) {
      const active = c.state !== 'leaving' && c.state !== 'waiting';
      const isPredator = c.kind === 'bird' || c.kind === 'anteater' || c.kind === 'spider' || c.kind === 'antlion';
      let base =
        c.kind === 'bird' || c.kind === 'anteater'
          ? 12.5
          : c.kind === 'spider' || c.kind === 'antlion'
          ? 10.0
          : c.kind === 'worm'
          ? 8.0
          : 7.0;
      if (!active) base *= 0.55;
      const dist = c.kind === 'bird' || c.kind === 'anteater' ? 3.1 : c.kind === 'ladybug' ? 2.1 : 2.35;
      out.push({
        id: `enemies:creature:${c.id}`,
        kind: 'enemies',
        x: c.x,
        y: c.y,
        score: base,
        danger: isPredator && active,
        dist,
      });
    }
  }

  private gatherWeatherDamage(sim: AntColonySimulation, out: Candidate[]): void {
    // 1. Buried workers & active cave-in rescues
    for (const a of sim.ants) {
      if (a.task === AntTask.BURIED || a.task === AntTask.RESCUING) {
        out.push({
          id: `weather:rescue:${Math.floor(a.x / 80)}_${Math.floor(a.y / 80)}`,
          kind: 'weather',
          x: a.x,
          y: a.y,
          score: 16.5,
          danger: true,
          dist: 2.05,
        });
        break;
      }
    }

    // 2. Urgent storm/collapse repair zones (digPlan[i] === 2)
    const repairPts: { x: number; y: number }[] = [];
    for (let i = 0; i < sim.digPlan.length; i++) {
      if (sim.digPlan[i] !== 2) continue;
      const gx = i % GRID_W;
      const gy = (i - gx) / GRID_W;
      repairPts.push({ x: (gx + 0.5) * CELL_SIZE, y: (gy + 0.5) * CELL_SIZE });
    }
    const used = new Uint8Array(repairPts.length);
    for (let i = 0; i < repairPts.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const p0 = repairPts[i];
      let sx = p0.x;
      let sy = p0.y;
      let n = 1;
      for (let j = i + 1; j < repairPts.length; j++) {
        if (used[j]) continue;
        if (Math.hypot(repairPts[j].x - p0.x, repairPts[j].y - p0.y) < 75) {
          used[j] = 1;
          sx += repairPts[j].x;
          sy += repairPts[j].y;
          n++;
        }
      }
      const cx = sx / n;
      const cy = sy / n;
      let helpers = 0;
      for (const a of sim.ants) {
        if ((a.task === AntTask.REPAIRING || a.task === AntTask.RESCUING || a.task === AntTask.EXCAVATING) && Math.hypot(a.x - cx, a.y - cy) < 75) {
          helpers++;
        }
      }
      out.push({
        id: `weather:repair:${Math.floor(cx / 90)}_${Math.floor(cy / 90)}`,
        kind: 'weather',
        x: cx,
        y: cy,
        score: 10.0 + Math.min(7, n * 0.65) + Math.min(6, helpers * 2.0),
        danger: true,
        dist: clamp(2.1 + n * 0.035, 2.1, 2.7),
      });
    }

    // 3. Active nest flooding
    if (sim.floodDepth > 4) {
      const floodY = sim.floodLineY();
      let bestChamber = sim.chambers[0];
      let bestScore = -1;
      for (const c of sim.chambers) {
        if (c.y + c.ry * 0.4 > floodY - 12) {
          let moving = 0;
          for (const a of sim.ants) {
            if (a.task === AntTask.MOVING_BROOD && Math.hypot(a.x - c.x, a.y - c.y) < 90) moving++;
          }
          const sc = 10 + Math.min(5, sim.floodDepth * 0.06) + moving * 2;
          if (sc > bestScore) {
            bestScore = sc;
            bestChamber = c;
          }
        }
      }
      if (bestChamber && bestScore > 0) {
        out.push({
          id: `weather:flood:${bestChamber.id}`,
          kind: 'weather',
          x: bestChamber.x,
          y: Math.min(bestChamber.y, floodY - 8),
          score: bestScore,
          danger: true,
          dist: 2.7,
        });
      }
    }

    // 4. Heavy storm / snow / sealed entrance / wind debris
    const rain = sim.rainIntensity();
    if (sim.sealed || rain >= 0.45 || sim.weather === 'Snow' || sim.weather === 'Thunderstorm') {
      const mainGx = clamp(Math.floor(sim.entrancePos.x / CELL_SIZE), 0, GRID_W - 1);
      out.push({
        id: 'weather:storm_entrance',
        kind: 'weather',
        x: sim.entrancePos.x,
        y: sim.grid.surfaceY[mainGx] - 8,
        score: 8.8 + rain * 3 + (sim.sealed ? 2.2 : 0),
        danger: rain >= 0.65 || sim.weather === 'Thunderstorm',
        dist: 2.7,
      });
    }
    for (const d of sim.debris) {
      if (d.carriedById != null) {
        out.push({
          id: `weather:debris:${Math.floor(d.x / 120)}`,
          kind: 'weather',
          x: d.x,
          y: d.y,
          score: 8.2,
          danger: false,
          dist: 2.15,
        });
        break;
      }
    }
  }

  private gatherEntrances(sim: AntColonySimulation, out: Candidate[]): void {
    const entrances: { id: string; x: number; base: number; dist: number }[] = [
      { id: 'entrance:main', x: sim.entrancePos.x, base: 6.2, dist: 2.65 },
      { id: 'entrance:side', x: SIDE_ENTRANCE_X, base: 4.5, dist: 2.45 },
    ];
    for (const e of entrances) {
      const gx = clamp(Math.floor(e.x / CELL_SIZE), 0, GRID_W - 1);
      const ey = sim.grid.surfaceY[gx] + 6;
      let traffic = 0;
      let special = 0;
      for (const a of sim.ants) {
        if (Math.hypot(a.x - e.x, a.y - ey) > 65) continue;
        traffic++;
        if (
          a.task === AntTask.RETURNING_WITH_FOOD ||
          a.task === AntTask.CARRYING_SOIL ||
          a.task === AntTask.TANDEM_LEADING ||
          a.task === AntTask.PATROLLING ||
          a.task === AntTask.SEALING_ENTRANCE
        ) {
          special += 0.6;
        }
      }
      const bigFood = sim.foods.some((f) => f.large && Math.abs(f.x - e.x) < 70);
      const score = e.base + Math.min(7, traffic * 0.55 + special * 0.45) + (bigFood ? 2.5 : 0);
      out.push({
        id: e.id,
        kind: 'entrance',
        x: e.x,
        y: ey - 6,
        score,
        danger: false,
        dist: e.dist,
      });
    }
  }

  private gatherChambers(sim: AntColonySimulation, out: Candidate[]): void {
    for (const c of sim.chambers) {
      let antScore = 0;
      let qx = c.x;
      let qy = c.y;
      let hasQueen = false;
      for (const a of sim.ants) {
        if (a.carriedById != null) continue;
        if (Math.abs(a.x - c.x) > c.rx + 22 || Math.abs(a.y - c.y) > c.ry + 22) continue;
        antScore += TASK_WEIGHT[a.task] ?? 0.5;
        if (a.caste === AntCaste.QUEEN) {
          hasQueen = true;
          antScore += 2.6;
          qx = a.x;
          qy = a.y;
        }
      }
      let broodCount = 0;
      let eclosing = 0;
      for (const b of sim.brood) {
        if (b.chamberId === c.id) {
          broodCount++;
          if (b.ecloseWait && b.ecloseWait > 0) eclosing++;
        }
      }
      let foodPiles = 0;
      for (const f of sim.foods) {
        if (f.storedInChamberId === c.id && f.amount > 1) foodPiles++;
      }

      const base =
        c.type === ChamberType.ROYAL
          ? 5.6
          : c.type === ChamberType.NURSERY
          ? 4.8
          : c.type === ChamberType.GRANARY
          ? 4.4
          : c.type === ChamberType.FUNGUS
          ? 4.4
          : 3.5;

      const score = base + Math.min(8, antScore * 0.55) + Math.min(3, broodCount * 0.25) + eclosing * 2 + Math.min(2, foodPiles * 0.4);
      const tx = hasQueen ? c.x * 0.4 + qx * 0.6 : c.x;
      const ty = hasQueen ? c.y * 0.4 + qy * 0.6 : c.y;
      out.push({
        id: `chamber:${c.id}`,
        kind: 'chamber',
        x: tx,
        y: ty,
        score,
        danger: false,
        dist: clamp(1.95 + c.rx * 0.015, 2.25, 3.0),
      });
    }

    // Refuse midden when fallen ants or undertakers are there
    let middenActivity = 0;
    for (const f of sim.fallenAnts) {
      if (f.atMidden || Math.abs(f.x - sim.middenPos.x) < 60) middenActivity += 1;
    }
    for (const a of sim.ants) {
      if ((a.task === AntTask.NECROPHORESIS || a.task === AntTask.CARRYING_CHAFF) && Math.hypot(a.x - sim.middenPos.x, a.y - sim.middenPos.y) < 80) {
        middenActivity += 2.5;
      }
    }
    if (middenActivity > 0) {
      out.push({
        id: 'chamber:midden',
        kind: 'chamber',
        x: sim.middenPos.x,
        y: sim.middenPos.y,
        score: 4.5 + Math.min(5, middenActivity),
        danger: false,
        dist: 2.35,
      });
    }

    // Active expansion excavation site (digPlan[i] === 1)
    let digSx = 0;
    let digSy = 0;
    let digN = 0;
    for (let i = 0; i < sim.digPlan.length; i++) {
      if (sim.digPlan[i] !== 1) continue;
      const gx = i % GRID_W;
      const gy = (i - gx) / GRID_W;
      digSx += (gx + 0.5) * CELL_SIZE;
      digSy += (gy + 0.5) * CELL_SIZE;
      digN++;
    }
    if (digN > 0) {
      const dx = digSx / digN;
      const dy = digSy / digN;
      let diggers = 0;
      for (const a of sim.ants) {
        if (a.task === AntTask.EXCAVATING && Math.hypot(a.x - dx, a.y - dy) < 80) diggers++;
      }
      if (diggers > 0) {
        out.push({
          id: 'chamber:excavation',
          kind: 'chamber',
          x: dx,
          y: dy,
          score: 5.5 + Math.min(6, diggers * 2.0),
          danger: false,
          dist: 2.3,
        });
      }
    }
  }

  private gatherPathways(sim: AntColonySimulation, out: Candidate[]): void {
    // 1. Surface foraging trails & pheromone pathways
    const surfaceZones: { x: number; y: number; score: number }[] = [];
    for (let gx = 14; gx < GRID_W - 14; gx += 6) {
      const wx = (gx + 0.5) * CELL_SIZE;
      if (Math.abs(wx - sim.entrancePos.x) < 48 || Math.abs(wx - SIDE_ENTRANCE_X) < 36) continue;
      const surfY = sim.grid.surfaceY[gx];
      const gy = clamp(Math.floor(surfY / CELL_SIZE), 1, GRID_H - 2);

      let scent = 0;
      for (let ox = -3; ox <= 3; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const i = (gy + oy) * GRID_W + (gx + ox);
          scent += sim.grid.foodPheromone[i];
        }
      }

      let antsScore = 0;
      for (const a of sim.ants) {
        if (a.carriedById != null || Math.abs(a.x - wx) > 42 || Math.abs(a.y - surfY) > 36) continue;
        if (
          a.task === AntTask.FOLLOWING_FOOD_TRAIL ||
          a.task === AntTask.RETURNING_WITH_FOOD ||
          a.task === AntTask.TANDEM_LEADING ||
          a.task === AntTask.TANDEM_FOLLOWING ||
          a.task === AntTask.GROUP_TRANSPORT ||
          a.task === AntTask.TENDING_APHIDS ||
          a.task === AntTask.CUTTING_LEAF ||
          a.task === AntTask.SIGNALING_FOOD
        ) {
          antsScore += 2.2;
        } else if (a.task === AntTask.FORAGING_SCOUT) {
          antsScore += 1.0;
        }
      }

      let foodBonus = 0;
      for (const f of sim.foods) {
        if (f.storedInChamberId === null && !f.falling && f.amount > 2 && Math.abs(f.x - wx) < 36) {
          foodBonus += f.large ? 3.5 : 1.4;
        }
      }

      const sc = Math.min(5, scent * 1.4) + Math.min(8, antsScore) + Math.min(4, foodBonus);
      if (sc >= 3.2) {
        surfaceZones.push({ x: wx, y: surfY - 6, score: 3.5 + sc });
      }
    }

    // Keep top non-overlapping surface pathway spots
    surfaceZones.sort((a, b) => b.score - a.score);
    const pickedSurface: { x: number; y: number; score: number }[] = [];
    for (const z of surfaceZones) {
      if (pickedSurface.some((p) => Math.abs(p.x - z.x) < 120)) continue;
      pickedSurface.push(z);
      out.push({
        id: `pathway:surf:${Math.floor(z.x / 120)}`,
        kind: 'pathway',
        x: z.x,
        y: z.y,
        score: z.score,
        danger: false,
        dist: 2.25,
      });
      if (pickedSurface.length >= 2) break;
    }

    // 2. Busy underground transit tunnels between chambers
    const transitAnts = sim.ants.filter((a) => {
      if (a.carriedById != null) return false;
      const g = sim.grid.worldToGrid(a.x, a.y);
      if (a.y <= sim.grid.surfaceY[g.gx] + 16) return false;
      const inChamber = sim.chambers.some((c) => Math.abs(a.x - c.x) < c.rx && Math.abs(a.y - c.y) < c.ry);
      if (inChamber) return false;
      return (
        a.task === AntTask.RETURNING_WITH_FOOD ||
        a.task === AntTask.CARRYING_SOIL ||
        a.task === AntTask.FOLLOWING_FOOD_TRAIL ||
        a.task === AntTask.MOVING_BROOD ||
        a.task === AntTask.CARRYING_LEAF ||
        a.task === AntTask.FORAGING_SCOUT
      );
    });
    const usedT = new Uint8Array(transitAnts.length);
    for (let i = 0; i < transitAnts.length; i++) {
      if (usedT[i]) continue;
      usedT[i] = 1;
      const root = transitAnts[i];
      let sx = root.x;
      let sy = root.y;
      let n = 1;
      for (let j = i + 1; j < transitAnts.length; j++) {
        if (usedT[j]) continue;
        if (Math.hypot(transitAnts[j].x - root.x, transitAnts[j].y - root.y) < 60) {
          usedT[j] = 1;
          sx += transitAnts[j].x;
          sy += transitAnts[j].y;
          n++;
        }
      }
      if (n >= 2) {
        const cx = sx / n;
        const cy = sy / n;
        out.push({
          id: `pathway:tunnel:${Math.floor(cx / 100)}_${Math.floor(cy / 90)}`,
          kind: 'pathway',
          x: cx,
          y: cy,
          score: 4.5 + Math.min(7.5, n * 1.9),
          danger: false,
          dist: 2.15,
        });
      }
    }
  }
}
