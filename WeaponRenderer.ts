/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WEAPON RENDERER — Babylon.js Visual Bridge for WeaponEngine Projectiles
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Responsibilities:
 *   • Load AssetAtlas textures via AssetPipeline and create SpriteManagers
 *   • Maintain pooled Sprite instances per weapon type (zero-GC render path)
 *   • Sync active IProjectile state → Sprite position / cellIndex / visibility
 *   • Angle-aware frame selection for directional projectiles
 *   • Scale/opacity modulation based on projectile lifetime
 *
 * Dependencies: WeaponEngine.ts, AssetPipeline.ts, @babylonjs/core
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  Scene,
  Vector3,
  Sprite,
  SpriteManager,
  Texture,
  Color4,
} from "@babylonjs/core";
import {
  WeaponManager,
  IProjectile,
  AssetAtlas,
  SpriteSheetMeta,
  getFrameUV,
  selectAngleFrame,
} from "./WeaponEngine";
import { AssetPipeline } from "./AssetPipeline";

interface SpritePool {
  manager: SpriteManager;
  free: Sprite[];
  inUse: Map<number, Sprite>; // projectile id -> sprite
  meta: SpriteSheetMeta;
}

export class WeaponRenderer {
  private _scene: Scene;
  private _weaponMgr: WeaponManager;
  private _pipeline: AssetPipeline;
  private _pools = new Map<string, SpritePool>();
  private _isDisposed = false;

  /** Max sprites per weapon type. Tune based on weapon count + projectile burst. */
  static readonly DEFAULT_CAPACITY = 128;

  constructor(
    scene: Scene,
    weaponMgr: WeaponManager,
    pipeline: AssetPipeline,
    capacityPerWeapon: number = WeaponRenderer.DEFAULT_CAPACITY
  ) {
    this._scene = scene;
    this._weaponMgr = weaponMgr;
    this._pipeline = pipeline;

    // Initialize one SpriteManager per AssetAtlas entry
    for (const [key, meta] of Object.entries(AssetAtlas)) {
      // Ensure texture is loaded through pipeline first
      const tex = pipeline.getTexture(key);
      if (!tex) {
        console.warn(`[WeaponRenderer] Texture not yet loaded for "${key}" at "${meta.path}". SpriteManager will auto-load.`);
      }

      const manager = new SpriteManager(
        `weapon_sm_${key}`,
        meta.path,
        capacityPerWeapon,
        { width: meta.frameW, height: meta.frameH },
        scene
      );
      manager.isPickable = false;

      this._pools.set(key, {
        manager,
        free: [],
        inUse: new Map(),
        meta,
      });

      // Pre-warm free pool to eliminate spawn hitches
      const pool = this._pools.get(key)!;
      for (let i = 0; i < Math.min(capacityPerWeapon, 32); i++) {
        const sprite = new Sprite(`wp_${key}_${i}`, manager);
        sprite.isVisible = false;
        sprite.color = new Color4(1, 1, 1, 1);
        pool.free.push(sprite);
      }
    }

    // Register per-frame sync
    scene.onBeforeRenderObservable.add(this._sync);
  }

  /** Main sync loop: map logical projectiles to visual sprites. */
  private _sync = (): void => {
    if (this._isDisposed) return;

    // Track which sprites are still active this frame
    const touched = new Set<string>(); // poolKey + ":" + proj.id

    // Iterate all active projectiles via WeaponManager's exposed pool
    const pool = this._weaponMgr.projectilePool;
    pool.forEachActive((proj) => {
      const poolKey = proj.spriteKey;
      const spritePool = this._pools.get(poolKey);
      if (!spritePool) return; // Unknown sprite key; silent skip

      let sprite = spritePool.inUse.get(proj.id);
      if (!sprite) {
        // Acquire from free pool or emergency-create
        sprite = spritePool.free.pop() ?? new Sprite(`wp_${poolKey}_emerg`, spritePool.manager);
        spritePool.inUse.set(proj.id, sprite);
      }

      touched.add(`${poolKey}:${proj.id}`);

      // ── Position (Vec2 → Vector3, Y=1.0 for isometric billboarding) ──
      sprite.position.x = proj.pos.x;
      sprite.position.y = 1.0; // Slightly above ground plane
      sprite.position.z = proj.pos.y;

      // ── Frame / Cell Index ──
      let frame = proj.frameIndex;
      // For linear projectiles with velocity, use angle-aware frame if meta supports it
      if (proj.motionType === "linear" && proj.vel && (proj.vel.x !== 0 || proj.vel.y !== 0)) {
        const angle = Math.atan2(proj.vel.y, proj.vel.x);
        frame = selectAngleFrame(spritePool.meta, angle);
      }
      sprite.cellIndex = Math.max(0, Math.min(frame, spritePool.meta.totalFrames - 1));

      // ── Visual Modulation ──
      sprite.size = proj.radius * proj.scale * 0.15; // Scale factor tuned to world units
      sprite.color.a = proj.opacity;
      sprite.isVisible = true;
      sprite.angle = proj.angle;

      // ── Lifetime fade-out ──
      if (proj.lifetime < 0.3 && proj.maxLifetime > 0) {
        sprite.color.a = proj.opacity * (proj.lifetime / 0.3);
      }
    });

    // Return untouched sprites to free pool
    for (const [key, spritePool] of this._pools) {
      for (const [projId, sprite] of spritePool.inUse) {
        if (!touched.has(`${key}:${projId}`)) {
          sprite.isVisible = false;
          spritePool.inUse.delete(projId);
          spritePool.free.push(sprite);
        }
      }
    }
  };

  /** Dispose all sprite managers and pooled sprites. */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this._scene.onBeforeRenderObservable.removeCallback(this._sync);

    for (const pool of this._pools.values()) {
      for (const sprite of pool.free) sprite.dispose();
      for (const sprite of pool.inUse.values()) sprite.dispose();
      pool.manager.dispose();
    }
    this._pools.clear();
  }
}
