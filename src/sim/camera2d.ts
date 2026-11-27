import * as THREE from 'three';

/**
 * Flat observation camera: always looks straight through the front glass (no orbit / tilt).
 * One-finger or mouse drag pans, pinch or wheel zooms about the fingers / cursor, a tap asks the
 * owner to pick something (an ant to follow), a double tap on empty space eases back to the full view.
 *
 * The fully zoomed-out view "covers" the case: the glass fills the whole screen with no empty bars,
 * and panning is clamped so the view never leaves the case.
 */
export interface CaseBounds {
  left: number;
  right: number;
  bottom: number;
  top: number;
  /** depth of the plane the bounds are measured on */
  z: number;
}

export type CameraMode = 'overview' | 'scan' | 'drift' | 'follow' | 'free';
/** the three hands-off modes the double tap cycles through */
const AUTO_MODES: CameraMode[] = ['overview', 'scan', 'drift'];

const FOLLOW_DIST = 3.4;
/** world units per second the scan sweeps up and down the nest */
const SCAN_SPEED = 0.55;
/** seconds the scan lingers at the sky / at the deepest chamber */
const SCAN_DWELL = 2.6;
/** seconds the sweep stays paused after the viewer slid it by hand */
const SCAN_RESUME = 4;
const DRIFT_MAX_SPEED = 3.2;
const MIN_DIST = 1.6;
const TAP_MS = 320;
const TAP_PX = 10;
const DOUBLE_TAP_MS = 320;

export class FlatCameraController {
  public followId: number | null = null;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly dom: HTMLElement;
  private readonly bounds: CaseBounds;
  private readonly onTap: (lx: number, ly: number) => boolean;

  private readonly target = new THREE.Vector2();
  private dist = 10;
  private maxDist = 10;

  /** eased goal (reset / follow); null when the user is in direct control */
  private goal: { x: number; y: number; dist: number } | null = null;
  /** while following, ease toward FOLLOW_DIST until the user zooms by hand */
  private followZoom = false;
  /** the rectangle worth looking at (sky, ground and every chamber); the zoomed-out view frames exactly this */
  private focus: { left: number; right: number; bottom: number; top: number };
  private _mode: CameraMode = 'overview';
  /** the last hands-off mode: tapping away from an ant, or double tapping out of a free view, returns here */
  private lastAuto: CameraMode = 'overview';
  /** called whenever the mode changes (UI, annotations) */
  public onModeChange: ((m: CameraMode) => void) | null = null;

  /** scan: 0 = sky, 1 = deepest chamber */
  private scanU = 0;
  private scanDir = 1;
  private scanDwell = 0;
  private scanHold = 0;
  /** 0..1: how fast the sweep is moving right now; eases to 0 while a caption is up and back to 1 after */
  private scanSpeed = 1;
  private captionHold = false;
  /** drift: where the action is (world coords) and the camera's glide velocity */
  private driftGoal: { x: number; y: number } | null = null;
  private readonly driftVel = new THREE.Vector2();

  private readonly pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number }>();
  private pinchDist = 0;
  private pinchMid = { x: 0, y: 0 };
  private lastTap = { t: 0, x: 0, y: 0 };
  private dragged = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
    bounds: CaseBounds,
    onTap: (lx: number, ly: number) => boolean
  ) {
    this.camera = camera;
    this.dom = dom;
    this.bounds = bounds;
    this.onTap = onTap;
    this.focus = { ...bounds };
    this.target.set((bounds.left + bounds.right) / 2, (bounds.bottom + bounds.top) / 2);
    this.fit();
    this.dist = this.maxDist;
    this.apply();

    dom.addEventListener('pointerdown', this.onDown);
    dom.addEventListener('pointermove', this.onMove);
    dom.addEventListener('pointerup', this.onUp);
    dom.addEventListener('pointercancel', this.onCancel);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('contextmenu', this.prevent);
  }

  public dispose(): void {
    const d = this.dom;
    d.removeEventListener('pointerdown', this.onDown);
    d.removeEventListener('pointermove', this.onMove);
    d.removeEventListener('pointerup', this.onUp);
    d.removeEventListener('pointercancel', this.onCancel);
    d.removeEventListener('wheel', this.onWheel);
    d.removeEventListener('contextmenu', this.prevent);
  }

  /** Recompute the cover distance (call after the camera aspect changes). */
  public fit(): void {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfW = (this.focus.right - this.focus.left) / 2;
    const halfH = (this.focus.top - this.focus.bottom) / 2;
    // largest zoom-out = just enough to frame the focus rectangle (never beyond what the case itself covers)
    this.maxDist = Math.max(halfH / tan, halfW / (tan * Math.max(0.01, this.camera.aspect)));
    this.dist = Math.min(this.dist, this.maxDist);
    if (this.goal) this.goal.dist = Math.min(this.goal.dist, this.maxDist);
    this.clamp();
    this.apply();
  }

  public focusCenterX(): number {
    return (this.focus.left + this.focus.right) / 2;
  }

  /** Tell the camera what the zoomed-out view should frame (clipped to the case). */
  public setFocus(f: { left: number; right: number; bottom: number; top: number }): void {
    const b = this.bounds;
    this.focus = {
      left: Math.max(b.left, f.left),
      right: Math.min(b.right, f.right),
      bottom: Math.max(b.bottom, f.bottom),
      top: Math.min(b.top, f.top),
    };
    this.fit();
  }

  /** While a caption is showing the up-down sweep eases to a stop; when it goes, the sweep eases back in. */
  public setCaptionHold(on: boolean): void {
    this.captionHold = on;
  }

  public get mode(): CameraMode {
    return this._mode;
  }

  public setMode(m: CameraMode): void {
    if (m === this._mode && (m !== 'follow' || this.followId !== null)) return;
    if (AUTO_MODES.includes(m)) this.lastAuto = m;
    const from = this._mode;
    this._mode = m;
    this.goal = null;
    this.driftVel.set(0, 0);
    this.scanHold = 0;
    this.scanDwell = 0;
    if (m !== 'follow') {
      this.followId = null;
      this.followZoom = false;
    }
    if (m === 'scan') this.enterScan(from === 'overview');
    this.onModeChange?.(m);
  }

  /** Whole farm -> scan -> drift -> whole farm. */
  public cycleMode(): void {
    const i = AUTO_MODES.indexOf(this._mode);
    this.setMode(AUTO_MODES[(i + 1) % AUTO_MODES.length]);
  }

  public reset(): void {
    this.setMode('overview');
  }

  /** Hand the camera back to the last hands-off mode (after following an ant or a manual look around). */
  public resume(): void {
    this.setMode(this.lastAuto);
  }

  /** Where the colony's action is, in world coords, for drift mode (null = nothing special going on). */
  public setDriftTarget(x: number | null, y?: number): void {
    this.driftGoal = x === null ? null : { x, y: y ?? 0 };
  }

  /** Any hands-on gesture leaves the automatic modes for the free camera. */
  private leaveOverview(): void {
    if (this._mode === 'follow') return;
    if (this._mode !== 'free') this.setMode('free');
    this.goal = null;
  }

  public follow(id: number): void {
    this.followId = id;
    this.followZoom = true;
    this.goal = null;
    if (this._mode !== 'follow') {
      this._mode = 'follow';
      this.onModeChange?.('follow');
    }
  }

  private widthFitDist(): number {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfW = (this.focus.right - this.focus.left) / 2;
    return THREE.MathUtils.clamp(halfW / (tan * Math.max(0.01, this.camera.aspect)), MIN_DIST, this.maxDist);
  }

  /** the vertical travel of the camera centre while the whole nest width fills the screen */
  private scanSpan(): { top: number; bottom: number } {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfH = this.widthFitDist() * tan;
    const top = this.focus.top - halfH;
    const bottom = this.focus.bottom + halfH;
    if (top <= bottom) {
      const mid = (this.focus.top + this.focus.bottom) / 2;
      return { top: mid, bottom: mid };
    }
    return { top, bottom };
  }

  private enterScan(fromTop: boolean): void {
    const { top, bottom } = this.scanSpan();
    const r = top - bottom;
    // from the whole-farm view, begin in the sky and sweep down; otherwise pick up from where the camera is
    this.scanU = fromTop || r <= 0.05 ? 0 : THREE.MathUtils.clamp((top - this.target.y) / r, 0, 1);
    this.scanDir = this.scanU > 0.85 ? -1 : 1;
  }

  /** Per-frame update. `followPos` is the followed ant's world position, or null if it is gone. */
  public update(dt: number, followPos: THREE.Vector3 | null): void {
    const k = 1 - Math.exp(-5 * dt);
    switch (this._mode) {
      case 'follow':
        if (this.followId === null || !followPos) {
          // the ant is gone: back to whatever hands-off view we came from
          this.followId = null;
          this.followZoom = false;
          this.setMode(this.lastAuto);
        } else {
          this.target.x += (followPos.x - this.target.x) * k;
          this.target.y += (followPos.y - this.target.y) * k;
          if (this.followZoom) {
            this.dist += (Math.min(FOLLOW_DIST, this.maxDist) - this.dist) * k * 0.7;
            if (Math.abs(this.dist - FOLLOW_DIST) < 0.02) this.followZoom = false;
          }
        }
        break;
      case 'overview':
        this.target.x += ((this.focus.left + this.focus.right) / 2 - this.target.x) * k;
        this.target.y += ((this.focus.bottom + this.focus.top) / 2 - this.target.y) * k;
        this.dist += (this.maxDist - this.dist) * k;
        break;
      case 'scan':
        this.updateScan(dt, k);
        break;
      case 'drift':
        this.updateDrift(dt);
        break;
      default:
        if (this.goal) {
          this.target.x += (this.goal.x - this.target.x) * k;
          this.target.y += (this.goal.y - this.target.y) * k;
          this.dist += (this.goal.dist - this.dist) * k;
          if (Math.abs(this.goal.dist - this.dist) < 0.01 && Math.hypot(this.goal.x - this.target.x, this.goal.y - this.target.y) < 0.01) {
            this.goal = null;
          }
        }
    }
    this.clamp();
    this.apply();
  }

  /** Whole nest width on screen; the view slides down to the deepest chamber and back, easing and lingering at each end. */
  private updateScan(dt: number, k: number): void {
    const { top, bottom } = this.scanSpan();
    const range = top - bottom;
    this.dist += (this.widthFitDist() - this.dist) * k;
    this.target.x += ((this.focus.left + this.focus.right) / 2 - this.target.x) * k;
    if (range < 0.05) {
      this.target.y += ((top + bottom) / 2 - this.target.y) * k;
      return;
    }
    if (this.scanHold > 0) {
      // the viewer is sliding by hand: follow their finger, resume from wherever they left it
      this.scanHold -= dt;
      this.scanU = THREE.MathUtils.clamp((top - this.target.y) / range, 0, 1);
      return;
    }
    this.scanSpeed += ((this.captionHold ? 0 : 1) - this.scanSpeed) * (1 - Math.exp(-2.2 * dt));
    if (this.scanDwell > 0) {
      this.scanDwell -= dt * this.scanSpeed;
    } else {
      const edge = this.scanDir > 0 ? 1 - this.scanU : this.scanU;
      const e = THREE.MathUtils.clamp(edge / 0.14, 0, 1);
      const f = 0.22 + 0.78 * (e * e * (3 - 2 * e)); // slow into the ends, steady between them
      this.scanU += (this.scanDir * SCAN_SPEED * f * this.scanSpeed * dt) / range;
      if (this.scanU >= 1 || this.scanU <= 0) {
        this.scanU = THREE.MathUtils.clamp(this.scanU, 0, 1);
        this.scanDir = -this.scanDir;
        this.scanDwell = SCAN_DWELL;
      }
    }
    const wantY = top - this.scanU * range;
    this.target.y += (wantY - this.target.y) * k;
  }

  /** Cinematic glide toward the action: accelerates and settles smoothly instead of snapping. */
  private updateDrift(dt: number): void {
    const wantDist = Math.min(this.widthFitDist(), Math.max(this.maxDist * 0.5, 3.2));
    this.dist += (wantDist - this.dist) * (1 - Math.exp(-0.9 * dt));
    const gx = this.driftGoal ? this.driftGoal.x : (this.focus.left + this.focus.right) / 2;
    const gy = this.driftGoal ? this.driftGoal.y : (this.focus.bottom + this.focus.top) / 2;
    const vk = 1 - Math.exp(-2.2 * dt);
    for (const axis of ['x', 'y'] as const) {
      const want = THREE.MathUtils.clamp((axis === 'x' ? gx - this.target.x : gy - this.target.y) * 0.9, -DRIFT_MAX_SPEED, DRIFT_MAX_SPEED);
      this.driftVel[axis] += (want - this.driftVel[axis]) * vk;
      this.target[axis] += this.driftVel[axis] * dt;
    }
  }

  /** Converts client coordinates into the canvas's own (possibly rotated) pixel space. */
  public toLocal(clientX: number, clientY: number): { x: number; y: number } {
    if (this.dom.closest('[data-rotated="1"]')) {
      // stage is rotated 90° clockwise: local x runs down the screen, local y runs right-to-left
      return { x: clientY, y: window.innerWidth - clientX };
    }
    const r = this.dom.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  private size(): { w: number; h: number } {
    return { w: this.dom.clientWidth || 1, h: this.dom.clientHeight || 1 };
  }

  /** world units per local pixel at the case plane */
  private wpp(dist = this.dist): number {
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    return (2 * dist * tan) / this.size().h;
  }

  private clamp(): void {
    this.dist = THREE.MathUtils.clamp(this.dist, MIN_DIST, this.maxDist);
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const halfH = this.dist * tan;
    const halfW = halfH * this.camera.aspect;
    const b = this.bounds;
    const cx = (b.left + b.right) / 2;
    const cy = (b.bottom + b.top) / 2;
    this.target.x = b.right - b.left > 2 * halfW ? THREE.MathUtils.clamp(this.target.x, b.left + halfW, b.right - halfW) : cx;
    this.target.y = b.top - b.bottom > 2 * halfH ? THREE.MathUtils.clamp(this.target.y, b.bottom + halfH, b.top - halfH) : cy;
  }

  private apply(): void {
    this.camera.position.set(this.target.x, this.target.y, this.bounds.z + this.dist);
    this.camera.lookAt(this.target.x, this.target.y, this.bounds.z);
  }

  private zoomAbout(lx: number, ly: number, factor: number): void {
    const { w, h } = this.size();
    const before = this.wpp();
    const wx = this.target.x + (lx - w / 2) * before;
    const wy = this.target.y - (ly - h / 2) * before;
    this.dist = THREE.MathUtils.clamp(this.dist * factor, MIN_DIST, this.maxDist);
    const after = this.wpp();
    this.target.x = wx - (lx - w / 2) * after;
    this.target.y = wy + (ly - h / 2) * after;
    this.followZoom = false;
    this.leaveOverview();
    this.clamp();
    this.apply();
  }

  private pinchState(): { d: number; mx: number; my: number } {
    const [a, b] = [...this.pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private readonly prevent = (e: Event) => e.preventDefault();

  private readonly onDown = (e: PointerEvent) => {
    if (e.button !== undefined && e.button > 2) return;
    this.dom.setPointerCapture?.(e.pointerId);
    const p = this.toLocal(e.clientX, e.clientY);
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now() });
    if (this.pointers.size === 1) this.dragged = false;
    if (this.pointers.size === 2) {
      const s = this.pinchState();
      this.pinchDist = s.d;
      this.pinchMid = { x: s.mx, y: s.my };
      this.dragged = true;
    }
  };

  private readonly onMove = (e: PointerEvent) => {
    const ptr = this.pointers.get(e.pointerId);
    if (!ptr) return;
    const p = this.toLocal(e.clientX, e.clientY);
    const dx = p.x - ptr.x;
    const dy = p.y - ptr.y;
    ptr.x = p.x;
    ptr.y = p.y;

    if (this.pointers.size === 1) {
      if (!this.dragged && Math.hypot(p.x - ptr.sx, p.y - ptr.sy) < TAP_PX) return;
      if (!this.dragged) {
        this.dragged = true;
        if (this._mode === 'scan') {
          /* sliding up and down keeps the scan: only the sweep pauses */
        } else {
          // grabbing the view takes it away from whatever the camera was doing
          this.setMode('free');
        }
      }
      const s = this.wpp();
      if (this._mode === 'scan') {
        const { top, bottom } = this.scanSpan();
        this.target.y = THREE.MathUtils.clamp(this.target.y + dy * s, Math.min(top, bottom), Math.max(top, bottom));
        this.scanHold = SCAN_RESUME;
      } else {
        this.target.x -= dx * s;
        this.target.y += dy * s;
      }
      this.clamp();
      this.apply();
    } else if (this.pointers.size === 2) {
      const s = this.pinchState();
      if (this.pinchDist > 0 && s.d > 0) this.zoomAbout(s.mx, s.my, this.pinchDist / s.d);
      if (this._mode !== 'follow') {
        const w = this.wpp();
        this.target.x -= (s.mx - this.pinchMid.x) * w;
        this.target.y += (s.my - this.pinchMid.y) * w;
        this.clamp();
        this.apply();
      }
      this.pinchDist = s.d;
      this.pinchMid = { x: s.mx, y: s.my };
    }
  };

  private readonly onUp = (e: PointerEvent) => {
    const ptr = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!ptr) return;
    if (this.pointers.size > 0) {
      // finishing a pinch: re-seed the remaining finger so it doesn't jump-pan
      for (const q of this.pointers.values()) {
        q.sx = q.x;
        q.sy = q.y;
      }
      return;
    }
    const now = performance.now();
    if (!this.dragged && now - ptr.t < TAP_MS && Math.hypot(ptr.x - ptr.sx, ptr.y - ptr.sy) < TAP_PX) {
      const picked = this.onTap(ptr.x, ptr.y);
      const dbl = now - this.lastTap.t < DOUBLE_TAP_MS && Math.hypot(ptr.x - this.lastTap.x, ptr.y - this.lastTap.y) < 40;
      if (!picked) {
        // tapping away from an ant lets go of it; a double tap steps through whole farm / scan / drift
        if (this._mode === 'follow') this.resume();
        else if (dbl) {
          if (this._mode === 'free') this.resume();
          else this.cycleMode();
        }
      }
      this.lastTap = { t: dbl ? 0 : now, x: ptr.x, y: ptr.y };
    }
  };

  private readonly onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.toLocal(e.clientX, e.clientY);
    const delta = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    this.zoomAbout(p.x, p.y, Math.exp(delta * 0.0015));
  };
}
