import { Vector3, Sprite, SpriteManager, Scene, Observer } from "@babylonjs/core";

/**
 * Global player state interface. XPDropManager mutates the `xp` field directly.
 */
export interface IPlayerState {
  xp: number;
}

/**
 * Anything with a readable world-space position vector (AbstractMesh, TransformNode, etc.)
 */
interface IPositionProvider {
  readonly position: Vector3;
}

/**
 * Runtime configuration for gem behaviour.
 */
export interface XPDropConfig {
  /** Distance at which gems begin accelerating toward the player. */
  readonly magnetRadius: number;
  /** Distance at which gems are collected (should match player capsule radius). */
  readonly collectRadius: number;
  /** m/s² acceleration while magnetized. */
  readonly magnetAcceleration: number;
  /** Terminal velocity while magnetized. */
  readonly maxMagnetSpeed: number;
  /** Base experience granted per gem. */
  readonly baseXPValue: number;
  /** Random XP variance added to base value. */
  readonly xpVariance: number;
  /** Vertical bob frequency for idle gems (radians/sec). */
  readonly idleBobSpeed: number;
  /** Vertical bob amplitude for idle gems (world units). */
  readonly idleBobHeight: number;
}

/**
 * Internal pooled object representing a single Soul Gem on the floor.
 */
interface SoulGem {
  /** Babylon sprite instance. */
  sprite: Sprite;
  /** Current world-space velocity (m/s). */
  velocity: Vector3;
  /** How much XP this gem is worth. */
  xpValue: number;
  /** True when this gem is currently in the active simulation array. */
  isActive: boolean;
  /** True once the player enters the magnet radius; persists until collected. */
  isMagnetized: boolean;
  /** Used for idle bobbing phase offset. */
  spawnTime: number;
  /** Original Y position so bobbing doesn't drift. */
  initialY: number;
}

export class XPDropManager {
  private readonly scene: Scene;
  private readonly spriteManager: SpriteManager;
  private readonly player: IPositionProvider;
  private readonly playerState: IPlayerState;
  private readonly config: XPDropConfig;

  private activeGems: SoulGem[] = [];
  private gemPool: SoulGem[] = [];
  private renderObserver: Observer<Scene> | null = null;

  /** Optional hook fired the moment a gem is collected. */
  private onCollectAudio?: () => void;

  constructor(
    scene: Scene,
    spriteManager: SpriteManager,
    player: IPositionProvider,
    playerState: IPlayerState,
    config?: Partial<XPDropConfig>
  ) {
    this.scene = scene;
    this.spriteManager = spriteManager;
    this.player = player;
    this.playerState = playerState;

    this.config = {
      magnetRadius: 3.0,
      collectRadius: 0.4,
      magnetAcceleration: 22.0,
      maxMagnetSpeed: 16.0,
      baseXPValue: 10,
      xpVariance: 5,
      idleBobSpeed: 2.5,
      idleBobHeight: 0.08,
      ...config,
    };

    // Hook into the main render loop.
    this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
      this.update();
    });
  }

  /**
   * Spawn a Soul Gem at the given world position.
   * @param positionVector World-space drop position.
   * @param xpCoefficient Multiplier applied to the randomized base XP value.
   */
  public spawnGem(positionVector: Vector3, xpCoefficient: number = 1.0): void {
    const gem = this.acquireGem();

    gem.sprite.position.copyFrom(positionVector);
    gem.sprite.isVisible = true;
    gem.sprite.width = 0.5;
    gem.sprite.height = 0.5;

    gem.velocity.setAll(0);
    gem.xpValue = Math.floor(
      (this.config.baseXPValue + Math.random() * this.config.xpVariance) *
        xpCoefficient
    );
    gem.isActive = true;
    gem.isMagnetized = false;
    gem.spawnTime = performance.now() / 1000;
    gem.initialY = positionVector.y;

    this.activeGems.push(gem);
  }

  /** Register a callback that fires on every gem collection (e.g. audio cue). */
  public setAudioCallback(callback: () => void): void {
    this.onCollectAudio = callback;
  }

  /** Permanently tears down the manager and all pooled sprites. */
  public dispose(): void {
    if (this.renderObserver) {
      this.scene.onBeforeRenderObservable.remove(this.renderObserver);
      this.renderObserver = null;
    }

    // Dispose every Babylon sprite to free GPU memory.
    for (const gem of this.activeGems) gem.sprite.dispose();
    for (const gem of this.gemPool) gem.sprite.dispose();

    this.activeGems = [];
    this.gemPool = [];
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

  private acquireGem(): SoulGem {
    const recycled = this.gemPool.pop();
    return recycled ?? this.createGem();
  }

  private createGem(): SoulGem {
    const sprite = new Sprite("soulGem", this.spriteManager);
    sprite.isVisible = false;
    return {
      sprite,
      velocity: new Vector3(0, 0, 0),
      xpValue: 0,
      isActive: false,
      isMagnetized: false,
      spawnTime: 0,
      initialY: 0,
    };
  }

  private update(): void {
    const dt = this.scene.getEngine().getDeltaTime() / 1000.0;
    const now = performance.now() / 1000;

    const playerPos = this.player.position;
    const magnetRadiusSq =
      this.config.magnetRadius * this.config.magnetRadius;
    const collectRadiusSq =
      this.config.collectRadius * this.config.collectRadius;

    // Iterate backwards so we can splice collected gems in O(1).
    for (let i = this.activeGems.length - 1; i >= 0; i--) {
      const gem = this.activeGems[i];
      const gemPos = gem.sprite.position;

      // ---- Squared distance check (no sqrt until necessary) ----
      const dx = playerPos.x - gemPos.x;
      const dy = playerPos.y - gemPos.y;
      const dz = playerPos.z - gemPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;

      // ---- Collection ----
      if (distSq < collectRadiusSq) {
        this.collectGem(gem, i);
        continue;
      }

      // ---- Magnetic pull state ----
      if (distSq < magnetRadiusSq || gem.isMagnetized) {
        gem.isMagnetized = true;

        // Normalized direction toward player.
        const dist = Math.sqrt(distSq);
        const invDist = 1.0 / dist;
        const dirX = dx * invDist;
        const dirY = dy * invDist;
        const dirZ = dz * invDist;

        // Accelerate velocity vector toward player.
        gem.velocity.x += dirX * this.config.magnetAcceleration * dt;
        gem.velocity.y += dirY * this.config.magnetAcceleration * dt;
        gem.velocity.z += dirZ * this.config.magnetAcceleration * dt;

        // Clamp to max speed.
        const speedSq =
          gem.velocity.x * gem.velocity.x +
          gem.velocity.y * gem.velocity.y +
          gem.velocity.z * gem.velocity.z;
        const maxSpeedSq = this.config.maxMagnetSpeed * this.config.maxMagnetSpeed;
        if (speedSq > maxSpeedSq) {
          const scale = this.config.maxMagnetSpeed / Math.sqrt(speedSq);
          gem.velocity.x *= scale;
          gem.velocity.y *= scale;
          gem.velocity.z *= scale;
        }
      } else {
        // Idle visual feedback: gentle vertical hover.
        const bobOffset =
          Math.sin((now - gem.spawnTime) * this.config.idleBobSpeed) *
          this.config.idleBobHeight;
        gemPos.y = gem.initialY + bobOffset;
      }

      // ---- Integrate velocity ----
      if (gem.isMagnetized) {
        gemPos.x += gem.velocity.x * dt;
        gemPos.y += gem.velocity.y * dt;
        gemPos.z += gem.velocity.z * dt;
      }
    }
  }

  private collectGem(gem: SoulGem, activeIndex: number): void {
    // 1. Credit global player state.
    this.playerState.xp += gem.xpValue;

    // 2. Audio cue hook.
    if (this.onCollectAudio) {
      this.onCollectAudio();
    }

    // 3. Remove from active simulation array.
    this.activeGems.splice(activeIndex, 1);

    // 4. Reset state and push back into the object pool (prevents memory leaks / GC stutter).
    gem.isActive = false;
    gem.isMagnetized = false;
    gem.velocity.setAll(0);
    gem.sprite.isVisible = false;
    this.gemPool.push(gem);
  }
}
