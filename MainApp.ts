/// <reference path="./types/babylon.d.ts" />
// ============================================================
// Diablo Survivors - MainApp.ts
// Master Orchestrator Initialization File
// Principal Architect | 2026-08-16 | v1.0.0
// ============================================================

// ============================================================
// IMPORTS: 22 Modular Sub-Systems
// ============================================================

import { EngineCore } from "./EngineCore";
import { PlayerController } from "./PlayerController";
import { SpriteAnimator } from "./SpriteAnimator";
import { MapEngine } from "./MapEngine";
import { CollisionSystem } from "./CollisionSystem";
import { SwarmAI } from "./SwarmAI";
import { VFXEngine } from "./VFXEngine";
import { WeaponEngine } from "./WeaponEngine";
import { ProgressionSystem } from "./ProgressionSystem";
import { UserInterface } from "./UserInterface";
import { AudioFXEngine } from "./AudioFXEngine";
import { PostProcessingPipeline } from "./PostProcessingPipeline";
import { SaveSystem } from "./SaveSystem";
import { GameFlowController } from "./GameFlowController";
import { AssetPipeline } from "./AssetPipeline";
import { XPDropSystem } from "./XPDropSystem";
import { LevelUpInterface } from "./LevelUpInterface";
import { MetaProgression } from "./MetaProgression";
import { LootChestSystem } from "./LootChestSystem";
import { AchievementTracker } from "./AchievementTracker";
import { BossDirector } from "./BossDirector";
import { MapPickups } from "./MapPickups";
import { CombatFeedback } from "./CombatFeedback";
import { PauseMenu } from "./PauseMenu";

// ============================================================
// TYPE DEFINITIONS & INTERFACES (Cross-module glue layer)
// ============================================================

type GameState = "BOOT" | "MAIN_MENU" | "CHARACTER_SELECT" | "GAMEPLAY_ACTIVE" | "GAME_OVER";

interface CharacterArchetype {
  id: string;
  name: string;
  portraitIndex: number;
  movementSpeedMod: number;
  damageMod: number;
  armorMod: number;
  mobilityMod: number;
  critChanceMod: number;
  startingWeapon: string;
  unlocked: boolean;
}

type AudioBus = "MASTER" | "MUSIC" | "AMBIENCE" | "COMBAT_FX" | "UI";

type PostEffect = "SSAO" | "BLOOM" | "SHAKE" | "CHROMATIC_ABERRATION" | "VIGNETTE" | "FILM_GRAIN";

interface WeaponData {
  id: string;
  name: string;
  baseDamage: number;
  cooldown: number;
  projectileSpeed: number;
  range: number;
  rank: number;
  maxRank: number;
  evolutionId?: string;
  pairedPassive?: string;
}

interface EnemyEntity {
  id: string;
  mesh: BABYLON.AbstractMesh;
  position: BABYLON.Vector3;
  velocity: BABYLON.Vector3;
  health: number;
  maxHealth: number;
  type: EnemyType;
  state: EnemyState;
  attackCooldown: number;
  animKey: string;
}

type EnemyType = "SKELETON" | "SUCCUBUS" | "BUTCHER" | "BLOODLORD" | "FALLEN";
type EnemyState = "IDLE" | "CHASE" | "ATTACK" | "DEAD" | "STUNNED";

interface BossEntity extends EnemyEntity {
  phase: number;
  maxPhases: number;
  barricades: BABYLON.AbstractMesh[];
  chargeCooldown: number;
  isCharging: boolean;
}

interface AttackEvent {
  attackerId: string;
  attackerType: EnemyType;
  targetPosition: BABYLON.Vector3;
  damage: number;
  animKey: string;
}

interface WaveConfig {
  enemyType: EnemyType;
  count: number;
  spawnRadius: number;
  eliteChance: number;
}

interface UpgradeOption {
  id: string;
  name: string;
  description: string;
  iconPath: string;
  type: "WEAPON" | "PASSIVE" | "EVOLUTION";
  rarity: "COMMON" | "RARE" | "EPIC" | "LEGENDARY";
}

type ChestTier = "COMMON" | "RARE" | "EPIC" | "LEGENDARY" | "BOSS";

interface LootChest {
  id: string;
  mesh: BABYLON.AbstractMesh;
  position: BABYLON.Vector3;
  tier: ChestTier;
  isOpen: boolean;
}

interface Reward {
  type: "GOLD" | "XP" | "WEAPON_RANK" | "PASSIVE_RANK" | "ITEM";
  amount: number;
  itemId?: string;
}

interface AchievementEvent {
  type: "KILL" | "BOSS_KILL" | "NO_HIT" | "SPEED_CLEAR" | "LEVEL_UP" | "WEAPON_EVOLVE" | "CHEST_OPEN";
  value: number;
  metadata?: Record<string, unknown>;
}

interface Achievement {
  id: string;
  name: string;
  description: string;
  iconPath: string;
  unlockedAt: number;
}

interface MetaUpgrade {
  id: string;
  name: string;
  description: string;
  cost: number;
  maxPurchases: number;
  effect: Record<string, number>;
}

type PropType = "BARREL" | "URN" | "CHEST" | "CRATE" | "SARCOPHAGUS";

interface PropEntity {
  id: string;
  mesh: BABYLON.AbstractMesh;
  position: BABYLON.Vector3;
  health: number;
  maxHealth: number;
  type: PropType;
  isDestroyed: boolean;
  debrisMesh?: BABYLON.AbstractMesh;
}

interface Collidable {
  id: string;
  mesh: BABYLON.AbstractMesh;
  bounds: BABYLON.BoundingBox;
  velocity: BABYLON.Vector3;
  isStatic: boolean;
  onCollision(other: Collidable, normal: BABYLON.Vector3): void;
}

interface AnimatedEntity {
  id: string;
  mesh: BABYLON.AbstractMesh;
  spriteManager: BABYLON.SpriteManager;
  currentAnim: string;
  flipH: boolean;
  frameTime: number;
  currentFrame: number;
}

type VFXType =
  | "BLOOD_SPLASH"
  | "FIRE_BURST"
  | "SOUL_DRAIN"
  | "PLAGUE_CLOUD"
  | "ICE_SHARD"
  | "LIGHTNING_STRIKE"
  | "DARK_PORTAL"
  | "HEAL_AURA"
  | "LEVEL_UP_BURST"
  | "BOSS_PHASE_TRANSITION";

interface SpriteSheetData {
  texture: BABYLON.Texture;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  totalFrames: number;
  animations: Map<string, { startFrame: number; endFrame: number; fps: number; loop: boolean }>;
}

// ============================================================
// ASSET MANIFEST: 13 Pre-Sliced Texture Sheets
// ============================================================

const ASSET_MANIFEST: string[] = [
  "player_run.png",
  "player_idle.png",
  "skeleton_walk.png",
  "succubus_fly.png",
  "succubus_attack.png",
  "butcher_boss.png",
  "butcher_charge.png",
  "crypt_tiles.png",
  "mansion_tiles.png",
  "decor_props.png",
  "ui_kit.png",
  "soul_gems.png",
  "font_atlas.png",
];

// ============================================================
// GLOBAL WINDOW INTERFACE EXTENSION
// ============================================================

declare global {
  interface Window {
    Game: DiabloSurvivorsEngine;
  }
}

// ============================================================
// MASTER ORCHESTRATOR CLASS
// ============================================================

class DiabloSurvivorsEngine {
  // Core References
  public engine: BABYLON.Engine | null = null;
  public scene: BABYLON.Scene | null = null;
  public camera: BABYLON.UniversalCamera | null = null;
  public canvas: HTMLCanvasElement | null = null;

  // 22 Module Instances
  public engineCore: EngineCore | null = null;
  public playerController: PlayerController | null = null;
  public spriteAnimator: SpriteAnimator | null = null;
  public mapEngine: MapEngine | null = null;
  public collisionSystem: CollisionSystem | null = null;
  public swarmAI: SwarmAI | null = null;
  public vfxEngine: VFXEngine | null = null;
  public weaponEngine: WeaponEngine | null = null;
  public progressionSystem: ProgressionSystem | null = null;
  public userInterface: UserInterface | null = null;
  public audioFXEngine: AudioFXEngine | null = null;
  public postProcessingPipeline: PostProcessingPipeline | null = null;
  public saveSystem: SaveSystem | null = null;
  public gameFlowController: GameFlowController | null = null;
  public assetPipeline: AssetPipeline | null = null;
  public xpDropSystem: XPDropSystem | null = null;
  public levelUpInterface: LevelUpInterface | null = null;
  public metaProgression: MetaProgression | null = null;
  public lootChestSystem: LootChestSystem | null = null;
  public achievementTracker: AchievementTracker | null = null;
  public bossDirector: BossDirector | null = null;
  public mapPickups: MapPickups | null = null;
  public combatFeedback: CombatFeedback | null = null;
  public pauseMenu: PauseMenu | null = null;

  // Input Module Reference
  public inputModule: {
    joystick: {
      originX: number;
      originY: number;
      deltaX: number;
      deltaY: number;
      isActive: boolean;
      onTouchStart: ((x: number, y: number) => void) | null;
      onTouchMove: ((x: number, y: number) => void) | null;
      onTouchEnd: (() => void) | null;
    };
    keyboard: {
      keys: Set<string>;
      onKeyDown: ((key: string) => void) | null;
      onKeyUp: ((key: string) => void) | null;
    };
  } | null = null;

  // Runtime State
  private _lastFrameTime: number = 0;
  private _deltaTime: number = 0;
  private _accumulatedTime: number = 0;
  private readonly _targetFrameTime: number = 1000 / 60;
  private _isBootComplete: boolean = false;
  private _isAssetsLoaded: boolean = false;
  private _bootError: Error | null = null;
  private _animationFrameId: number = 0;
  private _hitFreezeFrames: number = 0;
  private _hitFreezeTimeScale: number = 1.0;
  private readonly _hitFreezeDuration: number = 3;
  private readonly _hitFreezeScale: number = 0.05;

  // Event Bus
  private _eventBus: Map<string, Array<(data: unknown) => void>> = new Map();

  constructor(canvasElement: HTMLCanvasElement) {
    this.canvas = canvasElement;
    this._initializeInputModule();
    this._lastFrameTime = performance.now();
    this._animationFrameId = requestAnimationFrame(this._renderLoop.bind(this));
    console.log("[DiabloSurvivorsEngine] Boot sequence initiated.");
  }

  public async init(selectedArchetype: CharacterArchetype): Promise<void> {
    try {
      await this._initEngineCore();
      await this._initAssetPipeline();
      await this._initSaveSystem();
      await this._initGameFlowController();
      await this._initMetaProgression();
      await this._initAudioFXEngine();
      await this._initPostProcessingPipeline();
      await this._initMapEngine();
      await this._initSpriteAnimator();
      await this._initPlayerController(selectedArchetype);
      await this._initCollisionSystem();
      await this._initSwarmAI();
      await this._initVFXEngine();
      await this._initWeaponEngine();
      await this._initProgressionSystem();
      await this._initXPDropSystem();
      await this._initCombatFeedback();
      await this._initUserInterface();
      await this._initLevelUpInterface();
      await this._initLootChestSystem();
      await this._initAchievementTracker();
      await this._initBossDirector();
      await this._initMapPickups();
      await this._initPauseMenu();

      this._executeCommunicationHandshake();

      this.gameFlowController!.setState("MAIN_MENU");
      this._isBootComplete = true;
      window.Game = this;
      console.log("[DiabloSurvivorsEngine] Boot complete. window.Game exposed.");
    } catch (error) {
      this._bootError = error instanceof Error ? error : new Error(String(error));
      this._isBootComplete = false;
      console.error("[DiabloSurvivorsEngine] Boot failed:", this._bootError);
      throw this._bootError;
    }
  }

  public startGameplay(): void {
    if (!this._isBootComplete) return;
    this.gameFlowController!.setState("GAMEPLAY_ACTIVE");
    this.audioFXEngine!.playSound("gameplay_start", undefined, "MUSIC");
  }

  public shutdown(): void {
    if (this._animationFrameId) cancelAnimationFrame(this._animationFrameId);
    this.saveSystem?.save("last_session", { timestamp: Date.now() }).catch(() => {});
    this.engine?.dispose();
    if (window.Game === this) delete (window as unknown as Record<string, unknown>).Game;
    this._eventBus.clear();
  }

  public triggerHitFreeze(): void {
    this._hitFreezeFrames = this._hitFreezeDuration;
    this._hitFreezeTimeScale = this._hitFreezeScale;
    this.combatFeedback?.triggerHitFreeze();
  }

  public getCombatStats() {
    return {
      playerHealth: this.playerController?.health ?? 0,
      playerMaxHealth: (this.playerController as unknown as Record<string, number>)?.maxHealth ?? 100,
      playerLevel: this.progressionSystem?.getLevel() ?? 1,
      playerXP: this.progressionSystem?.getStats().currentXP ?? 0,
      playerMaxXP: this.progressionSystem?.getStats().maxXP ?? 100,
      killCount: this.achievementTracker?.getProgress("total_kills") ?? 0,
      activeEnemies: this.swarmAI?.getActiveEnemies().length ?? 0,
      activeBosses: this.bossDirector?.getActiveBosses().length ?? 0,
      gameTime: this._accumulatedTime / 1000,
      isPaused: this.gameFlowController?.isPaused ?? false,
    };
  }

  // ============================================================
  // PRIVATE BOOT SEQUENCE
  // ============================================================

  private async _initEngineCore(): Promise<void> {
    if (!this.canvas) throw new Error("Canvas is null.");
    this.engineCore = new EngineCore(this.canvas);
    this.engine = this.engineCore.engine;
    this.scene = this.engineCore.scene;
    this.camera = this.engineCore.camera;
    if (!this.engine || !this.scene || !this.camera) throw new Error("EngineCore failed.");
    console.log("[DiabloSurvivorsEngine] EngineCore initialized.");
  }

  private async _initAssetPipeline(): Promise<void> {
    if (!this.engine) throw new Error("Engine not initialized.");
    this.assetPipeline = new AssetPipeline(this.engine);
    const success = await this.assetPipeline.loadAll(ASSET_MANIFEST);
    if (!success) throw new Error("AssetPipeline failed to load textures.");
    this._isAssetsLoaded = true;
    console.log("[DiabloSurvivorsEngine] AssetPipeline initialized.");
  }

  private async _initSaveSystem(): Promise<void> {
    this.saveSystem = new SaveSystem();
    console.log("[DiabloSurvivorsEngine] SaveSystem initialized.");
  }

  private async _initGameFlowController(): Promise<void> {
    this.gameFlowController = new GameFlowController();
    this.gameFlowController.onStateChange.add((state: GameState) => {
      console.log(`[DiabloSurvivorsEngine] State: ${state}`);
      this.emit("stateChange", state);
    });
    console.log("[DiabloSurvivorsEngine] GameFlowController initialized.");
  }

  private async _initMetaProgression(): Promise<void> {
    if (!this.saveSystem) throw new Error("SaveSystem not initialized.");
    this.metaProgression = new MetaProgression(this.saveSystem);
    console.log("[DiabloSurvivorsEngine] MetaProgression initialized.");
  }

  private async _initAudioFXEngine(): Promise<void> {
    this.audioFXEngine = new AudioFXEngine();
    console.log("[DiabloSurvivorsEngine] AudioFXEngine initialized.");
  }

  private async _initPostProcessingPipeline(): Promise<void> {
    if (!this.scene || !this.camera) throw new Error("Scene or camera not initialized.");
    this.postProcessingPipeline = new PostProcessingPipeline(this.scene, this.camera);
    this.postProcessingPipeline.enable("SSAO");
    this.postProcessingPipeline.enable("BLOOM");
    this.postProcessingPipeline.enable("VIGNETTE");
    console.log("[DiabloSurvivorsEngine] PostProcessingPipeline initialized.");
  }

  private async _initMapEngine(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.mapEngine = new MapEngine(this.scene, 2.0);
    this.mapEngine.generateChunk(0, 0);
    this.mapEngine.generateChunk(1, 0);
    this.mapEngine.generateChunk(0, 1);
    this.mapEngine.generateChunk(1, 1);
    this.mapEngine.generateChunk(-1, 0);
    this.mapEngine.generateChunk(0, -1);
    console.log("[DiabloSurvivorsEngine] MapEngine initialized.");
  }

  private async _initSpriteAnimator(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.spriteAnimator = new SpriteAnimator(this.scene);
    console.log("[DiabloSurvivorsEngine] SpriteAnimator initialized.");
  }

  private async _initPlayerController(archetype: CharacterArchetype): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    if (!this.metaProgression!.isCharacterUnlocked(archetype.id)) {
      archetype = this._getDefaultArchetype();
    }
    this.playerController = new PlayerController(this.scene, archetype);
    this._bindInputToPlayer();
    console.log(`[DiabloSurvivorsEngine] PlayerController initialized: ${archetype.name}`);
  }

  private async _initCollisionSystem(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.collisionSystem = new CollisionSystem(this.scene);
    const mapBoxes = this.mapEngine!.getCollisionBoxes();
    for (const box of mapBoxes) {
      this.collisionSystem.registerCollider({
        id: `map_wall_${Math.random().toString(36).substr(2, 9)}`,
        mesh: null as unknown as BABYLON.AbstractMesh,
        bounds: box,
        velocity: BABYLON.Vector3.Zero(),
        isStatic: true,
        onCollision: () => {},
      });
    }
    console.log("[DiabloSurvivorsEngine] CollisionSystem initialized.");
  }

  private async _initSwarmAI(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.swarmAI = new SwarmAI(this.scene, 1200);
    this.swarmAI.onAttackEvent.add((event: AttackEvent) => {
      this._handleEnemyAttackEvent(event);
    });
    console.log("[DiabloSurvivorsEngine] SwarmAI initialized.");
  }

  private async _initVFXEngine(): Promise<void> {
    if (!this.scene || !this.engine) throw new Error("Scene or engine not initialized.");
    this.vfxEngine = new VFXEngine(this.scene, this.engine);
    console.log("[DiabloSurvivorsEngine] VFXEngine initialized.");
  }

  private async _initWeaponEngine(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.weaponEngine = new WeaponEngine(this.scene);
    const startingWeapon = this._getStartingWeaponData(this.playerController!.archetype.startingWeapon);
    if (startingWeapon) this.weaponEngine.equip(startingWeapon);
    console.log("[DiabloSurvivorsEngine] WeaponEngine initialized.");
  }

  private async _initProgressionSystem(): Promise<void> {
    this.progressionSystem = new ProgressionSystem();
    this.progressionSystem.onLevelUp.add((newLevel: number) => {
      this._handleLevelUp(newLevel);
    });
    console.log("[DiabloSurvivorsEngine] ProgressionSystem initialized.");
  }

  private async _initXPDropSystem(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.xpDropSystem = new XPDropSystem(this.scene);
    this.xpDropSystem.onPickup.add((xpValue: number) => {
      const leveledUp = this.progressionSystem!.addXP(xpValue);
      if (!leveledUp) {
        this.userInterface?.setXP(
          this.progressionSystem!.getStats().currentXP,
          this.progressionSystem!.getStats().maxXP
        );
      }
    });
    console.log("[DiabloSurvivorsEngine] XPDropSystem initialized.");
  }

  private async _initCombatFeedback(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    const uiContainer = document.getElementById("game-ui-container");
    if (!uiContainer) throw new Error("UI container #game-ui-container not found.");
    this.combatFeedback = new CombatFeedback(this.scene, uiContainer);
    console.log("[DiabloSurvivorsEngine] CombatFeedback initialized.");
  }

  private async _initUserInterface(): Promise<void> {
    const uiContainer = document.getElementById("game-ui-container");
    if (!uiContainer) throw new Error("UI container #game-ui-container not found.");
    this.userInterface = new UserInterface(uiContainer);
    this.userInterface.show();
    console.log("[DiabloSurvivorsEngine] UserInterface initialized.");
  }

  private async _initLevelUpInterface(): Promise<void> {
    const modalContainer = document.getElementById("levelup-modal-container");
    if (!modalContainer) throw new Error("Modal container #levelup-modal-container not found.");
    this.levelUpInterface = new LevelUpInterface(modalContainer);
    this.levelUpInterface.onSelect.add((option: UpgradeOption) => {
      this._handleUpgradeSelection(option);
    });
    console.log("[DiabloSurvivorsEngine] LevelUpInterface initialized.");
  }

  private async _initLootChestSystem(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.lootChestSystem = new LootChestSystem(this.scene);
    console.log("[DiabloSurvivorsEngine] LootChestSystem initialized.");
  }

  private async _initAchievementTracker(): Promise<void> {
    if (!this.saveSystem) throw new Error("SaveSystem not initialized.");
    this.achievementTracker = new AchievementTracker(this.saveSystem);
    console.log("[DiabloSurvivorsEngine] AchievementTracker initialized.");
  }

  private async _initBossDirector(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.bossDirector = new BossDirector(this.scene);
    this.bossDirector.scheduleEncounter(300, "BUTCHER");
    this.bossDirector.scheduleEncounter(600, "BUTCHER");
    this.bossDirector.scheduleEncounter(1200, "BUTCHER");
    console.log("[DiabloSurvivorsEngine] BossDirector initialized.");
  }

  private async _initMapPickups(): Promise<void> {
    if (!this.scene) throw new Error("Scene not initialized.");
    this.mapPickups = new MapPickups(this.scene);
    this.mapPickups.spawnProp("BARREL", new BABYLON.Vector3(5, 0, 5));
    this.mapPickups.spawnProp("URN", new BABYLON.Vector3(-3, 0, 7));
    this.mapPickups.spawnProp("CHEST", new BABYLON.Vector3(8, 0, -2));
    console.log("[DiabloSurvivorsEngine] MapPickups initialized.");
  }

  private async _initPauseMenu(): Promise<void> {
    const pauseContainer = document.getElementById("pause-menu-container");
    if (!pauseContainer) throw new Error("Pause container #pause-menu-container not found.");
    this.pauseMenu = new PauseMenu(pauseContainer);
    this.pauseMenu.onResume.add(() => {
      this.gameFlowController!.togglePause();
    });
    this.pauseMenu.onQuit.add(() => {
      this.shutdown();
    });
    console.log("[DiabloSurvivorsEngine] PauseMenu initialized.");
  }

  // ============================================================
  // INPUT MODULE
  // ============================================================

  private _initializeInputModule(): void {
    if (!this.canvas) return;
    this.inputModule = {
      joystick: { originX: 0, originY: 0, deltaX: 0, deltaY: 0, isActive: false, onTouchStart: null, onTouchMove: null, onTouchEnd: null },
      keyboard: { keys: new Set<string>(), onKeyDown: null, onKeyUp: null },
    };

    const canvas = this.canvas;
    const joystick = this.inputModule.joystick;

    canvas.addEventListener("touchstart", (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      const touch = e.touches[0];
      joystick.originX = touch.clientX;
      joystick.originY = touch.clientY;
      joystick.isActive = true;
      joystick.deltaX = 0;
      joystick.deltaY = 0;
      joystick.onTouchStart?.(touch.clientX, touch.clientY);
    }, { passive: true });

    canvas.addEventListener("touchmove", (e: TouchEvent) => {
      if (!joystick.isActive || e.touches.length === 0) return;
      const touch = e.touches[0];
      const maxRadius = 80;
      const dx = touch.clientX - joystick.originX;
      const dy = touch.clientY - joystick.originY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      if (distance > maxRadius) {
        const scale = maxRadius / distance;
        joystick.deltaX = dx * scale;
        joystick.deltaY = dy * scale;
      } else {
        joystick.deltaX = dx;
        joystick.deltaY = dy;
      }
      joystick.onTouchMove?.(joystick.deltaX, joystick.deltaY);
    }, { passive: true });

    canvas.addEventListener("touchend", () => {
      joystick.isActive = false;
      joystick.deltaX = 0;
      joystick.deltaY = 0;
      joystick.onTouchEnd?.();
    });

    canvas.addEventListener("touchcancel", () => {
      joystick.isActive = false;
      joystick.deltaX = 0;
      joystick.deltaY = 0;
      joystick.onTouchEnd?.();
    });

    const keyboard = this.inputModule.keyboard;
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keyboard.keys.add(key);
      keyboard.onKeyDown?.(key);
      if (key === "escape" || key === "p") this.gameFlowController?.togglePause();
    });

    window.addEventListener("keyup", (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      keyboard.keys.delete(key);
      keyboard.onKeyUp?.(key);
    });

    console.log("[DiabloSurvivorsEngine] Input module initialized.");
  }

  private _bindInputToPlayer(): void {
    if (!this.playerController || !this.inputModule) return;
    const joystick = this.inputModule.joystick;
    const keyboard = this.inputModule.keyboard;

    joystick.onTouchMove = (dx: number, dy: number) => {
      const maxRadius = 80;
      const nx = Math.max(-1, Math.min(1, dx / maxRadius));
      const ny = Math.max(-1, Math.min(1, dy / maxRadius));
      this.playerController!.setJoystickInput(nx, -ny);
    };

    joystick.onTouchEnd = () => {
      this.playerController!.setJoystickInput(0, 0);
    };

    keyboard.onKeyDown = (key: string) => {
      this.playerController!.setKeyInput(key, true);
    };

    keyboard.onKeyUp = (key: string) => {
      this.playerController!.setKeyInput(key, false);
    };

    console.log("[DiabloSurvivorsEngine] Input bound to PlayerController.");
  }

  // ============================================================
  // MASTER INTER-MODULE COMMUNICATION HANDSHAKE
  // ============================================================

  private _executeCommunicationHandshake(): void {
    console.log("[DiabloSurvivorsEngine] Executing inter-module handshake...");

    // WIRE 1: PlayerController -> SpriteAnimator, MapEngine, AudioFXEngine, BossDirector
    const playerPos = () => this.playerController!.position;
    const playerVel = () => this.playerController!.velocity;
    this.spriteAnimator!.setTargetReference(playerPos);
    this.mapEngine!.setPlayerPositionCallback(playerPos);
    this.audioFXEngine!.setListenerPositionCallback(playerPos);
    this.bossDirector!.setPlayerReference(playerPos, playerVel);

    // WIRE 2: SwarmAI -> CollisionSystem, WeaponEngine
    this.swarmAI!.onEnemySpawned.add((enemy: EnemyEntity) => {
      this.collisionSystem!.registerCollider({
        id: enemy.id,
        mesh: enemy.mesh,
        bounds: enemy.mesh.getBoundingInfo().boundingBox,
        velocity: enemy.velocity,
        isStatic: false,
        onCollision: (other: Collidable, normal: BABYLON.Vector3) => {
          if (other.id.startsWith("enemy_")) {
            const separationForce = normal.scale(0.5);
            enemy.velocity.addInPlace(separationForce);
          }
          if (other.id === "player") {
            const damage = this._calculateEnemyDamage(enemy);
            this.playerController!.takeDamage(damage);
            this.combatFeedback!.spawnDamageText(this.playerController!.position, damage, false);
            this.audioFXEngine!.playSound("player_hit", this.playerController!.position, "COMBAT_FX");
          }
          if (other.id.startsWith("map_wall_")) {
            const slide = enemy.velocity.subtract(normal.scale(BABYLON.Vector3.Dot(enemy.velocity, normal)));
            enemy.velocity.copyFrom(slide);
          }
        },
      });
    });

    this.swarmAI!.onEnemyDespawned.add((enemyId: string) => {
      this.collisionSystem!.unregisterCollider(enemyId);
    });

    this.weaponEngine!.setTargetProvider(() => this.swarmAI!.getActiveEnemies());

    // WIRE 3: SwarmAI Attack Events -> SpriteAnimator
    this.swarmAI!.onAttackEvent.add((event: AttackEvent) => {
      const enemy = this.swarmAI!.getActiveEnemies().find((e) => e.id === event.attackerId);
      if (!enemy) return;
      if (event.attackerType === "SUCCUBUS") {
        this.spriteAnimator!.play(enemy as unknown as AnimatedEntity, "succubus_attack", enemy.velocity.x < 0);
      } else if (event.attackerType === "BUTCHER") {
        this.spriteAnimator!.play(enemy as unknown as AnimatedEntity, "butcher_charge", enemy.velocity.x < 0);
      } else if (event.attackerType === "SKELETON") {
        this.spriteAnimator!.play(enemy as unknown as AnimatedEntity, "skeleton_attack", enemy.velocity.x < 0);
      }
      this.combatFeedback!.spawnDamageText(event.targetPosition, event.damage, false);
      this.audioFXEngine!.playSound("enemy_attack", event.targetPosition, "COMBAT_FX");
    });

    // WIRE 4: ProgressionSystem Level-Up -> GameFlowController, LevelUpInterface, AudioFXEngine
    this.progressionSystem!.onLevelUp.add((newLevel: number) => {
      this.gameFlowController!.isPaused = true;
      this.audioFXEngine!.setBusVolume("COMBAT_FX", 0.0);
      this.audioFXEngine!.setBusVolume("AMBIENCE", 0.3);
      const options = this._generateUpgradeOptions(newLevel);
      this.levelUpInterface!.open(options);
      this.vfxEngine!.emit("LEVEL_UP_BURST", this.playerController!.position, 1.0);
      this.audioFXEngine!.playSound("level_up", this.playerController!.position, "UI");
      this.achievementTracker!.track({ type: "LEVEL_UP", value: newLevel });
    });

    // WIRE 5: WeaponEngine -> VFXEngine, CombatFeedback, AchievementTracker
    this.weaponEngine!.onWeaponHit.add((event: { position: BABYLON.Vector3; damage: number; isCritical: boolean; enemyId: string; weaponId: string }) => {
      this.combatFeedback!.spawnDamageText(event.position, event.damage, event.isCritical);
      this.audioFXEngine!.playSound("weapon_hit", event.position, "COMBAT_FX");
      const vfxType = this._getWeaponVFXType(event.weaponId);
      this.vfxEngine!.emit(vfxType, event.position, event.isCritical ? 1.5 : 1.0);
      if (event.isCritical) {
        this.postProcessingPipeline!.triggerShake(0.3, 0.15);
        this.triggerHitFreeze();
      }
      const enemy = this.swarmAI!.getActiveEnemies().find((e) => e.id === event.enemyId);
      if (enemy && enemy.health <= 0) {
        this.achievementTracker!.track({ type: "KILL", value: 1, metadata: { enemyType: enemy.type, weaponId: event.weaponId } });
        this.xpDropSystem!.spawnGem(enemy.position, this._calculateXPDrop(enemy));
        if (enemy.type === "BLOODLORD" || enemy.type === "FALLEN") {
          this.lootChestSystem!.spawnChest(enemy.position, "RARE");
        }
      }
    });

    // WIRE 6: BossDirector -> SwarmAI, SpriteAnimator, VFXEngine, LootChestSystem, PostProcessingPipeline
    this.bossDirector!.onBossSpawned.add((boss: BossEntity) => {
      this.swarmAI!.setSpawnerActive(false);
      this.collisionSystem!.registerCollider({
        id: boss.id,
        mesh: boss.mesh,
        bounds: boss.mesh.getBoundingInfo().boundingBox,
        velocity: boss.velocity,
        isStatic: false,
        onCollision: (other: Collidable, normal: BABYLON.Vector3) => {
          if (other.id === "player") {
            const damage = this._calculateBossDamage(boss);
            this.playerController!.takeDamage(damage);
            this.combatFeedback!.spawnDamageText(this.playerController!.position, damage, false);
            this.audioFXEngine!.playSound("boss_hit_player", this.playerController!.position, "COMBAT_FX");
          }
        },
      });
      this.postProcessingPipeline!.triggerChromaticAberration(1.0, 2.0);
      this.audioFXEngine!.playSound("boss_spawn", boss.position, "COMBAT_FX");
      this.achievementTracker!.track({ type: "BOSS_KILL", value: 0, metadata: { bossType: "BUTCHER", phase: "spawn" } });
    });

    this.bossDirector!.onBossPhaseTransition.add((event: { bossId: string; oldPhase: number; newPhase: number; position: BABYLON.Vector3 }) => {
      this.vfxEngine!.emit("BOSS_PHASE_TRANSITION", event.position, 2.0);
      const boss = this.bossDirector!.getActiveBosses().find((b) => b.id === event.bossId);
      if (boss) {
        this.spriteAnimator!.play(boss as unknown as AnimatedEntity, event.newPhase === 2 ? "butcher_charge" : "butcher_boss", false);
      }
      this.postProcessingPipeline!.triggerShake(0.5, 0.5);
      this.postProcessingPipeline!.triggerChromaticAberration(0.8, 1.5);
      this.audioFXEngine!.playSound("boss_phase_transition", event.position, "COMBAT_FX");
    });

    this.bossDirector!.onBossDefeated.add((event: { bossId: string; position: BABYLON.Vector3; tier: ChestTier }) => {
      this.swarmAI!.setSpawnerActive(true);
      this.collisionSystem!.unregisterCollider(event.bossId);
      this.lootChestSystem!.spawnChest(event.position, event.tier);
      this.vfxEngine!.emit("DARK_PORTAL", event.position, 1.0);
      this.postProcessingPipeline!.triggerShake(0.8, 1.0);
      this.audioFXEngine!.playSound("boss_defeat", event.position, "COMBAT_FX");
      this.achievementTracker!.track({ type: "BOSS_KILL", value: 1, metadata: { bossType: "BUTCHER" } });
    });

    // WIRE 7: MapPickups -> XPDropSystem, CombatFeedback
    this.mapPickups!.onPropDestroyed.add((event: { propId: string; position: BABYLON.Vector3; type: PropType }) => {
      this.vfxEngine!.emit("BLOOD_SPLASH", event.position, 0.5);
      this.audioFXEngine!.playSound("prop_break", event.position, "COMBAT_FX");
      const dropRoll = Math.random();
      if (dropRoll < 0.3) this.xpDropSystem!.spawnGem(event.position, 10);
      else if (dropRoll < 0.5) this.lootChestSystem!.spawnChest(event.position, "COMMON");
      this.combatFeedback!.spawnDamageText(event.position, 0, false);
      this.triggerHitFreeze();
    });

    // WIRE 8: LootChestSystem -> ProgressionSystem, WeaponEngine, CombatFeedback
    this.lootChestSystem!.onChestOpened.add((rewards: Reward[]) => {
      for (const reward of rewards) {
        switch (reward.type) {
          case "GOLD": this.metaProgression!.spendGold(-reward.amount); break;
          case "XP": this.progressionSystem!.addXP(reward.amount); break;
          case "WEAPON_RANK": if (reward.itemId) this.weaponEngine!.upgrade(reward.itemId, 1); break;
          case "PASSIVE_RANK": if (reward.itemId) this.progressionSystem!.upgradePassive(reward.itemId, 1); break;
          case "ITEM": if (reward.itemId === "health_potion") this.playerController!.heal(reward.amount); break;
        }
      }
      this.audioFXEngine!.playSound("chest_open", this.playerController!.position, "UI");
      this.achievementTracker!.track({ type: "CHEST_OPEN", value: rewards.length });
      this.combatFeedback!.spawnDamageText(this.playerController!.position, 0, false);
    });

    // WIRE 9: PlayerController -> CombatFeedback, AchievementTracker
    this.playerController!.onDamageTaken.add((event: { damage: number; remainingHealth: number }) => {
      this.combatFeedback!.spawnDamageText(this.playerController!.position, event.damage, false);
      this.audioFXEngine!.playSound("player_hit", this.playerController!.position, "COMBAT_FX");
      this.userInterface!.setHealth(event.remainingHealth, (this.playerController as unknown as Record<string, number>).maxHealth);
      if (event.damage > 20) this.postProcessingPipeline!.triggerShake(0.2, 0.2);
      if (event.remainingHealth <= 0) this._handlePlayerDeath();
    });

    this.playerController!.onHealed.add((event: { amount: number; currentHealth: number }) => {
      this.userInterface!.setHealth(event.currentHealth, (this.playerController as unknown as Record<string, number>).maxHealth);
      this.audioFXEngine!.playSound("player_heal", this.playerController!.position, "COMBAT_FX");
    });

    // WIRE 10: GameFlowController -> PauseMenu, AudioFXEngine
    this.gameFlowController!.onStateChange.add((state: GameState) => {
      if (state === "GAME_OVER") this._handleGameOver();
    });

    console.log("[DiabloSurvivorsEngine] Handshake complete. All 12 wire bundles connected.");
  }

  // ============================================================
  // MASTER 60FPS RENDER LOOP
  // ============================================================

  private _renderLoop(): void {
    const now = performance.now();
    this._deltaTime = now - this._lastFrameTime;
    this._lastFrameTime = now;

    if (!this._isBootComplete) {
      this._renderLoadingScreen();
      this._animationFrameId = requestAnimationFrame(this._renderLoop.bind(this));
      return;
    }

    if (this._hitFreezeFrames > 0) {
      this._hitFreezeFrames--;
      this._hitFreezeTimeScale = this._hitFreezeScale;
      if (this._hitFreezeFrames <= 0) this._hitFreezeTimeScale = 1.0;
    } else {
      this._hitFreezeTimeScale = 1.0;
    }

    const scaledDeltaTime = this._deltaTime * this._hitFreezeTimeScale;
    this._accumulatedTime += scaledDeltaTime;

    const isPaused = this.gameFlowController!.isPaused;
    const isLevelUpOpen = this.levelUpInterface!.isOpen;
    const isPauseMenuVisible = this.pauseMenu!.isVisible;

    if (isPaused || isLevelUpOpen || isPauseMenuVisible) {
      this.userInterface?.update(scaledDeltaTime);
      this.levelUpInterface?.update(scaledDeltaTime);
      this.pauseMenu?.update(scaledDeltaTime);
      this._updateJoystickState();
      this.audioFXEngine?.update(this.camera!.position);
      this.scene!.render();
      this._animationFrameId = requestAnimationFrame(this._renderLoop.bind(this));
      return;
    }

    // ACTIVE GAMEPLAY: Strict sequential dependency order
    this._updateJoystickState();
    this.playerController!.update(scaledDeltaTime);

    const pPos = this.playerController!.position;
    this.swarmAI!.update(scaledDeltaTime, pPos);
    this.bossDirector!.update(scaledDeltaTime, pPos);
    this.collisionSystem!.resolveCollisions(scaledDeltaTime);

    const enemies = this.swarmAI!.getActiveEnemies();
    this.weaponEngine!.update(scaledDeltaTime, pPos, enemies);

    this.vfxEngine!.update(scaledDeltaTime);
    this.xpDropSystem!.update(scaledDeltaTime, pPos, this.playerController!.magnetRadius);
    this.mapPickups!.update(scaledDeltaTime);
    this.lootChestSystem!.update(scaledDeltaTime);

    this.combatFeedback!.update(scaledDeltaTime);
    this.spriteAnimator!.update(scaledDeltaTime);

    this.mapEngine!.updateRoofCulling(pPos);
    this.audioFXEngine!.update(pPos);
    this.postProcessingPipeline!.update(scaledDeltaTime);

    this.userInterface!.update(scaledDeltaTime);
    this.userInterface!.setHealth(this.playerController!.health, (this.playerController as unknown as Record<string, number>).maxHealth);
    this.userInterface!.setXP(this.progressionSystem!.getStats().currentXP, this.progressionSystem!.getStats().maxXP);

    if (Math.floor(this._accumulatedTime / 1000) % 5 === 0) {
      this._checkPeriodicAchievements();
    }

    this.scene!.render();
    this._animationFrameId = requestAnimationFrame(this._renderLoop.bind(this));
  }

  private _renderLoadingScreen(): void {
    if (!this.canvas) return;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#8b0000";
    ctx.font = "bold 48px serif";
    ctx.textAlign = "center";
    ctx.fillText("DIABLO SURVIVORS", this.canvas.width / 2, this.canvas.height / 2 - 40);
    const barWidth = 400;
    const barHeight = 20;
    const barX = (this.canvas.width - barWidth) / 2;
    const barY = this.canvas.height / 2 + 20;
    const progress = this.assetPipeline ? 0.5 : 0.0;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(barX, barY, barWidth, barHeight);
    ctx.fillStyle = "#8b0000";
    ctx.fillRect(barX, barY, barWidth * progress, barHeight);
    ctx.fillStyle = "#666";
    ctx.font = "16px monospace";
    ctx.fillText(this._bootError ? `ERROR: ${this._bootError.message}` : "Loading assets...", this.canvas.width / 2, barY + 40);
  }

  private _updateJoystickState(): void {
    // Hook for additional joystick processing (haptics, replay, etc.)
  }

  // ============================================================
  // EVENT HANDLERS
  // ============================================================

  private _handleEnemyAttackEvent(event: AttackEvent): void {
    console.log(`[DiabloSurvivorsEngine] Enemy attack: ${event.attackerType} -> ${event.damage} dmg`);
  }

  private _handleLevelUp(newLevel: number): void {
    console.log(`[DiabloSurvivorsEngine] Level up handled: ${newLevel}`);
  }

  private _handleUpgradeSelection(option: UpgradeOption): void {
    switch (option.type) {
      case "WEAPON": this.weaponEngine!.equip(this._getWeaponData(option.id)); break;
      case "PASSIVE": this.progressionSystem!.addPassive(option.id); break;
      case "EVOLUTION": this.weaponEngine!.evolveWeapon(option.id); break;
    }
    this.gameFlowController!.isPaused = false;
    this.levelUpInterface!.close();
    this.audioFXEngine!.setBusVolume("COMBAT_FX", 1.0);
    this.audioFXEngine!.setBusVolume("AMBIENCE", 1.0);
    this.audioFXEngine!.playSound("upgrade_select", undefined, "UI");
  }

  private _handlePlayerDeath(): void {
    this.gameFlowController!.setState("GAME_OVER");
    this.audioFXEngine!.setBusVolume("COMBAT_FX", 0.0);
    this.audioFXEngine!.playSound("player_death", this.playerController!.position, "COMBAT_FX");
    this.postProcessingPipeline!.triggerChromaticAberration(1.0, 3.0);
    this.postProcessingPipeline!.enable("FILM_GRAIN");
    this.saveSystem!.save("last_run", {
      timestamp: Date.now(),
      level: this.progressionSystem!.getLevel(),
      kills: this.achievementTracker!.getProgress("total_kills"),
      time: this._accumulatedTime / 1000,
      archetype: this.playerController!.archetype.id,
    }).catch(() => {});
  }

  private _handleGameOver(): void {
    this.userInterface!.hide();
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private _getDefaultArchetype(): CharacterArchetype {
    return {
      id: "heretic",
      name: "The Heretic",
      portraitIndex: 0,
      movementSpeedMod: 1.10,
      damageMod: 1.0,
      armorMod: 0,
      mobilityMod: 1.0,
      critChanceMod: 0.0,
      startingWeapon: "sinners_quills",
      unlocked: true,
    };
  }

  private _getStartingWeaponData(weaponId: string): WeaponData | null {
    const db: Record<string, WeaponData> = {
      sinners_quills: { id: "sinners_quills", name: "Sinner's Quills", baseDamage: 12, cooldown: 0.8, projectileSpeed: 15, range: 20, rank: 1, maxRank: 5, pairedPassive: "blood_onyx" },
      unholy_orbit: { id: "unholy_orbit", name: "Unholy Orbit", baseDamage: 8, cooldown: 1.2, projectileSpeed: 10, range: 12, rank: 1, maxRank: 5, pairedPassive: "spellbinders_ring" },
      judgment_radiance: { id: "judgment_radiance", name: "Judgment Radiance", baseDamage: 15, cooldown: 1.5, projectileSpeed: 12, range: 18, rank: 1, maxRank: 5, pairedPassive: "gothic_plate" },
      whirling_halberds: { id: "whirling_halberds", name: "Whirling Halberds", baseDamage: 18, cooldown: 1.0, projectileSpeed: 8, range: 10, rank: 1, maxRank: 5, pairedPassive: "flayers_edge" },
    };
    return db[weaponId] ?? null;
  }

  private _getWeaponData(weaponId: string): WeaponData {
    return this._getStartingWeaponData(weaponId) ?? { id: weaponId, name: "Unknown Weapon", baseDamage: 10, cooldown: 1.0, projectileSpeed: 10, range: 15, rank: 1, maxRank: 5 };
  }

  private _getWeaponVFXType(weaponId: string): VFXType {
    const map: Record<string, VFXType> = {
      sinners_quills: "BLOOD_SPLASH",
      whirling_halberds: "BLOOD_SPLASH",
      zealots_chain: "LIGHTNING_STRIKE",
      unholy_orbit: "DARK_PORTAL",
      grave_burst: "FIRE_BURST",
      blood_siphon: "SOUL_DRAIN",
      abyssal_rift: "DARK_PORTAL",
      font_of_torment: "FIRE_BURST",
      plague_swarm: "PLAGUE_CLOUD",
      grave_chill: "ICE_SHARD",
    };
    return map[weaponId] ?? "BLOOD_SPLASH";
  }

  private _calculateEnemyDamage(enemy: EnemyEntity): number {
    const base: Record<EnemyType, number> = { SKELETON: 8, SUCCUBUS: 12, BUTCHER: 25, BLOODLORD: 15, FALLEN: 10 };
    const damage = base[enemy.type] ?? 10;
    const armor = (this.playerController as unknown as Record<string, number>)?.armor ?? 0;
    return Math.max(1, damage - armor);
  }

  private _calculateBossDamage(boss: BossEntity): number {
    const baseDamage = boss.phase === 2 ? 40 : 25;
    const armor = (this.playerController as unknown as Record<string, number>)?.armor ?? 0;
    return Math.max(1, baseDamage - armor);
  }

  private _calculateXPDrop(enemy: EnemyEntity): number {
    const base: Record<EnemyType, number> = { SKELETON: 5, SUCCUBUS: 10, BUTCHER: 100, BLOODLORD: 20, FALLEN: 8 };
    return base[enemy.type] ?? 5;
  }

  private _generateUpgradeOptions(level: number): UpgradeOption[] {
    const inventory = this.weaponEngine!.getInventory();
    const passives = this.progressionSystem!.getPassives();
    const options: UpgradeOption[] = [];

    for (const weapon of inventory) {
      if (weapon.rank < weapon.maxRank) {
        options.push({
          id: weapon.id,
          name: `${weapon.name} +${weapon.rank + 1}`,
          description: `Increase ${weapon.name} damage and reduce cooldown.`,
          iconPath: `ui_kit.png#weapon_${weapon.id}`,
          type: "WEAPON",
          rarity: this._getRarityForRank(weapon.rank + 1),
        });
      }
    }

    for (const passive of passives) {
      if (passive.rank < 5) {
        options.push({
          id: passive.id,
          name: `${passive.name} +${passive.rank + 1}`,
          description: `Enhance ${passive.name} effect.`,
          iconPath: `ui_kit.png#passive_${passive.id}`,
          type: "PASSIVE",
          rarity: this._getRarityForRank(passive.rank + 1),
        });
      }
    }

    for (const weapon of inventory) {
      if (weapon.rank === 5 && weapon.pairedPassive) {
        const paired = passives.find((p) => p.id === weapon.pairedPassive);
        if (paired && paired.rank === 5) {
          options.push({
            id: weapon.evolutionId ?? `${weapon.id}_evolved`,
            name: this._getEvolutionName(weapon.id),
            description: `Ultimate evolution of ${weapon.name}.`,
            iconPath: `ui_kit.png#evolution_${weapon.id}`,
            type: "EVOLUTION",
            rarity: "LEGENDARY",
          });
        }
      }
    }

    options.sort(() => Math.random() - 0.5);
    return options.slice(0, 3);
  }

  private _getRarityForRank(rank: number): "COMMON" | "RARE" | "EPIC" | "LEGENDARY" {
    if (rank <= 2) return "COMMON";
    if (rank <= 3) return "RARE";
    if (rank <= 4) return "EPIC";
    return "LEGENDARY";
  }

  private _getEvolutionName(weaponId: string): string {
    const names: Record<string, string> = {
      sinners_quills: "Phantom Barrage",
      whirling_halberds: "Iron Fortress",
      judgment_radiance: "Heaven's Wrath",
      unholy_orbit: "Skeletal Cataclysm",
      grave_burst: "Corpse Nova",
      blood_siphon: "Sanguine Vortex",
      abyssal_rift: "Doomsday Singularity",
      font_of_torment: "Desecrated Wake",
      plague_swarm: "Pandemic Infestation",
      grave_chill: "Absolute Zero",
    };
    return names[weaponId] ?? "Unknown Evolution";
  }

  private _checkPeriodicAchievements(): void {
    const totalKills = this.achievementTracker!.getProgress("total_kills");
    if (totalKills >= 100 && !this.achievementTracker!.isUnlocked("kill_100")) {
      this.achievementTracker!.track({ type: "KILL", value: 100 });
    }
  }

  // ============================================================
  // EVENT BUS
  // ============================================================

  public on(event: string, callback: (data: unknown) => void): void {
    if (!this._eventBus.has(event)) this._eventBus.set(event, []);
    this._eventBus.get(event)!.push(callback);
  }

  public off(event: string, callback: (data: unknown) => void): void {
    const listeners = this._eventBus.get(event);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index !== -1) listeners.splice(index, 1);
    }
  }

  public emit(event: string, data: unknown): void {
    const listeners = this._eventBus.get(event);
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (err) {
          console.error(`[DiabloSurvivorsEngine] Event handler error for '${event}':`, err);
        }
      }
    }
  }
}

// ============================================================
// EXPORT
// ============================================================

export { DiabloSurvivorsEngine };
export type {
  GameState,
  CharacterArchetype,
  AudioBus,
  PostEffect,
  WeaponData,
  EnemyEntity,
  EnemyType,
  EnemyState,
  BossEntity,
  AttackEvent,
  WaveConfig,
  UpgradeOption,
  ChestTier,
  LootChest,
  Reward,
  AchievementEvent,
  Achievement,
  MetaUpgrade,
  PropType,
  PropEntity,
  Collidable,
  AnimatedEntity,
  VFXType,
  SpriteSheetData,
};
