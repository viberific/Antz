import { useEffect, useRef } from 'react';
import { AntColonySimulation } from './sim/colony';
import { Formicarium3DRenderer } from './sim/renderer3d';

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const renderer3dRef = useRef<Formicarium3DRenderer | null>(null);

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const sim = new AntColonySimulation();
    const renderer3d = new Formicarium3DRenderer(container, sim);
    renderer3dRef.current = renderer3d;

    let rafId = 0;
    let timerId = 0;
    let disposed = false;
    let lastTime = performance.now();

    const afterDraw = (cb: () => void) => {
      const gl = renderer3d.renderer.getContext() as WebGL2RenderingContext;
      if (!gl || typeof gl.fenceSync !== 'function') {
        timerId = window.setTimeout(cb, 80);
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
          timerId = window.setTimeout(cb, 80);
        }
      };
      timerId = window.setTimeout(poll, 5);
    };

    const tick = () => {
      if (disposed) return;
      const now = performance.now();
      const rawDt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      sim.step(rawDt);
      renderer3d.render(sim, rawDt);

      if (renderer3d.isSoftwareGl) {
        afterDraw(tick);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    rafId = requestAnimationFrame(tick);

    const onResize = () => renderer3d.resize();
    const preventGesture = (e: Event) => e.preventDefault();
    const handleSave = () => sim.saveState();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        sim.saveState();
      }
    };

    const autoSaveId = window.setInterval(handleSave, 10000);
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
    </main>
  );
}
