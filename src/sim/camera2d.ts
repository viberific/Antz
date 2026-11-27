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

const FOLLOW_DIST = 3.4;
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
  /** true while the camera sits on the framed overview (tracks it as the nest grows) */
  private overview = true;

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

  public reset(): void {
    this.followId = null;
    this.followZoom = false;
    this.goal = null;
    this.overview = true;
  }

  private leaveOverview(): void {
    this.overview = false;
    this.goal = null;
  }

  public follow(id: number): void {
    this.followId = id;
    this.followZoom = true;
    this.overview = false;
    this.goal = null;
  }

  /** Per-frame update. `followPos` is the followed ant's world position, or null if it is gone. */
  public update(dt: number, followPos: THREE.Vector3 | null): void {
    const k = 1 - Math.exp(-5 * dt);
    if (this.followId !== null) {
      if (!followPos) {
        this.followId = null;
        this.followZoom = false;
      } else {
        this.target.x += (followPos.x - this.target.x) * k;
        this.target.y += (followPos.y - this.target.y) * k;
        if (this.followZoom) {
          this.dist += (Math.min(FOLLOW_DIST, this.maxDist) - this.dist) * k * 0.7;
          if (Math.abs(this.dist - FOLLOW_DIST) < 0.02) this.followZoom = false;
        }
      }
    } else if (this.overview) {
      this.target.x += ((this.focus.left + this.focus.right) / 2 - this.target.x) * k;
      this.target.y += ((this.focus.bottom + this.focus.top) / 2 - this.target.y) * k;
      this.dist += (this.maxDist - this.dist) * k;
    } else if (this.goal) {
      this.target.x += (this.goal.x - this.target.x) * k;
      this.target.y += (this.goal.y - this.target.y) * k;
      this.dist += (this.goal.dist - this.dist) * k;
      if (Math.abs(this.goal.dist - this.dist) < 0.01 && Math.hypot(this.goal.x - this.target.x, this.goal.y - this.target.y) < 0.01) {
        this.goal = null;
      }
    }
    this.clamp();
    this.apply();
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
        // grabbing the view takes it away from whatever the camera was following
        this.followId = null;
        this.followZoom = false;
        this.leaveOverview();
      }
      const s = this.wpp();
      this.target.x -= dx * s;
      this.target.y += dy * s;
      this.clamp();
      this.apply();
    } else if (this.pointers.size === 2) {
      const s = this.pinchState();
      if (this.pinchDist > 0 && s.d > 0) this.zoomAbout(s.mx, s.my, this.pinchDist / s.d);
      if (this.followId === null) {
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
        // tapping away from an ant lets go of it and pulls back out to the whole nest, sky included
        if (this.followId !== null || dbl) this.reset();
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
