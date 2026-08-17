/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * VFX ENGINE — Minimal IVFXPool Implementation for WeaponEngine Integration
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * This is a lightweight stand-in that satisfies the IVFXPool contract.
 * Replace or extend with your full particle/shader system as needed.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { Scene, Vector3, ParticleSystem, Texture, Color4 } from "@babylonjs/core";
import { IVFXPool, IVFXRequest, VFXType, Vec2 } from "./WeaponEngine";

interface VFXBlueprint {
  capacity: number;
  textureUrl: string;
  minLife: number;
  maxLife: number;
  minSize: number;
  maxSize: number;
  emitRate: number;
  gravity: Vector3;
  color1: Color4;
  color2: Color4;
}

export class VFXEngine implements IVFXPool {
  private _scene: Scene;
  private _textures = new Map<string, Texture>();
  private _pools = new Map<string, ParticleSystem[]>();

  constructor(scene: Scene) {
    this._scene = scene;
    this._registerBlueprints();
  }

  private _registerBlueprints(): void {
    // Pre-allocate a small number of common burst systems
    this._ensurePool("impact_spark", {
      capacity: 50, textureUrl: "/assets/vfx/spark.png",
      minLife: 0.1, maxLife: 0.4, minSize: 0.2, maxSize: 0.8,
      emitRate: 0, gravity: new Vector3(0, -2, 0),
      color1: new Color4(1, 0.8, 0.2, 1), color2: new Color4(1, 0.2, 0, 0),
    });
    this._ensurePool("blood_spray", {
      capacity: 80, textureUrl: "/assets/vfx/blood.png",
      minLife: 0.2, maxLife: 0.6, minSize: 0.3, maxSize: 1.0,
      emitRate: 0, gravity: new Vector3(0, -4, 0),
      color1: new Color4(0.7, 0.05, 0.05, 1), color2: new Color4(0.3, 0, 0, 0),
    });
    this._ensurePool("bone_shatter", {
      capacity: 60, textureUrl: "/assets/vfx/bone_frag.png",
      minLife: 0.3, maxLife: 0.8, minSize: 0.4, maxSize: 1.2,
      emitRate: 0, gravity: new Vector3(0, -6, 0),
      color1: new Color4(0.9, 0.9, 0.85, 1), color2: new Color4(0.5, 0.5, 0.4, 0),
    });
    this._ensurePool("fire_burst", {
      capacity: 100, textureUrl: "/assets/vfx/fire.png",
      minLife: 0.4, maxLife: 1.0, minSize: 0.5, maxSize: 2.0,
      emitRate: 0, gravity: new Vector3(0, 1, 0),
      color1: new Color4(1, 0.3, 0, 1), color2: new Color4(0.3, 0, 0, 0),
    });
    this._ensurePool("ice_shatter", {
      capacity: 60, textureUrl: "/assets/vfx/ice.png",
      minLife: 0.3, maxLife: 0.9, minSize: 0.4, maxSize: 1.2,
      emitRate: 0, gravity: new Vector3(0, -1, 0),
      color1: new Color4(0.7, 0.9, 1, 1), color2: new Color4(0.1, 0.3, 0.5, 0),
    });
    this._ensurePool("lightning_arc", {
      capacity: 40, textureUrl: "/assets/vfx/lightning.png",
      minLife: 0.1, maxLife: 0.3, minSize: 0.5, maxSize: 1.5,
      emitRate: 0, gravity: Vector3.Zero(),
      color1: new Color4(0.8, 0.9, 1, 1), color2: new Color4(0.2, 0.4, 1, 0),
    });
    this._ensurePool("swarm_cloud", {
      capacity: 120, textureUrl: "/assets/vfx/swarm.png",
      minLife: 0.5, maxLife: 1.2, minSize: 0.5, maxSize: 1.8,
      emitRate: 0, gravity: new Vector3(0, 0.5, 0),
      color1: new Color4(0.3, 0.5, 0.1, 0.8), color2: new Color4(0.1, 0.2, 0, 0),
    });
  }

  private _ensurePool(name: string, bp: VFXBlueprint): void {
    const sys = new ParticleSystem(`vfx_${name}`, bp.capacity, this._scene);
    sys.particleTexture = this._getTexture(bp.textureUrl);
    sys.minLifeTime = bp.minLife;
    sys.maxLifeTime = bp.maxLife;
    sys.minSize = bp.minSize;
    sys.maxSize = bp.maxSize;
    sys.emitRate = bp.emitRate;
    sys.gravity = bp.gravity;
    sys.color1 = bp.color1;
    sys.color2 = bp.color2;
    sys.disposeOnStop = false;
    sys.targetStopDuration = bp.maxLife + 0.2;

    const pool: ParticleSystem[] = [sys];
    this._pools.set(name, pool);
  }

  private _getTexture(url: string): Texture {
    if (!this._textures.has(url)) {
      const tex = new Texture(url, this._scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
      tex.hasAlpha = true;
      this._textures.set(url, tex);
    }
    return this._textures.get(url)!;
  }

  spawn(req: IVFXRequest): void {
    const pool = this._pools.get(req.type);
    let sys = pool?.find((s) => !s.isStarted());
    if (!sys) {
      // Hot-expand if all systems busy
      const blueprint = this._pools.get(req.type)?.[0];
      if (!blueprint) return;
      sys = blueprint.clone();
      sys.name = `${req.type}_clone_${Math.random().toString(36).slice(2, 6)}`;
      pool?.push(sys);
    }
    sys.emitter = new Vector3(req.pos.x, 1.5, req.pos.y);
    sys.manualEmitCount = req.count ?? 10;
    sys.minSize = (req.scale ?? 1) * sys.minSize;
    sys.maxSize = (req.scale ?? 1) * sys.maxSize;
    sys.start();
    sys.onStopObservable.addOnce(() => sys?.stop());
  }

  spawnBurst(pos: Vec2, type: VFXType, count: number, radius: number): void {
    this.spawn({ type, pos, count, scale: 1 + radius * 0.02 });
  }

  dispose(): void {
    for (const pool of this._pools.values()) {
      for (const sys of pool) sys.dispose();
    }
    for (const tex of this._textures.values()) tex.dispose();
    this._pools.clear();
    this._textures.clear();
  }
}
