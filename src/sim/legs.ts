import * as THREE from 'three';

/**
 * Procedural insect leg system.
 *
 * Every foot is *planted* at a fixed world position on the terrain surface. A two-bone IK solve bends
 * the leg to reach the planted foot, so as the body moves, turns, climbs or stops the legs follow
 * naturally instead of playing a canned sine-wave swing. A foot only lifts and swings forward when the
 * body has carried it out of comfortable reach. Legs step in alternating tripod groups
 * (L-front, R-mid, L-rear) vs (R-front, L-mid, R-rear): a group may only start stepping while the other
 * group is fully planted, which gives the classic insect gait without any explicit phase clock.
 *
 * All quantities named *Local* are in the ant bodyGroup's local space (units before the caste scale).
 */

export interface LegGeometryParams {
  /** hip (coxa) attachment, bodyGroup-local */
  hip: THREE.Vector3;
  /** resting foot x/z offset (y is derived from current body height) */
  restX: number;
  restZ: number;
  femurLen: number;
  tibiaLen: number;
  tarsusLen: number;
}

export interface Leg {
  side: -1 | 1;
  index: 0 | 1 | 2;
  /** 0 = tripod A (L0,R1,L2), 1 = tripod B (R0,L1,R2) */
  group: 0 | 1;
  hip: THREE.Vector3;
  restX: number;
  restZ: number;
  femurLen: number;
  tibiaLen: number;
  tarsusLen: number;
  femur: THREE.Mesh;
  tibia: THREE.Mesh;
  tarsus: THREE.Mesh;
  /** planted (or in-flight) foot tip, world space */
  foot: THREE.Vector3;
  stepFrom: THREE.Vector3;
  /** -1 when planted, otherwise swing progress 0..1 */
  stepT: number;
  stepDur: number;
}

export interface LegSet {
  legs: Leg[];
  initialized: boolean;
  /** counts, for diagnostics/tests */
  stepsTaken: number;
  emergencySteps: number;
}

/** Samples the terrain surface nearest the given world point. Writes the contact point into `out`. */
export type GroundSampler = (wx: number, wy: number, wz: number, out: THREE.Vector3) => void;

const TRIGGER_DIST = 0.04; // local units a foot may drift from rest before it must step
const MATE_TRIGGER = 0.1; // the whole tripod steps together (mates barely off rest still move)
const EMERGENCY_MULT = 2.4;
const LIFT_HEIGHT = 0.026;

const _inv = new THREE.Matrix4();
const _rot = new THREE.Quaternion();
const _rotInv = new THREE.Quaternion();
const _restW = new THREE.Vector3();
const _destW = new THREE.Vector3();
const _footL = new THREE.Vector3();
const _velL = new THREE.Vector3();
const _upW = new THREE.Vector3();
const _ankle = new THREE.Vector3();
const _knee = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _yAxis = new THREE.Vector3(0, 1, 0);
const _scaleV = new THREE.Vector3();

export function createLegSet(): LegSet {
  return { legs: [], initialized: false, stepsTaken: 0, emergencySteps: 0 };
}

function easeInOut(t: number): number {
  return t * t * (3 - 2 * t);
}

function placeSegment(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, radius: number): void {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-6) return;
  _dir.multiplyScalar(1 / len);
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(_yAxis, _dir);
  mesh.scale.set(radius, len, radius);
}

/** Two-bone IK in bodyGroup-local space. Returns knee position in `outKnee`; `target` may be clamped. */
function solveTwoBone(
  hip: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  side: number,
  outKnee: THREE.Vector3
): void {
  _dir.subVectors(target, hip);
  let dist = _dir.length();
  if (dist < 1e-6) {
    _dir.set(0, -1, 0);
    dist = 1e-6;
  } else {
    _dir.multiplyScalar(1 / dist);
  }
  const maxR = l1 + l2 - 1e-4;
  const minR = Math.abs(l1 - l2) + 1e-3;
  const d = Math.min(maxR, Math.max(minR, dist));
  if (d !== dist) target.copy(hip).addScaledVector(_dir, d);

  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

  // Insect knees bend up and slightly outward.
  _pole.set(0, 1, side * 0.5);
  _pole.addScaledVector(_dir, -_pole.dot(_dir));
  if (_pole.lengthSq() < 1e-8) _pole.set(0, 1, 0);
  _pole.normalize();

  outKnee.copy(hip).addScaledVector(_dir, a).addScaledVector(_pole, h);
}

/**
 * Advance foot planting/stepping and pose the leg meshes.
 *
 * @param bodyGroup   ant body group (its world matrix is refreshed here)
 * @param worldVel    body world-space velocity (units/s)
 * @param ground      terrain sampler
 */
export function updateLegs(
  set: LegSet,
  bodyGroup: THREE.Group,
  worldVel: THREE.Vector3,
  dt: number,
  ground: GroundSampler
): void {
  const legs = set.legs;
  if (legs.length === 0) return;

  bodyGroup.updateWorldMatrix(true, false);
  _inv.copy(bodyGroup.matrixWorld).invert();
  bodyGroup.matrixWorld.decompose(_tmp, _rot, _scaleV);
  const scale = _scaleV.x || 1;
  _upW.set(0, 1, 0).applyQuaternion(_rot);

  // Body velocity in local units/s
  _velL.copy(worldVel).applyQuaternion(_rotInv.copy(_rot).invert()).multiplyScalar(1 / scale);
  const speedL = Math.hypot(_velL.x, _velL.z);
  const groundY = -bodyGroup.position.y / scale;

  /**
   * Foot landing point for `leg`: its rest slot (plus a lead along the direction of travel), shaped by the
   * terrain. The terrain sample is validated against the body's own ground plane so a bad sample on a
   * steep contour (or at a tunnel corner) can never drive a foot into the soil or far off its slot.
   */
  const sampleFoot = (leg: Leg, lead: number, out: THREE.Vector3): void => {
    let lx = leg.restX;
    let lz = leg.restZ;
    if (lead > 0 && speedL > 1e-4) {
      lx += (_velL.x / speedL) * lead;
      lz += (_velL.z / speedL) * lead;
    }
    _restW.set(lx, groundY, lz).applyMatrix4(bodyGroup.matrixWorld);
    ground(_restW.x, _restW.y, _restW.z, _tmp);
    _tmp.applyMatrix4(_inv);
    const plausible =
      Math.hypot(_tmp.x - lx, _tmp.z - lz) < 0.03 && Math.abs(_tmp.y - groundY) < 0.035;
    if (plausible) {
      out.set(_tmp.x, _tmp.y, _tmp.z);
    } else {
      out.set(lx, groundY, lz);
    }
    out.applyMatrix4(bodyGroup.matrixWorld);
  };

  if (!set.initialized) {
    for (const leg of legs) {
      sampleFoot(leg, 0, leg.foot);
      leg.stepT = -1;
    }
    set.initialized = true;
  }

  // ---- Decide which legs must step -------------------------------------------------------------
  const groupStepping = [false, false];
  const groupWorst = [0, 0];
  const errs: number[] = new Array(legs.length);
  const emergency: boolean[] = new Array(legs.length);

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.stepT >= 0) {
      groupStepping[leg.group] = true;
      errs[i] = 0;
      emergency[i] = false;
      continue;
    }
    _footL.copy(leg.foot).applyMatrix4(_inv);
    const errXZ = Math.hypot(_footL.x - leg.restX, _footL.z - leg.restZ);
    _ankle.set(_footL.x, _footL.y + leg.tarsusLen * 0.88, _footL.z - leg.side * leg.tarsusLen * 0.38);
    const stretched = _ankle.distanceTo(leg.hip) > (leg.femurLen + leg.tibiaLen) * 0.95;
    const heightErr = Math.abs(_footL.y - groundY) > 0.02;
    errs[i] = errXZ + (heightErr ? TRIGGER_DIST : 0);
    emergency[i] = errXZ > TRIGGER_DIST * EMERGENCY_MULT || stretched;
    if (errs[i] > groupWorst[leg.group]) groupWorst[leg.group] = errs[i];
  }

  const startStep = (leg: Leg): void => {
    leg.stepFrom.copy(leg.foot);
    leg.stepT = 0;
    // Faster walking => shorter swing. Stationary re-stances are slow and deliberate.
    // Swing must finish before the *other* tripod's feet drift out of reach, so it scales with 1/speed.
    leg.stepDur = Math.min(0.2, Math.max(0.04, (TRIGGER_DIST * 0.9) / Math.max(speedL, 0.2)));
    set.stepsTaken++;
  };

  const chooseGroup =
    groupWorst[0] >= groupWorst[1] ? 0 : 1;
  for (const g of [chooseGroup, 1 - chooseGroup] as const) {
    if (groupWorst[g] < TRIGGER_DIST || groupStepping[1 - g]) continue;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (leg.group !== g || leg.stepT >= 0) continue;
      if (errs[i] >= TRIGGER_DIST * MATE_TRIGGER) {
        startStep(leg);
        groupStepping[g] = true;
      }
    }
  }
  // Overstretched legs cannot wait for their turn.
  for (let i = 0; i < legs.length; i++) {
    if (emergency[i] && legs[i].stepT < 0) {
      startStep(legs[i]);
      set.emergencySteps++;
    }
  }

  // ---- Advance swings, IK, pose meshes -----------------------------------------------------------
  for (const leg of legs) {
    if (leg.stepT >= 0) {
      leg.stepT += dt / leg.stepDur;
      const lead = Math.min(TRIGGER_DIST * 0.85, speedL * (leg.stepDur * 0.5 + 0.04));
      sampleFoot(leg, lead, _destW);
      const t = Math.min(1, leg.stepT);
      const e = easeInOut(t);
      leg.foot.lerpVectors(leg.stepFrom, _destW, e);
      leg.foot.addScaledVector(_upW, Math.sin(Math.PI * t) * LIFT_HEIGHT * scale);
      if (leg.stepT >= 1) {
        leg.foot.copy(_destW);
        leg.stepT = -1;
      }
    }

    // IK happens in body-local space: foot tip -> ankle (lifted along local up, slightly toward body)
    _footL.copy(leg.foot).applyMatrix4(_inv);
    _ankle.set(_footL.x, _footL.y + leg.tarsusLen * 0.88, _footL.z - leg.side * leg.tarsusLen * 0.38);
    solveTwoBone(leg.hip, _ankle, leg.femurLen, leg.tibiaLen, leg.side, _knee);

    placeSegment(leg.femur, leg.hip, _knee, 0.0052);
    placeSegment(leg.tibia, _knee, _ankle, 0.0038);
    _tmp.copy(_footL);
    placeSegment(leg.tarsus, _ankle, _tmp, 0.0026);
  }
}

/** Hard-reset all feet (e.g. after the ant is teleported) so they re-plant on the next update. */
export function resetLegs(set: LegSet): void {
  set.initialized = false;
}
