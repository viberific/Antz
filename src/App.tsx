import { useEffect, useRef, useState } from 'react';
import { AntColonySimulation } from './sim/colony';
import { RealWorld } from './sim/realworld';
import { Formicarium3DRenderer } from './sim/renderer3d';
import type { CameraMode } from './sim/camera2d';
import { ArrowUpDown, BookOpen, Compass, Crosshair, Maximize2 } from 'lucide-react';

const CAPTIONS_KEY = 'formicarium_captions';

function loadCaptions(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Fixed simulation step: behaviour no longer depends on the device's frame rate. */
const SIM_STEP = 1 / 30;

/** Portrait screens draw the stage rotated 90° so the game is always landscape. */
function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

/** Best effort: real fullscreen + landscape lock where the browser allows it (Android); iOS ignores this. */
function goFullscreenLandscape(): void {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  const req = el.requestFullscreen?.bind(el) ?? el.webkitRequestFullscreen?.bind(el);
  if (!req || document.fullscreenElement) return;
  Promise.resolve(req())
    .then(() => {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
      return o?.lock?.('landscape');
    })
    .catch(() => {
      /* not allowed here: the rotated stage still gives a landscape view */
    });
}

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const renderer3dRef = useRef<Formicarium3DRenderer | null>(null);
  const [vp, setVp] = useState(viewport);
  const portrait = vp.h > vp.w;
  const [mode, setMode] = useState<CameraMode>('overview');
  const [captions, setCaptions] = useState(loadCaptions);
  const [hudIdle, setHudIdle] = useState(false);

  // controls fade back a few seconds after the last touch, so they never sit in the picture
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setHudIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setHudIdle(true), 4500);
    };
    wake();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('pointermove', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('pointermove', wake);
    };
  }, []);

  useEffect(() => {
    renderer3dRef.current?.setAnnotations(captions);
    try {
      localStorage.setItem(CAPTIONS_KEY, captions ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [captions]);

  useEffect(() => {
    const onFirstTouch = () => goFullscreenLandscape();
    window.addEventListener('pointerup', onFirstTouch, { once: true });
    return () => window.removeEventListener('pointerup', onFirstTouch);
  }, []);

  useEffect(() => {
    // the canvas is sized from the stage's (pre-rotation) layout box, so resize after the flip lands
    renderer3dRef.current?.resize();
  }, [vp.w, vp.h]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const sim = new AntColonySimulation();
    if (import.meta.env.DEV) (window as unknown as { __sim?: AntColonySimulation }).__sim = sim;
    const world = new RealWorld(sim);
    world.start();
    const renderer3d = new Formicarium3DRenderer(container, sim);
    renderer3dRef.current = renderer3d;
    renderer3d.onCameraMode = setMode;
    renderer3d.setAnnotations(loadCaptions());
    if (import.meta.env.DEV) (window as unknown as { __r?: unknown }).__r = renderer3d;
    if (import.meta.env.DEV) (window as unknown as { __antz?: unknown }).__antz = { sim, renderer3d };

    let rafId = 0;
    let timerId = 0;
    let disposed = false;
    let lastTime = performance.now();
    let acc = 0;

    const afterDraw = (cb: () => void) => {
      const gl = renderer3d.renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        timerId = window.setTimeout(cb, 30);
        return;
      }
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          timerId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          timerId = window.setTimeout(cb, 30);
        }
      };
      timerId = window.setTimeout(poll, 5);
    };

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const rawDt = Math.min(0.25, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;

      // Accumulate real time and advance the colony in fixed steps (capped so a long stall can't spiral).
      acc += rawDt;
      const maxSteps = 8;
      let steps = 0;
      while (acc >= SIM_STEP && steps < maxSteps) {
        sim.step(SIM_STEP);
        acc -= SIM_STEP;
        steps++;
      }
      if (steps >= maxSteps) acc = 0;

      renderer3d.render(sim, Math.max(0.001, Math.min(0.1, rawDt)));

      if (renderer3d.isSoftwareGl) {
        afterDraw(tick);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);

    const onResize = () => {
      setVp(viewport());
      renderer3d.resize();
    };
    const preventGesture = (e: Event) => e.preventDefault();
    const handleSave = () => sim.saveState();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') sim.saveState();
      lastTime = performance.now();
    };

    const autoSaveId = window.setInterval(handleSave, 15000);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('beforeunload', handleSave);
    window.addEventListener('pagehide', handleSave);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      window.clearInterval(autoSaveId);
      world.stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('beforeunload', handleSave);
      window.removeEventListener('pagehide', handleSave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      sim.saveState();
      renderer3d.dispose();
      renderer3dRef.current = null;
    };
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-black">
      <div
        data-rotated={portrait ? '1' : '0'}
        className="absolute left-0 top-0"
        style={
          portrait
            ? { width: vp.h, height: vp.w, transform: 'rotate(90deg) translateY(-100%)', transformOrigin: 'top left' }
            : { width: vp.w, height: vp.h }
        }
      >
        <div ref={mountRef} className="w-full h-full touch-none" aria-label="Ant colony in a glass formicarium" />
        <div className="hud" data-idle={hudIdle ? '1' : '0'}>
          {mode === 'follow' && (
            <div className="hud-group">
              <button className="hud-btn" aria-pressed="true" onClick={() => renderer3dRef.current?.camCtl.resume()} title="Stop following this ant">
                <Crosshair /> Following · release
              </button>
            </div>
          )}
          <div className="hud-group" role="group" aria-label="Camera">
            <button className="hud-btn" aria-pressed={mode === 'overview'} onClick={() => renderer3dRef.current?.camCtl.setMode('overview')} title="Whole farm">
              <Maximize2 /> Whole
            </button>
            <button className="hud-btn" aria-pressed={mode === 'scan'} onClick={() => renderer3dRef.current?.camCtl.setMode('scan')} title="Full width, sweeping down the nest. Drag up or down to look yourself.">
              <ArrowUpDown /> Scan
            </button>
            <button className="hud-btn" aria-pressed={mode === 'drift'} onClick={() => renderer3dRef.current?.camCtl.setMode('drift')} title="Glide to wherever the colony is busiest">
              <Compass /> Drift
            </button>
          </div>
          <div className="hud-group">
            <button className="hud-btn" aria-pressed={captions} onClick={() => setCaptions((c) => !c)} title="Field-note captions">
              <BookOpen /> Notes
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}
