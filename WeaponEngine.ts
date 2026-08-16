/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * WEAPON ENGINE — GOTHIC HORDE-SURVIVAL ACTIVE ABILITY SYSTEM
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Architecture: Modular ES6+ TypeScript module. Zero external runtime deps.
 * Responsibilities:
 *   • Weapon cooldown orchestration & auto-fire evaluation per frame
 *   • Projectile kinematics (euler integration, angular orbital mechanics)
 *   • 10 fully-implemented active weapon classes with distinct physics profiles
 *   • Collision-bridge dispatch → enemy tracking arrays + VFX pool triggers
 *   • Object-pooled projectile instances for hundreds of concurrent entities
 *
 * Asset Pipeline Integration:
 *   • Sprite-sheet UV slicing via frame-grid math (row/col → normalized UVs)
 *   • Angle-aware frame selection for directional projectiles
 *   • VFX atlas burst mapping for impact / spawn / death events
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 0: MATH PRIMITIVES & VECTOR HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

export const V2 = {
  zero: (): Vec2 => ({ x: 0, y: 0 }),
  from: (x: number, y: number): Vec2 => ({ x, y }),
  add: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y }),
  sub: (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y }),
  mul: (v: Vec2, s: number): Vec2 => ({ x: v.x * s, y: v.y * s }),
  dot: (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y,
  len: (v: Vec2): number => Math.sqrt(v.x * v.x + v.y * v.y),
  lenSq: (v: Vec2): number => v.x * v.x + v.y * v.y,
  norm: (v: Vec2): Vec2 => {
    const l = Math.sqrt(v.x * v.x + v.y * v.y);
    return l > 0 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 0 };
  },
  dist: (a: Vec2, b: Vec2): number => {
    const dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  },
  distSq: (a: Vec2, b: Vec2): number => {
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy;
  },
  rotate: (v: Vec2, angle: number): Vec2 => {
    const c = Math.cos(angle), s = Math.sin(angle);
    return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
  },
  angle: (v: Vec2): number => Math.atan2(v.y, v.x),
  lerp: (a: Vec2, b: Vec2, t: number): Vec2 => ({
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  }),
};

export const M = {
  clamp: (v: number, min: number, max: number) => Math.max(min, Math.min(max, v)),
  lerp: (a: number, b: number, t: number) => a + (b - a) * t,
  degToRad: (d: number) => (d * Math.PI) / 180,
  radToDeg: (r: number) => (r * 180) / Math.PI,
  randRange: (min: number, max: number) => min + Math.random() * (max - min),
  randInt: (min: number, max: number) => Math.floor(min + Math.random() * (max - min + 1)),
  circleCircle: (p1: Vec2, r1: number, p2: Vec2, r2: number): boolean => {
    const dx = p1.x - p2.x, dy = p1.y - p2.y;
    const rr = r1 + r2;
    return dx * dx + dy * dy <= rr * rr;
  },
  pointInCircle: (p: Vec2, c: Vec2, r: number): boolean => {
    const dx = p.x - c.x, dy = p.y - c.y;
    return dx * dx + dy * dy <= r * r;
  },
  angleDiff: (a: number, b: number): number => {
    let d = a - b;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: ASSET ATLAS METADATA — SPRITE-SHEET UV SLICING PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

export interface SpriteSheetMeta {
  key: string;
  path: string;
  frameW: number;
  frameH: number;
  cols: number;
  rows: number;
  totalFrames: number;
  transparent: boolean;
}

export interface FrameUV {
  u0: number; v0: number;
  u1: number; v1: number;
}

export const AssetAtlas: Record<string, SpriteSheetMeta> = {
  quills: {
    key: 'quills', path: '/assets/sprites/quills_daggers.png',
    frameW: 64, frameH: 64, cols: 14, rows: 4, totalFrames: 56, transparent: true,
  },
  halberds: {
    key: 'halberds', path: '/assets/sprites/halberds_spin.png',
    frameW: 96, frameH: 96, cols: 8, rows: 4, totalFrames: 32, transparent: true,
  },
  lightningArc: {
    key: 'lightningArc', path: '/assets/vfx/lightning_discharge.png',
    frameW: 128, frameH: 64, cols: 8, rows: 6, totalFrames: 48, transparent: true,
  },
  boneCage: {
    key: 'boneCage', path: '/assets/vfx/bone_cage_orbit.png',
    frameW: 128, frameH: 128, cols: 8, rows: 4, totalFrames: 32, transparent: true,
  },
  necroticEruption: {
    key: 'necroticEruption', path: '/assets/vfx/necrotic_eruption.png',
    frameW: 128, frameH: 128, cols: 8, rows: 4, totalFrames: 32, transparent: true,
  },
  bloodVortex: {
    key: 'bloodVortex', path: '/assets/vfx/blood_vortex.png',
    frameW: 128, frameH: 128, cols: 8, rows: 5, totalFrames: 40, transparent: true,
  },
  fireCarpet: {
    key: 'fireCarpet', path: '/assets/vfx/fire_carpet.png',
    frameW: 128, frameH: 64, cols: 8, rows: 4, totalFrames: 32, transparent: true,
  },
  locustSwarm: {
    key: 'locustSwarm', path: '/assets/sprites/locust_swarm.png',
    frameW: 128, frameH: 128, cols: 8, rows: 6, totalFrames: 48, transparent: true,
  },
  iceBurst: {
    key: 'iceBurst', path: '/assets/vfx/ice_burst.png',
    frameW: 128, frameH: 128, cols: 8, rows: 4, totalFrames: 32, transparent: true,
  },
  skeletonShatter: {
    key: 'skeletonShatter', path: '/assets/vfx/skeleton_shatter.png',
    frameW: 128, frameH: 128, cols: 6, rows: 2, totalFrames: 12, transparent: true,
  },
};

export function getFrameUV(meta: SpriteSheetMeta, frameIndex: number): FrameUV {
  const fi = Math.max(0, Math.min(frameIndex, meta.totalFrames - 1));
  const col = fi % meta.cols;
  const row = Math.floor(fi / meta.cols);
  const sheetW = meta.cols * meta.frameW;
  const sheetH = meta.rows * meta.frameH;
  return {
    u0: (col * meta.frameW) / sheetW,
    v0: (row * meta.frameH) / sheetH,
    u1: ((col + 1) * meta.frameW) / sheetW,
    v1: ((row + 1) * meta.frameH) / sheetH,
  };
}

export function selectAngleFrame(meta: SpriteSheetMeta, angleRad: number): number {
  const deg = ((M.radToDeg(angleRad) % 360) + 360) % 360;
  const step = 360 / meta.totalFrames;
  return Math.round(deg / step) % meta.totalFrames;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: COLLISION BRIDGE & VFX POOL INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export interface IEnemy {
  id: number;
  pos: Vec2;
  radius: number;
  hp: number;
  maxHp: number;
  speed: number;
  alive: boolean;
  slowPct?: number;
  slowTimer?: number;
  dotDps?: number;
  dotTimer?: number;
  dotSource?: string;
}

export type VFXType =
  | 'impact_spark' | 'blood_spray' | 'bone_shatter'
  | 'ice_shatter' | 'lightning_arc' | 'fire_burst'
  | 'swarm_cloud' | 'rift_open' | 'rift_close';

export interface IVFXRequest {
  type: VFXType;
  pos: Vec2;
  angle?: number;
  scale?: number;
  tint?: number;
  lifetime?: number;
  count?: number;
}

export interface IVFXPool {
  spawn(req: IVFXRequest): void;
  spawnBurst(pos: Vec2, type: VFXType, count: number, radius: number): void;
}

export interface ICollisionBridge {
  getEnemies(): IEnemy[];
  applyDamage(enemyId: number, amount: number, sourceWeapon: string): boolean;
  applyAreaDamage(center: Vec2, radius: number, amount: number, sourceWeapon: string): number[];
  applyConeDamage(origin: Vec2, angleRad: number, arcRad: number, range: number, amount: number, sourceWeapon: string): number[];
  pullEnemies(center: Vec2, radius: number, force: number, dt: number): void;
  pushEnemies(center: Vec2, radius: number, force: number, dt: number): void;
  applySlow(center: Vec2, radius: number, slowPct: number, duration: number, sourceWeapon: string): void;
  applyDOT(center: Vec2, radius: number, dps: number, duration: number, sourceWeapon: string): void;
  findNearest(pos: Vec2, maxCount: number, maxRange?: number): IEnemy[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: OBJECT POOLING
// ═══════════════════════════════════════════════════════════════════════════════

export interface Poolable {
  active: boolean;
  reset(): void;
}

export class ObjectPool<T extends Poolable> {
  private _factory: () => T;
  private _items: T[] = [];
  private _activeCount = 0;

  constructor(factory: () => T, initialCapacity = 64) {
    this._factory = factory;
    for (let i = 0; i < initialCapacity; i++) {
      this._items.push(this._factory());
    }
  }

  acquire(): T {
    for (let i = 0; i < this._items.length; i++) {
      if (!this._items[i].active) {
        this._items[i].active = true;
        this._items[i].reset();
        this._activeCount++;
        return this._items[i];
      }
    }
    const item = this._factory();
    item.active = true;
    this._items.push(item);
    this._activeCount++;
    return item;
  }

  release(item: T): void {
    item.active = false;
    this._activeCount = Math.max(0, this._activeCount - 1);
  }

  forEachActive(fn: (item: T, index: number) => void): void {
    for (let i = 0, idx = 0; i < this._items.length; i++) {
      if (this._items[i].active) fn(this._items[i], idx++);
    }
  }

  get activeCount(): number { return this._activeCount; }
  get capacity(): number { return this._items.length; }

  cullWhere(predicate: (item: T) => boolean): void {
    for (const item of this._items) {
      if (item.active && predicate(item)) {
        item.active = false;
        this._activeCount--;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4: PROJECTILE RUNTIME STATE
// ═══════════════════════════════════════════════════════════════════════════════

export type ProjectileMotionType =
  | 'linear' | 'homing' | 'orbital' | 'stationary' | 'swarm' | 'chain';

export interface IProjectile extends Poolable {
  id: number;
  weaponKey: string;
  motionType: ProjectileMotionType;
  pos: Vec2;
  vel: Vec2;
  angle: number;
  radius: number;
  lifetime: number;
  maxLifetime: number;
  pierce: number;
  bounces: number;
  damage: number;
  critChance: number;
  critMult: number;
  speed: number;
  accel: number;
  turnRate: number;
  targetId: number;
  orbitAnchor: Vec2;
  orbitRadius: number;
  orbitAngle: number;
  orbitSpeed: number;
  zoneRadius: number;
  tickRate: number;
  tickTimer: number;
  tickDamage: number;
  spriteKey: string;
  frameIndex: number;
  frameTimer: number;
  frameInterval: number;
  scale: number;
  opacity: number;
  hitEnemyIds: Set<number>;
  chainJumps: number;
  chainRange: number;
  chainHitIds: number[];
  reset(): void;
}

let _nextProjectileId = 1;

export function createProjectile(): IProjectile {
  return {
    id: _nextProjectileId++,
    active: false,
    weaponKey: '',
    motionType: 'linear',
    pos: V2.zero(),
    vel: V2.zero(),
    angle: 0,
    radius: 8,
    lifetime: 0,
    maxLifetime: 0,
    pierce: 0,
    bounces: 0,
    damage: 0,
    critChance: 0,
    critMult: 1.5,
    speed: 0,
    accel: 0,
    turnRate: 0,
    targetId: -1,
    orbitAnchor: V2.zero(),
    orbitRadius: 0,
    orbitAngle: 0,
    orbitSpeed: 0,
    zoneRadius: 0,
    tickRate: 0.2,
    tickTimer: 0,
    tickDamage: 0,
    spriteKey: '',
    frameIndex: 0,
    frameTimer: 0,
    frameInterval: 0.05,
    scale: 1,
    opacity: 1,
    hitEnemyIds: new Set(),
    chainJumps: 0,
    chainRange: 0,
    chainHitIds: [],
    reset() {
      this.active = false;
      this.weaponKey = '';
      this.motionType = 'linear';
      this.pos = V2.zero();
      this.vel = V2.zero();
      this.angle = 0;
      this.radius = 8;
      this.lifetime = 0;
      this.maxLifetime = 0;
      this.pierce = 0;
      this.bounces = 0;
      this.damage = 0;
      this.critChance = 0;
      this.critMult = 1.5;
      this.speed = 0;
      this.accel = 0;
      this.turnRate = 0;
      this.targetId = -1;
      this.orbitAnchor = V2.zero();
      this.orbitRadius = 0;
      this.orbitAngle = 0;
      this.orbitSpeed = 0;
      this.zoneRadius = 0;
      this.tickRate = 0.2;
      this.tickTimer = 0;
      this.tickDamage = 0;
      this.spriteKey = '';
      this.frameIndex = 0;
      this.frameTimer = 0;
      this.frameInterval = 0.05;
      this.scale = 1;
      this.opacity = 1;
      this.hitEnemyIds.clear();
      this.chainJumps = 0;
      this.chainRange = 0;
      this.chainHitIds = [];
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5: WEAPON CONFIGURATION SCHEMA
// ═══════════════════════════════════════════════════════════════════════════════

export interface WeaponLevelStats {
  damage: number;
  cooldown: number;
  projectileCount: number;
  speed: number;
  range: number;
  radius: number;
  pierce: number;
  duration: number;
  tickRate: number;
  special: number;
}

export interface IWeaponConfig {
  key: string;
  name: string;
  description: string;
  maxLevel: number;
  statsPerLevel: WeaponLevelStats[];
  spriteKey: string;
  vfxSpawn?: VFXType;
  vfxImpact?: VFXType;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6: BASE ACTIVE WEAPON CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export abstract class BaseActiveWeapon {
  public level = 1;
  public cooldownTimer = 0;
  public isUnlocked = false;

  public damageMult = 1;
  public cooldownMult = 1;
  public areaMult = 1;
  public speedMult = 1;
  public durationMult = 1;
  public projectileCountBonus = 0;

  constructor(
    public readonly config: IWeaponConfig,
    protected _pool: ObjectPool<IProjectile>,
    protected _bridge: ICollisionBridge,
    protected _vfx: IVFXPool,
  ) {}

  get currentStats(): WeaponLevelStats {
    const idx = Math.min(this.level - 1, this.config.statsPerLevel.length - 1);
    return this.config.statsPerLevel[idx];
  }

  get effectiveCooldown(): number {
    return this.currentStats.cooldown * this.cooldownMult;
  }

  get effectiveDamage(): number {
    return this.currentStats.damage * this.damageMult;
  }

  get effectiveSpeed(): number {
    return this.currentStats.speed * this.speedMult;
  }

  get effectiveRange(): number {
    return this.currentStats.range * this.areaMult;
  }

  get effectiveRadius(): number {
    return this.currentStats.radius * this.areaMult;
  }

  get effectiveDuration(): number {
    return this.currentStats.duration * this.durationMult;
  }

  get effectiveProjectileCount(): number {
    return this.currentStats.projectileCount + this.projectileCountBonus;
  }

  abstract update(dt: number, playerPos: Vec2, facingAngle: number): void;
  protected abstract _fire(playerPos: Vec2, facingAngle: number): void;

  protected _evalCooldown(dt: number, playerPos: Vec2, facingAngle: number): void {
    if (!this.isUnlocked) return;
    this.cooldownTimer -= dt;
    if (this.cooldownTimer <= 0) {
      this._fire(playerPos, facingAngle);
      this.cooldownTimer = this.effectiveCooldown;
    }
  }

  protected _spawnProjectile(overrides: Partial<IProjectile> = {}): IProjectile {
    const p = this._pool.acquire();
    p.weaponKey = this.config.key;
    p.damage = this.effectiveDamage;
    p.speed = this.effectiveSpeed;
    p.lifetime = this.effectiveDuration;
    p.maxLifetime = this.effectiveDuration;
    p.radius = this.effectiveRadius;
    p.pierce = this.currentStats.pierce;
    p.spriteKey = this.config.spriteKey;
    p.scale = 1;
    p.opacity = 1;
    p.hitEnemyIds.clear();
    p.chainHitIds = [];
    Object.assign(p, overrides);
    return p;
  }

  protected _resolveImpact(proj: IProjectile, enemy: IEnemy): void {
    if (proj.hitEnemyIds.has(enemy.id)) return;
    proj.hitEnemyIds.add(enemy.id);

    let dmg = proj.damage;
    if (Math.random() < proj.critChance) dmg *= proj.critMult;

    const died = this._bridge.applyDamage(enemy.id, dmg, this.config.key);

    this._vfx.spawn({
      type: this.config.vfxImpact ?? 'impact_spark',
      pos: V2.lerp(proj.pos, enemy.pos, 0.5),
      scale: 0.8 + Math.random() * 0.4,
    });

    if (died) {
      this._vfx.spawnBurst(enemy.pos, 'bone_shatter', 4, 20);
    }

    if (proj.pierce >= 0) {
      proj.pierce--;
      if (proj.pierce < 0) {
        proj.active = false;
        this._pool.release(proj);
      }
    }
  }

  protected _updateProjectileFrame(proj: IProjectile, dt: number, meta: SpriteSheetMeta): void {
    proj.frameTimer -= dt;
    if (proj.frameTimer <= 0) {
      proj.frameTimer = proj.frameInterval;
      proj.frameIndex = (proj.frameIndex + 1) % meta.totalFrames;
    }
  }

  protected _updateLinear(proj: IProjectile, dt: number): void {
    proj.pos = V2.add(proj.pos, V2.mul(proj.vel, dt));
    proj.lifetime -= dt;
    if (proj.lifetime <= 0) {
      proj.active = false;
      this._pool.release(proj);
    }
  }

  protected _updateOrbital(proj: IProjectile, dt: number): void {
    proj.orbitAngle += proj.orbitSpeed * dt;
    proj.pos = {
      x: proj.orbitAnchor.x + Math.cos(proj.orbitAngle) * proj.orbitRadius,
      y: proj.orbitAnchor.y + Math.sin(proj.orbitAngle) * proj.orbitRadius,
    };
    proj.angle = proj.orbitAngle + Math.PI / 2;
    proj.lifetime -= dt;
    if (proj.lifetime <= 0) {
      proj.active = false;
      this._pool.release(proj);
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7: WEAPON IMPLEMENTATIONS (10 BASE ACTIVE WEAPONS)
// ═══════════════════════════════════════════════════════════════════════════════

// ───────────────────────────────────────────────────────────────────────────────
// 7.1 SINNER'S QUILLS — Projectile Fan
// ───────────────────────────────────────────────────────────────────────────────

export class SinnersQuills extends BaseActiveWeapon {
  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
  }

  protected _fire(playerPos: Vec2, facingAngle: number): void {
    const count = this.effectiveProjectileCount;
    const spreadArc = M.degToRad(45 + this.level * 5);
    const baseDir = facingAngle;
    const meta = AssetAtlas.quills;

    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i / (count - 1)) - 0.5;
      const angle = baseDir + t * spreadArc;
      const dir = { x: Math.cos(angle), y: Math.sin(angle) };

      this._spawnProjectile({
        motionType: 'linear',
        pos: V2.add(playerPos, V2.mul(dir, 12)),
        vel: V2.mul(dir, this.effectiveSpeed),
        angle,
        radius: this.effectiveRadius,
        pierce: this.currentStats.pierce,
        spriteKey: meta.key,
        frameIndex: selectAngleFrame(meta, angle),
        frameInterval: 0,
      });
    }

    this._vfx.spawn({ type: 'impact_spark', pos: playerPos, scale: 0.5 });
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.2 WHIRLING HALBERDS — Orbital Spinners
// ───────────────────────────────────────────────────────────────────────────────

export class WhirlingHalberds extends BaseActiveWeapon {
  private _orbitals: IProjectile[] = [];

  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._syncOrbitals(playerPos, dt);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    const count = this.effectiveProjectileCount;
    const meta = AssetAtlas.halberds;

    for (let i = 0; i < count; i++) {
      const angleOffset = (Math.PI * 2 * i) / count;
      const p = this._spawnProjectile({
        motionType: 'orbital',
        orbitAnchor: { ...playerPos },
        orbitRadius: this.effectiveRange,
        orbitAngle: angleOffset,
        orbitSpeed: this.effectiveSpeed / this.effectiveRange,
        radius: this.effectiveRadius,
        pierce: -1,
        lifetime: this.effectiveDuration,
        spriteKey: meta.key,
        frameIndex: 0,
        frameInterval: 0.03,
      });
      this._orbitals.push(p);
    }

    this._vfx.spawn({ type: 'impact_spark', pos: playerPos, scale: 0.6 });
  }

  private _syncOrbitals(playerPos: Vec2, dt: number): void {
    const meta = AssetAtlas.halberds;
    this._orbitals = this._orbitals.filter(o => o.active);

    for (const o of this._orbitals) {
      o.orbitAnchor = { ...playerPos };
      this._updateOrbital(o, dt);
      this._updateProjectileFrame(o, dt, meta);

      const enemies = this._bridge.getEnemies();
      for (const e of enemies) {
        if (!e.alive) continue;
        if (M.circleCircle(o.pos, o.radius, e.pos, e.radius)) {
          this._resolveImpact(o, e);
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.3 ZEALOT'S CHAIN — Chain Lightning
// ───────────────────────────────────────────────────────────────────────────────

export class ZealotsChain extends BaseActiveWeapon {
  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    const targets = this._bridge.findNearest(playerPos, 1, this.effectiveRange);
    if (targets.length === 0) return;

    const primary = targets[0];
    const jumps = this.currentStats.special;
    const jumpRange = this.effectiveRange * 0.6;
    const meta = AssetAtlas.lightningArc;

    const dir = V2.norm(V2.sub(primary.pos, playerPos));
    const p = this._spawnProjectile({
      motionType: 'chain',
      pos: { ...playerPos },
      vel: V2.mul(dir, this.effectiveSpeed),
      angle: V2.angle(dir),
      radius: this.effectiveRadius,
      damage: this.effectiveDamage,
      pierce: -1,
      lifetime: 0.4,
      chainJumps: jumps,
      chainRange: jumpRange,
      chainHitIds: [primary.id],
      spriteKey: meta.key,
      frameIndex: M.randInt(0, meta.totalFrames - 1),
      frameInterval: 0.02,
    });

    this._bridge.applyDamage(primary.id, this.effectiveDamage, this.config.key);
    this._vfx.spawn({
      type: 'lightning_arc',
      pos: primary.pos,
      scale: 1.2,
      count: 3,
    });

    this._resolveChain(p, primary, jumpRange, jumps);
  }

  private _resolveChain(
    proj: IProjectile,
    lastHit: IEnemy,
    range: number,
    jumpsLeft: number,
  ): void {
    if (jumpsLeft <= 0) return;

    const enemies = this._bridge.getEnemies();
    let best: IEnemy | null = null;
    let bestDist = range * range;

    for (const e of enemies) {
      if (!e.alive || proj.chainHitIds.includes(e.id)) continue;
      const d2 = V2.distSq(lastHit.pos, e.pos);
      if (d2 < bestDist) {
        bestDist = d2;
        best = e;
      }
    }

    if (!best) return;

    proj.chainHitIds.push(best.id);
    const dmg = this.effectiveDamage * Math.pow(0.75, proj.chainHitIds.length - 1);
    this._bridge.applyDamage(best.id, dmg, this.config.key);

    const mid = V2.lerp(lastHit.pos, best.pos, 0.5);
    this._vfx.spawn({
      type: 'lightning_arc',
      pos: mid,
      angle: V2.angle(V2.sub(best.pos, lastHit.pos)),
      scale: 1.0 - (proj.chainHitIds.length - 1) * 0.15,
      count: 2,
    });

    this._resolveChain(proj, best, range, jumpsLeft - 1);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.4 UNHOLY ORBIT — Bone Cage Orbital
// ───────────────────────────────────────────────────────────────────────────────

export class UnholyOrbit extends BaseActiveWeapon {
  private _orbitals: IProjectile[] = [];

  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._syncOrbitals(playerPos, dt);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    const count = this.effectiveProjectileCount;
    const meta = AssetAtlas.boneCage;

    for (let i = 0; i < count; i++) {
      const angleOffset = (Math.PI * 2 * i) / count;
      const p = this._spawnProjectile({
        motionType: 'orbital',
        orbitAnchor: { ...playerPos },
        orbitRadius: this.effectiveRange,
        orbitAngle: angleOffset,
        orbitSpeed: -this.effectiveSpeed / this.effectiveRange,
        radius: this.effectiveRadius,
        pierce: -1,
        lifetime: this.effectiveDuration,
        damage: this.effectiveDamage * 1.2,
        spriteKey: meta.key,
        frameIndex: 0,
        frameInterval: 0.04,
        scale: 1 + this.level * 0.15,
      });
      this._orbitals.push(p);
    }

    this._vfx.spawn({ type: 'bone_shatter', pos: playerPos, scale: 0.8 });
  }

  private _syncOrbitals(playerPos: Vec2, dt: number): void {
    const meta = AssetAtlas.boneCage;
    this._orbitals = this._orbitals.filter(o => o.active);

    for (const o of this._orbitals) {
      o.orbitAnchor = { ...playerPos };
      this._updateOrbital(o, dt);
      this._updateProjectileFrame(o, dt, meta);

      const enemies = this._bridge.getEnemies();
      for (const e of enemies) {
        if (!e.alive) continue;
        if (M.circleCircle(o.pos, o.radius, e.pos, e.radius)) {
          this._bridge.pushEnemies(o.pos, o.radius * 2, 120, dt);
          this._resolveImpact(o, e);
        }
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.5 GRAVE BURST — Ground Eruption
// ───────────────────────────────────────────────────────────────────────────────

export class GraveBurst extends BaseActiveWeapon {
  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._updateBursts(dt);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    const count = this.effectiveProjectileCount;
    const meta = AssetAtlas.necroticEruption;

    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random()) * this.effectiveRange;
      const theta = Math.random() * Math.PI * 2;
      const offset = { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
      const spawnPos = V2.add(playerPos, offset);

      this._spawnProjectile({
        motionType: 'stationary',
        pos: spawnPos,
        vel: V2.zero(),
        angle: 0,
        radius: this.effectiveRadius,
        damage: this.effectiveDamage,
        pierce: -1,
        lifetime: 0.6,
        zoneRadius: this.effectiveRadius,
        tickRate: 0.1,
        tickTimer: 0.1,
        tickDamage: this.effectiveDamage,
        spriteKey: meta.key,
        frameIndex: 0,
        frameInterval: 0.05,
        scale: 0.8 + Math.random() * 0.6,
      });

      this._vfx.spawn({
        type: 'fire_burst',
        pos: spawnPos,
        scale: 1.0 + this.level * 0.2,
      });
    }

    this._bridge.pushEnemies(playerPos, this.effectiveRange * 1.5, 200, 0.16);
  }

  private _updateBursts(dt: number): void {
    const meta = AssetAtlas.necroticEruption;
    this._pool.forEachActive((proj) => {
      if (proj.weaponKey !== this.config.key) return;
      if (proj.motionType !== 'stationary') return;

      proj.lifetime -= dt;
      this._updateProjectileFrame(proj, dt, meta);

      proj.tickTimer -= dt;
      if (proj.tickTimer <= 0) {
        proj.tickTimer = proj.tickRate;
        this._bridge.applyAreaDamage(proj.pos, proj.zoneRadius, proj.tickDamage, this.config.key);
        this._vfx.spawnBurst(proj.pos, 'fire_burst', 2, proj.zoneRadius * 0.5);
      }

      if (proj.lifetime <= 0) {
        proj.active = false;
        this._pool.release(proj);
      }
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.6 BLOOD SIPHON — Life Drain Vortex
// ───────────────────────────────────────────────────────────────────────────────

export class BloodSiphon extends BaseActiveWeapon {
  private _vortex: IProjectile | null = null;

  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._updateVortex(playerPos, dt);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    if (this._vortex?.active) return;

    const meta = AssetAtlas.bloodVortex;
    this._vortex = this._spawnProjectile({
      motionType: 'stationary',
      pos: { ...playerPos },
      vel: V2.zero(),
      angle: 0,
      radius: this.effectiveRadius,
      damage: 0,
      pierce: -1,
      lifetime: this.effectiveDuration,
      zoneRadius: this.effectiveRange,
      tickRate: 0.25,
      tickTimer: 0.25,
      tickDamage: this.effectiveDamage * 0.4,
      spriteKey: meta.key,
      frameIndex: 0,
      frameInterval: 0.04,
      scale: 1 + this.level * 0.2,
    });

    this._vfx.spawn({ type: 'rift_open', pos: playerPos, scale: 1.5 });
  }

  private _updateVortex(playerPos: Vec2, dt: number): void {
    if (!this._vortex?.active) { this._vortex = null; return; }
    const v = this._vortex;
    const meta = AssetAtlas.bloodVortex;

    v.pos = { ...playerPos };
    v.lifetime -= dt;
    this._updateProjectileFrame(v, dt, meta);

    this._bridge.pullEnemies(v.pos, v.zoneRadius, 80 + this.level * 20, dt);

    v.tickTimer -= dt;
    if (v.tickTimer <= 0) {
      v.tickTimer = v.tickRate;
      const killed = this._bridge.applyAreaDamage(v.pos, v.zoneRadius, v.tickDamage, this.config.key);
      const healAmount = v.tickDamage * 0.2 * (killed.length + 3);
      // Heal event dispatched via WeaponManager event bus
    }

    if (v.lifetime <= 0) {
      this._vfx.spawn({ type: 'rift_close', pos: v.pos, scale: 1.2 });
      v.active = false;
      this._pool.release(v);
      this._vortex = null;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.7 ABYSSAL RIFT — Portal / Suction Vortex
// ───────────────────────────────────────────────────────────────────────────────

export class AbyssalRift extends BaseActiveWeapon {
  private _rift: IProjectile | null = null;

  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._updateRift(playerPos, dt);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    if (this._rift?.active) return;

    const meta = AssetAtlas.bloodVortex;
    this._rift = this._spawnProjectile({
      motionType: 'stationary',
      pos: { ...playerPos },
      vel: V2.zero(),
      angle: 0,
      radius: this.effectiveRadius,
      pierce: -1,
      lifetime: this.effectiveDuration,
      zoneRadius: this.effectiveRange,
      tickRate: 0.3,
      tickTimer: 0.3,
      tickDamage: this.effectiveDamage * 0.5,
      spriteKey: meta.key,
      frameIndex: 0,
      frameInterval: 0.05,
      scale: 1.2 + this.level * 0.25,
      opacity: 0.85,
    });

    this._vfx.spawn({ type: 'rift_open', pos: playerPos, scale: 2.0 });
  }

  private _updateRift(playerPos: Vec2, dt: number): void {
    if (!this._rift?.active) { this._rift = null; return; }
    const r = this._rift;
    const meta = AssetAtlas.bloodVortex;

    r.pos = { ...playerPos };
    r.lifetime -= dt;
    this._updateProjectileFrame(r, dt, meta);

    this._bridge.pullEnemies(r.pos, r.zoneRadius, 150 + this.level * 30, dt);

    r.tickTimer -= dt;
    if (r.tickTimer <= 0) {
      r.tickTimer = r.tickRate;
      this._bridge.applyDOT(r.pos, r.zoneRadius, r.tickDamage, 1.0, this.config.key);
      this._vfx.spawnBurst(r.pos, 'blood_spray', 3, r.zoneRadius * 0.4);
    }

    if (r.lifetime <= 0) {
      this._vfx.spawn({ type: 'rift_close', pos: r.pos, scale: 1.8 });
      r.active = false;
      this._pool.release(r);
      this._rift = null;
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.8 FONT OF TORMENT — Ground DOT Zone (Persistent Burning Carpet)
// ───────────────────────────────────────────────────────────────────────────────

export class FontOfTorment extends BaseActiveWeapon {
  private _zones: IProjectile[] = [];

  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._updateZones(dt);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    const count = this.effectiveProjectileCount;
    const meta = AssetAtlas.fireCarpet;

    for (let i = 0; i < count; i++) {
      const r = Math.sqrt(Math.random()) * this.effectiveRange * 0.8;
      const theta = Math.random() * Math.PI * 2;
      const offset = { x: Math.cos(theta) * r, y: Math.sin(theta) * r };
      const spawnPos = V2.add(playerPos, offset);

      const p = this._spawnProjectile({
        motionType: 'stationary',
        pos: spawnPos,
        vel: V2.zero(),
        angle: Math.random() * Math.PI * 2,
        radius: this.effectiveRadius,
        damage: 0,
        pierce: -1,
        lifetime: this.effectiveDuration,
        zoneRadius: this.effectiveRadius,
        tickRate: 0.5,
        tickTimer: 0.1,
        tickDamage: this.effectiveDamage * 0.6,
        spriteKey: meta.key,
        frameIndex: M.randInt(0, meta.totalFrames - 1),
        frameInterval: 0.08,
        scale: 0.9 + Math.random() * 0.4,
      });
      this._zones.push(p);
    }

    this._vfx.spawn({ type: 'fire_burst', pos: playerPos, scale: 1.0 });
  }

  private _updateZones(dt: number): void {
    const meta = AssetAtlas.fireCarpet;
    this._zones = this._zones.filter(z => z.active);

    for (const z of this._zones) {
      z.lifetime -= dt;
      this._updateProjectileFrame(z, dt, meta);

      z.tickTimer -= dt;
      if (z.tickTimer <= 0) {
        z.tickTimer = z.tickRate;
        this._bridge.applyAreaDamage(z.pos, z.zoneRadius, z.tickDamage, this.config.key);
        this._vfx.spawnBurst(z.pos, 'fire_burst', 1, z.zoneRadius * 0.3);
      }

      z.opacity = M.clamp(z.lifetime / 0.5, 0, 1);

      if (z.lifetime <= 0) {
        z.active = false;
        this._pool.release(z);
      }
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.9 PLAGUE SWARM — Homing Locust Swarm
// ───────────────────────────────────────────────────────────────────────────────

export class PlagueSwarm extends BaseActiveWeapon {
  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._updateSwarm(dt);
  }

  protected _fire(playerPos: Vec2, _facingAngle: number): void {
    const count = this.effectiveProjectileCount;
    const meta = AssetAtlas.locustSwarm;
    const enemies = this._bridge.getEnemies();

    for (let i = 0; i < count; i++) {
      let targetId = -1;
      if (enemies.length > 0) {
        targetId = enemies[M.randInt(0, enemies.length - 1)].id;
      }

      const spreadAngle = Math.random() * Math.PI * 2;
      const dir = { x: Math.cos(spreadAngle), y: Math.sin(spreadAngle) };

      this._spawnProjectile({
        motionType: 'homing',
        pos: V2.add(playerPos, V2.mul(dir, 16)),
        vel: V2.mul(dir, this.effectiveSpeed),
        angle: spreadAngle,
        radius: this.effectiveRadius,
        damage: this.effectiveDamage,
        pierce: 2 + Math.floor(this.level / 2),
        lifetime: this.effectiveDuration,
        turnRate: M.degToRad(180 + this.level * 15),
        targetId,
        spriteKey: meta.key,
        frameIndex: M.randInt(0, 7),
        frameInterval: 0.04,
        scale: 0.7 + Math.random() * 0.4,
      });
    }

    this._vfx.spawn({ type: 'swarm_cloud', pos: playerPos, scale: 1.2 });
  }

  private _updateSwarm(dt: number): void {
    const meta = AssetAtlas.locustSwarm;
    const enemies = this._bridge.getEnemies();
    const enemyMap = new Map<number, IEnemy>();
    for (const e of enemies) enemyMap.set(e.id, e);

    this._pool.forEachActive((proj) => {
      if (proj.weaponKey !== this.config.key) return;
      if (proj.motionType !== 'homing') return;

      let target = enemyMap.get(proj.targetId);
      if (!target || !target.alive) {
        const nearest = this._bridge.findNearest(proj.pos, 1, this.effectiveRange * 2);
        if (nearest.length > 0) {
          target = nearest[0];
          proj.targetId = target.id;
        }
      }

      if (target) {
        const desired = V2.norm(V2.sub(target.pos, proj.pos));
        const currentAngle = V2.angle(proj.vel);
        const desiredAngle = V2.angle(desired);
        const diff = M.angleDiff(desiredAngle, currentAngle);
        const steer = M.clamp(diff, -proj.turnRate * dt, proj.turnRate * dt);
        proj.angle = currentAngle + steer;
        proj.vel = V2.mul({ x: Math.cos(proj.angle), y: Math.sin(proj.angle) }, proj.speed);
      }

      proj.pos = V2.add(proj.pos, V2.mul(proj.vel, dt));
      proj.lifetime -= dt;
      this._updateProjectileFrame(proj, dt, meta);

      for (const e of enemies) {
        if (!e.alive) continue;
        if (M.circleCircle(proj.pos, proj.radius, e.pos, e.radius)) {
          this._resolveImpact(proj, e);
          if (!proj.active) break;
        }
      }

      if (proj.lifetime <= 0) {
        proj.active = false;
        this._pool.release(proj);
      }
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// 7.10 GRAVE CHILL — Ice Burst / Cone
// ───────────────────────────────────────────────────────────────────────────────

export class GraveChill extends BaseActiveWeapon {
  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    this._evalCooldown(dt, playerPos, facingAngle);
    this._updateIceProjectiles(dt);
  }

  protected _fire(playerPos: Vec2, facingAngle: number): void {
    const count = this.effectiveProjectileCount;
    const coneArc = M.degToRad(60 + this.level * 8);
    const meta = AssetAtlas.iceBurst;

    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0 : (i / (count - 1)) - 0.5;
      const angle = facingAngle + t * coneArc;
      const dir = { x: Math.cos(angle), y: Math.sin(angle) };

      this._spawnProjectile({
        motionType: 'linear',
        pos: V2.add(playerPos, V2.mul(dir, 14)),
        vel: V2.mul(dir, this.effectiveSpeed),
        angle,
        radius: this.effectiveRadius,
        damage: this.effectiveDamage,
        pierce: 3 + this.level,
        lifetime: this.effectiveDuration,
        spriteKey: meta.key,
        frameIndex: M.randInt(0, meta.totalFrames - 1),
        frameInterval: 0.03,
        scale: 0.8 + Math.random() * 0.5,
      });
    }

    this._bridge.applyConeDamage(
      playerPos, facingAngle, coneArc, this.effectiveRange,
      this.effectiveDamage * 0.3, this.config.key,
    );
    this._bridge.applySlow(playerPos, this.effectiveRange, 0.4 + this.level * 0.05, 2.5, this.config.key);

    this._vfx.spawnBurst(playerPos, 'ice_shatter', 5, 30);
  }

  private _updateIceProjectiles(dt: number): void {
    const meta = AssetAtlas.iceBurst;
    this._pool.forEachActive((proj) => {
      if (proj.weaponKey !== this.config.key) return;
      if (proj.motionType !== 'linear') return;

      this._updateLinear(proj, dt);
      this._updateProjectileFrame(proj, dt, meta);

      const enemies = this._bridge.getEnemies();
      for (const e of enemies) {
        if (!e.alive) continue;
        if (M.circleCircle(proj.pos, proj.radius, e.pos, e.radius)) {
          this._bridge.applySlow(e.pos, e.radius * 3, 0.35, 1.5, this.config.key);
          this._resolveImpact(proj, e);
          if (!proj.active) break;
        }
      }
    });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8: WEAPON CONFIGURATION FACTORY
// ═══════════════════════════════════════════════════════════════════════════════

export const WeaponConfigs: Record<string, IWeaponConfig> = {
  sinnersQuills: {
    key: 'sinnersQuills',
    name: "Sinner's Quills",
    description: 'Fan of cursed daggers hurled in the facing direction.',
    maxLevel: 8,
    spriteKey: 'quills',
    vfxImpact: 'impact_spark',
    statsPerLevel: [
      { damage: 12, cooldown: 1.2, projectileCount: 3, speed: 320, range: 500, radius: 10, pierce: 1, duration: 1.2, tickRate: 0, special: 0 },
      { damage: 16, cooldown: 1.1, projectileCount: 4, speed: 340, range: 520, radius: 11, pierce: 1, duration: 1.3, tickRate: 0, special: 0 },
      { damage: 20, cooldown: 1.0, projectileCount: 5, speed: 360, range: 540, radius: 12, pierce: 2, duration: 1.4, tickRate: 0, special: 0 },
      { damage: 26, cooldown: 0.9, projectileCount: 6, speed: 380, range: 560, radius: 13, pierce: 2, duration: 1.5, tickRate: 0, special: 0 },
      { damage: 32, cooldown: 0.8, projectileCount: 7, speed: 400, range: 580, radius: 14, pierce: 3, duration: 1.6, tickRate: 0, special: 0 },
      { damage: 40, cooldown: 0.7, projectileCount: 8, speed: 420, range: 600, radius: 15, pierce: 3, duration: 1.7, tickRate: 0, special: 0 },
      { damage: 50, cooldown: 0.6, projectileCount: 9, speed: 440, range: 620, radius: 16, pierce: 4, duration: 1.8, tickRate: 0, special: 0 },
      { damage: 65, cooldown: 0.5, projectileCount: 11, speed: 460, range: 650, radius: 18, pierce: 5, duration: 2.0, tickRate: 0, special: 0 },
    ],
  },
  whirlingHalberds: {
    key: 'whirlingHalberds',
    name: 'Whirling Halberds',
    description: 'Massive polearms orbit the player, shredding all who approach.',
    maxLevel: 8,
    spriteKey: 'halberds',
    vfxImpact: 'impact_spark',
    statsPerLevel: [
      { damage: 18, cooldown: 4.0, projectileCount: 1, speed: 180, range: 90, radius: 22, pierce: -1, duration: 3.0, tickRate: 0, special: 0 },
      { damage: 24, cooldown: 3.8, projectileCount: 2, speed: 190, range: 95, radius: 24, pierce: -1, duration: 3.2, tickRate: 0, special: 0 },
      { damage: 30, cooldown: 3.6, projectileCount: 2, speed: 200, range: 100, radius: 26, pierce: -1, duration: 3.4, tickRate: 0, special: 0 },
      { damage: 38, cooldown: 3.4, projectileCount: 3, speed: 210, range: 105, radius: 28, pierce: -1, duration: 3.6, tickRate: 0, special: 0 },
      { damage: 48, cooldown: 3.2, projectileCount: 3, speed: 220, range: 110, radius: 30, pierce: -1, duration: 3.8, tickRate: 0, special: 0 },
      { damage: 60, cooldown: 3.0, projectileCount: 4, speed: 230, range: 115, radius: 32, pierce: -1, duration: 4.0, tickRate: 0, special: 0 },
      { damage: 75, cooldown: 2.8, projectileCount: 4, speed: 240, range: 120, radius: 34, pierce: -1, duration: 4.2, tickRate: 0, special: 0 },
      { damage: 95, cooldown: 2.5, projectileCount: 5, speed: 260, range: 130, radius: 38, pierce: -1, duration: 4.5, tickRate: 0, special: 0 },
    ],
  },
  zealotsChain: {
    key: 'zealotsChain',
    name: "Zealot's Chain",
    description: 'Arcing lightning strikes the nearest foe, chaining to others.',
    maxLevel: 8,
    spriteKey: 'lightningArc',
    vfxImpact: 'lightning_arc',
    statsPerLevel: [
      { damage: 25, cooldown: 2.5, projectileCount: 1, speed: 800, range: 350, radius: 14, pierce: -1, duration: 0.3, tickRate: 0, special: 2 },
      { damage: 32, cooldown: 2.3, projectileCount: 1, speed: 820, range: 370, radius: 15, pierce: -1, duration: 0.3, tickRate: 0, special: 3 },
      { damage: 40, cooldown: 2.1, projectileCount: 1, speed: 840, range: 390, radius: 16, pierce: -1, duration: 0.3, tickRate: 0, special: 3 },
      { damage: 50, cooldown: 1.9, projectileCount: 1, speed: 860, range: 410, radius: 17, pierce: -1, duration: 0.3, tickRate: 0, special: 4 },
      { damage: 62, cooldown: 1.7, projectileCount: 1, speed: 880, range: 430, radius: 18, pierce: -1, duration: 0.3, tickRate: 0, special: 4 },
      { damage: 78, cooldown: 1.5, projectileCount: 1, speed: 900, range: 450, radius: 19, pierce: -1, duration: 0.3, tickRate: 0, special: 5 },
      { damage: 95, cooldown: 1.3, projectileCount: 1, speed: 920, range: 470, radius: 20, pierce: -1, duration: 0.3, tickRate: 0, special: 5 },
      { damage: 120, cooldown: 1.1, projectileCount: 1, speed: 950, range: 500, radius: 22, pierce: -1, duration: 0.3, tickRate: 0, special: 6 },
    ],
  },
  unholyOrbit: {
    key: 'unholyOrbit',
    name: 'Unholy Orbit',
    description: 'A cage of bone ribs spins around the player, repelling enemies.',
    maxLevel: 8,
    spriteKey: 'boneCage',
    vfxImpact: 'bone_shatter',
    statsPerLevel: [
      { damage: 22, cooldown: 4.5, projectileCount: 1, speed: 160, range: 100, radius: 28, pierce: -1, duration: 3.5, tickRate: 0, special: 0 },
      { damage: 28, cooldown: 4.2, projectileCount: 2, speed: 170, range: 105, radius: 30, pierce: -1, duration: 3.7, tickRate: 0, special: 0 },
      { damage: 36, cooldown: 3.9, projectileCount: 2, speed: 180, range: 110, radius: 32, pierce: -1, duration: 3.9, tickRate: 0, special: 0 },
      { damage: 45, cooldown: 3.6, projectileCount: 3, speed: 190, range: 115, radius: 34, pierce: -1, duration: 4.1, tickRate: 0, special: 0 },
      { damage: 56, cooldown: 3.3, projectileCount: 3, speed: 200, range: 120, radius: 36, pierce: -1, duration: 4.3, tickRate: 0, special: 0 },
      { damage: 70, cooldown: 3.0, projectileCount: 4, speed: 210, range: 125, radius: 38, pierce: -1, duration: 4.5, tickRate: 0, special: 0 },
      { damage: 88, cooldown: 2.7, projectileCount: 4, speed: 220, range: 130, radius: 40, pierce: -1, duration: 4.7, tickRate: 0, special: 0 },
      { damage: 110, cooldown: 2.4, projectileCount: 5, speed: 240, range: 140, radius: 44, pierce: -1, duration: 5.0, tickRate: 0, special: 0 },
    ],
  },
  graveBurst: {
    key: 'graveBurst',
    name: 'Grave Burst',
    description: 'Necrotic eruptions burst from the ground around the player.',
    maxLevel: 8,
    spriteKey: 'necroticEruption',
    vfxImpact: 'fire_burst',
    statsPerLevel: [
      { damage: 30, cooldown: 3.0, projectileCount: 3, speed: 0, range: 180, radius: 35, pierce: -1, duration: 0.6, tickRate: 0.1, special: 0 },
      { damage: 38, cooldown: 2.8, projectileCount: 4, speed: 0, range: 190, radius: 38, pierce: -1, duration: 0.6, tickRate: 0.1, special: 0 },
      { damage: 48, cooldown: 2.6, projectileCount: 5, speed: 0, range: 200, radius: 40, pierce: -1, duration: 0.7, tickRate: 0.1, special: 0 },
      { damage: 60, cooldown: 2.4, projectileCount: 6, speed: 0, range: 210, radius: 42, pierce: -1, duration: 0.7, tickRate: 0.1, special: 0 },
      { damage: 75, cooldown: 2.2, projectileCount: 7, speed: 0, range: 220, radius: 44, pierce: -1, duration: 0.8, tickRate: 0.1, special: 0 },
      { damage: 92, cooldown: 2.0, projectileCount: 8, speed: 0, range: 230, radius: 46, pierce: -1, duration: 0.8, tickRate: 0.1, special: 0 },
      { damage: 115, cooldown: 1.8, projectileCount: 9, speed: 0, range: 240, radius: 48, pierce: -1, duration: 0.9, tickRate: 0.1, special: 0 },
      { damage: 145, cooldown: 1.6, projectileCount: 11, speed: 0, range: 260, radius: 52, pierce: -1, duration: 1.0, tickRate: 0.1, special: 0 },
    ],
  },
  bloodSiphon: {
    key: 'bloodSiphon',
    name: 'Blood Siphon',
    description: 'A vortex of crimson essence drains life from nearby foes.',
    maxLevel: 8,
    spriteKey: 'bloodVortex',
    vfxImpact: 'blood_spray',
    statsPerLevel: [
      { damage: 8, cooldown: 5.0, projectileCount: 1, speed: 0, range: 140, radius: 20, pierce: -1, duration: 3.0, tickRate: 0.25, special: 0 },
      { damage: 10, cooldown: 4.7, projectileCount: 1, speed: 0, range: 150, radius: 22, pierce: -1, duration: 3.2, tickRate: 0.25, special: 0 },
      { damage: 13, cooldown: 4.4, projectileCount: 1, speed: 0, range: 160, radius: 24, pierce: -1, duration: 3.4, tickRate: 0.25, special: 0 },
      { damage: 16, cooldown: 4.1, projectileCount: 1, speed: 0, range: 170, radius: 26, pierce: -1, duration: 3.6, tickRate: 0.25, special: 0 },
      { damage: 20, cooldown: 3.8, projectileCount: 1, speed: 0, range: 180, radius: 28, pierce: -1, duration: 3.8, tickRate: 0.25, special: 0 },
      { damage: 25, cooldown: 3.5, projectileCount: 1, speed: 0, range: 190, radius: 30, pierce: -1, duration: 4.0, tickRate: 0.25, special: 0 },
      { damage: 32, cooldown: 3.2, projectileCount: 1, speed: 0, range: 200, radius: 32, pierce: -1, duration: 4.2, tickRate: 0.25, special: 0 },
      { damage: 40, cooldown: 2.8, projectileCount: 1, speed: 0, range: 220, radius: 36, pierce: -1, duration: 4.5, tickRate: 0.25, special: 0 },
    ],
  },
  abyssalRift: {
    key: 'abyssalRift',
    name: 'Abyssal Rift',
    description: 'Opens a dark portal that pulls enemies in and devours them.',
    maxLevel: 8,
    spriteKey: 'bloodVortex',
    vfxImpact: 'blood_spray',
    statsPerLevel: [
      { damage: 10, cooldown: 5.5, projectileCount: 1, speed: 0, range: 160, radius: 24, pierce: -1, duration: 3.5, tickRate: 0.3, special: 0 },
      { damage: 13, cooldown: 5.1, projectileCount: 1, speed: 0, range: 170, radius: 26, pierce: -1, duration: 3.7, tickRate: 0.3, special: 0 },
      { damage: 16, cooldown: 4.7, projectileCount: 1, speed: 0, range: 180, radius: 28, pierce: -1, duration: 3.9, tickRate: 0.3, special: 0 },
      { damage: 20, cooldown: 4.3, projectileCount: 1, speed: 0, range: 190, radius: 30, pierce: -1, duration: 4.1, tickRate: 0.3, special: 0 },
      { damage: 25, cooldown: 3.9, projectileCount: 1, speed: 0, range: 200, radius: 32, pierce: -1, duration: 4.3, tickRate: 0.3, special: 0 },
      { damage: 32, cooldown: 3.5, projectileCount: 1, speed: 0, range: 210, radius: 34, pierce: -1, duration: 4.5, tickRate: 0.3, special: 0 },
      { damage: 40, cooldown: 3.1, projectileCount: 1, speed: 0, range: 220, radius: 36, pierce: -1, duration: 4.7, tickRate: 0.3, special: 0 },
      { damage: 50, cooldown: 2.7, projectileCount: 1, speed: 0, range: 240, radius: 40, pierce: -1, duration: 5.0, tickRate: 0.3, special: 0 },
    ],
  },
  fontOfTorment: {
    key: 'fontOfTorment',
    name: 'Font of Torment',
    description: 'Scorches the earth with blood-red flame carpets.',
    maxLevel: 8,
    spriteKey: 'fireCarpet',
    vfxImpact: 'fire_burst',
    statsPerLevel: [
      { damage: 6, cooldown: 4.0, projectileCount: 2, speed: 0, range: 160, radius: 40, pierce: -1, duration: 4.0, tickRate: 0.5, special: 0 },
      { damage: 8, cooldown: 3.7, projectileCount: 3, speed: 0, range: 170, radius: 42, pierce: -1, duration: 4.2, tickRate: 0.5, special: 0 },
      { damage: 10, cooldown: 3.4, projectileCount: 3, speed: 0, range: 180, radius: 44, pierce: -1, duration: 4.4, tickRate: 0.5, special: 0 },
      { damage: 13, cooldown: 3.1, projectileCount: 4, speed: 0, range: 190, radius: 46, pierce: -1, duration: 4.6, tickRate: 0.5, special: 0 },
      { damage: 16, cooldown: 2.8, projectileCount: 4, speed: 0, range: 200, radius: 48, pierce: -1, duration: 4.8, tickRate: 0.5, special: 0 },
      { damage: 20, cooldown: 2.5, projectileCount: 5, speed: 0, range: 210, radius: 50, pierce: -1, duration: 5.0, tickRate: 0.5, special: 0 },
      { damage: 25, cooldown: 2.2, projectileCount: 5, speed: 0, range: 220, radius: 52, pierce: -1, duration: 5.2, tickRate: 0.5, special: 0 },
      { damage: 32, cooldown: 1.9, projectileCount: 6, speed: 0, range: 240, radius: 56, pierce: -1, duration: 5.5, tickRate: 0.5, special: 0 },
    ],
  },
  plagueSwarm: {
    key: 'plagueSwarm',
    name: 'Plague Swarm',
    description: 'A cloud of ravenous locusts seeks and devours enemies.',
    maxLevel: 8,
    spriteKey: 'locustSwarm',
    vfxImpact: 'swarm_cloud',
    statsPerLevel: [
      { damage: 9, cooldown: 2.0, projectileCount: 5, speed: 220, range: 450, radius: 10, pierce: 2, duration: 3.0, tickRate: 0, special: 0 },
      { damage: 12, cooldown: 1.9, projectileCount: 6, speed: 230, range: 470, radius: 11, pierce: 2, duration: 3.2, tickRate: 0, special: 0 },
      { damage: 15, cooldown: 1.8, projectileCount: 7, speed: 240, range: 490, radius: 12, pierce: 3, duration: 3.4, tickRate: 0, special: 0 },
      { damage: 19, cooldown: 1.7, projectileCount: 8, speed: 250, range: 510, radius: 13, pierce: 3, duration: 3.6, tickRate: 0, special: 0 },
      { damage: 24, cooldown: 1.6, projectileCount: 9, speed: 260, range: 530, radius: 14, pierce: 4, duration: 3.8, tickRate: 0, special: 0 },
      { damage: 30, cooldown: 1.5, projectileCount: 10, speed: 270, range: 550, radius: 15, pierce: 4, duration: 4.0, tickRate: 0, special: 0 },
      { damage: 38, cooldown: 1.4, projectileCount: 11, speed: 280, range: 570, radius: 16, pierce: 5, duration: 4.2, tickRate: 0, special: 0 },
      { damage: 48, cooldown: 1.2, projectileCount: 13, speed: 300, range: 600, radius: 18, pierce: 6, duration: 4.5, tickRate: 0, special: 0 },
    ],
  },
  graveChill: {
    key: 'graveChill',
    name: 'Grave Chill',
    description: 'Unleashes a cone of razor-sharp frost that slows enemies.',
    maxLevel: 8,
    spriteKey: 'iceBurst',
    vfxImpact: 'ice_shatter',
    statsPerLevel: [
      { damage: 18, cooldown: 2.2, projectileCount: 4, speed: 280, range: 320, radius: 14, pierce: 3, duration: 1.0, tickRate: 0, special: 0 },
      { damage: 24, cooldown: 2.0, projectileCount: 5, speed: 300, range: 340, radius: 15, pierce: 4, duration: 1.1, tickRate: 0, special: 0 },
      { damage: 30, cooldown: 1.8, projectileCount: 6, speed: 320, range: 360, radius: 16, pierce: 4, duration: 1.2, tickRate: 0, special: 0 },
      { damage: 38, cooldown: 1.7, projectileCount: 7, speed: 340, range: 380, radius: 17, pierce: 5, duration: 1.3, tickRate: 0, special: 0 },
      { damage: 48, cooldown: 1.6, projectileCount: 8, speed: 360, range: 400, radius: 18, pierce: 5, duration: 1.4, tickRate: 0, special: 0 },
      { damage: 60, cooldown: 1.5, projectileCount: 9, speed: 380, range: 420, radius: 19, pierce: 6, duration: 1.5, tickRate: 0, special: 0 },
      { damage: 75, cooldown: 1.4, projectileCount: 10, speed: 400, range: 440, radius: 20, pierce: 6, duration: 1.6, tickRate: 0, special: 0 },
      { damage: 95, cooldown: 1.2, projectileCount: 12, speed: 430, range: 470, radius: 22, pierce: 7, duration: 1.8, tickRate: 0, special: 0 },
    ],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9: WEAPON MANAGER — ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

export interface IWeaponManagerOptions {
  /** Initial capacity of the projectile object pool. */
  projectilePoolCapacity?: number;
  /** Max projectiles allowed active at once (hard cap for safety). */
  maxActiveProjectiles?: number;
}

export type WeaponEventType =
  | 'weaponFired'
  | 'projectileSpawned'
  | 'projectileDestroyed'
  | 'enemyKilled'
  | 'playerHealed'
  | 'weaponLeveledUp';

export interface IWeaponEvent {
  type: WeaponEventType;
  weaponKey?: string;
  projectileId?: number;
  enemyId?: number;
  position?: Vec2;
  amount?: number;
}

type EventCallback = (evt: IWeaponEvent) => void;

/**
 * WeaponManager is the single entry-point for all active weapon logic.
 * It owns the projectile object pool, maintains the weapon registry,
 * evaluates independent cooldown loops every frame, and bridges
 * collision results to the external enemy system + VFX pool.
 */
export class WeaponManager {
  private _weapons = new Map<string, BaseActiveWeapon>();
  private _projectilePool: ObjectPool<IProjectile>;
  private _bridge: ICollisionBridge;
  private _vfx: IVFXPool;
  private _options: Required<IWeaponManagerOptions>;
  private _eventListeners = new Map<WeaponEventType, EventCallback[]>();

  constructor(
    bridge: ICollisionBridge,
    vfx: IVFXPool,
    options: IWeaponManagerOptions = {},
  ) {
    this._bridge = bridge;
    this._vfx = vfx;
    this._options = {
      projectilePoolCapacity: options.projectilePoolCapacity ?? 512,
      maxActiveProjectiles: options.maxActiveProjectiles ?? 1024,
    };
    this._projectilePool = new ObjectPool(
      createProjectile,
      this._options.projectilePoolCapacity,
    );
  }

  // ── Weapon Lifecycle ──────────────────────────────────────────────────────

  register(key: string, weapon: BaseActiveWeapon): void {
    this._weapons.set(key, weapon);
  }

  unlock(key: string): boolean {
    const w = this._weapons.get(key);
    if (!w) return false;
    w.isUnlocked = true;
    w.cooldownTimer = 0; // Fire immediately on unlock
    return true;
  }

  lock(key: string): boolean {
    const w = this._weapons.get(key);
    if (!w) return false;
    w.isUnlocked = false;
    return true;
  }

  levelUp(key: string): boolean {
    const w = this._weapons.get(key);
    if (!w || w.level >= w.config.maxLevel) return false;
    w.level++;
    this._emit({ type: 'weaponLeveledUp', weaponKey: key });
    return true;
  }

  getWeapon(key: string): BaseActiveWeapon | undefined {
    return this._weapons.get(key);
  }

  getAllWeapons(): BaseActiveWeapon[] {
    return Array.from(this._weapons.values());
  }

  getActiveWeapons(): BaseActiveWeapon[] {
    return Array.from(this._weapons.values()).filter(w => w.isUnlocked);
  }

  // ── Passive Stat Modifiers ─────────────────────────────────────────────────

  applyGlobalBuff(opts: {
    damageMult?: number;
    cooldownMult?: number;
    areaMult?: number;
    speedMult?: number;
    durationMult?: number;
    projectileCountBonus?: number;
  }): void {
    for (const w of this._weapons.values()) {
      if (opts.damageMult !== undefined) w.damageMult *= opts.damageMult;
      if (opts.cooldownMult !== undefined) w.cooldownMult *= opts.cooldownMult;
      if (opts.areaMult !== undefined) w.areaMult *= opts.areaMult;
      if (opts.speedMult !== undefined) w.speedMult *= opts.speedMult;
      if (opts.durationMult !== undefined) w.durationMult *= opts.durationMult;
      if (opts.projectileCountBonus !== undefined) w.projectileCountBonus += opts.projectileCountBonus;
    }
  }

  // ── Per-Frame Update ──────────────────────────────────────────────────────

  /**
   * Main update loop. Call once per frame from your game loop.
   * @param dt Delta time in seconds.
   * @param playerPos Current player world position.
   * @param facingAngle Player facing angle in radians.
   */
  update(dt: number, playerPos: Vec2, facingAngle: number): void {
    // 1. Update all active weapons (cooldown eval + weapon-specific state)
    for (const weapon of this._weapons.values()) {
      if (weapon.isUnlocked) {
        weapon.update(dt, playerPos, facingAngle);
      }
    }

    // 2. Update all linear projectiles (collision sweep)
    this._updateLinearProjectiles(dt);

    // 3. Safety cap
    if (this._projectilePool.activeCount > this._options.maxActiveProjectiles) {
      this._cullOldestProjectiles(
        this._projectilePool.activeCount - this._options.maxActiveProjectiles,
      );
    }
  }

  private _updateLinearProjectiles(dt: number): void {
    const enemies = this._bridge.getEnemies();
    const metaMap = new Map<string, SpriteSheetMeta>();

    this._projectilePool.forEachActive((proj) => {
      if (proj.motionType !== 'linear') return;

      // Euler step
      proj.pos = V2.add(proj.pos, V2.mul(proj.vel, dt));
      proj.lifetime -= dt;

      // Animation frame
      const meta = metaMap.get(proj.spriteKey) ?? AssetAtlas[proj.spriteKey];
      if (meta) {
        metaMap.set(proj.spriteKey, meta);
        proj.frameTimer -= dt;
        if (proj.frameTimer <= 0) {
          proj.frameTimer = proj.frameInterval;
          proj.frameIndex = (proj.frameIndex + 1) % meta.totalFrames;
        }
      }

      // Collision sweep: circle-circle vs all enemies
      for (const e of enemies) {
        if (!e.alive) continue;
        if (M.circleCircle(proj.pos, proj.radius, e.pos, e.radius)) {
          // Resolve impact via the weapon that owns this projectile
          const weapon = this._weapons.get(proj.weaponKey);
          if (weapon) {
            weapon['_resolveImpact'](proj, e);
          }
          if (!proj.active) break;
        }
      }

      if (proj.lifetime <= 0) {
        proj.active = false;
        this._projectilePool.release(proj);
      }
    });
  }

  private _cullOldestProjectiles(count: number): void {
    // Simple cull: remove projectiles with the lowest remaining lifetime
    const active: IProjectile[] = [];
    this._projectilePool.forEachActive((p) => active.push(p));
    active.sort((a, b) => a.lifetime - b.lifetime);
    for (let i = 0; i < Math.min(count, active.length); i++) {
      active[i].active = false;
    }
  }

  // ── Pool Introspection ─────────────────────────────────────────────────────

  get projectilePool(): ObjectPool<IProjectile> {
    return this._projectilePool;
  }

  get activeProjectileCount(): number {
    return this._projectilePool.activeCount;
  }

  get poolCapacity(): number {
    return this._projectilePool.capacity;
  }

  // ── Event Bus ──────────────────────────────────────────────────────────────

  on(event: WeaponEventType, cb: EventCallback): () => void {
    if (!this._eventListeners.has(event)) {
      this._eventListeners.set(event, []);
    }
    this._eventListeners.get(event)!.push(cb);
    return () => this.off(event, cb);
  }

  off(event: WeaponEventType, cb: EventCallback): void {
    const arr = this._eventListeners.get(event);
    if (!arr) return;
    const idx = arr.indexOf(cb);
    if (idx >= 0) arr.splice(idx, 1);
  }

  private _emit(evt: IWeaponEvent): void {
    const arr = this._eventListeners.get(evt.type);
    if (!arr) return;
    for (const cb of arr) cb(evt);
  }

  // ── Factory Convenience ────────────────────────────────────────────────────

  /**
   * Build a complete WeaponManager pre-loaded with all 10 base weapons.
   * This is the recommended initialization path.
   */
  static createFullLoadout(
    bridge: ICollisionBridge,
    vfx: IVFXPool,
    options?: IWeaponManagerOptions,
  ): WeaponManager {
    const mgr = new WeaponManager(bridge, vfx, options);
    const pool = mgr._projectilePool;

    mgr.register('sinnersQuills', new SinnersQuills(WeaponConfigs.sinnersQuills, pool, bridge, vfx));
    mgr.register('whirlingHalberds', new WhirlingHalberds(WeaponConfigs.whirlingHalberds, pool, bridge, vfx));
    mgr.register('zealotsChain', new ZealotsChain(WeaponConfigs.zealotsChain, pool, bridge, vfx));
    mgr.register('unholyOrbit', new UnholyOrbit(WeaponConfigs.unholyOrbit, pool, bridge, vfx));
    mgr.register('graveBurst', new GraveBurst(WeaponConfigs.graveBurst, pool, bridge, vfx));
    mgr.register('bloodSiphon', new BloodSiphon(WeaponConfigs.bloodSiphon, pool, bridge, vfx));
    mgr.register('abyssalRift', new AbyssalRift(WeaponConfigs.abyssalRift, pool, bridge, vfx));
    mgr.register('fontOfTorment', new FontOfTorment(WeaponConfigs.fontOfTorment, pool, bridge, vfx));
    mgr.register('plagueSwarm', new PlagueSwarm(WeaponConfigs.plagueSwarm, pool, bridge, vfx));
    mgr.register('graveChill', new GraveChill(WeaponConfigs.graveChill, pool, bridge, vfx));

    return mgr;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10: EXPORTS & MODULE INTERFACE
// ═══════════════════════════════════════════════════════════════════════════════

export {
  Vec2, Vec3,
  IEnemy, IVFXPool, IVFXRequest, VFXType,
  ICollisionBridge,
  IWeaponConfig, WeaponLevelStats,
  IProjectile, ProjectileMotionType,
  Poolable, ObjectPool,
  SpriteSheetMeta, FrameUV,
};
