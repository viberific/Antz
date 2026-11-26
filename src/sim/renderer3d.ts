import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { AntColonySimulation } from './colony';
import {
  MaterialBank,
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
import {
  AntCaste,
  BroodStage,
  CELL_SIZE,
  GRID_W,
  PayloadType,
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
const _tfOut = {
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
const _skyDay = new THREE.Color(0x162231);
const _skyDusk = new THREE.Color(0x281822);
const _skyNight = new THREE.Color(0x06080d);
const _skyTmp = new THREE.Color();
const _sunDay = new THREE.Color(0xfff1d6);
const _sunDusk = new THREE.Color(0xff9c5a);
const _sunNight = new THREE.Color(0x6d8cc4);
const _sunTmp = new THREE.Color();

const HERO_CAM_POS = new THREE.Vector3(0.7, 1.8, 20.8);
const HERO_TARGET = new THREE.Vector3(0, -0.35, 0.14);

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export class Formicarium3DRenderer {
  public readonly isSoftwareGl: boolean;
  public readonly renderer: THREE.WebGLRenderer;
  public readonly scene: THREE.Scene;
  public readonly camera: THREE.PerspectiveCamera;
  public readonly controls: OrbitControls;

  private readonly container: HTMLElement;
  private readonly bank: MaterialBank;
  private readonly geo: GeometryBank;
  private readonly env3d: FormicariumEnvironment3D;
  private readonly envMapTex: THREE.Texture;

  private readonly sunLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly hemiLight: THREE.HemisphereLight;
  private readonly chamberLight: THREE.PointLight;

  private readonly antRigs = new Map<number, AntRig>();
  private readonly intruderRigs = new Map<number, IntruderRig>();
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

  private resettingCamera = false;
  private disposed = false;

  constructor(container: HTMLElement, sim: AntColonySimulation) {
    this.container = container;
    this.isSoftwareGl = detectSoftwareWebGL();

    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isSoftwareGl,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.setPixelRatio(this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio, 2));
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
    this.camera.position.copy(HERO_CAM_POS);

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

    const dustMat = new THREE.MeshBasicMaterial({ color: 0xf7e7c4, transparent: true, opacity: 0.42 });
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
    this.dustMesh = makeInst(new THREE.IcosahedronGeometry(0.032, 0), dustMat, 140, false);
    this.rainMesh = makeInst(new THREE.BoxGeometry(0.014, 0.24, 0.014), rainMat, 120, false);
    this.crumbMesh = makeInst(new THREE.SphereGeometry(0.036, 6, 4), this.bank.soilCrumbMat, 120, false);
    this.sparkMesh = makeInst(new THREE.IcosahedronGeometry(0.038, 0), sparkMat, 80, false);

    // OrbitControls: Pinch-to-zoom, 2-finger pan, right-drag pan, left-drag 3D orbit
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.copy(HERO_TARGET);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.075;
    this.controls.enableRotate = true;
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.zoomSpeed = 1.05;
    this.controls.panSpeed = 0.85;
    this.controls.rotateSpeed = 0.65;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 4.2;
    this.controls.maxDistance = 38.0;
    this.controls.minAzimuthAngle = -Math.PI * 0.3;
    this.controls.maxAzimuthAngle = Math.PI * 0.3;
    this.controls.minPolarAngle = Math.PI * 0.28;
    this.controls.maxPolarAngle = Math.PI * 0.64;
    this.controls.touches = {
      ONE: THREE.TOUCH.ROTATE,
      TWO: THREE.TOUCH.DOLLY_PAN,
    };

    this.controls.addEventListener('start', () => {
      this.resettingCamera = false;
    });

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }
  }

  public resetCamera(): void {
    this.resettingCamera = true;
  }

  public resize(): void {
    if (this.disposed) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
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

    const weatherDim = sim.weather === 'Light Rain' ? 0.65 : sim.weather === 'Misty' ? 0.8 : 1.0;
    this.sunLight.intensity = (0.35 + dayFactor * 2.1) * weatherDim;
    this.hemiLight.intensity = (0.32 + dayFactor * 0.58) * weatherDim;
    this.chamberLight.intensity = 1.55 - dayFactor * 0.45;

    _skyTmp.copy(_skyNight).lerp(_skyDay, dayFactor).lerp(_skyDusk, clamp(duskFactor * 0.65, 0, 1));
    if (sim.weather === 'Misty') _skyTmp.lerp(new THREE.Color(0x283545), 0.35);
    if (sim.weather === 'Light Rain') _skyTmp.lerp(new THREE.Color(0x131d29), 0.45);

    (this.scene.background as THREE.Color).copy(_skyTmp);
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.copy(_skyTmp);
      this.scene.fog.density = sim.weather === 'Misty' ? 0.019 : sim.weather === 'Light Rain' ? 0.015 : 0.01;
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

    // Build orthonormal basis where +X = projected forward along surface, +Y = continuous normal, +Z = right
    _fwd.set(vx, vy, 0);
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
    return _tfOut;
  }

  private syncAnts(sim: AntColonySimulation, dt: number): void {
    const activeIds = new Set<number>();
    const rotBlend = Math.min(1, 1 - Math.exp(-8.5 * dt));
    const posBlend = Math.min(1, 1 - Math.exp(-16 * dt));
    const flexBlend = Math.min(1, 1 - Math.exp(-11 * dt));

    for (const ant of sim.ants) {
      activeIds.add(ant.id);
      let rig = this.antRigs.get(ant.id);
      if (!rig || rig.caste !== ant.caste) {
        if (rig) this.scene.remove(rig.root);
        rig = createAntRig(ant.caste, ant.isCallow, this.bank, this.geo);
        rig.zLane = ((ant.id * 37) % 100) / 100 * 0.42 + 0.02;
        this.antRigs.set(ant.id, rig);
        this.scene.add(rig.root);
      }

      const probeDist =
        ant.caste === AntCaste.QUEEN ? 9.5 : ant.caste === AntCaste.SOLDIER ? 7.5 : 5.8;
      // Subtle dynamic Z-passing dodge when sharing tight 2D coordinates with nearby bugs
      let zDodge = 0;
      for (let j = 0; j < sim.ants.length; j++) {
        const o = sim.ants[j];
        if (o.id === ant.id) continue;
        if (Math.abs(o.x - ant.x) < 10 && Math.abs(o.y - ant.y) < 10) {
          const oRig = this.antRigs.get(o.id);
          const oz = oRig ? oRig.zLane : 0.22;
          if (Math.abs(rig.zLane - oz) < 0.12) {
            zDodge += ant.id < o.id ? -0.045 : 0.045;
          }
        }
      }
      const effectiveZ = clamp(rig.zLane + zDodge, 0.03, 0.44);
      const tf = this.compute3DSurfaceTransform(sim, ant.x, ant.y, ant.angle, effectiveZ, probeDist);
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
      rig.smoothBodyDip += (tf.bodyDip - rig.smoothBodyDip) * flexBlend;

      animateAntRig(rig, ant, sim.simTime, this.bank);
    }

    for (const [id, rig] of this.antRigs) {
      if (!activeIds.has(id)) {
        this.scene.remove(rig.root);
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
        if (rig) this.scene.remove(rig.root);
        rig = createIntruderRig(m.species, this.bank, this.geo);
        rig.zLane = ((m.id * 53) % 100) / 100 * 0.36 + 0.05;
        this.intruderRigs.set(m.id, rig);
        this.scene.add(rig.root);
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
      const tf = this.compute3DSurfaceTransform(sim, m.x, m.y, m.angle, effectiveZ, probeDist);
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
    }

    for (const [id, rig] of this.intruderRigs) {
      if (!activeIds.has(id)) {
        this.scene.remove(rig.root);
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
      const z = Math.max(this.env3d.sampleCavernBackZ(sim, b.x, b.y) + 0.03, 0.14 + Math.sin(b.id * 1.7) * 0.18);
      _dummy.position.set(simToWorldX(b.x), simToWorldY(b.y) - 0.015, z);
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
      const s = 0.55 + (f.amount / Math.max(1, f.maxAmount)) * 0.65;
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
      if (!d.settled && rainC < 120) {
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
    this.dustMesh.instanceMatrix.needsUpdate = true;
    this.crumbMesh.instanceMatrix.needsUpdate = true;
    this.sparkMesh.instanceMatrix.needsUpdate = true;
  }

  public render(sim: AntColonySimulation, dt: number): void {
    if (this.disposed) return;

    // Smooth camera reset animation (cancels if user interacts)
    if (this.resettingCamera) {
      const k = 1 - Math.exp(-6 * dt);
      this.camera.position.lerp(HERO_CAM_POS, k);
      this.controls.target.lerp(HERO_TARGET, k);
      if (
        this.camera.position.distanceTo(HERO_CAM_POS) < 0.03 &&
        this.controls.target.distanceTo(HERO_TARGET) < 0.03
      ) {
        this.camera.position.copy(HERO_CAM_POS);
        this.controls.target.copy(HERO_TARGET);
        this.resettingCamera = false;
      }
    }

    this.controls.update();
    // Keep pan target bounded inside the terrarium frame
    this.controls.target.x = clamp(this.controls.target.x, -13.5, 13.5);
    this.controls.target.y = clamp(this.controls.target.y, -7.8, 7.6);
    this.controls.target.z = clamp(this.controls.target.z, -0.45, 0.75);

    // Wind sway on 3D surface sprouts + keep seated on growing entrance mounds
    const keepSproutsSeated = sim.grid.dirtVisualDirty;
    for (let i = 0; i < this.sproutMeshes.length; i++) {
      const sp = this.sproutMeshes[i];
      if (keepSproutsSeated) {
        const simX = sp.baseX / WORLD_SCALE + 720;
        const gx = clamp(Math.floor(simX / CELL_SIZE), 0, GRID_W - 1);
        sp.mesh.position.y = simToWorldY(sim.grid.surfaceY[gx]);
      }
      sp.mesh.rotation.z =
        Math.sin(sim.simTime * 2.1 + sp.phase) * (0.045 + Math.abs(sim.windStrength) * 0.06);
    }

    this.env3d.update(sim, sim.simTime);
    this.updateLightingAndWeather(sim);
    this.syncAnts(sim, dt);
    this.syncIntruders(sim, dt);
    this.syncInstancedEntities(sim);

    this.renderer.render(this.scene, this.camera);
  }

  public dispose(): void {
    this.disposed = true;
    this.controls.dispose();
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
