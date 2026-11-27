import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AntColonySimulation } from './colony';
import {
  MaterialBank,
  SOIL_BACK_Z,
  SOIL_FRONT_Z,
  WORLD_SCALE,
  detectSoftwareWebGL,
  simToWorldX,
  simToWorldY,
} from './materials3d';
import {
  AntRig,
  GeometryBank,
  IntruderRig,
  animateAntRig,
  animateIntruderRig,
  createAntRig,
  createGeometryBank,
  createIntruderRig,
  createSproutMesh,
  createSurfacePropMesh,
} from './models3d';
import { FormicariumEnvironment3D } from './terrain3d';
import { FlatCameraController } from './camera2d';
import { animateCreatureRig, createCreatureRig, disposeCreatureRig, type CreatureRig } from './creatures3d';
import { resetLegs } from './legs';
import { MeshBatcher, collectMeshes } from './batcher';
import {
  AntCaste,
  BroodStage,
  CASE_BOTTOM,
  CASE_LEFT,
  CASE_RIGHT,
  CASE_TOP,
  CELL_SIZE,
  CellType,
  GRID_H,
  GRID_W,
  PayloadType,
  SURFACE_BASE_Y,
  WORLD_H,
  WORLD_W,
} from './types';

// Pre-allocated math helpers (zero GC inside frame loop)
const _up = new THREE.Vector3();
const _avgUp = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _targetQuat = new THREE.Quaternion();
const _targetPos = new THREE.Vector3();
const _contactPos = new THREE.Vector3();
const _posHead = new THREE.Vector3();
const _upHead = new THREE.Vector3();
const _posTail = new THREE.Vector3();
const _upTail = new THREE.Vector3();
const _deltaVec = new THREE.Vector3();
const _footUp = new THREE.Vector3();
const _tfOut = {
  stretch: 1,
  x: 0,
  y: 0,
  z: 0,
  quat: _targetQuat,
  headPitch: 0,
  tailPitch: 0,
  headYaw: 0,
  tailYaw: 0,
  headUp: 0,
  tailUp: 0,
  headSide: 0,
  tailSide: 0,
  bodyDip: 0,
};
const _dummy = new THREE.Object3D();
const _pick = new THREE.Vector3();
// Keep bodies (and the head/tail probes) clear of the cut side faces of the soil block
const EDGE_L = CASE_LEFT + 28;
const EDGE_R = CASE_RIGHT - 28;
const _skyDay = new THREE.Color(0x162231);
const _skyDusk = new THREE.Color(0x281822);
const _skyNight = new THREE.Color(0x06080d);
const _skyTmp = new THREE.Color();
const _skyOvercast = new THREE.Color(0x2a3038);
const _skyFog = new THREE.Color(0x3a4550);
const _skyRain = new THREE.Color(0x111a24);
const _skySnow = new THREE.Color(0x4a5560);
const _skyFlash = new THREE.Color(0xc8d4ff);
const _flyEuler = new THREE.Euler();
const _sunDay = new THREE.Color(0xfff1d6);
const _sunDusk = new THREE.Color(0xff9c5a);
const _sunNight = new THREE.Color(0x6d8cc4);
const _sunTmp = new THREE.Color();


function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export class Formicarium3DRenderer {
  public readonly isSoftwareGl: boolean;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly camCtl: FlatCameraController;

  private readonly container: HTMLElement;
  private readonly bank: MaterialBank;
  private readonly geo: GeometryBank;
  private readonly env3d: FormicariumEnvironment3D;
  private groundSim: AntColonySimulation | null = null;
  /** Terrain sampler handed to the procedural leg solver: world point -> nearest surface contact point. */
  private readonly sampleGround = (wx: number, wy: number, wz: number, out: THREE.Vector3): void => {
    if (!this.groundSim) return;
    const sx = wx / WORLD_SCALE + WORLD_W * 0.5;
    const sy = WORLD_H * 0.5 - wy / WORLD_SCALE;
    this.env3d.sampleSurfaceContact(this.groundSim, sx, sy, wz, out, _footUp);
  };
  private readonly airGround = (wx: number, wy: number, wz: number, out: THREE.Vector3): void => {
    out.set(wx, wy - 0.025, wz);
  };
  private readonly envMapTex: THREE.Texture;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly chamberLight: THREE.PointLight;

  private readonly antRigs = new Map<number, AntRig>();
  private readonly intruderRigs = new Map<number, IntruderRig>();
  private readonly rigMeshes = new Map<object, THREE.Mesh[]>();
  private readonly batcher: MeshBatcher;
  /** coarse buckets of ants by sim position, for the cheap side-by-side passing dodge */
  private readonly dodgeBuckets = new Map<number, number[]>();
  private readonly sproutMeshes: { mesh: THREE.Group; phase: number; baseX: number; baseY: number }[] = [];

  // Instanced pools for repeated small entities
  private readonly eggMesh: THREE.InstancedMesh;
  private readonly larvaMesh: THREE.InstancedMesh;
  private readonly pupaMesh: THREE.InstancedMesh;
  private readonly seedMesh: THREE.InstancedMesh;
  private readonly honeyMesh: THREE.InstancedMesh;
  private readonly proteinMesh: THREE.InstancedMesh;
  private readonly fungusMesh: THREE.InstancedMesh;
  private readonly dropletMesh: THREE.InstancedMesh;
  private readonly fallenMesh: THREE.InstancedMesh;
  private readonly dustMesh: THREE.InstancedMesh;
  private readonly rainMesh: THREE.InstancedMesh;
  private readonly crumbMesh: THREE.InstancedMesh;
  private readonly sparkMesh: THREE.InstancedMesh;

  private readonly instancedGeos: THREE.BufferGeometry[] = [];
  private readonly extraMats: THREE.Material[] = [];

  private disposed = false;
  private lightningFlash = 0;
  private readonly snowMesh: THREE.InstancedMesh;
  private readonly snowCapMesh: THREE.Mesh;
  private snowKey = '';
  private readonly floodMesh: THREE.InstancedMesh;
  private readonly aphidMesh: THREE.InstancedMesh;
  private readonly debrisMesh: THREE.InstancedMesh;
  private floodKey = '';
  private readonly creatureRigs = new Map<number, CreatureRig>();
  private moon!: THREE.Mesh;
  private moonCanvas!: HTMLCanvasElement;
  private moonTex!: THREE.CanvasTexture;
  private moonKey = -1;
  private fireflies!: THREE.InstancedMesh;
  private fireflyLevel = 0;
  private autumnLeaves!: THREE.InstancedMesh;
  private leafLevel = 0;

  private readonly sim: AntColonySimulation;
  private readonly _ray = new THREE.Raycaster();
  private readonly _plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -SOIL_FRONT_Z);

  constructor(container: HTMLElement, sim: AntColonySimulation) {
    this.sim = sim;
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGL();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    // Phones are fill-rate bound: 1.5x is visually close to their native 3x at a fraction of the pixel cost.
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, coarse ? 1.5 : 2));
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setSize(container.clientWidth || window.innerWidth, container.clientHeight || window.innerHeight);

    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0f17);
    this.scene.fog = new THREE.FogExp2(0x0b0f17, 0.011);

    const aspect = (container.clientWidth || window.innerWidth) / Math.max(1, container.clientHeight || window.innerHeight);
    this.camera = new THREE.PerspectiveCamera(42, aspect, 0.2, 160);

    // Studio RoomEnvironment reflection map
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envMapTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMapTex;
    pmrem.dispose();

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    this.bank = new MaterialBank(this.isSoftwareGl, maxAniso);
    this.geo = createGeometryBank();

    // 3-point + warm subterranean nest lighting
    this.hemiLight = new THREE.HemisphereLight(0xa5c4e8, 0x3f2918, 0.72);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff1d6, 2.2);
    this.sunLight.position.set(8, 16, 14);
    this.sunLight.castShadow = !this.isSoftwareGl;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 48;
    this.sunLight.shadow.camera.left = -18;
    this.sunLight.shadow.camera.right = 18;
    this.sunLight.shadow.camera.top = 12;
    this.sunLight.shadow.camera.bottom = -12;
    this.sunLight.shadow.bias = -0.0005;
    this.sunLight.shadow.normalBias = 0.025;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.rimLight = new THREE.DirectionalLight(0x88b4e8, 0.75);
    this.rimLight.position.set(-10, 10, -12);
    this.scene.add(this.rimLight);

    // Subtle macro observation light illuminating inside the glass tunnels
    this.chamberLight = new THREE.PointLight(0xffdfb0, 1.35, 36, 1.1);
    this.chamberLight.position.set(0, -1.5, 9.5);
    this.scene.add(this.chamberLight);

    // Build 3D formicarium case, dynamic 3D soil granules, roots, pebbles
    this.env3d = new FormicariumEnvironment3D(sim, this.bank, maxAniso, this.isSoftwareGl);
    this.scene.add(this.env3d.group);

    // Build static 3D surface props & animated sprouts
    for (const prop of sim.surfaceProps) {
      const m = createSurfacePropMesh(prop, this.bank, this.geo);
      m.position.set(simToWorldX(prop.x), simToWorldY(prop.y), 0.10 + Math.sin(prop.seed) * 0.22);
      this.scene.add(m);
    }
    for (const sp of sim.sprouts) {
      const m = createSproutMesh(sp, this.bank, this.geo);
      const wx = simToWorldX(sp.x);
      const wy = simToWorldY(sp.y);
      const wz = 0.10 + Math.sin(sp.x * 0.23) * 0.34;
      m.position.set(wx, wy, wz);
      this.scene.add(m);
      this.sproutMeshes.push({ mesh: m, phase: sp.swayPhase, baseX: wx, baseY: wy });
    }

    // Create InstancedMeshes for brood, food, droplets, fallen ants, and particles
    const makeInst = (
      g: THREE.BufferGeometry,
      m: THREE.Material,
      count: number,
      shadow = true,
      ownGeo = true
    ) => {
      const im = new THREE.InstancedMesh(g, m, count);
      im.count = 0;
      im.frustumCulled = false;
      im.castShadow = shadow && !this.isSoftwareGl;
      im.receiveShadow = shadow;
      this.scene.add(im);
      if (ownGeo) this.instancedGeos.push(g);
      return im;
    };

    const dustMat = new THREE.MeshBasicMaterial({ color: 0xf2e6cc, transparent: true, opacity: 0.3, depthWrite: false });
    const rainMat = new THREE.MeshBasicMaterial({ color: 0xbae6fd, transparent: true, opacity: 0.52 });
    const sparkMat = new THREE.MeshBasicMaterial({ color: 0xfef08a });
    this.extraMats.push(dustMat, rainMat, sparkMat);

    this.eggMesh = makeInst(new THREE.IcosahedronGeometry(0.05, 1), this.bank.eggMat, 90);
    this.larvaMesh = makeInst(this.geo.larvaGeo, this.bank.larvaMat, 90, true, false);
    this.pupaMesh = makeInst(new THREE.IcosahedronGeometry(0.072, 1), this.bank.pupaMat, 90);
    this.seedMesh = makeInst(new THREE.IcosahedronGeometry(0.078, 0), this.bank.seedMat, 80);
    this.honeyMesh = makeInst(new THREE.IcosahedronGeometry(0.076, 1), this.bank.honeydewMat, 60, false);
    this.proteinMesh = makeInst(new THREE.IcosahedronGeometry(0.058, 1), this.bank.proteinMat, 60);
    this.fungusMesh = makeInst(new THREE.IcosahedronGeometry(0.095, 1), this.bank.fungusMat, 60);
    this.dropletMesh = makeInst(new THREE.IcosahedronGeometry(0.045, 1), this.bank.waterMat, 140, false);
    this.fallenMesh = makeInst(this.geo.fallenAntGeo, this.bank.fallenAntMat, 40, true, false);
    // Real dust motes are specks, not pebbles: keep them far smaller than an ant's head (~0.04 across).
    this.dustMesh = makeInst(new THREE.IcosahedronGeometry(0.011, 1), dustMat, 140, false);
    this.rainMesh = makeInst(new THREE.BoxGeometry(0.014, 0.24, 0.014), rainMat, 220, false);
    const snowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
    const snowCapMat = new THREE.MeshStandardMaterial({ color: 0xf4f7fb, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    const floodMat = new THREE.MeshStandardMaterial({
      color: 0x5b7f96,
      roughness: 0.08,
      metalness: 0.1,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.extraMats.push(snowMat, snowCapMat, floodMat);
    this.snowMesh = makeInst(new THREE.IcosahedronGeometry(0.022, 0), snowMat, 220, false);
    // one continuous snow blanket, rebuilt along the smoothed ground contour whenever it changes
    this.snowCapMesh = new THREE.Mesh(new THREE.BufferGeometry(), snowCapMat);
    this.snowCapMesh.receiveShadow = true;
    this.snowCapMesh.frustumCulled = false;
    this.snowCapMesh.visible = false;
    this.scene.add(this.snowCapMesh);
    this.floodMesh = makeInst(new THREE.BoxGeometry(CELL_SIZE * WORLD_SCALE * 1.02, CELL_SIZE * WORLD_SCALE * 1.02, 0.7), floodMat, 1600, false);
    this.aphidMesh = makeInst(new THREE.IcosahedronGeometry(0.035, 1), this.bank.aphidMat, 60);
    this.debrisMesh = makeInst(new THREE.IcosahedronGeometry(0.06, 0), this.bank.debrisMat, 16);
    this.crumbMesh = makeInst(new THREE.SphereGeometry(0.036, 6, 4), this.bank.soilCrumbMat, 120, false);
    this.sparkMesh = makeInst(new THREE.IcosahedronGeometry(0.038, 0), sparkMat, 80, false);
    this.batcher = new MeshBatcher(this.scene, !this.isSoftwareGl);
    this.buildSkyExtras();

    // Flat observation camera: pan, pinch/wheel zoom, tap an ant to follow it. No orbiting.
    this.camCtl = new FlatCameraController(
      this.camera,
      this.renderer.domElement,
      {
        left: simToWorldX(CASE_LEFT),
        right: simToWorldX(CASE_RIGHT),
        top: simToWorldY(CASE_TOP),
        bottom: simToWorldY(CASE_BOTTOM),
        z: SOIL_FRONT_Z,
      },
      (lx, ly) => this.pickAnt(lx, ly) || (this.dropFoodAt(lx, ly), false)
    );

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
  }

  private buildSkyExtras(): void {
    // the moon is a flat canvas disc whose lit crescent is redrawn when the phase changes
    this.moonCanvas = document.createElement('canvas');
    this.moonCanvas.width = this.moonCanvas.height = 128;
    this.moonTex = new THREE.CanvasTexture(this.moonCanvas);
    this.moonTex.colorSpace = THREE.SRGBColorSpace;
    const moonGeo = new THREE.PlaneGeometry(1.7, 1.7);
    this.moon = new THREE.Mesh(moonGeo, new THREE.MeshBasicMaterial({ map: this.moonTex, transparent: true, fog: false, depthWrite: false }));
    this.moon.position.z = -4;
    this.moon.visible = false;
    this.scene.add(this.moon);
    this.instancedGeos.push(moonGeo);

    const flyGeo = new THREE.IcosahedronGeometry(0.03, 1);
    const flyMat = new THREE.MeshBasicMaterial({ color: 0xd9ff6e, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.fireflies = new THREE.InstancedMesh(flyGeo, flyMat, 48);
    this.fireflies.frustumCulled = false;
    this.fireflies.count = 0;
    this.scene.add(this.fireflies);

    const leafGeo = new THREE.PlaneGeometry(0.09, 0.06);
    const leafMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.autumnLeaves = new THREE.InstancedMesh(leafGeo, leafMat, 60);
    this.autumnLeaves.frustumCulled = false;
    this.autumnLeaves.count = 0;
    const c = new THREE.Color();
    const tones = [0xd9531e, 0xe38a1d, 0xc2352a, 0xe8c040, 0x9a5a22];
    for (let i = 0; i < 60; i++) this.autumnLeaves.setColorAt(i, c.set(tones[i % tones.length]));
    this.scene.add(this.autumnLeaves);
    this.instancedGeos.push(flyGeo, leafGeo);
    this.extraMats.push(flyMat, leafMat);
  }

  /** Moon with real phase, fireflies on warm nights, leaves drifting down in autumn. */
  private syncSky(sim: AntColonySimulation): void {
    const t = sim.simTime;
    const ctr = this.camCtl.focusCenterX();
    const tod = sim.timeOfDay;
    const n = (((tod - 0.72) % 1) + 1) % 1 / 0.56; // 0 at dusk .. 1 at dawn
    const nightUp = n > 0 && n < 1;
    const groundW = simToWorldY(SURFACE_BASE_Y);
    const lunar = (((Date.now() / 86400000 - 10957.27) % 29.530588) + 29.530588) % 29.530588 / 29.530588; // 0 new
    const lit = (1 - Math.cos(lunar * Math.PI * 2)) / 2;
    this.moon.visible = nightUp && lit > 0.04;
    if (this.moon.visible) {
      this.moon.position.set(ctr + (n - 0.5) * 16, groundW + 2.0 + Math.sin(n * Math.PI) * 1.6, -4);
      const key = Math.round(lunar * 60);
      if (key !== this.moonKey) {
        this.moonKey = key;
        const ctx = this.moonCanvas.getContext('2d')!;
        const R = 60;
        ctx.clearRect(0, 0, 128, 128);
        ctx.save();
        ctx.beginPath();
        ctx.arc(64, 64, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = '#eef2ff';
        ctx.fillRect(0, 0, 128, 128);
        // the terminator: an ellipse of the unlit part (waxing lit on the right, waning on the left)
        ctx.globalCompositeOperation = 'destination-out';
        const waxing = lunar < 0.5;
        const k = Math.cos(lunar * Math.PI * 2); // 1 new .. -1 full
        ctx.beginPath();
        if (k > 0) {
          // crescent: cut away the dark side plus an ellipse
          ctx.rect(waxing ? 0 : 64, 0, 64, 128);
          ctx.ellipse(64, 64, R * k, R, 0, 0, Math.PI * 2);
        } else {
          // gibbous: cut away only the thin dark side
          ctx.ellipse(64, 64, R * -k, R, 0, waxing ? Math.PI / 2 : -Math.PI / 2, waxing ? Math.PI * 1.5 : Math.PI / 2, false);
        }
        ctx.fill();
        ctx.restore();
        ctx.globalCompositeOperation = 'source-over';
        this.moonTex.needsUpdate = true;
      }
    }
    this.rimLight.intensity = 0.75 + (nightUp ? lit * 0.55 * Math.sin(n * Math.PI) : 0);

    // fireflies: warm, calm, dark
    const warm = sim.season === 'Summer' ? 1 : sim.season === 'Winter' ? 0 : 0.5;
    const calm = sim.rainIntensity() < 0.2 && sim.surfaceTempC > 11 && sim.windStrength < 1.2;
    const wantFly = sim.isNight() && calm ? warm : 0;
    this.fireflyLevel += (wantFly - this.fireflyLevel) * 0.02;
    const nFly = Math.round(this.fireflyLevel * 48);
    this.fireflies.count = nFly;
    for (let i = 0; i < nFly; i++) {
      const bx = ctr + (((i * 37) % 100) / 100 - 0.5) * 22;
      const x = bx + Math.sin(t * 0.21 + i) * 0.9;
      const gx = clamp(Math.floor((x / WORLD_SCALE + WORLD_W * 0.5) / CELL_SIZE), 0, GRID_W - 1);
      const ground = simToWorldY(sim.grid.surfaceY[gx]);
      const y = ground + 0.3 + (Math.sin(t * 0.3 + i * 1.7) * 0.5 + 0.5) * 1.3;
      const blink = Math.pow(Math.max(0, Math.sin(t * 1.5 + i * 2.3)), 3);
      _dummy.position.set(x, y, 0.1 + (((i * 53) % 100) / 100) * 0.5);
      _dummy.rotation.set(0, 0, 0);
      _dummy.scale.setScalar(0.05 + blink * 1.3);
      _dummy.updateMatrix();
      this.fireflies.setMatrixAt(i, _dummy.matrix);
    }
    this.fireflies.instanceMatrix.needsUpdate = true;

    // autumn leaves
    const wantLeaves = sim.season === 'Autumn' && sim.rainIntensity() < 0.6 && sim.weather !== 'Snow' ? 1 : 0;
    this.leafLevel += (wantLeaves - this.leafLevel) * 0.01;
    const nLeaf = Math.round(this.leafLevel * 60);
    this.autumnLeaves.count = nLeaf;
    const topW = groundW + 3.2;
    for (let i = 0; i < nLeaf; i++) {
      const cycle = (t * (0.035 + (i % 5) * 0.006) + i * 0.173) % 1;
      const bx = ctr + (((i * 61) % 100) / 100 - 0.5) * 22;
      const x = bx + Math.sin(t * 0.7 + i) * 0.45 + sim.windStrength * cycle * 1.2;
      const y = topW - cycle * 3.1;
      _dummy.position.set(x, y, 0.15 + (((i * 29) % 100) / 100) * 0.5);
      _dummy.rotation.set(t * 1.3 + i, t * 0.9 + i * 2, Math.sin(t + i) * 1.2);
      _dummy.scale.setScalar(1);
      _dummy.updateMatrix();
      this.autumnLeaves.setMatrixAt(i, _dummy.matrix);
    }
    this.autumnLeaves.instanceMatrix.needsUpdate = true;
    if (this.autumnLeaves.instanceColor) this.autumnLeaves.instanceColor.needsUpdate = true;
  }

  private syncCreatures(sim: AntColonySimulation): void {
    const alive = new Set<number>();
    for (const c of sim.creatures) {
      alive.add(c.id);
      let rig = this.creatureRigs.get(c.id);
      if (!rig) {
        rig = createCreatureRig(c.kind);
        this.scene.add(rig.root);
        this.creatureRigs.set(c.id, rig);
      }
      if (c.kind === 'worm' && rig.segs) {
        const tr = c.trail ?? [];
        for (let i = 0; i < rig.segs.length; i++) {
          const s = rig.segs[i];
          const pt = tr[Math.min(i, tr.length - 1)];
          s.visible = i < tr.length && !!pt;
          if (!pt) continue;
          const z = this.env3d.sampleCavernBackZ(sim, pt.x, pt.y) + 0.07;
          s.position.set(simToWorldX(pt.x), simToWorldY(pt.y) - 0.04 + Math.sin(sim.simTime * 4 + i * 0.9) * 0.012, z);
        }
        continue;
      }
      let wy = simToWorldY(c.y);
      const z = c.kind === 'bird' ? 0.5 : c.kind === 'anteater' ? 0.42 : c.kind === 'spider' ? 0.3 : c.kind === 'ladybug' ? 0.56 : SOIL_FRONT_Z + 0.03;
      if (c.kind === 'bird') {
        // a flying bird's body is centred on c.y; once it touches down its feet are on the ground
        const gW = simToWorldY(sim.grid.surfaceY[clamp(Math.floor(c.x / CELL_SIZE), 0, GRID_W - 1)]);
        const h = clamp((simToWorldY(c.y) - gW) / 0.8, 0, 1);
        wy -= 0.55 * h;
      }
      rig.root.position.set(simToWorldX(c.x), wy, z);
      const sc = c.kind === 'anteater' ? 0.8 : 1;
      rig.root.scale.set(c.dir * sc, sc, sc);
      if (c.kind === 'ladybug' || c.kind === 'anteater') {
        // follow the ground: tilt with the slope, and turn head-up when climbing a plant
        const ud = rig.root.userData as { px?: number; py?: number; ang?: number };
        const dx = (c.x - (ud.px ?? c.x)) * WORLD_SCALE;
        const dy = -(c.y - (ud.py ?? c.y)) * WORLD_SCALE;
        let ang = ud.ang ?? 0;
        if (Math.hypot(dx, dy) > 1e-4 && c.state !== 'flying' && c.state !== 'leaving') {
          const want = Math.atan2(dy * c.dir, Math.max(dx * c.dir, 0) + Math.abs(dy) * 0.0);
          ang += (clamp(want, -1.45, 1.45) - ang) * 0.12;
        } else if (c.state === 'flying' || c.state === 'leaving') ang *= 0.9;
        const stepped = Math.hypot(c.x - (ud.px ?? c.x), c.y - (ud.py ?? c.y));
        rig.walk += (stepped / (c.kind === 'ladybug' ? 7 : 22)) * Math.PI * 2;
        rig.moveAmp += ((stepped > 0.004 ? 1 : 0) - rig.moveAmp) * 0.2;
        ud.px = c.x;
        ud.py = c.y;
        ud.ang = ang;
        rig.root.rotation.z = ang * (c.kind === 'ladybug' ? 1 : 0.5);
      }
      animateCreatureRig(rig, c, sim.simTime);
    }
    for (const [id, rig] of this.creatureRigs) {
      if (alive.has(id)) continue;
      this.scene.remove(rig.root);
      disposeCreatureRig(rig);
      this.creatureRigs.delete(id);
    }
  }

  private focusKey = -1;

  /**
   * The zoomed-out view frames the sky above the ground, the surface and every chamber/tunnel (plus a margin), so
   * a big block of untouched soil never fills the screen. Recomputed only when the nest changes.
   */
  private updateCameraFocus(sim: AntColonySimulation): void {
    const ver = sim.grid.terrainVersion;
    if (ver === this.focusKey) return;
    this.focusKey = ver;
    let minGx = GRID_W;
    let maxGx = -1;
    let maxGy = -1;
    const t = sim.grid.terrain;
    for (let gy = 0; gy < GRID_H; gy++) {
      for (let gx = 0; gx < GRID_W; gx++) {
        if (t[gy * GRID_W + gx] !== CellType.TUNNEL) continue;
        if (gx < minGx) minGx = gx;
        if (gx > maxGx) maxGx = gx;
        if (gy > maxGy) maxGy = gy;
      }
    }
    const MARGIN = 70;
    const MIN_W = 520;
    let left = minGx * CELL_SIZE - MARGIN;
    let right = (maxGx + 1) * CELL_SIZE + MARGIN;
    let bottom = (maxGy + 1) * CELL_SIZE + MARGIN;
    if (maxGx < 0) {
      left = (CASE_LEFT + CASE_RIGHT) / 2 - MIN_W / 2;
      right = left + MIN_W;
      bottom = SURFACE_BASE_Y + 300;
    }
    if (right - left < MIN_W) {
      const c = (left + right) / 2;
      left = c - MIN_W / 2;
      right = c + MIN_W / 2;
    }
    let minSurf = SURFACE_BASE_Y;
    for (let gx = 0; gx < GRID_W; gx++) minSurf = Math.min(minSurf, sim.grid.surfaceY[gx]);
    const top = minSurf - 150; // a band of sky above the highest ground
    this.camCtl.setFocus({
      left: simToWorldX(left),
      right: simToWorldX(right),
      top: simToWorldY(top),
      bottom: simToWorldY(bottom),
    });
  }

  public resetCamera(): void {
    this.camCtl.reset();
  }

  /** A tap on empty sky or open ground above the surface drops food there (underground taps do nothing). */
  private dropFoodAt(lx: number, ly: number): boolean {
    const w = this.renderer.domElement.clientWidth || 1;
    const h = this.renderer.domElement.clientHeight || 1;
    this._ray.setFromCamera(new THREE.Vector2((lx / w) * 2 - 1, -(ly / h) * 2 + 1), this.camera);
    const hit = this._ray.ray.intersectPlane(this._plane, _pick);
    if (!hit) return false;
    const sx = _pick.x / WORLD_SCALE + WORLD_W * 0.5;
    const sy = WORLD_H * 0.5 - _pick.y / WORLD_SCALE;
    return this.sim.dropFoodFromTap(sx, sy);
  }

  /** Picks the ant drawn nearest a canvas-local pixel and starts following it. */
  private pickAnt(lx: number, ly: number): boolean {
    const w = this.renderer.domElement.clientWidth || 1;
    const h = this.renderer.domElement.clientHeight || 1;
    const radius = Math.max(28, Math.min(w, h) * 0.06);
    let best = -1;
    let bestD = radius * radius;
    for (const [id, rig] of this.antRigs) {
      _pick.copy(rig.root.position).project(this.camera);
      if (_pick.z > 1) continue;
      const px = (_pick.x * 0.5 + 0.5) * w;
      const py = (-_pick.y * 0.5 + 0.5) * h;
      const d = (px - lx) * (px - lx) + (py - ly) * (py - ly);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    if (best < 0) return false;
    this.camCtl.follow(best);
    return true;
  }

  public resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.camCtl.fit();
  }

  private updateLightingAndWeather(sim: AntColonySimulation): void {
    // Circadian cycle: 0..1 (0.25 dawn, 0.5 noon, 0.75 dusk, 0/1 midnight)
    const tod = sim.timeOfDay;
    const sunElev = Math.sin((tod - 0.2) * Math.PI * 2); // +1 noon, -1 midnight
    const dayFactor = clamp(sunElev * 0.85 + 0.35, 0, 1);
    const duskFactor = Math.exp(-Math.pow((tod - 0.72) * 8.5, 2)) + Math.exp(-Math.pow((tod - 0.22) * 8.5, 2));

    const sunAngle = (tod - 0.5) * Math.PI * 1.4;
    this.sunLight.position.set(
      Math.sin(sunAngle) * 16,
      8 + Math.max(0, sunElev) * 12,
      13
    );

    _sunTmp.copy(_sunNight).lerp(_sunDay, dayFactor).lerp(_sunDusk, clamp(duskFactor * 0.75, 0, 1));
    this.sunLight.color.copy(_sunTmp);

    // real cloud cover dims and greys the light; rain darkens it further; snow on the ground brightens the bounce
    const rain = sim.rainIntensity();
    const cloud = sim.climate.cloud;
    const weatherDim = clamp(1 - cloud * 0.38 - rain * 0.22 - (sim.weather === 'Fog' ? 0.15 : 0), 0.35, 1);
    // thunderstorms: occasional lightning flashes
    if (sim.weather === 'Thunderstorm' && this.lightningFlash <= 0 && Math.random() < 0.004) this.lightningFlash = 1;
    const flash = this.lightningFlash > 0 ? Math.max(0, this.lightningFlash) * (0.6 + 0.4 * Math.sin(this.lightningFlash * 40)) : 0;
    this.lightningFlash -= 0.06;
    this.sunLight.intensity = (0.35 + dayFactor * 2.1) * weatherDim * (1 - cloud * 0.35) + flash * 3;
    this.hemiLight.intensity = (0.32 + dayFactor * 0.58) * weatherDim + sim.snowCover * 0.25 * dayFactor + flash * 1.5;
    this.chamberLight.intensity = 1.55 - dayFactor * 0.45;

    _skyTmp.copy(_skyNight).lerp(_skyDay, dayFactor).lerp(_skyDusk, clamp(duskFactor * 0.65, 0, 1));
    _skyTmp.lerp(_skyOvercast, clamp(cloud * 0.45 * dayFactor, 0, 0.45));
    if (sim.weather === 'Fog') _skyTmp.lerp(_skyFog, 0.4);
    if (rain > 0) _skyTmp.lerp(_skyRain, clamp(rain * 0.45, 0, 0.5));
    if (sim.weather === 'Snow') _skyTmp.lerp(_skySnow, 0.3 * dayFactor + 0.1);
    if (flash > 0) _skyTmp.lerp(_skyFlash, clamp(flash, 0, 0.8));

    (this.scene.background as THREE.Color).copy(_skyTmp);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(_skyTmp);
      this.scene.fog.density =
        sim.weather === 'Fog' ? 0.024 : sim.weather === 'Snow' ? 0.017 : rain > 0 ? 0.011 + rain * 0.006 : 0.01;
    }
  }

  /**
   * Computes continuous 3D surface/wall/back-dome contact point and normal directly from
   * the smoothed Marching Squares contour and curved cavern mesh so critters walk and tilt fluidly.
   */
  private compute3DSurfaceTransform(
    sim: AntColonySimulation,
    sx: number,
    sy: number,
    angle2d: number,
    zLane: number,
    probeSimDist: number
  ): typeof _tfOut {
    const dirX = Math.cos(angle2d);
    const dirY = Math.sin(angle2d);

    this.env3d.sampleSurfaceContact(sim, sx, sy, zLane, _contactPos, _up);
    this.env3d.sampleSurfaceContact(
      sim,
      sx + dirX * probeSimDist,
      sy + dirY * probeSimDist,
      zLane,
      _posHead,
      _upHead
    );
    this.env3d.sampleSurfaceContact(
      sim,
      sx - dirX * probeSimDist,
      sy - dirY * probeSimDist,
      zLane,
      _posTail,
      _upTail
    );

    _avgUp
      .copy(_up)
      .multiplyScalar(0.66)
      .addScaledVector(_upHead, 0.17)
      .addScaledVector(_upTail, 0.17);
    if (_avgUp.lengthSq() < 1e-6) _avgUp.copy(_up);
    else _avgUp.normalize();

    const vx = dirX;
    const vy = -dirY;

    // Build orthonormal basis where +X = projected forward along surface, +Y = continuous normal, +Z = right.
    // Forward follows the *actual walking path over the surface* (head probe minus tail probe), not the flat 2D
    // heading: walking off a tunnel wall is heading along that wall's normal, which projects to nothing and used to
    // make ants spin as they went around the corner onto the back wall.
    _fwd.subVectors(_posHead, _posTail);
    if (_fwd.lengthSq() < 4e-4) _fwd.set(vx, vy, 0);
    const dot = _fwd.dot(_avgUp);
    _fwd.addScaledVector(_avgUp, -dot);

    if (_fwd.lengthSq() < 1e-4) {
      _fwd.set(0, 0, 1);
      const d2 = _fwd.dot(_avgUp);
      _fwd.addScaledVector(_avgUp, -d2);
      if (_fwd.lengthSq() < 1e-4) {
        _fwd.set(1, 0, 0);
        const d3 = _fwd.dot(_avgUp);
        _fwd.addScaledVector(_avgUp, -d3);
      }
    }
    _fwd.normalize();

    _right.crossVectors(_fwd, _avgUp).normalize();
    _basis.makeBasis(_fwd, _avgUp, _right);
    _targetQuat.setFromRotationMatrix(_basis);

    // Measure local curvature ahead (head) and behind (tail/gaster) in thorax local space
    _deltaVec.subVectors(_posHead, _contactPos);
    const headFwd = _deltaVec.dot(_fwd);
    const headUp = _deltaVec.dot(_avgUp);
    const headSide = _deltaVec.dot(_right);

    _deltaVec.subVectors(_posTail, _contactPos);
    const tailFwd = _deltaVec.dot(_fwd);
    const tailUp = _deltaVec.dot(_avgUp);
    const tailSide = _deltaVec.dot(_right);

    const headNormalPitch = Math.atan2(-_upHead.dot(_fwd), Math.max(0.05, _upHead.dot(_avgUp)));
    const headPosPitch = Math.atan2(headUp, Math.max(0.04, headFwd));
    const headPitch = clamp(headNormalPitch * 0.6 + headPosPitch * 0.4, -0.78, 0.78);

    const tailNormalPitch = Math.atan2(-_upTail.dot(_fwd), Math.max(0.05, _upTail.dot(_avgUp)));
    const tailPosPitch = Math.atan2(-tailUp, Math.max(0.04, -tailFwd));
    const tailPitch = clamp(tailNormalPitch * 0.6 + tailPosPitch * 0.4, -0.78, 0.78);

    const headYaw = clamp(
      -Math.atan2(headSide, Math.max(0.05, headFwd)) * 0.65 -
        Math.atan2(_upHead.dot(_right), Math.max(0.1, _upHead.dot(_avgUp))) * 0.35,
      -0.55,
      0.55
    );
    const tailYaw = clamp(
      Math.atan2(tailSide, Math.max(0.05, -tailFwd)) * 0.65 +
        Math.atan2(_upTail.dot(_right), Math.max(0.1, _upTail.dot(_avgUp))) * 0.35,
      -0.55,
      0.55
    );

    const bodyDip = clamp(0.22 * (headUp + tailUp), -0.02, 0.015);

    _tfOut.x = _contactPos.x;
    _tfOut.y = _contactPos.y;
    _tfOut.z = _contactPos.z;
    _tfOut.quat = _targetQuat;
    _tfOut.headPitch = headPitch;
    _tfOut.tailPitch = tailPitch;
    _tfOut.headYaw = headYaw;
    _tfOut.tailYaw = tailYaw;
    _tfOut.headUp = headUp;
    _tfOut.tailUp = tailUp;
    _tfOut.headSide = headSide;
    _tfOut.tailSide = tailSide;
    _tfOut.bodyDip = bodyDip;
    // 3D length of the surface chord head->tail over the 2D distance it spans: >1 around corners / on steep faces
    _tfOut.stretch = _posHead.distanceTo(_posTail) / Math.max(1e-6, 2 * probeSimDist * WORLD_SCALE);
    return _tfOut;
  }

  private syncAnts(sim: AntColonySimulation, dt: number): void {
    const activeIds = new Set<number>();
    const rotBlend = Math.min(1, 1 - Math.exp(-8.5 * dt));
    const posBlend = Math.min(1, 1 - Math.exp(-16 * dt));
    const flexBlend = Math.min(1, 1 - Math.exp(-11 * dt));

    for (const list of this.dodgeBuckets.values()) list.length = 0;
    for (let i = 0; i < sim.ants.length; i++) {
      const a = sim.ants[i];
      const key = Math.floor(a.y / 10) * 1000 + Math.floor(a.x / 10);
      let list = this.dodgeBuckets.get(key);
      if (!list) {
        list = [];
        this.dodgeBuckets.set(key, list);
      }
      list.push(i);
    }

    for (const ant of sim.ants) {
      activeIds.add(ant.id);
      let rig = this.antRigs.get(ant.id);
      if (!rig || rig.caste !== ant.caste) {
        const prev = rig;
        if (prev) this.rigMeshes.delete(prev);
        rig = createAntRig(ant.caste, ant.isCallow, this.bank, this.geo);
        rig.zLane = ((ant.id * 37) % 100) / 100 * 0.42 + 0.02;
        if (prev && prev.hasInitPos) {
          // a worker switching jobs keeps its place and pose
          rig.smoothPos.copy(prev.smoothPos);
          rig.hasInitPos = true;
          rig.currentQuat.copy(prev.currentQuat);
          rig.hasInitOrientation = true;
          rig.prevWorldPos.copy(prev.prevWorldPos);
        }
        this.antRigs.set(ant.id, rig);
        this.rigMeshes.set(rig, collectMeshes(rig.root));
      }

      const probeDist =
        ant.caste === AntCaste.QUEEN ? 9.5 : ant.caste === AntCaste.SOLDIER ? 7.5 : 5.8;
      // Subtle dynamic Z-passing dodge when sharing tight 2D coordinates with nearby bugs
      let zDodge = 0;
      const hx0 = Math.floor(ant.x / 10);
      const hy0 = Math.floor(ant.y / 10);
      for (let hy = hy0 - 1; hy <= hy0 + 1; hy++) {
        for (let hx = hx0 - 1; hx <= hx0 + 1; hx++) {
          const bucket = this.dodgeBuckets.get(hy * 1000 + hx);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const o = sim.ants[bucket[k]];
            if (o.id === ant.id || Math.abs(o.x - ant.x) >= 10 || Math.abs(o.y - ant.y) >= 10) continue;
            const oRig = this.antRigs.get(o.id);
            const oz = oRig ? oRig.zLane : 0.22;
            if (Math.abs(rig.zLane - oz) < 0.12) zDodge += ant.id < o.id ? -0.045 : 0.045;
          }
        }
      }
      if (ant.flying) {
        // airborne alate: free flight through the case, body along the direction of travel
        _targetPos.set(simToWorldX(ant.x), simToWorldY(ant.y), 0.3);
        rig.smoothPos.lerp(_targetPos, posBlend);
        rig.root.position.copy(rig.smoothPos);
        _flyEuler.set(0, 0, -ant.angle);
        rig.root.quaternion.setFromEuler(_flyEuler);
        rig.currentQuat.copy(rig.root.quaternion);
        rig.prevWorldPos.copy(rig.smoothPos);
        // legs hang beneath the body: solve them against an imaginary floor just under the ant
        rig.worldVel.set(0, 0, 0);
        animateAntRig(rig, ant, sim.simTime, this.bank, dt, rig.worldVel, this.airGround);
        rig.root.updateMatrixWorld(true);
        this.batcher.addAll(this.rigMeshes.get(rig)!);
        continue;
      }
      const effectiveZ = clamp(rig.zLane + zDodge, 0.03, 0.44);
      const tf = this.compute3DSurfaceTransform(sim, clamp(ant.x, EDGE_L, EDGE_R), ant.y, ant.angle, effectiveZ, probeDist);
      _targetPos.set(tf.x, tf.y, tf.z);
      if (ant.carriedById != null) _targetPos.y += 0.05; // lifted off the ground in a nestmate's jaws

      let justSnapped = false;
      if (!rig.hasInitPos || rig.smoothPos.distanceToSquared(_targetPos) > 2.25) {
        rig.smoothPos.copy(_targetPos);
        rig.hasInitPos = true;
        justSnapped = true;
      } else {
        rig.smoothPos.lerp(_targetPos, posBlend);
      }
      rig.root.position.copy(rig.smoothPos);

      // How much longer the 3D route over the surface is than the 2D sim step that produced it (>1 when rolling
      // around a tunnel corner onto the back wall, or climbing steeply). Measured from the geometry just ahead and
      // behind the ant, so it reacts before the ant reaches the corner. The sim slows the ant by this factor so it
      // walks the longer route at a natural pace instead of rocketing around the corner.
      const targetStretch = justSnapped ? 1 : clamp(tf.stretch, 1, 4);
      rig.stretch += (targetStretch - rig.stretch) * Math.min(1, dt * 20);
      ant.surfaceStretch = rig.stretch;

      // Body world velocity (low-passed) drives stride length / swing speed of the planted-foot leg solver.
      if (justSnapped) {
        rig.worldVel.set(0, 0, 0);
        resetLegs(rig.legSet);
      } else if (dt > 1e-4) {
        _deltaVec.subVectors(rig.smoothPos, rig.prevWorldPos).multiplyScalar(1 / dt);
        rig.worldVel.lerp(_deltaVec, Math.min(1, dt * 14));
      }
      rig.prevWorldPos.copy(rig.smoothPos);

      if (!rig.hasInitOrientation) {
        rig.currentQuat.copy(tf.quat);
        rig.hasInitOrientation = true;
      } else {
        rig.currentQuat.slerp(tf.quat, rotBlend);
      }
      rig.root.quaternion.copy(rig.currentQuat);

      rig.smoothHeadPitch += (tf.headPitch - rig.smoothHeadPitch) * flexBlend;
      rig.smoothTailPitch += (tf.tailPitch - rig.smoothTailPitch) * flexBlend;
      rig.smoothHeadYaw += (tf.headYaw - rig.smoothHeadYaw) * flexBlend;
      rig.smoothTailYaw += (tf.tailYaw - rig.smoothTailYaw) * flexBlend;
      rig.smoothBodyDip += (tf.bodyDip - rig.smoothBodyDip) * flexBlend;

      this.groundSim = sim;
      animateAntRig(rig, ant, sim.simTime, this.bank, dt, rig.worldVel, this.sampleGround);
      rig.root.updateMatrixWorld(true);
      this.batcher.addAll(this.rigMeshes.get(rig)!);
    }

    for (const [id, rig] of this.antRigs) {
      if (!activeIds.has(id)) {
        this.rigMeshes.delete(rig);
        this.antRigs.delete(id);
      }
    }
  }

  private syncIntruders(sim: AntColonySimulation, dt: number): void {
    const activeIds = new Set<number>();
    const rotBlend = Math.min(1, 1 - Math.exp(-8.0 * dt));
    const posBlend = Math.min(1, 1 - Math.exp(-15 * dt));
    const flexBlend = Math.min(1, 1 - Math.exp(-11 * dt));

    for (const m of sim.intruders) {
      activeIds.add(m.id);
      let rig = this.intruderRigs.get(m.id);
      if (!rig || rig.species !== m.species) {
        if (rig) this.rigMeshes.delete(rig);
        rig = createIntruderRig(m.species, this.bank, this.geo);
        rig.zLane = ((m.id * 53) % 100) / 100 * 0.36 + 0.05;
        this.intruderRigs.set(m.id, rig);
        this.rigMeshes.set(rig, collectMeshes(rig.root));
      }

      const probeDist =
        m.species === 'centipede'
          ? 11.5
          : m.species === 'earwig'
          ? 9.0
          : m.species === 'beetle'
          ? 8.0
          : m.species === 'rival_ant'
          ? 6.2
          : 4.5;
      let zDodge = 0;
      for (let j = 0; j < sim.intruders.length; j++) {
        const o = sim.intruders[j];
        if (o.id === m.id) continue;
        if (Math.abs(o.x - m.x) < 14 && Math.abs(o.y - m.y) < 14) {
          const oRig = this.intruderRigs.get(o.id);
          const oz = oRig ? oRig.zLane : 0.22;
          if (Math.abs(rig.zLane - oz) < 0.14) {
            zDodge += m.id < o.id ? -0.06 : 0.06;
          }
        }
      }
      const effectiveZ = clamp(rig.zLane + zDodge, 0.04, 0.43);
      const tf = this.compute3DSurfaceTransform(sim, clamp(m.x, EDGE_L, EDGE_R), m.y, m.angle, effectiveZ, probeDist);
      _targetPos.set(tf.x, tf.y, tf.z);

      if (!rig.hasInitPos || rig.smoothPos.distanceToSquared(_targetPos) > 2.25) {
        rig.smoothPos.copy(_targetPos);
        rig.hasInitPos = true;
      } else {
        rig.smoothPos.lerp(_targetPos, posBlend);
      }
      rig.root.position.copy(rig.smoothPos);

      if (!rig.hasInitOrientation) {
        rig.currentQuat.copy(tf.quat);
        rig.hasInitOrientation = true;
      } else {
        rig.currentQuat.slerp(tf.quat, rotBlend);
      }
      rig.root.quaternion.copy(rig.currentQuat);

      rig.smoothHeadPitch += (tf.headPitch - rig.smoothHeadPitch) * flexBlend;
      rig.smoothTailPitch += (tf.tailPitch - rig.smoothTailPitch) * flexBlend;
      rig.smoothHeadYaw += (tf.headYaw - rig.smoothHeadYaw) * flexBlend;
      rig.smoothTailYaw += (tf.tailYaw - rig.smoothTailYaw) * flexBlend;
      rig.smoothHeadY += (tf.headUp - rig.smoothHeadY) * flexBlend;
      rig.smoothTailY += (tf.tailUp - rig.smoothTailY) * flexBlend;
      rig.smoothHeadZ += (tf.headSide - rig.smoothHeadZ) * flexBlend;
      rig.smoothTailZ += (tf.tailSide - rig.smoothTailZ) * flexBlend;
      rig.smoothBodyDip += (tf.bodyDip - rig.smoothBodyDip) * flexBlend;

      animateIntruderRig(rig, m, sim.simTime);
      rig.root.updateMatrixWorld(true);
      this.batcher.addAll(this.rigMeshes.get(rig)!);
    }

    for (const [id, rig] of this.intruderRigs) {
      if (!activeIds.has(id)) {
        this.rigMeshes.delete(rig);
        this.intruderRigs.delete(id);
      }
    }
  }

  private syncInstancedEntities(sim: AntColonySimulation): void {
    // 1. Brood (Eggs, Larvae, Pupae)
    let eggC = 0;
    let larvaC = 0;
    let pupaC = 0;
    for (const b of sim.brood) {
      if (b.carriedByAntId !== null) continue;
      const bx = clamp(b.x, EDGE_L, EDGE_R);
      const z = Math.max(this.env3d.sampleCavernBackZ(sim, bx, b.y) + 0.03, 0.14 + Math.sin(b.id * 1.7) * 0.18);
      _dummy.position.set(simToWorldX(bx), simToWorldY(b.y) - 0.015, z);
      if (b.stage === BroodStage.EGG && eggC < 90) {
        _dummy.rotation.set(0, b.id * 0.8, Math.sin(b.wigglePhase) * 0.1);
        _dummy.scale.set(1.15, 0.72, 0.72);
        _dummy.updateMatrix();
        this.eggMesh.setMatrixAt(eggC++, _dummy.matrix);
      } else if (b.stage === BroodStage.LARVA && larvaC < 90) {
        const ls = 0.85 + (b.progress / 100) * 0.48;
        const wiggle = Math.sin(b.wigglePhase);
        _dummy.rotation.set(0.18, (b.id * 1.37) % (Math.PI * 2), wiggle * 0.14);
        _dummy.scale.set(ls + wiggle * 0.05, ls * (1 - wiggle * 0.04), ls);
        _dummy.updateMatrix();
        this.larvaMesh.setMatrixAt(larvaC++, _dummy.matrix);
      } else if (b.stage === BroodStage.PUPA && pupaC < 90) {
        _dummy.rotation.set(0, b.id * 0.8, Math.sin(b.wigglePhase) * 0.08);
        _dummy.scale.set(1.28, 0.76, 0.76);
        _dummy.updateMatrix();
        this.pupaMesh.setMatrixAt(pupaC++, _dummy.matrix);
      }
    }
    this.eggMesh.count = eggC;
    this.larvaMesh.count = larvaC;
    this.pupaMesh.count = pupaC;
    this.eggMesh.instanceMatrix.needsUpdate = true;
    this.larvaMesh.instanceMatrix.needsUpdate = true;
    this.pupaMesh.instanceMatrix.needsUpdate = true;

    // 2. Foods (Seeds, Honeydew, Protein, Fungus)
    let seedC = 0;
    let honeyC = 0;
    let proteinC = 0;
    let fungusC = 0;
    for (const f of sim.foods) {
      const s = f.large ? 2.6 : 0.55 + (f.amount / Math.max(1, f.maxAmount)) * 0.65;
      let z = 0.12 + Math.sin(f.id * 2.1) * 0.2;
      if (f.storedInChamberId !== null) {
        z = Math.max(this.env3d.sampleCavernBackZ(sim, f.x, f.y) + 0.03, z);
      }
      _dummy.position.set(simToWorldX(f.x), simToWorldY(f.y) - 0.015, z);
      _dummy.rotation.set(f.id * 0.5, f.id * 1.1, f.falling ? sim.simTime * 2 : 0);
      _dummy.scale.set(s * 1.08, s * 0.78, s * 0.92);
      _dummy.updateMatrix();

      if (f.type === PayloadType.SEED && seedC < 80) {
        this.seedMesh.setMatrixAt(seedC++, _dummy.matrix);
      } else if (f.type === PayloadType.HONEYDEW && honeyC < 60) {
        this.honeyMesh.setMatrixAt(honeyC++, _dummy.matrix);
      } else if (f.type === PayloadType.PROTEIN && proteinC < 60) {
        this.proteinMesh.setMatrixAt(proteinC++, _dummy.matrix);
      } else if (f.type === PayloadType.FUNGUS && fungusC < 60) {
        this.fungusMesh.setMatrixAt(fungusC++, _dummy.matrix);
      }
    }
    this.seedMesh.count = seedC;
    this.honeyMesh.count = honeyC;
    this.proteinMesh.count = proteinC;
    this.fungusMesh.count = fungusC;
    this.seedMesh.instanceMatrix.needsUpdate = true;
    this.honeyMesh.instanceMatrix.needsUpdate = true;
    this.proteinMesh.instanceMatrix.needsUpdate = true;
    this.fungusMesh.instanceMatrix.needsUpdate = true;

    // 3. Rain & Dew Droplets + Falling Rain Streaks
    let dropC = 0;
    let rainC = 0;
    for (const d of sim.droplets) {
      const z = 0.1 + Math.sin(d.id * 3.1) * 0.36;
      if (!d.settled && rainC < 220) {
        _dummy.position.set(simToWorldX(d.x), simToWorldY(d.y), z);
        _dummy.rotation.set(0, 0, -sim.windStrength * 0.08);
        _dummy.scale.setScalar(1);
        _dummy.updateMatrix();
        this.rainMesh.setMatrixAt(rainC++, _dummy.matrix);
      } else if (d.settled && dropC < 140) {
        const r = Math.max(0.45, d.radius * 0.35);
        _dummy.position.set(simToWorldX(d.x), simToWorldY(d.y) - 0.02, z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(r * 1.3, r * 0.65, r * 1.3);
        _dummy.updateMatrix();
        this.dropletMesh.setMatrixAt(dropC++, _dummy.matrix);
      }
    }
    this.dropletMesh.count = dropC;
    this.rainMesh.count = rainC;
    this.dropletMesh.instanceMatrix.needsUpdate = true;
    this.rainMesh.instanceMatrix.needsUpdate = true;

    // 4. Fallen Ants
    let fallenC = 0;
    for (const fa of sim.fallenAnts) {
      if (fa.carriedByAntId !== null || fallenC >= 40) continue;
      _dummy.position.set(simToWorldX(fa.x), simToWorldY(fa.y) - 0.015, 0.12 + Math.sin(fa.id * 1.9) * 0.14);
      _dummy.rotation.set(0.2, fa.angle, 0.15);
      _dummy.scale.setScalar(1.0);
      _dummy.updateMatrix();
      this.fallenMesh.setMatrixAt(fallenC++, _dummy.matrix);
    }
    this.fallenMesh.count = fallenC;
    this.fallenMesh.instanceMatrix.needsUpdate = true;

    // 5. Particles (dust motes, excavation crumbs, combat sparks)
    let dustC = 0;
    let crumbC = 0;
    let snowC = 0;
    let sparkC = 0;
    for (let i = 0; i < sim.particles.length; i++) {
      const p = sim.particles[i];
      const z = 0.1 + Math.sin(i * 2.7) * 0.42;
      _dummy.position.set(simToWorldX(p.x), simToWorldY(p.y), z);
      _dummy.rotation.set(i, sim.simTime + i, 0);
      if (p.kind === 'dust' && dustC < 140) {
        _dummy.scale.setScalar(0.55 + p.size * 0.35);
        _dummy.updateMatrix();
        this.dustMesh.setMatrixAt(dustC++, _dummy.matrix);
      } else if (p.kind === 'crumb' && crumbC < 120) {
        _dummy.scale.setScalar(0.65 + p.size * 0.3);
        _dummy.updateMatrix();
        this.crumbMesh.setMatrixAt(crumbC++, _dummy.matrix);
      } else if (p.kind === 'snow' && snowC < 220) {
        _dummy.scale.setScalar(0.7 + p.size * 0.4);
        _dummy.updateMatrix();
        this.snowMesh.setMatrixAt(snowC++, _dummy.matrix);
      } else if ((p.kind === 'spark' || p.kind === 'mist') && sparkC < 80) {
        const s = (1 - p.life / Math.max(0.01, p.maxLife)) * 1.1;
        _dummy.scale.setScalar(Math.max(0.05, s));
        _dummy.updateMatrix();
        this.sparkMesh.setMatrixAt(sparkC++, _dummy.matrix);
      }
    }
    this.dustMesh.count = dustC;
    this.crumbMesh.count = crumbC;
    this.sparkMesh.count = sparkC;
    this.snowMesh.count = snowC;
    this.snowMesh.instanceMatrix.needsUpdate = true;
    this.syncWeatherEntities(sim);
    this.dustMesh.instanceMatrix.needsUpdate = true;
    this.crumbMesh.instanceMatrix.needsUpdate = true;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Snow lying on the ground: a smooth ribbon that follows the same smoothed contour the soil mesh is built from,
   * with a soft rounded lip at the front glass. Thickness grows with the snow cover and drifts a little.
   */
  private updateSnowBlanket(sim: AntColonySimulation): void {
    const cover = sim.snowCover;
    if (cover < 0.02) {
      this.snowCapMesh.visible = false;
      this.snowKey = '';
      return;
    }
    const key = `${this.env3d.fieldVersion}:${Math.round(cover * 40)}`;
    this.snowCapMesh.visible = true;
    if (key === this.snowKey) return;
    this.snowKey = key;

    const STEP = 3;
    const x0 = CASE_LEFT + 2;
    const n = Math.floor((CASE_RIGHT - 2 - x0) / STEP) + 1;
    const ys = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      const sx = x0 + j * STEP;
      const gx = clamp(Math.floor(sx / CELL_SIZE), 0, GRID_W - 1);
      ys[j] = this.env3d.groundYAt(sx, sim.grid.surfaceY[gx] + CELL_SIZE * 2.5);
    }
    // lightly smooth what we found, never across a gap (entrance holes stay open)
    const sm = new Float32Array(n);
    for (let j = 0; j < n; j++) {
      if (Number.isNaN(ys[j])) {
        sm[j] = NaN;
        continue;
      }
      let sum = 0;
      let w = 0;
      for (let k = -2; k <= 2; k++) {
        const v = ys[j + k];
        if (v === undefined || Number.isNaN(v)) continue;
        const wk = 3 - Math.abs(k);
        sum += v * wk;
        w += wk;
      }
      sm[j] = sum / w;
    }

    const zBack = SOIL_BACK_Z + 0.02;
    const zFront = SOIL_FRONT_Z;
    const base = 0.012 + cover * 0.07;
    const pos: number[] = [];
    const idx: number[] = [];
    const ROW = 5;
    let prevValid = false;
    for (let j = 0; j < n; j++) {
      const sy = sm[j];
      const valid = !Number.isNaN(sy);
      // drift: thickness wanders gently, and thins toward the edges of a gap
      const edge = valid && (Number.isNaN(sm[j - 1] ?? NaN) || Number.isNaN(sm[j + 1] ?? NaN)) ? 0.35 : 1;
      const th = base * edge * (0.85 + 0.15 * Math.sin(j * 0.37) + 0.08 * Math.sin(j * 1.31));
      const x = simToWorldX(x0 + j * STEP);
      const y = valid ? simToWorldY(sy) : 0;
      // back edge, top, start of the rounded front lip, lip, bottom of the lip against the glass
      pos.push(x, y + th * 0.8, zBack);
      pos.push(x, y + th, zBack + (zFront - zBack) * 0.3);
      pos.push(x, y + th * 0.96, zFront - 0.05);
      pos.push(x, y + th * 0.55, zFront + 0.012);
      pos.push(x, y - 0.012, zFront + 0.016);
      if (valid && prevValid) {
        const a = (j - 1) * ROW;
        const b = j * ROW;
        for (let r = 0; r < ROW - 1; r++) idx.push(a + r, b + r, a + r + 1, a + r + 1, b + r, b + r + 1);
      }
      prevValid = valid;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    this.snowCapMesh.geometry.dispose();
    this.snowCapMesh.geometry = g;
  }

  /** Snow lying on the ground, floodwater in the tunnels, aphids on the plants, trail debris. */
  private syncWeatherEntities(sim: AntColonySimulation): void {
    this.updateSnowBlanket(sim);

    // floodwater fills open cells below the water line (rebuilt only when the level or the nest changes)
    const key = sim.floodDepth > 0.5 ? `${Math.round(sim.floodDepth)}:${sim.grid.terrainVersion}` : '';
    if (key !== this.floodKey) {
      this.floodKey = key;
      let fc = 0;
      if (key) {
        const lineGy = Math.floor(sim.floodLineY() / CELL_SIZE);
        for (let gy = Math.max(0, lineGy); gy < GRID_H && fc < 1600; gy++) {
          for (let gx = 0; gx < GRID_W && fc < 1600; gx++) {
            if (sim.grid.terrain[gy * GRID_W + gx] !== CellType.TUNNEL) continue;
            _dummy.position.set(simToWorldX((gx + 0.5) * CELL_SIZE), simToWorldY((gy + 0.5) * CELL_SIZE), 0.17);
            _dummy.rotation.set(0, 0, 0);
            _dummy.scale.setScalar(1);
            _dummy.updateMatrix();
            this.floodMesh.setMatrixAt(fc++, _dummy.matrix);
          }
        }
      }
      this.floodMesh.count = fc;
      this.floodMesh.instanceMatrix.needsUpdate = true;
    }

    let aphC = 0;
    for (const a of sim.aphids) {
      if (aphC >= 60) break;
      _dummy.position.set(simToWorldX(a.x), simToWorldY(a.y), 0.12 + Math.sin(a.id * 1.3) * 0.2);
      _dummy.rotation.set(0, a.id, Math.sin(a.phase * 2) * 0.1);
      const fat = 0.8 + (a.honeydew / 12) * 0.45;
      _dummy.scale.set(1.25 * fat, 0.85 * fat, 0.9 * fat);
      _dummy.updateMatrix();
      this.aphidMesh.setMatrixAt(aphC++, _dummy.matrix);
    }
    this.aphidMesh.count = aphC;
    this.aphidMesh.instanceMatrix.needsUpdate = true;

    let debC = 0;
    for (const d of sim.debris) {
      if (debC >= 16 || d.carriedById != null) continue;
      _dummy.position.set(simToWorldX(d.x), simToWorldY(d.y), 0.1 + Math.sin(d.id * 2.3) * 0.2);
      _dummy.rotation.set(d.id, d.id * 0.7, 0);
      _dummy.scale.set(d.size * 1.4, d.size * 0.6, d.size);
      _dummy.updateMatrix();
      this.debrisMesh.setMatrixAt(debC++, _dummy.matrix);
    }
    this.debrisMesh.count = debC;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
  }

  public render(sim: AntColonySimulation, dt: number): void {
    if (this.disposed) return;

    let followPos: THREE.Vector3 | null = null;
    if (this.camCtl.followId !== null) {
      const ant = sim.ants.find((a) => a.id === this.camCtl.followId);
      if (ant) {
        const rig = this.antRigs.get(ant.id);
        followPos = rig && rig.hasInitPos ? rig.root.position : _pick.set(simToWorldX(ant.x), simToWorldY(ant.y), 0.2);
      }
    }
    this.camCtl.update(dt, followPos);
    // the ground trembles when tunnels cave in or something heavy walks overhead
    if (sim.shake > 0.01) {
      const k = sim.shake * sim.shake * 0.05;
      this.camera.position.x += (Math.random() - 0.5) * k;
      this.camera.position.y += (Math.random() - 0.5) * k;
    }

    // Wind sway on 3D surface sprouts + keep seated on growing entrance mounds
    const keepSproutsSeated = sim.grid.dirtVisualDirty;
    for (let i = 0; i < this.sproutMeshes.length; i++) {
      const sp = this.sproutMeshes[i];
      if (keepSproutsSeated) {
        const simX = sp.baseX / WORLD_SCALE + 720;
        const gx = clamp(Math.floor(simX / CELL_SIZE), 0, GRID_W - 1);
        sp.mesh.position.y = simToWorldY(sim.grid.surfaceY[gx]);
      }
      const cut = sim.sprouts[i]?.cut ?? 0;
      const vigor = sim.season === 'Summer' ? 1.05 : sim.season === 'Spring' ? 0.85 : sim.season === 'Autumn' ? 0.72 : 0.45;
      sp.mesh.scale.y += ((1 - cut * 0.45) * vigor - sp.mesh.scale.y) * 0.04;
      sp.mesh.rotation.z =
        Math.sin(sim.simTime * 2.1 + sp.phase) * (0.045 + Math.abs(sim.windStrength) * 0.06);
    }

    this.env3d.update(sim, sim.simTime);
    this.updateCameraFocus(sim);
    this.updateLightingAndWeather(sim);
    this.batcher.begin();
    this.syncAnts(sim, dt);
    this.syncIntruders(sim, dt);
    this.batcher.end();
    this.syncInstancedEntities(sim);
    this.syncCreatures(sim);
    this.syncSky(sim);

    this.renderer.render(this.scene, this.camera);
  }

  public dispose(): void {
    this.disposed = true;
    this.camCtl.dispose();
    this.snowCapMesh.geometry.dispose();
    this.batcher.dispose();
    for (const rig of this.creatureRigs.values()) disposeCreatureRig(rig);
    this.env3d.dispose();
    this.geo.dispose();
    this.bank.dispose();
    this.envMapTex.dispose();
    for (const g of this.instancedGeos) g.dispose();
    for (const m of this.extraMats) m.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
