/**
 * TileStitchingEngine.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Chunk-based tile atlas renderer for a multi-layer gothic world.
 *
 * Responsibilities:
 *   • Reads structural tile rules from WorldTileRules.ts
 *   • Manages a 16×16-cell chunk memory grid (cell size = 2.0 world units)
 *   • Slices HD hand-painted atlas sheets via manual VertexBuffer.UVKind
 *     manipulation — zero texture bleeding via inner-UV padding.
 *   • Progressive chunk population (Layers 0-2 stitched; Layer 3 / Roofs
 *     isolated under an independent parent node hierarchy).
 *   • Aggressive draw-call reduction via ThinInstance buckets grouped by
 *     material, plus optional Mesh.MergeMeshes fallback for dynamic layers.
 *
 * Architecture:
 *   Chunk ──► Layer ──► MaterialBucket ──► ThinInstanceSet
 *                        (or MergedMesh)
 *
 * Performance targets:
 *   • O(1) chunk lookup via spatial hash
 *   • Sub-frame chunk streaming (< 4 ms per chunk on mid-tier hardware)
 *   • Draw calls capped to ~(#unique materials × #visible chunks)
 */

import {
  Scene,
  Vector2,
  Vector3,
  Mesh,
  VertexData,
  VertexBuffer,
  Material,
  StandardMaterial,
  Texture,
  Color3,
  Node,
  TransformNode,
  Nullable,
  IDisposable,
  Matrix,
  BoundingInfo,
  SubMesh,
  Tools,
} from "@babylonjs/core";

import {
  WorldTileRules,
  TileRule,
  TileLayer,
  TileAtlasDef,
  AtlasSlice,
  StructuralConfig,
} from "./WorldTileRules";

/* ────────────────────────────────────────────────────────────────────────────
 *  Constants & Types
 * ──────────────────────────────────────────────────────────────────────────── */

const CELL_SIZE = 2.0;
const CHUNK_CELLS = 16;
const CHUNK_WORLD_SIZE = CELL_SIZE * CHUNK_CELLS; // 32.0

/** UV inset (in texel space) to eradicate atlas bleeding. */
const UV_BLEED_PAD = 0.5;

/** Maximum thin instances per bucket before we split into a new batch.
 *  WebGPU has a 64k matrix limit per draw in some paths; we stay well under. */
const MAX_THIN_INSTANCES_PER_BUCKET = 4000;

/** Enum mirroring the logical layers so we can index arrays safely. */
const enum LayerIndex {
  Ground = 0,
  Details = 1,
  Walls = 2,
  Roofs = 3,
}

/** A single cell inside a chunk stores rule handles for every layer. */
interface ChunkCell {
  rules: [Nullable<TileRule>, Nullable<TileRule>, Nullable<TileRule>, Nullable<TileRule>];
}

/** Spatial key for chunk map: "cx,cz" */
type ChunkKey = string;

/** One material bucket owns either a ThinInstance array or a merged mesh. */
interface MaterialBucket {
  material: Material;
  baseMesh: Mesh;
  /** Thin-instance matrices for this material in this chunk+layer. */
  matrices: Matrix[];
  /** If we overflow MAX_THIN_INSTANCES_PER_BUCKET, overflow goes here. */
  overflowBuckets?: MaterialBucket[];
  /** If true, this bucket was baked into a merged mesh (non-instanced path). */
  isBaked: boolean;
}

/** Per-layer container inside a chunk. */
interface ChunkLayer {
  buckets: Map<string, MaterialBucket>;
  /** Independent parent node for Layer 3 (Roofs). */
  parentNode: TransformNode;
}

/** A loaded/loading chunk. */
interface Chunk {
  key: ChunkKey;
  cx: number;
  cz: number;
  cells: ChunkCell[][];
  layers: [ChunkLayer, ChunkLayer, ChunkLayer, ChunkLayer];
  isLoaded: boolean;
  isLoading: boolean;
  worldBounds: BoundingInfo;
  /** Disposable handles for cleanup. */
  disposables: IDisposable[];
}

/** Atlas cache entry — one Texture per atlas image path. */
interface AtlasCacheEntry {
  texture: Texture;
  def: TileAtlasDef;
  /** Pre-computed UV rectangles for every named slice, with bleed padding. */
  uvRects: Map<string, { u1: number; v1: number; u2: number; v2: number }>;
}

/** Options for the engine. */
export interface TileStitchingEngineOptions {
  scene: Scene;
  rules: WorldTileRules;
  /** Root node for all tile geometry. */
  rootNode: TransformNode;
  /** Root node specifically for roof geometry (Layer 3). */
  roofRootNode: TransformNode;
  /** If true, prefer Mesh.MergeMeshes over ThinInstance for layers
   *  that have high triangle counts per tile. Default false (ThinInstance). */
  preferMergeMeshes?: boolean;
  /** Atlas texture filtering. */
  samplingMode?: number;
  /** Anisotropic level for ground textures. */
  anisotropicLevel?: number;
}

/* ────────────────────────────────────────────────────────────────────────────
 *  TileStitchingEngine
 * ──────────────────────────────────────────────────────────────────────────── */

export class TileStitchingEngine implements IDisposable {
  private readonly _scene: Scene;
  private readonly _rules: WorldTileRules;
  private readonly _rootNode: TransformNode;
  private readonly _roofRootNode: TransformNode;
  private readonly _preferMergeMeshes: boolean;

  /** Spatial hash: key → Chunk. */
  private readonly _chunks = new Map<ChunkKey, Chunk>();

  /** Atlas image path → cache entry. */
  private readonly _atlasCache = new Map<string, AtlasCacheEntry>();

  /** Re-usable geometry for a single flat tile (1×1, later scaled). */
  private readonly _tileVertexData: VertexData;

  /** Shared ground-plane base mesh for thin-instancing. Cloned per material. */
  private readonly _tileBaseMesh: Mesh;

  /** Track which chunks are currently visible / within stream radius. */
  private _activeChunkRadius = 3;
  private _lastViewerChunk: ChunkKey = "-99999,-99999";

  /** Frame budget for chunk streaming (milliseconds). */
  private readonly _frameBudgetMs = 3.5;

  /** Pending chunks queued for population this frame. */
  private _populateQueue: Chunk[] = [];

  constructor(opts: TileStitchingEngineOptions) {
    this._scene = opts.scene;
    this._rules = opts.rules;
    this._rootNode = opts.rootNode;
    this._roofRootNode = opts.roofRootNode;
    this._preferMergeMeshes = opts.preferMergeMeshes ?? false;

    // ── Build canonical tile geometry (unit quad, origin at bottom-left) ──
    this._tileVertexData = this._createUnitTileVertexData();
    this._tileBaseMesh = this._createBaseMesh("__tileBase__");

    // ── Pre-load all atlases referenced by the rule set ──
    this._warmAtlasCache(opts.samplingMode, opts.anisotropicLevel);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PUBLIC API
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Call every frame with the viewer/camera world position.
   * Handles progressive chunk loading/unloading and visibility culling.
   */
  public update(viewerPos: Vector3): void {
    const vChunkX = Math.floor(viewerPos.x / CHUNK_WORLD_SIZE);
    const vChunkZ = Math.floor(viewerPos.z / CHUNK_WORLD_SIZE);
    const key = `${vChunkX},${vChunkZ}`;

    if (key !== this._lastViewerChunk) {
      this._lastViewerChunk = key;
      this._refreshChunkRing(vChunkX, vChunkZ);
    }

    this._processPopulateQueue();
  }

  /**
   * Force immediate generation of a specific chunk (for editor / debug).
   */
  public forceLoadChunk(cx: number, cz: number): Chunk {
    const key = `${cx},${cz}`;
    let chunk = this._chunks.get(key);
    if (!chunk) {
      chunk = this._allocateChunk(cx, cz);
      this._chunks.set(key, chunk);
    }
    if (!chunk.isLoaded && !chunk.isLoading) {
      this._populateChunk(chunk);
    }
    return chunk;
  }

  /**
   * Unload a chunk and dispose all GPU resources.
   */
  public unloadChunk(cx: number, cz: number): void {
    const key = `${cx},${cz}`;
    const chunk = this._chunks.get(key);
    if (chunk) {
      this._disposeChunk(chunk);
      this._chunks.delete(key);
    }
  }

  /**
   * Set the streaming radius in chunks.
   */
  public setStreamRadius(radiusChunks: number): void {
    this._activeChunkRadius = Math.max(1, radiusChunks);
  }

  /**
   * Dispose the entire engine and all GPU resources.
   */
  public dispose(): void {
    for (const chunk of this._chunks.values()) {
      this._disposeChunk(chunk);
    }
    this._chunks.clear();

    for (const entry of this._atlasCache.values()) {
      entry.texture.dispose();
    }
    this._atlasCache.clear();

    this._tileBaseMesh.dispose();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     CHUNK MEMORY LAYOUT
     ═══════════════════════════════════════════════════════════════════════ */

  private _allocateChunk(cx: number, cz: number): Chunk {
    const cells: ChunkCell[][] = [];
    for (let x = 0; x < CHUNK_CELLS; x++) {
      cells[x] = [];
      for (let z = 0; z < CHUNK_CELLS; z++) {
        cells[x][z] = { rules: [null, null, null, null] };
      }
    }

    const min = new Vector3(cx * CHUNK_WORLD_SIZE, -1000, cz * CHUNK_WORLD_SIZE);
    const max = new Vector3(
      (cx + 1) * CHUNK_WORLD_SIZE,
      1000,
      (cz + 1) * CHUNK_WORLD_SIZE
    );

    const chunk: Chunk = {
      key: `${cx},${cz}`,
      cx,
      cz,
      cells,
      layers: [
        this._createChunkLayer(LayerIndex.Ground),
        this._createChunkLayer(LayerIndex.Details),
        this._createChunkLayer(LayerIndex.Walls),
        this._createChunkLayer(LayerIndex.Roofs),
      ],
      isLoaded: false,
      isLoading: false,
      worldBounds: new BoundingInfo(min, max),
      disposables: [],
    };

    // ── Query WorldTileRules for every cell & layer ──
    this._fillChunkFromRules(chunk);

    return chunk;
  }

  private _createChunkLayer(layerIdx: LayerIndex): ChunkLayer {
    const parent = new TransformNode(`chunkLayer_${layerIdx}`, this._scene);
    parent.parent = layerIdx === LayerIndex.Roofs ? this._roofRootNode : this._rootNode;
    parent.setEnabled(false); // enabled after population
    return { buckets: new Map(), parentNode: parent };
  }

  /**
   * Ask WorldTileRules what tile belongs in each cell for each layer.
   */
  private _fillChunkFromRules(chunk: Chunk): void {
    const config = this._rules.getConfig();
    for (let lx = 0; lx < CHUNK_CELLS; lx++) {
      for (let lz = 0; lz < CHUNK_CELLS; lz++) {
        const worldX = chunk.cx * CHUNK_CELLS + lx;
        const worldZ = chunk.cz * CHUNK_CELLS + lz;
        const cell = chunk.cells[lx][lz];

        for (let layer = 0; layer < 4; layer++) {
          const rule = this._rules.resolveTile(worldX, worldZ, layer as TileLayer);
          cell.rules[layer] = rule;
        }
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     PROGRESSIVE CHUNK POPULATION
     ═══════════════════════════════════════════════════════════════════════ */

  private _refreshChunkRing(centerCx: number, centerCz: number): void {
    const needed = new Set<ChunkKey>();
    const r = this._activeChunkRadius;

    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const cx = centerCx + dx;
        const cz = centerCz + dz;
        const key = `${cx},${cz}`;
        needed.add(key);

        let chunk = this._chunks.get(key);
        if (!chunk) {
          chunk = this._allocateChunk(cx, cz);
          this._chunks.set(key, chunk);
        }
        if (!chunk.isLoaded && !chunk.isLoading) {
          chunk.isLoading = true;
          this._populateQueue.push(chunk);
        }
      }
    }

    // Unload distant chunks
    for (const [key, chunk] of this._chunks) {
      if (!needed.has(key)) {
        this._disposeChunk(chunk);
        this._chunks.delete(key);
      }
    }
  }

  private _processPopulateQueue(): void {
    if (this._populateQueue.length === 0) return;

    const t0 = performance.now();
    let processed = 0;

    while (this._populateQueue.length > 0) {
      const chunk = this._populateQueue.shift()!;
      this._populateChunk(chunk);
      processed++;

      if (performance.now() - t0 > this._frameBudgetMs) {
        break;
      }
    }
  }

  /**
   * The heavy lifting: for every cell in the chunk, build geometry
   * and push it into material buckets, then bake buckets into draw calls.
   */
  private _populateChunk(chunk: Chunk): void {
    // Temporary accumulator: materialKey → list of tile instances
    const acc = new Map<string, { rule: TileRule; matrices: Matrix[]; uvs: Float32Array[] }>();

    for (let lx = 0; lx < CHUNK_CELLS; lx++) {
      for (let lz = 0; lz < CHUNK_CELLS; lz++) {
        const cell = chunk.cells[lx][lz];
        const baseX = chunk.cx * CHUNK_WORLD_SIZE + lx * CELL_SIZE;
        const baseZ = chunk.cz * CHUNK_WORLD_SIZE + lz * CELL_SIZE;

        for (let layer = 0; layer < 4; layer++) {
          const rule = cell.rules[layer];
          if (!rule) continue;

          const atlasEntry = this._atlasCache.get(rule.atlasPath);
          if (!atlasEntry) continue;

          const uvRect = atlasEntry.uvRects.get(rule.sliceName);
          if (!uvRect) continue;

          // Build transform matrix for this tile instance
          const posX = baseX + CELL_SIZE * 0.5;
          const posZ = baseZ + CELL_SIZE * 0.5;
          const posY = this._computeLayerHeight(layer, rule);

          const scaleX = CELL_SIZE * rule.scaleX;
          const scaleZ = CELL_SIZE * rule.scaleZ;
          const scaleY = rule.scaleY;

          const matrix = Matrix.Compose(
            new Vector3(scaleX, scaleY, scaleZ),
            rule.rotationQuaternion ?? Vector3.Zero().toQuaternion(),
            new Vector3(posX, posY, posZ)
          );

          // Build per-instance UV override (if the rule uses a non-default slice)
          const uvOverride = this._buildUVOverride(uvRect);

          const matKey = this._materialKey(rule, layer);
          let bucket = acc.get(matKey);
          if (!bucket) {
            bucket = { rule, matrices: [], uvs: [] };
            acc.set(matKey, bucket);
          }
          bucket.matrices.push(matrix);
          bucket.uvs.push(uvOverride);
        }
      }
    }

    // ── Bake accumulators into GPU-friendly representations ──
    for (const [matKey, bucket] of acc) {
      this._bakeBucket(chunk, bucket.rule, bucket.matrices, bucket.uvs);
    }

    // ── Enable layer parent nodes ──
    for (let i = 0; i < 4; i++) {
      chunk.layers[i].parentNode.setEnabled(true);
    }

    chunk.isLoaded = true;
    chunk.isLoading = false;
  }

  private _computeLayerHeight(layer: number, rule: TileRule): number {
    // Layer 0 = ground at Y=0, Layer 1 = slightly above, etc.
    const baseHeights = [0.0, 0.05, 1.0, 2.5];
    return baseHeights[layer] + rule.heightOffset;
  }

  private _materialKey(rule: TileRule, layer: number): string {
    // Unique key per atlas+slice+material+layer combo
    return `${rule.atlasPath}|${rule.sliceName}|${rule.materialHint ?? "default"}|L${layer}`;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     BUCKET BAKING: ThinInstance vs MergeMeshes
     ═══════════════════════════════════════════════════════════════════════ */

  private _bakeBucket(
    chunk: Chunk,
    rule: TileRule,
    matrices: Matrix[],
    uvOverrides: Float32Array[]
  ): void {
    const layerIdx = this._resolveLayerIndex(rule.layer);
    const layer = chunk.layers[layerIdx];
    const matKey = this._materialKey(rule, layerIdx);

    // Re-use or create material
    let bucket = layer.buckets.get(matKey);
    if (!bucket) {
      bucket = this._createMaterialBucket(rule, layer.parentNode);
      layer.buckets.set(matKey, bucket);
    }

    if (this._preferMergeMeshes || matrices.length < 50) {
      // Low-count fallback: merge into a single mesh
      this._bakeViaMerge(chunk, bucket, matrices, uvOverrides);
    } else {
      // High-count path: thin instances
      this._bakeViaThinInstance(bucket, matrices, uvOverrides);
    }
  }

  private _createMaterialBucket(rule: TileRule, parent: TransformNode): MaterialBucket {
    const mat = this._buildMaterial(rule);
    const baseMesh = this._tileBaseMesh.clone(`base_${rule.sliceName}`);
    baseMesh.material = mat;
    baseMesh.parent = parent;
    baseMesh.setEnabled(false); // thin-instance master is invisible

    return {
      material: mat,
      baseMesh,
      matrices: [],
      isBaked: false,
    };
  }

  /**
   * ThinInstance path: upload matrices & custom UVs in bulk.
   */
  private _bakeViaThinInstance(
    bucket: MaterialBucket,
    matrices: Matrix[],
    uvOverrides: Float32Array[]
  ): void {
    // If we'd overflow the safe limit, chain into overflow buckets
    const startIdx = bucket.matrices.length;
    const total = startIdx + matrices.length;

    if (total <= MAX_THIN_INSTANCES_PER_BUCKET) {
      bucket.matrices.push(...matrices);
      this._refreshThinInstances(bucket, uvOverrides);
    } else {
      // Split across overflow buckets
      let cursor = 0;
      const targets: MaterialBucket[] = [bucket, ...(bucket.overflowBuckets ?? [])];

      for (const target of targets) {
        const room = MAX_THIN_INSTANCES_PER_BUCKET - target.matrices.length;
        if (room <= 0) continue;
        const take = Math.min(room, matrices.length - cursor);
        const sliceMats = matrices.slice(cursor, cursor + take);
        const sliceUVs = uvOverrides.slice(cursor, cursor + take);
        target.matrices.push(...sliceMats);
        this._refreshThinInstances(target, sliceUVs);
        cursor += take;
        if (cursor >= matrices.length) break;
      }

      // If still overflowing, create new overflow buckets
      while (cursor < matrices.length) {
        const overflow = this._createOverflowBucket(bucket);
        bucket.overflowBuckets = bucket.overflowBuckets ?? [];
        bucket.overflowBuckets.push(overflow);
        const take = Math.min(MAX_THIN_INSTANCES_PER_BUCKET, matrices.length - cursor);
        const sliceMats = matrices.slice(cursor, cursor + take);
        const sliceUVs = uvOverrides.slice(cursor, cursor + take);
        overflow.matrices.push(...sliceMats);
        this._refreshThinInstances(overflow, sliceUVs);
        cursor += take;
      }
    }
  }

  private _createOverflowBucket(source: MaterialBucket): MaterialBucket {
    const baseMesh = source.baseMesh.clone(`${source.baseMesh.name}_overflow`);
    baseMesh.setEnabled(false);
    return {
      material: source.material,
      baseMesh,
      matrices: [],
      isBaked: false,
    };
  }

  /**
   * Rebuild thin-instance buffers for a bucket.
   * Supports per-instance UV overrides via custom vertex buffer.
   */
  private _refreshThinInstances(bucket: MaterialBucket, newUVs: Float32Array[]): void {
    const mesh = bucket.baseMesh;
    const count = bucket.matrices.length;

    if (count === 0) {
      mesh.thinInstanceCount = 0;
      return;
    }

    // Build flat float32 matrix array (16 floats per matrix)
    const matrixData = new Float32Array(count * 16);
    for (let i = 0; i < count; i++) {
      bucket.matrices[i].copyToArray(matrixData, i * 16);
    }

    // Refresh thin instances
    mesh.thinInstanceCount = 0; // reset
    mesh.thinInstanceSetBuffer("matrix", matrixData, 16, false);

    // ── Per-instance UV overrides ──
    // We store UVs as a vec4 (u1,v1,u2,v2) per instance in a custom buffer.
    // The vertex shader (or material plugin) can read this and remap UVs.
    if (newUVs.length > 0) {
      const uvData = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        const uv = newUVs[i] ?? newUVs[newUVs.length - 1];
        uvData.set(uv, i * 4);
      }
      mesh.thinInstanceSetBuffer("uvRect", uvData, 4, false);
    }

    mesh.thinInstanceCount = count;
  }

  /**
   * MergeMeshes path: clone tile geometry per instance, apply UVs, merge.
   * Used for low-count buckets or when preferMergeMeshes is true.
   */
  private _bakeViaMerge(
    chunk: Chunk,
    bucket: MaterialBucket,
    matrices: Matrix[],
    uvOverrides: Float32Array[]
  ): void {
    const meshesToMerge: Mesh[] = [];

    for (let i = 0; i < matrices.length; i++) {
      const tile = this._tileBaseMesh.clone(`tile_${chunk.key}_${i}`);
      tile.material = bucket.material;
      tile.parent = bucket.baseMesh.parent;

      // Apply transform
      const m = matrices[i];
      tile.position = new Vector3(m.m[12], m.m[13], m.m[14]);
      tile.scaling = new Vector3(
        Math.sqrt(m.m[0] * m.m[0] + m.m[1] * m.m[1] + m.m[2] * m.m[2]),
        Math.sqrt(m.m[4] * m.m[4] + m.m[5] * m.m[5] + m.m[6] * m.m[6]),
        Math.sqrt(m.m[8] * m.m[8] + m.m[9] * m.m[9] + m.m[10] * m.m[10])
      );
      tile.rotationQuaternion = Matrix.Decompose(m)?.rotationQuaternion ?? null;

      // Apply UV override directly to vertex buffer
      if (uvOverrides[i]) {
        this._applyUVOverrideToMesh(tile, uvOverrides[i]);
      }

      meshesToMerge.push(tile);
    }

    if (meshesToMerge.length > 0) {
      const merged = Mesh.MergeMeshes(
        meshesToMerge,
        true,
        true,
        undefined,
        false,
        true
      );
      if (merged) {
        merged.name = `merged_${bucket.baseMesh.name}`;
        merged.parent = bucket.baseMesh.parent;
        merged.material = bucket.material;
        chunk.disposables.push(merged);

        // Dispose the temporary clones
        for (const m of meshesToMerge) {
          m.dispose();
        }
      }
    }

    bucket.isBaked = true;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     ATLAS UV SLICING — ZERO BLEED
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Pre-compute UV rectangles for every slice in every atlas.
   * Applies texel-edge inset so adjacent atlas pixels never bleed in.
   */
  private _warmAtlasCache(samplingMode?: number, anisoLevel?: number): void {
    const configs = this._rules.getAtlasDefinitions();

    for (const def of configs) {
      const tex = new Texture(def.imagePath, this._scene, true, false, samplingMode);
      tex.anisotropicFilteringLevel = anisoLevel ?? 4;
      tex.wrapU = Texture.CLAMP_ADDRESSMODE;
      tex.wrapV = Texture.CLAMP_ADDRESSMODE;

      const uvRects = new Map<string, { u1: number; v1: number; u2: number; v2: number }>();

      for (const slice of def.slices) {
        const rect = this._computePaddedUVRect(tex, slice);
        uvRects.set(slice.name, rect);
      }

      this._atlasCache.set(def.imagePath, { texture: tex, def, uvRects });
    }
  }

  /**
   * Convert pixel-space slice coordinates into normalized UV space,
   * inset by UV_BLEED_PAD texels on all four sides.
   */
  private _computePaddedUVRect(
    tex: Texture,
    slice: AtlasSlice
  ): { u1: number; v1: number; u2: number; v2: number } {
    const texW = tex.getSize().width;
    const texH = tex.getSize().height;

    const padU = UV_BLEED_PAD / texW;
    const padV = UV_BLEED_PAD / texH;

    const u1 = (slice.x + UV_BLEED_PAD) / texW;
    const v1 = 1.0 - (slice.y + slice.h - UV_BLEED_PAD) / texH; // flip V for Babylon
    const u2 = (slice.x + slice.w - UV_BLEED_PAD) / texW;
    const v2 = 1.0 - (slice.y + UV_BLEED_PAD) / texH;

    return { u1: Math.max(0, u1), v1: Math.max(0, v1), u2: Math.min(1, u2), v2: Math.min(1, v2) };
  }

  /**
   * Build a Float32Array of 4 floats representing the UV rectangle
   * for a thin-instance custom buffer.
   */
  private _buildUVOverride(rect: { u1: number; v1: number; u2: number; v2: number }): Float32Array {
    return new Float32Array([rect.u1, rect.v1, rect.u2, rect.v2]);
  }

  /**
   * Directly overwrite the UV buffer of a mesh with a new atlas slice.
   * Used in the MergeMeshes fallback path.
   */
  private _applyUVOverrideToMesh(mesh: Mesh, uvRect: Float32Array): void {
    const uvs = mesh.getVerticesData(VertexBuffer.UVKind);
    if (!uvs) return;

    const u1 = uvRect[0];
    const v1 = uvRect[1];
    const u2 = uvRect[2];
    const v2 = uvRect[3];

    // Unit quad UVs are (0,0), (1,0), (1,1), (0,1)
    // Remap to the atlas slice rectangle.
    for (let i = 0; i < uvs.length; i += 2) {
      const u = uvs[i];
      const v = uvs[i + 1];
      uvs[i] = u1 + u * (u2 - u1);
      uvs[i + 1] = v1 + v * (v2 - v1);
    }

    mesh.updateVerticesData(VertexBuffer.UVKind, uvs);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     MATERIAL FACTORY
     ═══════════════════════════════════════════════════════════════════════ */

  private _buildMaterial(rule: TileRule): Material {
    const atlasEntry = this._atlasCache.get(rule.atlasPath);
    const mat = new StandardMaterial(`mat_${rule.sliceName}`, this._scene);

    if (atlasEntry) {
      mat.diffuseTexture = atlasEntry.texture;
      mat.specularColor = new Color3(0.1, 0.1, 0.1);
      mat.ambientColor = new Color3(0.4, 0.4, 0.4);
    }

    if (rule.materialHint === "emissive") {
      mat.emissiveColor = new Color3(0.3, 0.2, 0.1);
    } else if (rule.materialHint === "transparent") {
      mat.alpha = 0.85;
      mat.transparencyMode = Material.MATERIAL_ALPHATEST;
    }

    mat.backFaceCulling = false;
    return mat;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     GEOMETRY HELPERS
     ═══════════════════════════════════════════════════════════════════════ */

  private _createUnitTileVertexData(): VertexData {
    const vd = new VertexData();
    // Unit quad, origin at center, lying on XZ plane (Y-up)
    vd.positions = [
      -0.5, 0, -0.5, // 0
       0.5, 0, -0.5, // 1
       0.5, 0,  0.5, // 2
      -0.5, 0,  0.5, // 3
    ];
    vd.normals = [
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
      0, 1, 0,
    ];
    vd.uvs = [
      0, 0,
      1, 0,
      1, 1,
      0, 1,
    ];
    vd.indices = [0, 2, 1, 0, 3, 2];
    return vd;
  }

  private _createBaseMesh(name: string): Mesh {
    const mesh = new Mesh(name, this._scene);
    this._tileVertexData.applyToMesh(mesh);
    mesh.isVisible = false;
    mesh.doNotSyncBoundingInfo = true;
    return mesh;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     UTILITIES
     ═══════════════════════════════════════════════════════════════════════ */

  private _resolveLayerIndex(layer: TileLayer): LayerIndex {
    switch (layer) {
      case TileLayer.Ground: return LayerIndex.Ground;
      case TileLayer.Details: return LayerIndex.Details;
      case TileLayer.Walls: return LayerIndex.Walls;
      case TileLayer.Roofs: return LayerIndex.Roofs;
      default: return LayerIndex.Ground;
    }
  }

  private _disposeChunk(chunk: Chunk): void {
    for (const d of chunk.disposables) {
      d.dispose();
    }
    for (let i = 0; i < 4; i++) {
      const layer = chunk.layers[i];
      for (const bucket of layer.buckets.values()) {
        bucket.baseMesh.dispose();
        if (bucket.overflowBuckets) {
          for (const ov of bucket.overflowBuckets) {
            ov.baseMesh.dispose();
          }
        }
      }
      layer.parentNode.dispose();
    }
    chunk.isLoaded = false;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 *  Re-export types for consumers
 * ──────────────────────────────────────────────────────────────────────────── */

export type {
  Chunk,
  ChunkLayer,
  MaterialBucket,
  AtlasCacheEntry,
  TileStitchingEngineOptions,
};
