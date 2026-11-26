import {
  CELL_SIZE,
  CellType,
  GRID_H,
  GRID_W,
  Vec2,
} from './types';

const NB_DX = [-1, 1, 0, 0, -1, 1, -1, 1];
const NB_DY = [0, 0, -1, 1, -1, -1, 1, 1];
const NB_COST = [1, 1, 1.08, 1.08, 1.45, 1.45, 1.45, 1.45];

export class ColonyGrid {
  public terrain: Uint8Array;
  public moisture: Float32Array;
  public foodPheromone: Float32Array;
  public homePheromone: Float32Array;
  public alarmPheromone: Float32Array;
  public digCue: Float32Array;
  public nestDistField: Float32Array;
  public cavityDepth: Float32Array; // smoothed distance inside TUNNEL cells to nearest solid earth
  public surfaceY: Float32Array; // per column gx: world Y of ground surface
  public dirtVisualDirty: boolean = true;
  public dirtyCells: number[] = [];
  /** cached walkability (see computeNavigable); kept in sync by setTerrain / rebuildNav */
  public nav: Uint8Array;
  /** bumped on every terrain edit so dependants (flow fields) know when to refresh */
  public terrainVersion = 0;
  private fieldHeapIdx: Int32Array;
  private fieldHeapScore: Float32Array;

  // Reusable A* scratch buffers to eliminate GC pressure
  private gScore: Float32Array;
  private fScore: Float32Array;
  private cameFrom: Int32Array;
  private closedSet: Uint8Array;
  private openSetFlag: Uint8Array;
  private heapIdx: Int32Array;
  private heapScore: Float32Array;
  private visitStamp: Uint32Array;
  private currentStamp: number = 1;

  constructor() {
    const size = GRID_W * GRID_H;
    this.terrain = new Uint8Array(size);
    this.moisture = new Float32Array(size);
    this.foodPheromone = new Float32Array(size);
    this.homePheromone = new Float32Array(size);
    this.alarmPheromone = new Float32Array(size);
    this.digCue = new Float32Array(size);
    this.nestDistField = new Float32Array(size);
    this.cavityDepth = new Float32Array(size);
    this.surfaceY = new Float32Array(GRID_W);

    this.gScore = new Float32Array(size);
    this.fScore = new Float32Array(size);
    this.cameFrom = new Int32Array(size);
    this.closedSet = new Uint8Array(size);
    this.openSetFlag = new Uint8Array(size);
    this.heapIdx = new Int32Array(size);
    this.heapScore = new Float32Array(size);
    this.visitStamp = new Uint32Array(size);
    this.nav = new Uint8Array(size);
    this.fieldHeapIdx = new Int32Array(size * 4);
    this.fieldHeapScore = new Float32Array(size * 4);
  }

  public idx(gx: number, gy: number): number {
    return gy * GRID_W + gx;
  }

  public inBounds(gx: number, gy: number): boolean {
    return gx >= 0 && gx < GRID_W && gy >= 0 && gy < GRID_H;
  }

  public worldToGrid(x: number, y: number): { gx: number; gy: number } {
    return {
      gx: Math.max(0, Math.min(GRID_W - 1, Math.floor(x / CELL_SIZE))),
      gy: Math.max(0, Math.min(GRID_H - 1, Math.floor(y / CELL_SIZE))),
    };
  }

  public gridToWorld(gx: number, gy: number): Vec2 {
    return {
      x: (gx + 0.5) * CELL_SIZE,
      y: (gy + 0.5) * CELL_SIZE,
    };
  }

  public isSolid(gx: number, gy: number): boolean {
    if (!this.inBounds(gx, gy)) return true;
    const t = this.terrain[gy * GRID_W + gx];
    return t !== CellType.AIR && t !== CellType.TUNNEL;
  }

  public isDiggable(gx: number, gy: number): boolean {
    if (!this.inBounds(gx, gy)) return false;
    const t = this.terrain[gy * GRID_W + gx];
    return t === CellType.TOPSOIL || t === CellType.SUBSOIL || t === CellType.DEEP_CLAY;
  }

  /**
   * Side-view walkability:
   * - Inside TUNNEL cells: ants cling to the glass & soil walls anywhere in the tunnel.
   * - In AIR cells above ground: ants walk along the surface terrain contour (up to 2 cells above solid ground or clinging to surface mounds/pebbles).
   */
  public isNavigable(gx: number, gy: number): boolean {
    if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return false;
    return this.nav[gy * GRID_W + gx] === 1;
  }

  public rebuildNav(): void {
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        this.nav[gy * GRID_W + gx] = this.computeNavigable(gx, gy) ? 1 : 0;
      }
    }
    this.terrainVersion++;
  }

  private refreshNavAround(gx: number, gy: number): void {
    for (let y = gy - 3; y <= gy + 1; y++) {
      for (let x = gx - 1; x <= gx + 1; x++) {
        if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
        this.nav[y * GRID_W + x] = this.computeNavigable(x, y) ? 1 : 0;
      }
    }
  }

  private computeNavigable(gx: number, gy: number): boolean {
    if (!this.inBounds(gx, gy)) return false;
    const t = this.terrain[gy * GRID_W + gx];
    if (t === CellType.TUNNEL) return true;
    if (t !== CellType.AIR) return false;

    // Check if near solid ground (surface walking)
    for (let dy = 1; dy <= 3; dy++) {
      if (gy + dy < GRID_H) {
        const below = this.terrain[(gy + dy) * GRID_W + gx];
        if (below !== CellType.AIR && below !== CellType.TUNNEL) return true;
      }
    }
    // Seamless transition across tunnel entrance openings (1-2 cells above TUNNEL)
    if (gy + 1 < GRID_H && this.terrain[(gy + 1) * GRID_W + gx] === CellType.TUNNEL) {
      return true;
    }
    if (
      gy + 2 < GRID_H &&
      this.terrain[(gy + 1) * GRID_W + gx] === CellType.AIR &&
      this.terrain[(gy + 2) * GRID_W + gx] === CellType.TUNNEL
    ) {
      return true;
    }
    // Also allow climbing 1 cell beside solid slope
    for (let dx = -1; dx <= 1; dx += 2) {
      if (gx + dx >= 0 && gx + dx < GRID_W) {
        const side = this.terrain[gy * GRID_W + (gx + dx)];
        if (side !== CellType.AIR && side !== CellType.TUNNEL) return true;
      }
    }
    return false;
  }

  public setTerrain(gx: number, gy: number, type: CellType): void {
    if (!this.inBounds(gx, gy)) return;
    const i = gy * GRID_W + gx;
    if (this.terrain[i] !== type) {
      this.terrain[i] = type;
      this.dirtyCells.push(i);
      this.dirtVisualDirty = true;
      this.terrainVersion++;
      this.refreshNavAround(gx, gy);
    }
  }

  /** Recompute the ground height of one column (cheap alternative to updateSurfaceProfile). */
  public updateSurfaceColumn(gx: number): void {
    if (gx < 0 || gx >= GRID_W) return;
    let foundY = GRID_H * CELL_SIZE;
    for (let gy = 0; gy < GRID_H; gy++) {
      const t = this.terrain[gy * GRID_W + gx];
      if (t !== CellType.AIR && t !== CellType.GLASS_WALL) {
        foundY = gy * CELL_SIZE;
        break;
      }
    }
    this.surfaceY[gx] = foundY;
  }

  /**
   * Multi-source Dijkstra over walkable cells. `out[i]` becomes the walking cost from cell i to the nearest source,
   * so any ant anywhere can find its way by stepping downhill (see `descend`). One field serves every ant heading
   * to the same kind of place, which is far cheaper than a per-ant A* search.
   */
  public buildFlowField(out: Float32Array, sources: number[], sourceCosts?: number[]): void {
    out.fill(1e6);
    const hIdx = this.fieldHeapIdx;
    const hScore = this.fieldHeapScore;
    const cap = hIdx.length;
    let size = 0;
    const push = (node: number, score: number) => {
      if (size >= cap) return;
      let i = size++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (hScore[p] <= score) break;
        hIdx[i] = hIdx[p];
        hScore[i] = hScore[p];
        i = p;
      }
      hIdx[i] = node;
      hScore[i] = score;
    };
    for (let k = 0; k < sources.length; k++) {
      const s = sources[k];
      if (this.nav[s] !== 1) continue;
      const c = sourceCosts ? sourceCosts[k] : 0;
      if (c < out[s]) {
        out[s] = c;
        push(s, c);
      }
    }
    const nav = this.nav;
    const terrain = this.terrain;
    while (size > 0) {
      const cur = hIdx[0];
      const curScore = hScore[0];
      size--;
      if (size > 0) {
        const lastIdx = hIdx[size];
        const lastScore = hScore[size];
        let i = 0;
        while (true) {
          const l = (i << 1) + 1;
          if (l >= size) break;
          const r = l + 1;
          const m = r < size && hScore[r] < hScore[l] ? r : l;
          if (lastScore <= hScore[m]) break;
          hIdx[i] = hIdx[m];
          hScore[i] = hScore[m];
          i = m;
        }
        hIdx[i] = lastIdx;
        hScore[i] = lastScore;
      }
      // (out is Float32: compare with a tolerance, or float64 re-relaxations of equal cost requeue endlessly)
      if (curScore > out[cur] + 1e-3) continue;
      const cx = cur % GRID_W;
      const cy = (cur - cx) / GRID_W;
      for (let k = 0; k < 8; k++) {
        const dx = NB_DX[k];
        const dy = NB_DY[k];
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
        const ni = ny * GRID_W + nx;
        if (nav[ni] !== 1) continue;
        if (dx !== 0 && dy !== 0 && this.isSolid(cx + dx, cy) && this.isSolid(cx, cy + dy)) continue;
        let cost = NB_COST[k];
        // discourage hovering routes through open air that is not resting on the ground
        if (terrain[ni] === CellType.AIR && ny + 1 < GRID_H && !this.isSolid(nx, ny + 1)) cost += 0.7;
        const nd = curScore + cost;
        if (nd < out[ni] - 1e-3) {
          out[ni] = nd;
          push(ni, nd);
        }
      }
    }
  }

  /** Next cell downhill on a flow field from cell `i`, or -1 at a minimum / dead end. */
  public descend(field: Float32Array, i: number): number {
    const cx = i % GRID_W;
    const cy = (i - cx) / GRID_W;
    let best = -1;
    let bestD = field[i];
    for (let k = 0; k < 8; k++) {
      const dx = NB_DX[k];
      const dy = NB_DY[k];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      const ni = ny * GRID_W + nx;
      if (this.nav[ni] !== 1) continue;
      if (dx !== 0 && dy !== 0 && this.isSolid(cx + dx, cy) && this.isSolid(cx, cy + dy)) continue;
      if (field[ni] < bestD - 1e-4) {
        bestD = field[ni];
        best = ni;
      }
    }
    return best;
  }

  public updateSurfaceProfile(): void {
    for (let gx = 0; gx < GRID_W; gx++) {
      let foundY = GRID_H * CELL_SIZE;
      for (let gy = 0; gy < GRID_H; gy++) {
        const t = this.terrain[gy * GRID_W + gx];
        if (t !== CellType.AIR && t !== CellType.GLASS_WALL) {
          foundY = gy * CELL_SIZE;
          break;
        }
      }
      this.surfaceY[gx] = foundY;
    }
  }

  /**
   * Computes a smoothed distance field inside all TUNNEL cells to nearest solid soil,
   * creating natural cylindrical tunnel walls and deep concave domed cavern ceilings/backs.
   */
  public updateCavityDepthField(): void {
    const len = GRID_W * GRID_H;
    const tmp = new Float32Array(len);

    for (let i = 0; i < len; i++) {
      const t = this.terrain[i];
      tmp[i] = t === CellType.TUNNEL ? 24 : t === CellType.AIR ? 2.5 : 0;
    }

    // Forward chamfer distance pass
    for (let gy = 1; gy < GRID_H - 1; gy++) {
      const row = gy * GRID_W;
      for (let gx = 1; gx < GRID_W - 1; gx++) {
        const i = row + gx;
        if (this.terrain[i] !== CellType.TUNNEL) continue;
        let d = tmp[i];
        d = Math.min(d, tmp[i - 1] + 1);
        d = Math.min(d, tmp[i - GRID_W] + 1);
        d = Math.min(d, tmp[i - GRID_W - 1] + 1.414);
        d = Math.min(d, tmp[i - GRID_W + 1] + 1.414);
        tmp[i] = d;
      }
    }

    // Backward chamfer distance pass
    for (let gy = GRID_H - 2; gy >= 1; gy--) {
      const row = gy * GRID_W;
      for (let gx = GRID_W - 2; gx >= 1; gx--) {
        const i = row + gx;
        if (this.terrain[i] !== CellType.TUNNEL) continue;
        let d = tmp[i];
        d = Math.min(d, tmp[i + 1] + 1);
        d = Math.min(d, tmp[i + GRID_W] + 1);
        d = Math.min(d, tmp[i + GRID_W - 1] + 1.414);
        d = Math.min(d, tmp[i + GRID_W + 1] + 1.414);
        tmp[i] = d;
      }
    }

    // Smooth over TUNNEL cells so square corners become organic curved arches
    this.cavityDepth.set(tmp);
    for (let pass = 0; pass < 2; pass++) {
      for (let gy = 1; gy < GRID_H - 1; gy++) {
        const row = gy * GRID_W;
        for (let gx = 1; gx < GRID_W - 1; gx++) {
          const i = row + gx;
          if (this.terrain[i] !== CellType.TUNNEL) {
            this.cavityDepth[i] = 0;
            continue;
          }
          const sum =
            tmp[i] * 2 +
            tmp[i - 1] +
            tmp[i + 1] +
            tmp[i - GRID_W] +
            tmp[i + GRID_W] +
            (tmp[i - GRID_W - 1] + tmp[i - GRID_W + 1] + tmp[i + GRID_W - 1] + tmp[i + GRID_W + 1]) * 0.7;
          this.cavityDepth[i] = sum / 8.8;
        }
      }
      if (pass === 0) tmp.set(this.cavityDepth);
    }
  }

  /**
   * Computes a Dijkstra / BFS distance field from the Royal Chamber center
   * through all navigable cells so returning ants always possess an innate spatial map.
   */
  public recomputeNestField(royalWorldX: number, royalWorldY: number): void {
    this.nestDistField.fill(1e6);
    const start = this.worldToGrid(royalWorldX, royalWorldY);
    const startIdx = this.idx(start.gx, start.gy);
    if (!this.isNavigable(start.gx, start.gy)) return;

    const queue = new Int32Array(GRID_W * GRID_H);
    let head = 0;
    let tail = 0;
    this.nestDistField[startIdx] = 0;
    queue[tail++] = startIdx;

    const dirs = [
      -1, 0, 1,
      1, 0, 1,
      0, -1, 1.08,
      0, 1, 1.05,
      -1, -1, 1.45,
      1, -1, 1.45,
      -1, 1, 1.45,
      1, 1, 1.45,
    ];

    while (head < tail) {
      const curr = queue[head++];
      const cx = curr % GRID_W;
      const cy = (curr - cx) / GRID_W;
      const baseDist = this.nestDistField[curr];

      for (let d = 0; d < dirs.length; d += 3) {
        const nx = cx + dirs[d];
        const ny = cy + dirs[d + 1];
        if (!this.isNavigable(nx, ny)) continue;
        // Prevent diagonal corner cutting through solid earth
        if (dirs[d] !== 0 && dirs[d + 1] !== 0) {
          if (this.isSolid(cx + dirs[d], cy) && this.isSolid(cx, cy + dirs[d + 1])) continue;
        }
        const nIdx = ny * GRID_W + nx;
        const nd = baseDist + dirs[d + 2];
        if (nd < this.nestDistField[nIdx]) {
          this.nestDistField[nIdx] = nd;
          queue[tail++] = nIdx;
        }
      }
    }
  }

  /**
   * Bounded A* pathfinding between two world points across tunnels and surface contours.
   * Returns smoothed world coordinates.
   */
  public findPath(
    startWorld: Vec2,
    goalWorld: Vec2,
    options?: {
      preferFoodPheromone?: boolean;
      preferHomePheromone?: boolean;
      maxIterations?: number;
    }
  ): Vec2[] {
    const s = this.worldToGrid(startWorld.x, startWorld.y);
    const g = this.worldToGrid(goalWorld.x, goalWorld.y);

    const startGx = this.findNearestNavigable(s.gx, s.gy, 5);
    const goalGx = this.findNearestNavigable(g.gx, g.gy, 6);
    if (!startGx || !goalGx) return [];

    const startIdx = this.idx(startGx.gx, startGx.gy);
    const goalIdx = this.idx(goalGx.gx, goalGx.gy);
    if (startIdx === goalIdx) return [this.gridToWorld(goalGx.gx, goalGx.gy)];

    this.currentStamp++;
    if (this.currentStamp > 0xffffff00) {
      this.visitStamp.fill(0);
      this.currentStamp = 1;
    }
    const stamp = this.currentStamp;

    let heapSize = 0;
    const pushHeap = (nodeIdx: number, score: number) => {
      let i = heapSize++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (this.heapScore[parent] <= score) break;
        this.heapIdx[i] = this.heapIdx[parent];
        this.heapScore[i] = this.heapScore[parent];
        i = parent;
      }
      this.heapIdx[i] = nodeIdx;
      this.heapScore[i] = score;
    };

    const popHeap = (): number => {
      const top = this.heapIdx[0];
      heapSize--;
      if (heapSize > 0) {
        const lastIdx = this.heapIdx[heapSize];
        const lastScore = this.heapScore[heapSize];
        let i = 0;
        while (true) {
          let left = (i << 1) + 1;
          if (left >= heapSize) break;
          const right = left + 1;
          let smallest = left;
          if (right < heapSize && this.heapScore[right] < this.heapScore[left]) {
            smallest = right;
          }
          if (lastScore <= this.heapScore[smallest]) break;
          this.heapIdx[i] = this.heapIdx[smallest];
          this.heapScore[i] = this.heapScore[smallest];
          i = smallest;
        }
        this.heapIdx[i] = lastIdx;
        this.heapScore[i] = lastScore;
      }
      return top;
    };

    this.visitStamp[startIdx] = stamp;
    this.gScore[startIdx] = 0;
    const h0 = Math.hypot(goalGx.gx - startGx.gx, goalGx.gy - startGx.gy);
    this.fScore[startIdx] = h0;
    this.cameFrom[startIdx] = -1;
    this.closedSet[startIdx] = 0;
    this.openSetFlag[startIdx] = 1;
    pushHeap(startIdx, h0);

    const maxIter = options?.maxIterations ?? 4500;
    const preferFood = options?.preferFoodPheromone ?? false;
    const preferHome = options?.preferHomePheromone ?? false;
    let iter = 0;
    let bestFallbackIdx = startIdx;
    let bestFallbackH = h0;

    const neighbors = [
      -1, 0, 1,
      1, 0, 1,
      0, -1, 1.12,
      0, 1, 1.06,
      -1, -1, 1.48,
      1, -1, 1.48,
      -1, 1, 1.44,
      1, 1, 1.44,
    ];

    let foundGoal = false;
    while (heapSize > 0 && iter < maxIter) {
      iter++;
      const current = popHeap();
      if (this.visitStamp[current] === stamp && this.closedSet[current] === 1) continue;
      if (current === goalIdx) {
        foundGoal = true;
        break;
      }
      this.closedSet[current] = 1;
      this.openSetFlag[current] = 0;

      const cx = current % GRID_W;
      const cy = (current - cx) / GRID_W;
      const currG = this.gScore[current];

      for (let k = 0; k < neighbors.length; k += 3) {
        const dx = neighbors[k];
        const dy = neighbors[k + 1];
        const nx = cx + dx;
        const ny = cy + dy;
        if (!this.isNavigable(nx, ny)) continue;
        if (dx !== 0 && dy !== 0) {
          if (this.isSolid(cx + dx, cy) && this.isSolid(cx, cy + dy)) continue;
        }

        const nIdx = ny * GRID_W + nx;
        if (this.visitStamp[nIdx] === stamp && this.closedSet[nIdx] === 1) continue;

        let stepCost = neighbors[k + 2];
        if (this.terrain[nIdx] === CellType.TUNNEL) {
          if (this.isSolid(nx - 1, ny) || this.isSolid(nx + 1, ny)) {
            stepCost += 0.22;
          }
        }
        if (preferFood) {
          stepCost *= 1 - Math.min(0.45, this.foodPheromone[nIdx] * 0.45);
        } else if (preferHome) {
          stepCost *= 1 - Math.min(0.4, this.homePheromone[nIdx] * 0.4);
        }

        const tentativeG = currG + stepCost;
        const visited = this.visitStamp[nIdx] === stamp;
        if (!visited || tentativeG < this.gScore[nIdx]) {
          this.visitStamp[nIdx] = stamp;
          this.closedSet[nIdx] = 0;
          this.cameFrom[nIdx] = current;
          this.gScore[nIdx] = tentativeG;
          const h = Math.hypot(goalGx.gx - nx, goalGx.gy - ny) * 1.15;
          if (h < bestFallbackH) {
            bestFallbackH = h;
            bestFallbackIdx = nIdx;
          }
          const f = tentativeG + h;
          this.fScore[nIdx] = f;
          pushHeap(nIdx, f);
        }
      }
    }

    const endNode = foundGoal ? goalIdx : bestFallbackIdx;
    const raw: Vec2[] = [];
    let trace = endNode;
    let guard = 0;
    while (trace !== -1 && trace !== startIdx && guard < 1200) {
      guard++;
      const tx = trace % GRID_W;
      const ty = (trace - tx) / GRID_W;
      raw.push(this.gridToWorld(tx, ty));
      trace = this.cameFrom[trace];
    }
    raw.reverse();

    if (raw.length <= 2) return raw;

    // Collinear-only decimation preserves every bend and tunnel-top corner waypoint
    const smoothed: Vec2[] = [raw[0]];
    for (let i = 1; i < raw.length - 1; i++) {
      const prev = smoothed[smoothed.length - 1];
      const curr = raw[i];
      const next = raw[i + 1];
      const dx1 = Math.sign(curr.x - prev.x);
      const dy1 = Math.sign(curr.y - prev.y);
      const dx2 = Math.sign(next.x - curr.x);
      const dy2 = Math.sign(next.y - curr.y);
      if (dx1 !== dx2 || dy1 !== dy2) {
        smoothed.push(curr);
      }
    }
    smoothed.push(raw[raw.length - 1]);
    return smoothed;
  }

  public findNearestNavigable(gx: number, gy: number, maxRadius: number): { gx: number; gy: number } | null {
    if (this.isNavigable(gx, gy)) return { gx, gy };
    for (let r = 1; r <= maxRadius; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const nx = gx + dx;
          const ny = gy + dy;
          if (this.isNavigable(nx, ny)) return { gx: nx, gy: ny };
        }
      }
    }
    return null;
  }

  public depositPheromone(
    field: Float32Array,
    worldX: number,
    worldY: number,
    amount: number,
    radiusCells: number = 1
  ): void {
    const { gx, gy } = this.worldToGrid(worldX, worldY);
    for (let dy = -radiusCells; dy <= radiusCells; dy++) {
      for (let dx = -radiusCells; dx <= radiusCells; dx++) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (!this.inBounds(nx, ny)) continue;
        const dist = Math.hypot(dx, dy);
        if (dist > radiusCells + 0.3) continue;
        const falloff = 1 - dist / (radiusCells + 0.8);
        const i = ny * GRID_W + nx;
        field[i] = Math.min(1, field[i] + amount * falloff);
      }
    }
  }

  public stepPheromonesAndMoisture(dt: number, weather: 'Clear' | 'Misty' | 'Light Rain'): void {
    const foodDecay = Math.exp(-0.042 * dt);
    const homeDecay = Math.exp(-0.024 * dt);
    const alarmDecay = Math.exp(-0.22 * dt);
    const digDecay = Math.exp(-0.012 * dt);

    const len = GRID_W * GRID_H;
    for (let i = 0; i < len; i++) {
      if (this.foodPheromone[i] > 0.002) {
        this.foodPheromone[i] *= foodDecay;
      } else {
        this.foodPheromone[i] = 0;
      }
      if (this.homePheromone[i] > 0.002) {
        this.homePheromone[i] *= homeDecay;
      } else {
        this.homePheromone[i] = 0;
      }
      if (this.alarmPheromone[i] > 0.003) {
        this.alarmPheromone[i] *= alarmDecay;
      } else {
        this.alarmPheromone[i] = 0;
      }
      if (this.digCue[i] > 0.002) {
        // Dig cues stay active longer inside solid soil until excavated
        if (this.terrain[i] === CellType.TUNNEL || this.terrain[i] === CellType.AIR) {
          this.digCue[i] = 0;
        } else {
          this.digCue[i] *= digDecay;
        }
      } else {
        this.digCue[i] = 0;
      }
    }

    // Subterranean moisture percolation & evaporation (subsampled per frame for speed)
    const rainBonus = weather === 'Light Rain' ? 0.08 * dt : weather === 'Misty' ? 0.025 * dt : 0;
    const evap = weather === 'Clear' ? 0.006 * dt : 0.0015 * dt;

    for (let gx = 8; gx < GRID_W - 8; gx++) {
      const surfGy = Math.floor(this.surfaceY[gx] / CELL_SIZE);
      if (rainBonus > 0 && surfGy >= 0 && surfGy < GRID_H) {
        const si = surfGy * GRID_W + gx;
        this.moisture[si] = Math.min(1, this.moisture[si] + rainBonus);
      }
    }

    // Percolate moisture slowly downward & laterally
    for (let gy = GRID_H - 10; gy >= 35; gy--) {
      for (let gx = 9; gx < GRID_W - 9; gx++) {
        const i = gy * GRID_W + gx;
        const t = this.terrain[i];
        if (t === CellType.AIR || t === CellType.GLASS_WALL || t === CellType.PEBBLE) continue;

        let m = this.moisture[i];
        if (t === CellType.TUNNEL) {
          m = Math.max(0.05, m - evap * 0.8);
          this.moisture[i] = m;
          continue;
        }

        // Topsoil evaporates slightly when clear
        if (gy * CELL_SIZE <= this.surfaceY[gx] + 12) {
          m = Math.max(0.08, m - evap);
        }

        // Gravity percolation into cell below
        const belowIdx = (gy + 1) * GRID_W + gx;
        const belowT = this.terrain[belowIdx];
        if (belowT !== CellType.GLASS_WALL && belowT !== CellType.PEBBLE && m > this.moisture[belowIdx] + 0.04) {
          const transfer = (m - this.moisture[belowIdx]) * 0.09 * dt;
          m -= transfer;
          this.moisture[belowIdx] = Math.min(1, this.moisture[belowIdx] + transfer);
        }

        // Lateral diffusion
        const rightIdx = i + 1;
        if (this.terrain[rightIdx] !== CellType.GLASS_WALL && this.terrain[rightIdx] !== CellType.AIR) {
          const diff = (m - this.moisture[rightIdx]) * 0.05 * dt;
          m -= diff;
          this.moisture[rightIdx] = Math.max(0, Math.min(1, this.moisture[rightIdx] + diff));
        }

        this.moisture[i] = Math.max(0.05, Math.min(1, m));
      }
    }
  }
}
