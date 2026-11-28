import * as THREE from 'three';
import { WORLD_H, WORLD_W } from './types';

export const WORLD_SCALE = 0.02;
export const TANK_HALF_DEPTH = 0.72;
export const SOIL_FRONT_Z = 0.65;
export const SOIL_BACK_Z = -0.32;

export function simToWorldX(sx: number): number {
  return (sx - WORLD_W * 0.5) * WORLD_SCALE;
}

export function simToWorldY(sy: number): number {
  return (WORLD_H * 0.5 - sy) * WORLD_SCALE;
}

export function detectSoftwareWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

function createSoilGrainTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#c8c0b4';
  ctx.fillRect(0, 0, size, size);

  let seed = 1337;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  for (let i = 0; i < 4200; i++) {
    const x = rand() * size;
    const y = rand() * size;
    const r = 0.6 + rand() * 2.1;
    const shade = Math.floor(140 + (rand() - 0.5) * 95);
    ctx.fillStyle = `rgb(${shade}, ${Math.floor(shade * 0.94)}, ${Math.floor(shade * 0.86)})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Subtle mineral flecks
  for (let i = 0; i < 240; i++) {
    const x = rand() * size;
    const y = rand() * size;
    ctx.fillStyle = rand() < 0.5 ? 'rgba(255,245,225,0.35)' : 'rgba(42,30,20,0.42)';
    ctx.fillRect(x, y, 1.4, 1.4);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

function createWoodGrainTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#2d1e14';
  ctx.fillRect(0, 0, w, h);

  for (let y = 0; y < h; y++) {
    const wave = Math.sin(y * 0.22) * 8 + Math.cos(y * 0.07) * 12;
    const lum = 28 + Math.sin((y + wave) * 0.35) * 9;
    ctx.fillStyle = `rgb(${Math.floor(lum * 1.45)}, ${Math.floor(lum * 0.95)}, ${Math.floor(lum * 0.65)})`;
    ctx.fillRect(0, y, w, 1);
  }

  for (let i = 0; i < 180; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    ctx.fillStyle = 'rgba(18, 10, 6, 0.25)';
    ctx.fillRect(x, y, 14 + Math.random() * 28, 1);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

function createTableSlateTexture(maxAnisotropy: number): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#121316';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 2400; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const v = 14 + Math.floor(Math.random() * 14);
    ctx.fillStyle = `rgb(${v}, ${v + 1}, ${v + 3})`;
    ctx.fillRect(x, y, 2, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAnisotropy;
  return tex;
}

export class MaterialBank {
  public readonly textures: THREE.Texture[] = [];
  public readonly materials: THREE.Material[] = [];

  public readonly soilGrainTex: THREE.CanvasTexture;
  public readonly woodTex: THREE.CanvasTexture;
  public readonly tableTex: THREE.CanvasTexture;

  // Ant chitin & accent materials
  public readonly queenBody: THREE.MeshStandardMaterial;
  public readonly wingMat: THREE.MeshStandardMaterial;
  public readonly maleBody: THREE.MeshStandardMaterial;
  public readonly chaffMat: THREE.MeshStandardMaterial;
  public readonly cutLeafMat: THREE.MeshStandardMaterial;
  public readonly aphidMat: THREE.MeshStandardMaterial;
  public readonly debrisMat: THREE.MeshStandardMaterial;
  public readonly queenAbdomen: THREE.MeshStandardMaterial;
  public readonly workerBody: THREE.MeshStandardMaterial;
  public readonly workerAbdomen: THREE.MeshStandardMaterial;
  public readonly nurseBody: THREE.MeshStandardMaterial;
  public readonly excavatorBody: THREE.MeshStandardMaterial;
  public readonly soldierHead: THREE.MeshStandardMaterial;
  public readonly soldierBody: THREE.MeshStandardMaterial;
  public readonly callowBody: THREE.MeshStandardMaterial;
  public readonly antEye: THREE.MeshStandardMaterial;
  public readonly antLeg: THREE.MeshStandardMaterial;
  public readonly mandible: THREE.MeshStandardMaterial;

  // Intruder materials
  public readonly beetleShell: THREE.MeshStandardMaterial;
  public readonly beetleThorax: THREE.MeshStandardMaterial;
  public readonly miteBody: THREE.MeshStandardMaterial;
  public readonly miteLeg: THREE.MeshStandardMaterial;
  public readonly centipedeBody: THREE.MeshStandardMaterial;
  public readonly centipedeSegment: THREE.MeshStandardMaterial;
  public readonly earwigBody: THREE.MeshStandardMaterial;
  public readonly earwigPincer: THREE.MeshStandardMaterial;
  public readonly rivalAntBody: THREE.MeshStandardMaterial;
  public readonly rivalAntAbdomen: THREE.MeshStandardMaterial;

  // Environment & enclosure
  public readonly walnutWood: THREE.MeshStandardMaterial;
  public readonly brushedBrass: THREE.MeshStandardMaterial;
  public readonly studioTable: THREE.MeshStandardMaterial;
  public readonly frontGlass: THREE.MeshStandardMaterial;
  public readonly sideGlass: THREE.MeshStandardMaterial;
  public readonly soilFrontMat: THREE.MeshStandardMaterial;
  public readonly soilWallMat: THREE.MeshStandardMaterial;
  public readonly rootMat: THREE.MeshStandardMaterial;
  public readonly pebbleMat: THREE.MeshStandardMaterial;
  public readonly outcropRockMat: THREE.MeshStandardMaterial;
  public readonly creviceShadowMat: THREE.MeshStandardMaterial;
  public readonly barkMat: THREE.MeshStandardMaterial;
  public readonly leafMat: THREE.MeshStandardMaterial;
  public readonly mossMat: THREE.MeshStandardMaterial;
  public readonly grassMat: THREE.MeshStandardMaterial;
  public readonly cloverMat: THREE.MeshStandardMaterial;

  // Payloads, foods, brood, droplets
  public readonly seedMat: THREE.MeshStandardMaterial;
  public readonly honeydewMat: THREE.MeshStandardMaterial;
  public readonly proteinMat: THREE.MeshStandardMaterial;
  public readonly fungusMat: THREE.MeshStandardMaterial;
  public readonly soilCrumbMat: THREE.MeshStandardMaterial;
  public readonly eggMat: THREE.MeshStandardMaterial;
  public readonly larvaMat: THREE.MeshStandardMaterial;
  public readonly pupaMat: THREE.MeshStandardMaterial;
  public readonly waterMat: THREE.MeshStandardMaterial;
  public readonly fallenAntMat: THREE.MeshStandardMaterial;

  constructor(_isSoftwareGl: boolean, maxAnisotropy: number, physicalMaterials = true) {
    this.soilGrainTex = createSoilGrainTexture(maxAnisotropy);
    this.woodTex = createWoodGrainTexture(maxAnisotropy);
    this.tableTex = createTableSlateTexture(maxAnisotropy);
    this.textures.push(this.soilGrainTex, this.woodTex, this.tableTex);

    const reg = <T extends THREE.Material>(m: T): T => {
      this.materials.push(m);
      return m;
    };

    // Ants (low-poly faceted chitin with distinct roughness/metalness contrast)
    this.queenBody = reg(
      new THREE.MeshStandardMaterial({ color: 0x3b170e, roughness: 0.3, metalness: 0.14, flatShading: true })
    );
    this.queenAbdomen = reg(
      new THREE.MeshStandardMaterial({ color: 0x5c2716, roughness: 0.26, metalness: 0.18, flatShading: true })
    );
    this.workerBody = reg(
      new THREE.MeshStandardMaterial({ color: 0x702d16, roughness: 0.36, metalness: 0.08, flatShading: true })
    );
    this.workerAbdomen = reg(
      new THREE.MeshStandardMaterial({ color: 0x3a180e, roughness: 0.28, metalness: 0.12, flatShading: true })
    );
    this.nurseBody = reg(
      new THREE.MeshStandardMaterial({ color: 0xa45424, roughness: 0.38, metalness: 0.06, flatShading: true })
    );
    this.excavatorBody = reg(
      new THREE.MeshStandardMaterial({ color: 0x592917, roughness: 0.44, metalness: 0.05, flatShading: true })
    );
    this.soldierHead = reg(
      new THREE.MeshStandardMaterial({ color: 0x8b2615, roughness: 0.25, metalness: 0.16, flatShading: true })
    );
    this.soldierBody = reg(
      new THREE.MeshStandardMaterial({ color: 0x451810, roughness: 0.34, metalness: 0.1, flatShading: true })
    );
    this.callowBody = reg(
      new THREE.MeshStandardMaterial({ color: 0xd99b52, roughness: 0.48, metalness: 0.02, flatShading: true })
    );
    this.antEye = reg(
      new THREE.MeshStandardMaterial({ color: 0x0b0b0d, roughness: 0.1, metalness: 0.3, flatShading: true })
    );
    this.antLeg = reg(
      new THREE.MeshStandardMaterial({ color: 0x26120b, roughness: 0.55, metalness: 0.02, flatShading: true })
    );
    this.mandible = reg(
      new THREE.MeshStandardMaterial({ color: 0x1e0e08, roughness: 0.22, metalness: 0.24, flatShading: true })
    );

    // Intruders
    this.beetleShell = reg(
      new THREE.MeshStandardMaterial({ color: 0x1d4d3a, roughness: 0.2, metalness: 0.46, flatShading: true })
    );
    this.beetleThorax = reg(
      new THREE.MeshStandardMaterial({ color: 0x162922, roughness: 0.35, metalness: 0.28, flatShading: true })
    );
    this.miteBody = reg(
      new THREE.MeshStandardMaterial({ color: 0xb91c1c, roughness: 0.32, metalness: 0.08, flatShading: true })
    );
    this.miteLeg = reg(
      new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.52, metalness: 0.04, flatShading: true })
    );
    this.centipedeBody = reg(
      new THREE.MeshStandardMaterial({ color: 0x7c2d12, roughness: 0.34, metalness: 0.12, flatShading: true })
    );
    this.centipedeSegment = reg(
      new THREE.MeshStandardMaterial({ color: 0xd97706, roughness: 0.48, metalness: 0.05, flatShading: true })
    );
    this.earwigBody = reg(
      new THREE.MeshStandardMaterial({ color: 0x452212, roughness: 0.4, metalness: 0.1, flatShading: true })
    );
    this.earwigPincer = reg(
      new THREE.MeshStandardMaterial({ color: 0xb45309, roughness: 0.22, metalness: 0.3, flatShading: true })
    );
    this.rivalAntBody = reg(
      new THREE.MeshStandardMaterial({ color: 0x1b1519, roughness: 0.24, metalness: 0.22, flatShading: true })
    );
    this.rivalAntAbdomen = reg(
      new THREE.MeshStandardMaterial({ color: 0x7f1d1d, roughness: 0.22, metalness: 0.24, flatShading: true })
    );

    // Tank & Studio
    this.walnutWood = reg(
      new THREE.MeshStandardMaterial({ map: this.woodTex, roughness: 0.62, metalness: 0.05 })
    );
    this.brushedBrass = reg(
      new THREE.MeshStandardMaterial({ color: 0xc29b57, roughness: 0.26, metalness: 0.88 })
    );
    this.studioTable = reg(
      new THREE.MeshStandardMaterial({ map: this.tableTex, roughness: 0.85, metalness: 0.06 })
    );
    this.frontGlass = reg(
      physicalMaterials
        ? new THREE.MeshPhysicalMaterial({
            color: 0xe6f4ff,
            roughness: 0.04,
            metalness: 0.0,
            transparent: true,
            opacity: 0.08,
            ior: 1.52,
            reflectivity: 0.9,
            clearcoat: 1.0,
            depthWrite: false,
          })
        : new THREE.MeshStandardMaterial({
            color: 0xe6f4ff,
            roughness: 0.04,
            metalness: 0.14,
            transparent: true,
            opacity: 0.09,
            depthWrite: false,
          })
    );
    this.sideGlass = reg(
      physicalMaterials
        ? new THREE.MeshPhysicalMaterial({
            color: 0xd2ebfc,
            roughness: 0.08,
            metalness: 0.04,
            transparent: true,
            opacity: 0.24,
            ior: 1.52,
            clearcoat: 0.9,
            depthWrite: false,
          })
        : new THREE.MeshStandardMaterial({
            color: 0xd2ebfc,
            roughness: 0.08,
            metalness: 0.16,
            transparent: true,
            opacity: 0.24,
            depthWrite: false,
          })
    );

    // Soil & natural terrain
    this.soilFrontMat = reg(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.96,
        metalness: 0.0,
        flatShading: false,
      })
    );
    this.soilWallMat = reg(
      new THREE.MeshStandardMaterial({
        map: this.soilGrainTex,
        vertexColors: true,
        roughness: 0.96,
        metalness: 0.0,
        flatShading: false,
      })
    );
    this.rootMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x5c3c22, roughness: 0.88, metalness: 0.02, flatShading: true })
    );
    this.pebbleMat = reg(
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72, metalness: 0.05, flatShading: true })
    );
    this.outcropRockMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x4b4e54, roughness: 0.86, metalness: 0.06, flatShading: true })
    );
    this.creviceShadowMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x09080a, roughness: 0.98, metalness: 0.0, flatShading: true })
    );
    this.barkMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x3b2618, roughness: 0.9, metalness: 0.02, flatShading: true })
    );
    this.leafMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x8c4d24, roughness: 0.68, metalness: 0.02, flatShading: true, side: THREE.DoubleSide })
    );
    this.mossMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x456e30, roughness: 0.92, metalness: 0.0, flatShading: true })
    );
    this.grassMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x558438, roughness: 0.68, metalness: 0.02, flatShading: true, side: THREE.DoubleSide })
    );
    this.cloverMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x487a37, roughness: 0.64, metalness: 0.02, flatShading: true, side: THREE.DoubleSide })
    );

    // Foods, brood, droplets
    this.seedMat = reg(
      new THREE.MeshStandardMaterial({ color: 0xd9ad62, roughness: 0.62, metalness: 0.04, flatShading: true })
    );
    this.honeydewMat = reg(
      physicalMaterials
        ? new THREE.MeshPhysicalMaterial({
            color: 0xf59e0b,
            emissive: 0x78350f,
            emissiveIntensity: 0.22,
            roughness: 0.14,
            metalness: 0.05,
            clearcoat: 1.0,
            transparent: true,
            opacity: 0.9,
          })
        : new THREE.MeshStandardMaterial({
            color: 0xf59e0b,
            emissive: 0x78350f,
            emissiveIntensity: 0.22,
            roughness: 0.12,
            metalness: 0.08,
            transparent: true,
            opacity: 0.9,
          })
    );
    this.proteinMat = reg(
      new THREE.MeshStandardMaterial({ color: 0xbe6d58, roughness: 0.52, metalness: 0.06, flatShading: true })
    );
    this.fungusMat = reg(
      new THREE.MeshStandardMaterial({
        color: 0xe6e1d3,
        emissive: 0x262920,
        emissiveIntensity: 0.15,
        roughness: 0.85,
        metalness: 0.0,
        flatShading: true,
      })
    );
    this.soilCrumbMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x3b2416, roughness: 0.95, metalness: 0.0, flatShading: false })
    );
    this.eggMat = reg(
      new THREE.MeshStandardMaterial({ color: 0xf6f0de, roughness: 0.34, metalness: 0.02, flatShading: false })
    );
    this.larvaMat = reg(
      physicalMaterials
        ? new THREE.MeshPhysicalMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.34,
            metalness: 0.01,
            clearcoat: 0.42,
            clearcoatRoughness: 0.36,
            flatShading: false,
          })
        : new THREE.MeshStandardMaterial({
            color: 0xffffff,
            vertexColors: true,
            roughness: 0.28,
            metalness: 0.02,
            flatShading: false,
          })
    );
    this.pupaMat = reg(
      new THREE.MeshStandardMaterial({ color: 0xcba675, roughness: 0.62, metalness: 0.02, flatShading: false })
    );
    this.waterMat = reg(
      physicalMaterials
        ? new THREE.MeshPhysicalMaterial({
            color: 0xbae6fd,
            roughness: 0.06,
            metalness: 0.02,
            transparent: true,
            opacity: 0.8,
            clearcoat: 1.0,
          })
        : new THREE.MeshStandardMaterial({
            color: 0xbae6fd,
            roughness: 0.06,
            metalness: 0.1,
            transparent: true,
            opacity: 0.8,
          })
    );
    this.wingMat = reg(
      new THREE.MeshStandardMaterial({
        color: 0xdfe9f2,
        roughness: 0.2,
        metalness: 0.1,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    this.maleBody = reg(new THREE.MeshStandardMaterial({ color: 0x17120f, roughness: 0.4, metalness: 0.08 }));
    this.cutLeafMat = reg(new THREE.MeshStandardMaterial({ color: 0x5fae45, roughness: 0.7, metalness: 0, flatShading: true, side: THREE.DoubleSide }));
    this.chaffMat = reg(new THREE.MeshStandardMaterial({ color: 0xc9a86a, roughness: 0.85, metalness: 0, flatShading: true }));
    this.aphidMat = reg(new THREE.MeshStandardMaterial({ color: 0x9bd46a, roughness: 0.45, metalness: 0, emissive: 0x1a2a0c, emissiveIntensity: 0.3 }));
    this.debrisMat = reg(new THREE.MeshStandardMaterial({ color: 0x6b5a45, roughness: 0.92, metalness: 0, flatShading: true }));
    this.fallenAntMat = reg(
      new THREE.MeshStandardMaterial({ color: 0x291a14, roughness: 0.78, metalness: 0.02, flatShading: true })
    );
  }

  public dispose(): void {
    for (const t of this.textures) t.dispose();
    for (const m of this.materials) m.dispose();
  }
}
