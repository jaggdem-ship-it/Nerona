// ============================================================
// CharacterArchetypes.ts
// Isolated class-definition database & factory injector.
// ============================================================

/**
 * Raw stat modifier block applied to a player entity at spawn time.
 * All values are additive deltas (e.g. +0.10 means +10%).
 */
export interface StatModifierBlock {
  /** Flat health bonus (positive or negative). */
  health: number;
  /** Multiplicative movement speed modifier (1.0 = baseline). */
  baseSpeed: number;
  /** Pickup magnet radius bonus in world units. */
  passiveMagnetRadius: number;
  /** Flat armor rating bonus (damage reduction). */
  passiveArmor: number;
  /** Multiplicative outgoing damage modifier (1.0 = baseline). */
  passiveDamageMod: number;
  /** Critical hit chance bonus (0.15 = +15%). */
  passiveCritChance: number;
}

/**
 * Immutable character archetype blueprint.
 * Consumed by `applyClassArchetype` during player initialization.
 */
export interface CharacterProfile {
  /** Display name used in UI / selection screens. */
  readonly className: string;
  /**
   * Index into the 2x2 portrait atlas grid.
   * 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right.
   */
  readonly portraitAtlasIndex: number;
  /** Baseline stat modifiers applied on spawn. */
  readonly stats: StatModifierBlock;
  /** Weapon ID string resolved by the WeaponRegistry on spawn. */
  readonly starterWeaponId: string;
}

// ------------------------------------------------------------------
// HARDCODED ARCHETYPE DATABASE
// ------------------------------------------------------------------

/**
 * Read-only dictionary of all playable classes keyed by stable ID.
 */
export const CHARACTER_ARCHETYPES: Readonly<Record<string, CharacterProfile>> = {
  heretic: {
    className: "The Heretic",
    portraitAtlasIndex: 0,
    stats: {
      health: 0,
      baseSpeed: 0.10,
      passiveMagnetRadius: 0,
      passiveArmor: 0,
      passiveDamageMod: 0,
      passiveCritChance: 0,
    },
    starterWeaponId: "sinners_quills",
  },

  necromancer: {
    className: "The Necromancer",
    portraitAtlasIndex: 1,
    stats: {
      health: 0,
      baseSpeed: 0,
      passiveMagnetRadius: 0,
      passiveArmor: -2,
      passiveDamageMod: 0.15,
      passiveCritChance: 0,
    },
    starterWeaponId: "unholy_orbit",
  },

  paladin: {
    className: "The Paladin",
    portraitAtlasIndex: 2,
    stats: {
      health: 0,
      baseSpeed: -0.10,
      passiveMagnetRadius: 0,
      passiveArmor: 4,
      passiveDamageMod: 0,
      passiveCritChance: 0,
    },
    starterWeaponId: "judgment_radiance",
  },

  rogue: {
    className: "The Rogue",
    portraitAtlasIndex: 3,
    stats: {
      health: 0,
      baseSpeed: 0,
      passiveMagnetRadius: 0,
      passiveArmor: 0,
      passiveDamageMod: 0,
      passiveCritChance: 0.15,
    },
    starterWeaponId: "whirling_halberds",
  },
} as const;

/** Union type of all valid class keys for compile-time safety. */
export type ClassArchetypeId = keyof typeof CHARACTER_ARCHETYPES;

// ------------------------------------------------------------------
// ENTITY CONTRACT (minimal interface expected by the injector)
// ------------------------------------------------------------------

/**
 * Lightweight contract describing the shape of a player entity
 * that the factory can hydrate. In a full project this interface
 * would be imported from your Player / Entity module.
 */
export interface IPlayerEntity {
  /** Babylon.js mesh or transform node representing the player. */
  mesh: import("@babylonjs/core").TransformNode;
  /** Mutable runtime data bucket. */
  metadata: {
    classId?: string;
    className?: string;
    portraitAtlasIndex?: number;
    stats: {
      health: number;
      baseSpeed: number;
      passiveMagnetRadius: number;
      passiveArmor: number;
      passiveDamageMod: number;
      passiveCritChance: number;
    };
    starterWeaponId?: string;
  };
}

// ------------------------------------------------------------------
// FACTORY INITIALIZER
// ------------------------------------------------------------------

/**
 * Validates the requested `classId`, retrieves the matching archetype,
 * and injects all baseline properties, multipliers, and weapon hooks
 * directly into the target player entity's metadata.
 *
 * @param playerEntity - The live player entity instance to mutate.
 * @param classId      - Stable archetype key (e.g. "heretic", "rogue").
 * @returns The same `playerEntity` reference for chaining.
 * @throws If `classId` is not present in the archetype database.
 */
export function applyClassArchetype(
  playerEntity: IPlayerEntity,
  classId: string
): IPlayerEntity {
  const profile = CHARACTER_ARCHETYPES[classId];

  if (!profile) {
    const validKeys = Object.keys(CHARACTER_ARCHETYPES).join(", ");
    throw new Error(
      `[CharacterArchetypes] Invalid classId "${classId}". ` +
        `Expected one of: ${validKeys}`
    );
  }

  // Ensure the metadata.stats sub-object exists.
  if (!playerEntity.metadata) {
    (playerEntity as IPlayerEntity).metadata = {
      stats: {
        health: 0,
        baseSpeed: 1.0,
        passiveMagnetRadius: 1.0,
        passiveArmor: 0,
        passiveDamageMod: 1.0,
        passiveCritChance: 0,
      },
    };
  }

  const base = playerEntity.metadata.stats;

  // --- Inject identity & portrait reference ---
  playerEntity.metadata.classId = classId;
  playerEntity.metadata.className = profile.className;
  playerEntity.metadata.portraitAtlasIndex = profile.portraitAtlasIndex;
  playerEntity.metadata.starterWeaponId = profile.starterWeaponId;

  // --- Inject additive stat modifiers ---
  base.health += profile.stats.health;
  base.baseSpeed += profile.stats.baseSpeed;
  base.passiveMagnetRadius += profile.stats.passiveMagnetRadius;
  base.passiveArmor += profile.stats.passiveArmor;
  base.passiveDamageMod += profile.stats.passiveDamageMod;
  base.passiveCritChance += profile.stats.passiveCritChance;

  // Optional: clamp sanity bounds so designers can't accidentally
  // push values into negative territory during future balance passes.
  base.baseSpeed = Math.max(0.1, base.baseSpeed);
  base.passiveMagnetRadius = Math.max(0, base.passiveMagnetRadius);
  base.passiveDamageMod = Math.max(0.1, base.passiveDamageMod);
  base.passiveCritChance = Math.max(0, Math.min(1, base.passiveCritChance));

  return playerEntity;
}

// ------------------------------------------------------------------
// UTILITY EXPORTS (handy for UI / selection screens)
// ------------------------------------------------------------------

/** Returns a shallow array of all archetype entries for character-select UIs. */
export function getAllArchetypes(): readonly CharacterProfile[] {
  return Object.values(CHARACTER_ARCHETYPES);
}

/** Type-guard to validate a string at runtime. */
export function isValidClassId(id: string): id is ClassArchetypeId {
  return id in CHARACTER_ARCHETYPES;
}
