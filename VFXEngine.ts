/**
 * VFXEngine.ts
 * Data-driven Particle System Pool for Babylon.js
 * 
 * Architecture:
 * - Pre-allocated object pools per effect type to eliminate runtime GC.
 * - Shared Texture instances to reduce GPU memory overhead.
 * - Strict min/max lifetime enforcement with auto-recycle hooks.
 * - Hard pool caps to guarantee framerate during horde-survival scenarios.
 */

import {
  Scene,
  Vector3,
  ParticleSystem,
  Texture,
  Color4,
} from "@babylonjs/core";

/* -----------------------------------------------------------------------------
   DATA INTERFACES
   ----------------------------------------------------------------------------- */

export interface VFXBlueprint {
  /** Max simultaneous particles for this system (pre-allocated buffer). */
  capacity: number;
  /** Filename relative to textureRoot. */
  textureUrl: string;
  /** Babylon blend mode (e.g. ParticleSystem.BLENDMODE_ONEONE). */
  blendMode: number;
  /** Strict lifetime floor (seconds). */
  minLifeTime: number;
  /** Strict lifetime ceiling (seconds). */
  maxLifeTime: number;
  minSize: number;
  maxSize: number;
  minEmitPower: number;
  maxEmitPower: number;
  /** Base emit rate; overridden to 0 for burst-only systems. */
  emitRate: number;
  gravity: Vector3;
  direction1: Vector3;
  direction2: Vector3;
  /** Color ramp (factor 0..1 -> Color4). */
  colorGradients: Array<{ factor: number; color: Color4 }>;
  /** Optional size ramp (factor 0..1 -> size). */
  sizeGradients?: Array<{ factor: number; size: number }>;
  /** Rotational velocity range (rad/s). */
  angularSpeed1?: number;
  angularSpeed2?: number;
  /** Initial Z-rotation range (rad) for sprite variation. */
  minInitialRotation?: number;
  maxInitialRotation?: number;
  /** Billboard alignment (default true). */
  billboard?: boolean;
}

/* -----------------------------------------------------------------------------
   POOL MANAGER
   ----------------------------------------------------------------------------- */

export class ParticleFXPool {
  private readonly _scene: Scene;
  private readonly _textureRoot: string;
  private readonly _maxPoolSize: number;

  /** Effect name -> construction blueprint. */
  private readonly _blueprints: Map<string, VFXBlueprint> = new Map();
  /** Effect name -> idle ParticleSystem stack. */
  private readonly _pools: Map<string, ParticleSystem[]> = new Map();
  /** Effect name -> currently active systems (for capping). */
  private readonly _active: Map<string, Set<ParticleSystem>> = new Map();
  /** Effect name -> shared Texture instance. */
  private readonly _textures: Map<string, Texture> = new Map();

  constructor(
    scene: Scene,
    textureRoot: string = "./assets/textures/vfx/",
    maxPoolSize: number = 8
  ) {
    this._scene = scene;
    this._textureRoot = textureRoot;
    this._maxPoolSize = maxPoolSize;

    this._registerBlueprints();
    this._preallocatePools();
  }

  /* ---------------------------------------------------------------------------
     BLUEPRINT REGISTRY
     Maps logical effect names to dark-fantasy particle configurations.
     --------------------------------------------------------------------------- */

  private _registerBlueprints(): void {
    // --- Blood Spray: visceral crimson splatter ----------------------------
    this._blueprints.set("blood_spray", {
      capacity: 300,
      textureUrl: "blood_spray.png",
      blendMode: ParticleSystem.BLENDMODE_STANDARD,
      minLifeTime: 0.15,
      maxLifeTime: 0.55,
      minSize: 0.2,
      maxSize: 0.9,
      minEmitPower: 1.5,
      maxEmitPower: 4.0,
      emitRate: 0,
      gravity: new Vector3(0, -6.0, 0),
      direction1: new Vector3(-1, 0.5, -1),
      direction2: new Vector3(1, 1.5, 1),
      colorGradients: [
        { factor: 0.0, color: new Color4(0.7, 0.05, 0.05, 1.0) },
        { factor: 0.3, color: new Color4(0.5, 0.0, 0.0, 0.9) },
        { factor: 0.7, color: new Color4(0.2, 0.0, 0.0, 0.4) },
        { factor: 1.0, color: new Color4(0.05, 0.0, 0.0, 0.0) },
      ],
      sizeGradients: [
        { factor: 0.0, size: 0.4 },
        { factor: 0.2, size: 1.0 },
        { factor: 0.6, size: 0.8 },
        { factor: 1.0, size: 0.1 },
      ],
      angularSpeed1: 0,
      angularSpeed2: 2.0,
      minInitialRotation: 0,
      maxInitialRotation: Math.PI * 2,
    });

    // --- Void Glow: additive cosmic vortex halos ---------------------------
    this._blueprints.set("void_glow", {
      capacity: 400,
      textureUrl: "void_glow.png",
      blendMode: ParticleSystem.BLENDMODE_ONEONE,
      minLifeTime: 0.8,
      maxLifeTime: 1.6,
      minSize: 0.5,
      maxSize: 2.5,
      minEmitPower: 0.3,
      maxEmitPower: 1.2,
      emitRate: 0,
      gravity: new Vector3(0, 0.2, 0),
      direction1: new Vector3(-0.5, -0.5, -0.5),
      direction2: new Vector3(0.5, 0.5, 0.5),
      colorGradients: [
        { factor: 0.0, color: new Color4(0.4, 0.1, 0.6, 1.0) },
        { factor: 0.4, color: new Color4(0.2, 0.0, 0.5, 0.9) },
        { factor: 0.8, color: new Color4(0.05, 0.0, 0.2, 0.5) },
        { factor: 1.0, color: new Color4(0.0, 0.0, 0.0, 0.0) },
      ],
      sizeGradients: [
        { factor: 0.0, size: 0.2 },
        { factor: 0.5, size: 1.5 },
        { factor: 1.0, size: 2.8 },
      ],
      angularSpeed1: -1.5,
      angularSpeed2: 1.5,
      minInitialRotation: 0,
      maxInitialRotation: Math.PI,
    });

    // --- Frost Haze: translucent cyan ice clouds -----------------------------
    this._blueprints.set("frost_haze", {
      capacity: 250,
      textureUrl: "frost_haze.png",
      blendMode: ParticleSystem.BLENDMODE_STANDARD,
      minLifeTime: 1.2,
      maxLifeTime: 2.8,
      minSize: 1.0,
      maxSize: 3.5,
      minEmitPower: 0.1,
      maxEmitPower: 0.6,
      emitRate: 0,
      gravity: new Vector3(0, 0.3, 0),
      direction1: new Vector3(-0.8, 0, -0.8),
      direction2: new Vector3(0.8, 0.5, 0.8),
      colorGradients: [
        { factor: 0.0, color: new Color4(0.7, 0.9, 1.0, 0.6) },
        { factor: 0.3, color: new Color4(0.4, 0.8, 0.95, 0.5) },
        { factor: 0.7, color: new Color4(0.1, 0.4, 0.7, 0.2) },
        { factor: 1.0, color: new Color4(0.0, 0.1, 0.3, 0.0) },
      ],
      sizeGradients: [
        { factor: 0.0, size: 1.0 },
        { factor: 0.4, size: 2.5 },
        { factor: 1.0, size: 4.0 },
      ],
      angularSpeed1: -0.5,
      angularSpeed2: 0.5,
      minInitialRotation: 0,
      maxInitialRotation: Math.PI * 2,
    });
  }

  /* ---------------------------------------------------------------------------
     TEXTURE & POOL FACTORY
     --------------------------------------------------------------------------- */

  /** Loads or returns a cached Texture to avoid redundant GPU uploads. */
  private _getTexture(name: string, url: string): Texture {
    if (!this._textures.has(name)) {
      const tex = new Texture(
        this._textureRoot + url,
        this._scene,
        true,   // noMipmap = false (generate mipmaps for distance scaling)
        false,  // invertY
        Texture.TRILINEAR_SAMPLINGMODE
      );
      tex.hasAlpha = true;
      tex.wrapU = Texture.WRAP_ADDRESSMODE;
      tex.wrapV = Texture.WRAP_ADDRESSMODE;
      this._textures.set(name, tex);
    }
    return this._textures.get(name)!;
  }

  /** Eagerly instantiate a baseline number of systems to eliminate hitches. */
  private _preallocatePools(): void {
    for (const [name, blueprint] of this._blueprints) {
      const pool: ParticleSystem[] = [];
      const active: Set<ParticleSystem> = new Set();

      // Pre-warm 50% of max so memory is reserved but not fully committed.
      const prealloc = Math.max(2, Math.floor(this._maxPoolSize / 2));
      for (let i = 0; i < prealloc; i++) {
        pool.push(this._buildSystem(name, blueprint));
      }

      this._pools.set(name, pool);
      this._active.set(name, active);
    }
  }

  /** Constructs a single ParticleSystem from a blueprint. */
  private _buildSystem(name: string, bp: VFXBlueprint): ParticleSystem {
    const sys = new ParticleSystem(
      `vfx_${name}_${Math.random().toString(36).substring(2, 7)}`,
      bp.capacity,
      this._scene
    );

    // -- Texture binding ----------------------------------------------------
    sys.particleTexture = this._getTexture(name, bp.textureUrl);

    // -- Strict lifetime & performance rules --------------------------------
    sys.minLifeTime = bp.minLifeTime;
    sys.maxLifeTime = bp.maxLifeTime;
    sys.minSize = bp.minSize;
    sys.maxSize = bp.maxSize;
    sys.minEmitPower = bp.minEmitPower;
    sys.maxEmitPower = bp.maxEmitPower;
    sys.emitRate = bp.emitRate; // 0: burst-only, no background emission
    sys.gravity = bp.gravity;
    sys.direction1 = bp.direction1;
    sys.direction2 = bp.direction2;
    sys.blendMode = bp.blendMode;
    sys.billboard = bp.billboard ?? true;
    sys.disposeOnStop = false;

    // Lock update step to 60fps equivalent for deterministic WebGPU/CPU sync
    sys.updateSpeed = 1.0 / 60.0;

    // -- Color ramps --------------------------------------------------------
    sys.clearColorGradients();
    for (const g of bp.colorGradients) {
      sys.addColorGradient(g.factor, g.color);
    }

    // -- Size ramps ---------------------------------------------------------
    if (bp.sizeGradients) {
      sys.clearSizeGradients();
      for (const g of bp.sizeGradients) {
        sys.addSizeGradient(g.factor, g.size);
      }
    }

    // -- Rotational velocity for organic motion ------------------------------
    if (bp.angularSpeed1 !== undefined && bp.angularSpeed2 !== undefined) {
      sys.minAngularSpeed = bp.angularSpeed1;
      sys.maxAngularSpeed = bp.angularSpeed2;
    }
    if (bp.minInitialRotation !== undefined && bp.maxInitialRotation !== undefined) {
      sys.minInitialRotation = bp.minInitialRotation;
      sys.maxInitialRotation = bp.maxInitialRotation;
    }

    // -- Emitter shape: zero-volume box for point bursts --------------------
    sys.createBoxEmitter(
      bp.direction1,
      bp.direction2,
      Vector3.Zero(),
      Vector3.Zero()
    );

    return sys;
  }

  /* ---------------------------------------------------------------------------
     POOL ACQUIRE / RELEASE
     --------------------------------------------------------------------------- */

  /** Pulls an idle system from the stack, or creates one if under the hard cap. */
  private _acquire(name: string): ParticleSystem | null {
    const pool = this._pools.get(name);
    const active = this._active.get(name);
    if (!pool || !active) return null;

    if (pool.length > 0) {
      const sys = pool.pop()!;
      active.add(sys);
      return sys;
    }

    // Hot-path expansion: allowed only if we haven't hit the absolute ceiling.
    const total = active.size + pool.length;
    if (total < this._maxPoolSize) {
      const blueprint = this._blueprints.get(name);
      if (!blueprint) return null;
      const sys = this._buildSystem(name, blueprint);
      active.add(sys);
      return sys;
    }

    // Hard cap reached: silently drop to protect frame time.
    return null;
  }

  /** Returns a system to the idle stack or disposes it if the stack is full. */
  private _release(sys: ParticleSystem, name: string): void {
    const pool = this._pools.get(name);
    const active = this._active.get(name);
    if (!pool || !active) return;

    sys.stop();
    sys.reset();
    active.delete(sys);

    if (pool.length < this._maxPoolSize) {
      pool.push(sys);
    } else {
      sys.dispose(); // Keep memory flat
    }
  }

  /* ---------------------------------------------------------------------------
     PUBLIC API
     --------------------------------------------------------------------------- */

  /**
   * Fire a one-shot particle burst at a world position.
   *
   * @param effectName - "blood_spray" | "void_glow" | "frost_haze"
   * @param position   - World-space Vector3 origin
   * @param count      - Number of particles to emit (respects system capacity)
   */
  public emitBurst(effectName: string, position: Vector3, count: number): void {
    const sys = this._acquire(effectName);
    if (!sys) return;

    const bp = this._blueprints.get(effectName)!;

    // Move emitter to burst origin (Vector3 emitter = zero-GC friendly)
    sys.emitter = position.clone();

    // Clamp burst to pre-allocated capacity to avoid buffer resize stalls
    sys.manualEmitCount = Math.min(count, bp.capacity);

    // Auto-terminate after the longest possible particle life + render margin
    sys.targetStopDuration = bp.maxLifeTime + 0.25;

    // Recycle once the system fully stops
    sys.onStopObservable.clear();
    sys.onStopObservable.addOnce(() => {
      this._release(sys, effectName);
    });

    sys.start();
  }

  /**
   * Aggressively pre-warm a pool before a heavy combat sequence.
   * Call during loading screens or room transitions.
   */
  public warmPool(effectName: string, targetSize: number): void {
    const bp = this._blueprints.get(effectName);
    const pool = this._pools.get(effectName);
    const active = this._active.get(effectName);
    if (!bp || !pool || !active) return;

    const currentTotal = pool.length + active.size;
    const toAdd = Math.min(targetSize - pool.length, this._maxPoolSize - currentTotal);
    for (let i = 0; i < toAdd; i++) {
      pool.push(this._buildSystem(effectName, bp));
    }
  }

  /** Total active particle systems (for HUD debug / profiling). */
  public getActiveCount(effectName: string): number {
    return this._active.get(effectName)?.size ?? 0;
  }

  /** Dispose all pooled systems and shared textures. */
  public dispose(): void {
    for (const pool of this._pools.values()) {
      for (const sys of pool) sys.dispose();
      pool.length = 0;
    }
    for (const active of this._active.values()) {
      for (const sys of active) sys.dispose();
      active.clear();
    }
    for (const tex of this._textures.values()) tex.dispose();
    this._textures.clear();
  }
}
