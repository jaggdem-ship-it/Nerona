/**
 * =============================================================================
 * GAMEFLOW CONTROLLER — Gothic Horde-Survival Rogue-Lite Engine
 * =============================================================================
 * A centralized state machine and scene orchestrator for a Vampire Survivors–
 * style horde-survival game set in a dark, gothic Diablo-inspired universe.
 *
 * Responsibilities (strictly high-level):
 *   • Operational lifecycle state management (5 explicit engine states)
 *   • Scene-swapping with deterministic cleanup & memory hygiene
 *   • Asynchronous biome transition loading screens with VRAM progress
 *   • Win/loss conditional hooks (30:00 victory | 0 HP defeat)
 *   • Canvas visibility handshakes and render-loop gatekeeping
 *
 * Dependencies:  Babylon.js (core, GUI, loaders), ES2020+
 * Architecture:    Event-driven observer pattern + strict finite-state machine
 * =============================================================================
 */

import {
  Engine,
  Scene,
  Observable,
  Observer,
  ParticleSystem,
  ThinEngine,
  AbstractMesh,
  TransformNode,
  KeyboardEventTypes,
  Nullable,
} from "@babylonjs/core";

// ─────────────────────────────────────────────────────────────────────────────
// §1  TYPE DEFINITIONS & DOMAIN MODELS
// ─────────────────────────────────────────────────────────────────────────────

/** The five canonical operational engine states. */
export enum EngineState {
  BOOT = "BOOT",
  MAIN_MENU = "MAIN_MENU",
  CHARACTER_SELECT = "CHARACTER_SELECT",
  GAMEPLAY_ACTIVE = "GAMEPLAY_ACTIVE",
  GAME_OVER_SUMMARY = "GAME_OVER_SUMMARY",
}

/** Discriminated union for state-transition metadata. */
export type StateTransition =
  | { from: EngineState.BOOT; to: EngineState.MAIN_MENU; trigger: "bootComplete" }
  | { from: EngineState.MAIN_MENU; to: EngineState.CHARACTER_SELECT; trigger: "startCharacterSelect" }
  | { from: EngineState.MAIN_MENU; to: EngineState.GAMEPLAY_ACTIVE; trigger: "quickStart" }
  | { from: EngineState.CHARACTER_SELECT; to: EngineState.GAMEPLAY_ACTIVE; trigger: "characterConfirmed" }
  | { from: EngineState.GAMEPLAY_ACTIVE; to: EngineState.GAME_OVER_SUMMARY; trigger: "playerDefeated" | "victoryAchieved" }
  | { from: EngineState.GAME_OVER_SUMMARY; to: EngineState.MAIN_MENU; trigger: "returnToMenu" }
  | { from: EngineState.GAME_OVER_SUMMARY; to: EngineState.GAMEPLAY_ACTIVE; trigger: "restartRun" }
  | { from: EngineState.GAMEPLAY_ACTIVE; to: EngineState.GAMEPLAY_ACTIVE; trigger: "biomeTransition" };

/** Payload broadcast when the engine changes state. */
export interface StateChangePayload {
  previous: EngineState;
  current: EngineState;
  transition: StateTransition;
  timestamp: number;
}

/** Biome descriptor used during async loading transitions. */
export interface BiomeDescriptor {
  id: string;
  displayName: string;
  atlasManifest: AssetAtlasManifest;
  thematicColor: string; // hex, e.g. "#1a0a2e" for Courtyard, "#0d0d0d" for Dungeon
  ambientTrack?: string;
}

/** Manifest of texture atlases & sprite sheets to VRAM-load for a biome. */
export interface AssetAtlasManifest {
  textureAtlases: Array<{
    url: string;
    alias: string;
    estimatedBytes: number;
  }>;
  spriteSheets: Array<{
    url: string;
    alias: string;
    frameWidth: number;
    frameHeight: number;
    estimatedBytes: number;
  }>;
  shaderPrograms: Array<{
    name: string;
    vertexUrl?: string;
    fragmentUrl?: string;
    vertexSource?: string;
    fragmentSource?: string;
  }>;
}

/** Survival metrics displayed on the GAME_OVER_SUMMARY panel. */
export interface SurvivalMetrics {
  elapsedSeconds: number;
  enemiesSlain: number;
  damageDealt: number;
  damageTaken: number;
  levelsGained: number;
  goldCollected: number;
  longestCombo: number;
  biomesVisited: string[];
}

/** Loading progress snapshot. */
export interface LoadProgress {
  phase: "preparing" | "downloading" | "uploadingVRAM" | "spawning" | "complete";
  percent: number; // 0–100
  bytesLoaded: number;
  bytesTotal: number;
  currentAssetAlias: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// §2  SCENE CONTRACT — Every scene must implement this interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle contract enforced on all game scenes.
 * The GameFlowController owns the swap; the scene owns its internals.
 */
export interface IGameScene {
  readonly name: string;
  readonly scene: Scene;

  /** Called once when the scene is first created (constructor time). */
  initialize(): Promise<void>;

  /** Called every time this scene becomes the active visible scene. */
  onEnter(previousScene: Nullable<IGameScene>): Promise<void>;

  /** Called every time this scene is being swapped away from. */
  onExit(nextScene: Nullable<IGameScene>): Promise<void>;

  /**
   * Deterministic cleanup: unbind inputs, halt particles, flush thin instances,
   * dispose transient meshes, drop GPU buffers, etc.
   */
  dispose(): void;

  /** Optional: pause internal simulation (e.g. when loading overlay is up). */
  pause?(): void;

  /** Optional: resume internal simulation. */
  resume?(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// §3  EVENT BUS — Decoupled intra-engine communication
// ─────────────────────────────────────────────────────────────────────────────

/** Lightweight typed event bus for cross-module pub/sub. */
export class GameEventBus {
  private _channels: Map<string, Observable<any>> = new Map();

  /** Subscribe to an event channel. Returns an Observer handle for unsubscription. */
  on<T>(channel: string, callback: (payload: T) => void): Observer<T> {
    if (!this._channels.has(channel)) {
      this._channels.set(channel, new Observable<T>());
    }
    return this._channels.get(channel)!.add(callback);
  }

  /** Emit an event to all subscribers. */
  emit<T>(channel: string, payload: T): void {
    this._channels.get(channel)?.notifyObservers(payload);
  }

  /** Remove every subscriber from a channel. */
  clear(channel: string): void {
    const obs = this._channels.get(channel);
    if (obs) {
      obs.clear();
      this._channels.delete(channel);
    }
  }

  /** Nuke every channel (nuclear option during full engine reset). */
  clearAll(): void {
    this._channels.forEach((obs) => obs.clear());
    this._channels.clear();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §4  LOADING SCREEN OVERLAY — Thematic veil with progress instrumentation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Manages the DOM-based loading overlay shown during biome transitions.
 * Decoupled from Babylon GUI so it survives engine pauses & canvas swaps.
 */
export class LoadingScreenOverlay {
  private _container: HTMLDivElement | null = null;
  private _progressBar: HTMLDivElement | null = null;
  private _progressText: HTMLSpanElement | null = null;
  private _phaseLabel: HTMLSpanElement | null = null;
  private _biomeTitle: HTMLHeadingElement | null = null;
  private _isVisible = false;

  constructor(private readonly _parentElement: HTMLElement) {}

  /** Build the DOM skeleton once. */
  mount(): void {
    if (this._container) return;

    const container = document.createElement("div");
    container.id = "gfc-loading-veil";
    container.style.cssText = `
      position: fixed; inset: 0; z-index: 9999;
      display: none; flex-direction: column;
      align-items: center; justify-content: center;
      background: radial-gradient(circle at 50% 50%, #0a0a0a 0%, #000000 100%);
      font-family: 'Cinzel', 'Georgia', serif;
      transition: opacity 0.6s cubic-bezier(0.4,0,0.2,1);
      opacity: 0; pointer-events: none;
    `;

    container.innerHTML = `
      <div id="gfc-loading-content" style="text-align:center; max-width:520px; width:90%;">
        <h2 id="gfc-biome-title" style="
          color: #c9a227; font-size: 2rem; margin-bottom: 8px;
          text-shadow: 0 0 20px rgba(201,162,39,0.3);
          letter-spacing: 2px; text-transform: uppercase;
        ">Traversing the Veil…</h2>
        <p id="gfc-phase-label" style="
          color: #888; font-size: 0.9rem; margin-bottom: 32px;
          letter-spacing: 1px;
        ">Preparing dark energies…</p>
        <div style="
          width: 100%; height: 4px; background: #1a1a1a;
          border-radius: 2px; overflow: hidden; margin-bottom: 16px;
          box-shadow: 0 0 10px rgba(201,162,39,0.1);
        ">
          <div id="gfc-progress-bar" style="
            width: 0%; height: 100%; background: linear-gradient(90deg, #8b0000, #c9a227);
            transition: width 0.25s ease-out; border-radius: 2px;
          "></div>
        </div>
        <div style="display:flex; justify-content:space-between; color:#666; font-size:0.75rem;">
          <span id="gfc-progress-text">0 MB / 0 MB</span>
          <span id="gfc-progress-percent">0%</span>
        </div>
        <div id="gfc-loading-flavor" style="
          margin-top: 48px; color: #444; font-size: 0.8rem;
          font-style: italic; min-height: 1.2em;
        "></div>
      </div>
    `;

    this._parentElement.appendChild(container);
    this._container = container;
    this._progressBar = container.querySelector("#gfc-progress-bar") as HTMLDivElement;
    this._progressText = container.querySelector("#gfc-progress-text") as HTMLSpanElement;
    this._phaseLabel = container.querySelector("#gfc-phase-label") as HTMLSpanElement;
    this._biomeTitle = container.querySelector("#gfc-biome-title") as HTMLHeadingElement;
  }

  /** Show the veil and optionally set thematic color. */
  show(biome?: BiomeDescriptor): void {
    if (!this._container) this.mount();
    if (biome) {
      this._biomeTitle!.textContent = biome.displayName;
      this._container!.style.background = `radial-gradient(circle at 50% 50%, ${biome.thematicColor} 0%, #000000 100%)`;
    }
    this._container!.style.display = "flex";
    // Force reflow for transition
    void this._container!.offsetHeight;
    this._container!.style.opacity = "1";
    this._container!.style.pointerEvents = "auto";
    this._isVisible = true;
  }

  /** Update progress bar and labels. */
  updateProgress(progress: LoadProgress): void {
    if (!this._isVisible || !this._progressBar) return;

    this._progressBar.style.width = `${progress.percent}%`;
    (this._container!.querySelector("#gfc-progress-percent") as HTMLSpanElement).textContent =
      `${Math.round(progress.percent)}%`;

    const loadedMB = (progress.bytesLoaded / 1024 / 1024).toFixed(1);
    const totalMB = (progress.bytesTotal / 1024 / 1024).toFixed(1);
    this._progressText!.textContent = `${loadedMB} MB / ${totalMB} MB`;

    const phaseLabels: Record<LoadProgress["phase"], string> = {
      preparing: "Preparing dark energies…",
      downloading: `Downloading ${progress.currentAssetAlias}…`,
      uploadingVRAM: `Binding ${progress.currentAssetAlias} to VRAM…`,
      spawning: "Summoning entities into the fold…",
      complete: "The veil parts…",
    };
    this._phaseLabel!.textContent = phaseLabels[progress.phase];

    // Rotating flavor text based on phase
    const flavor = this._container!.querySelector("#gfc-loading-flavor") as HTMLDivElement;
    const flavors: Record<LoadProgress["phase"], string[]> = {
      preparing: ["The candles flicker…", "Whispers echo from beyond…", "The hour grows late…"],
      downloading: ["Glyphs materialize from the aether…", "Ancient textures stir…", "Runes align…"],
      uploadingVRAM: ["The GPU awakens…", "VRAM hungers for pixels…", "Shader spirits bind…"],
      spawning: ["Skeletons rattle to life…", "Blood pools coalesce…", "The horde gathers…"],
      complete: ["Enter, if you dare…", "The darkness welcomes you…", "Your fate awaits…"],
    };
    const pool = flavors[progress.phase];
    flavor.textContent = pool[Math.floor(Math.random() * pool.length)];
  }

  /** Hide with fade-out. Returns a Promise resolved after transition. */
  hide(): Promise<void> {
    return new Promise((resolve) => {
      if (!this._container || !this._isVisible) {
        resolve();
        return;
      }
      this._container.style.opacity = "0";
      this._container.style.pointerEvents = "none";
      setTimeout(() => {
        this._container!.style.display = "none";
        this._isVisible = false;
        resolve();
      }, 600);
    });
  }

  /** Destroy DOM elements. */
  dispose(): void {
    if (this._container && this._container.parentNode) {
      this._container.parentNode.removeChild(this._container);
    }
    this._container = null;
    this._progressBar = null;
    this._progressText = null;
    this._phaseLabel = null;
    this._biomeTitle = null;
    this._isVisible = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §5  MEMORY HYGIENE UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Static utility class for aggressive, deterministic memory cleanup.
 * Invoked during every scene transition to prevent long-term GPU/JS leaks.
 */
export class MemoryHygiene {
  /**
   * Unbind all keyboard observables on a Babylon scene.
   * This prevents phantom input after scene swaps.
   */
  static unbindKeyboardListeners(scene: Scene): void {
    // Remove native Babylon keyboard observers
    scene.onKeyboardObservable.clear();

    // Null-out any cached key-state maps held by game systems
    // (Systems that track `isKeyDown` maps should listen to state-change events
    //  and clear themselves; this is a safety net.)
    (scene as any).__gfc_keyStateMap = null;
  }

  /**
   * Halt and dispose every active ParticleSystem in the scene.
   * Does NOT dispose the underlying texture atlas (shared across biomes).
   */
  static haltParticleEmitters(scene: Scene): void {
    const systems = scene.particleSystems.slice(); // copy before mutation
    for (const ps of systems) {
      ps.stop();
      ps.reset();
      // Only dispose if the system is marked transient; persistent VFX
      // (e.g. ambient torches) should be flagged and skipped.
      if ((ps as any).__gfc_transient === true) {
        ps.dispose();
      }
    }
  }

  /**
   * Flush thin-instance matrices and dispose thin-instance buffers.
   * Critical when hundreds of enemy instances are rendered via thin instances.
   */
  static flushThinInstanceArrays(scene: Scene): void {
    for (const mesh of scene.meshes) {
      if (mesh.thinInstanceCount > 0) {
        mesh.thinInstanceCount = 0;
        // Force buffer refresh
        if ((mesh as any)._thinInstanceDataStorage) {
          (mesh as any)._thinInstanceDataStorage.matrixData = null;
          (mesh as any)._thinInstanceDataStorage.colorData = null;
        }
      }
    }
  }

  /**
   * Dispose transient meshes, materials, and textures that are biome-specific.
   * Preserves shared assets (UI chrome, persistent shaders, font textures).
   */
  static purgeTransientAssets(scene: Scene): void {
    // Meshes flagged as transient
    const toDispose: AbstractMesh[] = [];
    for (const mesh of scene.meshes) {
      if ((mesh as any).__gfc_transient === true) {
        toDispose.push(mesh);
      }
    }
    toDispose.forEach((m) => m.dispose(false, true));

    // Materials flagged as transient
    for (const mat of scene.materials) {
      if ((mat as any).__gfc_transient === true) {
        mat.dispose(true, true); // forceDisposeTextures = true for biome mats
      }
    }
  }

  /**
   * Nullify cross-reference pointers on the scene object to assist GC.
   * Does NOT dispose the scene itself — that is the responsibility of
   * the scene factory on full engine reset.
   */
  static scrubSceneReferences(scene: Scene): void {
    (scene as any).__gfc_entityManager = null;
    (scene as any).__gfc_spellManager = null;
    (scene as any).__gfc_lootManager = null;
    (scene as any).__gfc_waveManager = null;
    (scene as any).__gfc_pathfinder = null;
  }

  /**
   * Cooperative garbage-collection hint.
   * In environments where `gc()` is exposed (e.g. Electron, debug builds),
   * invoke it. Otherwise rely on engine texture GC.
   */
  static requestGarbageCollection(): void {
    // Hint V8 to collect
    if (typeof (globalThis as any).gc === "function") {
      try {
        (globalThis as any).gc();
      } catch {
        /* noop — gc() not guaranteed */
      }
    }
    // Clear any dangling object pools
    if ((globalThis as any).__gfc_objectPools) {
      for (const pool of Object.values((globalThis as any).__gfc_objectPools)) {
        (pool as any[]).length = 0;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §6  ASSET ATLAS LOADER — VRAM-bound progress tracking
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads texture atlases and sprite sheets into Babylon's VRAM while
 * reporting granular progress to the LoadingScreenOverlay.
 */
export class AssetAtlasLoader {
  constructor(
    private readonly _engine: Engine,
    private readonly _onProgress: (p: LoadProgress) => void
  ) {}

  async loadManifest(manifest: AssetAtlasManifest): Promise<void> {
    const bytesTotal =
      manifest.textureAtlases.reduce((s, a) => s + a.estimatedBytes, 0) +
      manifest.spriteSheets.reduce((s, a) => s + a.estimatedBytes, 0);

    let bytesLoaded = 0;

    const report = (
      phase: LoadProgress["phase"],
      alias: string,
      deltaBytes: number
    ) => {
      bytesLoaded += deltaBytes;
      this._onProgress({
        phase,
        percent: Math.min(100, (bytesLoaded / bytesTotal) * 100),
        bytesLoaded,
        bytesTotal,
        currentAssetAlias: alias,
      });
    };

    // Phase: preparing
    this._onProgress({
      phase: "preparing",
      percent: 0,
      bytesLoaded: 0,
      bytesTotal,
      currentAssetAlias: "manifest",
    });

    // 1. Texture Atlases
    for (const atlas of manifest.textureAtlases) {
      report("downloading", atlas.alias, 0);
      await this._loadTexture(atlas.url, atlas.alias);
      report("uploadingVRAM", atlas.alias, atlas.estimatedBytes);
    }

    // 2. Sprite Sheets
    for (const sheet of manifest.spriteSheets) {
      report("downloading", sheet.alias, 0);
      await this._loadSpriteSheet(sheet);
      report("uploadingVRAM", sheet.alias, sheet.estimatedBytes);
    }

    // 3. Shader Programs (compile & link)
    for (const shader of manifest.shaderPrograms) {
      report("downloading", shader.name, 0);
      // Compilation happens lazily in Babylon, but we can pre-warm here
      // by creating a dummy Effect.
      await this._prewarmShader(shader);
      report("uploadingVRAM", shader.name, 1024 * 1024); // nominal 1MB
    }

    // Phase: spawning (reserved for scene-specific entity spawn)
    report("spawning", "entities", 0);
  }

  private async _loadTexture(url: string, alias: string): Promise<void> {
    const scene = this._engine.scenes[0];
    if (!scene) return;
    // Use Babylon's TextureAssetTask equivalent or raw Texture
    const { Texture } = await import("@babylonjs/core");
    const tex = new Texture(url, scene, false, true);
    return new Promise((resolve, reject) => {
      tex.onLoadObservable.addOnce(() => resolve());
      tex.onErrorObservable.addOnce((_, err) => reject(err));
    });
  }

  private async _loadSpriteSheet(sheet: AssetAtlasManifest["spriteSheets"][0]): Promise<void> {
    // Sprite sheet loading is project-specific; this stub delegates to
    // the project's SpriteAtlasManager or equivalent.
    // In a real build, this would slice the sheet into frame UVs.
    await new Promise((r) => setTimeout(r, 50)); // simulate decode time
  }

  private async _prewarmShader(shader: AssetAtlasManifest["shaderPrograms"][0]): Promise<void> {
    const { Effect } = await import("@babylonjs/core");
    // Compile the shader program so first use is instant
    if (shader.vertexSource && shader.fragmentSource) {
      new Effect(
        shader.vertexSource,
        shader.fragmentSource,
        [],
        [],
        this._engine
      );
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §7  WIN / LOSS CONDITION MONITOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Monitors gameplay variables and fires victory/defeat events.
 * Decoupled from GameFlowController so it can be unit-tested in isolation.
 */
export class GameConditionMonitor {
  private _elapsedSeconds = 0;
  private _playerHealth = 100;
  private _isRunning = false;
  private _timerHandle: ReturnType<typeof setInterval> | null = null;

  /** Observable fired when the 30:00 survival threshold is reached. */
  readonly onVictory: Observable<void> = new Observable<void>();

  /** Observable fired when player health reaches 0. */
  readonly onDefeat: Observable<SurvivalMetrics> = new Observable<SurvivalMetrics>();

  /** Observable fired every second with current elapsed time. */
  readonly onTick: Observable<number> = new Observable<number>();

  /** Victory threshold in seconds (30 minutes). */
  static readonly VICTORY_TIME_SECONDS = 30 * 60; // 1800

  constructor(private readonly _eventBus: GameEventBus) {}

  /** Start monitoring (called on entering GAMEPLAY_ACTIVE). */
  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    this._elapsedSeconds = 0;
    this._playerHealth = 100; // reset for new run

    this._timerHandle = setInterval(() => {
      this._elapsedSeconds++;
      this.onTick.notifyObservers(this._elapsedSeconds);

      if (this._elapsedSeconds >= GameConditionMonitor.VICTORY_TIME_SECONDS) {
        this._triggerVictory();
      }
    }, 1000);
  }

  /** Stop monitoring (called on exiting GAMEPLAY_ACTIVE). */
  stop(): void {
    this._isRunning = false;
    if (this._timerHandle) {
      clearInterval(this._timerHandle);
      this._timerHandle = null;
    }
  }

  /** External systems call this to update player health. */
  setPlayerHealth(hp: number): void {
    this._playerHealth = Math.max(0, hp);
    if (this._playerHealth <= 0 && this._isRunning) {
      this._triggerDefeat();
    }
  }

  getPlayerHealth(): number {
    return this._playerHealth;
  }

  getElapsedSeconds(): number {
    return this._elapsedSeconds;
  }

  private _triggerVictory(): void {
    this.stop();
    this.onVictory.notifyObservers();
    this._eventBus.emit("game:victory", undefined);
  }

  private _triggerDefeat(): void {
    this.stop();
    // Build survival metrics snapshot
    const metrics: SurvivalMetrics = {
      elapsedSeconds: this._elapsedSeconds,
      enemiesSlain: (globalThis as any).__gfc_metrics?.enemiesSlain ?? 0,
      damageDealt: (globalThis as any).__gfc_metrics?.damageDealt ?? 0,
      damageTaken: (globalThis as any).__gfc_metrics?.damageTaken ?? 0,
      levelsGained: (globalThis as any).__gfc_metrics?.levelsGained ?? 0,
      goldCollected: (globalThis as any).__gfc_metrics?.goldCollected ?? 0,
      longestCombo: (globalThis as any).__gfc_metrics?.longestCombo ?? 0,
      biomesVisited: (globalThis as any).__gfc_metrics?.biomesVisited ?? [],
    };
    this.onDefeat.notifyObservers(metrics);
    this._eventBus.emit("game:defeat", metrics);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §8  MAIN CONTROLLER — GameFlowController
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The central nervous system of the engine.
 *
 * Owns:
 *   • Finite-state machine (5 EngineState values)
 *   • Scene registry & active scene pointer
 *   • Loading screen overlay lifecycle
 *   • Win/loss condition wiring
 *   • Canvas visibility handshakes
 *
 * Does NOT own:
 *   • Game logic (spawning, combat, AI)
 *   • Rendering details
 *   • Input mapping semantics
 */
export class GameFlowController {
  // ── State ────────────────────────────────────────────────────────────────
  private _currentState: EngineState = EngineState.BOOT;
  private _previousState: EngineState = EngineState.BOOT;
  private _activeScene: Nullable<IGameScene> = null;
  private _sceneRegistry: Map<EngineState, IGameScene> = new Map();
  private _isTransitioning = false;
  private _biomeStack: BiomeDescriptor[] = [];

  // ── Subsystems ───────────────────────────────────────────────────────────
  private readonly _eventBus: GameEventBus;
  private readonly _loadingOverlay: LoadingScreenOverlay;
  private readonly _conditionMonitor: GameConditionMonitor;
  private readonly _atlasLoader: AssetAtlasLoader;

  // ── Observables ──────────────────────────────────────────────────────────
  /** Fired on every state change with full transition metadata. */
  readonly onStateChange: Observable<StateChangePayload> = new Observable<StateChangePayload>();

  /** Fired when a scene transition begins. */
  readonly onTransitionStart: Observable<{ from: EngineState; to: EngineState }> =
    new Observable<{ from: EngineState; to: EngineState }>();

  /** Fired when a scene transition completes. */
  readonly onTransitionEnd: Observable<{ from: EngineState; to: EngineState }> =
    new Observable<{ from: EngineState; to: EngineState }>();

  // ── Constructor ──────────────────────────────────────────────────────────
  constructor(
    private readonly _engine: Engine,
    private readonly _canvas: HTMLCanvasElement,
    parentElement: HTMLElement = document.body
  ) {
    this._eventBus = new GameEventBus();
    this._loadingOverlay = new LoadingScreenOverlay(parentElement);
    this._conditionMonitor = new GameConditionMonitor(this._eventBus);
    this._atlasLoader = new AssetAtlasLoader(_engine, (p) =>
      this._loadingOverlay.updateProgress(p)
    );

    this._wireConditionMonitor();
    this._wireCanvasVisibility();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PUBLIC API — State Machine
  // ═══════════════════════════════════════════════════════════════════════════

  /** Current operational engine state. */
  get currentState(): EngineState {
    return this._currentState;
  }

  /** The scene currently driving the render loop. */
  get activeScene(): Nullable<IGameScene> {
    return this._activeScene;
  }

  /** Expose the event bus for cross-module communication. */
  get eventBus(): GameEventBus {
    return this._eventBus;
  }

  /** Expose the condition monitor for health/time queries. */
  get conditionMonitor(): GameConditionMonitor {
    return this._conditionMonitor;
  }

  /**
   * Register a scene implementation against an engine state.
   * Must be called before transitioning into that state.
   */
  registerScene(state: EngineState, scene: IGameScene): void {
    this._sceneRegistry.set(state, scene);
  }

  /**
   * Initiate a state transition.
   *
   * This is the ONLY public entry-point for changing engine state.
   * It enforces:
   *   • Transition validity (guards against illegal jumps)
   *   • Sequential execution (no overlapping transitions)
   *   • Full cleanup lifecycle on the outgoing scene
   *   • Async loading veil for biome transitions
   */
  async transitionTo(
    targetState: EngineState,
    transitionMeta: Omit<StateTransition, "from" | "to">
  ): Promise<void> {
    if (this._isTransitioning) {
      console.warn(`[GFC] Transition rejected: already transitioning (${this._currentState} → ${targetState})`);
      return;
    }

    const from = this._currentState;
    const to = targetState;

    if (from === to) {
      console.warn(`[GFC] No-op transition: ${from}`);
      return;
    }

    // Validate transition
    if (!this._isValidTransition(from, to)) {
      throw new Error(`[GFC] Illegal state transition: ${from} → ${to}`);
    }

    this._isTransitioning = true;
    this.onTransitionStart.notifyObservers({ from, to });
    this._eventBus.emit("gfc:transitionStart", { from, to });

    try {
      // ── 1. Exit current scene ──
      const outgoingScene = this._activeScene;
      if (outgoingScene) {
        await this._executeSceneExit(outgoingScene, to);
      }

      // ── 2. State bookkeeping ──
      this._previousState = from;
      this._currentState = to;

      const fullTransition = { from, to, ...transitionMeta } as StateTransition;

      // ── 3. Handle special transition types ──
      if (to === EngineState.GAMEPLAY_ACTIVE && from !== EngineState.GAME_OVER_SUMMARY) {
        // Fresh gameplay start — show loading if we have a queued biome
        await this._handleGameplayEntry(from);
      } else if (fullTransition.trigger === "biomeTransition") {
        // Biome switch within active gameplay
        await this._handleBiomeTransition();
      }

      // ── 4. Enter new scene ──
      const incomingScene = this._sceneRegistry.get(to);
      if (incomingScene) {
        await this._executeSceneEnter(incomingScene, outgoingScene);
        this._activeScene = incomingScene;
      }

      // ── 5. Broadcast state change ──
      const payload: StateChangePayload = {
        previous: from,
        current: to,
        transition: fullTransition,
        timestamp: performance.now(),
      };
      this.onStateChange.notifyObservers(payload);
      this._eventBus.emit("gfc:stateChange", payload);

      // ── 6. State-specific side effects ──
      this._applyStateSideEffects(to, from);

      this.onTransitionEnd.notifyObservers({ from, to });
      this._eventBus.emit("gfc:transitionEnd", { from, to });

      console.log(`[GFC] Transition complete: ${from} → ${to}`);
    } catch (err) {
      console.error(`[GFC] Transition failed: ${from} → ${to}`, err);
      this._eventBus.emit("gfc:transitionError", { from, to, error: err });
      throw err;
    } finally {
      this._isTransitioning = false;
    }
  }

  /**
   * Queue a biome for the next gameplay session or transition.
   * The biome's atlas will be loaded before player spawn.
   */
  queueBiome(biome: BiomeDescriptor): void {
    this._biomeStack.push(biome);
    this._eventBus.emit("gfc:biomeQueued", biome);
  }

  /**
   * Hard reset the entire engine to BOOT state.
   * Used for "Return to Title" or catastrophic error recovery.
   */
  async hardReset(): Promise<void> {
    console.log("[GFC] Hard reset initiated…");

    // Stop all monitors
    this._conditionMonitor.stop();

    // Dispose active scene
    if (this._activeScene) {
      await this._executeSceneExit(this._activeScene, EngineState.BOOT);
      this._activeScene = null;
    }

    // Dispose all registered scenes
    for (const [state, scene] of this._sceneRegistry) {
      scene.dispose();
      console.log(`[GFC] Disposed scene: ${state}`);
    }
    this._sceneRegistry.clear();

    // Clear biome queue
    this._biomeStack = [];

    // Reset state
    this._previousState = EngineState.BOOT;
    this._currentState = EngineState.BOOT;

    // Nuke event bus
    this._eventBus.clearAll();

    // GC hint
    MemoryHygiene.requestGarbageCollection();

    console.log("[GFC] Hard reset complete.");
  }

  /**
   * Graceful engine shutdown.
   */
  dispose(): void {
    this._conditionMonitor.stop();
    this._loadingOverlay.dispose();
    this._eventBus.clearAll();
    this.onStateChange.clear();
    this.onTransitionStart.clear();
    this.onTransitionEnd.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — Scene Lifecycle Execution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Execute the full cleanup lifecycle on an outgoing scene.
   *
   * Order matters:
   *   1. Pause simulation (stop AI, physics, animations)
   *   2. Unbind keyboard listeners (prevent phantom input)
   *   3. Halt particle emitters
   *   4. Flush thin-instance arrays
   *   5. Purge transient assets
   *   6. Scrub cross-references
   *   7. Invoke scene.onExit()
   *   8. Request GC
   */
  private async _executeSceneExit(
    scene: IGameScene,
    nextState: EngineState
  ): Promise<void> {
    console.log(`[GFC] Exiting scene: ${scene.name}`);

    // 1. Pause
    scene.pause?.();

    // 2–6. Deterministic memory hygiene
    MemoryHygiene.unbindKeyboardListeners(scene.scene);
    MemoryHygiene.haltParticleEmitters(scene.scene);
    MemoryHygiene.flushThinInstanceArrays(scene.scene);
    MemoryHygiene.purgeTransientAssets(scene.scene);
    MemoryHygiene.scrubSceneReferences(scene.scene);

    // 7. Scene-specific exit logic
    const nextScene = this._sceneRegistry.get(nextState) ?? null;
    await scene.onExit(nextScene);

    // 8. GC hint
    MemoryHygiene.requestGarbageCollection();

    // Detach scene from engine render loop
    this._engine.stopRenderLoop();
  }

  /**
   * Execute the entry lifecycle on an incoming scene.
   *
   * Order:
   *   1. Ensure canvas is visible
   *   2. Initialize if first use
   *   3. Attach render loop
   *   4. Invoke scene.onEnter()
   *   5. Resume simulation
   */
  private async _executeSceneEnter(
    scene: IGameScene,
    previousScene: Nullable<IGameScene>
  ): Promise<void> {
    console.log(`[GFC] Entering scene: ${scene.name}`);

    // 1. Canvas handshake
    this._canvas.style.display = "block";
    this._canvas.style.visibility = "visible";

    // 2. Lazy init
    await scene.initialize();

    // 3. Attach render loop
    this._engine.runRenderLoop(() => {
      scene.scene.render();
    });

    // 4. Scene-specific enter logic
    await scene.onEnter(previousScene);

    // 5. Resume
    scene.resume?.();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — Transition Guards & Validation
  // ═══════════════════════════════════════════════════════════════════════════

  private _isValidTransition(from: EngineState, to: EngineState): boolean {
    const validEdges: Record<EngineState, EngineState[]> = {
      [EngineState.BOOT]: [EngineState.MAIN_MENU],
      [EngineState.MAIN_MENU]: [EngineState.CHARACTER_SELECT, EngineState.GAMEPLAY_ACTIVE],
      [EngineState.CHARACTER_SELECT]: [EngineState.GAMEPLAY_ACTIVE, EngineState.MAIN_MENU],
      [EngineState.GAMEPLAY_ACTIVE]: [
        EngineState.GAME_OVER_SUMMARY,
        EngineState.GAMEPLAY_ACTIVE, // biome transition self-loop
      ],
      [EngineState.GAME_OVER_SUMMARY]: [EngineState.MAIN_MENU, EngineState.GAMEPLAY_ACTIVE],
    };
    return validEdges[from]?.includes(to) ?? false;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — Gameplay Entry & Biome Transitions
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handles the transition into GAMEPLAY_ACTIVE from non-gameplay states.
   * Shows loading veil, loads biome atlases, then spawns player.
   */
  private async _handleGameplayEntry(fromState: EngineState): Promise<void> {
    const biome = this._biomeStack.pop();
    if (!biome) {
      console.warn("[GFC] No biome queued for gameplay entry. Using fallback.");
      return;
    }

    // Show loading overlay
    this._loadingOverlay.show(biome);

    // Load assets
    await this._atlasLoader.loadManifest(biome.atlasManifest);

    // Small artificial delay for dramatic effect + shader warm-up
    await new Promise((r) => setTimeout(r, 400));

    // Hide overlay
    await this._loadingOverlay.hide();

    // Start win/loss monitoring
    this._conditionMonitor.start();

    this._eventBus.emit("gfc:gameplayReady", { biome: biome.id });
  }

  /**
   * Handles a biome transition while already in GAMEPLAY_ACTIVE.
   * Preserves player state, swaps environment assets, shows veil.
   */
  private async _handleBiomeTransition(): Promise<void> {
    const biome = this._biomeStack.pop();
    if (!biome) return;

    // Pause active scene simulation
    this._activeScene?.pause?.();

    // Show veil
    this._loadingOverlay.show(biome);

    // Load new biome assets
    await this._atlasLoader.loadManifest(biome.atlasManifest);

    // Hide veil
    await this._loadingOverlay.hide();

    // Resume simulation
    this._activeScene?.resume?.();

    this._eventBus.emit("gfc:biomeTransitionComplete", { biome: biome.id });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — State Side Effects
  // ═══════════════════════════════════════════════════════════════════════════

  private _applyStateSideEffects(newState: EngineState, previousState: EngineState): void {
    switch (newState) {
      case EngineState.BOOT:
        this._canvas.style.opacity = "0";
        break;

      case EngineState.MAIN_MENU:
        this._conditionMonitor.stop();
        this._canvas.style.opacity = "1";
        // Stop any lingering gameplay render loops
        if (previousState === EngineState.GAMEPLAY_ACTIVE) {
          this._engine.stopRenderLoop();
        }
        break;

      case EngineState.CHARACTER_SELECT:
        this._canvas.style.opacity = "1";
        break;

      case EngineState.GAMEPLAY_ACTIVE:
        this._canvas.style.opacity = "1";
        this._canvas.focus();
        break;

      case EngineState.GAME_OVER_SUMMARY:
        // Keep canvas visible for background rendering (defeat scene)
        this._conditionMonitor.stop();
        break;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — Win/Loss Wiring
  // ═══════════════════════════════════════════════════════════════════════════

  private _wireConditionMonitor(): void {
    // Victory → trigger cutscene event then transition to summary
    this._conditionMonitor.onVictory.add(() => {
      console.log("[GFC] Victory condition met (30:00 survived).");
      this._eventBus.emit("game:victoryCutscene", {
        elapsedSeconds: this._conditionMonitor.getElapsedSeconds(),
      });

      // Allow cutscene systems a frame to hook in, then transition
      requestAnimationFrame(() => {
        this.transitionTo(EngineState.GAME_OVER_SUMMARY, {
          trigger: "victoryAchieved",
        }).catch(console.error);
      });
    });

    // Defeat → instantly pull up performance summary
    this._conditionMonitor.onDefeat.add((metrics: SurvivalMetrics) => {
      console.log("[GFC] Defeat condition met (0 HP).");
      this._eventBus.emit("game:performanceSummary", metrics);

      // Immediate transition — no cutscene for defeat
      this.transitionTo(EngineState.GAME_OVER_SUMMARY, {
        trigger: "playerDefeated",
      }).catch(console.error);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIVATE — Canvas Visibility Handshakes
  // ═══════════════════════════════════════════════════════════════════════════

  private _wireCanvasVisibility(): void {
    // Pause render loop when tab is hidden (battery & thermal savings)
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        if (this._currentState === EngineState.GAMEPLAY_ACTIVE) {
          this._activeScene?.pause?.();
          this._engine.stopRenderLoop();
          console.log("[GFC] Canvas hidden — render loop paused.");
        }
      } else {
        if (this._currentState === EngineState.GAMEPLAY_ACTIVE && this._activeScene) {
          this._engine.runRenderLoop(() => this._activeScene!.scene.render());
          this._activeScene.resume?.();
          console.log("[GFC] Canvas visible — render loop resumed.");
        }
      }
    });

    // Handle window resize
    window.addEventListener("resize", () => {
      this._engine.resize();
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// §9  FACTORY — Convenience builder for bootstrapping
// ─────────────────────────────────────────────────────────────────────────────

export interface GameFlowControllerConfig {
  engine: Engine;
  canvas: HTMLCanvasElement;
  parentElement?: HTMLElement;
  initialBiome?: BiomeDescriptor;
}

/**
 * Factory function that constructs a fully wired GameFlowController.
 *
 * Usage:
 *   const gfc = createGameFlowController({ engine, canvas });
 *   gfc.registerScene(EngineState.MAIN_MENU, new MainMenuScene(engine));
 *   await gfc.transitionTo(EngineState.MAIN_MENU, { trigger: "bootComplete" });
 */
export function createGameFlowController(
  config: GameFlowControllerConfig
): GameFlowController {
  const gfc = new GameFlowController(
    config.engine,
    config.canvas,
    config.parentElement
  );

  if (config.initialBiome) {
    gfc.queueBiome(config.initialBiome);
  }

  return gfc;
}

// ─────────────────────────────────────────────────────────────────────────────
// §10  EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export {
  GameFlowController as default,
  GameFlowController,
  GameEventBus,
  LoadingScreenOverlay,
  MemoryHygiene,
  AssetAtlasLoader,
  GameConditionMonitor,
  createGameFlowController,
};
