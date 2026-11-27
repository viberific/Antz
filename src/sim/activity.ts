import { AntCaste, AntTask } from './types';
import type { AntColonySimulation } from './colony';

/** A place worth looking at, in sim coordinates. */
export interface Hotspot {
  x: number;
  y: number;
  /** summed interest of everything near it */
  score: number;
  /** a threat (predator, raid, fight): the camera should not dawdle */
  danger: boolean;
}

interface Item {
  x: number;
  y: number;
  w: number;
  danger: boolean;
}

const BIN = 100;
/** the radius around a hotspot whose action counts as "the same scene" */
const SCENE_R = 150;
const MIN_HOLD = 9;
const MAX_HOLD = 24;

/** How much a behaviour is worth watching. Anything not listed counts a little, so busy places beat empty ones. */
const TASK_WEIGHT: Partial<Record<AntTask, number>> = {
  [AntTask.IDLE]: 0,
  [AntTask.SEEKING_REST]: 0.1,
  [AntTask.CLUSTERING]: 0.1,
  [AntTask.DEFENDING]: 4,
  [AntTask.LAYING_EGG]: 4,
  [AntTask.HELPING_ECLOSION]: 5,
  [AntTask.RESCUING]: 5,
  [AntTask.BURIED]: 5,
  [AntTask.NUPTIAL_FLIGHT]: 5,
  [AntTask.GROUP_TRANSPORT]: 4,
  [AntTask.CARRYING_NESTMATE]: 3,
  [AntTask.TANDEM_LEADING]: 3,
  [AntTask.SIGNALING_FOOD]: 3,
  [AntTask.CANNIBALIZING]: 3,
  [AntTask.TENDING_QUEEN]: 2.5,
  [AntTask.TROPHALLAXIS]: 2.5,
  [AntTask.TENDING_APHIDS]: 2.5,
  [AntTask.CUTTING_LEAF]: 2.5,
  [AntTask.EXCAVATING]: 2.2,
  [AntTask.FEEDING_LARVA]: 2,
  [AntTask.MOVING_BROOD]: 2,
  [AntTask.FOLLOWING_FOOD_TRAIL]: 0.8,
  [AntTask.RETURNING_WITH_FOOD]: 0.8,
};

const CREATURE_WEIGHT: Record<string, number> = {
  bird: 7,
  spider: 5,
  antlion: 5,
  anteater: 7,
  worm: 3,
  ladybug: 2,
};

/**
 * Finds where the colony is most worth watching, for the drifting camera.
 *
 * Every few seconds it scores the whole case: ants doing interesting things, intruders and predators, hatching brood.
 * The camera stays with a scene long enough to take it in, follows it as it moves, and only leaves for something
 * clearly better (or something dangerous). Places it has just been score lower, so it tours the colony.
 */
export class ActivityDirector {
  private current: Hotspot | null = null;
  private held = 0;
  private clock = 0;
  private sinceScan = 99;
  private readonly visited = new Map<number, number>();

  public reset(): void {
    this.current = null;
    this.held = 0;
    this.sinceScan = 99;
  }

  public update(sim: AntColonySimulation, dt: number): Hotspot | null {
    this.clock += dt;
    this.held += dt;
    this.sinceScan += dt;
    if (this.sinceScan < 0.5) return this.current;
    this.sinceScan = 0;

    const items = this.gather(sim);
    const best = this.bestScene(items);

    if (this.current) {
      // follow the scene we are watching as its participants move
      const here = this.sceneAt(items, this.current.x, this.current.y);
      if (here && here.score >= 1) {
        this.current = { ...here, danger: here.danger };
        this.visited.set(this.binKey(here.x, here.y), this.clock);
      } else {
        this.current = null;
      }
    }

    if (best) {
      const bestAdj = best.score * this.novelty(best.x, best.y);
      const curScore = this.current ? this.current.score : 0;
      const far = this.current ? Math.hypot(best.x - this.current.x, best.y - this.current.y) > SCENE_R * 1.4 : true;
      const take =
        !this.current ||
        (this.held > MIN_HOLD && far && bestAdj > curScore * 1.25) ||
        (this.held > MAX_HOLD && far) ||
        (best.danger && !this.current.danger && this.held > 3 && best.score > curScore * 1.4);
      if (take) {
        this.current = best;
        this.held = 0;
        this.visited.set(this.binKey(best.x, best.y), this.clock);
      }
    }
    return this.current;
  }

  private gather(sim: AntColonySimulation): Item[] {
    const items: Item[] = [];
    for (const a of sim.ants) {
      if (a.carriedById != null) continue;
      let w = TASK_WEIGHT[a.task];
      if (w === undefined) w = 0.4;
      if (a.caste === AntCaste.QUEEN) w += 1.5;
      if (a.flying) w = Math.max(w, 5);
      if (w > 0) items.push({ x: a.x, y: a.y, w, danger: a.task === AntTask.DEFENDING });
    }
    for (const m of sim.intruders) {
      items.push({ x: m.x, y: m.y, w: m.aggression > 0 ? 6 : 2, danger: m.aggression > 0 });
    }
    for (const c of sim.creatures) {
      const active = c.state !== 'leaving' && c.state !== 'waiting';
      items.push({ x: c.x, y: c.y, w: (CREATURE_WEIGHT[c.kind] ?? 2) * (active ? 1 : 0.5), danger: c.kind === 'bird' || c.kind === 'anteater' });
    }
    for (const b of sim.brood) {
      if (b.ecloseWait && b.ecloseWait > 0) items.push({ x: b.x, y: b.y, w: 3, danger: false });
    }
    return items;
  }

  private binKey(x: number, y: number): number {
    return Math.floor(x / BIN) + Math.floor(y / BIN) * 1000;
  }

  /** 1 for somewhere we have not been lately, down toward 0.3 for somewhere we were just now */
  private novelty(x: number, y: number): number {
    const t = this.visited.get(this.binKey(x, y));
    if (t === undefined) return 1;
    return 1 - 0.7 * Math.exp(-(this.clock - t) / 70);
  }

  private sceneAt(items: Item[], cx: number, cy: number): Hotspot | null {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let danger = false;
    for (const it of items) {
      if (Math.abs(it.x - cx) > SCENE_R || Math.abs(it.y - cy) > SCENE_R) continue;
      if (Math.hypot(it.x - cx, it.y - cy) > SCENE_R) continue;
      sw += it.w;
      sx += it.x * it.w;
      sy += it.y * it.w;
      if (it.danger) danger = true;
    }
    if (sw <= 0) return null;
    return { x: sx / sw, y: sy / sw, score: sw, danger };
  }

  /** The densest cluster of interest anywhere: evaluate a scene at each occupied bin. */
  private bestScene(items: Item[]): Hotspot | null {
    const bins = new Map<number, { x: number; y: number }>();
    for (const it of items) {
      if (it.w < 0.4) continue;
      const k = this.binKey(it.x, it.y);
      if (!bins.has(k)) bins.set(k, { x: it.x, y: it.y });
    }
    let best: Hotspot | null = null;
    let bestAdj = 0;
    for (const p of bins.values()) {
      const s = this.sceneAt(items, p.x, p.y);
      if (!s) continue;
      const adj = s.score * this.novelty(s.x, s.y);
      if (adj > bestAdj) {
        bestAdj = adj;
        best = s;
      }
    }
    return best;
  }
}
