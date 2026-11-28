import * as THREE from 'three';
import type { AntColonySimulation } from './colony';
import type { FlatCameraController } from './camera2d';
import { SOIL_FRONT_Z, WORLD_SCALE, simToWorldX, simToWorldY } from './materials3d';
import { AntCaste, AntTask, SURFACE_BASE_Y, type CreatureKind } from './types';

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface AudioUpdateExtras {
  lightningOnset?: boolean;
}

interface CounterSnapshot {
  pickups: number;
  deliveries: number;
  digs: number;
  deposits: number;
  larvaFeeds: number;
  queenFeeds: number;
  tandems: number;
  rescues: number;
  flights: number;
  collapses: number;
  backfills: number;
  intrudersCount: number;
  sparksCount: number;
}

interface TrackedCreatureState {
  kind: CreatureKind;
  state: string;
  phase: number;
  x: number;
  y: number;
}

/**
 * Procedural nature-inspired Web Audio soundscape & spatial SFX engine.
 *
 * Uses shaped pink/brown/granular noise, resonant acoustic filtering, and natural FM/AM phrasing
 * rather than raw oscillators so every sound matches earth, wind, rain, thunder, foliage,
 * insects, and wildlife inside and around the glass terrarium.
 */
export class NatureAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambientGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;

  // Shared pre-baked seamless noise buffers (zero GC in frame loop)
  private pinkBuffer: AudioBuffer | null = null;
  private brownBuffer: AudioBuffer | null = null;
  private gritBuffer: AudioBuffer | null = null;

  // Continuous soundscape nodes
  private windGain: GainNode | null = null;
  private windLpf: BiquadFilterNode | null = null;
  private windShimmerGain: GainNode | null = null;
  private windShimmerBpf: BiquadFilterNode | null = null;

  private rainGain: GainNode | null = null;
  private rainLpf: BiquadFilterNode | null = null;
  private rainToneBpf: BiquadFilterNode | null = null;

  private earthGain: GainNode | null = null;
  private earthLpf: BiquadFilterNode | null = null;

  private waterGain: GainNode | null = null;
  private waterBpf: BiquadFilterNode | null = null;

  private scurryGain: GainNode | null = null;
  private scurryBpf: BiquadFilterNode | null = null;

  private swarmGain: GainNode | null = null;
  private swarmOsc: OscillatorNode | null = null;
  private swarmBpf: BiquadFilterNode | null = null;
  private swarmNoiseGain: GainNode | null = null;

  private continuousSources: AudioScheduledSourceNode[] = [];

  private _enabled = true;
  private _unlocked = false;
  private _paused = false;
  private disposed = false;

  // Cooldowns & polyphony caps (seconds in sim/real clock)
  private clock = 0;
  private activeVoices = 0;
  private readonly maxVoices = 18;
  private lastDigAt = -10;
  private lastDepositAt = -10;
  private lastPickupAt = -10;
  private lastFeedAt = -10;
  private lastCollapseAt = -10;
  private lastCombatAt = -10;
  private lastRaindropAt = -10;
  private lastBirdAt = -10;
  private nextBirdDelay = 3.5;
  private lastCricketAt = -10;
  private nextCricketDelay = 1.6;
  private lastWormAt = -10;
  private lastAnteaterStepAt = -10;
  private lastThunderAt = -10;
  private lastWindDripAt = -10;
  private lastLeafSnipAt = -10;

  // Diff state across frames
  private prevCounters: CounterSnapshot | null = null;
  private readonly prevCreatures = new Map<number, TrackedCreatureState>();
  private readonly prevIntruderHp = new Map<number, number>();
  private prevShake = 0;

  // Precomputed spatial mixing state (exposed for diagnostics / testing)
  public undergroundMix = 0;
  public zoomMix = 0;

  public get enabled(): boolean {
    return this._enabled;
  }

  public get unlocked(): boolean {
    return this._unlocked;
  }

  public setEnabled(on: boolean): void {
    this._enabled = on;
    this.syncMasterGain(0.08);
    if (on && this.ctx && this.ctx.state === 'suspended' && !this._paused) {
      void this.ctx.resume().catch(() => {});
    }
  }

  public setPaused(paused: boolean): void {
    this._paused = paused;
    if (!this.ctx) return;
    if (paused) {
      this.syncMasterGain(0.05);
    } else {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      this.syncMasterGain(0.14);
    }
  }

  /** Must be called from a user gesture (`pointerdown`, `keydown`, `touchstart`) to unlock Web Audio. */
  public unlock(): void {
    if (this.disposed) return;
    if (typeof window === 'undefined') return;

    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: 'interactive' });
      } catch {
        return;
      }
      this.buildGraph();
    }

    if (this.ctx.state === 'suspended') {
      void this.ctx
        .resume()
        .then(() => {
          this._unlocked = true;
          this.syncMasterGain(0.45);
        })
        .catch(() => {});
    } else {
      this._unlocked = true;
      this.syncMasterGain(0.45);
    }
  }

  private syncMasterGain(tau = 0.08): void {
    if (!this.ctx || !this.masterGain) return;
    const target = this._enabled && !this._paused && this._unlocked ? 0.78 : 0;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.safeTarget(this.masterGain.gain, target, now, tau);
  }

  private safeTarget(param: AudioParam, value: number, now: number, tau: number): void {
    if (!Number.isFinite(value) || !Number.isFinite(now) || !Number.isFinite(tau)) return;
    param.setTargetAtTime(value, now, Math.max(0.001, tau));
  }

  private startNoiseBurst(src: AudioBufferSourceNode, buffer: AudioBuffer, when: number, duration: number): void {
    src.buffer = buffer;
    src.loop = true;
    const maxOff = Math.max(0.05, buffer.duration - 0.15);
    src.start(when, Math.random() * maxOff, duration);
  }

  private buildGraph(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // Gentle mastering dynamics so overlapping thunder + collapse + rain stay warm and never clip
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -15;
    comp.knee.value = 18;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.012;
    comp.release.value = 0.24;

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = 0;

    this.ambientGain = ctx.createGain();
    this.ambientGain.gain.value = 0.9;

    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = 1.0;

    this.ambientGain.connect(comp);
    this.sfxGain.connect(comp);
    comp.connect(this.masterGain);
    this.masterGain.connect(ctx.destination);

    // Pre-bake 3s seamless pink & brown noise + 2s gritty granular earth noise
    this.pinkBuffer = this.createSeamlessPinkBuffer(ctx, 3);
    this.brownBuffer = this.createSeamlessBrownBuffer(ctx, 3);
    this.gritBuffer = this.createSeamlessGritBuffer(ctx, 2);

    // 1. Air / Foliage Breeze Layer
    const windSrc = this.makeLoopSource(ctx, this.pinkBuffer, 1.0);
    this.windLpf = ctx.createBiquadFilter();
    this.windLpf.type = 'lowpass';
    this.windLpf.frequency.value = 950;
    this.windLpf.Q.value = 0.65;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    windSrc.connect(this.windLpf);
    this.windLpf.connect(this.windGain);
    this.windGain.connect(this.ambientGain);

    const windShimSrc = this.makeLoopSource(ctx, this.pinkBuffer, 1.15);
    this.windShimmerBpf = ctx.createBiquadFilter();
    this.windShimmerBpf.type = 'bandpass';
    this.windShimmerBpf.frequency.value = 2100;
    this.windShimmerBpf.Q.value = 1.2;
    this.windShimmerGain = ctx.createGain();
    this.windShimmerGain.gain.value = 0;
    windShimSrc.connect(this.windShimmerBpf);
    this.windShimmerBpf.connect(this.windShimmerGain);
    this.windShimmerGain.connect(this.ambientGain);

    // 2. Rain Wash Layer
    const rainSrc = this.makeLoopSource(ctx, this.pinkBuffer, 1.07);
    this.rainToneBpf = ctx.createBiquadFilter();
    this.rainToneBpf.type = 'peaking';
    this.rainToneBpf.frequency.value = 1200;
    this.rainToneBpf.Q.value = 0.9;
    this.rainToneBpf.gain.value = 3.5;
    this.rainLpf = ctx.createBiquadFilter();
    this.rainLpf.type = 'lowpass';
    this.rainLpf.frequency.value = 3800;
    this.rainLpf.Q.value = 0.5;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    rainSrc.connect(this.rainToneBpf);
    this.rainToneBpf.connect(this.rainLpf);
    this.rainLpf.connect(this.rainGain);
    this.rainGain.connect(this.ambientGain);

    // 3. Subterranean Earth Room-Tone Layer
    const earthSrc = this.makeLoopSource(ctx, this.brownBuffer, 0.92);
    this.earthLpf = ctx.createBiquadFilter();
    this.earthLpf.type = 'lowpass';
    this.earthLpf.frequency.value = 145;
    this.earthLpf.Q.value = 0.7;
    this.earthGain = ctx.createGain();
    this.earthGain.gain.value = 0;
    earthSrc.connect(this.earthLpf);
    this.earthLpf.connect(this.earthGain);
    this.earthGain.connect(this.ambientGain);

    // 4. Water Seep / Tunnel Flood Layer
    const waterSrc = this.makeLoopSource(ctx, this.gritBuffer, 0.85);
    this.waterBpf = ctx.createBiquadFilter();
    this.waterBpf.type = 'bandpass';
    this.waterBpf.frequency.value = 620;
    this.waterBpf.Q.value = 2.4;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    waterSrc.connect(this.waterBpf);
    this.waterBpf.connect(this.waterGain);
    this.waterGain.connect(this.ambientGain);

    // 5. Colony Macro Tarsal Scurry Layer (chitin micro-rustle)
    const scurrySrc = this.makeLoopSource(ctx, this.gritBuffer, 1.32);
    this.scurryBpf = ctx.createBiquadFilter();
    this.scurryBpf.type = 'bandpass';
    this.scurryBpf.frequency.value = 2850;
    this.scurryBpf.Q.value = 1.35;
    this.scurryGain = ctx.createGain();
    this.scurryGain.gain.value = 0;
    scurrySrc.connect(this.scurryBpf);
    this.scurryBpf.connect(this.scurryGain);
    this.scurryGain.connect(this.ambientGain);

    // 6. Nuptial Flight Wing-Hum Layer (soft filtered flutter)
    this.swarmOsc = ctx.createOscillator();
    this.swarmOsc.type = 'triangle';
    this.swarmOsc.frequency.value = 158;
    const swarmBodyGain = ctx.createGain();
    swarmBodyGain.gain.value = 0.35;
    const swarmAirSrc = this.makeLoopSource(ctx, this.pinkBuffer, 1.1);
    this.swarmNoiseGain = ctx.createGain();
    this.swarmNoiseGain.gain.value = 0.65;
    this.swarmBpf = ctx.createBiquadFilter();
    this.swarmBpf.type = 'bandpass';
    this.swarmBpf.frequency.value = 240;
    this.swarmBpf.Q.value = 1.6;
    this.swarmGain = ctx.createGain();
    this.swarmGain.gain.value = 0;
    this.swarmOsc.connect(swarmBodyGain);
    swarmBodyGain.connect(this.swarmBpf);
    swarmAirSrc.connect(this.swarmNoiseGain);
    this.swarmNoiseGain.connect(this.swarmBpf);
    this.swarmBpf.connect(this.swarmGain);
    this.swarmGain.connect(this.ambientGain);
    this.swarmOsc.start();
    this.continuousSources.push(this.swarmOsc);
  }

  private makeLoopSource(ctx: AudioContext, buffer: AudioBuffer, rate = 1): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(0, Math.random() * Math.max(0.1, buffer.duration - 0.2));
    this.continuousSources.push(src);
    return src;
  }

  private createSeamlessPinkBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(1024, Math.floor(sr * seconds));
    const fade = Math.min(Math.floor(sr * 0.25), Math.floor(len * 0.12));
    const raw = new Float32Array(len + fade);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < raw.length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      if (i < fade) {
        const w = Math.sin((i / fade) * Math.PI * 0.5);
        out[i] = raw[i] * w + raw[len + i] * Math.sqrt(Math.max(0, 1 - w * w));
      } else {
        out[i] = raw[i];
      }
    }
    return buf;
  }

  private createSeamlessBrownBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(1024, Math.floor(sr * seconds));
    const fade = Math.min(Math.floor(sr * 0.3), Math.floor(len * 0.12));
    const raw = new Float32Array(len + fade);
    let last = 0;
    for (let i = 0; i < raw.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.025 * white) / 1.012;
      raw[i] = clamp(last * 2.8, -1, 1);
    }
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      if (i < fade) {
        const w = Math.sin((i / fade) * Math.PI * 0.5);
        out[i] = raw[i] * w + raw[len + i] * Math.sqrt(Math.max(0, 1 - w * w));
      } else {
        out[i] = raw[i];
      }
    }
    return buf;
  }

  private createSeamlessGritBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const sr = ctx.sampleRate;
    const len = Math.max(1024, Math.floor(sr * seconds));
    const fade = Math.min(Math.floor(sr * 0.2), Math.floor(len * 0.12));
    const raw = new Float32Array(len + fade);
    let env = 0;
    for (let i = 0; i < raw.length; i++) {
      if (Math.random() < 0.018) env = 0.4 + Math.random() * 0.6;
      else env *= 0.94;
      const white = Math.random() * 2 - 1;
      raw[i] = white * (0.08 + env * 0.65);
    }
    const buf = ctx.createBuffer(1, len, sr);
    const out = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      if (i < fade) {
        const w = Math.sin((i / fade) * Math.PI * 0.5);
        out[i] = raw[i] * w + raw[len + i] * Math.sqrt(Math.max(0, 1 - w * w));
      } else {
        out[i] = raw[i];
      }
    }
    return buf;
  }

  private createPanner(pan: number): AudioNode | null {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return null;
    if (typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -0.85, 0.85);
      p.connect(this.sfxGain);
      return p;
    }
    return this.sfxGain;
  }

  private worldViewMetrics(camera: THREE.PerspectiveCamera): { halfW: number; halfH: number; dist: number; groundWorldY: number } {
    const dist = Math.max(1.2, camera.position.z - SOIL_FRONT_Z);
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const halfW = halfH * Math.max(0.5, camera.aspect);
    const groundWorldY = simToWorldY(SURFACE_BASE_Y);
    return { halfW, halfH, dist, groundWorldY };
  }

  private panForSimX(sx: number, camera: THREE.PerspectiveCamera, halfW: number): number {
    const wx = simToWorldX(sx);
    return clamp((wx - camera.position.x) / Math.max(1.2, halfW), -0.85, 0.85);
  }

  private distanceGain(sx: number, sy: number, camera: THREE.PerspectiveCamera, halfW: number): number {
    const wx = simToWorldX(sx);
    const wy = simToWorldY(sy);
    const d = Math.hypot(wx - camera.position.x, wy - camera.position.y);
    return clamp(1 - d / Math.max(4.5, halfW * 1.65), 0.14, 1);
  }

  /**
   * Main per-frame audio update. Modulates spatial/weather ambience and triggers
   * organic event sounds from simulation state deltas and creature activity.
   */
  public update(
    sim: AntColonySimulation,
    camera: THREE.PerspectiveCamera,
    camCtl: FlatCameraController,
    dt: number,
    extras?: AudioUpdateExtras
  ): void {
    this.clock += dt;

    const { halfW, halfH, dist, groundWorldY } = this.worldViewMetrics(camera);
    // Compute how strongly the camera is subterranean vs surface/sky
    const depthFrac = (groundWorldY - camera.position.y) / Math.max(0.9, halfH * 0.7);
    const rawUnderground = clamp((depthFrac + 0.15) / 1.1, 0, 1);
    const rawZoom = clamp(1 - (dist - 1.6) / 6.5, 0, 1);
    // When zoomed all the way out in overview mode, surface weather stays mildly present alongside underground life
    const overviewBlend = camCtl.mode === 'overview' ? 0.35 : 1.0;
    this.undergroundMix = rawUnderground * (1 - (1 - rawZoom) * 0.45 * (1 - overviewBlend * 0.3));
    this.zoomMix = rawZoom;

    const ctx = this.ctx;
    if (!ctx || !this._unlocked || !this._enabled || this._paused || this.disposed) {
      this.captureSnapshot(sim);
      return;
    }

    const now = ctx.currentTime;
    const t = sim.simTime;
    const underground = this.undergroundMix;
    const earthMuffle = 1 - underground * 0.78;
    const rain = sim.rainIntensity();
    const isSnow = sim.weather === 'Snow';
    const windAbs = Math.abs(sim.windStrength);
    const windNorm = clamp(windAbs / 3.2, 0, 1);
    const gust = 0.65 + 0.35 * Math.sin(t * 0.42 + Math.sin(t * 0.19) * 1.7);

    // 1. Update wind & foliage breeze
    if (this.windGain && this.windLpf && this.windShimmerGain && this.windShimmerBpf) {
      const snowDamp = isSnow ? 0.55 : 1.0;
      const baseWindGain = (0.018 + windNorm * 0.085 * gust) * snowDamp * (0.25 + 0.75 * earthMuffle);
      const lpfTarget = lerp(240, 620 + windNorm * 950 * gust, earthMuffle);
      const shimTarget = windNorm * 0.032 * gust * earthMuffle * (isSnow ? 0.3 : 1.0);
      this.safeTarget(this.windGain.gain, baseWindGain, now, 0.18);
      this.safeTarget(this.windLpf.frequency, lpfTarget, now, 0.22);
      this.safeTarget(this.windShimmerGain.gain, shimTarget, now, 0.2);
      this.safeTarget(this.windShimmerBpf.frequency, 1750 + windNorm * 900 * gust, now, 0.2);
    }

    // 2. Update rain wash + surface droplets
    if (this.rainGain && this.rainLpf) {
      const activeRain = isSnow ? 0 : rain;
      const rainVol = activeRain > 0.02 ? (0.025 + Math.pow(activeRain, 0.85) * 0.16) * (0.28 + 0.72 * earthMuffle) : 0;
      const rainFreq = lerp(360, 1800 + activeRain * 2800, earthMuffle);
      this.safeTarget(this.rainGain.gain, rainVol, now, 0.2);
      this.safeTarget(this.rainLpf.frequency, rainFreq, now, 0.2);

      // Stochastic micro rain droplets hitting leaves/soil
      if (activeRain > 0.06 && this.clock - this.lastRaindropAt > lerp(0.45, 0.075, activeRain)) {
        if (Math.random() < 0.75) {
          this.playRaindrop(underground, clamp(activeRain, 0.15, 1));
          this.lastRaindropAt = this.clock;
        }
      } else if (sim.wetness > 0.35 && underground > 0.45 && this.clock - this.lastWindDripAt > 1.8) {
        // Post-rain cavern condensation drip
        if (Math.random() < 0.08) {
          this.playCavernDrip(Math.random() * 1.2 - 0.6);
          this.lastWindDripAt = this.clock;
        }
      }
    }

    // 3. Subterranean earth chamber resonance
    if (this.earthGain && this.earthLpf) {
      const earthVol = underground * (0.045 + rawZoom * 0.045);
      this.safeTarget(this.earthGain.gain, earthVol, now, 0.22);
      this.safeTarget(this.earthLpf.frequency, 115 + (1 - underground) * 70, now, 0.25);
    }

    // 4. Water trickle when flooded or very saturated tunnels
    if (this.waterGain && this.waterBpf) {
      const floodFactor = sim.floodDepth > 0.5 ? clamp(sim.floodDepth / 180, 0.25, 1) : 0;
      const wetSub = underground * clamp((sim.wetness - 0.45) / 0.55, 0, 1) * 0.25;
      const targetWater = (floodFactor * (0.35 + underground * 0.65) + wetSub) * 0.065;
      this.safeTarget(this.waterGain.gain, targetWater, now, 0.25);
      this.safeTarget(this.waterBpf.frequency, 520 + Math.sin(t * 2.3) * 140, now, 0.15);
    }

    // 5. Colony bustle / chitin scurry & leaf cutting near camera
    let nearMovingAnts = 0;
    let flyingAlates = 0;
    let avgNearX = 0;
    let leafCutX = -1;
    let leafCutDistG = 0;
    for (let i = 0; i < sim.ants.length; i++) {
      const a = sim.ants[i];
      if (a.flying) {
        flyingAlates++;
      }
      if (a.task === AntTask.CUTTING_LEAF && (a.leafTimer ?? 0) > 0) {
        const dg = this.distanceGain(a.x, a.y, camera, halfW);
        if (dg > leafCutDistG) {
          leafCutDistG = dg;
          leafCutX = a.x;
        }
      }
      if ((a.pauseTimer ?? 0) > 0 || Math.hypot(a.vx, a.vy) < 1.2) continue;
      const wx = simToWorldX(a.x);
      const wy = simToWorldY(a.y);
      if (Math.abs(wx - camera.position.x) < halfW * 1.1 && Math.abs(wy - camera.position.y) < halfH * 1.1) {
        nearMovingAnts++;
        avgNearX += a.x;
      }
    }
    if (leafCutX >= 0 && leafCutDistG > 0.25 && rawZoom > 0.3 && this.clock - this.lastLeafSnipAt > 0.65) {
      if (Math.random() < 0.35) {
        this.lastLeafSnipAt = this.clock;
        this.playLeafSnip(this.panForSimX(leafCutX, camera, halfW), leafCutDistG * (0.4 + 0.6 * rawZoom));
      }
    }
    if (this.scurryGain && this.scurryBpf) {
      const antDensity = clamp(nearMovingAnts / 28, 0, 1);
      const scurryVol = antDensity * (0.008 + rawZoom * 0.044);
      this.safeTarget(this.scurryGain.gain, scurryVol, now, 0.18);
      this.safeTarget(this.scurryBpf.frequency, 2450 + Math.sin(t * 5.7) * 350, now, 0.14);
    }

    // 6. Nuptial flight soft wing-hum
    if (this.swarmGain && this.swarmOsc && this.swarmBpf) {
      const wantSwarm = sim.swarming && flyingAlates > 0 ? clamp(flyingAlates / 5, 0.25, 1) * earthMuffle * 0.045 : 0;
      this.safeTarget(this.swarmGain.gain, wantSwarm, now, 0.25);
      if (flyingAlates > 0) {
        this.safeTarget(this.swarmOsc.frequency, 156 + Math.sin(t * 6.4) * 5, now, 0.08);
        this.safeTarget(this.swarmBpf.frequency, 225 + Math.sin(t * 4.1) * 25, now, 0.1);
      }
    }

    // 7. Ambient birdsong (Daytime, mild, not raining hard, not winter freeze, mostly above ground)
    const isDay = !sim.isNight();
    const mildAir = rain < 0.35 && !isSnow && sim.surfaceTempC > 4;
    if (isDay && mildAir && underground < 0.75 && this.clock - this.lastBirdAt > this.nextBirdDelay) {
      this.lastBirdAt = this.clock;
      const birdPresent = sim.creatures.some((c) => c.kind === 'bird');
      this.nextBirdDelay = birdPresent ? 2.4 + Math.random() * 3.0 : 5.5 + Math.random() * 8.5;
      const pan = Math.random() * 1.4 - 0.7;
      this.playAmbientBirdSong(pan, earthMuffle * (0.55 + 0.45 * (1 - underground)));
    }

    // 8. Nocturnal Crickets (Nighttime, warm, dry/light mist, not winter, near/above surface)
    if (!isDay && rain < 0.25 && !isSnow && sim.surfaceTempC > 10 && underground < 0.72) {
      if (this.clock - this.lastCricketAt > this.nextCricketDelay) {
        this.lastCricketAt = this.clock;
        this.nextCricketDelay = 1.15 + Math.random() * 1.6;
        const warmth = clamp((sim.surfaceTempC - 10) / 14, 0.35, 1);
        this.playCricketChirp((Math.random() - 0.5) * 1.3, earthMuffle * warmth * 0.85);
      }
    }

    // 9. Lightning -> Thunder crack + rolling deep storm rumble
    if (extras?.lightningOnset && this.clock - this.lastThunderAt > 2.2) {
      this.lastThunderAt = this.clock;
      this.playThunder(underground);
    }

    // 10. Event Deltas & Creature Tracking
    this.processEventDeltas(sim, camera, halfW, avgNearX / Math.max(1, nearMovingAnts));
    this.processCreatures(sim, camera, halfW);
  }

  private captureSnapshot(sim: AntColonySimulation): void {
    const c = sim.counters;
    this.prevCounters = {
      pickups: c.pickups,
      deliveries: c.deliveries,
      digs: c.digs,
      deposits: c.deposits,
      larvaFeeds: c.larvaFeeds,
      queenFeeds: c.queenFeeds,
      tandems: c.tandems,
      rescues: c.rescues,
      flights: c.flights,
      collapses: c.collapses,
      backfills: c.backfills,
      intrudersCount: sim.intruders.length,
      sparksCount: sim.particles.filter((p) => p.kind === 'spark').length,
    };
    this.prevShake = sim.shake;
    this.prevIntruderHp.clear();
    for (const m of sim.intruders) this.prevIntruderHp.set(m.id, m.hp);
    this.prevCreatures.clear();
    for (const cr of sim.creatures) {
      this.prevCreatures.set(cr.id, { kind: cr.kind, state: cr.state, phase: cr.phase, x: cr.x, y: cr.y });
    }
  }

  private processEventDeltas(
    sim: AntColonySimulation,
    camera: THREE.PerspectiveCamera,
    halfW: number,
    nearAntCenterX: number
  ): void {
    const c = sim.counters;
    const prev = this.prevCounters;
    const sparkCount = sim.particles.reduce((acc, p) => (p.kind === 'spark' ? acc + 1 : acc), 0);

    if (!prev) {
      this.captureSnapshot(sim);
      return;
    }

    const panDefault = nearAntCenterX > 0 ? this.panForSimX(nearAntCenterX, camera, halfW) : 0;

    // Excavation digs -> crisp sand/grit scrapes
    if (c.digs > prev.digs && this.clock - this.lastDigAt > 0.11) {
      this.lastDigAt = this.clock;
      const intensity = clamp((c.digs - prev.digs) * 0.45, 0.4, 1);
      this.playDigGrit(panDefault + (Math.random() - 0.5) * 0.35, intensity * (0.45 + 0.55 * this.zoomMix));
    }

    // Soil mound deposits / backfills -> soft muted earthy pat/pebble settle
    if ((c.deposits > prev.deposits || c.backfills > prev.backfills) && this.clock - this.lastDepositAt > 0.16) {
      this.lastDepositAt = this.clock;
      this.playSoilDeposit(panDefault + (Math.random() - 0.5) * 0.35, 0.4 + 0.6 * this.zoomMix);
    }

    // Food pickups / deliveries -> delicate seed/leaf/forage rustle
    if ((c.pickups > prev.pickups || c.deliveries > prev.deliveries) && this.clock - this.lastPickupAt > 0.24) {
      this.lastPickupAt = this.clock;
      this.playForageRustle(panDefault + (Math.random() - 0.5) * 0.4, 0.35 + 0.65 * this.zoomMix);
    }

    // Brood / queen feeding & trophallaxis -> ultra-quiet nursery intimacy when zoomed close
    if (
      (c.larvaFeeds > prev.larvaFeeds || c.queenFeeds > prev.queenFeeds) &&
      this.zoomMix > 0.42 &&
      this.clock - this.lastFeedAt > 0.55
    ) {
      this.lastFeedAt = this.clock;
      this.playBroodNibble(panDefault, this.zoomMix);
    }

    // Alate launch into air
    if (c.flights > prev.flights) {
      this.playWingTakeoff(panDefault, 0.65);
    }

    // Tunnel collapses & sudden seismic tremors
    const collapseBurst = c.collapses > prev.collapses;
    const shakeSpike = sim.shake - this.prevShake > 0.22;
    if ((collapseBurst || shakeSpike) && this.clock - this.lastCollapseAt > 0.45) {
      this.lastCollapseAt = this.clock;
      this.playTunnelCollapse(0, clamp(Math.max(0.55, sim.shake), 0.45, 1));
    }

    // Intruder combat bites / skirmish sparks
    let damageBurst = false;
    let combatX = nearAntCenterX;
    for (const m of sim.intruders) {
      const oldHp = this.prevIntruderHp.get(m.id);
      if (oldHp !== undefined && m.hp < oldHp - 0.4) {
        damageBurst = true;
        combatX = m.x;
        break;
      }
    }
    if ((damageBurst || sparkCount > prev.sparksCount + 1) && this.clock - this.lastCombatAt > 0.18) {
      const targetIntruder = sim.intruders[0];
      const sx = damageBurst ? combatX : targetIntruder ? targetIntruder.x : nearAntCenterX;
      const sy = targetIntruder ? targetIntruder.y : SURFACE_BASE_Y;
      const distG = this.distanceGain(sx, sy, camera, halfW);
      if (distG > 0.18) {
        this.lastCombatAt = this.clock;
        this.playMandibleSnap(this.panForSimX(sx, camera, halfW), distG * (0.5 + 0.5 * this.zoomMix));
      }
    }

    this.captureSnapshot(sim);
  }

  private processCreatures(sim: AntColonySimulation, camera: THREE.PerspectiveCamera, halfW: number): void {
    const activeIds = new Set<number>();

    for (const cr of sim.creatures) {
      activeIds.add(cr.id);
      const prev = this.prevCreatures.get(cr.id);
      const pan = this.panForSimX(cr.x, camera, halfW);
      const distG = this.distanceGain(cr.x, cr.y, camera, halfW);

      if (!prev) {
        // Newly arrived wildlife
        if (cr.kind === 'bird') {
          this.playWingFlutter(pan, distG * 0.9);
          this.playAmbientBirdSong(pan, distG * 0.95);
        } else if (cr.kind === 'anteater') {
          this.playAnteaterSniff(pan, distG * 0.85);
        } else if (cr.kind === 'spider') {
          this.playSandRustle(pan, distG * 0.55);
        } else if (cr.kind === 'antlion') {
          this.playSandSlide(pan, distG * 0.65);
        }
      } else {
        if (cr.kind === 'bird') {
          if (prev.state !== 'leaving' && cr.state === 'leaving') {
            this.playWingFlutter(pan, distG);
          } else if (cr.state === 'pecking' && Math.floor(cr.phase * 0.62) !== Math.floor(prev.phase * 0.62)) {
            this.playBirdPeck(pan, distG * (0.45 + 0.55 * this.zoomMix));
          }
        } else if (cr.kind === 'anteater') {
          if ((cr.state === 'approach' || cr.state === 'leaving') && this.clock - this.lastAnteaterStepAt > 0.55) {
            this.lastAnteaterStepAt = this.clock;
            this.playHeavyFootstep(pan, distG * 0.75);
          }
          if (cr.state === 'digging') {
            if (Math.floor(cr.phase * 0.5) !== Math.floor(prev.phase * 0.5)) {
              this.playAnteaterSniff(pan, distG * 0.85);
            }
            if (Math.floor(cr.phase * 0.25) !== Math.floor(prev.phase * 0.25)) {
              this.playAnteaterClawRake(pan, distG);
            }
          }
        } else if (cr.kind === 'antlion' && prev.state !== 'flinging' && cr.state === 'flinging') {
          this.playSandSlide(pan, distG * 0.9);
        } else if (cr.kind === 'spider' && prev.state !== 'wrapping' && cr.state === 'wrapping') {
          this.playSandRustle(pan, distG * 0.8);
        } else if (cr.kind === 'worm' && cr.state === 'burrowing' && distG > 0.3 && this.zoomMix > 0.35) {
          if (this.clock - this.lastWormAt > 1.75) {
            this.lastWormAt = this.clock;
            this.playWormSquirm(pan, distG * this.zoomMix);
          }
        }
      }

      this.prevCreatures.set(cr.id, { kind: cr.kind, state: cr.state, phase: cr.phase, x: cr.x, y: cr.y });
    }

    for (const id of this.prevCreatures.keys()) {
      if (!activeIds.has(id)) this.prevCreatures.delete(id);
    }
  }

  // ────────────────────────── Player Interaction SFX ──────────────────────────

  public playFoodDrop(sx: number, sy: number, camera: THREE.PerspectiveCamera, camCtl?: FlatCameraController): void {
    if (!this.canPlaySfx()) return;
    const { halfW } = this.worldViewMetrics(camera);
    const pan = this.panForSimX(sx, camera, halfW);
    const scale = camCtl?.mode === 'overview' ? 0.8 : 1.0;
    this.playOrganicFoodLand(pan, scale);
    void sy;
  }

  public playTapAnt(sx: number, camera: THREE.PerspectiveCamera): void {
    if (!this.canPlaySfx()) return;
    const { halfW } = this.worldViewMetrics(camera);
    this.playWoodTap(this.panForSimX(sx, camera, halfW), 0.55);
  }

  public playUiTick(): void {
    if (!this.canPlaySfx()) return;
    this.playWoodTap(0, 0.38);
  }

  public playAntSound(caste?: AntCaste): void {
    if (!this.canPlaySfx()) return;
    this.playMandibleSnap(0, caste === AntCaste.SOLDIER ? 0.65 : 0.45);
  }

  private canPlaySfx(): boolean {
    return (
      !this.disposed &&
      !!this.ctx &&
      !!this.sfxGain &&
      this._unlocked &&
      this._enabled &&
      !this._paused &&
      this.activeVoices < this.maxVoices
    );
  }

  private trackVoice(durationSec: number): void {
    this.activeVoices++;
    globalThis.setTimeout(() => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, Math.ceil(durationSec * 1000) + 40);
  }

  // ────────────────────────── Organic Nature Synthesis Voices ──────────────────────────

  private playRaindrop(underground: number, weight: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.065;
    this.trackVoice(dur);

    const dest = this.createPanner(Math.random() * 1.4 - 0.7);
    if (!dest) return;

    // Resinous natural droplet splash: short bandpassed noise + tiny descending droplet pitch puff
    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    const baseFreq = lerp(1900 + Math.random() * 1600, 420 + Math.random() * 180, underground);
    bpf.frequency.setValueAtTime(baseFreq, now);
    bpf.frequency.exponentialRampToValueAtTime(Math.max(180, baseFreq * 0.52), now + dur);
    bpf.Q.value = 3.2;

    const g = ctx.createGain();
    const peak = (0.02 + Math.random() * 0.025) * weight * (1 - underground * 0.72);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.01);
  }

  private playCavernDrip(pan: number): void {
    if (!this.canPlaySfx() || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.095;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    // Real water drop into a damp cave puddle sweeps *upward* slightly as the air bubble collapses
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const f0 = 640 + Math.random() * 280;
    osc.frequency.setValueAtTime(f0, now);
    osc.frequency.exponentialRampToValueAtTime(f0 * 1.65, now + 0.045);

    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = f0 * 1.3;
    bpf.Q.value = 2.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.028, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    osc.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    osc.start(now);
    osc.stop(now + dur + 0.01);
  }

  private playThunder(underground: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.brownBuffer || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const delay = 0.18 + Math.random() * 0.55;
    const start = ctx.currentTime + delay;
    const dur = 3.6;
    this.trackVoice(delay + dur);

    const dest = this.createPanner((Math.random() - 0.5) * 0.8);
    if (!dest) return;
    const muffle = 1 - underground * 0.65;

    // Distant initial atmospheric crack
    const crack = ctx.createBufferSource();
    crack.buffer = this.pinkBuffer;
    const crackLpf = ctx.createBiquadFilter();
    crackLpf.type = 'lowpass';
    crackLpf.frequency.setValueAtTime(lerp(1800, 320, underground), start);
    crackLpf.frequency.exponentialRampToValueAtTime(110, start + 0.65);
    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.0001, start);
    crackGain.gain.linearRampToValueAtTime(0.16 * muffle, start + 0.03);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.75);
    crack.connect(crackLpf);
    crackLpf.connect(crackGain);
    crackGain.connect(dest);
    this.startNoiseBurst(crack, this.pinkBuffer, start, 0.8);

    // Long undulating sub-bass rolling tail with secondary rumble swells
    const roll = ctx.createBufferSource();
    const rollLpf = ctx.createBiquadFilter();
    rollLpf.type = 'lowpass';
    rollLpf.frequency.setValueAtTime(155 * muffle + 45, start);
    rollLpf.frequency.exponentialRampToValueAtTime(52, start + dur);
    const rollGain = ctx.createGain();
    rollGain.gain.setValueAtTime(0.0001, start);
    rollGain.gain.linearRampToValueAtTime(0.28 * (0.55 + 0.45 * muffle), start + 0.18);
    rollGain.gain.linearRampToValueAtTime(0.14 * (0.55 + 0.45 * muffle), start + 0.9);
    rollGain.gain.linearRampToValueAtTime(0.21 * (0.55 + 0.45 * muffle), start + 1.45);
    rollGain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

    roll.connect(rollLpf);
    rollLpf.connect(rollGain);
    rollGain.connect(dest);
    this.startNoiseBurst(roll, this.brownBuffer, start, dur + 0.05);
  }

  private playAmbientBirdSong(pan: number, gainScale: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const motif = Math.floor(Math.random() * 3);
    const notes =
      motif === 0
        ? [
            { t: 0, d: 0.11, f0: 2550, f1: 3350 },
            { t: 0.16, d: 0.14, f0: 2900, f1: 3850 },
          ]
        : motif === 1
        ? [
            { t: 0, d: 0.08, f0: 2300, f1: 2700 },
            { t: 0.11, d: 0.08, f0: 2750, f1: 3150 },
            { t: 0.22, d: 0.16, f0: 3250, f1: 2800 },
          ]
        : [
            { t: 0, d: 0.17, f0: 2100, f1: 3400 },
            { t: 0.23, d: 0.09, f0: 3100, f1: 3500 },
          ];

    const totalDur = notes[notes.length - 1].t + notes[notes.length - 1].d + 0.05;
    this.trackVoice(totalDur);

    const dest = this.createPanner(pan);
    if (!dest) return;
    const baseAmp = clamp(0.032 * gainScale, 0.004, 0.055);
    const pitchJitter = 0.92 + Math.random() * 0.18;

    for (const n of notes) {
      const t0 = now + n.t;
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f0 * pitchJitter, t0);
      osc.frequency.exponentialRampToValueAtTime(n.f1 * pitchJitter, t0 + n.d);

      // Gentle FM syrinx vibrato for natural warble (not robotic sine)
      const vib = ctx.createOscillator();
      const vibG = ctx.createGain();
      vib.frequency.value = 32 + Math.random() * 14;
      vibG.gain.value = 48;
      vib.connect(vibG);
      vibG.connect(osc.frequency);

      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = 4400;

      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(baseAmp, t0 + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.d);

      osc.connect(lpf);
      lpf.connect(g);
      g.connect(dest);

      osc.start(t0);
      vib.start(t0);
      osc.stop(t0 + n.d + 0.02);
      vib.stop(t0 + n.d + 0.02);
    }
  }

  private playCricketChirp(pan: number, gainScale: number): void {
    if (!this.canPlaySfx() || !this.ctx) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const pulses = 3 + (Math.random() < 0.45 ? 1 : 0);
    const step = 0.038;
    const total = pulses * step + 0.04;
    this.trackVoice(total);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const carrier = ctx.createOscillator();
    carrier.type = 'triangle';
    carrier.frequency.value = 4120 + Math.random() * 240;

    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 4200;
    bpf.Q.value = 4.5;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    const amp = clamp(0.016 * gainScale, 0.002, 0.024);

    for (let i = 0; i < pulses; i++) {
      const t0 = now + i * step;
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.linearRampToValueAtTime(amp, t0 + 0.006);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.026);
    }

    carrier.connect(bpf);
    bpf.connect(env);
    env.connect(dest);
    carrier.start(now);
    carrier.stop(now + total);
  }

  private playDigGrit(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.gritBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.055 + Math.random() * 0.03;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.gritBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 1800 + Math.random() * 1400;
    bpf.Q.value = 1.6;

    const g = ctx.createGain();
    const peak = 0.036 * clamp(strength, 0.25, 1);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peak, now + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.gritBuffer, now, dur + 0.01);
  }

  private playSoilDeposit(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.065;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(680 + Math.random() * 280, now);
    bpf.frequency.exponentialRampToValueAtTime(340, now + dur);
    bpf.Q.value = 1.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.032 * clamp(strength, 0.25, 1), now + 0.007);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.01);
  }

  private playForageRustle(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.05;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const hpf = ctx.createBiquadFilter();
    hpf.type = 'bandpass';
    hpf.frequency.value = 2600 + Math.random() * 1200;
    hpf.Q.value = 1.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.024 * clamp(strength, 0.2, 1), now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(hpf);
    hpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.01);
  }

  private playLeafSnip(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.gritBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.042;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.gritBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(4200 + Math.random() * 700, now);
    bpf.frequency.exponentialRampToValueAtTime(2200, now + dur);
    bpf.Q.value = 2.4;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.028 * clamp(strength, 0.25, 1), now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.gritBuffer, now, dur + 0.01);
  }

  private playBroodNibble(pan: number, zoom: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.gritBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.04;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.gritBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 1350 + Math.random() * 350;
    bpf.Q.value = 2.0;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.016 * zoom, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.gritBuffer, now, dur + 0.01);
  }

  private playWingTakeoff(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.16;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(320, now);
    bpf.frequency.exponentialRampToValueAtTime(680, now + dur);
    bpf.Q.value = 2.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.04 * strength, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.01);
  }

  private playTunnelCollapse(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.brownBuffer || !this.gritBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.72;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    // Low earthy thump + settling rumble
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.brownBuffer;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(190, now);
    lpf.frequency.exponentialRampToValueAtTime(65, now + 0.55);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, now);
    rg.gain.linearRampToValueAtTime(0.22 * strength, now + 0.022);
    rg.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);
    rumble.connect(lpf);
    lpf.connect(rg);
    rg.connect(dest);
    this.startNoiseBurst(rumble, this.brownBuffer, now, 0.62);

    // Cascading tumbling sand & pebbles over 0.04s..0.65s
    const cascade = ctx.createBufferSource();
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(1400, now);
    bpf.frequency.exponentialRampToValueAtTime(750, now + dur);
    bpf.Q.value = 1.0;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, now);
    cg.gain.linearRampToValueAtTime(0.095 * strength, now + 0.05);
    cg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    cascade.connect(bpf);
    bpf.connect(cg);
    cg.connect(dest);
    this.startNoiseBurst(cascade, this.gritBuffer, now, dur + 0.02);
  }

  private playMandibleSnap(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.gritBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.032;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.gritBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(2400 + Math.random() * 900, now);
    bpf.frequency.exponentialRampToValueAtTime(1100, now + dur);
    bpf.Q.value = 2.6;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.055 * clamp(strength, 0.2, 1), now + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.gritBuffer, now, dur + 0.01);
  }

  private playWingFlutter(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const flaps = 4;
    const dur = flaps * 0.075 + 0.05;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 540;
    bpf.Q.value = 1.1;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    const peak = 0.08 * clamp(strength, 0.25, 1);
    for (let i = 0; i < flaps; i++) {
      const t0 = now + i * 0.072;
      g.gain.setValueAtTime(0.002, t0);
      g.gain.linearRampToValueAtTime(peak * (1 - i * 0.12), t0 + 0.022);
      g.gain.exponentialRampToValueAtTime(0.002, t0 + 0.065);
    }

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.02);
  }

  private playBirdPeck(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.045;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(1150, now);
    bpf.frequency.exponentialRampToValueAtTime(420, now + dur);
    bpf.Q.value = 2.0;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.048 * strength, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.01);
  }

  private playHeavyFootstep(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.brownBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.14;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.brownBuffer;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.value = 140;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.11 * strength, now + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(lpf);
    lpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.brownBuffer, now, dur + 0.01);
  }

  private playAnteaterSniff(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.18;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(420, now);
    bpf.frequency.exponentialRampToValueAtTime(760, now + 0.09);
    bpf.frequency.exponentialRampToValueAtTime(340, now + dur);
    bpf.Q.value = 1.8;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.065 * strength, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.02);
  }

  private playAnteaterClawRake(pan: number, strength: number): void {
    this.playDigGrit(pan, strength * 1.15);
    this.playHeavyFootstep(pan, strength * 0.9);
  }

  private playSandSlide(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.gritBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.24;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.gritBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(2400, now);
    bpf.frequency.exponentialRampToValueAtTime(1200, now + dur);
    bpf.Q.value = 1.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.055 * strength, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.gritBuffer, now, dur + 0.01);
  }

  private playSandRustle(pan: number, strength: number): void {
    this.playForageRustle(pan, strength * 1.1);
  }

  private playWormSquirm(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.16;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(320, now);
    bpf.frequency.exponentialRampToValueAtTime(580, now + 0.08);
    bpf.frequency.exponentialRampToValueAtTime(290, now + dur);
    bpf.Q.value = 3.2;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.028 * strength, now + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.01);
  }

  private playOrganicFoodLand(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.brownBuffer || !this.gritBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.11;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    // Soft earthen thud
    const thud = ctx.createBufferSource();
    thud.buffer = this.brownBuffer;
    const lpf = ctx.createBiquadFilter();
    lpf.type = 'lowpass';
    lpf.frequency.setValueAtTime(260, now);
    lpf.frequency.exponentialRampToValueAtTime(110, now + dur);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, now);
    tg.gain.linearRampToValueAtTime(0.095 * strength, now + 0.006);
    tg.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    thud.connect(lpf);
    lpf.connect(tg);
    tg.connect(dest);
    this.startNoiseBurst(thud, this.brownBuffer, now, dur + 0.01);

    // Subtle dry seed/crumb scatter
    const grit = ctx.createBufferSource();
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.value = 1850;
    bpf.Q.value = 1.4;
    const gg = ctx.createGain();
    gg.gain.setValueAtTime(0.0001, now + 0.01);
    gg.gain.linearRampToValueAtTime(0.038 * strength, now + 0.022);
    gg.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
    grit.connect(bpf);
    bpf.connect(gg);
    gg.connect(dest);
    this.startNoiseBurst(grit, this.gritBuffer, now + 0.01, 0.1);
  }

  private playWoodTap(pan: number, strength: number): void {
    if (!this.canPlaySfx() || !this.ctx || !this.pinkBuffer) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const dur = 0.042;
    this.trackVoice(dur);

    const dest = this.createPanner(pan);
    if (!dest) return;

    const src = ctx.createBufferSource();
    src.buffer = this.pinkBuffer;
    const bpf = ctx.createBiquadFilter();
    bpf.type = 'bandpass';
    bpf.frequency.setValueAtTime(520, now);
    bpf.frequency.exponentialRampToValueAtTime(280, now + dur);
    bpf.Q.value = 3.5;

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.04 * strength, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(bpf);
    bpf.connect(g);
    g.connect(dest);
    this.startNoiseBurst(src, this.pinkBuffer, now, dur + 0.01);
  }

  public dispose(): void {
    this.disposed = true;
    for (const s of this.continuousSources) {
      try {
        s.stop();
        s.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.continuousSources.length = 0;
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    this.masterGain = null;
    this.ambientGain = null;
    this.sfxGain = null;
  }
}
