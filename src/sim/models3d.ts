import * as THREE from 'three';
import { createLegSet, updateLegs, type GroundSampler, type Leg, type LegSet } from './legs';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MaterialBank, WORLD_SCALE } from './materials3d';
import { Ant, AntCaste, AntTask, Intruder, PayloadType, PlantSprout, SurfaceProp } from './types';

export interface GeometryBank {
  icosa0: THREE.BufferGeometry;
  icosa1: THREE.BufferGeometry;
  box1: THREE.BufferGeometry;
  tetra0: THREE.BufferGeometry;
  cyl6: THREE.BufferGeometry;
  cone5: THREE.BufferGeometry;
  larvaGeo: THREE.BufferGeometry;
  fallenAntGeo: THREE.BufferGeometry;
  dispose: () => void;
}

/**
 * Procedurally builds a detailed C-curved, 10-segment annulated ant larva BufferGeometry
 * with bulging cuticle rings, tapered cephalic head capsule tip, and translucent gut/crease shading.
 */
export function createLarvaGeometry(): THREE.BufferGeometry {
  const uSteps = 34;
  const vSteps = 14;
  const ringVerts = vSteps + 1;
  const vertCount = (uSteps + 1) * ringVerts;

  const positions = new Float32Array(vertCount * 3);
  const colors = new Float32Array(vertCount * 3);
  const indices: number[] = [];
  const col = new THREE.Color();

  const spinePoint = (u: number): [number, number] => {
    const theta = (u - 0.42) * 1.65;
    const x = Math.sin(theta) * 0.088;
    const y = (1 - Math.cos(theta)) * 0.068 - 0.022;
    return [x, y];
  };

  for (let iu = 0; iu <= uSteps; iu++) {
    const u = iu / uSteps;
    const [cx, cy] = spinePoint(u);
    const [px0, py0] = spinePoint(Math.max(0, u - 0.01));
    const [px1, py1] = spinePoint(Math.min(1, u + 0.01));
    let tx = px1 - px0;
    let ty = py1 - py0;
    const tLen = Math.hypot(tx, ty) || 1;
    tx /= tLen;
    ty /= tLen;
    // In-plane normal pointing toward outer/dorsal side (-y in curved arc -> invert so normal points up/out)
    const nx = -ty;
    const ny = tx;

    const sinEnv = Math.sin(Math.max(0, Math.min(1, u)) * Math.PI);
    const envelope = iu === 0 || iu === uSteps ? 0 : Math.pow(sinEnv, 0.54);
    const taper = 1.2 - 0.62 * u;
    const crease = Math.pow(Math.cos(u * Math.PI * 10), 4);
    const segPinch = 1.0 - 0.19 * crease;
    const headBulge = u > 0.85 && u < 0.97 ? 1.14 : 1.0;
    const rad = 0.039 * envelope * taper * segPinch * headBulge;

    const isHead = u > 0.86;
    const gutWeight = Math.max(0, 1 - Math.abs(u - 0.46) / 0.24);

    for (let iv = 0; iv <= vSteps; iv++) {
      const v = (iv / vSteps) * Math.PI * 2;
      const cosV = Math.cos(v);
      const sinV = Math.sin(v);

      const rx = rad * cosV;
      const rz = rad * 0.88 * sinV;

      const vx = cx + nx * rx;
      const vy = cy + ny * rx;
      const vz = rz;

      const idx = (iu * ringVerts + iv) * 3;
      positions[idx] = vx;
      positions[idx + 1] = vy;
      positions[idx + 2] = vz;

      // Subtle dorsal-ventral, inter-segment crease, internal gut, and amber head coloration
      let r = 0.97 - crease * 0.13;
      let g = 0.93 - crease * 0.16;
      let b = 0.84 - crease * 0.20;

      if (gutWeight > 0) {
        const innerSide = Math.max(0, cosV * 0.5 + 0.5);
        const gw = gutWeight * innerSide * 0.45;
        r = r * (1 - gw) + 0.86 * gw;
        g = g * (1 - gw) + 0.68 * gw;
        b = b * (1 - gw) + 0.46 * gw;
      }

      if (isHead) {
        const hw = Math.min(1, (u - 0.86) / 0.08);
        r = r * (1 - hw) + 0.84 * hw;
        g = g * (1 - hw) + 0.67 * hw;
        b = b * (1 - hw) + 0.46 * hw;
      }

      col.setRGB(r, g, b, THREE.SRGBColorSpace);
      colors[idx] = col.r;
      colors[idx + 1] = col.g;
      colors[idx + 2] = col.b;
    }
  }

  for (let iu = 0; iu < uSteps; iu++) {
    for (let iv = 0; iv < vSteps; iv++) {
      const a = iu * ringVerts + iv;
      const b = (iu + 1) * ringVerts + iv;
      const c = (iu + 1) * ringVerts + (iv + 1);
      const d = iu * ringVerts + (iv + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Compact curled dead-ant silhouette (gaster, thorax, head, tucked legs) replacing raw rock chunks.
 */
export function createFallenAntGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const gaster = new THREE.IcosahedronGeometry(1, 0);
  gaster.scale(0.055, 0.036, 0.038);
  gaster.rotateZ(-0.45);
  gaster.translate(-0.042, 0.006, 0);
  parts.push(gaster);

  const thorax = new THREE.IcosahedronGeometry(1, 0);
  thorax.scale(0.042, 0.025, 0.024);
  thorax.translate(0.008, 0.022, 0);
  parts.push(thorax);

  const head = new THREE.IcosahedronGeometry(1, 0);
  head.scale(0.030, 0.025, 0.026);
  head.rotateZ(0.5);
  head.translate(0.055, 0.004, 0);
  parts.push(head);

  for (const side of [-1, 1]) {
    const leg = new THREE.CylinderGeometry(0.004, 0.004, 0.065, 5);
    leg.rotateZ(0.8);
    leg.rotateX(side * 0.75);
    leg.translate(0.005, -0.004, side * 0.028);
    // icosahedra are non-indexed; the cylinder must match or the merge fails
    parts.push(leg.toNonIndexed());
    leg.dispose();
  }

  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!merged) return new THREE.IcosahedronGeometry(0.055, 0);
  merged.computeBoundingSphere();
  return merged;
}

export function createGeometryBank(): GeometryBank {
  const icosa0 = new THREE.IcosahedronGeometry(1, 0);
  const icosa1 = new THREE.IcosahedronGeometry(1, 1);
  const box1 = new THREE.BoxGeometry(1, 1, 1);
  const tetra0 = new THREE.TetrahedronGeometry(1, 0);
  const cyl6 = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true); // open-ended: leg and antenna caps are never seen
  const cone5 = new THREE.ConeGeometry(1, 1, 5);
  const larvaGeo = createLarvaGeometry();
  const fallenAntGeo = createFallenAntGeometry();
  return {
    icosa0,
    icosa1,
    box1,
    tetra0,
    cyl6,
    cone5,
    larvaGeo,
    fallenAntGeo,
    dispose: () => {
      icosa0.dispose();
      icosa1.dispose();
      box1.dispose();
      tetra0.dispose();
      cyl6.dispose();
      cone5.dispose();
      larvaGeo.dispose();
      fallenAntGeo.dispose();
    },
  };
}

export interface AntRig {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  neckPivot: THREE.Group;
  petiolePivot: THREE.Group;
  gasterPivot: THREE.Group;
  gaster: THREE.Mesh;
  gasterBand: THREE.Mesh;
  gasterTip: THREE.Mesh;
  headGroup: THREE.Group;
  leftMandible: THREE.Mesh;
  rightMandible: THREE.Mesh;
  leftAntenna: THREE.Group;
  rightAntenna: THREE.Group;
  legSet: LegSet;
  payloadGroup: THREE.Group;
  payloadMeshes: Record<number, THREE.Object3D>;
  caste: AntCaste;
  isCallow: boolean;
  /** alates only: [left fore, right fore, left hind, right hind] wing pivots */
  wings: THREE.Group[];
  tintables: THREE.Mesh[];
  baseMat: THREE.Material;
  abdomenMat: THREE.Material;
  currentQuat: THREE.Quaternion;
  hasInitOrientation: boolean;
  smoothPos: THREE.Vector3;
  hasInitPos: boolean;
  zLane: number;
  baseBodyY: number;
  smoothHeadPitch: number;
  smoothTailPitch: number;
  smoothHeadYaw: number;
  smoothTailYaw: number;
  smoothBodyDip: number;
  /** smoothed world-space body velocity (units/s) used by the leg solver */
  worldVel: THREE.Vector3;
  prevWorldPos: THREE.Vector3;
  /** smoothed ratio of 3D surface path length to 2D sim distance (fed back to the sim to slow corner turns) */
  stretch: number;
}

export function createAntRig(
  caste: AntCaste,
  isCallow: boolean,
  bank: MaterialBank,
  geo: GeometryBank
): AntRig {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const isQueen = caste === AntCaste.QUEEN;
  const isSoldier = caste === AntCaste.SOLDIER;
  const isGyne = caste === AntCaste.GYNE;
  const isMale = caste === AntCaste.MALE;
  const scale = isQueen ? 1.55 : isGyne ? 1.42 : isMale ? 0.98 : isSoldier ? 1.24 : caste === AntCaste.EXCAVATOR ? 1.04 : 0.94;
  bodyGroup.scale.setScalar(scale);

  const baseBodyY = 0.038 * scale;
  // Elevation offset so tarsal tips touch local Y = 0
  bodyGroup.position.y = baseBodyY;

  const baseMat = isCallow
    ? bank.callowBody
    : isMale
    ? bank.maleBody
    : isQueen || isGyne
    ? bank.queenBody
    : isSoldier
    ? bank.soldierBody
    : caste === AntCaste.NURSE
    ? bank.nurseBody
    : caste === AntCaste.EXCAVATOR
    ? bank.excavatorBody
    : bank.workerBody;

  const headMat = isCallow ? bank.callowBody : isSoldier ? bank.soldierHead : baseMat;
  const abdomenMat = isCallow
    ? bank.callowBody
    : isMale
    ? bank.maleBody
    : isQueen || isGyne
    ? bank.queenAbdomen
    : bank.workerAbdomen;

  const tintables: THREE.Mesh[] = [];

  // 1 & 2. Articulated Petiole waist + multi-plate Gaster hinge chain at -X
  const petiolePivot = new THREE.Group();
  petiolePivot.position.set(-0.030, 0.009, 0);
  bodyGroup.add(petiolePivot);

  const petiole = new THREE.Mesh(geo.icosa0, baseMat);
  petiole.scale.set(0.025, 0.02, 0.02);
  petiole.position.set(-0.018, -0.001, 0);
  petiolePivot.add(petiole);
  tintables.push(petiole);

  const gasterPivot = new THREE.Group();
  gasterPivot.position.set(-0.034, 0.003, 0);
  petiolePivot.add(gasterPivot);

  const gasterBand = new THREE.Mesh(geo.icosa0, baseMat);
  gasterBand.scale.set(isQueen ? 0.085 : 0.052, isQueen ? 0.072 : 0.048, isQueen ? 0.076 : 0.05);
  gasterBand.position.set(isQueen ? -0.051 : -0.026, 0.005, 0);
  gasterPivot.add(gasterBand);
  tintables.push(gasterBand);

  const gaster = new THREE.Mesh(geo.icosa0, abdomenMat);
  gaster.scale.set(isQueen ? 0.13 : 0.088, isQueen ? 0.086 : 0.058, isQueen ? 0.086 : 0.058);
  gaster.position.set(isQueen ? -0.091 : -0.051, 0.002, 0);
  gaster.castShadow = true;
  gasterPivot.add(gaster);

  const gasterTip = new THREE.Mesh(geo.icosa0, abdomenMat);
  gasterTip.scale.set(isQueen ? 0.072 : 0.046, isQueen ? 0.054 : 0.036, isQueen ? 0.054 : 0.036);
  gasterTip.position.set(isQueen ? -0.145 : -0.088, -0.002, 0);
  gasterPivot.add(gasterTip);

  // 3. Sculpted Thorax (prothorax + mesothorax)
  const thorax = new THREE.Mesh(geo.icosa0, baseMat);
  thorax.scale.set(0.068, isQueen ? 0.048 : 0.036, isQueen ? 0.046 : 0.035);
  thorax.position.set(0.012, 0.012, 0);
  thorax.castShadow = true;
  bodyGroup.add(thorax);
  tintables.push(thorax);

  // Wings (alates): two pairs of membranous wings hinged on the thorax, folded back along the gaster at rest
  const wings: THREE.Group[] = [];
  if (isGyne || isMale) {
    for (const [len, x, side] of [
      [0.15, 0.02, 1],
      [0.15, 0.02, -1],
      [0.11, 0.0, 1],
      [0.11, 0.0, -1],
    ] as const) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.04, 0.012 * side);
      const w = new THREE.Mesh(geo.icosa0, bank.wingMat);
      w.scale.set(len, 0.004, len * 0.3);
      w.position.set(-len * 0.5, 0, 0);
      w.castShadow = false;
      pivot.add(w);
      pivot.userData.side = side;
      bodyGroup.add(pivot);
      wings.push(pivot);
    }
  }

  const pronotum = new THREE.Mesh(geo.icosa0, baseMat);
  pronotum.scale.set(0.04, 0.032, 0.034);
  pronotum.position.set(0.055, 0.014, 0);
  bodyGroup.add(pronotum);
  tintables.push(pronotum);

  // 4. Articulated Neck + Head group at +X
  const neckPivot = new THREE.Group();
  neckPivot.position.set(0.074, 0.015, 0);
  bodyGroup.add(neckPivot);

  const headGroup = new THREE.Group();
  headGroup.position.set(0.021, 0.001, 0);
  neckPivot.add(headGroup);

  const head = new THREE.Mesh(geo.icosa0, headMat);
  head.scale.set(
    isSoldier ? 0.056 : 0.044,
    isSoldier ? 0.048 : 0.036,
    isSoldier ? 0.056 : 0.038
  );
  head.position.set(0.02, 0, 0);
  head.castShadow = true;
  headGroup.add(head);
  if (!isSoldier) tintables.push(head);

  // 5. Compound eyes
  const leftEye = new THREE.Mesh(geo.icosa0, bank.antEye);
  leftEye.scale.set(0.012, 0.011, 0.01);
  leftEye.position.set(0.032, 0.016, -0.028);
  headGroup.add(leftEye);

  const rightEye = new THREE.Mesh(geo.icosa0, bank.antEye);
  rightEye.scale.set(0.012, 0.011, 0.01);
  rightEye.position.set(0.032, 0.016, 0.028);
  headGroup.add(rightEye);

  // 6. Articulated Mandibles
  const mandLen = isSoldier ? 0.052 : 0.03;
  const leftMandible = new THREE.Mesh(geo.cone5, bank.mandible);
  leftMandible.scale.set(0.012, mandLen, 0.01);
  leftMandible.rotation.z = -Math.PI * 0.5;
  leftMandible.rotation.y = 0.34;
  leftMandible.position.set(0.062, -0.008, -0.016);
  headGroup.add(leftMandible);

  const rightMandible = new THREE.Mesh(geo.cone5, bank.mandible);
  rightMandible.scale.set(0.012, mandLen, 0.01);
  rightMandible.rotation.z = -Math.PI * 0.5;
  rightMandible.rotation.y = -0.34;
  rightMandible.position.set(0.062, -0.008, 0.016);
  headGroup.add(rightMandible);

  // 7. Elbowed Antennae
  const makeAntenna = (side: -1 | 1): THREE.Group => {
    const antPivot = new THREE.Group();
    antPivot.position.set(0.044, 0.02, side * 0.014);
    const scape = new THREE.Mesh(geo.cyl6, bank.antLeg);
    scape.scale.set(0.004, 0.038, 0.004);
    scape.rotation.z = -0.75;
    scape.rotation.x = side * 0.35;
    scape.position.set(0.014, 0.014, side * 0.008);
    antPivot.add(scape);

    const funiculus = new THREE.Mesh(geo.cyl6, bank.antLeg);
    funiculus.scale.set(0.0032, 0.042, 0.0032);
    funiculus.rotation.z = -1.35;
    funiculus.rotation.x = side * 0.25;
    funiculus.position.set(0.044, 0.024, side * 0.018);
    antPivot.add(funiculus);
    return antPivot;
  };
  const leftAntenna = makeAntenna(-1);
  const rightAntenna = makeAntenna(1);
  headGroup.add(leftAntenna, rightAntenna);

  // 8. Six procedurally-stepped legs (femur / tibia / tarsus). Posed every frame by the IK foot-planting solver.
  const legSet = createLegSet();
  const legAttachX = [0.045, 0.01, -0.025];
  const legRestX = [0.082, 0.012, -0.066];
  const legRestZ = [0.074, 0.088, 0.082];
  const femurLen = [0.057, 0.06, 0.066];
  const tibiaLen = [0.06, 0.064, 0.076];
  const tarsusLen = [0.024, 0.026, 0.03];

  for (let idx = 0; idx < 3; idx++) {
    for (const side of [-1, 1] as const) {
      const femur = new THREE.Mesh(geo.cyl6, bank.antLeg);
      const tibia = new THREE.Mesh(geo.cyl6, bank.antLeg);
      const tarsus = new THREE.Mesh(geo.cyl6, bank.antLeg);
      bodyGroup.add(femur, tibia, tarsus);
      // Tripod A = (L0, R1, L2); tripod B = (R0, L1, R2)
      const groupA = (side === -1 && idx !== 1) || (side === 1 && idx === 1);
      const leg: Leg = {
        side,
        index: idx as 0 | 1 | 2,
        group: groupA ? 0 : 1,
        hip: new THREE.Vector3(legAttachX[idx], -0.005, side * 0.02),
        restX: legRestX[idx],
        restZ: side * legRestZ[idx],
        femurLen: femurLen[idx],
        tibiaLen: tibiaLen[idx],
        tarsusLen: tarsusLen[idx],
        femur,
        tibia,
        tarsus,
        foot: new THREE.Vector3(),
        stepFrom: new THREE.Vector3(),
        stepT: -1,
        stepDur: 0.1,
      };
      legSet.legs.push(leg);
    }
  }

  // 9. Carried Payload Anchor between mandibles
  const payloadGroup = new THREE.Group();
  payloadGroup.position.set(0.076, -0.004, 0);
  headGroup.add(payloadGroup);

  const seedMesh = new THREE.Mesh(geo.icosa0, bank.seedMat);
  seedMesh.scale.set(0.036, 0.026, 0.026);
  seedMesh.visible = false;

  const honeyMesh = new THREE.Mesh(geo.icosa1, bank.honeydewMat);
  honeyMesh.scale.setScalar(0.032);
  honeyMesh.visible = false;

  const proteinMesh = new THREE.Mesh(geo.icosa0, bank.proteinMat);
  proteinMesh.scale.set(0.038, 0.028, 0.032);
  proteinMesh.visible = false;

  const soilMesh = new THREE.Mesh(geo.icosa1, bank.soilCrumbMat);
  soilMesh.scale.setScalar(0.036);
  soilMesh.visible = false;

  const eggMesh = new THREE.Mesh(geo.icosa1, bank.eggMat);
  eggMesh.scale.set(0.032, 0.02, 0.02);
  eggMesh.visible = false;

  const larvaMesh = new THREE.Mesh(geo.larvaGeo, bank.larvaMat);
  larvaMesh.scale.setScalar(0.68);
  larvaMesh.rotation.set(0.22, 0.15, -0.35);
  larvaMesh.visible = false;

  const pupaMesh = new THREE.Mesh(geo.icosa1, bank.pupaMat);
  pupaMesh.scale.set(0.044, 0.022, 0.022);
  pupaMesh.visible = false;

  const refuseMesh = new THREE.Mesh(geo.fallenAntGeo, bank.fallenAntMat);
  refuseMesh.scale.setScalar(0.84);
  refuseMesh.visible = false;

  payloadGroup.add(seedMesh, honeyMesh, proteinMesh, soilMesh, eggMesh, larvaMesh, pupaMesh, refuseMesh);

  const chaffMesh = new THREE.Mesh(geo.icosa0, bank.chaffMat);
  chaffMesh.scale.set(0.05, 0.012, 0.035);
  chaffMesh.visible = false;
  const debrisMesh = new THREE.Mesh(geo.icosa0, bank.debrisMat);
  debrisMesh.scale.set(0.06, 0.025, 0.03);
  debrisMesh.visible = false;
  const leafMesh = new THREE.Mesh(geo.icosa0, bank.cutLeafMat);
  leafMesh.scale.set(0.085, 0.01, 0.06);
  leafMesh.position.y = 0.035;
  leafMesh.visible = false;
  payloadGroup.add(chaffMesh, debrisMesh, leafMesh);

  const payloadMeshes: Record<number, THREE.Object3D> = {
    [PayloadType.CHAFF]: chaffMesh,
    [PayloadType.LEAF]: leafMesh,
    [PayloadType.DEBRIS]: debrisMesh,
    [PayloadType.SEED]: seedMesh,
    [PayloadType.HONEYDEW]: honeyMesh,
    [PayloadType.PROTEIN]: proteinMesh,
    [PayloadType.SOIL]: soilMesh,
    [PayloadType.EGG]: eggMesh,
    [PayloadType.LARVA]: larvaMesh,
    [PayloadType.PUPA]: pupaMesh,
    [PayloadType.FUNGUS]: seedMesh,
    [PayloadType.REFUSE]: refuseMesh,
  };

  return {
    root,
    bodyGroup,
    neckPivot,
    petiolePivot,
    gasterPivot,
    gaster,
    gasterBand,
    gasterTip,
    headGroup,
    leftMandible,
    rightMandible,
    leftAntenna,
    rightAntenna,
    legSet,
    payloadGroup,
    payloadMeshes,
    caste,
    isCallow,
    wings,
    tintables,
    baseMat,
    abdomenMat,
    currentQuat: new THREE.Quaternion(),
    hasInitOrientation: false,
    smoothPos: new THREE.Vector3(),
    hasInitPos: false,
    zLane: 0,
    baseBodyY,
    smoothHeadPitch: 0,
    smoothTailPitch: 0,
    smoothHeadYaw: 0,
    smoothTailYaw: 0,
    smoothBodyDip: 0,
    worldVel: new THREE.Vector3(),
    prevWorldPos: new THREE.Vector3(),
    stretch: 1,
  };
}

export function animateAntRig(
  rig: AntRig,
  ant: Ant,
  time: number,
  bank: MaterialBank,
  dt = 1 / 60,
  worldVel?: THREE.Vector3,
  ground?: GroundSampler
): void {
  // Update callow -> mature coloration seamlessly when callow timer expires
  if (rig.isCallow !== ant.isCallow) {
    rig.isCallow = ant.isCallow;
    if (!ant.isCallow) {
      for (const m of rig.tintables) m.material = rig.baseMat;
      rig.gaster.material = rig.abdomenMat;
      rig.gasterTip.material = rig.abdomenMat;
    } else {
      for (const m of rig.tintables) m.material = bank.callowBody;
      rig.gaster.material = bank.callowBody;
      rig.gasterTip.material = bank.callowBody;
    }
  }

  // Repletes: the gaster balloons as the crop fills with stored liquid food
  const swell = ant.replete !== undefined ? 1 + ant.replete * 2.2 : 1;
  rig.gasterPivot.scale.setScalar(swell);

  // Alate wings: folded flat over the back at rest, a blur of beats in flight, fanned while waiting to swarm
  if (rig.wings.length) {
    const flapping = !!ant.flying;
    const fanning = !flapping && ant.task === AntTask.NUPTIAL_FLIGHT;
    for (let k = 0; k < rig.wings.length; k++) {
      const w = rig.wings[k];
      const side = w.userData.side as number;
      if (flapping) {
        const beat = Math.sin(time * 70 + (k < 2 ? 0 : 0.6));
        w.rotation.set(side * (0.3 + beat * 1.1), side * 1.15, 0);
      } else if (fanning) {
        w.rotation.set(side * 0.25, side * (0.35 + Math.sin(time * 9 + k) * 0.15), 0.25);
      } else {
        w.rotation.set(0, side * 0.12, 0.08);
      }
    }
  }

  // Antennae sweep faster during social greeting, trophallaxis, food signaling, or defending
  const signaling = ant.task === AntTask.SIGNALING_FOOD;
  const antAmp = signaling
    ? 0.52
    : ant.task === AntTask.GREETING || ant.task === AntTask.TROPHALLAXIS || ant.task === AntTask.DEFENDING
    ? 0.38
    : 0.16;
  const antFreq = signaling ? time * 26 + ant.id : ant.antennaPhase;
  rig.leftAntenna.rotation.y = Math.sin(antFreq) * antAmp;
  rig.leftAntenna.rotation.z = Math.cos(antFreq * 1.3) * antAmp * 0.65;
  rig.rightAntenna.rotation.y = -Math.sin(antFreq + 0.7) * antAmp;
  rig.rightAntenna.rotation.z = Math.cos(antFreq * 1.1 + 0.5) * antAmp * 0.65;

  // Mandible clamp/open animation
  const biting = ant.task === AntTask.DEFENDING || ant.task === AntTask.EXCAVATING;
  const carrying = ant.payload !== PayloadType.NONE;
  const mandOpen = biting
    ? 0.25 + Math.abs(Math.sin(time * 16 + ant.id)) * 0.35
    : carrying
    ? 0.16
    : 0.32 + Math.sin(time * 3 + ant.id) * 0.05;
  rig.leftMandible.rotation.y = mandOpen;
  rig.rightMandible.rotation.y = -mandOpen;

  // Multi-joint curvature flex across neck, petiole waist, and gaster!
  const gasterBob =
    Math.sin(time * (signaling ? 18 : 3.5) + ant.id) * (signaling ? 0.16 : 0.045) +
    (ant.task === AntTask.DEFENDING ? 0.22 : 0);

  rig.bodyGroup.position.y = rig.baseBodyY + rig.smoothBodyDip;
  rig.neckPivot.rotation.z = rig.smoothHeadPitch * 0.92;
  rig.neckPivot.rotation.y = rig.smoothHeadYaw * 0.85;
  rig.petiolePivot.rotation.z = rig.smoothTailPitch * 0.48;
  rig.petiolePivot.rotation.y = rig.smoothTailYaw * 0.45;
  rig.gasterPivot.rotation.z = rig.smoothTailPitch * 0.52 + gasterBob;
  rig.gasterPivot.rotation.y = rig.smoothTailYaw * 0.55;

  // Legs last: they depend on the final body pose (root transform, body dip) this frame.
  if (ground && worldVel) updateLegs(rig.legSet, rig.bodyGroup, worldVel, dt, ground);

  // Sync visible 3D payload
  for (const key in rig.payloadMeshes) {
    rig.payloadMeshes[key].visible = false;
  }
  if (ant.payload !== PayloadType.NONE && rig.payloadMeshes[ant.payload]) {
    rig.payloadMeshes[ant.payload].visible = true;
  }
}

export interface IntruderRig {
  root: THREE.Group;
  bodyGroup: THREE.Group;
  neckPivot?: THREE.Group;
  tailPivots: THREE.Group[]; // chained abdomen/elytra hinges
  legs: { hip: THREE.Group; side: -1 | 1; index: number; baseYaw: number }[];
  segments: THREE.Group[]; // centipede multi-segment spine
  segmentBaseX: number[];
  leftPincer?: THREE.Object3D;
  rightPincer?: THREE.Object3D;
  stolenFoodMesh: THREE.Mesh;
  species: Intruder['species'];
  currentQuat: THREE.Quaternion;
  hasInitOrientation: boolean;
  smoothPos: THREE.Vector3;
  hasInitPos: boolean;
  zLane: number;
  baseBodyY: number;
  smoothHeadPitch: number;
  smoothTailPitch: number;
  smoothHeadYaw: number;
  smoothTailYaw: number;
  smoothHeadY: number;
  smoothTailY: number;
  smoothHeadZ: number;
  smoothTailZ: number;
  smoothBodyDip: number;
}

export function createIntruderRig(
  species: Intruder['species'],
  bank: MaterialBank,
  geo: GeometryBank
): IntruderRig {
  const root = new THREE.Group();
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const legs: IntruderRig['legs'] = [];
  const segments: THREE.Group[] = [];
  const segmentBaseX: number[] = [];
  const tailPivots: THREE.Group[] = [];
  let neckPivot: THREE.Group | undefined;
  let leftPincer: THREE.Object3D | undefined;
  let rightPincer: THREE.Object3D | undefined;
  let baseBodyY = 0.055;

  const stolenFoodMesh = new THREE.Mesh(geo.icosa0, bank.seedMat);
  stolenFoodMesh.scale.set(0.055, 0.04, 0.04);
  stolenFoodMesh.visible = false;

  if (species === 'beetle') {
    baseBodyY = 0.075;
    bodyGroup.position.y = baseBodyY;

    // Articulated rear elytra/abdomen pivot
    const elytraPivot = new THREE.Group();
    elytraPivot.position.set(0.03, 0.022, 0);
    bodyGroup.add(elytraPivot);
    tailPivots.push(elytraPivot);

    const elytra = new THREE.Mesh(geo.icosa1, bank.beetleShell);
    elytra.scale.set(0.17, 0.09, 0.125);
    elytra.position.set(-0.08, 0.003, 0);
    elytra.castShadow = true;
    elytraPivot.add(elytra);

    const pronotum = new THREE.Mesh(geo.icosa0, bank.beetleThorax);
    pronotum.scale.set(0.08, 0.068, 0.095);
    pronotum.position.set(0.095, 0.015, 0);
    pronotum.castShadow = true;
    bodyGroup.add(pronotum);

    // Articulated neck + head + mandibles
    neckPivot = new THREE.Group();
    neckPivot.position.set(0.13, 0.009, 0);
    bodyGroup.add(neckPivot);

    const head = new THREE.Mesh(geo.icosa0, bank.beetleThorax);
    head.scale.set(0.055, 0.045, 0.065);
    head.position.set(0.035, -0.004, 0);
    neckPivot.add(head);

    const lm = new THREE.Mesh(geo.cone5, bank.mandible);
    lm.scale.set(0.016, 0.055, 0.014);
    lm.rotation.z = -Math.PI * 0.5;
    lm.rotation.y = 0.35;
    lm.position.set(0.09, -0.014, -0.028);
    neckPivot.add(lm);
    leftPincer = lm;

    const rm = new THREE.Mesh(geo.cone5, bank.mandible);
    rm.scale.set(0.016, 0.055, 0.014);
    rm.rotation.z = -Math.PI * 0.5;
    rm.rotation.y = -0.35;
    rm.position.set(0.09, -0.014, 0.028);
    neckPivot.add(rm);
    rightPincer = rm;

    stolenFoodMesh.position.set(0.10, -0.009, 0);
    neckPivot.add(stolenFoodMesh);

    const legX = [0.09, 0.01, -0.07];
    const yaws = [0.55, 0, -0.55];
    for (let i = 0; i < 3; i++) {
      for (const side of [-1, 1] as const) {
        const hip = new THREE.Group();
        hip.position.set(legX[i], -0.015, side * 0.06);
        hip.rotation.y = side * yaws[i];
        const leg = new THREE.Mesh(geo.cyl6, bank.beetleThorax);
        leg.scale.set(0.009, 0.095, 0.009);
        leg.rotation.x = side * 0.9;
        leg.position.set(0, -0.025, side * 0.045);
        hip.add(leg);
        bodyGroup.add(hip);
        legs.push({ hip, side, index: i, baseYaw: side * yaws[i] });
      }
    }
  } else if (species === 'mite') {
    baseBodyY = 0.052;
    bodyGroup.position.y = baseBodyY;
    // Parasitic Soil Mite: crimson carapace + articulated gnathosoma head + 8 legs
    const dome = new THREE.Mesh(geo.icosa1, bank.miteBody);
    dome.scale.set(0.11, 0.075, 0.095);
    dome.position.set(-0.01, 0.015, 0);
    dome.castShadow = true;
    bodyGroup.add(dome);

    neckPivot = new THREE.Group();
    neckPivot.position.set(0.068, 0.005, 0);
    bodyGroup.add(neckPivot);

    const head = new THREE.Mesh(geo.icosa0, bank.miteLeg);
    head.scale.set(0.04, 0.032, 0.04);
    head.position.set(0.027, -0.005, 0);
    neckPivot.add(head);

    const legX = [0.065, 0.025, -0.02, -0.065];
    const yaws = [0.65, 0.25, -0.25, -0.65];
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1] as const) {
        const hip = new THREE.Group();
        hip.position.set(legX[i], -0.01, side * 0.055);
        hip.rotation.y = side * yaws[i];
        const leg = new THREE.Mesh(geo.cyl6, bank.miteLeg);
        leg.scale.set(0.006, 0.08, 0.006);
        leg.rotation.x = side * 0.95;
        leg.position.set(0, -0.02, side * 0.035);
        hip.add(leg);
        bodyGroup.add(hip);
        legs.push({ hip, side, index: i, baseYaw: side * yaws[i] });
      }
    }
    neckPivot.add(stolenFoodMesh);
  } else if (species === 'earwig') {
    baseBodyY = 0.058;
    bodyGroup.position.y = baseBodyY;
    // Earwig: articulated neck+head, mesothorax, and 3-jointed flexible abdomen + forceps!
    const thorax = new THREE.Mesh(geo.icosa0, bank.earwigPincer);
    thorax.scale.set(0.078, 0.046, 0.06);
    thorax.position.set(0.065, 0.014, 0);
    bodyGroup.add(thorax);

    neckPivot = new THREE.Group();
    neckPivot.position.set(0.112, 0.012, 0);
    bodyGroup.add(neckPivot);

    const head = new THREE.Mesh(geo.icosa0, bank.earwigBody);
    head.scale.set(0.048, 0.038, 0.052);
    head.position.set(0.038, -0.002, 0);
    neckPivot.add(head);

    stolenFoodMesh.position.set(0.098, -0.012, 0);
    neckPivot.add(stolenFoodMesh);

    const abd1 = new THREE.Group();
    abd1.position.set(0.015, 0.012, 0);
    bodyGroup.add(abd1);
    const seg1 = new THREE.Mesh(geo.icosa0, bank.earwigBody);
    seg1.scale.set(0.064, 0.046, 0.060);
    seg1.position.set(-0.035, 0, 0);
    seg1.castShadow = true;
    abd1.add(seg1);

    const abd2 = new THREE.Group();
    abd2.position.set(-0.068, 0, 0);
    abd1.add(abd2);
    const seg2 = new THREE.Mesh(geo.icosa0, bank.earwigBody);
    seg2.scale.set(0.064, 0.048, 0.064);
    seg2.position.set(-0.034, 0, 0);
    seg2.castShadow = true;
    abd2.add(seg2);

    const abd3 = new THREE.Group();
    abd3.position.set(-0.068, 0, 0);
    abd2.add(abd3);
    const seg3 = new THREE.Mesh(geo.icosa0, bank.earwigBody);
    seg3.scale.set(0.056, 0.042, 0.054);
    seg3.position.set(-0.032, 0, 0);
    seg3.castShadow = true;
    abd3.add(seg3);

    tailPivots.push(abd1, abd2, abd3);

    // Rear curved forceps pincers on final hinged segment
    const lp = new THREE.Mesh(geo.cone5, bank.earwigPincer);
    lp.scale.set(0.013, 0.085, 0.011);
    lp.rotation.z = Math.PI * 0.5;
    lp.rotation.y = -0.25;
    lp.position.set(-0.082, 0.003, -0.022);
    abd3.add(lp);
    leftPincer = lp;

    const rp = new THREE.Mesh(geo.cone5, bank.earwigPincer);
    rp.scale.set(0.013, 0.085, 0.011);
    rp.rotation.z = Math.PI * 0.5;
    rp.rotation.y = 0.25;
    rp.position.set(-0.082, 0.003, 0.022);
    abd3.add(rp);
    rightPincer = rp;

    const legX = [0.09, 0.02, -0.05];
    const yaws = [0.5, 0, -0.5];
    for (let i = 0; i < 3; i++) {
      for (const side of [-1, 1] as const) {
        const hip = new THREE.Group();
        hip.position.set(legX[i], -0.008, side * 0.038);
        hip.rotation.y = side * yaws[i];
        const leg = new THREE.Mesh(geo.cyl6, bank.earwigPincer);
        leg.scale.set(0.006, 0.078, 0.006);
        leg.rotation.x = side * 0.9;
        leg.position.set(0, -0.02, side * 0.034);
        hip.add(leg);
        bodyGroup.add(hip);
        legs.push({ hip, side, index: i, baseYaw: side * yaws[i] });
      }
    }
  } else if (species === 'rival_ant') {
    // Rival Marauder Ant: articulated neck+head, thorax+legs, petiole waist + crimson segmented gaster
    bodyGroup.scale.setScalar(1.06);
    baseBodyY = 0.04;
    bodyGroup.position.y = baseBodyY;

    const petiolePivot = new THREE.Group();
    petiolePivot.position.set(-0.026, 0.010, 0);
    bodyGroup.add(petiolePivot);

    const petiole = new THREE.Mesh(geo.icosa0, bank.rivalAntBody);
    petiole.scale.set(0.026, 0.02, 0.02);
    petiole.position.set(-0.019, 0, 0);
    petiolePivot.add(petiole);

    const gasterPivot = new THREE.Group();
    gasterPivot.position.set(-0.036, 0.004, 0);
    petiolePivot.add(gasterPivot);

    const gasterBand = new THREE.Mesh(geo.icosa0, bank.rivalAntBody);
    gasterBand.scale.set(0.052, 0.048, 0.052);
    gasterBand.position.set(-0.025, 0.006, 0);
    gasterPivot.add(gasterBand);

    const gaster = new THREE.Mesh(geo.icosa0, bank.rivalAntAbdomen);
    gaster.scale.set(0.092, 0.06, 0.06);
    gaster.position.set(-0.053, 0.004, 0);
    gaster.castShadow = true;
    gasterPivot.add(gaster);

    tailPivots.push(petiolePivot, gasterPivot);

    const thorax = new THREE.Mesh(geo.icosa0, bank.rivalAntBody);
    thorax.scale.set(0.072, 0.038, 0.036);
    thorax.position.set(0.018, 0.014, 0);
    thorax.castShadow = true;
    bodyGroup.add(thorax);

    neckPivot = new THREE.Group();
    neckPivot.position.set(0.082, 0.015, 0);
    bodyGroup.add(neckPivot);

    const head = new THREE.Mesh(geo.icosa0, bank.rivalAntBody);
    head.scale.set(0.05, 0.04, 0.046);
    head.position.set(0.03, 0.001, 0);
    head.castShadow = true;
    neckPivot.add(head);

    const lm = new THREE.Mesh(geo.cone5, bank.mandible);
    lm.scale.set(0.013, 0.042, 0.01);
    lm.rotation.z = -Math.PI * 0.5;
    lm.rotation.y = 0.36;
    lm.position.set(0.083, -0.007, -0.018);
    neckPivot.add(lm);
    leftPincer = lm;

    const rm = new THREE.Mesh(geo.cone5, bank.mandible);
    rm.scale.set(0.013, 0.042, 0.01);
    rm.rotation.z = -Math.PI * 0.5;
    rm.rotation.y = -0.36;
    rm.position.set(0.083, -0.007, 0.018);
    neckPivot.add(rm);
    rightPincer = rm;

    for (const side of [-1, 1] as const) {
      const antMesh = new THREE.Mesh(geo.cyl6, bank.rivalAntBody);
      antMesh.scale.set(0.0035, 0.052, 0.0035);
      antMesh.rotation.z = -1.05;
      antMesh.rotation.x = side * 0.38;
      antMesh.position.set(0.073, 0.021, side * 0.022);
      neckPivot.add(antMesh);
    }

    stolenFoodMesh.position.set(0.098, -0.007, 0);
    neckPivot.add(stolenFoodMesh);

    const legX = [0.05, 0.01, -0.03];
    const yaws = [0.55, 0, -0.58];
    for (let i = 0; i < 3; i++) {
      for (const side of [-1, 1] as const) {
        const hip = new THREE.Group();
        hip.position.set(legX[i], -0.004, side * 0.024);
        hip.rotation.y = side * yaws[i];
        const leg = new THREE.Mesh(geo.cyl6, bank.rivalAntBody);
        leg.scale.set(0.005, 0.068, 0.005);
        leg.rotation.x = side * 0.92;
        leg.position.set(0, -0.015, side * 0.028);
        hip.add(leg);
        bodyGroup.add(hip);
        legs.push({ hip, side, index: i, baseYaw: side * yaws[i] });
      }
    }
  } else {
    // Centipede: head + 6 terrain-conforming undulating segments + 12 legs
    baseBodyY = 0.055;
    bodyGroup.position.y = baseBodyY;
    const headSeg = new THREE.Group();
    headSeg.position.set(0.22, 0.01, 0);
    const head = new THREE.Mesh(geo.icosa0, bank.centipedeBody);
    head.scale.set(0.06, 0.04, 0.058);
    head.castShadow = true;
    headSeg.add(head);

    const lf = new THREE.Mesh(geo.cone5, bank.mandible);
    lf.scale.set(0.012, 0.05, 0.01);
    lf.rotation.z = -Math.PI * 0.5;
    lf.rotation.y = 0.42;
    lf.position.set(0.065, -0.004, -0.022);
    headSeg.add(lf);
    leftPincer = lf;

    const rf = new THREE.Mesh(geo.cone5, bank.mandible);
    rf.scale.set(0.012, 0.05, 0.01);
    rf.rotation.z = -Math.PI * 0.5;
    rf.rotation.y = -0.42;
    rf.position.set(0.065, -0.004, 0.022);
    headSeg.add(rf);
    rightPincer = rf;

    bodyGroup.add(headSeg);
    segments.push(headSeg);
    segmentBaseX.push(0.22);

    for (let s = 0; s < 6; s++) {
      const seg = new THREE.Group();
      const bx = 0.13 - s * 0.088;
      seg.position.set(bx, 0.008, 0);
      const body = new THREE.Mesh(geo.icosa0, s % 2 === 0 ? bank.centipedeBody : bank.centipedeSegment);
      body.scale.set(0.055, 0.036, 0.052);
      body.castShadow = true;
      seg.add(body);

      for (const side of [-1, 1] as const) {
        const hip = new THREE.Group();
        hip.position.set(0, -0.008, side * 0.035);
        const leg = new THREE.Mesh(geo.cyl6, bank.centipedeSegment);
        leg.scale.set(0.0055, 0.085, 0.0055);
        leg.rotation.x = side * 1.0;
        leg.position.set(0, -0.018, side * 0.038);
        hip.add(leg);
        seg.add(hip);
        legs.push({ hip, side, index: s, baseYaw: 0 });
      }
      bodyGroup.add(seg);
      segments.push(seg);
      segmentBaseX.push(bx);
    }
    stolenFoodMesh.position.set(0.08, -0.005, 0);
    headSeg.add(stolenFoodMesh);
  }

  return {
    root,
    bodyGroup,
    neckPivot,
    tailPivots,
    legs,
    segments,
    segmentBaseX,
    leftPincer,
    rightPincer,
    stolenFoodMesh,
    species,
    currentQuat: new THREE.Quaternion(),
    hasInitOrientation: false,
    smoothPos: new THREE.Vector3(),
    hasInitPos: false,
    zLane: 0.22,
    baseBodyY,
    smoothHeadPitch: 0,
    smoothTailPitch: 0,
    smoothHeadYaw: 0,
    smoothTailYaw: 0,
    smoothHeadY: 0,
    smoothTailY: 0,
    smoothHeadZ: 0,
    smoothTailZ: 0,
    smoothBodyDip: 0,
  };
}

export function animateIntruderRig(rig: IntruderRig, m: Intruder, time: number): void {
  const phase = m.legPhase;
  for (const leg of rig.legs) {
    const wave = Math.sin(phase + leg.index * 1.15 + (leg.side > 0 ? Math.PI : 0));
    leg.hip.rotation.y = leg.baseYaw + wave * 0.36;
    leg.hip.rotation.x = Math.max(0, Math.cos(phase + leg.index * 1.15)) * 0.18 * leg.side;
  }

  rig.bodyGroup.position.y = rig.baseBodyY + rig.smoothBodyDip;

  if (rig.neckPivot) {
    rig.neckPivot.rotation.z = rig.smoothHeadPitch * 0.92;
    rig.neckPivot.rotation.y = rig.smoothHeadYaw * 0.85;
  }

  if (rig.tailPivots.length > 0) {
    const share = 1 / rig.tailPivots.length;
    for (let i = 0; i < rig.tailPivots.length; i++) {
      rig.tailPivots[i].rotation.z = rig.smoothTailPitch * share * 1.05;
      rig.tailPivots[i].rotation.y = rig.smoothTailYaw * share * 1.05;
    }
  }

  if (rig.species === 'centipede') {
    const halfSpan = 0.28;
    for (let s = 0; s < rig.segments.length; s++) {
      const seg = rig.segments[s];
      const u = Math.max(-1.2, Math.min(1.2, rig.segmentBaseX[s] / halfSpan));
      // Lagrange quadratic spline through (-1, tail), (0, center=0), (+1, head)
      const curveY = 0.5 * u * (u + 1) * rig.smoothHeadY + 0.5 * u * (u - 1) * rig.smoothTailY;
      const curveZ = 0.5 * u * (u + 1) * rig.smoothHeadZ + 0.5 * u * (u - 1) * rig.smoothTailZ;
      const dYdU = (u + 0.5) * rig.smoothHeadY + (u - 0.5) * rig.smoothTailY;
      const dZdU = (u + 0.5) * rig.smoothHeadZ + (u - 0.5) * rig.smoothTailZ;
      const pitchZ = Math.atan2(dYdU, halfSpan);
      const yawZ = -Math.atan2(dZdU, halfSpan);

      seg.position.y = (s === 0 ? 0.01 : 0.008) + Math.max(-0.18, Math.min(0.18, curveY));
      seg.position.z =
        Math.sin(time * 9 - s * 0.85 + m.id) * 0.042 +
        Math.max(-0.14, Math.min(0.14, curveZ));
      seg.rotation.z = Math.max(-0.85, Math.min(0.85, pitchZ));
      seg.rotation.y = Math.cos(time * 9 - s * 0.85 + m.id) * 0.16 + Math.max(-0.65, Math.min(0.65, yawZ));
    }
  }

  if (rig.leftPincer && rig.rightPincer) {
    const snap = Math.sin(time * 10 + m.id) * 0.14;
    if (rig.species === 'earwig') {
      rig.leftPincer.rotation.y = -0.25 + snap;
      rig.rightPincer.rotation.y = 0.25 - snap;
    } else {
      rig.leftPincer.rotation.y = 0.36 + snap;
      rig.rightPincer.rotation.y = -0.36 - snap;
    }
  }

  rig.stolenFoodMesh.visible = (m.carryingFoodAmount ?? 0) > 0;
}

export function createSproutMesh(
  sprout: PlantSprout,
  bank: MaterialBank,
  geo: GeometryBank
): THREE.Group {
  const g = new THREE.Group();
  const h = sprout.height * WORLD_SCALE;

  if (sprout.kind === 'moss') {
    const count = 3;
    for (let i = 0; i < count; i++) {
      const dome = new THREE.Mesh(geo.icosa0, bank.mossMat);
      const r = h * (0.7 + i * 0.2);
      dome.scale.set(r * 1.4, r * 0.72, r * 1.25);
      dome.position.set((i - 1) * r * 0.65, r * 0.32, (i % 2 === 0 ? 1 : -1) * 0.06);
      dome.castShadow = true;
      dome.receiveShadow = true;
      g.add(dome);
    }
  } else if (sprout.kind === 'grass') {
    for (let i = 0; i < 3; i++) {
      const blade = new THREE.Mesh(geo.cone5, bank.grassMat);
      const bh = h * (0.82 + (i % 2) * 0.28);
      blade.scale.set(0.025, bh, 0.012);
      blade.position.set((i - 1) * 0.032, bh * 0.5, (i - 1) * 0.025);
      blade.rotation.z = (i - 1) * 0.18;
      blade.castShadow = true;
      g.add(blade);
    }
  } else if (sprout.kind === 'clover') {
    const stem = new THREE.Mesh(geo.cyl6, bank.cloverMat);
    stem.scale.set(0.01, h, 0.01);
    stem.position.y = h * 0.5;
    g.add(stem);

    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      const leaf = new THREE.Mesh(geo.icosa0, bank.cloverMat);
      leaf.scale.set(0.065, 0.016, 0.055);
      leaf.position.set(Math.cos(a) * 0.048, h, Math.sin(a) * 0.048);
      leaf.rotation.y = -a;
      leaf.castShadow = true;
      g.add(leaf);
    }
  } else {
    // Low-poly Fern frond with angled leaflets
    const stalk = new THREE.Mesh(geo.cyl6, bank.grassMat);
    stalk.scale.set(0.012, h, 0.012);
    stalk.position.y = h * 0.48;
    stalk.rotation.z = -0.14;
    g.add(stalk);

    for (let k = 0; k < 5; k++) {
      const t = 0.35 + (k / 5) * 0.6;
      const y = h * t;
      const span = (1 - t * 0.55) * 0.11;
      for (const s of [-1, 1]) {
        const frond = new THREE.Mesh(geo.tetra0, bank.grassMat);
        frond.scale.set(span, 0.014, 0.045);
        frond.position.set(s * span * 0.6 + t * 0.03, y, s * 0.02);
        frond.rotation.z = s * 0.3;
        frond.castShadow = true;
        g.add(frond);
      }
    }
  }

  return g;
}

export function createSurfacePropMesh(
  prop: SurfaceProp,
  bank: MaterialBank,
  geo: GeometryBank
): THREE.Group {
  const g = new THREE.Group();
  const w = prop.width * WORLD_SCALE;
  const h = prop.height * WORLD_SCALE;

  if (prop.kind === 'bark') {
    const log = new THREE.Mesh(geo.icosa1, bank.barkMat);
    log.scale.set(w * 0.52, h * 0.52, 0.2);
    log.position.y = h * 0.32;
    log.castShadow = true;
    log.receiveShadow = true;
    g.add(log);

    const ridge = new THREE.Mesh(geo.icosa0, bank.barkMat);
    ridge.scale.set(w * 0.38, h * 0.36, 0.15);
    ridge.position.set(-w * 0.12, h * 0.52, 0.03);
    ridge.castShadow = true;
    g.add(ridge);

    const mossCap = new THREE.Mesh(geo.icosa0, bank.mossMat);
    mossCap.scale.set(w * 0.22, h * 0.25, 0.13);
    mossCap.position.set(w * 0.15, h * 0.62, 0.02);
    g.add(mossCap);
  } else if (prop.kind === 'stone') {
    const rock = new THREE.Mesh(geo.icosa0, bank.pebbleMat);
    rock.scale.set(w * 0.5, h * 0.52, 0.22);
    rock.position.y = h * 0.34;
    rock.rotation.set(prop.seed * 0.4, prop.seed, 0.1);
    rock.castShadow = true;
    rock.receiveShadow = true;
    g.add(rock);

    const chip = new THREE.Mesh(geo.icosa0, bank.pebbleMat);
    chip.scale.set(w * 0.26, h * 0.32, 0.14);
    chip.position.set(w * 0.28, h * 0.22, 0.07);
    chip.castShadow = true;
    g.add(chip);
  } else if (prop.kind === 'outcrop') {
    // Craggy multi-boulder edge outcrop with shadowed ground-level crevice where rival ants emerge
    const dirToCenter = prop.x < 700 ? 1 : -1;

    const crevice = new THREE.Mesh(geo.icosa0, bank.creviceShadowMat);
    crevice.scale.set(w * 0.32, h * 0.24, 0.24);
    crevice.position.set(dirToCenter * w * 0.16, h * 0.14, 0.03);
    g.add(crevice);

    const mainBoulder = new THREE.Mesh(geo.icosa0, bank.outcropRockMat);
    mainBoulder.scale.set(w * 0.56, h * 0.58, 0.42);
    mainBoulder.position.set(-dirToCenter * w * 0.12, h * 0.36, -0.02);
    mainBoulder.rotation.set(0.25, prop.seed, dirToCenter * 0.14);
    mainBoulder.castShadow = true;
    mainBoulder.receiveShadow = true;
    g.add(mainBoulder);

    const capShelf = new THREE.Mesh(geo.icosa0, bank.outcropRockMat);
    capShelf.scale.set(w * 0.44, h * 0.34, 0.36);
    capShelf.position.set(dirToCenter * w * 0.1, h * 0.54, 0.04);
    capShelf.rotation.set(-0.2, prop.seed * 0.7, -dirToCenter * 0.22);
    capShelf.castShadow = true;
    capShelf.receiveShadow = true;
    g.add(capShelf);

    const sideStone = new THREE.Mesh(geo.icosa0, bank.pebbleMat);
    sideStone.scale.set(w * 0.28, h * 0.26, 0.28);
    sideStone.position.set(dirToCenter * w * 0.42, h * 0.16, 0.12);
    sideStone.rotation.set(0.4, prop.seed * 1.4, 0.2);
    sideStone.castShadow = true;
    sideStone.receiveShadow = true;
    g.add(sideStone);

    const mossShelf = new THREE.Mesh(geo.icosa0, bank.mossMat);
    mossShelf.scale.set(w * 0.26, h * 0.12, 0.24);
    mossShelf.position.set(-dirToCenter * w * 0.04, h * 0.72, 0.03);
    mossShelf.receiveShadow = true;
    g.add(mossShelf);
  } else {
    const leaf = new THREE.Mesh(geo.icosa0, bank.leafMat);
    leaf.scale.set(w * 0.52, 0.025, 0.16);
    leaf.position.y = 0.02;
    leaf.rotation.z = prop.angle;
    leaf.castShadow = true;
    g.add(leaf);
  }

  g.rotation.z = prop.angle;
  return g;
}
