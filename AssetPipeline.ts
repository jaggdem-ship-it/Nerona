/**
 * ============================================================================
 * AssetPipeline.ts
 * ============================================================================
 * A strict runtime asset-loading and memory collection pipeline for
 * Babylon.js WebGPU/WebGL2 horde-survival games.
 *
 * Responsibilities:
 *   1. Centralized async asset loading via BABYLON.AssetsManager
 *   2. Texture Pooling & Recycling (10-sec idle eviction from render cycle)
 *   3. Aggressive manual garbage collection between biomes/maps
 *   4. Real-time performance diagnostics (FPS, draw calls, mesh allocations)
 *
 * @module AssetPipeline
 * @author Senior Graphics Engineer
 * @version 1.0.0
 * ============================================================================
 */

import {
  AssetsManager,
  BinaryFileAssetTask,
  Engine,
  IAssetTask,
  ImageAssetTask,
  Mesh,
  Scene,
  Texture,
  Nullable,
  Observer,
  ISize,
  VertexBuffer,
  HardwareScalingLevel,
  IPipelineOptions,
} from "@babylonjs/core";

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

/** Supported asset categories for the pipeline. */
export type AssetCategory = "texture" | "audio" | "spriteMap" | "font" | "binary";

/** Metadata attached to every managed asset. */
export interface ManagedAssetMeta {
  /** Unique key used for dictionary lookups. */
  key: string;
  /** Human-readable asset path/URL. */
  url: string;
  /** Asset classification. */
  category: AssetCategory;
  /** Timestamp (ms) of last active render-frame usage. */
  lastActiveAt: number;
  /** Is the asset currently participating in a render cycle? */
  isActive: boolean;
  /** Raw loaded data (varies by loader). */
  payload: any;
  /** Optional Babylon Texture reference (for texture/spriteMap). */
  textureRef: Nullable<Texture>;
  /** Size in VRAM (bytes), estimated. */
  vramBytes: number;
}

/** Configuration for the texture pool recycler. */
export interface TexturePoolConfig {
  /** Milliseconds before an inactive texture is dropped from render cycles. */
  evictionThresholdMs: number;
  /** Interval (ms) between recycler sweeps. */
  sweepIntervalMs: number;
  /** Max number of textures to keep hot in VRAM before hard disposal. */
  maxPooledTextures: number;
  /** Enable debug logging. */
  debug: boolean;
}

/** Configuration for the performance monitor. */
export interface PerfMonitorConfig {
  /** Target FPS (usually 60). */
  targetFps: number;
  /** Sample window size for FPS averaging. */
  sampleSize: number;
  /** Warn if draw calls exceed this count. */
  maxDrawCalls: number;
  /** Warn if active mesh count exceeds this count. */
  maxActiveMeshes: number;
  /** Interval (ms) between diagnostic logs. */
  logIntervalMs: number;
  /** Is WebGPU the active renderer? */
  isWebGPU: boolean;
}

/** Snapshot returned by the performance monitor. */
export interface PerfSnapshot {
  fps: number;
  averageFps: number;
  drawCalls: number;
  activeMeshes: number;
  activeParticles: number;
  totalVertices: number;
  totalIndices: number;
  frameTimeMs: number;
  gpuFrameTimeMs: number;
  timestamp: number;
  isUnderPerforming: boolean;
}

/** Descriptor for a single asset to load. */
export interface AssetDescriptor {
  key: string;
  url: string;
  category: AssetCategory;
  /** Optional: treat as sprite sheet (rows/cols). */
  spriteSheet?: { rows: number; cols: number };
  /** Optional: sampling mode for textures. */
  samplingMode?: number;
  /** Optional: invert Y for textures. */
  invertY?: boolean;
}

/** Result of a bulk load operation. */
export interface BulkLoadResult {
  succeeded: string[];
  failed: string[];
  errors: Map<string, Error>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TEXTURE_POOL_CONFIG: TexturePoolConfig = {
  evictionThresholdMs: 10_000,   // 10 seconds idle = drop from render cycle
  sweepIntervalMs: 2_000,        // sweep every 2 seconds
  maxPooledTextures: 256,        // hard ceiling to prevent VRAM bloat
  debug: false,
};

const DEFAULT_PERF_CONFIG: PerfMonitorConfig = {
  targetFps: 60,
  sampleSize: 60,
  maxDrawCalls: 800,
  maxActiveMeshes: 1_200,
  logIntervalMs: 5_000,
  isWebGPU: false,
};

const BYTES_PER_PIXEL_RGBA = 4;

// ─────────────────────────────────────────────────────────────────────────────
// ASSET PIPELINE CLASS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Centralized asset loading controller, texture pool, garbage collector,
 * and performance diagnostic engine.
 *
 * Usage:
 *   const pipeline = new AssetPipeline(scene, engine);
 *   await pipeline.loadBulk([{key:"hero", url:"/tex/hero.png", category:"texture"}]);
 *   pipeline.markActive("hero");   // call every frame the asset is visible
 *   pipeline.startRecycling();     // begin the 10-sec eviction sweeps
 *   pipeline.startPerfMonitor();   // begin FPS/draw-call logging
 */
export class AssetPipeline {
  /** Babylon scene reference. */
  private _scene: Scene;
  /** Babylon engine reference. */
  private _engine: Engine;
  /** Centralized Babylon asset manager. */
  private _assetsManager: AssetsManager;

  /** Primary lookup: key -> metadata + payload. */
  private _assetRegistry: Map<string, ManagedAssetMeta> = new Map();

  /** Secondary index: category -> keys. */
  private _categoryIndex: Map<AssetCategory, Set<string>> = new Map([
    ["texture", new Set()],
    ["audio", new Set()],
    ["spriteMap", new Set()],
    ["font", new Set()],
    ["binary", new Set()],
  ]);

  /** Textures that have been evicted from render cycles but kept in VRAM. */
  private _pooledTextures: Map<string, Texture> = new Map();

  /** Textures currently attached to active meshes/materials. */
  private _activeTextures: Map<string, Texture> = new Map();

  /** Recycler interval handle. */
  private _recyclerIntervalId: Nullable<ReturnType<typeof setInterval>> = null;

  /** Performance observer handle. */
  private _perfObserver: Nullable<Observer<Scene>> = null;

  /** Performance logging interval handle. */
  private _perfLogIntervalId: Nullable<ReturnType<typeof setInterval>> = null;

  /** Circular buffer for FPS samples. */
  private _fpsSamples: Float64Array;
  private _fpsSampleIndex = 0;
  private _fpsSampleCount = 0;

  /** Running totals for GPU timer queries (WebGPU only). */
  private _gpuFrameTimes: number[] = [];

  /** Configuration objects. */
  private _poolConfig: TexturePoolConfig;
  private _perfConfig: PerfMonitorConfig;

  /** Is the pipeline disposed? */
  private _isDisposed = false;

  /** Debug logger. */
  private _log = (msg: string, ...args: any[]) => {
    if (this._poolConfig.debug) {
      console.log(`[AssetPipeline] ${msg}`, ...args);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // CONSTRUCTOR
  // ──────────────────────────────────────────────────────────────────────────

  constructor(
    scene: Scene,
    engine: Engine,
    poolConfig?: Partial<TexturePoolConfig>,
    perfConfig?: Partial<PerfMonitorConfig>
  ) {
    this._scene = scene;
    this._engine = engine;
    this._assetsManager = new AssetsManager(scene);

    // Merge configs
    this._poolConfig = { ...DEFAULT_TEXTURE_POOL_CONFIG, ...poolConfig };
    this._perfConfig = { ...DEFAULT_PERF_CONFIG, ...perfConfig };

    // Detect WebGPU automatically if not explicitly set
    if (perfConfig?.isWebGPU === undefined) {
      this._perfConfig.isWebGPU = (engine as any).isWebGPU ?? false;
    }

    // Initialize FPS sample ring buffer
    this._fpsSamples = new Float64Array(this._perfConfig.sampleSize);

    // Configure AssetsManager
    this._assetsManager.useDefaultLoadingScreen = false;
    this._assetsManager.onTaskErrorObservable.add((task) => {
      console.error(`[AssetPipeline] Task failed: ${task.name}`, task.errorObject);
    });

    this._log("Pipeline initialized. WebGPU=", this._perfConfig.isWebGPU);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 1. CENTRALIZED ASSET LOADING
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Queue a single asset for loading.
   * Returns a promise that resolves when the asset is loaded.
   */
  public loadAsset(descriptor: AssetDescriptor): Promise<ManagedAssetMeta> {
    return new Promise((resolve, reject) => {
      if (this._isDisposed) {
        reject(new Error("AssetPipeline is disposed."));
        return;
      }

      const { key, url, category } = descriptor;

      // Dedupe
      if (this._assetRegistry.has(key)) {
        resolve(this._assetRegistry.get(key)!);
        return;
      }

      let task: IAssetTask;

      switch (category) {
        case "texture":
        case "spriteMap": {
          const imgTask = this._assetsManager.addImageTask(key, url);
          task = imgTask;
          break;
        }
        case "audio": {
          // Babylon AssetsManager does not have a dedicated audio task in core,
          // so we use binary task and let the consumer decode.
          const binTask = this._assetsManager.addBinaryFileTask(key, url);
          task = binTask;
          break;
        }
        case "font": {
          const binTask = this._assetsManager.addBinaryFileTask(key, url);
          task = binTask;
          break;
        }
        case "binary": {
          const binTask = this._assetsManager.addBinaryFileTask(key, url);
          task = binTask;
          break;
        }
        default:
          reject(new Error(`Unknown asset category: ${category}`));
          return;
      }

      task.onSuccess = (t: IAssetTask) => {
        const payload = (t as any).image ?? (t as any).data ?? null;

        // For textures, create the Babylon Texture object immediately
        let textureRef: Nullable<Texture> = null;
        let vramBytes = 0;

        if ((category === "texture" || category === "spriteMap") && payload) {
          const invertY = descriptor.invertY ?? false;
          const sampling = descriptor.samplingMode ?? Texture.TRILINEAR_SAMPLINGMODE;

          textureRef = new Texture(
            url,
            this._scene,
            invertY,
            false,
            sampling,
            () => {
              // onLoad: calculate VRAM footprint
              const size = textureRef!.getSize();
              vramBytes = size.width * size.height * BYTES_PER_PIXEL_RGBA;
              if (textureRef!._texture?.generateMipMaps) {
                vramBytes = Math.floor(vramBytes * 1.33); // mipmap overhead
              }
              meta.vramBytes = vramBytes;
            },
            (msg, ex) => {
              console.warn(`[AssetPipeline] Texture load warning for ${key}:`, msg, ex);
            }
          );

          // Store in active pool immediately after creation
          this._activeTextures.set(key, textureRef);
        }

        const meta: ManagedAssetMeta = {
          key,
          url,
          category,
          lastActiveAt: performance.now(),
          isActive: true,
          payload,
          textureRef,
          vramBytes,
        };

        this._assetRegistry.set(key, meta);
        this._categoryIndex.get(category)!.add(key);

        this._log(`Loaded asset: ${key} (${category})`);
        resolve(meta);
      };

      task.onError = (t: IAssetTask, message?: string, exception?: any) => {
        reject(new Error(`Failed to load ${key}: ${message ?? exception?.message}`));
      };

      // Kick the manager if not already running
      this._assetsManager.load();
    });
  }

  /**
   * Bulk-load an array of descriptors.
   * Returns a summary of succeeded/failed keys.
   */
  public async loadBulk(descriptors: AssetDescriptor[]): Promise<BulkLoadResult> {
    const result: BulkLoadResult = {
      succeeded: [],
      failed: [],
      errors: new Map(),
    };

    // Use Promise.allSettled for parallel loading
    const promises = descriptors.map((desc) =>
      this.loadAsset(desc)
        .then(() => {
          result.succeeded.push(desc.key);
        })
        .catch((err) => {
          result.failed.push(desc.key);
          result.errors.set(desc.key, err instanceof Error ? err : new Error(String(err)));
        })
    );

    await Promise.allSettled(promises);

    this._log(
      `Bulk load complete. Success: ${result.succeeded.length}, Failed: ${result.failed.length}`
    );
    return result;
  }

  /**
   * Retrieve metadata for a loaded asset.
   */
  public getAsset(key: string): Nullable<ManagedAssetMeta> {
    return this._assetRegistry.get(key) ?? null;
  }

  /**
   * Get the Babylon Texture for a loaded texture/spriteMap asset.
   * Returns null if not loaded or wrong category.
   */
  public getTexture(key: string): Nullable<Texture> {
    const meta = this._assetRegistry.get(key);
    if (!meta) return null;
    if (meta.category !== "texture" && meta.category !== "spriteMap") return null;

    // If pooled, reactivate on access
    if (!meta.isActive && this._pooledTextures.has(key)) {
      this._reactivateTexture(key);
    }

    // Update activity timestamp
    meta.lastActiveAt = performance.now();
    meta.isActive = true;

    return meta.textureRef ?? this._activeTextures.get(key) ?? this._pooledTextures.get(key) ?? null;
  }

  /**
   * Mark an asset as actively used this frame.
   * Call this every frame the asset participates in rendering.
   */
  public markActive(key: string): void {
    const meta = this._assetRegistry.get(key);
    if (!meta) return;

    const now = performance.now();
    meta.lastActiveAt = now;

    if (!meta.isActive) {
      meta.isActive = true;
      this._reactivateTexture(key);
    }
  }

  /**
   * Mark many assets active in one call (batch optimization).
   */
  public markActiveBatch(keys: string[]): void {
    const now = performance.now();
    for (const key of keys) {
      const meta = this._assetRegistry.get(key);
      if (!meta) continue;
      meta.lastActiveAt = now;
      if (!meta.isActive) {
        meta.isActive = true;
        this._reactivateTexture(key);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 2. TEXTURE POOLING & RECYCLING
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Start the background recycler that sweeps inactive textures.
   * Textures idle >10s are dropped from render cycles but cached in VRAM.
   */
  public startRecycling(): void {
    if (this._recyclerIntervalId) return;

    this._log("Starting texture recycler...");
    this._recyclerIntervalId = setInterval(() => {
      this._sweepInactiveTextures();
    }, this._poolConfig.sweepIntervalMs);
  }

  /**
   * Stop the background recycler.
   */
  public stopRecycling(): void {
    if (this._recyclerIntervalId) {
      clearInterval(this._recyclerIntervalId);
      this._recyclerIntervalId = null;
      this._log("Texture recycler stopped.");
    }
  }

  /**
   * Internal sweep: move idle textures from active -> pooled.
   */
  private _sweepInactiveTextures(): void {
    const now = performance.now();
    const threshold = this._poolConfig.evictionThresholdMs;
    let evicted = 0;
    let hardDropped = 0;

    for (const [key, meta] of this._assetRegistry) {
      if (meta.category !== "texture" && meta.category !== "spriteMap") continue;
      if (!meta.isActive) continue; // already pooled

      const idleTime = now - meta.lastActiveAt;
      if (idleTime > threshold) {
        // Drop from active render cycle
        meta.isActive = false;

        const tex = meta.textureRef ?? this._activeTextures.get(key);
        if (tex) {
          // Move to pooled cache (retain VRAM)
          this._activeTextures.delete(key);
          this._pooledTextures.set(key, tex);

          // Reduce GPU overhead: set texture to not renderable
          // but DO NOT dispose — we want to keep it in VRAM
          tex.isBlocking = false;

          // If we exceed max pooled count, hard-dispose oldest
          if (this._pooledTextures.size > this._poolConfig.maxPooledTextures) {
            const oldestKey = this._findOldestPooledTexture();
            if (oldestKey && oldestKey !== key) {
              this._hardDisposeTexture(oldestKey);
              hardDropped++;
            }
          }

          evicted++;
        }
      }
    }

    if (evicted > 0 || hardDropped > 0) {
      this._log(
        `Recycler sweep: evicted ${evicted} to pool, hard-dropped ${hardDropped}. ` +
        `Active=${this._activeTextures.size}, Pooled=${this._pooledTextures.size}`
      );
    }
  }

  /**
   * Move a texture from pooled back to active.
   */
  private _reactivateTexture(key: string): void {
    const pooled = this._pooledTextures.get(key);
    if (!pooled) return;

    this._pooledTextures.delete(key);
    this._activeTextures.set(key, pooled);

    const meta = this._assetRegistry.get(key);
    if (meta) {
      meta.isActive = true;
      meta.lastActiveAt = performance.now();
    }

    this._log(`Reactivated texture: ${key}`);
  }

  /**
   * Find the oldest pooled texture by lastActiveAt for hard disposal.
   */
  private _findOldestPooledTexture(): Nullable<string> {
    let oldestKey: Nullable<string> = null;
    let oldestTime = Infinity;

    for (const [key, meta] of this._assetRegistry) {
      if (!meta.isActive && this._pooledTextures.has(key)) {
        if (meta.lastActiveAt < oldestTime) {
          oldestTime = meta.lastActiveAt;
          oldestKey = key;
        }
      }
    }

    return oldestKey;
  }

  /**
   * Hard dispose a texture, freeing VRAM.
   */
  private _hardDisposeTexture(key: string): void {
    const tex = this._pooledTextures.get(key) ?? this._activeTextures.get(key);
    if (tex) {
      tex.dispose();
    }
    this._pooledTextures.delete(key);
    this._activeTextures.delete(key);

    const meta = this._assetRegistry.get(key);
    if (meta) {
      meta.textureRef = null;
      meta.vramBytes = 0;
    }

    this._log(`Hard disposed texture: ${key}`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 3. AGGRESSIVE GARBAGE COLLECTION
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Force a complete memory cleanup when switching maps or biomes.
   * This disposes ALL textures, clears vertex caches, and forces GC hints.
   */
  public collectGarbage(options?: {
    /** If true, dispose pooled textures too (full purge). Default true. */
    disposePooled?: boolean;
    /** If true, clear scene meshes/materials not in a keep list. Default false. */
    clearSceneMeshes?: boolean;
    /** Mesh names to preserve during scene clearing. */
    keepMeshNames?: string[];
  }): void {
    const opts = {
      disposePooled: true,
      clearSceneMeshes: false,
      keepMeshNames: [],
      ...options,
    };

    this._log("=== GARBAGE COLLECTION START ===");
    const t0 = performance.now();

    // 3a. Dispose all active textures
    for (const [key, tex] of this._activeTextures) {
      tex.dispose();
      const meta = this._assetRegistry.get(key);
      if (meta) meta.textureRef = null;
    }
    this._activeTextures.clear();

    // 3b. Dispose pooled textures if requested
    if (opts.disposePooled) {
      for (const [key, tex] of this._pooledTextures) {
        tex.dispose();
        const meta = this._assetRegistry.get(key);
        if (meta) {
          meta.textureRef = null;
          meta.vramBytes = 0;
        }
      }
      this._pooledTextures.clear();
    }

    // 3c. Clear scene-level geometry caches
    this._clearVertexCaches();

    // 3d. Optional: remove scene meshes not in keep list
    if (opts.clearSceneMeshes) {
      const keepSet = new Set(opts.keepMeshNames ?? []);
      const toRemove: Mesh[] = [];
      for (const mesh of this._scene.meshes) {
        if (mesh.name && keepSet.has(mesh.name)) continue;
        if (mesh instanceof Mesh) {
          toRemove.push(mesh);
        }
      }
      for (const mesh of toRemove) {
        mesh.dispose(false, true); // doNotRecurse=false, disposeMaterial=true
      }
      this._log(`Disposed ${toRemove.length} scene meshes.`);
    }

    // 3e. Force engine-level cache clear
    this._engine.wipeCaches(true);

    // 3f. Hint the JS engine to collect (non-blocking, best-effort)
    if (typeof (globalThis as any).gc === "function") {
      try {
        (globalThis as any).gc();
        this._log("Forced JS GC via --expose-gc flag.");
      } catch {
        // ignore
      }
    }

    // 3g. Compact asset registry
    for (const [key, meta] of this._assetRegistry) {
      if (!meta.isActive && opts.disposePooled) {
        meta.textureRef = null;
        meta.vramBytes = 0;
      }
    }

    const t1 = performance.now();
    this._log(`=== GARBAGE COLLECTION END (${(t1 - t0).toFixed(2)} ms) ===`);
  }

  /**
   * Clear internal Babylon vertex buffers and effect caches.
   */
  private _clearVertexCaches(): void {
    // Release compiled effects to free shader program memory
    this._scene.getEngine().releaseEffects();

    // Dispose unused vertex buffers on meshes
    for (const mesh of this._scene.meshes) {
      if (mesh instanceof Mesh && mesh.isDisposed()) continue;
      if (mesh instanceof Mesh) {
        // Force geometry rebuild on next use
        const geometry = mesh.geometry;
        if (geometry) {
          // Mark as dirty so buffers re-upload if needed
          geometry.boundingBias = geometry.boundingBias ?? new BABYLON.Vector2(0, 0);
        }
      }
    }

    // Clear material shader cache references
    for (const material of this._scene.materials) {
      // Reset draw cache
      (material as any)._drawWrapper = undefined;
    }

    this._log("Vertex caches and effect programs cleared.");
  }

  /**
   * Dispose a specific asset by key.
   */
  public disposeAsset(key: string): boolean {
    const meta = this._assetRegistry.get(key);
    if (!meta) return false;

    if (meta.textureRef) {
      meta.textureRef.dispose();
    }
    this._activeTextures.delete(key);
    this._pooledTextures.delete(key);
    this._assetRegistry.delete(key);
    this._categoryIndex.get(meta.category)?.delete(key);

    this._log(`Disposed asset: ${key}`);
    return true;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // 4. DIAGNOSTIC PERFORMANCE MONITOR
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Start the real-time performance monitor.
   * Logs warnings if FPS < 60, draw calls too high, or mesh count excessive.
   */
  public startPerfMonitor(): void {
    if (this._perfObserver) return;

    this._log("Starting performance monitor...");

    // Hook into scene render loop for per-frame metrics
    this._perfObserver = this._scene.onAfterRenderObservable.add(() => {
      this._recordFrameMetrics();
    });

    // Periodic logging
    this._perfLogIntervalId = setInterval(() => {
      this._logPerformanceSnapshot();
    }, this._perfConfig.logIntervalMs);
  }

  /**
   * Stop the performance monitor.
   */
  public stopPerfMonitor(): void {
    if (this._perfObserver) {
      this._scene.onAfterRenderObservable.remove(this._perfObserver);
      this._perfObserver = null;
    }
    if (this._perfLogIntervalId) {
      clearInterval(this._perfLogIntervalId);
      this._perfLogIntervalId = null;
    }
    this._log("Performance monitor stopped.");
  }

  /**
   * Record metrics for the current frame.
   */
  private _recordFrameMetrics(): void {
    const engine = this._engine;
    const fps = engine.getFps();

    // Store in ring buffer
    this._fpsSamples[this._fpsSampleIndex] = fps;
    this._fpsSampleIndex = (this._fpsSampleIndex + 1) % this._perfConfig.sampleSize;
    if (this._fpsSampleCount < this._perfConfig.sampleSize) {
      this._fpsSampleCount++;
    }

    // WebGPU: try to capture GPU frame time via timestamp queries
    if (this._perfConfig.isWebGPU) {
      const gpuTime = (engine as any).gpuFrameTimeGPU?.current ?? 0;
      if (gpuTime > 0) {
        this._gpuFrameTimes.push(gpuTime);
        if (this._gpuFrameTimes.length > this._perfConfig.sampleSize) {
          this._gpuFrameTimes.shift();
        }
      }
    }
  }

  /**
   * Compute and log a performance snapshot.
   */
  private _logPerformanceSnapshot(): void {
    const snap = this.getPerfSnapshot();
    if (!snap) return;

    const warnings: string[] = [];

    if (snap.averageFps < this._perfConfig.targetFps) {
      warnings.push(`FPS below target (${snap.averageFps.toFixed(1)} < ${this._perfConfig.targetFps})`);
    }
    if (snap.drawCalls > this._perfConfig.maxDrawCalls) {
      warnings.push(`Draw calls high (${snap.drawCalls} > ${this._perfConfig.maxDrawCalls})`);
    }
    if (snap.activeMeshes > this._perfConfig.maxActiveMeshes) {
      warnings.push(`Active meshes high (${snap.activeMeshes} > ${this._perfConfig.maxActiveMeshes})`);
    }

    if (warnings.length > 0) {
      console.warn(
        `[AssetPipeline][PERF WARNING] ${warnings.join(" | ")} | ` +
        `FrameTime=${snap.frameTimeMs.toFixed(2)}ms ` +
        `GPU=${snap.gpuFrameTimeMs.toFixed(2)}ms ` +
        `Verts=${snap.totalVertices} Indices=${snap.totalIndices}`
      );
    } else if (this._poolConfig.debug) {
      this._log(
        `Perf OK | FPS=${snap.fps.toFixed(1)} Avg=${snap.averageFps.toFixed(1)} ` +
        `Draws=${snap.drawCalls} Meshes=${snap.activeMeshes} ` +
        `GPU=${snap.gpuFrameTimeMs.toFixed(2)}ms`
      );
    }
  }

  /**
   * Get a current performance snapshot.
   */
  public getPerfSnapshot(): Nullable<PerfSnapshot> {
    if (this._fpsSampleCount === 0) return null;

    const engine = this._engine;
    const scene = this._scene;

    // Calculate average FPS from ring buffer
    let sum = 0;
    for (let i = 0; i < this._fpsSampleCount; i++) {
      sum += this._fpsSamples[i];
    }
    const avgFps = sum / this._fpsSampleCount;
    const currentFps = this._fpsSamples[(this._fpsSampleIndex - 1 + this._perfConfig.sampleSize) % this._perfConfig.sampleSize];

    // Draw calls (engine internal counters)
    const drawCalls = (engine as any)._drawCalls?.current ?? (scene as any)._renderingManager?.renderingGroups?.length ?? 0;

    // Active meshes
    const activeMeshes = scene.getActiveMeshes().length;

    // Particles
    let activeParticles = 0;
    for (const system of scene.particleSystems) {
      if (system.isStarted()) activeParticles += system.getActiveCount();
    }

    // Vertex / index counts
    let totalVertices = 0;
    let totalIndices = 0;
    for (const mesh of scene.meshes) {
      if (mesh instanceof Mesh && !mesh.isDisposed()) {
        totalVertices += mesh.getTotalVertices();
        const geometry = mesh.geometry;
        if (geometry && geometry.getIndexBuffer()) {
          totalIndices += geometry.getTotalIndices();
        }
      }
    }

    // Frame time
    const frameTimeMs = currentFps > 0 ? 1000 / currentFps : 0;

    // GPU frame time average
    let gpuFrameTimeMs = 0;
    if (this._gpuFrameTimes.length > 0) {
      gpuFrameTimeMs = this._gpuFrameTimes.reduce((a, b) => a + b, 0) / this._gpuFrameTimes.length;
    }

    return {
      fps: currentFps,
      averageFps: avgFps,
      drawCalls,
      activeMeshes,
      activeParticles,
      totalVertices,
      totalIndices,
      frameTimeMs,
      gpuFrameTimeMs,
      timestamp: performance.now(),
      isUnderPerforming: avgFps < this._perfConfig.targetFps || drawCalls > this._perfConfig.maxDrawCalls,
    };
  }

  /**
   * Get a JSON-serializable memory report.
   */
  public getMemoryReport(): object {
    let totalVram = 0;
    let activeVram = 0;
    let pooledVram = 0;

    for (const [key, meta] of this._assetRegistry) {
      if (meta.category === "texture" || meta.category === "spriteMap") {
        totalVram += meta.vramBytes;
        if (meta.isActive) activeVram += meta.vramBytes;
        else pooledVram += meta.vramBytes;
      }
    }

    return {
      timestamp: performance.now(),
      assetCount: this._assetRegistry.size,
      byCategory: {
        texture: this._categoryIndex.get("texture")!.size,
        spriteMap: this._categoryIndex.get("spriteMap")!.size,
        audio: this._categoryIndex.get("audio")!.size,
        font: this._categoryIndex.get("font")!.size,
        binary: this._categoryIndex.get("binary")!.size,
      },
      textures: {
        active: this._activeTextures.size,
        pooled: this._pooledTextures.size,
      },
      vramBytes: {
        total: totalVram,
        active: activeVram,
        pooled: pooledVram,
      },
      perfSnapshot: this.getPerfSnapshot(),
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // LIFECYCLE
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Dispose the entire pipeline.
   */
  public dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;

    this.stopRecycling();
    this.stopPerfMonitor();

    // Dispose all textures
    for (const tex of this._activeTextures.values()) tex.dispose();
    for (const tex of this._pooledTextures.values()) tex.dispose();
    this._activeTextures.clear();
    this._pooledTextures.clear();

    // Clear registry
    this._assetRegistry.clear();
    for (const set of this._categoryIndex.values()) set.clear();

    // Dispose assets manager
    this._assetsManager.dispose();

    this._log("Pipeline disposed.");
  }

  /**
   * Is the pipeline disposed?
   */
  public get isDisposed(): boolean {
    return this._isDisposed;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SINGLETON EXPORT (optional convenience)
// ─────────────────────────────────────────────────────────────────────────────

let _globalPipeline: Nullable<AssetPipeline> = null;

/**
 * Initialize the global pipeline instance.
 */
export function initAssetPipeline(
  scene: Scene,
  engine: Engine,
  poolConfig?: Partial<TexturePoolConfig>,
  perfConfig?: Partial<PerfMonitorConfig>
): AssetPipeline {
  if (_globalPipeline) {
    _globalPipeline.dispose();
  }
  _globalPipeline = new AssetPipeline(scene, engine, poolConfig, perfConfig);
  return _globalPipeline;
}

/**
 * Access the global pipeline instance.
 */
export function getAssetPipeline(): Nullable<AssetPipeline> {
  return _globalPipeline;
}

/**
 * Destroy the global pipeline instance.
 */
export function destroyAssetPipeline(): void {
  if (_globalPipeline) {
    _globalPipeline.dispose();
    _globalPipeline = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export default AssetPipeline;
