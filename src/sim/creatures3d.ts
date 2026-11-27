import * as THREE from 'three';
import type { Creature, CreatureKind } from './types';

/**
 * Low-poly wildlife built from primitives: bird, spider (with web), antlion pit, anteater, earthworm.
 * Every rig faces +x; the renderer mirrors it with scale.x for creatures walking left.
 */

export interface CreatureRig {
  kind: CreatureKind;
  root: THREE.Group;
  parts: Record<string, THREE.Object3D>;
  disposables: (THREE.BufferGeometry | THREE.Material)[];
  /** worm body segments */
  segs?: THREE.Mesh[];
  /** gait phase (advances with distance walked) and how much it is moving right now (0..1) */
  walk: number;
  moveAmp: number;
}

const flat = (color: number, rough = 0.85): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, flatShading: true });

export function createCreatureRig(kind: CreatureKind): CreatureRig {
  const root = new THREE.Group();
  const parts: Record<string, THREE.Object3D> = {};
  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const sphere = new THREE.IcosahedronGeometry(1, 1);
  const cone = new THREE.ConeGeometry(1, 1, 6);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 6);
  disposables.push(sphere, cone, box, cyl);
  const mesh = (g: THREE.BufferGeometry, m: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0) => {
    const o = new THREE.Mesh(g, m);
    o.scale.set(sx, sy, sz);
    o.position.set(x, y, z);
    o.castShadow = true;
    return o;
  };

  if (kind === 'bird') {
    const brown = flat(0x7a5a3a);
    const light = flat(0xd9c7a3);
    const dark = flat(0x2f2418);
    const beakM = flat(0xe0a32e);
    disposables.push(brown, light, dark, beakM);
    const body = new THREE.Group();
    body.add(mesh(sphere, brown, 0.62, 0.42, 0.36));
    body.add(mesh(sphere, light, 0.46, 0.3, 0.34, 0.1, -0.1, 0));
    const neck = new THREE.Group();
    neck.position.set(0.5, 0.18, 0);
    neck.add(mesh(sphere, brown, 0.28, 0.26, 0.24, 0.1, 0.1, 0));
    neck.add(mesh(sphere, dark, 0.05, 0.05, 0.05, 0.28, 0.17, 0.12));
    const beak = mesh(cone, beakM, 0.09, 0.3, 0.09, 0.46, 0.1, 0);
    beak.rotation.z = -Math.PI / 2;
    neck.add(beak);
    body.add(neck);
    const tail = mesh(box, dark, 0.55, 0.06, 0.22, -0.72, 0.05, 0);
    tail.rotation.z = 0.18;
    body.add(tail);
    const wing = new THREE.Group();
    wing.position.set(-0.05, 0.14, 0.2);
    wing.add(mesh(sphere, dark, 0.52, 0.07, 0.3, -0.3, 0, 0));
    const wing2 = wing.clone();
    wing2.position.z = -0.2;
    body.add(wing, wing2);
    const legM = flat(0xc08a3a);
    disposables.push(legM);
    const legs = new THREE.Group();
    for (const z of [0.1, -0.1]) legs.add(mesh(cyl, legM, 0.02, 0.4, 0.02, 0.05, -0.38, z));
    body.add(legs);
    root.add(body);
    parts.body = body;
    parts.neck = neck;
    parts.wing = wing;
    parts.wing2 = wing2;
    parts.legs = legs;
    body.position.y = 0.55;
  } else if (kind === 'anteater') {
    const fur = flat(0x5b4a3a);
    const dark = flat(0x1f1812);
    const stripe = flat(0xe8e2d2);
    const tongueM = flat(0xd9627a);
    disposables.push(fur, dark, stripe, tongueM);
    const body = new THREE.Group();
    body.add(mesh(sphere, fur, 1.0, 0.46, 0.5));
    const stripeM = mesh(box, stripe, 0.12, 0.8, 0.52, 0.35, 0.04, 0);
    stripeM.rotation.z = -0.55;
    body.add(stripeM);
    // long tapering snout
    const head = new THREE.Group();
    head.position.set(1.0, 0.1, 0);
    const snout = mesh(cone, fur, 0.2, 1.3, 0.2, 0.62, -0.05, 0);
    snout.rotation.z = -Math.PI / 2 - 0.12;
    head.add(snout);
    head.add(mesh(sphere, dark, 0.07, 0.07, 0.07, 0.15, 0.17, 0.2));
    const tongue = mesh(cyl, tongueM, 0.025, 1, 0.025, 1.3, -0.12, 0);
    tongue.rotation.z = Math.PI / 2;
    tongue.visible = false;
    head.add(tongue);
    body.add(head);
    // huge bushy tail
    const tail = mesh(sphere, fur, 0.85, 0.3, 0.28, -1.5, 0.05, 0);
    tail.rotation.z = 0.3;
    body.add(tail);
    const legs: THREE.Group[] = [];
    for (const [x, z] of [[0.65, 0.3], [0.65, -0.3], [-0.55, 0.3], [-0.55, -0.3]] as const) {
      const leg = new THREE.Group();
      leg.position.set(x, -0.25, z);
      leg.add(mesh(cyl, dark, 0.09, 0.6, 0.09, 0, -0.28, 0));
      const claw = mesh(cone, stripe, 0.06, 0.2, 0.06, 0.1, -0.6, 0);
      claw.rotation.z = -Math.PI / 2.6;
      leg.add(claw);
      body.add(leg);
      legs.push(leg);
    }
    body.position.y = 0.95;
    root.add(body);
    parts.body = body;
    parts.head = head;
    parts.tongue = tongue;
    parts.leg0 = legs[0];
    parts.leg1 = legs[1];
    parts.leg2 = legs[2];
    parts.leg3 = legs[3];
  } else if (kind === 'spider') {
    const bodyM = flat(0x2c2230);
    const mark = flat(0xc9a34a);
    disposables.push(bodyM, mark);
    const body = new THREE.Group();
    body.add(mesh(sphere, bodyM, 0.2, 0.19, 0.19));
    body.add(mesh(sphere, bodyM, 0.28, 0.25, 0.25, -0.34, 0, 0));
    body.add(mesh(sphere, mark, 0.1, 0.05, 0.07, -0.36, 0.2, 0));
    for (const s of [1, -1]) {
      for (let k = 0; k < 4; k++) {
        const leg = new THREE.Group();
        leg.position.set(0.1 - k * 0.09, 0, 0.05 * s);
        const a = (k - 1.5) * 0.45;
        const upper = mesh(cyl, bodyM, 0.012, 0.32, 0.012, 0, 0.14, 0);
        upper.position.set(0.12 * Math.sin(a), 0.1, 0.12 * s);
        upper.rotation.set(0.9 * s, 0, -a * 0.4);
        const lower = mesh(cyl, bodyM, 0.01, 0.34, 0.01, 0.0, -0.1, 0.34 * s);
        lower.rotation.set(-0.5 * s, 0, a * 0.5);
        leg.add(upper, lower);
        body.add(leg);
        parts[`leg${s > 0 ? 'a' : 'b'}${k}`] = leg;
      }
    }
    root.add(body);
    parts.body = body;
    body.position.y = 0.26;
    // the web: radial threads and a spiral, hanging in the plane beside the spider
    const web = new THREE.Group();
    const pts: number[] = [];
    const R = 0.9;
    const spokes = 9;
    for (let i = 0; i < spokes; i++) {
      const a = (i / spokes) * Math.PI * 2;
      pts.push(0, 0, 0, Math.cos(a) * R, Math.sin(a) * R * 0.9, 0);
    }
    for (let ring = 1; ring <= 5; ring++) {
      const r = (ring / 5) * R;
      for (let i = 0; i < spokes; i++) {
        const a0 = (i / spokes) * Math.PI * 2;
        const a1 = ((i + 1) / spokes) * Math.PI * 2;
        pts.push(Math.cos(a0) * r, Math.sin(a0) * r * 0.9, 0, Math.cos(a1) * r, Math.sin(a1) * r * 0.9, 0);
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const wm = new THREE.LineBasicMaterial({ color: 0xe8eef5, transparent: true, opacity: 0.55 });
    disposables.push(wg, wm);
    web.add(new THREE.LineSegments(wg, wm));
    web.position.set(0.1, 1.15, -0.05);
    parts.web = web;
    root.add(web);
    body.position.set(0.1, 1.1, 0);
  } else if (kind === 'antlion') {
    // seen side-on: a sandy funnel notched into the ground, jaws at the bottom
    const sand = flat(0xb59f70, 1);
    const jawM = flat(0x4a3320);
    disposables.push(sand, jawM);
    const shape = new THREE.Shape();
    shape.moveTo(-0.5, 0);
    shape.lineTo(0.5, 0);
    shape.lineTo(0.06, -0.42);
    shape.lineTo(-0.06, -0.42);
    shape.closePath();
    const g = new THREE.ShapeGeometry(shape);
    disposables.push(g);
    const funnel = new THREE.Mesh(g, sand);
    funnel.position.z = 0.02;
    root.add(funnel);
    const jaws = new THREE.Group();
    for (const s of [1, -1]) {
      const j = mesh(cone, jawM, 0.03, 0.16, 0.03, 0.06 * s, -0.4, 0.04);
      j.rotation.z = s * 0.5;
      jaws.add(j);
    }
    jaws.position.z = 0.03;
    root.add(jaws);
    parts.jaws = jaws;
  } else if (kind === 'ladybug') {
    const red = flat(0xd8281f, 0.4);
    const black = flat(0x15110f, 0.5);
    const white = flat(0xf4f1e8, 0.5);
    disposables.push(red, black, white);
    const body = new THREE.Group();
    const dome = mesh(sphere, red, 0.13, 0.095, 0.11);
    body.add(dome);
    body.add(mesh(box, black, 0.003, 0.09, 0.1, 0, 0.0, 0));
    // spots sit on the flank facing the viewer (z>0) and mirrored on the far side
    for (const sz of [1, -1])
      for (const [x, y] of [[0.06, 0.02], [-0.04, 0.045], [-0.07, -0.01], [0.02, -0.025]] as const)
        body.add(mesh(sphere, black, 0.03, 0.026, 0.014, x, y, sz * 0.098));
    const head = mesh(sphere, black, 0.045, 0.045, 0.06, 0.13, -0.015, 0);
    body.add(head);
    body.add(mesh(sphere, white, 0.012, 0.014, 0.014, 0.165, 0.0, 0.035));
    body.add(mesh(sphere, white, 0.012, 0.014, 0.014, 0.165, 0.0, -0.035));
    // six jointed legs (hip -> femur -> knee -> tibia); a tripod gait swings them in animateCreatureRig
    const legs = new THREE.Group();
    let li = 0;
    for (const hx of [0.07, 0.0, -0.07]) {
      for (const side of [1, -1]) {
        const swing = new THREE.Group();
        swing.position.set(hx, -0.055, side * 0.055);
        const splay = new THREE.Group();
        splay.rotation.x = side * 0.75; // legs reach out sideways, then down
        swing.add(splay);
        splay.add(mesh(cyl, black, 0.008, 0.05, 0.008, 0, -0.025, 0));
        const knee = new THREE.Group();
        knee.position.y = -0.05;
        knee.rotation.x = -side * 0.8;
        splay.add(knee);
        knee.add(mesh(cyl, black, 0.007, 0.055, 0.007, 0, -0.027, 0));
        knee.add(mesh(sphere, black, 0.011, 0.011, 0.011, 0, -0.055, 0));
        legs.add(swing);
        parts[`sw${li}`] = swing;
        parts[`kn${li}`] = knee;
        li++;
      }
    }
    body.add(legs);
    const wingM = flat(0xdcd8cf, 0.3);
    disposables.push(wingM);
    const wing = mesh(sphere, wingM, 0.13, 0.008, 0.045, -0.03, 0.1, 0.09);
    wing.visible = false;
    body.add(wing);
    body.position.y = 0.12;
    root.add(body);
    parts.body = body;
    parts.legs = legs;
    parts.wing = wing;
    parts.dome = dome;
  } else {
    // earthworm: chain of pink segments positioned by the renderer
    const pink = flat(0xd9867f, 0.55);
    const band = flat(0xc2645d, 0.5);
    disposables.push(pink, band);
    const segs: THREE.Mesh[] = [];
    for (let i = 0; i < 9; i++) {
      const m = mesh(sphere, i === 2 ? band : pink, 0.085, 0.07, 0.07);
      segs.push(m);
      root.add(m);
    }
    return { kind, root, parts, disposables, segs, walk: 0, moveAmp: 0 };
  }
  return { kind, root, parts, disposables, walk: 0, moveAmp: 0 };
}

const wob = (t: number, f: number) => Math.sin(t * f);

/** Per-frame pose. `moving` is whether the creature is travelling (legs / wings go). */
export function animateCreatureRig(rig: CreatureRig, c: Creature, time: number): void {
  const p = rig.parts;
  if (rig.kind === 'bird') {
    const flying = c.state === 'arriving' || c.state === 'leaving';
    const flap = flying ? wob(time, 22) * 0.9 : 0;
    p.wing.rotation.z = flying ? 0.5 + flap : -0.15;
    p.wing2.rotation.z = flying ? 0.5 + flap : -0.15;
    p.legs.visible = !flying;
    const peck = c.state === 'pecking' ? Math.max(0, wob(time, 5)) : 0;
    p.neck.rotation.z = -peck * 1.0;
    p.body.rotation.z = flying ? (c.state === 'leaving' ? 0.35 : -0.15) : -peck * 0.3;
    p.body.position.y = flying ? 0.55 : 0.55 + Math.abs(wob(time, 3)) * 0.04;
  } else if (rig.kind === 'anteater') {
    const walking = c.state === 'approach' || c.state === 'leaving';
    const swing = walking ? wob(time, 5) * 0.5 : 0;
    p.leg0.rotation.z = swing;
    p.leg3.rotation.z = swing;
    p.leg1.rotation.z = -swing;
    p.leg2.rotation.z = -swing;
    p.body.position.y = 0.95 + (walking ? Math.abs(wob(time, 5)) * 0.04 : 0);
    const digging = c.state === 'digging';
    p.head.rotation.z = digging ? -0.5 + wob(time, 9) * 0.12 : wob(time, 2) * 0.05;
    // the two fore legs rake while digging
    if (digging) {
      p.leg0.rotation.z = wob(time, 10) * 0.9;
      p.leg1.rotation.z = -wob(time, 10) * 0.9;
    }
    p.tongue.visible = digging && wob(time, 4) > 0.55;
  } else if (rig.kind === 'spider') {
    const dart = c.state === 'wrapping' ? wob(time, 20) * 0.05 : wob(time, 1.2) * 0.012;
    p.body.position.y = 1.1 + dart;
    for (const k of ['a', 'b']) for (let i = 0; i < 4; i++) p[`leg${k}${i}`].rotation.z = wob(time * 0.8 + i, 2) * 0.08;
    p.web.rotation.z = wob(time, 0.6) * 0.01;
  } else if (rig.kind === 'ladybug') {
    const flying = c.state === 'flying' || c.state === 'leaving';
    p.wing.visible = flying;
    p.wing.rotation.x = flying ? wob(time, 60) * 0.6 : 0;
    p.dome.rotation.z = flying ? 0.35 : 0;
    p.body.rotation.z = flying ? (c.state === 'leaving' ? 0.4 : -0.3) : 0;
    // tripod gait: front-left, mid-right, rear-left step together, the other three in antiphase
    const amp = rig.moveAmp;
    for (let i = 0; i < 6; i++) {
      const side = i % 2 === 0 ? 1 : -1;
      const row = Math.floor(i / 2);
      const grp = (row % 2 === 0 ? 1 : 0) ^ (side > 0 ? 0 : 1);
      const ph = rig.walk + grp * Math.PI;
      const swingA = Math.sin(ph) * 0.5 * amp;
      const lift = Math.max(0, Math.cos(ph)) * 0.55 * amp; // foot comes up while it swings forward
      p[`sw${i}`].rotation.z = swingA + (row - 1) * 0.12;
      (p[`kn${i}`] as THREE.Object3D).rotation.z = -lift * 0.6;
      p[`sw${i}`].position.y = -0.055 + lift * 0.012;
    }
    p.body.position.y = 0.12 + Math.abs(Math.sin(rig.walk)) * 0.006 * amp;
    p.legs.visible = !flying;
  } else if (rig.kind === 'antlion') {
    p.jaws.position.y = c.state === 'flinging' ? wob(time, 25) * 0.04 : 0;
    p.jaws.scale.setScalar(c.state === 'flinging' ? 1.3 : 1);
  }
}

export function disposeCreatureRig(rig: CreatureRig): void {
  for (const d of rig.disposables) d.dispose();
}
