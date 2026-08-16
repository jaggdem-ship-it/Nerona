/**
 * WeaponEngine.ts
 * =============================================================================
 * Modular Active Weapon System for a Diablo-themed Vampire Survivors clone.
 *
 * Architecture:
 * - WeaponManager: Owns the active ability roster, evaluates independent
 *   cooldown loops every frame, and bridges damage to the swarm SoA.
 * - BaseWeapon: Abstract contract for rank, cooldown, and per-frame tick.
 * - ProjectilePool: Zero-GC object pool for low-poly mesh projectiles.
 * - Per-Weapon Implementations: Unique casting math, angular orbital
 *   equations, directional sweeps, and bounding-zone collision.
 *
 * Integrates with:
 *   - VFXEngine.ts    (ParticleFXPool.emitBurst)
 *   - PlayerController.ts (position, stats snapshot, heal)
 *   - SwarmAI.ts      (flat SoA enemy arrays via query callbacks)
 * =============================================================================
 */

import {
  Scene,
  Vector3,
  Mesh,
  MeshBuilder,
  StandardMaterial,
  Texture,
  Color3,
  Matrix,
  Quaternion,
  Sprite,
  SpriteManager,
} from "@babylonjs/core";
import { ParticleFXPool } from "./VFXEngine";
import { PlayerController, PlayerStatsSnapshot } from "./PlayerController";

/* -------------------------------------------------------------------------- */
/*  DATA INTERFACES & CONSTANTS                                               */
/* -------------------------------------------------------------------------- */

/** Hard cap on simultaneous projectiles to protect frame time. */
const MAX_PROJECTILES = 512;
const MAX_ORBITALS = 64;
const MAX_AOE_ZONES = 32;

/** Evolution pairings: base weapon -> passive item -> ultimate name. */
export const EVOLUTION_PAIRS: ReadonlyMap<string, { passive: string; ultimate: string }> =
  new Map([
    ["sinners_quills",   { passive: "flayers_edge",        ultimate: "phantom_barrage" }],
    ["whirling_halberds",{ passive: "gothic_plate",        ultimate: "iron_fortress" }],
    ["zealots_chain",    { passive: "spellbinders_ring",   ultimate: "heavens_wrath" }],
    ["unholy_orbit",     { passive: "blood_onyx",          ultimate: "skeletal_cataclysm" }],
    ["grave_burst",      { passive: "cursed_hourglass",    ultimate: "corpse_nova" }],
    ["blood_siphon",     { passive: "vampiric_crest",      ultimate: "sanguine_vortex" }],
    ["abyssal_rift",     { passive: "amplifying_lens",     ultimate: "doomsday_singularity" }],
    ["font_of_torment",  { passive: "demons_luck",         ultimate: "desecrated_wake" }],
    ["plague_swarm",     { passive: "catacomb_magnet",     ultimate: "pandemic_infestation" }],
    ["grave_chill",      { passive: "swiftness_shard",     ultimate: "absolute_zero" }],
  ]);

export interface WeaponStats {
  baseDamage: number;
  cooldown: number;      // seconds
  projectileSpeed: number;
  pierce: number;        // how many enemies can be hit before dying
  areaSize: number;      // radius multiplier
  duration: number;      // how long the effect lasts
  count: number;         // projectiles / orbitals / bursts per cast
}

/** Rank-up table: each weapon defines 5 explicit ranks (+25% per rank). */
export const WEAPON_RANK_TABLE: ReadonlyMap<string, WeaponStats> = new Map([
  ["sinners_quills", {
    baseDamage: 12, cooldown: 1.2, projectileSpeed: 22,
    pierce: 1, areaSize: 1.0, duration: 0, count: 3,
  }],
  ["whirling_halberds", {
    baseDamage: 18, cooldown: 1.5, projectileSpeed: 6,
    pierce: 999, areaSize: 1.0, duration: 4.0, count: 2,
  }],
  ["zealots_chain", {
    baseDamage: 15, cooldown: 1.3, projectileSpeed: 16,
    pierce: 5, areaSize: 1.0, duration: 0.6, count: 1,
  }],
  ["unholy_orbit", {
    baseDamage: 10, cooldown: 1.0, projectileSpeed: 4,
    pierce: 999, areaSize: 1.0, duration: 5.0, count: 3,
  }],
  ["grave_burst", {
    baseDamage: 35, cooldown: 3.0, projectileSpeed: 0,
    pierce: 999, areaSize: 1.0, duration: 0.4, count: 1,
  }],
  ["blood_siphon", {
    baseDamage: 8, cooldown: 0.8, projectileSpeed: 0,
    pierce: 999, areaSize: 1.0, duration: 0.5, count: 2,
  }],
  ["abyssal_rift", {
    baseDamage: 20, cooldown: 4.0, projectileSpeed: 0,
    pierce: 999, areaSize: 1.0, duration: 3.5, count: 1,
  }],
  ["font_of_torment", {
    baseDamage: 14, cooldown: 2.5, projectileSpeed: 0,
    pierce: 999, areaSize: 1.0, duration: 4.0, count: 1,
  }],
  ["plague_swarm", {
    baseDamage: 6, cooldown: 1.1, projectileSpeed: 14,
    pierce: 2, areaSize: 1.0, duration: 2.0, count: 6,
  }],
  ["grave_chill", {
    baseDamage: 5, cooldown: 0.5, projectileSpeed: 0,
    pierce: 999, areaSize: 1.0, duration: 0.3, count: 1,
  }],
]);

/** Flat array enemy query bridge (SwarmAI SoA integration). */
export interface EnemyQueryBridge {
  /** Returns indices of enemies within radius of origin. */
  queryRadius(originX: number, originY: number, radius: number): number[];
  /** Apply damage to enemy by SoA index. Returns true if killed. */
  applyDamage(enemyIndex: number, amount: number): boolean;
  /** Get enemy position by SoA index. */
  getEnemyPosition(enemyIndex: number): { x: number; y: number } | null;
  /** Total alive enemy count (for targeting). */
  aliveCount: number;
}

/** Callback signature for floating combat text. */
export type CombatTextFn = (pos: Vector3, text: string, isCrit: boolean) => void;

/* -------------------------------------------------------------------------- */
/*  PROJECTILE OBJECT POOL                                                    */
/* -------------------------------------------------------------------------- */

interface PooledProjectile {
  mesh: Mesh;
  active: boolean;
  life: number;
  maxLife: number;
  velocity: Vector3;
  damage: number;
  pierce: number;
  hitMask: Set<number>; // enemy indices already struck
  onUpdate?: (dt: number, proj: PooledProjectile) => void;
  onDeath?: (proj: PooledProjectile) => void;
}

class ProjectilePool {
  private readonly _scene: Scene;
  private readonly _projectiles: PooledProjectile[] = [];
  private readonly _parent: Mesh;

  constructor(scene: Scene, maxSize: number = MAX_PROJECTILES) {
    this._scene = scene;
    this._parent = new Mesh("projectile_root", scene);
    this._parent.isVisible = false;

    for (let i = 0; i < maxSize; i++) {
      const mesh = MeshBuilder.CreateBox(
        `proj_${i}`,
        { size: 0.3, height: 0.1 },
        scene
      );
      mesh.isVisible = false;
      mesh.parent = this._parent;
      mesh.checkCollisions = false;

      this._projectiles.push({
        mesh,
        active: false,
        life: 0,
        maxLife: 0,
        velocity: Vector3.Zero(),
        damage: 0,
        pierce: 0,
        hitMask: new Set(),
      });
    }
  }

  /** Acquire an idle projectile or return null if pool is exhausted. */
  acquire(): PooledProjectile | null {
    for (const p of this._projectiles) {
      if (!p.active) {
        p.active = true;
        p.life = 0;
        p.hitMask.clear();
        p.velocity.setAll(0);
        p.mesh.isVisible = true;
        p.mesh.position.setAll(0);
        p.mesh.rotation.setAll(0);
        p.mesh.scaling.setAll(1);
        return p;
      }
    }
    return null; // hard cap reached
  }

  release(p: PooledProjectile): void {
    p.active = false;
    p.mesh.isVisible = false;
    p.mesh.position.setAll(0);
    p.velocity.setAll(0);
    p.onUpdate = undefined;
    p.onDeath = undefined;
  }

  getActive(): ReadonlyArray<PooledProjectile> {
    return this._projectiles.filter((p) => p.active);
  }

  dispose(): void {
    for (const p of this._projectiles) p.mesh.dispose();
    this._parent.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  ORBITAL OBJECT POOL                                                       */
/* -------------------------------------------------------------------------- */

interface PooledOrbital {
  mesh: Mesh;
  active: boolean;
  angle: number;
  radius: number;
  speed: number;
  damage: number;
  life: number;
  maxLife: number;
  axisOffset: number; // for multi-orbital spacing
}

class OrbitalPool {
  private readonly _orbitals: PooledOrbital[] = [];
  private readonly _parent: Mesh;

  constructor(scene: Scene, maxSize: number = MAX_ORBITALS) {
    this._parent = new Mesh("orbital_root", scene);
    this._parent.isVisible = false;

    for (let i = 0; i < maxSize; i++) {
      const mesh = MeshBuilder.CreateCylinder(
        `orb_${i}`,
        { height: 1.2, diameter: 0.15, tessellation: 6 },
        scene
      );
      mesh.isVisible = false;
      mesh.parent = this._parent;

      this._orbitals.push({
        mesh,
        active: false,
        angle: 0,
        radius: 3,
        speed: 2,
        damage: 0,
        life: 0,
        maxLife: 0,
        axisOffset: 0,
      });
    }
  }

  acquire(): PooledOrbital | null {
    for (const o of this._orbitals) {
      if (!o.active) {
        o.active = true;
        o.life = 0;
        o.angle = 0;
        o.mesh.isVisible = true;
        o.mesh.position.setAll(0);
        o.mesh.rotation.setAll(0);
        return o;
      }
    }
    return null;
  }

  release(o: PooledOrbital): void {
    o.active = false;
    o.mesh.isVisible = false;
  }

  getActive(): ReadonlyArray<PooledOrbital> {
    return this._orbitals.filter((o) => o.active);
  }

  dispose(): void {
    for (const o of this._orbitals) o.mesh.dispose();
    this._parent.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  AOE ZONE POOL                                                             */
/* -------------------------------------------------------------------------- */

interface PooledZone {
  mesh: Mesh;
  active: boolean;
  life: number;
  maxLife: number;
  radius: number;
  damage: number;
  tickInterval: number;
  tickTimer: number;
  origin: Vector3;
}

class ZonePool {
  private readonly _zones: PooledZone[] = [];
  private readonly _parent: Mesh;

  constructor(scene: Scene, maxSize: number = MAX_AOE_ZONES) {
    this._parent = new Mesh("zone_root", scene);
    this._parent.isVisible = false;

    for (let i = 0; i < maxSize; i++) {
      const mesh = MeshBuilder.CreateDisc(
        `zone_${i}`,
        { radius: 1, tessellation: 24 },
        scene
      );
      mesh.rotation.x = Math.PI / 2;
      mesh.isVisible = false;
      mesh.parent = this._parent;

      this._zones.push({
        mesh,
        active: false,
        life: 0,
        maxLife: 0,
        radius: 1,
        damage: 0,
        tickInterval: 0.5,
        tickTimer: 0,
        origin: Vector3.Zero(),
      });
    }
  }

  acquire(): PooledZone | null {
    for (const z of this._zones) {
      if (!z.active) {
        z.active = true;
        z.life = 0;
        z.tickTimer = 0;
        z.mesh.isVisible = true;
        return z;
      }
    }
    return null;
  }

  release(z: PooledZone): void {
    z.active = false;
    z.mesh.isVisible = false;
    z.mesh.scaling.setAll(1);
  }

  getActive(): ReadonlyArray<PooledZone> {
    return this._zones.filter((z) => z.active);
  }

  dispose(): void {
    for (const z of this._zones) z.mesh.dispose();
    this._parent.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  BASE WEAPON ABSTRACT CLASS                                                */
/* -------------------------------------------------------------------------- */

export abstract class BaseWeapon {
  public readonly id: string;
  public rank: number = 1;
  public isEvolved: boolean = false;

  protected _cooldownTimer: number = 0;
  protected _stats: WeaponStats;
  protected _scene: Scene;
  protected _vfx: ParticleFXPool;
  protected _player: PlayerController;
  protected _bridge: EnemyQueryBridge;
  protected _combatText: CombatTextFn | null = null;

  constructor(
    id: string,
    scene: Scene,
    vfx: ParticleFXPool,
    player: PlayerController,
    bridge: EnemyQueryBridge
  ) {
    this.id = id;
    this._scene = scene;
    this._vfx = vfx;
    this._player = player;
    this._bridge = bridge;
    const base = WEAPON_RANK_TABLE.get(id);
    if (!base) throw new Error(`Unknown weapon id: ${id}`);
    this._stats = { ...base };
  }

  /** Inject combat text callback. */
  public setCombatText(fn: CombatTextFn): void {
    this._combatText = fn;
  }

  /** Rank up the weapon, scaling stats by +25% per rank. */
  public rankUp(): void {
    if (this.rank >= 5) return;
    this.rank++;
    const m = 1.25;
    this._stats.baseDamage *= m;
    this._stats.projectileSpeed *= 1.1;
    this._stats.areaSize *= 1.15;
    this._stats.count = Math.floor(this._stats.count * 1.2 + 0.5);
    if (this._stats.cooldown > 0.2) {
      this._stats.cooldown *= 0.85;
    }
  }

  /** Called every frame by WeaponManager. */
  public tick(deltaTime: number): void {
    if (this._cooldownTimer > 0) {
      this._cooldownTimer -= deltaTime;
    }
    if (this._cooldownTimer <= 0) {
      this._fire();
      this._cooldownTimer = this._getEffectiveCooldown();
    }
    this._updateActive(deltaTime);
  }

  /** Effective cooldown reduced by player attack speed (hard cap 60% CDR). */
  protected _getEffectiveCooldown(): number {
    const snapshot = this._player.getStatsSnapshot();
    const asMod = Math.min(snapshot.passiveAttackSpeed, 2.5); // max 2.5x atk spd
    const cdr = Math.min(0.6, (asMod - 1) * 0.4); // 60% cap
    return this._stats.cooldown * (1 - cdr);
  }

  /** Effective damage scaled by player damage modifier and crit. */
  protected _rollDamage(): { damage: number; isCrit: boolean } {
    const snapshot = this._player.getStatsSnapshot();
    let dmg = this._stats.baseDamage * snapshot.passiveDamageMod;
    let isCrit = Math.random() < snapshot.passiveCritChance;
    if (isCrit) dmg *= snapshot.passiveCritDamage;
    // Evolved weapons deal 1.5x base
    if (this.isEvolved) dmg *= 1.5;
    return { damage: Math.round(dmg), isCrit };
  }

  /** Spawn a burst VFX at world position. */
  protected _spawnVFX(name: "blood_spray" | "void_glow" | "frost_haze", pos: Vector3, count: number): void {
    this._vfx.emitBurst(name, pos, count);
  }

  /** Apply damage to an enemy index, handling kill confirmation. */
  protected _damageEnemy(enemyIndex: number, amount: number, isCrit: boolean): void {
    const pos = this._bridge.getEnemyPosition(enemyIndex);
    if (!pos) return;

    const killed = this._bridge.applyDamage(enemyIndex, amount);
    if (this._combatText) {
      this._combatText(
        new Vector3(pos.x, 1.5, pos.y),
        amount.toString(),
        isCrit
      );
    }
    if (killed) {
      this._spawnVFX("blood_spray", new Vector3(pos.x, 1.0, pos.y), 12);
    }
  }

  /** Find nearest enemy index to a world position, or -1. */
  protected _findNearest(origin: Vector3, maxRange: number = 9999): number {
    if (this._bridge.aliveCount === 0) return -1;
    const indices = this._bridge.queryRadius(origin.x, origin.z, maxRange);
    let best = -1;
    let bestDist = Infinity;
    for (const idx of indices) {
      const p = this._bridge.getEnemyPosition(idx);
      if (!p) continue;
      const dx = p.x - origin.x;
      const dy = p.y - origin.z;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist) {
        bestDist = d2;
        best = idx;
      }
    }
    return best;
  }

  protected abstract _fire(): void;
  protected abstract _updateActive(deltaTime: number): void;
  public abstract dispose(): void;
}

/* -------------------------------------------------------------------------- */
/*  1. SINNER'S QUILLS -- Forward-firing dagger projectiles                    */
/* -------------------------------------------------------------------------- */

export class SinnersQuills extends BaseWeapon {
  private readonly _pool: ProjectilePool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("sinners_quills", scene, vfx, player, bridge);
    this._pool = new ProjectilePool(scene, MAX_PROJECTILES);

    this._material = new StandardMaterial("quill_mat", scene);
    this._material.diffuseColor = new Color3(0.8, 0.1, 0.1);
    this._material.emissiveColor = new Color3(0.4, 0.0, 0.0);
    this._material.specularColor = new Color3(0.3, 0.3, 0.3);
    // Texture atlas slice would be bound here in full pipeline
    // this._material.diffuseTexture = new Texture("assets/sinners_quills.png", scene);
  }

  protected _fire(): void {
    const origin = this._player.position;
    const count = this._stats.count;
    const spreadArc = Math.PI / 6; // 30-degree spread

    for (let i = 0; i < count; i++) {
      const proj = this._pool.acquire();
      if (!proj) break;

      const targetIdx = this._findNearest(origin, 25);
      let dir: Vector3;
      if (targetIdx >= 0) {
        const tp = this._bridge.getEnemyPosition(targetIdx)!;
        dir = new Vector3(tp.x - origin.x, 0, tp.y - origin.z).normalize();
      } else {
        dir = new Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
        if (dir.lengthSquared() < 0.01) dir.z = 1;
      }

      // Spread for multi-projectile casts
      if (count > 1) {
        const angle = (i / (count - 1) - 0.5) * spreadArc;
        const sin = Math.sin(angle);
        const cos = Math.cos(angle);
        dir = new Vector3(dir.x * cos - dir.z * sin, 0, dir.x * sin + dir.z * cos);
      }

      proj.mesh.position.copyFrom(origin);
      proj.mesh.position.y = 1.0;
      proj.velocity = dir.scale(this._stats.projectileSpeed);
      proj.maxLife = 3.0;
      proj.pierce = this._stats.pierce;
      const roll = this._rollDamage();
      proj.damage = roll.damage;

      // Visual: point mesh along velocity
      proj.mesh.lookAt(proj.mesh.position.add(proj.velocity));
      proj.mesh.material = this._material;
    }
  }

  protected _updateActive(dt: number): void {
    for (const p of this._pool.getActive()) {
      p.life += dt;
      if (p.life >= p.maxLife) {
        this._pool.release(p);
        continue;
      }

      // Forward sweep
      p.mesh.position.addInPlace(p.velocity.scale(dt));

      // Collision vs enemy radii
      const enemies = this._bridge.queryRadius(p.mesh.position.x, p.mesh.position.z, 1.2);
      for (const idx of enemies) {
        if (p.hitMask.has(idx)) continue;
        const epos = this._bridge.getEnemyPosition(idx);
        if (!epos) continue;

        const dx = epos.x - p.mesh.position.x;
        const dz = epos.y - p.mesh.position.z;
        if (dx * dx + dz * dz < 1.0) { // radius 1.0 hit
          p.hitMask.add(idx);
          const roll = this._rollDamage();
          this._damageEnemy(idx, roll.damage, roll.isCrit);
          this._spawnVFX("blood_spray", p.mesh.position, 6);

          if (p.hitMask.size > p.pierce) {
            this._pool.release(p);
            break;
          }
        }
      }
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  2. WHIRLING HALBERDS -- Orbital spinning melee blades                      */
/* -------------------------------------------------------------------------- */

export class WhirlingHalberds extends BaseWeapon {
  private readonly _pool: OrbitalPool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("whirling_halberds", scene, vfx, player, bridge);
    this._pool = new OrbitalPool(scene, MAX_ORBITALS);

    this._material = new StandardMaterial("halberd_mat", scene);
    this._material.diffuseColor = new Color3(0.6, 0.6, 0.7);
    this._material.emissiveColor = new Color3(0.1, 0.1, 0.15);
  }

  protected _fire(): void {
    const origin = this._player.position;
    const count = this._stats.count;

    for (let i = 0; i < count; i++) {
      const orb = this._pool.acquire();
      if (!orb) break;

      orb.mesh.position.copyFrom(origin);
      orb.mesh.position.y = 1.2;
      orb.mesh.material = this._material;
      orb.radius = 3.5 * this._stats.areaSize;
      orb.speed = this._stats.projectileSpeed;
      orb.maxLife = this._stats.duration;
      orb.axisOffset = (Math.PI * 2 * i) / count;
      orb.damage = this._stats.baseDamage;
    }
  }

  protected _updateActive(dt: number): void {
    const origin = this._player.position;

    for (const o of this._pool.getActive()) {
      o.life += dt;
      if (o.life >= o.maxLife) {
        this._pool.release(o);
        continue;
      }

      // Angular equation: orbit around player
      o.angle += o.speed * dt;
      const x = origin.x + Math.cos(o.angle + o.axisOffset) * o.radius;
      const z = origin.z + Math.sin(o.angle + o.axisOffset) * o.radius;
      o.mesh.position.x = x;
      o.mesh.position.z = z;
      o.mesh.rotation.y = -o.angle;

      // Collision sweep
      const enemies = this._bridge.queryRadius(x, z, 1.5);
      for (const idx of enemies) {
        const epos = this._bridge.getEnemyPosition(idx);
        if (!epos) continue;
        const dx = epos.x - x;
        const dz = epos.y - z;
        if (dx * dx + dz * dz < 2.0) {
          const roll = this._rollDamage();
          this._damageEnemy(idx, roll.damage, roll.isCrit);
        }
      }
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  3. ZEALOT'S CHAIN -- Lashing chain that extends and retracts               */
/* -------------------------------------------------------------------------- */

export class ZealotsChain extends BaseWeapon {
  private readonly _pool: ProjectilePool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("zealots_chain", scene, vfx, player, bridge);
    this._pool = new ProjectilePool(scene, 64);
    this._material = new StandardMaterial("chain_mat", scene);
    this._material.diffuseColor = new Color3(0.7, 0.5, 0.1);
    this._material.emissiveColor = new Color3(0.3, 0.2, 0.0);
  }

  protected _fire(): void {
    const origin = this._player.position;
    const targetIdx = this._findNearest(origin, 20);
    if (targetIdx < 0) return;

    const tp = this._bridge.getEnemyPosition(targetIdx)!;
    const dir = new Vector3(tp.x - origin.x, 0, tp.y - origin.z);
    const dist = dir.length();
    dir.normalize();

    const proj = this._pool.acquire();
    if (!proj) return;

    proj.mesh.position.copyFrom(origin);
    proj.mesh.position.y = 1.0;
    proj.mesh.material = this._material;
    proj.mesh.scaling.setAll(1);

    const maxReach = Math.min(dist, 12 * this._stats.areaSize);
    const speed = this._stats.projectileSpeed;

    // Custom update: extend then retract
    let phase: "out" | "back" = "out";
    let traveled = 0;

    proj.onUpdate = (dt, p) => {
      if (phase === "out") {
        const step = speed * dt;
        traveled += step;
        p.mesh.position.addInPlace(dir.scale(step));
        p.mesh.lookAt(p.mesh.position.add(dir));

        if (traveled >= maxReach) {
          phase = "back";
        }

        // Damage during extension
        const enemies = this._bridge.queryRadius(p.mesh.position.x, p.mesh.position.z, 1.5);
        for (const idx of enemies) {
          if (p.hitMask.has(idx)) continue;
          const epos = this._bridge.getEnemyPosition(idx);
          if (!epos) continue;
          const dx = epos.x - p.mesh.position.x;
          const dz = epos.y - p.mesh.position.z;
          if (dx * dx + dz * dz < 1.5) {
            p.hitMask.add(idx);
            const roll = this._rollDamage();
            this._damageEnemy(idx, roll.damage, roll.isCrit);
            this._spawnVFX("blood_spray", p.mesh.position, 5);
          }
        }
      } else {
        // Retract toward player
        const toPlayer = origin.subtract(p.mesh.position);
        toPlayer.y = 0;
        const d = toPlayer.length();
        if (d < 0.5) {
          this._pool.release(p);
          return;
        }
        toPlayer.normalize();
        p.mesh.position.addInPlace(toPlayer.scale(speed * 1.5 * dt));
        p.mesh.lookAt(p.mesh.position.add(toPlayer));
      }
    };
  }

  protected _updateActive(dt: number): void {
    for (const p of this._pool.getActive()) {
      p.life += dt;
      if (p.onUpdate) p.onUpdate(dt, p);
      if (p.life > 3) this._pool.release(p);
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  4. UNHOLY ORBIT -- Dark orbiting spheres that damage on contact            */
/* -------------------------------------------------------------------------- */

export class UnholyOrbit extends BaseWeapon {
  private readonly _pool: OrbitalPool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("unholy_orbit", scene, vfx, player, bridge);
    this._pool = new OrbitalPool(scene, MAX_ORBITALS);
    this._material = new StandardMaterial("unholy_mat", scene);
    this._material.diffuseColor = new Color3(0.2, 0.0, 0.4);
    this._material.emissiveColor = new Color3(0.4, 0.0, 0.6);
    this._material.alpha = 0.9;
  }

  protected _fire(): void {
    const count = this._stats.count;
    for (let i = 0; i < count; i++) {
      const orb = this._pool.acquire();
      if (!orb) break;
      orb.radius = 4.0 * this._stats.areaSize;
      orb.speed = this._stats.projectileSpeed;
      orb.maxLife = this._stats.duration;
      orb.axisOffset = (Math.PI * 2 * i) / count;
      orb.damage = this._stats.baseDamage;
      orb.mesh.material = this._material;
      orb.mesh.scaling.setAll(1.5);
    }
  }

  protected _updateActive(dt: number): void {
    const origin = this._player.position;
    for (const o of this._pool.getActive()) {
      o.life += dt;
      if (o.life >= o.maxLife) {
        this._pool.release(o);
        continue;
      }
      o.angle += o.speed * dt;
      const x = origin.x + Math.cos(o.angle + o.axisOffset) * o.radius;
      const z = origin.z + Math.sin(o.angle + o.axisOffset) * o.radius;
      o.mesh.position.set(x, 1.5, z);

      // Vertical bobbing via sin wave for unholy feel
      o.mesh.position.y = 1.5 + Math.sin(o.life * 3 + o.axisOffset) * 0.5;

      const enemies = this._bridge.queryRadius(x, z, 2.0);
      for (const idx of enemies) {
        const epos = this._bridge.getEnemyPosition(idx);
        if (!epos) continue;
        const dx = epos.x - x;
        const dz = epos.y - z;
        if (dx * dx + dz * dz < 2.5) {
          const roll = this._rollDamage();
          this._damageEnemy(idx, roll.damage, roll.isCrit);
          this._spawnVFX("void_glow", o.mesh.position, 4);
        }
      }
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  5. GRAVE BURST -- Explosive ground eruption                                */
/* -------------------------------------------------------------------------- */

export class GraveBurst extends BaseWeapon {
  private readonly _pool: ZonePool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("grave_burst", scene, vfx, player, bridge);
    this._pool = new ZonePool(scene, MAX_AOE_ZONES);
    this._material = new StandardMaterial("grave_mat", scene);
    this._material.diffuseColor = new Color3(0.3, 0.25, 0.2);
    this._material.emissiveColor = new Color3(0.1, 0.08, 0.05);
    this._material.alpha = 0.6;
  }

  protected _fire(): void {
    const origin = this._player.position;
    const targetIdx = this._findNearest(origin, 18);
    let center: Vector3;
    if (targetIdx >= 0) {
      const tp = this._bridge.getEnemyPosition(targetIdx)!;
      center = new Vector3(tp.x, 0.1, tp.y);
    } else {
      const angle = Math.random() * Math.PI * 2;
      center = new Vector3(origin.x + Math.cos(angle) * 5, 0.1, origin.z + Math.sin(angle) * 5);
    }

    const zone = this._pool.acquire();
    if (!zone) return;

    zone.mesh.position.copyFrom(center);
    zone.mesh.material = this._material;
    zone.radius = 4.0 * this._stats.areaSize;
    zone.maxLife = this._stats.duration;
    zone.damage = this._stats.baseDamage;
    zone.mesh.scaling.setAll(zone.radius);

    // Immediate burst damage
    const enemies = this._bridge.queryRadius(center.x, center.z, zone.radius);
    for (const idx of enemies) {
      const roll = this._rollDamage();
      this._damageEnemy(idx, roll.damage, roll.isCrit);
    }
    this._spawnVFX("blood_spray", center, 20);
  }

  protected _updateActive(dt: number): void {
    for (const z of this._pool.getActive()) {
      z.life += dt;
      const t = z.life / z.maxLife;
      // Scale up then fade
      const scale = z.radius * (1 + Math.sin(t * Math.PI) * 0.3);
      z.mesh.scaling.setAll(scale);
      z.mesh.material!.alpha = 0.6 * (1 - t);

      if (z.life >= z.maxLife) {
        this._pool.release(z);
      }
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  6. BLOOD SIPHON -- Lifesteal beam connecting to nearest enemies            */
/* -------------------------------------------------------------------------- */

export class BloodSiphon extends BaseWeapon {
  private _activeBeams: Array<{
    targetIndex: number;
    timer: number;
    maxTime: number;
    origin: Vector3;
  }> = [];
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("blood_siphon", scene, vfx, player, bridge);
    this._material = new StandardMaterial("siphon_mat", scene);
    this._material.diffuseColor = new Color3(0.6, 0.0, 0.0);
    this._material.emissiveColor = new Color3(0.8, 0.0, 0.0);
    this._material.alpha = 0.4;
  }

  protected _fire(): void {
    const origin = this._player.position;
    const count = this._stats.count;

    for (let i = 0; i < count; i++) {
      const idx = this._findNearest(origin, 12);
      if (idx < 0) continue;

      // Avoid duplicate targets in same wave
      if (this._activeBeams.some((b) => b.targetIndex === idx)) continue;

      this._activeBeams.push({
        targetIndex: idx,
        timer: 0,
        maxTime: this._stats.duration,
        origin: origin.clone(),
      });

      const roll = this._rollDamage();
      this._damageEnemy(idx, roll.damage, roll.isCrit);
      // Lifesteal: 20% of damage dealt
      const heal = roll.damage * 0.2;
      this._player.heal(heal);

      const tp = this._bridge.getEnemyPosition(idx);
      if (tp) {
        const pos = new Vector3(tp.x, 1.2, tp.y);
        this._spawnVFX("blood_spray", pos, 8);
      }
    }
  }

  protected _updateActive(dt: number): void {
    const origin = this._player.position;
    for (let i = this._activeBeams.length - 1; i >= 0; i--) {
      const beam = this._activeBeams[i];
      beam.timer += dt;
      beam.origin.copyFrom(origin);

      // Verify target still alive / in range
      const tp = this._bridge.getEnemyPosition(beam.targetIndex);
      if (!tp || beam.timer >= beam.maxTime) {
        this._activeBeams.splice(i, 1);
        continue;
      }

      // Continuous damage tick
      if (Math.floor(beam.timer * 4) !== Math.floor((beam.timer - dt) * 4)) {
        const roll = this._rollDamage();
        this._damageEnemy(beam.targetIndex, roll.damage * 0.5, roll.isCrit);
        this._player.heal(roll.damage * 0.1);
      }
    }
  }

  public dispose(): void {
    this._activeBeams.length = 0;
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  7. ABYSSAL RIFT -- Pull zone that drags enemies inward and damages         */
/* -------------------------------------------------------------------------- */

export class AbyssalRift extends BaseWeapon {
  private readonly _pool: ZonePool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("abyssal_rift", scene, vfx, player, bridge);
    this._pool = new ZonePool(scene, MAX_AOE_ZONES);
    this._material = new StandardMaterial("rift_mat", scene);
    this._material.diffuseColor = new Color3(0.05, 0.0, 0.15);
    this._material.emissiveColor = new Color3(0.2, 0.0, 0.4);
    this._material.alpha = 0.7;
  }

  protected _fire(): void {
    const origin = this._player.position;
    const targetIdx = this._findNearest(origin, 20);
    let center: Vector3;
    if (targetIdx >= 0) {
      const tp = this._bridge.getEnemyPosition(targetIdx)!;
      center = new Vector3(tp.x, 0.2, tp.y);
    } else {
      const angle = Math.random() * Math.PI * 2;
      center = new Vector3(origin.x + Math.cos(angle) * 6, 0.2, origin.z + Math.sin(angle) * 6);
    }

    const zone = this._pool.acquire();
    if (!zone) return;

    zone.mesh.position.copyFrom(center);
    zone.mesh.material = this._material;
    zone.radius = 5.0 * this._stats.areaSize;
    zone.maxLife = this._stats.duration;
    zone.damage = this._stats.baseDamage;
    zone.mesh.scaling.setAll(zone.radius);
    zone.origin.copyFrom(center);
  }

  protected _updateActive(dt: number): void {
    for (const z of this._pool.getActive()) {
      z.life += dt;
      z.tickTimer += dt;

      // Rotate zone for vortex feel
      z.mesh.rotation.z += dt * 2;

      if (z.tickTimer >= z.tickInterval) {
        z.tickTimer = 0;
        const enemies = this._bridge.queryRadius(z.origin.x, z.origin.z, z.radius);
        for (const idx of enemies) {
          const epos = this._bridge.getEnemyPosition(idx);
          if (!epos) continue;
          const dx = z.origin.x - epos.x;
          const dz = z.origin.z - epos.y;
          const dist = Math.sqrt(dx * dx + dz * dz);
          if (dist < z.radius && dist > 0.5) {
            // Pull force (reported to swarm via external impulse if supported,
            // otherwise just damage). Here we apply damage only; pull is
            // communicated through an optional callback on the bridge.
            const roll = this._rollDamage();
            this._damageEnemy(idx, roll.damage, roll.isCrit);
          }
        }
        this._spawnVFX("void_glow", z.origin, 10);
      }

      if (z.life >= z.maxLife) {
        this._pool.release(z);
      }
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  8. FONT OF TORMENT -- Persistent damaging fountain underneath player       */
/* -------------------------------------------------------------------------- */

export class FontOfTorment extends BaseWeapon {
  private readonly _pool: ZonePool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("font_of_torment", scene, vfx, player, bridge);
    this._pool = new ZonePool(scene, MAX_AOE_ZONES);
    this._material = new StandardMaterial("font_mat", scene);
    this._material.diffuseColor = new Color3(0.5, 0.0, 0.1);
    this._material.emissiveColor = new Color3(0.6, 0.0, 0.15);
    this._material.alpha = 0.5;
  }

  protected _fire(): void {
    const zone = this._pool.acquire();
    if (!zone) return;

    zone.mesh.position.copyFrom(this._player.position);
    zone.mesh.position.y = 0.1;
    zone.mesh.material = this._material;
    zone.radius = 3.5 * this._stats.areaSize;
    zone.maxLife = this._stats.duration;
    zone.damage = this._stats.baseDamage;
    zone.mesh.scaling.setAll(zone.radius);
    zone.tickInterval = 0.4;
    zone.origin.copyFrom(this._player.position);
  }

  protected _updateActive(dt: number): void {
    for (const z of this._pool.getActive()) {
      z.life += dt;
      z.tickTimer += dt;

      // Follow player
      z.mesh.position.x = this._player.position.x;
      z.mesh.position.z = this._player.position.z;

      if (z.tickTimer >= z.tickInterval) {
        z.tickTimer = 0;
        const enemies = this._bridge.queryRadius(z.mesh.position.x, z.mesh.position.z, z.radius);
        for (const idx of enemies) {
          const roll = this._rollDamage();
          this._damageEnemy(idx, roll.damage, roll.isCrit);
        }
        this._spawnVFX("blood_spray", z.mesh.position, 6);
      }

      if (z.life >= z.maxLife) {
        this._pool.release(z);
      }
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  9. PLAGUE SWARM -- Tracking swarm of diseased projectiles                  */
/* -------------------------------------------------------------------------- */

export class PlagueSwarm extends BaseWeapon {
  private readonly _pool: ProjectilePool;
  private _material: StandardMaterial;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("plague_swarm", scene, vfx, player, bridge);
    this._pool = new ProjectilePool(scene, MAX_PROJECTILES);
    this._material = new StandardMaterial("plague_mat", scene);
    this._material.diffuseColor = new Color3(0.2, 0.5, 0.1);
    this._material.emissiveColor = new Color3(0.1, 0.3, 0.0);
  }

  protected _fire(): void {
    const origin = this._player.position;
    const count = this._stats.count;

    for (let i = 0; i < count; i++) {
      const proj = this._pool.acquire();
      if (!proj) break;

      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const dir = new Vector3(Math.cos(angle), 0, Math.sin(angle));

      proj.mesh.position.copyFrom(origin);
      proj.mesh.position.y = 1.0;
      proj.velocity = dir.scale(this._stats.projectileSpeed * 0.5);
      proj.maxLife = this._stats.duration;
      proj.pierce = this._stats.pierce;
      proj.mesh.material = this._material;

      // Homing update
      proj.onUpdate = (dt, p) => {
        const nearest = this._findNearest(p.mesh.position, 15);
        if (nearest >= 0) {
          const tp = this._bridge.getEnemyPosition(nearest)!;
          const desired = new Vector3(tp.x - p.mesh.position.x, 0, tp.y - p.mesh.position.z);
          desired.normalize();
          // Steer velocity toward target
          p.velocity = Vector3.Lerp(p.velocity, desired.scale(this._stats.projectileSpeed), 4 * dt);
        }
        p.mesh.lookAt(p.mesh.position.add(p.velocity));
      };
    }
  }

  protected _updateActive(dt: number): void {
    for (const p of this._pool.getActive()) {
      p.life += dt;
      if (p.life >= p.maxLife) {
        this._pool.release(p);
        continue;
      }

      if (p.onUpdate) p.onUpdate(dt, p);
      p.mesh.position.addInPlace(p.velocity.scale(dt));

      const enemies = this._bridge.queryRadius(p.mesh.position.x, p.mesh.position.z, 1.0);
      for (const idx of enemies) {
        if (p.hitMask.has(idx)) continue;
        const epos = this._bridge.getEnemyPosition(idx);
        if (!epos) continue;
        const dx = epos.x - p.mesh.position.x;
        const dz = epos.y - p.mesh.position.z;
        if (dx * dx + dz * dz < 0.8) {
          p.hitMask.add(idx);
          const roll = this._rollDamage();
          this._damageEnemy(idx, roll.damage, roll.isCrit);
          if (p.hitMask.size > p.pierce) {
            this._pool.release(p);
            break;
          }
        }
      }
    }
  }

  public dispose(): void {
    this._pool.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  10. GRAVE CHILL -- Aura that slows and damages nearby enemies              */
/* -------------------------------------------------------------------------- */

export class GraveChill extends BaseWeapon {
  private _pulseTimer: number = 0;
  private _material: StandardMaterial;
  private _auraMesh: Mesh;

  constructor(scene: Scene, vfx: ParticleFXPool, player: PlayerController, bridge: EnemyQueryBridge) {
    super("grave_chill", scene, vfx, player, bridge);
    this._material = new StandardMaterial("chill_mat", scene);
    this._material.diffuseColor = new Color3(0.5, 0.8, 0.9);
    this._material.emissiveColor = new Color3(0.2, 0.5, 0.7);
    this._material.alpha = 0.25;

    this._auraMesh = MeshBuilder.CreateDisc(
      "grave_chill_aura",
      { radius: 1, tessellation: 32 },
      scene
    );
    this._auraMesh.rotation.x = Math.PI / 2;
    this._auraMesh.material = this._material;
    this._auraMesh.isVisible = false;
  }

  protected _fire(): void {
    // Grave Chill is a passive aura; firing just resets the pulse
    this._pulseTimer = 0;
  }

  protected _updateActive(dt: number): void {
    this._pulseTimer += dt;
    const radius = 5.0 * this._stats.areaSize;

    // Visual aura follow
    this._auraMesh.isVisible = true;
    this._auraMesh.position.copyFrom(this._player.position);
    this._auraMesh.position.y = 0.2;
    this._auraMesh.scaling.setAll(radius);

    // Pulse opacity
    const pulse = 0.2 + Math.sin(this._pulseTimer * 3) * 0.1;
    this._material.alpha = pulse;

    if (this._pulseTimer >= this._stats.cooldown) {
      this._pulseTimer = 0;
      const origin = this._player.position;
      const enemies = this._bridge.queryRadius(origin.x, origin.z, radius);
      for (const idx of enemies) {
        const roll = this._rollDamage();
        this._damageEnemy(idx, roll.damage, roll.isCrit);
      }
      if (enemies.length > 0) {
        this._spawnVFX("frost_haze", origin, 8);
      }
    }
  }

  public dispose(): void {
    this._auraMesh.dispose();
    this._material.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/*  WEAPON MANAGER                                                            */
/* -------------------------------------------------------------------------- */

export class WeaponManager {
  private readonly _scene: Scene;
  private readonly _vfx: ParticleFXPool;
  private readonly _player: PlayerController;
  private readonly _bridge: EnemyQueryBridge;
  private readonly _weapons: Map<string, BaseWeapon> = new Map();
  private _combatText: CombatTextFn | null = null;
  private _observer: any;

  constructor(
    scene: Scene,
    vfx: ParticleFXPool,
    player: PlayerController,
    bridge: EnemyQueryBridge
  ) {
    this._scene = scene;
    this._vfx = vfx;
    this._player = player;
    this._bridge = bridge;

    this._observer = scene.onBeforeRenderObservable.add(() => {
      if ((window as any).Game?.isPaused) return;
      const dt = scene.getEngine().getDeltaTime() / 1000;
      this._tickAll(dt);
    });
  }

  /** Inject floating combat text renderer. */
  public setCombatText(fn: CombatTextFn): void {
    this._combatText = fn;
    for (const w of this._weapons.values()) w.setCombatText(fn);
  }

  /** Add a weapon by id. Returns false if already present. */
  public addWeapon(id: string): boolean {
    if (this._weapons.has(id)) return false;

    let weapon: BaseWeapon;
    switch (id) {
      case "sinners_quills":    weapon = new SinnersQuills(this._scene, this._vfx, this._player, this._bridge); break;
      case "whirling_halberds": weapon = new WhirlingHalberds(this._scene, this._vfx, this._player, this._bridge); break;
      case "zealots_chain":     weapon = new ZealotsChain(this._scene, this._vfx, this._player, this._bridge); break;
      case "unholy_orbit":      weapon = new UnholyOrbit(this._scene, this._vfx, this._player, this._bridge); break;
      case "grave_burst":       weapon = new GraveBurst(this._scene, this._vfx, this._player, this._bridge); break;
      case "blood_siphon":      weapon = new BloodSiphon(this._scene, this._vfx, this._player, this._bridge); break;
      case "abyssal_rift":      weapon = new AbyssalRift(this._scene, this._vfx, this._player, this._bridge); break;
      case "font_of_torment":   weapon = new FontOfTorment(this._scene, this._vfx, this._player, this._bridge); break;
      case "plague_swarm":      weapon = new PlagueSwarm(this._scene, this._vfx, this._player, this._bridge); break;
      case "grave_chill":       weapon = new GraveChill(this._scene, this._vfx, this._player, this._bridge); break;
      default: throw new Error(`WeaponManager: unknown weapon id "${id}"`);
    }

    if (this._combatText) weapon.setCombatText(this._combatText);
    this._weapons.set(id, weapon);
    return true;
  }

  /** Rank up a weapon. If at rank 5 and paired passive at rank 5, evolve. */
  public rankUpWeapon(id: string): boolean {
    const weapon = this._weapons.get(id);
    if (!weapon) return false;

    const pair = EVOLUTION_PAIRS.get(id);
    if (pair && weapon.rank >= 5) {
      // In a full build, query passive inventory here.
      // For now, we gate evolution behind an explicit flag.
      // weapon.isEvolved = true; // Set by external synthesis check
    }

    weapon.rankUp();
    return true;
  }

  /** Force-evolve a weapon (called by external synthesis algorithm). */
  public evolveWeapon(id: string): boolean {
    const weapon = this._weapons.get(id);
    if (!weapon) return false;
    weapon.isEvolved = true;
    return true;
  }

  /** Remove a weapon and dispose its resources. */
  public removeWeapon(id: string): boolean {
    const weapon = this._weapons.get(id);
    if (!weapon) return false;
    weapon.dispose();
    this._weapons.delete(id);
    return true;
  }

  /** Get a snapshot of current loadout for HUD rendering. */
  public getLoadout(): Array<{ id: string; rank: number; evolved: boolean; cooldownPct: number }> {
    return Array.from(this._weapons.values()).map((w) => ({
      id: w.id,
      rank: w.rank,
      evolved: w.isEvolved,
      cooldownPct: 0, // Could be wired per-weapon if needed
    }));
  }

  /** Number of active weapons. */
  public get count(): number {
    return this._weapons.size;
  }

  /** Tick all active weapons. */
  private _tickAll(dt: number): void {
    for (const weapon of this._weapons.values()) {
      weapon.tick(dt);
    }
  }

  /** Full cleanup. */
  public dispose(): void {
    if (this._observer) {
      this._scene.onBeforeRenderObservable.remove(this._observer);
      this._observer = null;
    }
    for (const w of this._weapons.values()) w.dispose();
    this._weapons.clear();
  }
}
