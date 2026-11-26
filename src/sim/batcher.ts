import * as THREE from 'three';

interface Bucket {
  mesh: THREE.InstancedMesh;
  count: number;
}

/**
 * Draws many articulated rigs with a handful of draw calls.
 *
 * Each ant is still built as an ordinary Object3D hierarchy (so the leg IK and joint animation code is unchanged),
 * but the hierarchy is never added to the scene. After animating, every visible part's world matrix is copied into an
 * InstancedMesh shared by all parts with the same geometry + material. ~40 parts x 150 ants used to cost ~6000 draw
 * calls a frame (shadow pass included); this brings it down to a few dozen.
 */
export class MeshBatcher {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly shadows: boolean
  ) {}

  begin(): void {
    for (const b of this.buckets.values()) b.count = 0;
  }

  /** Queue all visible meshes of a rig (whose world matrices are already up to date). */
  addAll(meshes: THREE.Mesh[]): void {
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m.visible) continue;
      this.add(m);
    }
  }

  add(m: THREE.Mesh): void {
    const mat = m.material as THREE.Material;
    const key = m.geometry.id + ':' + mat.id;
    let b = this.buckets.get(key);
    if (!b) {
      b = { mesh: this.makeInstanced(m.geometry, mat, 64, m.castShadow), count: 0 };
      this.buckets.set(key, b);
    }
    if (b.count >= b.mesh.instanceMatrix.count) this.grow(b);
    b.mesh.setMatrixAt(b.count++, m.matrixWorld);
  }

  end(): void {
    for (const b of this.buckets.values()) {
      if (b.mesh.count !== b.count || b.count > 0) {
        b.mesh.count = b.count;
        b.mesh.instanceMatrix.needsUpdate = true;
      }
      b.mesh.visible = b.count > 0;
    }
  }

  private makeInstanced(geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, castShadow: boolean): THREE.InstancedMesh {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = this.shadows && castShadow;
    im.receiveShadow = false;
    this.scene.add(im);
    return im;
  }

  private grow(b: Bucket): void {
    const old = b.mesh;
    const next = this.makeInstanced(old.geometry, old.material as THREE.Material, old.instanceMatrix.count * 2, old.castShadow);
    (next.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    this.scene.remove(old);
    old.dispose();
    b.mesh = next;
  }

  dispose(): void {
    for (const b of this.buckets.values()) {
      this.scene.remove(b.mesh);
      b.mesh.dispose();
    }
    this.buckets.clear();
  }
}

/** All meshes in a rig, collected once so per-frame batching doesn't have to traverse the hierarchy. */
export function collectMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
  });
  return out;
}
