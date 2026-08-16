/**
 * DestructibleObjectPooler.ts
 * ---------------------------------------------------------------------------
 * Manages the complete lifecycle of interactive destructible props scattered
 * across Layer 1 & 2 tile matrices (barrels, chests, jars). Handles collision
 * detection, durability degradation, sprite-sheet driven break animations,
 * debris particle meshes, and item-drop spawning with player-magnet physics.
 *
 * Architecture: ES6 modular class with internal object-pool subsystems.
 * Dependencies: Babylon.js scene, sprite atlas (decor_props.png), player ref.
 */

import {
  Scene,
  Vector3,
  Mesh,
  TransformNode,
  Sprite,
  SpriteManager,
  AbstractMesh,
  BoundingBox,
  Animation,
  AnimationEvent,
  StandardMaterial,
  Texture,
  ParticleSystem,
  Color4,
  MeshBuilder,
  Matrix,
  Quaternion,
} from "@babylonjs/core";

// ---------------------------------------------------------------------------
// Type Definitions
// ---------------------------------------------------------------------------

export type PropType = "barrel" | "chest" | "jar";

export interface PropConfig {
  type: PropType;
  /** Unique key prefix for this prop archetype */
  keyPrefix: string;
  /** Collision radius in world units */
  collisionRadius: number;
  /** Max structural durability (HP) */
  maxDurability: number;
  /** Sprite atlas cell index for intact state [x, y, w, h] in UV space 0..1 */
  intactUV: [number, number, number, number];
  /** Array of sprite atlas cell indices for break animation frames */
  breakFramesUV: Array<[number, number, number, number]>;
  /** Number of debris shards to spawn on destruction */
  debrisCount: number;
  /** Debris UV cell in sprite sheet */
  debrisUV: [number, number, number, number];
  /** Drop table: item type -> weight */
  dropTable: Map<DropType, number>;
  /** Base probability (0..1) that ANY drop occurs */
  dropChance: number;
}

export type DropType = "gold_gem" | "health_potion" | "none";

export interface DestructibleProp {
  /** Unique runtime tracking key: "{prefix}_{tileX}_{tileY}_{instanceId}" */
  trackingKey: string;
  /** Logical tile coordinates on the layer matrix */
  tileX: number;
  tileY: number;
  /** World-space position */
  position: Vector3;
  /** Prop archetype configuration reference */
  config: PropConfig;
  /** Current structural durability */
  durability: number;
  /** Is this prop currently alive (not destroyed) */
  isAlive: boolean;
  /** Is this prop currently playing break animation */
  isBreaking: boolean;
  /** Babylon transform node (parent for mesh + sprite) */
  transform: TransformNode;
  /** The visible sprite for intact state */
  sprite: Sprite | null;
  /** Array of debris mesh instances if already spawned */
  debrisMeshes: Mesh[];
  /** Internal pool index for O(1) recycle */
  poolIndex: number;
}

export interface DroppedItem {
  /** Unique tracking key */
  trackingKey: string;
  /** Drop type */
  type: Exclude<DropType, "none">;
  /** World position */
  position: Vector3;
  /** Velocity vector */
  velocity: Vector3;
  /** Is currently being magnet-attracted to player */
  isMagnetized: boolean;
  /** Babylon mesh / sprite reference */
  visual: Sprite | Mesh;
  /** Lifetime accumulator for bobbing animation */
  lifeTime: number;
  /** Has been collected */
  isCollected: boolean;
}

export interface WeaponHitEvent {
  /** World-space origin of the weapon collision zone */
  origin: Vector3;
  /** Radius of the weapon collision zone */
  radius: number;
  /** Damage to apply to prop durability */
  damage: number;
  /** Normalized direction vector of the hit (for debris impulse) */
  direction: Vector3;
}

export interface PlayerState {
  position: Vector3;
  magnetRadius: number;
  magnetStrength: number;
  /** Called when player collects an item */
  onCollect: (item: DroppedItem) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROP_POOL_CAPACITY = 512;
const DROP_POOL_CAPACITY = 256;
const DEBRIS_LIFETIME_MS = 3000;
const DEBRIS_FADE_START_MS = 2000;
const ITEM_BOB_AMPLITUDE = 0.15;
const ITEM_BOB_FREQUENCY = 3.0;
const ITEM_MAGNET_ACCEL = 18.0;
const ITEM_MAX_MAGNET_SPEED = 12.0;
const ITEM_FRICTION = 0.92;
const ITEM_COLLECT_RADIUS = 0.6;

// ---------------------------------------------------------------------------
// Sprite Atlas Slicer Helper
// ---------------------------------------------------------------------------

/**
 * Computes UV coordinates for a cell in a uniform sprite grid atlas.
 * @param col Zero-based column index
 * @param row Zero-based row index
 * @param cols Total columns in the atlas
 * @param rows Total rows in the atlas
 * @returns UV tuple [u1, v1, u2, v2]
 */
export function sliceAtlasCell(
  col: number,
  row: number,
  cols: number,
  rows: number
): [number, number, number, number] {
  const cellW = 1 / cols;
  const cellH = 1 / rows;
  const u1 = col * cellW;
  const v1 = 1 - (row + 1) * cellH; // flip V for Babylon
  const u2 = u1 + cellW;
  const v2 = v1 + cellH;
  return [u1, v1, u2, v2];
}

// ---------------------------------------------------------------------------
// DestructibleObjectPooler
// ---------------------------------------------------------------------------

export class DestructibleObjectPooler {
  private scene: Scene;
  private spriteManager: SpriteManager;
  private decorTexture: Texture;

  /** Active prop lookup by tracking key */
  private activeProps: Map<string, DestructibleProp> = new Map();
  /** Spatial index: layer -> tileKey -> propKey (for fast tile queries) */
  private spatialIndex: Map<number, Map<string, string>> = new Map();

  /** Object pool: pre-allocated prop slots */
  private propPool: DestructibleProp[] = [];
  /** Index of next free slot in propPool (stack pointer) */
  private freePropStack: number[] = [];

  /** Drop object pool */
  private dropPool: DroppedItem[] = [];
  private freeDropStack: number[] = [];
  private activeDrops: Map<string, DroppedItem> = new Map();

  /** Debris mesh pool (instanced boxes mapped by prop type) */
  private debrisPools: Map<PropType, Mesh[]> = new Map();
  private freeDebrisStacks: Map<PropType, number[]> = new Map();

  /** Registered prop archetypes */
  private propConfigs: Map<PropType, PropConfig> = new Map();

  /** Player reference for magnet logic */
  private player: PlayerState | null = null;

  /** Global instance counter for unique keys */
  private instanceCounter = 0;

  /** Particle system template for break bursts */
  private breakParticleTemplate: ParticleSystem | null = null;

  constructor(scene: Scene, decorTexturePath: string, atlasCols: number, atlasRows: number) {
    this.scene = scene;

    // Initialize sprite manager for props (cell size = 64x64 default)
    this.decorTexture = new Texture(decorTexturePath, scene);
    this.spriteManager = new SpriteManager(
      "destructibleSpriteMgr",
      decorTexturePath,
      PROP_POOL_CAPACITY + DROP_POOL_CAPACITY,
      { width: 64, height: 64 },
      scene
    );
    this.spriteManager.isPickable = false;

    // Pre-allocate prop pool
    for (let i = 0; i < PROP_POOL_CAPACITY; i++) {
      const transform = new TransformNode(`prop_transform_${i}`, scene);
      transform.setEnabled(false);

      const prop: DestructibleProp = {
        trackingKey: "",
        tileX: -1,
        tileY: -1,
        position: Vector3.Zero(),
        config: null as unknown as PropConfig,
        durability: 0,
        isAlive: false,
        isBreaking: false,
        transform,
        sprite: null,
        debrisMeshes: [],
        poolIndex: i,
      };
      this.propPool.push(prop);
      this.freePropStack.push(i);
    }

    // Pre-allocate drop pool
    for (let i = 0; i < DROP_POOL_CAPACITY; i++) {
      const drop: DroppedItem = {
        trackingKey: "",
        type: "gold_gem",
        position: Vector3.Zero(),
        velocity: Vector3.Zero(),
        isMagnetized: false,
        visual: null as unknown as Sprite,
        lifeTime: 0,
        isCollected: false,
      };
      this.dropPool.push(drop);
      this.freeDropStack.push(i);
    }

    // Initialize spatial indices for Layer 1 & 2
    this.spatialIndex.set(1, new Map());
    this.spatialIndex.set(2, new Map());

    // Initialize debris pools per prop type
    this.initDebrisPools();

    // Build particle template
    this.initBreakParticles();

    // Register default configs
    this.registerDefaultConfigs(atlasCols, atlasRows);
  }

  // -------------------------------------------------------------------------
  // Configuration Registration
  // -------------------------------------------------------------------------

  /**
   * Register a prop archetype configuration.
   */
  registerPropConfig(config: PropConfig): void {
    this.propConfigs.set(config.type, config);
  }

  private registerDefaultConfigs(cols: number, rows: number): void {
    // Barrel: row 0, col 0 intact; row 0, col 1-3 break frames; row 1, col 0 debris
    const barrelBreak: Array<[number, number, number, number]> = [];
    for (let c = 1; c <= 3; c++) {
      barrelBreak.push(sliceAtlasCell(c, 0, cols, rows));
    }

    this.registerPropConfig({
      type: "barrel",
      keyPrefix: "barrel",
      collisionRadius: 0.35,
      maxDurability: 1,
      intactUV: sliceAtlasCell(0, 0, cols, rows),
      breakFramesUV: barrelBreak,
      debrisCount: 6,
      debrisUV: sliceAtlasCell(0, 1, cols, rows),
      dropTable: new Map([
        ["gold_gem", 70],
        ["health_potion", 15],
        ["none", 15],
      ]),
      dropChance: 0.45,
    });

    // Chest: row 1, col 1 intact; row 1, col 2-4 break frames; row 2, col 0 debris
    const chestBreak: Array<[number, number, number, number]> = [];
    for (let c = 2; c <= 4; c++) {
      chestBreak.push(sliceAtlasCell(c, 1, cols, rows));
    }

    this.registerPropConfig({
      type: "chest",
      keyPrefix: "chest",
      collisionRadius: 0.45,
      maxDurability: 2,
      intactUV: sliceAtlasCell(1, 1, cols, rows),
      breakFramesUV: chestBreak,
      debrisCount: 10,
      debrisUV: sliceAtlasCell(0, 2, cols, rows),
      dropTable: new Map([
        ["gold_gem", 80],
        ["health_potion", 20],
      ]),
      dropChance: 0.85,
    });

    // Jar: row 2, col 1 intact; row 2, col 2-3 break frames; row 2, col 4 debris
    const jarBreak: Array<[number, number, number, number]> = [];
    for (let c = 2; c <= 3; c++) {
      jarBreak.push(sliceAtlasCell(c, 2, cols, rows));
    }

    this.registerPropConfig({
      type: "jar",
      keyPrefix: "jar",
      collisionRadius: 0.25,
      maxDurability: 1,
      intactUV: sliceAtlasCell(1, 2, cols, rows),
      breakFramesUV: jarBreak,
      debrisCount: 4,
      debrisUV: sliceAtlasCell(4, 2, cols, rows),
      dropTable: new Map([
        ["gold_gem", 40],
        ["health_potion", 10],
        ["none", 50],
      ]),
      dropChance: 0.3,
    });
  }

  // -------------------------------------------------------------------------
  // Debris Pool Initialization
  // -------------------------------------------------------------------------

  private initDebrisPools(): void {
    const types: PropType[] = ["barrel", "chest", "jar"];
    for (const type of types) {
      const pool: Mesh[] = [];
      const freeStack: number[] = [];
      // Pre-build 64 debris meshes per type (box planes with sprite texture)
      for (let i = 0; i < 64; i++) {
        const debris = MeshBuilder.CreatePlane(
          `debris_${type}_${i}`,
          { size: 0.15 },
          this.scene
        );
        debris.billboardMode = Mesh.BILLBOARDMODE_ALL;
        debris.isVisible = false;
        debris.setEnabled(false);

        const mat = new StandardMaterial(`debrisMat_${type}_${i}`, this.scene);
        mat.diffuseTexture = this.decorTexture;
        mat.diffuseTexture.hasAlpha = true;
        mat.useAlphaFromDiffuseTexture = true;
        mat.backFaceCulling = false;
        mat.specularColor.set(0, 0, 0);
        debris.material = mat;

        pool.push(debris);
        freeStack.push(i);
      }
      this.debrisPools.set(type, pool);
      this.freeDebrisStacks.set(type, freeStack);
    }
  }

  // -------------------------------------------------------------------------
  // Particle System
  // -------------------------------------------------------------------------

  private initBreakParticles(): void {
    const ps = new ParticleSystem("breakParticles", 200, this.scene);
    ps.particleTexture = this.decorTexture;
    ps.emitter = Vector3.Zero();
    ps.minEmitBox = new Vector3(-0.2, 0, -0.2);
    ps.maxEmitBox = new Vector3(0.2, 0.3, 0.2);
    ps.color1 = new Color4(0.6, 0.5, 0.3, 1.0);
    ps.color2 = new Color4(0.4, 0.3, 0.2, 1.0);
    ps.colorDead = new Color4(0.2, 0.15, 0.1, 0.0);
    ps.minSize = 0.05;
    ps.maxSize = 0.12;
    ps.minLifeTime = 0.3;
    ps.maxLifeTime = 0.8;
    ps.emitRate = 0;
    ps.blendMode = ParticleSystem.BLENDMODE_ONEONE;
    ps.gravity = new Vector3(0, -6, 0);
    ps.direction1 = new Vector3(-2, 3, -2);
    ps.direction2 = new Vector3(2, 5, 2);
    ps.minAngularSpeed = 0;
    ps.maxAngularSpeed = Math.PI;
    ps.minEmitPower = 1.5;
    ps.maxEmitPower = 4.0;
    ps.updateSpeed = 0.02;
    ps.targetStopDuration = 0.5;

    this.breakParticleTemplate = ps;
  }

  // -------------------------------------------------------------------------
  // Player Binding
  // -------------------------------------------------------------------------

  setPlayer(player: PlayerState): void {
    this.player = player;
  }

  // -------------------------------------------------------------------------
  // Prop Spawning API
  // -------------------------------------------------------------------------

  /**
   * Spawn a destructible prop onto a tile matrix layer.
   * @param type Prop archetype
   * @param layer 1 or 2
   * @param tileX Tile column
   * @param tileY Tile row
   * @param worldPos World-space position to place the prop
   * @returns The tracking key, or null if pool exhausted
   */
  spawnProp(
    type: PropType,
    layer: number,
    tileX: number,
    tileY: number,
    worldPos: Vector3
  ): string | null {
    const config = this.propConfigs.get(type);
    if (!config) {
      console.warn(`[DestructibleObjectPooler] Unknown prop type: ${type}`);
      return null;
    }

    if (this.freePropStack.length === 0) {
      console.warn("[DestructibleObjectPooler] Prop pool exhausted!");
      return null;
    }

    // Acquire from pool
    const poolIdx = this.freePropStack.pop()!;
    const prop = this.propPool[poolIdx];

    // Build unique tracking key
    const instanceId = this.instanceCounter++;
    const trackingKey = `${config.keyPrefix}_${tileX}_${tileY}_${instanceId}`;

    // Initialize prop state
    prop.trackingKey = trackingKey;
    prop.tileX = tileX;
    prop.tileY = tileY;
    prop.position.copyFrom(worldPos);
    prop.config = config;
    prop.durability = config.maxDurability;
    prop.isAlive = true;
    prop.isBreaking = false;
    prop.debrisMeshes = [];

    // Activate transform
    prop.transform.setEnabled(true);
    prop.transform.position.copyFrom(worldPos);

    // Create / recycle sprite
    if (!prop.sprite) {
      prop.sprite = new Sprite(`sprite_${trackingKey}`, this.spriteManager);
      prop.sprite.size = 1.0;
      prop.sprite.isVisible = false;
    }
    prop.sprite.isVisible = true;
    prop.sprite.position.copyFrom(worldPos);
    prop.sprite.position.y += 0.5; // sit on top of tile
    prop.sprite.cellIndex = this.uvToCellIndex(config.intactUV);

    // Register in lookups
    this.activeProps.set(trackingKey, prop);
    const layerMap = this.spatialIndex.get(layer);
    if (layerMap) {
      layerMap.set(`${tileX},${tileY}`, trackingKey);
    }

    return trackingKey;
  }

  /**
   * Batch spawn props from a tile matrix descriptor.
   * @param layer Layer number (1 or 2)
   * @param matrix 2D array where non-null values are PropType strings
   * @param tileToWorldFn Callback (tileX, tileY) => Vector3 world position
   */
  spawnFromMatrix(
    layer: number,
    matrix: (PropType | null)[][],
    tileToWorldFn: (tx: number, ty: number) => Vector3
  ): string[] {
    const keys: string[] = [];
    for (let y = 0; y < matrix.length; y++) {
      const row = matrix[y];
      for (let x = 0; x < row.length; x++) {
        const type = row[x];
        if (type) {
          const key = this.spawnProp(type, layer, x, y, tileToWorldFn(x, y));
          if (key) keys.push(key);
        }
      }
    }
    return keys;
  }

  // -------------------------------------------------------------------------
  // Weapon Collision / Breaking Pipeline
  // -------------------------------------------------------------------------

  /**
   * Process a weapon hit event against all active props within the hit zone.
   * Returns array of tracking keys for props that were destroyed.
   */
  processWeaponHit(hit: WeaponHitEvent): string[] {
    const destroyedKeys: string[] = [];

    for (const prop of this.activeProps.values()) {
      if (!prop.isAlive || prop.isBreaking) continue;

      const dist = Vector3.Distance(hit.origin, prop.position);
      if (dist <= hit.radius + prop.config.collisionRadius) {
        const destroyed = this.applyDamage(prop, hit.damage, hit.direction);
        if (destroyed) {
          destroyedKeys.push(prop.trackingKey);
        }
      }
    }

    return destroyedKeys;
  }

  /**
   * Apply durability damage to a single prop. Returns true if destroyed.
   */
  private applyDamage(
    prop: DestructibleProp,
    damage: number,
    hitDirection: Vector3
  ): boolean {
    prop.durability -= damage;

    if (prop.durability <= 0) {
      this.executeBreak(prop, hitDirection);
      return true;
    }

    // Visual feedback: brief flash / wobble on intact sprite
    this.playDamageWobble(prop);
    return false;
  }

  /**
   * Execute the full break sequence: animation -> debris -> drops -> cleanup.
   */
  private executeBreak(prop: DestructibleProp, hitDirection: Vector3): void {
    prop.isAlive = false;
    prop.isBreaking = true;

    // 1. Play sequential break animation on sprite
    this.playBreakAnimation(prop, () => {
      // 2. Hide sprite after animation
      if (prop.sprite) {
        prop.sprite.isVisible = false;
      }

      // 3. Spawn debris meshes
      this.spawnDebris(prop, hitDirection);

      // 4. Burst particles
      this.emitBreakParticles(prop.position);

      // 5. Roll item drop
      this.rollItemDrop(prop);

      // 6. Mark for full recycle (debris lives on for a few seconds)
      this.schedulePropRecycle(prop, DEBRIS_LIFETIME_MS);
    });
  }

  /**
   * Animate through break frames at fixed timestep.
   */
  private playBreakAnimation(prop: DestructibleProp, onComplete: () => void): void {
    const frames = prop.config.breakFramesUV;
    if (frames.length === 0) {
      onComplete();
      return;
    }

    let frameIdx = 0;
    const frameTimeMs = 80; // 80ms per frame

    const advanceFrame = () => {
      if (!prop.sprite) return;
      if (frameIdx < frames.length) {
        prop.sprite.cellIndex = this.uvToCellIndex(frames[frameIdx]);
        frameIdx++;
        setTimeout(advanceFrame, frameTimeMs);
      } else {
        onComplete();
      }
    };

    advanceFrame();
  }

  private playDamageWobble(prop: DestructibleProp): void {
    if (!prop.sprite) return;
    // Simple scale punch using Babylon animation
    const anim = new Animation(
      "wobble",
      "width",
      60,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CONSTANT
    );
    const keys = [
      { frame: 0, value: prop.sprite.width },
      { frame: 5, value: prop.sprite.width * 1.2 },
      { frame: 10, value: prop.sprite.width },
    ];
    anim.setKeys(keys);
    this.scene.beginDirectAnimation(prop.sprite as unknown as Mesh, [anim], 0, 10, false);
  }

  // -------------------------------------------------------------------------
  // Debris System
  // -------------------------------------------------------------------------

  private spawnDebris(prop: DestructibleProp, hitDirection: Vector3): void {
    const pool = this.debrisPools.get(prop.config.type);
    const freeStack = this.freeDebrisStacks.get(prop.config.type);
    if (!pool || !freeStack) return;

    const count = Math.min(prop.config.debrisCount, freeStack.length);
    const debrisUV = prop.config.debrisUV;

    for (let i = 0; i < count; i++) {
      if (freeStack.length === 0) break;

      const debrisIdx = freeStack.pop()!;
      const debris = pool[debrisIdx];

      // Random scatter position around prop
      const offset = new Vector3(
        (Math.random() - 0.5) * 0.6,
        0.2 + Math.random() * 0.4,
        (Math.random() - 0.5) * 0.6
      );
      debris.position.copyFrom(prop.position).addInPlace(offset);
      debris.isVisible = true;
      debris.setEnabled(true);

      // Set UV from sprite sheet
      const mat = debris.material as StandardMaterial;
      const tex = mat.diffuseTexture as Texture;
      tex.uScale = debrisUV[2] - debrisUV[0];
      tex.vScale = debrisUV[3] - debrisUV[1];
      tex.uOffset = debrisUV[0];
      tex.vOffset = debrisUV[1];

      // Physics-like impulse: outward from hit + upward arc
      const impulse = hitDirection
        .normalize()
        .scale(1.5 + Math.random() * 2.5)
        .add(new Vector3((Math.random() - 0.5) * 2, 2 + Math.random() * 3, (Math.random() - 0.5) * 2));

      // Animate debris: simple gravity arc + rotation
      this.animateDebris(debris, impulse, prop.config.type, debrisIdx);

      prop.debrisMeshes.push(debris);
    }
  }

  private animateDebris(
    debris: Mesh,
    velocity: Vector3,
    type: PropType,
    debrisIdx: number
  ): void {
    const startPos = debris.position.clone();
    const gravity = new Vector3(0, -9.8, 0);
    let time = 0;
    const dt = 0.016;
    const rotSpeed = new Vector3(
      Math.random() * 5,
      Math.random() * 5,
      Math.random() * 5
    );

    const obs = this.scene.onBeforeRenderObservable.add(() => {
      time += dt;

      // Integrate velocity
      velocity.addInPlace(gravity.scale(dt));
      debris.position.addInPlace(velocity.scale(dt));

      // Rotate
      debris.rotation.x += rotSpeed.x * dt;
      debris.rotation.y += rotSpeed.y * dt;
      debris.rotation.z += rotSpeed.z * dt;

      // Floor collision (simple)
      if (debris.position.y <= startPos.y - 0.3) {
        debris.position.y = startPos.y - 0.3;
        velocity.y *= -0.3; // bounce dampen
        velocity.x *= 0.8;
        velocity.z *= 0.8;
      }

      // Fade out near end of life
      if (time > DEBRIS_FADE_START_MS / 1000) {
        const mat = debris.material as StandardMaterial;
        const alpha = Math.max(0, 1 - (time - DEBRIS_FADE_START_MS / 1000) / ((DEBRIS_LIFETIME_MS - DEBRIS_FADE_START_MS) / 1000));
        mat.alpha = alpha;
      }

      // End of life
      if (time >= DEBRIS_LIFETIME_MS / 1000) {
        this.scene.onBeforeRenderObservable.remove(obs);
        debris.isVisible = false;
        debris.setEnabled(false);
        const freeStack = this.freeDebrisStacks.get(type);
        if (freeStack) freeStack.push(debrisIdx);
      }
    });
  }

  private emitBreakParticles(position: Vector3): void {
    if (!this.breakParticleTemplate) return;

    // Clone template for one-shot burst
    const burst = this.breakParticleTemplate.clone();
    burst.emitter = position.clone();
    burst.emitRate = 60;
    burst.start();

    setTimeout(() => {
      burst.stop();
      burst.dispose();
    }, 600);
  }

  // -------------------------------------------------------------------------
  // Item Drop System
  // -------------------------------------------------------------------------

  private rollItemDrop(prop: DestructibleProp): void {
    if (Math.random() > prop.config.dropChance) return;

    // Weighted random from drop table
    const table = prop.config.dropTable;
    let totalWeight = 0;
    for (const weight of table.values()) {
      totalWeight += weight;
    }

    let roll = Math.random() * totalWeight;
    let selected: DropType = "none";
    for (const [dropType, weight] of table.entries()) {
      roll -= weight;
      if (roll <= 0) {
        selected = dropType;
        break;
      }
    }

    if (selected === "none") return;

    this.spawnDrop(selected, prop.position.clone());
  }

  /**
   * Spawn a dropped item at a world position.
   */
  spawnDrop(type: Exclude<DropType, "none">, position: Vector3): string | null {
    if (this.freeDropStack.length === 0) {
      console.warn("[DestructibleObjectPooler] Drop pool exhausted!");
      return null;
    }

    const poolIdx = this.freeDropStack.pop()!;
    const drop = this.dropPool[poolIdx];

    const instanceId = this.instanceCounter++;
    const trackingKey = `drop_${type}_${instanceId}`;

    drop.trackingKey = trackingKey;
    drop.type = type;
    drop.position.copyFrom(position);
    drop.position.y += 0.5;
    drop.velocity.set(0, 0, 0);
    drop.isMagnetized = false;
    drop.lifeTime = 0;
    drop.isCollected = false;

    // Create / recycle visual
    if (!drop.visual || drop.visual.isDisposed()) {
      const sprite = new Sprite(`dropSprite_${trackingKey}`, this.spriteManager);
      sprite.size = 0.6;
      drop.visual = sprite;
    }
    const sprite = drop.visual as Sprite;
    sprite.isVisible = true;
    sprite.position.copyFrom(drop.position);

    // Assign cell index based on drop type
    sprite.cellIndex = type === "gold_gem" ? 30 : 31; // assumed atlas cells

    this.activeDrops.set(trackingKey, drop);
    return trackingKey;
  }

  // -------------------------------------------------------------------------
  // Drop Update Loop (Magnet Physics)
  // -------------------------------------------------------------------------

  /**
   * Must be called every frame/tick from the main game loop.
   * @param deltaTime Seconds since last frame
   */
  update(deltaTime: number): void {
    if (!this.player) return;

    const playerPos = this.player.position;

    for (const drop of this.activeDrops.values()) {
      if (drop.isCollected) continue;

      drop.lifeTime += deltaTime;

      // Bobbing animation
      const bobOffset = Math.sin(drop.lifeTime * ITEM_BOB_FREQUENCY) * ITEM_BOB_AMPLITUDE;
      drop.visual.position.y = drop.position.y + bobOffset;

      // Magnet check
      const distToPlayer = Vector3.Distance(drop.position, playerPos);

      if (distToPlayer <= this.player.magnetRadius) {
        drop.isMagnetized = true;
      }

      if (drop.isMagnetized) {
        // Attraction vector
        const toPlayer = playerPos.subtract(drop.position).normalize();
        drop.velocity.addInPlace(toPlayer.scale(ITEM_MAGNET_ACCEL * deltaTime));

        // Clamp speed
        if (drop.velocity.length() > ITEM_MAX_MAGNET_SPEED) {
          drop.velocity.normalize().scaleInPlace(ITEM_MAX_MAGNET_SPEED);
        }
      } else {
        // Friction when not magnetized
        drop.velocity.scaleInPlace(ITEM_FRICTION);
      }

      // Integrate position
      drop.position.addInPlace(drop.velocity.scale(deltaTime));
      drop.visual.position.x = drop.position.x;
      drop.visual.position.z = drop.position.z;

      // Collection check
      if (distToPlayer <= ITEM_COLLECT_RADIUS) {
        this.collectDrop(drop);
      }
    }
  }

  private collectDrop(drop: DroppedItem): void {
    drop.isCollected = true;
    drop.visual.isVisible = false;

    if (this.player) {
      this.player.onCollect(drop);
    }

    // Return to pool after brief delay (allow pickup FX)
    setTimeout(() => {
      this.activeDrops.delete(drop.trackingKey);
      this.freeDropStack.push((drop as any).poolIndex ?? 0);
    }, 50);
  }

  // -------------------------------------------------------------------------
  // Query API
  // -------------------------------------------------------------------------

  getPropByKey(key: string): DestructibleProp | undefined {
    return this.activeProps.get(key);
  }

  getPropAtTile(layer: number, tileX: number, tileY: number): DestructibleProp | undefined {
    const layerMap = this.spatialIndex.get(layer);
    if (!layerMap) return undefined;
    const key = layerMap.get(`${tileX},${tileY}`);
    if (!key) return undefined;
    return this.activeProps.get(key);
  }

  getActivePropCount(): number {
    return this.activeProps.size;
  }

  getActiveDropCount(): number {
    return this.activeDrops.size;
  }

  // -------------------------------------------------------------------------
  // Cleanup & Pooling
  // -------------------------------------------------------------------------

  private schedulePropRecycle(prop: DestructibleProp, delayMs: number): void {
    setTimeout(() => {
      this.recycleProp(prop);
    }, delayMs);
  }

  private recycleProp(prop: DestructibleProp): void {
    // Remove from lookups
    this.activeProps.delete(prop.trackingKey);

    // Remove from spatial index (scan both layers)
    for (const layerMap of this.spatialIndex.values()) {
      const key = `${prop.tileX},${prop.tileY}`;
      if (layerMap.get(key) === prop.trackingKey) {
        layerMap.delete(key);
      }
    }

    // Disable transform
    prop.transform.setEnabled(false);

    // Hide sprite but keep reference
    if (prop.sprite) {
      prop.sprite.isVisible = false;
    }

    // Return debris meshes to their pools
    for (const debris of prop.debrisMeshes) {
      debris.isVisible = false;
      debris.setEnabled(false);
      // Find type and return index (debris name encodes it)
      const match = debris.name.match(/debris_(\w+)_\d+/);
      if (match) {
        const type = match[1] as PropType;
        const pool = this.debrisPools.get(type);
        if (pool) {
          const idx = pool.indexOf(debris);
          if (idx >= 0) {
            const freeStack = this.freeDebrisStacks.get(type);
            if (freeStack && !freeStack.includes(idx)) {
              freeStack.push(idx);
            }
          }
        }
      }
    }
    prop.debrisMeshes = [];

    // Reset state
    prop.isAlive = false;
    prop.isBreaking = false;
    prop.durability = 0;
    prop.trackingKey = "";

    // Return to free stack
    this.freePropStack.push(prop.poolIndex);
  }

  /**
   * Dispose all resources. Call on scene teardown.
   */
  dispose(): void {
    this.scene.onBeforeRenderObservable.clear();

    for (const prop of this.propPool) {
      prop.transform.dispose();
      if (prop.sprite) prop.sprite.dispose();
    }

    for (const drops of this.dropPool) {
      if (drops.visual) drops.visual.dispose();
    }

    for (const pool of this.debrisPools.values()) {
      for (const mesh of pool) {
        mesh.material?.dispose();
        mesh.dispose();
      }
    }

    this.breakParticleTemplate?.dispose();
    this.spriteManager.dispose();
    this.decorTexture.dispose();

    this.activeProps.clear();
    this.activeDrops.clear();
    this.spatialIndex.clear();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Convert a UV cell tuple to a sprite manager cell index.
   * Assumes uniform grid atlas managed by the SpriteManager.
   */
  private uvToCellIndex(uv: [number, number, number, number]): number {
    // SpriteManager auto-calculates cellIndex from row-major grid.
    // If using manual UV slicing, we compute based on the manager's cell layout.
    const cols = this.spriteManager.cellWidth > 0
      ? Math.floor(1 / this.spriteManager.cellWidth)
      : 8;
    const rows = this.spriteManager.cellHeight > 0
      ? Math.floor(1 / this.spriteManager.cellHeight)
      : 8;

    const col = Math.round(uv[0] * cols);
    const row = Math.round((1 - uv[3]) * rows);
    return row * cols + col;
  }
}

// ---------------------------------------------------------------------------
// Export factory for convenience
// ---------------------------------------------------------------------------

export function createDestructibleObjectPooler(
  scene: Scene,
  decorTexturePath: string,
  atlasCols: number,
  atlasRows: number
): DestructibleObjectPooler {
  return new DestructibleObjectPooler(scene, decorTexturePath, atlasCols, atlasRows);
}
