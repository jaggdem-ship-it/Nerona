/**
 * ============================================================================
 * SpriteAnimator.ts — High-Performance Sprite Sheet Management System
 * ============================================================================
 * Principal Technical Animator Module for a Gothic Diablo-style horde-survival
 * rogue-lite built on Babylon.js. Manages multi-layered billboard sprite
 * animation, state-machine-driven character playback, automatic directional
 * flipping, and pooled enemy instantiation.
 *
 * Architecture:
 *   • SpriteAnimationController   – Central orchestrator, owns all managers
 *   • SpriteStateMachine          – Player animation state transitions
 *   • EnemySpritePool             – Object-pooled enemy billboards
 *   • SpriteSheetRegistry         – Static metadata for every uploaded asset
 * ============================================================================
 */

import * as BABYLON from "@babylonjs/core";

// =============================================================================
// SECTION 1: TYPE DEFINITIONS & CONSTANTS
// =============================================================================

/** Valid animation states for the player character. */
export type PlayerAnimState = "idle" | "run" | "death";

/** Valid animation states for enemy skeletons. */
export type EnemyAnimState = "walk" | "attack" | "death";

/** Directional facings for isometric/8-way sprite sheets. */
export type FacingDirection =
  | "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/** Metadata describing a single sprite sheet's grid layout. */
interface SpriteSheetMeta {
  /** Asset URL (relative or absolute). */
  url: string;
  /** Number of columns in the sprite sheet grid. */
  cols: number;
  /** Number of rows in the sprite sheet grid. */
  rows: number;
  /** Pixel width of one cell (frame). */
  cellWidth: number;
  /** Pixel height of one cell (frame). */
  cellHeight: number;
  /** Total frame count (may be < cols * rows if sheet has padding). */
  frameCount: number;
  /** Playback frames-per-second for this animation. */
  fps: number;
  /** Whether this sheet loops indefinitely. */
  loop: boolean;
  /** Whether the sheet supports 8-way directional rows. */
  directional: boolean;
  /** Z-layer priority (higher = rendered on top). */
  layerPriority: number;
}

/** Runtime descriptor for a living sprite instance. */
interface SpriteInstance {
  /** The Babylon Sprite handle. */
  sprite: BABYLON.Sprite;
  /** Current animation metadata. */
  meta: SpriteSheetMeta;
  /** Current frame index (0-based). */
  currentFrame: number;
  /** Accumulated delta time for frame advancement. */
  frameTimer: number;
  /** Time between frames in ms (derived from fps + random offset). */
  frameIntervalMs: number;
  /** Whether the sprite is currently flipped horizontally. */
  flipped: boolean;
  /** Current animation state label. */
  state: string;
  /** Facing direction (for multi-row directional sheets). */
  facing: FacingDirection;
  /** World-space velocity vector (used for auto-flip). */
  velocity: BABYLON.Vector3;
  /** Whether this instance is pooled and available for reuse. */
  isPooled: boolean;
  /** Unique instance ID for debugging. */
  id: number;
}

/** Configuration passed to the controller constructor. */
export interface SpriteAnimatorConfig {
  /** Babylon scene reference. */
  scene: BABYLON.Scene;
  /** Base path where sprite textures are hosted. */
  assetBasePath?: string;
  /** Maximum concurrent player sprites (usually 1, but supports clones). */
  maxPlayerSprites?: number;
  /** Maximum concurrent enemy sprites (object pool size). */
  maxEnemySprites?: number;
  /** Maximum concurrent VFX sprites. */
  maxVfxSprites?: number;
  /** Global time-scale multiplier (1.0 = normal). */
  timeScale?: number;
}

// =============================================================================
// SECTION 2: SPRITE SHEET REGISTRY — Asset Metadata for All Uploaded Textures
// =============================================================================

/**
 * Static registry containing grid-slicing metadata for every hand-painted
 * texture uploaded to the project. Each entry describes how a 4K texture
 * is divided into animation frames for the SpriteManager.
 */
const SPRITE_SHEET_REGISTRY: Record<string, SpriteSheetMeta> = {
  // ---------------------------------------------------------------------------
  // PLAYER CHARACTER — 8-directional run cycle (72 frames total)
  // Texture: player_run.png
  // Layout: 8 rows × 9 cols, each cell ~512×512px in a 4K sheet
  // Directions: N, NE, E, SE, S, SW, W, NW (top-to-bottom)
  // ---------------------------------------------------------------------------
  player_run: {
    url: "assets/sprites/player_run.png",
    cols: 9,
    rows: 8,
    cellWidth: 512,
    cellHeight: 512,
    frameCount: 72,
    fps: 12,
    loop: true,
    directional: true,
    layerPriority: 100,
  },

  // ---------------------------------------------------------------------------
  // PLAYER CHARACTER — Idle loop + progressive death animation (14 frames)
  // Texture: player_idle.png
  // Layout: 1 row × 14 cols, each cell ~512×512px
  // Frames 0-5: idle breathing loop
  // Frames 6-13: progressive collapse/death (one-shot)
  // ---------------------------------------------------------------------------
  player_idle: {
    url: "assets/sprites/player_idle.png",
    cols: 14,
    rows: 1,
    cellWidth: 512,
    cellHeight: 512,
    frameCount: 14,
    fps: 8,
    loop: true,
    directional: false,
    layerPriority: 100,
  },

  // ---------------------------------------------------------------------------
  // ENEMY: SKELETON WALK — 11-frame walk cycle
  // Texture: skeleton_walk.png
  // Layout: 1 row × 11 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  skeleton_walk: {
    url: "assets/sprites/skeleton_walk.png",
    cols: 11,
    rows: 1,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 11,
    fps: 10,
    loop: true,
    directional: false,
    layerPriority: 90,
  },

  // ---------------------------------------------------------------------------
  // ENEMY: SKELETON ATTACK — 11-frame attack animation
  // Texture: skeleton_attack.png
  // Layout: 1 row × 11 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  skeleton_attack: {
    url: "assets/sprites/skeleton_attack.png",
    cols: 11,
    rows: 1,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 11,
    fps: 14,
    loop: false,
    directional: false,
    layerPriority: 90,
  },

  // ---------------------------------------------------------------------------
  // VFX: NECROTIC BLOOD VORTEX — 37-frame swirling blood portal
  // Texture: blood_vortex.png
  // Layout: Spiral arrangement mapped to a grid: ~6 rows × 7 cols
  // Central large vortex + surrounding ring fragments
  // ---------------------------------------------------------------------------
  blood_vortex: {
    url: "assets/sprites/blood_vortex.png",
    cols: 7,
    rows: 6,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 37,
    fps: 16,
    loop: true,
    directional: false,
    layerPriority: 50,
  },

  // ---------------------------------------------------------------------------
  // VFX: NECROTIC ERUPTION — 16-frame fire + explosion sequence
  // Texture: necrotic_eruption.png
  // Layout: Mixed rows; 4 rows with varying cols
  // Row 0: Blood-Red Fire Carpet (4 frames)
  // Row 1: Molten Bone Marrow Geysers (6 frames)
  // Row 2: Visceral Organic Explosions (2 frames)
  // Row 3: Smoke Dissipation (4 frames)
  // ---------------------------------------------------------------------------
  necrotic_eruption: {
    url: "assets/sprites/necrotic_eruption.png",
    cols: 6,
    rows: 4,
    cellWidth: 512,
    cellHeight: 512,
    frameCount: 16,
    fps: 12,
    loop: false,
    directional: false,
    layerPriority: 60,
  },

  // ---------------------------------------------------------------------------
  // VFX: LIGHTNING SPELL — 6 categories of electrical discharge
  // Texture: lightning_vfx.png
  // Layout: 6 rows × 12 cols, each cell ~256×128px
  // Rows: Discharge Arcs, Branching Bolts, Impact Crackles,
  //       Electrical Pulses, Ground-Striking, Volatile Crackles
  // ---------------------------------------------------------------------------
  lightning_vfx: {
    url: "assets/sprites/lightning_vfx.png",
    cols: 12,
    rows: 6,
    cellWidth: 256,
    cellHeight: 128,
    frameCount: 72,
    fps: 18,
    loop: false,
    directional: false,
    layerPriority: 70,
  },

  // ---------------------------------------------------------------------------
  // VFX: HOLY LIGHT BEAM — 4-frame divine radiance
  // Texture: holy_light.png
  // Layout: 2 rows × 2 cols, each cell ~512×512px
  // ---------------------------------------------------------------------------
  holy_light: {
    url: "assets/sprites/holy_light.png",
    cols: 2,
    rows: 2,
    cellWidth: 512,
    cellHeight: 512,
    frameCount: 4,
    fps: 8,
    loop: true,
    directional: false,
    layerPriority: 65,
  },

  // ---------------------------------------------------------------------------
  // VFX: BLOOD/CELLULAR FLUID — 26 frames across 4 animation strips
  // Texture: blood_fluid_vfx.png
  // Layout: 4 rows × 8 cols, each cell ~256×256px
  // Strips: Blood Fluid, Cellular Tether Pulse, Glowing Red Energy,
  //         Fused Blood Energy
  // ---------------------------------------------------------------------------
  blood_fluid_vfx: {
    url: "assets/sprites/blood_fluid_vfx.png",
    cols: 8,
    rows: 4,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 26,
    fps: 10,
    loop: true,
    directional: false,
    layerPriority: 55,
  },

  // ---------------------------------------------------------------------------
  // VFX: BLOOD DRIPS + ENERGY STREAMS — 21 frames
  // Texture: blood_drips_energy.png
  // Layout: 3 rows × 8 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  blood_drips_energy: {
    url: "assets/sprites/blood_drips_energy.png",
    cols: 8,
    rows: 3,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 21,
    fps: 10,
    loop: true,
    directional: false,
    layerPriority: 55,
  },

  // ---------------------------------------------------------------------------
  // ENVIRONMENT: TOMBSTONES — 27 static decorative objects
  // Texture: tombstones.png
  // Layout: 3 rows × 9 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  tombstones: {
    url: "assets/sprites/tombstones.png",
    cols: 9,
    rows: 3,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 27,
    fps: 0,
    loop: false,
    directional: false,
    layerPriority: 40,
  },

  // ---------------------------------------------------------------------------
  // PROPS: GOTHIC SHIELDS — 8 static shield variants
  // Texture: shields.png
  // Layout: 2 rows × 4 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  shields: {
    url: "assets/sprites/shields.png",
    cols: 4,
    rows: 2,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 8,
    fps: 0,
    loop: false,
    directional: false,
    layerPriority: 45,
  },

  // ---------------------------------------------------------------------------
  // SPELL: ICE SPIKE PROJECTILE — 16-frame expansion/shatter
  // Texture: ice_spikes.png
  // Layout: 4 rows × 4 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  ice_spikes: {
    url: "assets/sprites/ice_spikes.png",
    cols: 4,
    rows: 4,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 16,
    fps: 14,
    loop: false,
    directional: false,
    layerPriority: 75,
  },

  // ---------------------------------------------------------------------------
  // WEAPON: NECROTIC SCYTHE — 28-frame spinning attack
  // Texture: scythe.png
  // Layout: 4 rows × 7 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  scythe: {
    url: "assets/sprites/scythe.png",
    cols: 7,
    rows: 4,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 28,
    fps: 16,
    loop: true,
    directional: false,
    layerPriority: 80,
  },

  // ---------------------------------------------------------------------------
  // WEAPON: RITUAL DAGGERS — 56-frame rotation set (0°–200°)
  // Texture: daggers.png
  // Layout: 4 rows × 14 cols, each cell ~128×128px
  // ---------------------------------------------------------------------------
  daggers: {
    url: "assets/sprites/daggers.png",
    cols: 14,
    rows: 4,
    cellWidth: 128,
    cellHeight: 128,
    frameCount: 56,
    fps: 0,
    loop: false,
    directional: false,
    layerPriority: 80,
  },

  // ---------------------------------------------------------------------------
  // VFX: BONE RIBCAGE EXPLOSION — 30-frame shatter sequence
  // Texture: bone_explosion.png
  // Layout: 4 rows × 8 cols, each cell ~256×256px
  // ---------------------------------------------------------------------------
  bone_explosion: {
    url: "assets/sprites/bone_explosion.png",
    cols: 8,
    rows: 4,
    cellWidth: 256,
    cellHeight: 256,
    frameCount: 30,
    fps: 14,
    loop: false,
    directional: false,
    layerPriority: 65,
  },

  // ---------------------------------------------------------------------------
  // ENVIRONMENT: LAVA TILES — 13-frame boiling lava surface
  // Texture: lava_tiles.png
  // Layout: 3 rows × 5 cols, each cell ~512×512px
  // ---------------------------------------------------------------------------
  lava_tiles: {
    url: "assets/sprites/lava_tiles.png",
    cols: 5,
    rows: 3,
    cellWidth: 512,
    cellHeight: 512,
    frameCount: 13,
    fps: 6,
    loop: true,
    directional: false,
    layerPriority: 30,
  },

  // ---------------------------------------------------------------------------
  // VFX: VOID PORTALS — 4-frame swirling dark portals
  // Texture: void_portals.png
  // Layout: 2 rows × 2 cols, each cell ~512×512px
  // ---------------------------------------------------------------------------
  void_portals: {
    url: "assets/sprites/void_portals.png",
    cols: 2,
    rows: 2,
    cellWidth: 512,
    cellHeight: 512,
    frameCount: 4,
    fps: 8,
    loop: true,
    directional: false,
    layerPriority: 50,
  },
};

// =============================================================================
// SECTION 3: DIRECTION MAPPING UTILITIES
// =============================================================================

/** Maps a velocity vector to the nearest 8-way facing direction. */
function velocityToFacing(vx: number, vz: number): FacingDirection {
  if (vx === 0 && vz === 0) return "S"; // default facing
  const angle = Math.atan2(vz, vx); // radians, 0 = East
  const deg = (angle * 180) / Math.PI;
  const normalized = ((deg + 360) % 360);

  // 8-way compass: slice into 45° sectors
  if (normalized >= 337.5 || normalized < 22.5)  return "E";
  if (normalized >= 22.5  && normalized < 67.5)   return "SE";
  if (normalized >= 67.5  && normalized < 112.5)  return "S";
  if (normalized >= 112.5 && normalized < 157.5)  return "SW";
  if (normalized >= 157.5 && normalized < 202.5)  return "W";
  if (normalized >= 202.5 && normalized < 247.5)  return "NW";
  if (normalized >= 247.5 && normalized < 292.5)  return "N";
  return "NE";
}

/** Row index for each facing in the player_run 8-directional sheet. */
const FACING_ROW_MAP: Record<FacingDirection, number> = {
  N: 0, NE: 1, E: 2, SE: 3, S: 4, SW: 5, W: 6, NW: 7,
};

// =============================================================================
// SECTION 4: ENEMY SPRITE POOL
// =============================================================================

/**
 * Object pool for enemy billboard sprites. Pre-allocates Sprite instances
 * from a centralized SpriteManager to eliminate per-spawn GC pressure when
 * hundreds of skeletons are active on screen.
 */
class EnemySpritePool {
  private _scene: BABYLON.Scene;
  private _manager: BABYLON.SpriteManager;
  private _meta: SpriteSheetMeta;
  private _available: SpriteInstance[] = [];
  private _active: Map<number, SpriteInstance> = new Map();
  private _nextId = 0;
  private _basePath: string;

  constructor(
    scene: BABYLON.Scene,
    meta: SpriteSheetMeta,
    capacity: number,
    basePath: string
  ) {
    this._scene = scene;
    this._meta = meta;
    this._basePath = basePath;

    // Create the centralized SpriteManager with high capacity
    const textureUrl = basePath + meta.url;
    this._manager = new BABYLON.SpriteManager(
      `sm_enemy_${meta.url.replace(/[^a-z0-9]/gi, "_")}`,
      textureUrl,
      capacity,
      { width: meta.cellWidth, height: meta.cellHeight },
      scene
    );
    this._manager.isPickable = false;
    this._manager.renderingGroupId = meta.layerPriority;

    // Pre-allocate all sprites into the pool
    for (let i = 0; i < capacity; i++) {
      const sprite = new BABYLON.Sprite(`enemy_sprite_${i}`, this._manager);
      sprite.isVisible = false;
      sprite.size = 2.0;
      sprite.position = BABYLON.Vector3.Zero();

      const instance: SpriteInstance = {
        sprite,
        meta,
        currentFrame: 0,
        frameTimer: 0,
        frameIntervalMs: 1000 / meta.fps,
        flipped: false,
        state: "walk",
        facing: "S",
        velocity: BABYLON.Vector3.Zero(),
        isPooled: true,
        id: this._nextId++,
      };
      this._available.push(instance);
    }
  }

  /** Acquire a sprite from the pool. Returns null if exhausted. */
  acquire(
    position: BABYLON.Vector3,
    speedVariance: number = 0.25
  ): SpriteInstance | null {
    const instance = this._available.pop();
    if (!instance) return null;

    // Reset to active state
    instance.isPooled = false;
    instance.sprite.isVisible = true;
    instance.sprite.position.copyFrom(position);
    instance.sprite.position.y = 1.0; // stand on ground
    instance.currentFrame = 0;
    instance.frameTimer = 0;

    // Apply randomized frame speed offset to break visual uniformity
    const variance = 1.0 + (Math.random() * 2.0 - 1.0) * speedVariance;
    instance.frameIntervalMs = (1000 / this._meta.fps) * variance;

    // Randomize starting frame so hordes don't march in lockstep
    instance.currentFrame = Math.floor(Math.random() * this._meta.frameCount);

    this._active.set(instance.id, instance);
    this._updateSpriteCell(instance);
    return instance;
  }

  /** Return a sprite to the pool for reuse. */
  release(instance: SpriteInstance): void {
    if (instance.isPooled) return;

    instance.isPooled = true;
    instance.sprite.isVisible = false;
    instance.sprite.position = BABYLON.Vector3.Zero();
    instance.velocity = BABYLON.Vector3.Zero();
    instance.flipped = false;

    this._active.delete(instance.id);
    this._available.push(instance);
  }

  /** Update all active enemy sprites for a frame. */
  update(deltaMs: number, timeScale: number): void {
    const scaledDelta = deltaMs * timeScale;
    for (const inst of this._active.values()) {
      this._advanceFrame(inst, scaledDelta);
      this._applyFlip(inst);
      this._updateSpriteCell(inst);
    }
  }

  /** Get all currently active instances. */
  get active(): IterableIterator<SpriteInstance> {
    return this._active.values();
  }

  get activeCount(): number {
    return this._active.size;
  }

  get availableCount(): number {
    return this._available.length;
  }

  /** Advance animation frame based on elapsed time. */
  private _advanceFrame(inst: SpriteInstance, deltaMs: number): void {
    inst.frameTimer += deltaMs;
    if (inst.frameTimer >= inst.frameIntervalMs) {
      inst.frameTimer -= inst.frameIntervalMs;
      inst.currentFrame++;
      if (inst.currentFrame >= inst.meta.frameCount) {
        inst.currentFrame = inst.meta.loop ? 0 : inst.meta.frameCount - 1;
      }
    }
  }

  /** Apply invertU based on X velocity sign. */
  private _applyFlip(inst: SpriteInstance): void {
    const shouldFlip = inst.velocity.x < 0;
    if (shouldFlip !== inst.flipped) {
      inst.flipped = shouldFlip;
      inst.sprite.invertU = shouldFlip ? 1 : 0;
    }
  }

  /** Map the current frame index to cell coordinates on the sprite sheet. */
  private _updateSpriteCell(inst: SpriteInstance): void {
    const meta = inst.meta;
    const frame = Math.min(inst.currentFrame, meta.frameCount - 1);

    let row: number;
    let col: number;

    if (meta.directional) {
      // For directional sheets, row = facing direction, col = frame within row
      row = FACING_ROW_MAP[inst.facing] ?? 0;
      col = frame % meta.cols;
    } else {
      row = Math.floor(frame / meta.cols);
      col = frame % meta.cols;
    }

    // Clamp to valid grid bounds
    row = Math.min(row, meta.rows - 1);
    col = Math.min(col, meta.cols - 1);

    inst.sprite.cellIndex = row * meta.cols + col;
  }

  /** Dispose all resources. */
  dispose(): void {
    for (const inst of this._available) {
      inst.sprite.dispose();
    }
    for (const inst of this._active.values()) {
      inst.sprite.dispose();
    }
    this._available.length = 0;
    this._active.clear();
    this._manager.dispose();
  }
}

// =============================================================================
// SECTION 5: PLAYER SPRITE STATE MACHINE
// =============================================================================

/**
 * State machine managing the player's billboard sprite transitions.
 * Handles clean disposal of previous animation sprites to prevent
 * memory leaks when switching between idle, run, and death states.
 */
class PlayerSpriteStateMachine {
  private _scene: BABYLON.Scene;
  private _managers: Map<string, BABYLON.SpriteManager> = new Map();
  private _current: SpriteInstance | null = null;
  private _state: PlayerAnimState = "idle";
  private _facing: FacingDirection = "S";
  private _velocity: BABYLON.Vector3 = BABYLON.Vector3.Zero();
  private _basePath: string;
  private _timeScale = 1.0;
  private _nextId = 0;

  constructor(scene: BABYLON.Scene, basePath: string) {
    this._scene = scene;
    this._basePath = basePath;
  }

  /** Initialize the sprite managers for player animations. */
  initialize(): void {
    this._ensureManager("player_idle", SPRITE_SHEET_REGISTRY.player_idle);
    this._ensureManager("player_run", SPRITE_SHEET_REGISTRY.player_run);
  }

  /** Switch to a new animation state with clean disposal of the old sprite. */
  setState(newState: PlayerAnimState): void {
    if (this._state === newState && this._current) return;

    // Cleanly dispose the previous sprite to prevent memory leaks
    this._disposeCurrent();

    this._state = newState;
    const metaKey = newState === "death" ? "player_idle" : `player_${newState}`;
    const meta = SPRITE_SHEET_REGISTRY[metaKey];
    if (!meta) return;

    const manager = this._ensureManager(metaKey, meta);
    const sprite = new BABYLON.Sprite(`player_${newState}_${this._nextId++}`, manager);
    sprite.size = 2.5; // Player is larger than enemies
    sprite.position = this._current?.sprite.position?.clone() ?? new BABYLON.Vector3(0, 1.5, 0);
    sprite.isVisible = true;

    this._current = {
      sprite,
      meta,
      currentFrame: 0,
      frameTimer: 0,
      frameIntervalMs: 1000 / meta.fps,
      flipped: false,
      state: newState,
      facing: this._facing,
      velocity: this._velocity.clone(),
      isPooled: false,
      id: this._nextId++,
    };

    this._updateSpriteCell(this._current);
  }

  /** Update facing direction from velocity vector. */
  setVelocity(velocity: BABYLON.Vector3): void {
    this._velocity.copyFrom(velocity);
    if (this._current) {
      this._current.velocity.copyFrom(velocity);
    }

    // Update facing for directional sheets
    if (velocity.length() > 0.01) {
      this._facing = velocityToFacing(velocity.x, velocity.z);
      if (this._current) {
        this._current.facing = this._facing;
      }
    }

    // Auto-flip based on X velocity sign
    this._applyFlip();

    // Auto-transition between idle and run
    const isMoving = velocity.length() > 0.05;
    const targetState: PlayerAnimState = isMoving ? "run" : "idle";
    if (this._state !== "death" && this._state !== targetState) {
      this.setState(targetState);
    }
  }

  /** Per-frame update for the player sprite. */
  update(deltaMs: number): void {
    if (!this._current) return;

    const scaledDelta = deltaMs * this._timeScale;
    const inst = this._current;

    inst.frameTimer += scaledDelta;
    if (inst.frameTimer >= inst.frameIntervalMs) {
      inst.frameTimer -= inst.frameIntervalMs;
      inst.currentFrame++;
      if (inst.currentFrame >= inst.meta.frameCount) {
        inst.currentFrame = inst.meta.loop ? 0 : inst.meta.frameCount - 1;
      }
    }

    this._updateSpriteCell(inst);
  }

  /** Set the player sprite's world position. */
  setPosition(position: BABYLON.Vector3): void {
    if (this._current) {
      this._current.sprite.position.copyFrom(position);
      this._current.sprite.position.y = 1.5;
    }
  }

  /** Get the current sprite position. */
  get position(): BABYLON.Vector3 | null {
    return this._current?.sprite.position ?? null;
  }

  get currentState(): PlayerAnimState {
    return this._state;
  }

  set timeScale(value: number) {
    this._timeScale = value;
  }

  /** Dispose the current sprite and null the reference. */
  private _disposeCurrent(): void {
    if (this._current) {
      this._current.sprite.dispose();
      this._current = null;
    }
  }

  /** Apply horizontal flip based on X velocity sign. */
  private _applyFlip(): void {
    if (!this._current) return;
    const shouldFlip = this._velocity.x < -0.01;
    if (shouldFlip !== this._current.flipped) {
      this._current.flipped = shouldFlip;
      this._current.sprite.invertU = shouldFlip ? 1 : 0;
    }
  }

  /** Lazily create or retrieve a SpriteManager for a given key. */
  private _ensureManager(
    key: string,
    meta: SpriteSheetMeta
  ): BABYLON.SpriteManager {
    if (this._managers.has(key)) {
      return this._managers.get(key)!;
    }

    const textureUrl = this._basePath + meta.url;
    const manager = new BABYLON.SpriteManager(
      `sm_player_${key}`,
      textureUrl,
      4, // Small capacity for player (1 active + 3 buffer for state transitions)
      { width: meta.cellWidth, height: meta.cellHeight },
      this._scene
    );
    manager.isPickable = true;
    manager.renderingGroupId = meta.layerPriority;
    this._managers.set(key, manager);
    return manager;
  }

  /** Map frame index to cell coordinates. */
  private _updateSpriteCell(inst: SpriteInstance): void {
    const meta = inst.meta;
    const frame = Math.min(inst.currentFrame, meta.frameCount - 1);

    let row: number;
    let col: number;

    if (meta.directional) {
      row = FACING_ROW_MAP[inst.facing] ?? 0;
      col = frame % meta.cols;
    } else {
      row = Math.floor(frame / meta.cols);
      col = frame % meta.cols;
    }

    row = Math.min(row, meta.rows - 1);
    col = Math.min(col, meta.cols - 1);

    inst.sprite.cellIndex = row * meta.cols + col;
  }

  /** Dispose all player resources. */
  dispose(): void {
    this._disposeCurrent();
    for (const manager of this._managers.values()) {
      manager.dispose();
    }
    this._managers.clear();
  }
}

// =============================================================================
// SECTION 6: VFX SPRITE MANAGER
// =============================================================================

/**
 * Lightweight manager for one-shot and looping visual effect sprites.
 * Uses object pooling for high-frequency spawn/despawn of blood splatters,
 * lightning arcs, bone explosions, etc.
 */
class VfxSpriteManager {
  private _scene: BABYLON.Scene;
  private _basePath: string;
  private _managers: Map<string, BABYLON.SpriteManager> = new Map();
  private _activeVfx: SpriteInstance[] = [];
  private _nextId = 0;
  private _timeScale = 1.0;

  constructor(scene: BABYLON.Scene, basePath: string) {
    this._scene = scene;
    this._basePath = basePath;
  }

  /**
   * Spawn a one-shot VFX at a world position.
   * @param key Registry key for the VFX sprite sheet.
   * @param position World-space spawn position.
   * @param size Billboard size in world units.
   * @param onComplete Optional callback when animation finishes.
   */
  spawnOneShot(
    key: string,
    position: BABYLON.Vector3,
    size: number = 3.0,
    onComplete?: () => void
  ): SpriteInstance | null {
    const meta = SPRITE_SHEET_REGISTRY[key];
    if (!meta) {
      console.warn(`[SpriteAnimator] Unknown VFX key: ${key}`);
      return null;
    }

    const manager = this._ensureManager(key, meta);
    const sprite = new BABYLON.Sprite(`vfx_${key}_${this._nextId++}`, manager);
    sprite.position.copyFrom(position);
    sprite.size = size;
    sprite.isVisible = true;

    const inst: SpriteInstance = {
      sprite,
      meta,
      currentFrame: 0,
      frameTimer: 0,
      frameIntervalMs: 1000 / meta.fps,
      flipped: false,
      state: key,
      facing: "S",
      velocity: BABYLON.Vector3.Zero(),
      isPooled: false,
      id: this._nextId++,
    };

    this._activeVfx.push(inst);
    this._updateSpriteCell(inst);
    return inst;
  }

  /** Spawn a looping ambient VFX (e.g., blood vortex, lava tile). */
  spawnLooping(
    key: string,
    position: BABYLON.Vector3,
    size: number = 3.0
  ): SpriteInstance | null {
    const inst = this.spawnOneShot(key, position, size);
    if (inst) {
      inst.meta = { ...inst.meta, loop: true };
    }
    return inst;
  }

  /** Update all active VFX sprites. */
  update(deltaMs: number): void {
    const scaledDelta = deltaMs * this._timeScale;
    const survivors: SpriteInstance[] = [];

    for (const inst of this._activeVfx) {
      inst.frameTimer += scaledDelta;
      if (inst.frameTimer >= inst.frameIntervalMs) {
        inst.frameTimer -= inst.frameIntervalMs;
        inst.currentFrame++;

        if (inst.currentFrame >= inst.meta.frameCount) {
          if (inst.meta.loop) {
            inst.currentFrame = 0;
          } else {
            // Animation complete — dispose
            inst.sprite.dispose();
            continue;
          }
        }
      }
      this._updateSpriteCell(inst);
      survivors.push(inst);
    }

    this._activeVfx = survivors;
  }

  /** Manually dispose a specific VFX instance. */
  disposeVfx(inst: SpriteInstance): void {
    inst.sprite.dispose();
    const idx = this._activeVfx.indexOf(inst);
    if (idx >= 0) this._activeVfx.splice(idx, 1);
  }

  set timeScale(value: number) {
    this._timeScale = value;
  }

  private _ensureManager(key: string, meta: SpriteSheetMeta): BABYLON.SpriteManager {
    if (this._managers.has(key)) return this._managers.get(key)!;

    const textureUrl = this._basePath + meta.url;
    const manager = new BABYLON.SpriteManager(
      `sm_vfx_${key}`,
      textureUrl,
      128, // High capacity for particle-like VFX
      { width: meta.cellWidth, height: meta.cellHeight },
      this._scene
    );
    manager.isPickable = false;
    manager.renderingGroupId = meta.layerPriority;
    this._managers.set(key, manager);
    return manager;
  }

  private _updateSpriteCell(inst: SpriteInstance): void {
    const meta = inst.meta;
    const frame = Math.min(inst.currentFrame, meta.frameCount - 1);
    const row = Math.min(Math.floor(frame / meta.cols), meta.rows - 1);
    const col = Math.min(frame % meta.cols, meta.cols - 1);
    inst.sprite.cellIndex = row * meta.cols + col;
  }

  dispose(): void {
    for (const inst of this._activeVfx) {
      inst.sprite.dispose();
    }
    this._activeVfx.length = 0;
    for (const manager of this._managers.values()) {
      manager.dispose();
    }
    this._managers.clear();
  }
}

// =============================================================================
// SECTION 7: MAIN CONTROLLER — SpriteAnimationController
// =============================================================================

/**
 * Central orchestrator for all billboard sprite animation in the game.
 *
 * Responsibilities:
 *   • Owns and manages all BABYLON.SpriteManager layers.
 *   • Drives the player animation state machine.
 *   • Maintains the enemy object pool.
 *   • Provides the public `createEnemyBillboard` factory.
 *   • Handles per-frame updates for all sprite instances.
 *   • Manages global time-scale and layer priorities.
 */
export class SpriteAnimationController {
  private _scene: BABYLON.Scene;
  private _config: Required<SpriteAnimatorConfig>;
  private _player: PlayerSpriteStateMachine;
  private _enemyPool: EnemySpritePool;
  private _vfxManager: VfxSpriteManager;
  private _lastTime = 0;
  private _isDisposed = false;

  /** Observable fired when an enemy animation completes (non-looping). */
  public onEnemyAnimComplete = new BABYLON.Observable<{
    instance: SpriteInstance;
    state: EnemyAnimState;
  }>();

  constructor(config: SpriteAnimatorConfig) {
    this._scene = config.scene;
    this._config = {
      scene: config.scene,
      assetBasePath: config.assetBasePath ?? "",
      maxPlayerSprites: config.maxPlayerSprites ?? 4,
      maxEnemySprites: config.maxEnemySprites ?? 500,
      maxVfxSprites: config.maxVfxSprites ?? 256,
      timeScale: config.timeScale ?? 1.0,
    };

    // Initialize player state machine
    this._player = new PlayerSpriteStateMachine(
      this._scene,
      this._config.assetBasePath
    );
    this._player.initialize();
    this._player.timeScale = this._config.timeScale;

    // Initialize enemy object pool
    this._enemyPool = new EnemySpritePool(
      this._scene,
      SPRITE_SHEET_REGISTRY.skeleton_walk,
      this._config.maxEnemySprites,
      this._config.assetBasePath
    );

    // Initialize VFX manager
    this._vfxManager = new VfxSpriteManager(
      this._scene,
      this._config.assetBasePath
    );
    this._vfxManager.timeScale = this._config.timeScale;

    // Hook into Babylon's render loop
    this._scene.onBeforeRenderObservable.add(this._onBeforeRender);
  }

  // ===========================================================================
  // PUBLIC API: Player Controls
  // ===========================================================================

  /** Set the player's world position. */
  setPlayerPosition(position: BABYLON.Vector3): void {
    this._player.setPosition(position);
  }

  /** Feed velocity to the player state machine (triggers idle/run transitions). */
  setPlayerVelocity(velocity: BABYLON.Vector3): void {
    this._player.setVelocity(velocity);
  }

  /** Force the player into the death state. */
  killPlayer(): void {
    this._player.setState("death");
  }

  /** Get the player's current animation state. */
  get playerState(): PlayerAnimState {
    return this._player.currentState;
  }

  // ===========================================================================
  // PUBLIC API: Enemy Factory
  // ===========================================================================

  /**
   * Factory method: instantiate an individual enemy billboard from the
   * centralized manager pool and play its walking loop with a randomized
   * frame speed offset to break visual uniformity.
   *
   * @param position World-space spawn position.
   * @returns The pooled SpriteInstance, or null if pool is exhausted.
   */
  createEnemyBillboard(position: BABYLON.Vector3): SpriteInstance | null {
    const instance = this._enemyPool.acquire(position, 0.25);
    if (!instance) {
      console.warn(
        `[SpriteAnimator] Enemy pool exhausted (${this._config.maxEnemySprites} max).`
      );
    }
    return instance;
  }

  /** Release an enemy sprite back to the pool. */
  releaseEnemy(instance: SpriteInstance): void {
    this._enemyPool.release(instance);
  }

  /** Get the number of active enemy sprites. */
  get activeEnemyCount(): number {
    return this._enemyPool.activeCount;
  }

  /** Get the number of available enemy slots in the pool. */
  get availableEnemyCount(): number {
    return this._enemyPool.availableCount;
  }

  // ===========================================================================
  // PUBLIC API: Batch Enemy Updates
  // ===========================================================================

  /**
   * Batch-update velocities for all active enemies. Used by the AI/physics
   * system to feed movement data into the sprite animator each frame.
   *
   * @param updates Array of { id, velocity } tuples. Only updates matching IDs.
   */
  batchUpdateEnemyVelocities(
    updates: Array<{ id: number; velocity: BABYLON.Vector3 }>
  ): void {
    const updateMap = new Map(updates.map((u) => [u.id, u.velocity]));
    for (const inst of this._enemyPool.active) {
      const vel = updateMap.get(inst.id);
      if (vel) {
        inst.velocity.copyFrom(vel);
      }
    }
  }

  /**
   * Batch-update positions for all active enemies. Useful when the physics
   * engine drives movement and the animator only handles visuals.
   */
  batchUpdateEnemyPositions(
    updates: Array<{ id: number; position: BABYLON.Vector3 }>
  ): void {
    const updateMap = new Map(updates.map((u) => [u.id, u.position]));
    for (const inst of this._enemyPool.active) {
      const pos = updateMap.get(inst.id);
      if (pos) {
        inst.sprite.position.copyFrom(pos);
        inst.sprite.position.y = 1.0;
      }
    }
  }

  // ===========================================================================
  // PUBLIC API: VFX Spawning
  // ===========================================================================

  /** Spawn a one-shot VFX (e.g., bone explosion on enemy death). */
  spawnVfx(
    key: string,
    position: BABYLON.Vector3,
    size?: number
  ): SpriteInstance | null {
    return this._vfxManager.spawnOneShot(key, position, size);
  }

  /** Spawn a looping ambient VFX (e.g., blood vortex). */
  spawnAmbientVfx(
    key: string,
    position: BABYLON.Vector3,
    size?: number
  ): SpriteInstance | null {
    return this._vfxManager.spawnLooping(key, position, size);
  }

  /** Dispose a specific VFX instance early. */
  disposeVfx(inst: SpriteInstance): void {
    this._vfxManager.disposeVfx(inst);
  }

  // ===========================================================================
  // PUBLIC API: Global Controls
  // ===========================================================================

  /** Set global time scale (affects all animations). */
  setTimeScale(scale: number): void {
    this._config.timeScale = scale;
    this._player.timeScale = scale;
    this._vfxManager.timeScale = scale;
  }

  /** Pause all sprite animations. */
  pause(): void {
    this.setTimeScale(0);
  }

  /** Resume all sprite animations. */
  resume(): void {
    this.setTimeScale(1);
  }

  // ===========================================================================
  // INTERNAL: Render Loop Hook
  // ===========================================================================

  private _onBeforeRender = (): void => {
    if (this._isDisposed) return;

    const now = performance.now();
    const deltaMs = this._lastTime === 0 ? 16.667 : now - this._lastTime;
    this._lastTime = now;

    // Cap delta to prevent spiral-of-death on lag spikes
    const clampedDelta = Math.min(deltaMs, 100);

    // Update player
    this._player.update(clampedDelta);

    // Update all pooled enemies
    this._enemyPool.update(clampedDelta, this._config.timeScale);

    // Update VFX
    this._vfxManager.update(clampedDelta);
  };

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /** Dispose all resources, managers, and sprites. */
  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this._scene.onBeforeRenderObservable.removeCallback(this._onBeforeRender);
    this._player.dispose();
    this._enemyPool.dispose();
    this._vfxManager.dispose();
    this.onEnemyAnimComplete.clear();
  }
}

// =============================================================================
// SECTION 8: EXPORTS
// =============================================================================

export { SpriteInstance, EnemyAnimState, FacingDirection };
export { SPRITE_SHEET_REGISTRY };
