import { useEffect, useRef, useState } from 'react';
import { AntColonySimulation, ColonyEvent, ColonyStats } from './sim/colony';
import { Formicarium3DRenderer } from './sim/renderer3d';

/** Fixed simulation step: behaviour no longer depends on the device's frame rate. */
const SIM_STEP = 1 / 30;
const SPEEDS = [1, 2, 4];

interface HudState {
  stats: ColonyStats;
  events: ColonyEvent[];
  simTime: number;
}

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const renderer3dRef = useRef<Formicarium3DRenderer | null>(null);
  const speedRef = useRef(1);
  const [speed, setSpeed] = useState(1);
  const [hud, setHud] = useState<HudState | null>(null);
  const [open, setOpen] = useState(() => {
    // collapsed by default on phones so the colony isn't hidden behind the panel
    const wide = typeof window !== 'undefined' && window.innerWidth >= 640;
    try {
      const saved = localStorage.getItem('formicarium_hud');
      return saved ? saved !== 'closed' : wide;
    } catch {
      return wide;
    }
  });

  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  useEffect(() => {
    try {
      localStorage.setItem('formicarium_hud', open ? 'open' : 'closed');
    } catch {
      /* ignore */
    }
  }, [open]);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const sim = new AntColonySimulation();
    const renderer3d = new Formicarium3DRenderer(container, sim);
    renderer3dRef.current = renderer3d;
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
      acc += rawDt * speedRef.current;
      const maxSteps = 8 * speedRef.current;
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

    const hudId = window.setInterval(() => {
      setHud({ stats: sim.getStats(), events: sim.events.slice(-5).reverse(), simTime: sim.simTime });
    }, 600);

    const onResize = () => renderer3d.resize();
    const preventGesture = (e: Event) => e.preventDefault();
    const handleSave = () => sim.saveState();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') sim.saveState();
      lastTime = performance.now();
    };

    const autoSaveId = window.setInterval(handleSave, 15000);
    window.addEventListener('resize', onResize);
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
      window.clearInterval(hudId);
      window.removeEventListener('resize', onResize);
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
    <main className="relative w-screen h-screen overflow-hidden bg-[#07080b]">
      <div
        ref={mountRef}
        onDoubleClick={() => renderer3dRef.current?.resetCamera()}
        className="w-full h-full touch-none cursor-grab active:cursor-grabbing"
        aria-label="Autonomous 3D glass formicarium ant colony"
      />
      {hud && <ColonyHud hud={hud} open={open} setOpen={setOpen} speed={speed} setSpeed={setSpeed} />}
    </main>
  );
}

function ColonyHud({
  hud,
  open,
  setOpen,
  speed,
  setSpeed,
}: {
  hud: HudState;
  open: boolean;
  setOpen: (v: boolean) => void;
  speed: number;
  setSpeed: (v: number) => void;
}) {
  const s = hud.stats;
  const c = s.castes;
  const workers = (c['Forager'] ?? 0) + (c['Nurse'] ?? 0) + (c['Excavator'] ?? 0);
  const busy = s.busy;
  const n = (k: string) => busy[k] ?? 0;
  const diggers = n('Excavating Tunnel') + n('Repairing Storm Damage') + n('Depositing Excavated Soil');

  return (
    <div className="pointer-events-none absolute left-2 top-2 right-2 sm:right-auto flex flex-col items-start gap-1.5 font-['IBM_Plex_Mono'] text-[11px] leading-[1.35] text-[#e9e3d8]">
      <div className="pointer-events-auto flex items-center gap-1 rounded-md bg-black/55 px-2 py-1 backdrop-blur-sm">
        <button
          onClick={() => setOpen(!open)}
          className="rounded px-1.5 py-0.5 text-[#f1d9a8] hover:bg-white/10"
          aria-expanded={open}
          aria-label={open ? 'Hide colony panel' : 'Show colony panel'}
        >
          {open ? '▾' : '▸'} Colony
        </button>
        <span className="px-1 text-white/70">
          Day {s.day} · {s.isNight ? 'night' : 'day'} · {s.weather.toLowerCase()}
        </span>
        <span className="ml-1 flex overflow-hidden rounded border border-white/15">
          {SPEEDS.map((v) => (
            <button
              key={v}
              onClick={() => setSpeed(v)}
              className={`px-1.5 py-0.5 ${speed === v ? 'bg-[#f1d9a8] text-black' : 'text-white/70 hover:bg-white/10'}`}
              aria-pressed={speed === v}
            >
              {v}×
            </button>
          ))}
        </span>
      </div>

      {open && (
        <div className="pointer-events-auto w-full max-w-[300px] rounded-md bg-black/55 px-2.5 py-2 backdrop-blur-sm">
          <Row label="Ants" value={`${s.population}${s.queenAlive ? '' : ' · no queen!'}`} />
          <Row
            label="Castes"
            value={`${s.queenAlive ? '1 queen · ' : ''}${workers} workers · ${c['Soldier'] ?? 0} soldiers`}
          />
          <Row label="Brood" value={`${s.eggs} eggs · ${s.larvae} larvae · ${s.pupae} pupae`} />
          <Row label="Stores" value={`${s.storedFood} food`} />
          <Row label="Nest" value={`${s.chambers} chambers · ${s.tunnelCells} dug · mound ${s.moundSoil}`} />
          <div className="mt-1.5 border-t border-white/10 pt-1.5 text-white/75">
            <div>
              {n('Carrying Food Home')} hauling food · {n('Scouting Surface') + n('Following Scent Trail')} foraging
            </div>
            <div>
              {n('Feeding Larva') + n('Relocating Brood') + n('Grooming') + n('Tending Queen')} tending brood/queen
            </div>
            <div>
              {diggers} digging/building · {n('Resting') + n('Heading Home to Rest')} resting
            </div>
            {s.intruders > 0 && (
              <div className="text-[#ff9b7a]">
                {s.intruders} intruder{s.intruders > 1 ? 's' : ''} · {n('Repelling Intruder')} ants fighting
              </div>
            )}
          </div>
          {hud.events.length > 0 && (
            <ul className="mt-1.5 space-y-0.5 border-t border-white/10 pt-1.5">
              {hud.events.map((e, i) => (
                <li
                  key={`${e.time}-${i}`}
                  className={e.kind === 'danger' ? 'text-[#ffb199]' : e.kind === 'good' ? 'text-[#bfe3a6]' : 'text-white/70'}
                >
                  {e.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-[52px] shrink-0 text-white/45">{label}</span>
      <span>{value}</span>
    </div>
  );
}
