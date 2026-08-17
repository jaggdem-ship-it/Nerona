/**
 * MapPickups.ts
 */

import {
  Vector3, Mesh, TransformNode, StandardMaterial, Color3, Color4,
  Animation, Observable, Scene, ParticleSystem, Texture, MeshBuilder,
  InstancedMesh, Scalar,
} from \"@babylonjs/core\";

export enum PickupCategory {
  UNHOLY_ROSARY = \"unholy_rosary\",
  ATTRACT_VACUUM = \"attract_vacuum\",
  VAMPIRIC_ELIXIR = \"vampiric_elixir\",
}

export interface IPickupDefinition {
  category: PickupCategory;
  baseColor: Color3;
  pulseColor: Color3;
  glowIntensity: number;
  billboardSize: number;
  particleTexturePath: string;
  lifetimeSeconds: number;
}

export interface IActivePickup {
  mesh: Mesh | InstancedMesh;
  category: PickupCategory;
  spawnTime: number;
  worldPosition: Vector3;
  isConsumed: boolean;
  pulseAnimatable: Animation | null;
  glowParticleSystem: ParticleSystem | null;
}

export interface IMonsterHordeManager {
  getActiveMonsterInstances(): Array<{ id: number; matrixIndex: number; hp: number }>;
  applyDamageToAllInstances(damage: number): number;
  isInstanceOnScreen(matrixIndex: number): boolean;
}

export interface IXPGemSystem {
  getAllDroppedGems(): Array<{ mesh: TransformNode; tileCoords: Vector3; isPulling: boolean }>;
  setGemMagnetState(tileCoords: Vector3, active: boolean, targetPosition?: Vector3): void;
}

export interface IPlayerStats {
  currentHealth: number;
  maxHealth: number;
  addHealth(amount: number): void;
  getPosition(): Vector3;
  getCollisionRadius(): number;
}

export interface IParticleEffectsPool {
  acquire(name: string, position: Vector3, color1: Color4, color2: Color4): ParticleSystem;
  release(system: ParticleSystem): void;
}

const PICKUP_REGISTRY: Record<PickupCategory, IPickupDefinition> = {
  [PickupCategory.UNHOLY_ROSARY]: {
    category: PickupCategory.UNHOLY_ROSARY,
    baseColor: new Color3(0.9, 0.1, 0.05),
    pulseColor: new Color3(1.0, 0.4, 0.0),
    glowIntensity: 2.4,
    billboardSize: 1.2,
    particleTexturePath: \"assets/fx/gothic_ember_64.png\",
    lifetimeSeconds: 12,
  },
  [PickupCategory.ATTRACT_VACUUM]: {
    category: PickupCategory.ATTRACT_VACUUM,
    baseColor: new Color3(0.15, 0.05, 0.9),
    pulseColor: new Color3(0.6, 0.2, 1.0),
    glowIntensity: 3.0,
    billboardSize: 1.0,
    particleTexturePath: \"assets/fx/gothic_sparkle_64.png\",
    lifetimeSeconds: 10,
  },
  [PickupCategory.VAMPIRIC_ELIXIR]: {
    category: PickupCategory.VAMPIRIC_ELIXIR,
    baseColor: new Color3(0.05, 0.7, 0.2),
    pulseColor: new Color3(0.4, 1.0, 0.5),
    glowIntensity: 2.0,
    billboardSize: 0.9,
    particleTexturePath: \"assets/fx/gothic_drip_64.png\",
    lifetimeSeconds: 14,
  },
};

class PickupMeshPool {
  private _scene: Scene;
  private _pools: Map<PickupCategory, Mesh[]> = new Map();
  private _materials: Map<PickupCategory, StandardMaterial> = new Map();
  private _baseMeshes: Map<PickupCategory, Mesh> = new Map();

  constructor(scene: Scene) {
    this._scene = scene;
    this._initializePools();
  }

  private _initializePools(): void {
    Object.values(PickupCategory).forEach((cat) => {
      const def = PICKUP_REGISTRY[cat as PickupCategory];
      const mat = new StandardMaterial(\`pickup_mat_\${cat}\`, this._scene);
      mat.diffuseColor = def.baseColor;
      mat.emissiveColor = def.baseColor.scale(def.glowIntensity);
      mat.disableLighting = true;
      mat.alpha = 0.95;
      this._materials.set(cat as PickupCategory, mat);

      const base = MeshBuilder.CreatePlane(
        \`pickup_base_\${cat}\`,
        { size: def.billboardSize },
        this._scene
      );
      base.material = mat;
      base.billboardMode = Mesh.BILLBOARDMODE_ALL;
      base.isVisible = false;
      base.isPickable = false;
      base.checkCollisions = false;

      const inner = MeshBuilder.CreatePlane(
        \`pickup_inner_\${cat}\`,
        { size: def.billboardSize * 0.6 },
        this._scene
      );
      const innerMat = mat.clone(\`pickup_inner_mat_\${cat}\`);
      innerMat.emissiveColor = def.pulseColor.scale(def.glowIntensity * 1.5);
      innerMat.alpha = 0.6;
      inner.material = innerMat;
      inner.parent = base;
      inner.position.z = -0.01;
      inner.billboardMode = Mesh.BILLBOARDMODE_ALL;

      this._baseMeshes.set(cat as PickupCategory, base);
      this._pools.set(cat as PickupCategory, []);
    });
  }

  public acquire(category: PickupCategory, position: Vector3): Mesh {
    const pool = this._pools.get(category)!;
    let mesh: Mesh;
    if (pool.length > 0) {
      mesh = pool.pop()!;
    } else {
      const base = this._baseMeshes.get(category)!;
      mesh = base.clone(\`pickup_\${category}_\${Date.now()}\`) as Mesh;
      mesh.material = this._materials.get(category)!;
    }
    mesh.position.copyFrom(position);
    mesh.isVisible = true;
    mesh.setEnabled(true);
    return mesh;
  }

  public release(mesh: Mesh, category: PickupCategory): void {
    mesh.isVisible = false;
    mesh.setEnabled(false);
    mesh.position.setAll(0);
    this._scene.stopAnimation(mesh);
    const pool = this._pools.get(category)!;
    if (pool.length < 64) {
      pool.push(mesh);
    } else {
      mesh.dispose(false, true);
    }
  }

  public dispose(): void {
    this._pools.forEach((pool) => pool.forEach((m) => m.dispose(false, true)));
    this._baseMeshes.forEach((m) => m.dispose(false, true));
    this._materials.forEach((m) => m.dispose());
    this._pools.clear();
    this._materials.clear();
    this._baseMeshes.clear();
  }
}

export class MapPickupsManager {
  private _scene: Scene;
  private _pool: PickupMeshPool;
  private _activePickups: Map<string, IActivePickup> = new Map();
  private _player: IPlayerStats;
  private _hordeManager: IMonsterHordeManager | null = null;
  private _xpSystem: IXPGemSystem | null = null;
  private _particlePool: IParticleEffectsPool | null = null;

  public onPickupConsumed: Observable<{ category: PickupCategory; position: Vector3 }> = new Observable();
  public onNukeDetonated: Observable<{ xpHarvested: number; kills: number }> = new Observable();
  public onVacuumActivated: Observable<{ gemsAffected: number }> = new Observable();
  public onPotionConsumed: Observable<{ healAmount: number; newHealth: number }> = new Observable();

  private _pickupCollisionRadius: number = 1.1;
  private _cleanupInterval: number = 1000;
  private _lastCleanupTime: number = 0;
  private _isDisposed: boolean = false;

  constructor(scene: Scene, player: IPlayerStats) {
    this._scene = scene;
    this._player = player;
    this._pool = new PickupMeshPool(scene);
    this._scene.onBeforeRenderObservable.add(this._updateLoop);
  }

  public injectHordeManager(manager: IMonsterHordeManager): void {
    this._hordeManager = manager;
  }

  public injectXPGemSystem(system: IXPGemSystem): void {
    this._xpSystem = system;
  }

  public injectParticlePool(pool: IParticleEffectsPool): void {
    this._particlePool = pool;
  }

  public spawnPickup(origin: Vector3, forcedCategory?: PickupCategory, ejectionVelocity?: Vector3): string {
    const category = forcedCategory ?? this._rollRandomCategory();
    const def = PICKUP_REGISTRY[category];
    const id = \`pickup_\${category}_\${Date.now()}_\${Math.floor(Math.random() * 10000)}\`;

    const spawnPos = origin.add(new Vector3(
      Scalar.RandomRange(-0.5, 0.5),
      0.4,
      Scalar.RandomRange(-0.5, 0.5)
    ));

    const mesh = this._pool.acquire(category, spawnPos);

    if (ejectionVelocity) {
      mesh.metadata = { velocity: ejectionVelocity.clone() };
    }

    const pulseAnim = this._createPulseAnimation(mesh, def);
    this._scene.beginAnimation(mesh, 0, 60, true);

    let glowSystem: ParticleSystem | null = null;
    if (this._particlePool) {
      glowSystem = this._particlePool.acquire(
        def.particleTexturePath,
        spawnPos,
        new Color4(def.pulseColor.r, def.pulseColor.g, def.pulseColor.b, 1.0),
        new Color4(def.baseColor.r, def.baseColor.g, def.baseColor.b, 0.0)
      );
      glowSystem.emitter = mesh;
    }

    const pickup: IActivePickup = {
      mesh, category,
      spawnTime: performance.now(),
      worldPosition: spawnPos.clone(),
      isConsumed: false,
      pulseAnimatable: pulseAnim,
      glowParticleSystem: glowSystem,
    };

    this._activePickups.set(id, pickup);
    return id;
  }

  public spawnPickupBurst(origin: Vector3, count: number, weights?: Partial<Record<PickupCategory, number>>): string[] {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const roll = this._rollRandomCategory(weights);
      const vel = new Vector3(Scalar.RandomRange(-2, 2), Scalar.RandomRange(1, 3), Scalar.RandomRange(-2, 2));
      ids.push(this.spawnPickup(origin, roll, vel));
    }
    return ids;
  }

  private _updateLoop = (): void => {
    if (this._isDisposed) return;
    const now = performance.now();
    const playerPos = this._player.getPosition();
    const playerRad = this._player.getCollisionRadius() + this._pickupCollisionRadius;

    this._activePickups.forEach((pickup, id) => {
      if (pickup.isConsumed) return;

      if (pickup.mesh.metadata?.velocity) {
        const vel: Vector3 = pickup.mesh.metadata.velocity;
        pickup.mesh.position.addInPlace(vel.scale(this._scene.getEngine().getDeltaTime() / 1000));
        vel.y -= 9.8 * (this._scene.getEngine().getDeltaTime() / 1000);
        if (pickup.mesh.position.y <= 0.4) {
          pickup.mesh.position.y = 0.4;
          pickup.mesh.metadata.velocity = null;
        }
      }

      pickup.worldPosition.copyFrom(pickup.mesh.position);

      const age = (now - pickup.spawnTime) / 1000;
      const maxLife = PICKUP_REGISTRY[pickup.category].lifetimeSeconds;
      if (age >= maxLife) {
        this._expirePickup(id);
        return;
      }

      if (age > maxLife - 2) {
        const fade = 0.5 + 0.5 * Math.sin(age * 20);
        if (pickup.mesh.material) {
          (pickup.mesh.material as StandardMaterial).alpha = fade;
        }
      }

      const distSq = Vector3.DistanceSquared(playerPos, pickup.worldPosition);
      if (distSq <= playerRad * playerRad) {
        this._consumePickup(id, pickup);
      }
    });

    if (now - this._lastCleanupTime > this._cleanupInterval) {
      this._lastCleanupTime = now;
    }
  };

  private _consumePickup(id: string, pickup: IActivePickup): void {
    if (pickup.isConsumed) return;
    pickup.isConsumed = true;
    this._spawnConsumptionBurst(pickup);

    switch (pickup.category) {
      case PickupCategory.UNHOLY_ROSARY:
        this._executeNuke();
        break;
      case PickupCategory.ATTRACT_VACUUM:
        this._executeVacuum(pickup.worldPosition);
        break;
      case PickupCategory.VAMPIRIC_ELIXIR:
        this._executePotion();
        break;
    }

    this.onPickupConsumed.notifyObservers({
      category: pickup.category,
      position: pickup.worldPosition.clone(),
    });

    this._retirePickup(id, pickup);
  }

  private _executeNuke(): void {
    if (!this._hordeManager) {
      console.warn(\"[MapPickupsManager] HordeManager not injected; Nuke aborted.\");
      return;
    }
    const instances = this._hordeManager.getActiveMonsterInstances();
    let killCount = 0;
    for (const inst of instances) {
      if (this._hordeManager!.isInstanceOnScreen(inst.matrixIndex)) {
        killCount++;
      }
    }
    const xpHarvested = this._hordeManager.applyDamageToAllInstances(9999);
    this.onNukeDetonated.notifyObservers({ xpHarvested, kills: killCount });
  }

  private _executeVacuum(origin: Vector3): void {
    if (!this._xpSystem) {
      console.warn(\"[MapPickupsManager] XPGemSystem not injected; Vacuum aborted.\");
      return;
    }
    const allGems = this._xpSystem.getAllDroppedGems();
    let affected = 0;
    const playerPos = this._player.getPosition();
    for (const gem of allGems) {
      if (!gem.isPulling) {
        this._xpSystem!.setGemMagnetState(gem.tileCoords, true, playerPos);
        affected++;
      }
    }
    this.onVacuumActivated.notifyObservers({ gemsAffected: affected });
  }

  private _executePotion(): void {
    const healAmount = Math.floor(this._player.maxHealth * 0.3);
    const previousHealth = this._player.currentHealth;
    this._player.addHealth(healAmount);
    const actualHeal = this._player.currentHealth - previousHealth;
    this.onPotionConsumed.notifyObservers({ healAmount: actualHeal, newHealth: this._player.currentHealth });
  }

  private _rollRandomCategory(weights?: Partial<Record<PickupCategory, number>>): PickupCategory {
    const defaultWeights: Record<PickupCategory, number> = {
      [PickupCategory.UNHOLY_ROSARY]: 0.15,
      [PickupCategory.ATTRACT_VACUUM]: 0.35,
      [PickupCategory.VAMPIRIC_ELIXIR]: 0.50,
    };
    const w = { ...defaultWeights, ...weights };
    const roll = Math.random();
    let cumulative = 0;
    for (const cat of Object.values(PickupCategory)) {
      cumulative += w[cat];
      if (roll <= cumulative) return cat;
    }
    return PickupCategory.VAMPIRIC_ELIXIR;
  }

  private _createPulseAnimation(mesh: Mesh, def: IPickupDefinition): Animation {
    const anim = new Animation(\"pickup_pulse\", \"material.emissiveColor\", 60, Animation.ANIMATIONTYPE_COLOR3, Animation.ANIMATIONLOOPMODE_CYCLE);
    const keys = [
      { frame: 0, value: def.baseColor.scale(def.glowIntensity) },
      { frame: 30, value: def.pulseColor.scale(def.glowIntensity * 1.6) },
      { frame: 60, value: def.baseColor.scale(def.glowIntensity) },
    ];
    anim.setKeys(keys);
    mesh.animations.push(anim);
    return anim;
  }

  private _spawnConsumptionBurst(pickup: IActivePickup): void {
    if (!this._particlePool) return;
    const def = PICKUP_REGISTRY[pickup.category];
    const burst = this._particlePool.acquire(
      def.particleTexturePath,
      pickup.worldPosition,
      new Color4(1, 1, 1, 1),
      new Color4(def.pulseColor.r, def.pulseColor.g, def.pulseColor.b, 0)
    );
    burst.minSize = 0.2;
    burst.maxSize = 0.8;
    burst.emitRate = 500;
    burst.targetStopDuration = 0.3;
    burst.disposeOnStop = true;
  }

  private _expirePickup(id: string): void {
    const pickup = this._activePickups.get(id);
    if (!pickup) return;
    this._retirePickup(id, pickup);
  }

  private _retirePickup(id: string, pickup: IActivePickup): void {
    if (pickup.glowParticleSystem && this._particlePool) {
      this._particlePool.release(pickup.glowParticleSystem);
    }
    this._scene.stopAnimation(pickup.mesh);
    this._pool.release(pickup.mesh, pickup.category);
    this._activePickups.delete(id);
  }

  public clearAllPickups(): void {
    this._activePickups.forEach((pickup, id) => this._retirePickup(id, pickup));
    this._activePickups.clear();
  }

  public getActivePickupCount(): number {
    return this._activePickups.size;
  }

  public dispose(): void {
    this._isDisposed = true;
    this._scene.onBeforeRenderObservable.removeCallback(this._updateLoop);
    this.clearAllPickups();
    this._pool.dispose();
    this.onPickupConsumed.clear();
    this.onNukeDetonated.clear();
    this.onVacuumActivated.clear();
    this.onPotionConsumed.clear();
  }
}
