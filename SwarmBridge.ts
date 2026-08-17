/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SWARM BRIDGE — EnemySwarmManager → ICollisionBridge Adapter
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Bridges the flat SoA swarm arrays (SwarmAI.ts) to the weapon system's
 * ICollisionBridge contract (WeaponEngine.ts).
 *
 * Responsibilities:
 *   • Rebuild a live IEnemy[] cache once per frame (zero-GC warm path)
 *   • Forward damage calls with weapon-key attribution
 *   • Implement area, cone, pull, push, slow, and DOT effects via SoA mutation
 *   • Maintain side tables for status effects not native to SwarmAI
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import {
  ICollisionBridge,
  IEnemy,
  Vec2,
  V2,
} from "./WeaponEngine";
import { EnemySwarmManager } from "./SwarmAI";

/** Side-car state for enemies afflicted by weapon status effects. */
interface StatusEntry {
  slowPct: number;
  slowTimer: number;
  dotDps: number;
  dotTimer: number;
  dotSource: string;
}

export class SwarmBridge implements ICollisionBridge {
  private readonly _swarm: EnemySwarmManager;
  private _enemyCache: IEnemy[] = [];
  private _cacheDirty = true;
  private _statusTable = new Map<number, StatusEntry>();
  private _dotAccumulators = new Map<number, number>(); // enemyId -> pending damage

  constructor(swarm: EnemySwarmManager) {
    this._swarm = swarm;
  }

  /** Call once per frame before WeaponManager.update() to refresh the cache. */
  public invalidateCache(): void {
    this._cacheDirty = true;
  }

  /** Apply pending DOT ticks. Call from your game loop before collision. */
  public tickDOT(dt: number): void {
    for (const [enemyId, entry] of this._statusTable) {
      if (entry.dotTimer > 0) {
        entry.dotTimer -= dt;
        // Accumulate fractional damage and flush on integer boundary
        const dmg = entry.dotDps * dt;
        const acc = (this._dotAccumulators.get(enemyId) ?? 0) + dmg;
        if (acc >= 1) {
          const floored = Math.floor(acc);
          this._swarm.applyDamageToInstance(enemyId, floored);
          this._dotAccumulators.set(enemyId, acc - floored);
        } else {
          this._dotAccumulators.set(enemyId, acc);
        }
        if (entry.dotTimer <= 0) {
          this._dotAccumulators.delete(enemyId);
        }
      }
      if (entry.slowTimer > 0) {
        entry.slowTimer -= dt;
      }
      // Clean up expired entries
      if (entry.slowTimer <= 0 && entry.dotTimer <= 0) {
        this._statusTable.delete(enemyId);
        this._dotAccumulators.delete(enemyId);
      }
    }
  }

  // ── ICollisionBridge: Enemy Queries ────────────────────────────────────────

  getEnemies(): IEnemy[] {
    this._rebuildCache();
    return this._enemyCache;
  }

  findNearest(pos: Vec2, maxCount: number, maxRange?: number): IEnemy[] {
    const enemies = this.getEnemies().filter((e) => e.alive);
    enemies.sort((a, b) => {
      const da = V2.distSq(a.pos, pos);
      const db = V2.distSq(b.pos, pos);
      return da - db;
    });
    if (maxRange !== undefined) {
      const r2 = maxRange * maxRange;
      const filtered = enemies.filter((e) => V2.distSq(e.pos, pos) <= r2);
      return filtered.slice(0, maxCount);
    }
    return enemies.slice(0, maxCount);
  }

  // ── ICollisionBridge: Damage ───────────────────────────────────────────────

  applyDamage(enemyId: number, amount: number, _sourceWeapon: string): boolean {
    return this._swarm.applyDamageToInstance(enemyId, amount);
  }

  applyAreaDamage(center: Vec2, radius: number, amount: number, _sourceWeapon: string): number[] {
    const killed: number[] = [];
    const victims = this._swarm.getEnemiesWithinRadius(center, radius);
    for (const v of victims) {
      if (this._swarm.applyDamageToInstance(v.id, amount)) {
        killed.push(v.id);
      }
    }
    return killed;
  }

  applyConeDamage(
    origin: Vec2,
    angleRad: number,
    arcRad: number,
    range: number,
    amount: number,
    sourceWeapon: string
  ): number[] {
    const killed: number[] = [];
    const halfArc = arcRad * 0.5;
    const enemies = this.getEnemies();

    for (const e of enemies) {
      if (!e.alive) continue;
      const to = V2.sub(e.pos, origin);
      const dist = V2.len(to);
      if (dist > range || dist < 0.001) continue;

      const angleTo = Math.atan2(to.y, to.x);
      const diff = Math.abs(((angleTo - angleRad + Math.PI) % (Math.PI * 2)) - Math.PI);
      if (diff <= halfArc) {
        if (this.applyDamage(e.id, amount, sourceWeapon)) {
          killed.push(e.id);
        }
      }
    }
    return killed;
  }

  // ── ICollisionBridge: Physics Effects ──────────────────────────────────────

  pullEnemies(center: Vec2, radius: number, force: number, dt: number): void {
    const soa = this._getSoA();
    const victims = this._swarm.getEnemiesWithinRadius(center, radius);
    for (const v of victims) {
      const idx = this._findIndexById(v.id);
      if (idx === -1) continue;
      const dx = center.x - soa.x[idx];
      const dy = center.y - soa.y[idx];
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      soa.vx[idx] += (dx / dist) * force * dt;
      soa.vy[idx] += (dy / dist) * force * dt;
    }
  }

  pushEnemies(center: Vec2, radius: number, force: number, dt: number): void {
    const soa = this._getSoA();
    const victims = this._swarm.getEnemiesWithinRadius(center, radius);
    for (const v of victims) {
      const idx = this._findIndexById(v.id);
      if (idx === -1) continue;
      const dx = soa.x[idx] - center.x;
      const dy = soa.y[idx] - center.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      soa.vx[idx] += (dx / dist) * force * dt;
      soa.vy[idx] += (dy / dist) * force * dt;
    }
  }

  // ── ICollisionBridge: Status Effects ───────────────────────────────────────

  applySlow(center: Vec2, radius: number, slowPct: number, duration: number, sourceWeapon: string): void {
    const victims = this._swarm.getEnemiesWithinRadius(center, radius);
    for (const v of victims) {
      const entry = this._statusTable.get(v.id) ?? {
        slowPct: 0, slowTimer: 0, dotDps: 0, dotTimer: 0, dotSource: "",
      };
      entry.slowPct = Math.max(entry.slowPct, slowPct);
      entry.slowTimer = Math.max(entry.slowTimer, duration);
      entry.dotSource = sourceWeapon;
      this._statusTable.set(v.id, entry);
    }
  }

  applyDOT(center: Vec2, radius: number, dps: number, duration: number, sourceWeapon: string): void {
    const victims = this._swarm.getEnemiesWithinRadius(center, radius);
    for (const v of victims) {
      const entry = this._statusTable.get(v.id) ?? {
        slowPct: 0, slowTimer: 0, dotDps: 0, dotTimer: 0, dotSource: "",
      };
      entry.dotDps = Math.max(entry.dotDps, dps);
      entry.dotTimer = Math.max(entry.dotTimer, duration);
      entry.dotSource = sourceWeapon;
      this._statusTable.set(v.id, entry);
    }
  }

  // ── Cache Rebuild ──────────────────────────────────────────────────────────

  private _rebuildCache(): void {
    if (!this._cacheDirty) return;
    this._cacheDirty = false;

    const soa = this._getSoA();
    const out: IEnemy[] = [];
    // MAX_SWARM_SIZE is 2048; scanning the whole array is ~0.03ms on modern JS
    for (let i = 0; i < soa.alive.length; i++) {
      if (soa.alive[i]) {
        const id = soa.id[i];
        const status = this._statusTable.get(id);
        out.push({
          id,
          pos: { x: soa.x[i], y: soa.y[i] },
          radius: soa.radius[i],
          hp: soa.hp[i],
          maxHp: soa.maxHp[i],
          speed: soa.speed[i] * (status ? (1 - status.slowPct) : 1),
          alive: true,
          slowPct: status?.slowPct,
          slowTimer: status?.slowTimer,
          dotDps: status?.dotDps,
          dotTimer: status?.dotTimer,
          dotSource: status?.dotSource,
        });
      }
    }
    this._enemyCache = out;
  }

  // ── SoA Access ─────────────────────────────────────────────────────────────

  private _getSoA() {
    return (this._swarm as any).soa as {
      alive: Uint8Array; id: Uint16Array;
      x: Float32Array; y: Float32Array;
      vx: Float32Array; vy: Float32Array;
      hp: Float32Array; maxHp: Float32Array;
      speed: Float32Array; radius: Float32Array;
    };
  }

  private _findIndexById(id: number): number {
    const soa = this._getSoA();
    for (let i = 0; i < soa.alive.length; i++) {
      if (soa.alive[i] && soa.id[i] === id) return i;
    }
    return -1;
  }
}
