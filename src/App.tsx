import { useEffect, useRef, useState } from 'react';
import { AntColonySimulation } from './sim/colony';
import { RealWorld } from './sim/realworld';
import { Formicarium3DRenderer } from './sim/renderer3d';
import type { CameraMode } from './sim/camera2d';
import { ArrowUpDown, BookOpen, Compass, Footprints, Maximize2, Volume2, VolumeX, X } from 'lucide-react';

const CAPTIONS_KEY = 'formicarium_captions';
const AUDIO_KEY = 'formicarium_audio';

function loadCaptions(): boolean {
  try {
    return localStorage.getItem(CAPTIONS_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadAudio(): boolean {
  try {
    return localStorage.getItem(AUDIO_KEY) !== '0';
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

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const renderer3dRef = useRef<Formicarium3DRenderer | null>(null);
  const [vp, setVp] = useState(viewport);
  const portrait = vp.h > vp.w;
  const [mode, setMode] = useState<CameraMode>('overview');
  const [captions, setCaptions] = useState(loadCaptions);
  const [soundOn, setSoundOn] = useState(loadAudio);
  const [hudIdle, setHudIdle] = useState(false);
  const [bootPhase, setBootPhase] = useState<'loading' | 'fading' | 'ready'>('loading');
  const [bootProgress, setBootProgress] = useState<{ pct: number; stage: string }>({
    pct: 4,
    stage: 'Initializing terrarium',
  });

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

  // unlock Web Audio cleanly on first user interaction
  useEffect(() => {
    const unlockAudio = () => {
      const r = renderer3dRef.current;
      if (r) r.audio.unlock();
    };
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    window.addEventListener('keydown', unlockAudio, { passive: true });
    window.addEventListener('touchstart', unlockAudio, { passive: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('touchstart', unlockAudio);
    };
  }, []);

  // desktop shortcuts: 1 / 2 / 3 camera modes, N notes, M sound, Esc stop following
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const cam = renderer3dRef.current?.camCtl;
      if (e.key === 'm' || e.key === 'M') {
        renderer3dRef.current?.audio.unlock();
        setSoundOn((s) => !s);
        return;
      }
      if (!cam) return;
      if (e.key === '1') cam.setMode('overview');
      else if (e.key === '2') cam.setMode('scan');
      else if (e.key === '3') cam.setMode('drift');
      else if (e.key === 'n' || e.key === 'N') setCaptions((c) => !c);
      else if (e.key === 'Escape' && cam.mode === 'follow') cam.resume();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
    const audio = renderer3dRef.current?.audio;
    if (audio) {
      if (soundOn) audio.unlock();
      audio.setEnabled(soundOn);
    }
    try {
      localStorage.setItem(AUDIO_KEY, soundOn ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }, [soundOn]);

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

    let rafId = 0;
    let timerId = 0;
    let autoSaveId = 0;
    let initialSaveId = 0;
    let fadeDoneId = 0;
    let disposed = false;
    let contextLost = false;
    let sim: AntColonySimulation | null = null;
    let world: RealWorld | null = null;
    let renderer3d: Formicarium3DRenderer | null = null;
    let lastTime = performance.now();
    let acc = 0;

    const report = (pct: number, stage: string) => {
      if (!disposed) {
        setBootProgress((prev) => ({
          pct: Math.max(prev.pct, Math.min(100, pct)),
          stage,
        }));
      }
    };

    const afterDraw = (cb: () => void) => {
      if (!renderer3d) return;
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

    let consecutiveErrors = 0;
    const tick = () => {
      if (disposed || !sim || !renderer3d) return;
      if (contextLost) return;
      const now = performance.now();
      const rawDt = Math.min(0.25, Math.max(0, (now - lastTime) / 1000));
      lastTime = now;

      try {
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
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors++;
        acc = 0;
        if (import.meta.env.DEV) console.error('Frame tick error:', err);
        if (consecutiveErrors >= 5) return;
      }

      if (renderer3d.isSoftwareGl) {
        afterDraw(tick);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    const onResize = () => {
      setVp(viewport());
      renderer3d?.resize();
    };
    const preventGesture = (e: Event) => e.preventDefault();
    const handleSave = () => sim?.saveState();
    const handleVisibilityChange = () => {
      const hidden = document.visibilityState === 'hidden';
      if (hidden) sim?.saveState();
      renderer3d?.audio.setPaused(hidden);
      lastTime = performance.now();
    };

    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    window.addEventListener('beforeunload', handleSave);
    window.addEventListener('pagehide', handleSave);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    document.addEventListener('gesturestart', preventGesture, { passive: false });
    document.addEventListener('gesturechange', preventGesture, { passive: false });

    const boot = async () => {
      report(8, 'Generating soil & colony');
      await nextFrame();
      if (disposed) return;

      sim = new AntColonySimulation();
      if (import.meta.env.DEV) (window as unknown as { __sim?: AntColonySimulation }).__sim = sim;
      world = new RealWorld(sim);

      report(22, 'Preparing lighting & reflections');
      await nextFrame();
      if (disposed) return;

      renderer3d = new Formicarium3DRenderer(container, sim, true);
      renderer3dRef.current = renderer3d;
      renderer3d.audio.setEnabled(loadAudio());
      renderer3d.onCameraMode = setMode;
      renderer3d.setAnnotations(loadCaptions());
      renderer3d.onContextLost = () => {
        contextLost = true;
        cancelAnimationFrame(rafId);
        window.clearTimeout(timerId);
      };
      renderer3d.onContextRestored = () => {
        if (disposed) return;
        contextLost = false;
        lastTime = performance.now();
        acc = 0;
        rafId = requestAnimationFrame(tick);
      };
      if (import.meta.env.DEV) (window as unknown as { __r?: unknown }).__r = renderer3d;
      if (import.meta.env.DEV) (window as unknown as { __antz?: unknown }).__antz = { sim, renderer3d };

      await nextFrame();
      if (disposed) return;

      await renderer3d.warmup(sim, report);
      if (disposed) return;

      // Render initial live frame, begin simulation, and cross-fade curtain away
      world.start();
      renderer3d.render(sim, SIM_STEP);
      report(100, 'Colony ready');
      await nextFrame();
      if (disposed) return;

      lastTime = performance.now();
      acc = 0;
      rafId = requestAnimationFrame(tick);
      autoSaveId = window.setInterval(handleSave, 15000);

      if (sim.needsInitialSave) {
        const s = sim;
        initialSaveId = window.setTimeout(() => {
          if (!disposed) {
            s.saveState();
            s.needsInitialSave = false;
          }
        }, 1500);
      }

      setBootPhase('fading');
      const reducedMotion =
        typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      fadeDoneId = window.setTimeout(() => {
        if (!disposed) setBootPhase('ready');
      }, reducedMotion ? 20 : 360);
    };

    void boot();

    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      window.clearTimeout(initialSaveId);
      window.clearTimeout(fadeDoneId);
      window.clearInterval(autoSaveId);
      world?.stop();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      window.removeEventListener('beforeunload', handleSave);
      window.removeEventListener('pagehide', handleSave);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      document.removeEventListener('gesturestart', preventGesture);
      document.removeEventListener('gesturechange', preventGesture);
      sim?.saveState();
      renderer3d?.dispose();
      renderer3dRef.current = null;
    };
  }, []);

  const displayPct = Math.round(bootProgress.pct);

  return (
    <main className="fixed inset-0 overflow-hidden bg-[#060607]">
      <div
        data-rotated={portrait ? '1' : '0'}
        className="stage absolute left-0 top-0"
        style={
          portrait
            ? { width: vp.h, height: vp.w, transform: 'rotate(90deg) translateY(-100%)', transformOrigin: 'top left' }
            : { width: vp.w, height: vp.h }
        }
      >
        <div ref={mountRef} className="w-full h-full touch-none cursor-grab active:cursor-grabbing" aria-label="Ant colony in a glass formicarium" />
        <div className="hud" data-idle={hudIdle ? '1' : '0'}>
          {mode === 'follow' && (
            <div className="hud-group">
              <button className="hud-btn" aria-pressed="true" onClick={() => renderer3dRef.current?.camCtl.resume()} title="Stop following (Esc)">
                <Footprints /> <span className="hud-label">Following</span> <X />
              </button>
            </div>
          )}
          <div className="hud-group" role="group" aria-label="Camera">
            <button className="hud-btn" aria-pressed={mode === 'overview'} onClick={() => renderer3dRef.current?.camCtl.setMode('overview')} title="Whole farm (1)">
              <Maximize2 /> <span className="hud-label">Whole</span>
            </button>
            <button className="hud-btn" aria-pressed={mode === 'scan'} onClick={() => renderer3dRef.current?.camCtl.setMode('scan')} title="Scan: full width, sweeping down the nest. Drag up or down to look yourself (2)">
              <ArrowUpDown /> <span className="hud-label">Scan</span>
            </button>
            <button className="hud-btn" aria-pressed={mode === 'drift'} onClick={() => renderer3dRef.current?.camCtl.setMode('drift')} title="Drift: glide to wherever the colony is busiest (3)">
              <Compass /> <span className="hud-label">Drift</span>
            </button>
          </div>
          <div className="hud-group">
            <button className="hud-btn" aria-pressed={captions} onClick={() => setCaptions((c) => !c)} title="Field notes (N)">
              <BookOpen /> <span className="hud-label">Notes</span>
            </button>
            <button
              className="hud-btn"
              aria-pressed={soundOn}
              onClick={() => {
                renderer3dRef.current?.audio.unlock();
                setSoundOn((s) => !s);
              }}
              title={soundOn ? 'Mute nature audio (M)' : 'Unmute nature audio (M)'}
              aria-label={soundOn ? 'Mute nature audio' : 'Enable nature audio'}
            >
              {soundOn ? <Volume2 /> : <VolumeX />} <span className="hud-label">Sound</span>
            </button>
          </div>
        </div>
        {bootPhase !== 'ready' && (
          <div
            className="boot-curtain"
            data-fading={bootPhase === 'fading' ? '1' : '0'}
            onTransitionEnd={() => {
              if (bootPhase === 'fading') setBootPhase('ready');
            }}
            aria-hidden={bootPhase === 'fading'}
          >
            <h1 className="boot-curtain-title">Formicarium</h1>
            <div
              className="boot-curtain-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={displayPct}
              aria-valuetext={`${bootProgress.stage} (${displayPct}%)`}
            >
              <div className="boot-curtain-track">
                <div
                  className="boot-curtain-fill"
                  style={{ transform: `scaleX(${Math.max(0.04, bootProgress.pct / 100)})` }}
                />
              </div>
              <p className="boot-curtain-sub">
                <span>{bootProgress.stage}</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono-tabular">{displayPct}%</span>
              </p>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
