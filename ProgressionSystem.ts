/**
 * ProgressionSystem.ts
 * ---------------------------------------------------------------------------
 * Data-driven player upgrade, passive modifier, and weapon-evolution system.
 * 
 * Responsibilities:
 *   - Track up to 5 weapon ranks and 5 passive item ranks.
 *   - Compute live StatModifiers from passive ranks.
 *   - Detect Rank-5 + Rank-5 recipes and execute ultimate mutations.
 *   - Expose Ultimate Evolution behavior configs for the weapon engine.
 * 
 * Dependencies: None (pure logic module).
 * ---------------------------------------------------------------------------
 */

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

/** Live stat snapshot consumed by PlayerController and WeaponEngine. */
export interface StatModifiers {
  // Additive bonuses
  maxHealthBonus: number;
  healthRegenBonus: number;
  movementSpeedBonus: number;
  magnetRadiusBonus: number;
  armorBonus: number;
  luckBonus: number;

  // Multiplicative coefficients (1.0 = baseline)
  damageMultiplier: number;
  areaMultiplier: number;
  durationMultiplier: number;
  cooldownReduction: number; // 0.0 – 0.80 hard cap
  critChance: number;
  critDamageMultiplier: number;
  lifeSteal: number; // fraction of damage dealt returned as HP
}

/** Context passed into evolution behavior hooks each frame or event. */
export interface EvolutionContext {
  playerPosition: { x: number; y: number; z: number };
  playerForward: { x: number; y: number; z: number };
  playerStats: Readonly<StatModifiers>;
  elapsedTime: number;
  deltaTime: number;
  rank: number; // evolution rank (inherited from base weapon rank at mutation time)
}

/** Generic enemy stub; replace with your engine's entity type. */
export interface EnemyStub {
  id: string;
  position: { x: number; y: number; z: number };
  health: number;
  maxHealth: number;
  statusEffects: Set<string>;
  takeDamage(amount: number, source: string): void;
  applyStatus(effectId: string, duration: number): void;
}

/** Projectile / effect instance spawned by an evolution. */
export interface EvolutionInstance {
  evolutionId: string;
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  spawnTime: number;
  lifetime: number;
  instances: number; // projectile count, skeleton count, etc.
}

/** Defines how an ultimate evolution behaves in the weapon engine. */
export interface EvolutionBehavior {
  id: string;
  name: string;
  description: string;
  baseWeaponId: string;
  requiredPassiveId: string;

  // Base scalars (rank 1). The weapon engine multiplies these by player stats.
  baseDamage: number;
  baseCooldown: number; // seconds
  baseArea: number; // radius or width
  baseDuration: number; // seconds
  baseProjectileCount: number;
  baseTickRate: number; // for DOT / aura effects

  // Flags
  piercing: boolean;
  homing: boolean;
  canCrit: boolean;

  // ----- Event Hooks (called by WeaponEngine) -----
  
  /** Called when the evolution's projectile/zone first hits a target. */
  onHit?: (
    target: EnemyStub,
    baseDamage: number,
    ctx: EvolutionContext
  ) => { finalDamage: number; effectsToApply: string[] };

  /** Called when the evolution kills a target. */
  onKill?: (target: EnemyStub, ctx: EvolutionContext) => void;

  /** Called every tick for persistent / aura evolutions. */
  onTick?: (activeInstances: EvolutionInstance[], ctx: EvolutionContext) => void;

  /** Called once when the evolution is activated (fire button / auto-fire). */
  onActivate?: (
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
    ctx: EvolutionContext
  ) => EvolutionInstance;

  /** Called when an instance expires or is destroyed. */
  onDestroy?: (instance: EvolutionInstance, ctx: EvolutionContext) => void;
}

/** Passive item definition with its rank-scaling hook. */
export interface PassiveItemConfig {
  id: string;
  name: string;
  description: string;
  maxRank: number;
  /** Mutates a StatModifiers object in-place based on the current rank. */
  applyRank(stats: StatModifiers, rank: number): void;
}

/** Base weapon definition before evolution. */
export interface BaseWeaponConfig {
  id: string;
  name: string;
  evolutionId: string;
  requiredPassiveId: string;
}

// ============================================================================
// STAT MODIFIER HELPERS
// ============================================================================

function createZeroStats(): StatModifiers {
  return {
    maxHealthBonus: 0,
    healthRegenBonus: 0,
    movementSpeedBonus: 0,
    magnetRadiusBonus: 0,
    armorBonus: 0,
    luckBonus: 0,
    damageMultiplier: 1.0,
    areaMultiplier: 1.0,
    durationMultiplier: 1.0,
    cooldownReduction: 0.0,
    critChance: 0.0,
    critDamageMultiplier: 1.5,
    lifeSteal: 0.0,
  };
}

// ============================================================================
// PASSIVE ITEM REGISTRY
// ============================================================================

export const PASSIVE_REGISTRY: ReadonlyMap<string, PassiveItemConfig> = new Map([
  [
    "p_blood_onyx",
    {
      id: "p_blood_onyx",
      name: "Blood Onyx",
      description: "Recover a fraction of damage dealt as health.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.lifeSteal += rank * 0.025; // +2.5% per rank
      },
    },
  ],
  [
    "p_vampiric_crest",
    {
      id: "p_vampiric_crest",
      name: "Vampiric Crest",
      description: "Increases maximum health and health regeneration.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.maxHealthBonus += rank * 15;
        stats.healthRegenBonus += rank * 0.8;
      },
    },
  ],
  [
    "p_swiftness_shard",
    {
      id: "p_swiftness_shard",
      name: "Swiftness Shard",
      description: "Increases movement speed.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.movementSpeedBonus += rank * 0.08; // +8% per rank
      },
    },
  ],
  [
    "p_catacomb_magnet",
    {
      id: "p_catacomb_magnet",
      name: "Catacomb Magnet",
      description: "Expands pickup radius for experience and items.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.magnetRadiusBonus += rank * 0.20; // +20% per rank
      },
    },
  ],
  [
    "p_gothic_plate",
    {
      id: "p_gothic_plate",
      name: "Gothic Plate",
      description: "Hardened armor that reduces incoming damage.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.armorBonus += rank * 4;
      },
    },
  ],
  [
    "p_spellbinders_ring",
    {
      id: "p_spellbinders_ring",
      name: "Spellbinder's Ring",
      description: "Reduces cooldowns between attacks.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.cooldownReduction += rank * 0.05; // +5% per rank
      },
    },
  ],
  [
    "p_cursed_hourglass",
    {
      id: "p_cursed_hourglass",
      name: "Cursed Hourglass",
      description: "Extends the duration of all weapon effects.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.durationMultiplier += rank * 0.10; // +10% per rank
      },
    },
  ],
  [
    "p_amplifying_lens",
    {
      id: "p_amplifying_lens",
      name: "Amplifying Lens",
      description: "Expands the area of effect of all attacks.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.areaMultiplier += rank * 0.12; // +12% per rank
      },
    },
  ],
  [
    "p_flayers_edge",
    {
      id: "p_flayers_edge",
      name: "Flayer's Edge",
      description: "Increases damage and critical strike severity.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.damageMultiplier += rank * 0.10; // +10% per rank
        stats.critDamageMultiplier += rank * 0.15;
      },
    },
  ],
  [
    "p_demons_luck",
    {
      id: "p_demons_luck",
      name: "Demon's Luck",
      description: "Improves critical chance and fortune.",
      maxRank: 5,
      applyRank(stats, rank) {
        stats.critChance += rank * 0.03; // +3% per rank
        stats.luckBonus += rank * 3;
      },
    },
  ],
]);

// ============================================================================
// BASE WEAPON REGISTRY
// ============================================================================

export const WEAPON_REGISTRY: ReadonlyMap<string, BaseWeaponConfig> = new Map([
  {
    id: "w_spectral_dagger",
    name: "Spectral Dagger",
    evolutionId: "evo_phantom_barrage",
    requiredPassiveId: "p_swiftness_shard",
  },
  {
    id: "w_tower_shield",
    name: "Tower Shield",
    evolutionId: "evo_iron_fortress",
    requiredPassiveId: "p_gothic_plate",
  },
  {
    id: "w_divine_scepter",
    name: "Divine Scepter",
    evolutionId: "evo_heavens_wrath",
    requiredPassiveId: "p_spellbinders_ring",
  },
  {
    id: "w_necrotic_staff",
    name: "Necrotic Staff",
    evolutionId: "evo_skeletal_cataclysm",
    requiredPassiveId: "p_catacomb_magnet",
  },
  {
    id: "w_blood_orb",
    name: "Blood Orb",
    evolutionId: "evo_corpse_nova",
    requiredPassiveId: "p_vampiric_crest",
  },
  {
    id: "w_crimson_whip",
    name: "Crimson Whip",
    evolutionId: "evo_sanguine_vortex",
    requiredPassiveId: "p_blood_onyx",
  },
  {
    id: "w_void_core",
    name: "Void Core",
    evolutionId: "evo_doomsday_singularity",
    requiredPassiveId: "p_amplifying_lens",
  },
  {
    id: "w_death_scythe",
    name: "Death Scythe",
    evolutionId: "evo_desecrated_wake",
    requiredPassiveId: "p_cursed_hourglass",
  },
  {
    id: "w_plague_flask",
    name: "Plague Flask",
    evolutionId: "evo_pandemic_infestation",
    requiredPassiveId: "p_demons_luck",
  },
  {
    id: "w_frost_rune",
    name: "Frost Rune",
    evolutionId: "evo_absolute_zero",
    requiredPassiveId: "p_flayers_edge",
  },
].map((w) => [w.id, w]));

// ============================================================================
// ULTIMATE EVOLUTION REGISTRY
// ============================================================================

export const EVOLUTION_REGISTRY: ReadonlyMap<string, EvolutionBehavior> = new Map([
  // --------------------------------------------------------------------------
  // 1. PHANTOM BARRAGE
  // --------------------------------------------------------------------------
  [
    "evo_phantom_barrage",
    {
      id: "evo_phantom_barrage",
      name: "Phantom Barrage",
      description:
        "Unleashes a torrent of piercing spectral blades. Each blade passes through enemies and leaves a lingering soul-bleed.",
      baseWeaponId: "w_spectral_dagger",
      requiredPassiveId: "p_swiftness_shard",

      baseDamage: 18,
      baseCooldown: 2.5,
      baseArea: 0.6,
      baseDuration: 1.2,
      baseProjectileCount: 6,
      baseTickRate: 0.0,

      piercing: true,
      homing: false,
      canCrit: true,

      onActivate(origin, direction, ctx) {
        const count = Math.floor(this.baseProjectileCount * ctx.playerStats.areaMultiplier);
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { ...direction },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: count,
        };
      },

      onHit(target, baseDamage, ctx) {
        const dmg = baseDamage * ctx.playerStats.damageMultiplier;
        // Soul-bleed status
        target.applyStatus("soul_bleed", 3.0 * ctx.playerStats.durationMultiplier);
        return { finalDamage: dmg, effectsToApply: ["soul_bleed"] };
      },

      onKill(target, ctx) {
        // Phantom blades chain: on kill, a secondary blade spawns at corpse
        // WeaponEngine listens for this flag and spawns a delayed mini-instance
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 2. IRON FORTRESS
  // --------------------------------------------------------------------------
  [
    "evo_iron_fortress",
    {
      id: "evo_iron_fortress",
      name: "Iron Fortress",
      description:
        "Erects an orbiting ring of cursed shields that block projectiles and reflect damage back to attackers.",
      baseWeaponId: "w_tower_shield",
      requiredPassiveId: "p_gothic_plate",

      baseDamage: 35,
      baseCooldown: 8.0,
      baseArea: 3.5,
      baseDuration: 6.0,
      baseProjectileCount: 4,
      baseTickRate: 0.5,

      piercing: false,
      homing: false,
      canCrit: false,

      onActivate(origin, _direction, ctx) {
        const shields = Math.floor(this.baseProjectileCount + ctx.rank);
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { x: 0, y: 0, z: 0 },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: shields,
        };
      },

      onTick(activeInstances, ctx) {
        // Every tick, shields orbit and damage enemies inside the ring
        const tickDmg = this.baseDamage * ctx.playerStats.damageMultiplier * ctx.deltaTime;
        for (const inst of activeInstances) {
          if (inst.evolutionId !== this.id) continue;
          // WeaponEngine uses inst.instances to render orbiting shields
          // and applies tickDmg to enemies within baseArea * areaMultiplier
        }
      },

      onHit(target, baseDamage, ctx) {
        // Reflective thorns: portion of damage reflected
        const thornDmg = baseDamage * ctx.playerStats.damageMultiplier * 0.5;
        return { finalDamage: thornDmg, effectsToApply: ["staggered"] };
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 3. HEAVEN'S WRATH
  // --------------------------------------------------------------------------
  [
    "evo_heavens_wrath",
    {
      id: "evo_heavens_wrath",
      name: "Heaven's Wrath",
      description:
        "Calls down searing beams of light from the abyssal sky. Beams consecrate the ground, burning heretics over time.",
      baseWeaponId: "w_divine_scepter",
      requiredPassiveId: "p_spellbinders_ring",

      baseDamage: 45,
      baseCooldown: 5.0,
      baseArea: 2.0,
      baseDuration: 3.5,
      baseProjectileCount: 3,
      baseTickRate: 0.25,

      piercing: true,
      homing: true,
      canCrit: true,

      onActivate(origin, direction, ctx) {
        const beams = Math.floor(this.baseProjectileCount + Math.floor(ctx.rank / 2));
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { ...direction },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: beams,
        };
      },

      onHit(target, baseDamage, ctx) {
        const dmg = baseDamage * ctx.playerStats.damageMultiplier;
        target.applyStatus("consecrated_burn", 2.0 * ctx.playerStats.durationMultiplier);
        return { finalDamage: dmg, effectsToApply: ["consecrated_burn"] };
      },

      onTick(activeInstances, ctx) {
        // Consecrated ground DOT
        const dot = (this.baseDamage * 0.3) * ctx.playerStats.damageMultiplier * ctx.deltaTime;
        for (const inst of activeInstances) {
          if (inst.evolutionId !== this.id) continue;
          // Engine applies `dot` to all enemies standing in beam zones
        }
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 4. SKELETAL CATACLYSM
  // --------------------------------------------------------------------------
  [
    "evo_skeletal_cataclysm",
    {
      id: "evo_skeletal_cataclysm",
      name: "Skeletal Cataclysm",
      description:
        "Summons a legion of skeletal warriors. When a skeleton dies or expires, its bones detonate in a cross-shaped fracture.",
      baseWeaponId: "w_necrotic_staff",
      requiredPassiveId: "p_catacomb_magnet",

      baseDamage: 22,
      baseCooldown: 7.0,
      baseArea: 1.5,
      baseDuration: 8.0,
      baseProjectileCount: 5,
      baseTickRate: 1.0,

      piercing: false,
      homing: false,
      canCrit: false,

      onActivate(origin, _direction, ctx) {
        const skels = Math.floor(this.baseProjectileCount + ctx.rank);
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { x: 0, y: 0, z: 0 },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: skels,
        };
      },

      onDestroy(instance, ctx) {
        // Bone detonation on expiration
        const explosionDmg = this.baseDamage * 2.5 * ctx.playerStats.damageMultiplier;
        const radius = this.baseArea * 2.0 * ctx.playerStats.areaMultiplier;
        // Engine spawns cross-shaped AoE at instance.origin with explosionDmg and radius
      },

      onTick(activeInstances, ctx) {
        // Skeletons auto-attack nearby enemies once per second
        const atkDmg = this.baseDamage * ctx.playerStats.damageMultiplier;
        for (const inst of activeInstances) {
          if (inst.evolutionId !== this.id) continue;
          // Engine finds nearest enemy to each skeleton and applies atkDmg
        }
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 5. CORPSE NOVA
  // --------------------------------------------------------------------------
  [
    "evo_corpse_nova",
    {
      id: "evo_corpse_nova",
      name: "Corpse Nova",
      description:
        "Detonates slain enemies. Each corpse explosion has a chance to chain into adjacent corpses, creating cascading devastation.",
      baseWeaponId: "w_blood_orb",
      requiredPassiveId: "p_vampiric_crest",

      baseDamage: 60,
      baseCooldown: 6.0,
      baseArea: 2.5,
      baseDuration: 0.5,
      baseProjectileCount: 1,
      baseTickRate: 0.0,

      piercing: false,
      homing: false,
      canCrit: true,

      onActivate(origin, direction, ctx) {
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { ...direction },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration,
          instances: 1,
        };
      },

      onKill(target, ctx) {
        // Primary corpse explosion
        const blastDmg = this.baseDamage * ctx.playerStats.damageMultiplier;
        const radius = this.baseArea * ctx.playerStats.areaMultiplier;
        // Chain chance scales with luck
        const chainChance = 0.35 + (ctx.playerStats.luckBonus * 0.02);
        // Engine handles the AoE and chain roll
      },

      onHit(target, baseDamage, ctx) {
        // Direct hits from the initial blood orb apply hemorrhage
        const dmg = baseDamage * ctx.playerStats.damageMultiplier;
        target.applyStatus("hemorrhage", 4.0 * ctx.playerStats.durationMultiplier);
        return { finalDamage: dmg, effectsToApply: ["hemorrhage"] };
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 6. SANGUINE VORTEX
  // --------------------------------------------------------------------------
  [
    "evo_sanguine_vortex",
    {
      id: "evo_sanguine_vortex",
      name: "Sanguine Vortex",
      description:
        "Conjures a tornado of cursed blood that pulls enemies toward its center, shredding them and healing the caster.",
      baseWeaponId: "w_crimson_whip",
      requiredPassiveId: "p_blood_onyx",

      baseDamage: 12,
      baseCooldown: 9.0,
      baseArea: 4.0,
      baseDuration: 5.0,
      baseProjectileCount: 1,
      baseTickRate: 0.2,

      piercing: true,
      homing: false,
      canCrit: false,

      onActivate(origin, _direction, ctx) {
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { x: 0, y: 0, z: 0 },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: 1,
        };
      },

      onTick(activeInstances, ctx) {
        const tickDmg = this.baseDamage * ctx.playerStats.damageMultiplier;
        const pullRadius = this.baseArea * ctx.playerStats.areaMultiplier;
        for (const inst of activeInstances) {
          if (inst.evolutionId !== this.id) continue;
          // Engine pulls enemies toward inst.origin within pullRadius
          // and applies tickDmg every 0.2s
          // Life-steal is handled globally by PlayerController using stats.lifeSteal
        }
      },

      onHit(target, baseDamage, ctx) {
        // Each tick hit applies stacking bleed
        target.applyStatus("deep_wound", 5.0);
        return { finalDamage: baseDamage * ctx.playerStats.damageMultiplier, effectsToApply: ["deep_wound"] };
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 7. DOOMSDAY SINGULARITY
  // --------------------------------------------------------------------------
  [
    "evo_doomsday_singularity",
    {
      id: "evo_doomsday_singularity",
      name: "Doomsday Singularity",
      description:
        "Collapses reality into a void sphere that drags all nearby matter into annihilation. Grows larger over its lifetime.",
      baseWeaponId: "w_void_core",
      requiredPassiveId: "p_amplifying_lens",

      baseDamage: 80,
      baseCooldown: 12.0,
      baseArea: 3.0,
      baseDuration: 4.0,
      baseProjectileCount: 1,
      baseTickRate: 0.1,

      piercing: true,
      homing: false,
      canCrit: true,

      onActivate(origin, direction, ctx) {
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { ...direction },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: 1,
        };
      },

      onTick(activeInstances, ctx) {
        for (const inst of activeInstances) {
          if (inst.evolutionId !== this.id) continue;
          const elapsed = ctx.elapsedTime - inst.spawnTime;
          const growth = 1.0 + (elapsed / inst.lifetime) * 2.0; // Grows 3x
          const currentRadius = this.baseArea * growth * ctx.playerStats.areaMultiplier;
          const tickDmg = (this.baseDamage * 0.25) * ctx.playerStats.damageMultiplier * ctx.deltaTime;
          // Engine applies gravity pull + tickDmg to all enemies in currentRadius
        }
      },

      onDestroy(instance, ctx) {
        // Implosion finale
        const implosionDmg = this.baseDamage * 4.0 * ctx.playerStats.damageMultiplier;
        const finalRadius = this.baseArea * 3.0 * ctx.playerStats.areaMultiplier;
        // Engine spawns delayed massive hit at instance.origin
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 8. DESECRATED WAKE
  // --------------------------------------------------------------------------
  [
    "evo_desecrated_wake",
    {
      id: "evo_desecrated_wake",
      name: "Desecrated Wake",
      description:
        "Leaves a trail of unholy ground behind the player. The trail persists, corrupting and slowing all who tread upon it.",
      baseWeaponId: "w_death_scythe",
      requiredPassiveId: "p_cursed_hourglass",

      baseDamage: 15,
      baseCooldown: 0.5,
      baseArea: 1.2,
      baseDuration: 6.0,
      baseProjectileCount: 1,
      baseTickRate: 0.5,

      piercing: true,
      homing: false,
      canCrit: false,

      onActivate(origin, _direction, ctx) {
        // Spawns a "patch" at current location rather than a projectile
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { x: 0, y: 0, z: 0 },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: 1,
        };
      },

      onTick(activeInstances, ctx) {
        const tickDmg = this.baseDamage * ctx.playerStats.damageMultiplier * ctx.deltaTime;
        for (const inst of activeInstances) {
          if (inst.evolutionId !== this.id) continue;
          // Engine checks enemies inside inst.origin radius = baseArea * areaMultiplier
          // applies tickDmg + slow status
        }
      },

      onHit(target, baseDamage, ctx) {
        target.applyStatus("desecrated_slow", 1.0);
        return { finalDamage: baseDamage * ctx.playerStats.damageMultiplier, effectsToApply: ["desecrated_slow"] };
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 9. PANDEMIC INFESTATION
  // --------------------------------------------------------------------------
  [
    "evo_pandemic_infestation",
    {
      id: "evo_pandemic_infestation",
      name: "Pandemic Infestation",
      description:
        "Infects targets with a virulent plague that jumps to nearby enemies on death. Each jump increases the plague's damage.",
      baseWeaponId: "w_plague_flask",
      requiredPassiveId: "p_demons_luck",

      baseDamage: 25,
      baseCooldown: 4.0,
      baseArea: 2.0,
      baseDuration: 5.0,
      baseProjectileCount: 3,
      baseTickRate: 1.0,

      piercing: false,
      homing: true,
      canCrit: true,

      onActivate(origin, direction, ctx) {
        const flasks = Math.floor(this.baseProjectileCount + Math.floor(ctx.rank / 2));
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { ...direction },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: flasks,
        };
      },

      onHit(target, baseDamage, ctx) {
        const dmg = baseDamage * ctx.playerStats.damageMultiplier;
        target.applyStatus("plague", 5.0 * ctx.playerStats.durationMultiplier);
        return { finalDamage: dmg, effectsToApply: ["plague"] };
      },

      onKill(target, ctx) {
        // Plague jump: find nearest uninfected enemy within jump radius
        const jumpRadius = this.baseArea * 1.5 * ctx.playerStats.areaMultiplier;
        const jumpDmg = this.baseDamage * ctx.playerStats.damageMultiplier * 1.25;
        // Engine searches for nearest enemy within jumpRadius and applies plague + jumpDmg
        // Luck increases chain cap
      },

      onTick(activeInstances, ctx) {
        // DOT tick for infected enemies is handled by status system,
        // but we amplify it here based on active instances
        const dotAmp = 1.0 + (activeInstances.filter(i => i.evolutionId === this.id).length * 0.1);
        // Engine multiplies plague DOT by dotAmp
      },
    } as EvolutionBehavior,
  ],

  // --------------------------------------------------------------------------
  // 10. ABSOLUTE ZERO
  // --------------------------------------------------------------------------
  [
    "evo_absolute_zero",
    {
      id: "evo_absolute_zero",
      name: "Absolute Zero",
      description:
        "Flash-freezes an area. Frozen enemies take critical damage; killing a frozen enemy causes a shatter explosion.",
      baseWeaponId: "w_frost_rune",
      requiredPassiveId: "p_flayers_edge",

      baseDamage: 40,
      baseCooldown: 7.0,
      baseArea: 3.5,
      baseDuration: 4.0,
      baseProjectileCount: 1,
      baseTickRate: 0.0,

      piercing: true,
      homing: false,
      canCrit: true,

      onActivate(origin, direction, ctx) {
        return {
          evolutionId: this.id,
          origin: { ...origin },
          direction: { ...direction },
          spawnTime: ctx.elapsedTime,
          lifetime: this.baseDuration * ctx.playerStats.durationMultiplier,
          instances: 1,
        };
      },

      onHit(target, baseDamage, ctx) {
        const isFrozen = target.statusEffects.has("frozen");
        let dmg = baseDamage * ctx.playerStats.damageMultiplier;
        if (isFrozen) {
          // Shatter bonus: crit damage applies automatically
          dmg *= ctx.playerStats.critDamageMultiplier;
        } else {
          target.applyStatus("frozen", 3.0 * ctx.playerStats.durationMultiplier);
        }
        return { finalDamage: dmg, effectsToApply: isFrozen ? ["shattered"] : ["frozen"] };
      },

      onKill(target, ctx) {
        // Shatter explosion
        const shatterDmg = this.baseDamage * 1.5 * ctx.playerStats.damageMultiplier;
        const radius = this.baseArea * 0.6 * ctx.playerStats.areaMultiplier;
        // Engine spawns ice-shatter AoE at target.position
        // Enemies hit by shatter are slowed
      },
    } as EvolutionBehavior,
  ],
]);

// ============================================================================
// INVENTORY MANAGER
// ============================================================================

export type InventoryChangeType = "weapon_added" | "weapon_upgraded" | "weapon_removed" | "passive_added" | "passive_upgraded" | "passive_removed" | "evolution_unlocked";

export interface InventoryChangeEvent {
  type: InventoryChangeType;
  itemId: string;
  newRank: number;
  evolvedFrom?: string;
  evolvedInto?: string;
}

export class InventoryManager {
  private readonly MAX_WEAPON_SLOTS = 5;
  private readonly MAX_PASSIVE_SLOTS = 5;
  private readonly MAX_RANK = 5;

  // Active loadout: itemId -> currentRank
  private weapons = new Map<string, number>();
  private passives = new Map<string, number>();

  // Unlocked ultimate evolutions (permanent for the run)
  private unlockedEvolutions = new Set<string>();

  // Cached live stats
  private liveStats: StatModifiers = createZeroStats();

  // Subscribers
  private statListeners: Array<(stats: StatModifiers) => void> = [];
  private changeListeners: Array<(evt: InventoryChangeEvent) => void> = [];

  // --------------------------------------------------------------------------
  // PUBLIC API: QUERY
  // --------------------------------------------------------------------------

  /** Returns a read-only map of equipped weapons and their ranks. */
  getWeapons(): ReadonlyMap<string, number> {
    return this.weapons;
  }

  /** Returns a read-only map of equipped passives and their ranks. */
  getPassives(): ReadonlyMap<string, number> {
    return this.passives;
  }

  /** Returns true if the given ultimate evolution has been unlocked. */
  hasEvolution(evolutionId: string): boolean {
    return this.unlockedEvolutions.has(evolutionId);
  }

  /** Returns the set of unlocked evolution IDs. */
  getUnlockedEvolutions(): ReadonlySet<string> {
    return this.unlockedEvolutions;
  }

  /** Returns the current computed stat modifiers. */
  getStats(): Readonly<StatModifiers> {
    return this.liveStats;
  }

  getWeaponRank(weaponId: string): number {
    return this.weapons.get(weaponId) ?? 0;
  }

  getPassiveRank(passiveId: string): number {
    return this.passives.get(passiveId) ?? 0;
  }

  // --------------------------------------------------------------------------
  // PUBLIC API: MUTATION
  // --------------------------------------------------------------------------

  /**
   * Adds a new weapon at Rank 1, or upgrades an existing weapon by one rank.
   * Triggers stat recompute and recipe check.
   */
  addOrUpgradeWeapon(weaponId: string): boolean {
    const weapon = WEAPON_REGISTRY.get(weaponId);
    if (!weapon) {
      console.warn(`[ProgressionSystem] Unknown weapon: ${weaponId}`);
      return false;
    }

    const currentRank = this.weapons.get(weaponId) ?? 0;

    if (currentRank === 0) {
      if (this.weapons.size >= this.MAX_WEAPON_SLOTS) {
        console.warn(`[ProgressionSystem] Weapon slots full. Cannot add ${weaponId}.`);
        return false;
      }
      this.weapons.set(weaponId, 1);
      this._emitChange({ type: "weapon_added", itemId: weaponId, newRank: 1 });
    } else if (currentRank < this.MAX_RANK) {
      this.weapons.set(weaponId, currentRank + 1);
      this._emitChange({ type: "weapon_upgraded", itemId: weaponId, newRank: currentRank + 1 });
    } else {
      console.warn(`[ProgressionSystem] ${weaponId} already at max rank.`);
      return false;
    }

    this._recomputeStats();
    this._checkRecipes();
    return true;
  }

  /**
   * Adds a new passive at Rank 1, or upgrades an existing passive by one rank.
   * Instantly scales the respective coefficient via _recomputeStats().
   */
  addOrUpgradePassive(passiveId: string): boolean {
    const passive = PASSIVE_REGISTRY.get(passiveId);
    if (!passive) {
      console.warn(`[ProgressionSystem] Unknown passive: ${passiveId}`);
      return false;
    }

    const currentRank = this.passives.get(passiveId) ?? 0;

    if (currentRank === 0) {
      if (this.passives.size >= this.MAX_PASSIVE_SLOTS) {
        console.warn(`[ProgressionSystem] Passive slots full. Cannot add ${passiveId}.`);
        return false;
      }
      this.passives.set(passiveId, 1);
      this._emitChange({ type: "passive_added", itemId: passiveId, newRank: 1 });
    } else if (currentRank < this.MAX_RANK) {
      this.passives.set(passiveId, currentRank + 1);
      this._emitChange({ type: "passive_upgraded", itemId: passiveId, newRank: currentRank + 1 });
    } else {
      console.warn(`[ProgressionSystem] ${passiveId} already at max rank.`);
      return false;
    }

    // Passive modifiers apply immediately
    this._recomputeStats();
    this._checkRecipes();
    return true;
  }

  /** Removes a weapon from the loadout. Used by cheat/debug or mutation. */
  removeWeapon(weaponId: string): boolean {
    if (!this.weapons.has(weaponId)) return false;
    this.weapons.delete(weaponId);
    this._emitChange({ type: "weapon_removed", itemId: weaponId, newRank: 0 });
    this._recomputeStats();
    this._checkRecipes();
    return true;
  }

  /** Removes a passive from the loadout. */
  removePassive(passiveId: string): boolean {
    if (!this.passives.has(passiveId)) return false;
    this.passives.delete(passiveId);
    this._emitChange({ type: "passive_removed", itemId: passiveId, newRank: 0 });
    this._recomputeStats();
    this._checkRecipes();
    return true;
  }

  // --------------------------------------------------------------------------
  // RECIPE CHECKING & MUTATION
  // --------------------------------------------------------------------------

  /**
   * After every inventory change, scan for any base weapon at Rank 5 whose
   * matching passive is also at Rank 5. If found, execute the mutation:
   *   1. Permanently delete the base weapon.
   *   2. Unlock the ultimate evolution variant.
   */
  private _checkRecipes(): void {
    for (const [weaponId, weaponRank] of this.weapons) {
      if (weaponRank < this.MAX_RANK) continue;

      const weapon = WEAPON_REGISTRY.get(weaponId);
      if (!weapon || !weapon.evolutionId) continue;

      const passiveRank = this.passives.get(weapon.requiredPassiveId) ?? 0;
      if (passiveRank < this.MAX_RANK) continue;

      // MUTATION SEQUENCE
      const evolutionId = weapon.evolutionId;

      // 1. Permanently delete base weapon
      this.weapons.delete(weaponId);

      // 2. Unlock ultimate evolution (permanent for the run)
      this.unlockedEvolutions.add(evolutionId);

      // 3. Optionally: if you want the evolution to occupy a weapon slot,
      //    uncomment the next line. By default it lives in the evolution set
      //    so the player gets a free power spike and an open weapon slot.
      // this.weapons.set(evolutionId, this.MAX_RANK);

      this._emitChange({
        type: "evolution_unlocked",
        itemId: evolutionId,
        newRank: this.MAX_RANK,
        evolvedFrom: weaponId,
        evolvedInto: evolutionId,
      });

      console.log(
        `[ProgressionSystem] MUTATION: ${weapon.name} + ${PASSIVE_REGISTRY.get(weapon.requiredPassiveId)?.name} → ${EVOLUTION_REGISTRY.get(evolutionId)?.name}`
      );

      // Only one mutation per check cycle to avoid cascading side-effects
      break;
    }
  }

  // --------------------------------------------------------------------------
  // STAT RECOMPUTATION
  // --------------------------------------------------------------------------

  /** Aggregates all passive ranks into the live StatModifiers snapshot. */
  private _recomputeStats(): void {
    const stats = createZeroStats();

    for (const [passiveId, rank] of this.passives) {
      const config = PASSIVE_REGISTRY.get(passiveId);
      if (config) {
        config.applyRank(stats, rank);
      }
    }

    // Hard caps
    stats.cooldownReduction = Math.min(stats.cooldownReduction, 0.80);
    stats.critChance = Math.min(stats.critChance, 1.0);
    stats.lifeSteal = Math.min(stats.lifeSteal, 0.50);

    this.liveStats = stats;

    // Broadcast to PlayerController / WeaponEngine
    for (const cb of this.statListeners) {
      cb(this.liveStats);
    }
  }

  // --------------------------------------------------------------------------
  // EVENTS
  // --------------------------------------------------------------------------

  /** Subscribe to live stat changes. Fires immediately with current stats. */
  onStatsChanged(callback: (stats: StatModifiers) => void): () => void {
    this.statListeners.push(callback);
    callback(this.liveStats); // Initial push
    return () => {
      const idx = this.statListeners.indexOf(callback);
      if (idx >= 0) this.statListeners.splice(idx, 1);
    };
  }

  /** Subscribe to inventory mutation events. */
  onInventoryChanged(callback: (evt: InventoryChangeEvent) => void): () => void {
    this.changeListeners.push(callback);
    return () => {
      const idx = this.changeListeners.indexOf(callback);
      if (idx >= 0) this.changeListeners.splice(idx, 1);
    };
  }

  private _emitChange(evt: InventoryChangeEvent): void {
    for (const cb of this.changeListeners) {
      cb(evt);
    }
  }

  // --------------------------------------------------------------------------
  // SERIALIZATION (for save/load)
  // --------------------------------------------------------------------------

  serialize(): object {
    return {
      weapons: Array.from(this.weapons.entries()),
      passives: Array.from(this.passives.entries()),
      evolutions: Array.from(this.unlockedEvolutions),
    };
  }

  deserialize(data: { weapons: [string, number][]; passives: [string, number][]; evolutions: string[] }): void {
    this.weapons = new Map(data.weapons);
    this.passives = new Map(data.passives);
    this.unlockedEvolutions = new Set(data.evolutions);
    this._recomputeStats();
  }
}

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

/** Helper to resolve the EvolutionBehavior for an unlocked evolution. */
export function getEvolutionBehavior(evolutionId: string): EvolutionBehavior | undefined {
  return EVOLUTION_REGISTRY.get(evolutionId);
}

/** Helper to check if a given weapon+passive pair can still evolve. */
export function canMutate(weaponId: string, passiveId: string, inv: InventoryManager): boolean {
  const weapon = WEAPON_REGISTRY.get(weaponId);
  if (!weapon) return false;
  return (
    weapon.requiredPassiveId === passiveId &&
    inv.getWeaponRank(weaponId) >= 5 &&
    inv.getPassiveRank(passiveId) >= 5 &&
    !inv.hasEvolution(weapon.evolutionId)
  );
}

/** Returns all evolution IDs that are theoretically possible given current loadout. */
export function getPendingMutations(inv: InventoryManager): string[] {
  const pending: string[] = [];
  for (const [weaponId, rank] of inv.getWeapons()) {
    if (rank < 5) continue;
    const weapon = WEAPON_REGISTRY.get(weaponId);
    if (!weapon || !weapon.evolutionId) continue;
    if (inv.getPassiveRank(weapon.requiredPassiveId) >= 5 && !inv.hasEvolution(weapon.evolutionId)) {
      pending.push(weapon.evolutionId);
    }
  }
  return pending;
}
