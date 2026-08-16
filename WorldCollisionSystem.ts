import { Vector3 } from "@babylonjs/core";
import type { GridArray, TileRegistry, TileDef, TileLayer } from "./WorldTileRules";

/* ───────────────────────────────────────────────────────────────────────────
   CONSTANTS
   ─────────────────────────────────────────────────────────────────────────── */

/** Default world-unit size of one grid cell (matches TileStitchingEngine). */
const DEFAULT_CELL_SIZE = 2.0;

/** Player capsule radius in world units (matches PlayerController). */
const DEFAULT_PLAYER_RADIUS = 0.5;

/** Player capsule height (used for API completeness; solver is 2.5D). */
const DEFAULT_PLAYER_HEIGHT = 2.0;

/** Maximum solver iterations per frame to resolve corner stacking. */
const DEFAULT_MAX_ITERATIONS = 3;

/** Tiny epsilon added to penetration resolution to prevent numerical sticking. */
const DEFAULT_SKIN_WIDTH = 0.005;

/** Capsule penetration clamp to guard against tunneling on frame spikes. */
const DEFAULT_MAX_PENETRATION = 2.0;

/** Velocity dampening applied to the tangential component on collision. */
const DEFAULT_IMPACT_DAMPENING = 0.92;

/** Default layers treated as structural obstacles (WALL + ROOF). */
const DEFAULT_STRUCTURAL_LAYERS: ReadonlySet<number> = new Set([2, 3]);

/* ───────────────────────────────────────────────────────────────────────────
   TYPE SYSTEM
   ─────────────────────────────────────────────────────────────────────────── */

/** Discriminated collision shape kinds for structural obstacles. */
export const enum CollisionShapeKind {
  AABB = 0,
  CIRCLE = 1,
}

/** Axis-Aligned Bounding Box for walls, building frames, solid stone blocks. */
export interface AABBShape {
  readonly kind: CollisionShapeKind.AABB;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** Circle for cylindrical pillars, posts, columns. */
export interface CircleShape {
  readonly kind: CollisionShapeKind.CIRCLE;
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
}

export type CollisionShape = AABBShape | CircleShape;

/** Internal obstacle descriptor — scalar-only, cache-friendly. */
export interface StructuralObstacle {
  /** Unique insertion index. */
  readonly id: number;
  /** Grid X coordinate (tile space). */
  readonly gridX: number;
  /** Grid Z coordinate (tile space). */
  readonly gridZ: number;
  /** Source layer index. */
  readonly layer: number;
  /** Source TileID for debug / introspection. */
  readonly tileId: string;
  /** World-space collision geometry. */
  readonly shape: CollisionShape;
}

/** Spatial cell bucket — holds obstacle indices into the master flat array. */
interface SpatialCell {
  readonly obstacles: number[];
}

/** Reusable out-parameter buffer to avoid GC churn in the hot loop. */
interface CollisionResult {
  collided: boolean;
  posX: number;
  posZ: number;
  velX: number;
  velZ: number;
}

/** Options for constructing the collision system. */
export interface WorldCollisionSystemOptions {
  /** World-unit size of one spatial-grid cell. Default 2.0. */
  cellSize?: number;
  /** Player capsule radius. Default 0.5. */
  playerRadius?: number;
  /** Player capsule height (informational). Default 2.0. */
  playerHeight?: number;
  /** Solver iterations per frame. Default 3. */
  maxIterations?: number;
  /** Penetration epsilon to prevent sticking. Default 0.005. */
  skinWidth?: number;
  /** Maximum penetration depth clamp. Default 2.0. */
  maxPenetration?: number;
  /** Tangential velocity dampening on contact. Default 0.92. */
  impactDampening?: number;
  /** Which tile layers are treated as structural colliders. Default [2,3]. */
  structuralLayers?: number[];
}

/* ───────────────────────────────────────────────────────────────────────────
   WORLD COLLISION SYSTEM
   ─────────────────────────────────────────────────────────────────────────── */

export class WorldCollisionSystem {
  // ── Configuration ─────────────────────────────────────────────────────
  private readonly _cellSize: number;
  private readonly _invCellSize: number;
  private readonly _playerRadius: number;
  private readonly _playerHeight: number;
  private readonly _maxIterations: number;
  private readonly _skinWidth: number;
  private readonly _maxPenetration: number;
  private readonly _impactDampening: number;
  private readonly _structuralLayers: ReadonlySet<number>;

  // ── Data stores ───────────────────────────────────────────────────────
  private _obstacles: StructuralObstacle[] = [];
  private readonly _spatialGrid = new Map<string, SpatialCell>();
  private _nextObstacleId = 0;

  // ── Hot-loop scratch space (pre-allocated) ─────────────────────────────
  private readonly _queryCache: number[] = new Array(256);
  private _queryCount = 0;
  private readonly _out: CollisionResult = {
    collided: false,
    posX: 0,
    posZ: 0,
    velX: 0,
    velZ: 0,
  };

  constructor(options?: WorldCollisionSystemOptions) {
    this._cellSize = options?.cellSize ?? DEFAULT_CELL_SIZE;
    this._invCellSize = 1.0 / this._cellSize;
    this._playerRadius = options?.playerRadius ?? DEFAULT_PLAYER_RADIUS;
    this._playerHeight = options?.playerHeight ?? DEFAULT_PLAYER_HEIGHT;
    this._maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    this._skinWidth = options?.skinWidth ?? DEFAULT_SKIN_WIDTH;
    this._maxPenetration = options?.maxPenetration ?? DEFAULT_MAX_PENETRATION;
    this._impactDampening = options?.impactDampening ?? DEFAULT_IMPACT_DAMPENING;

    const layers = options?.structuralLayers;
    this._structuralLayers = layers
      ? new Set(layers)
      : DEFAULT_STRUCTURAL_LAYERS;
  }

  /* ═════════════════════════════════════════════════════════════════════
     PUBLIC API — Map ingestion
     ═════════════════════════════════════════════════════════════════════ */

  /**
   * Build the entire collision index from a `GridArray` + `TileRegistry`.
   *
   * Automatically scans Layers 2 (Walls) and 3 (Roofs / Exterior frames)
   * and generates exact geometric bounds:
   *   • Wall / frame tiles → AABB 2.0×2.0 world units
   *   • Pillar / column tiles → Circle radius 0.55 world units
   */
  public buildFromGridArray(gridArray: GridArray, registry: TileRegistry): void {
    this.clear();

    const height = gridArray.length;
    const width = height > 0 ? gridArray[0].length : 0;

    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        const cell = gridArray[z][x];
        for (const layer of this._structuralLayers) {
          const tileId = cell.layers[layer as TileLayer];
          if (!tileId) continue;

          const def = registry.get(tileId);
          if (!def || !def.collision.blocksMovement) continue;

          const shape = this._inferShapeFromTileDef(def, x, z);
          if (!shape) continue;

          this._addObstacle(x, z, layer, tileId, shape);
        }
      }
    }
  }

  /**
   * Low-level matrix ingestion for custom pipelines or editor tooling.
   *
   * @param layers      3-D array: layers[layer][z][x] = tileId | null
   * @param width       Matrix width in tiles
   * @param height      Matrix height in tiles
   * @param cellSize    World-unit size of one tile
   * @param resolver    Callback mapping (tileId, layer, x, z) → shape or null
   */
  public buildFromTileMatrix(
    layers: (string | null)[][][],
    width: number,
    height: number,
    cellSize: number,
    resolver: (tileId: string, layer: number, gridX: number, gridZ: number) => CollisionShape | null
  ): void {
    this.clear();

    for (let layer = 0; layer < layers.length; layer++) {
      if (!this._structuralLayers.has(layer)) continue;
      const layerData = layers[layer];
      if (!layerData) continue;

      for (let z = 0; z < height; z++) {
        const row = layerData[z];
        if (!row) continue;
        for (let x = 0; x < width; x++) {
          const tileId = row[x];
          if (!tileId) continue;

          const shape = resolver(tileId, layer, x, z);
          if (!shape) continue;

          this._addObstacle(x, z, layer, tileId, shape);
        }
      }
    }
  }

  /** Wipe all obstacles and reset the spatial index. */
  public clear(): void {
    this._obstacles.length = 0;
    this._spatialGrid.clear();
    this._nextObstacleId = 0;
    this._queryCount = 0;
  }

  /* ═════════════════════════════════════════════════════════════════════
     PUBLIC API — Frame resolution
     ═════════════════════════════════════════════════════════════════════ */

  /**
   * Resolve environmental collisions for the current frame.
   *
   * Mutates `playerPos` and `playerVel` in-place (XZ plane only).
   * Y-component is untouched.
   */
  public resolve(playerPos: Vector3, playerVel: Vector3): void {
    let px = playerPos.x;
    let pz = playerPos.z;
    let vx = playerVel.x;
    let vz = playerVel.z;

    const out = this._out;

    for (let iter = 0; iter < this._maxIterations; iter++) {
      let hadCollision = false;

      // ── Broad-phase: gather candidate obstacles from 3×3 spatial cells ──
      this._queryCount = 0;
      this._gatherCandidates(px, pz);

      // ── Narrow-phase: AABB vs Capsule  +  Circle vs Circle ──
      for (let i = 0; i < this._queryCount; i++) {
        const obs = this._obstacles[this._queryCache[i]];
        out.collided = false;

        if (obs.shape.kind === CollisionShapeKind.AABB) {
          this._resolveAABBvsCapsule(px, pz, vx, vz, obs.shape, out);
        } else {
          this._resolveCirclevsCircle(px, pz, vx, vz, obs.shape, out);
        }

        if (out.collided) {
          px = out.posX;
          pz = out.posZ;
          vx = out.velX;
          vz = out.velZ;
          hadCollision = true;
        }
      }

      if (!hadCollision) break;
    }

    // Write back
    playerPos.x = px;
    playerPos.z = pz;
    playerVel.x = vx;
    playerVel.z = vz;
  }

  /**
   * Scalar variant for systems that do not use Babylon `Vector3`.
   * Returns the corrected position and velocity.
   */
  public resolveScalar(
    posX: number,
    posZ: number,
    velX: number,
    velZ: number
  ): { posX: number; posZ: number; velX: number; velZ: number } {
    const pos = new Vector3(posX, 0, posZ);
    const vel = new Vector3(velX, 0, velZ);
    this.resolve(pos, vel);
    return { posX: pos.x, posZ: pos.z, velX: vel.x, velZ: vel.z };
  }

  /* ═════════════════════════════════════════════════════════════════════
     PUBLIC API — Introspection
     ═════════════════════════════════════════════════════════════════════ */

  /** Total structural obstacles in the active index. */
  public get obstacleCount(): number {
    return this._obstacles.length;
  }

  /** Number of populated spatial-grid cells. */
  public get gridCellCount(): number {
    return this._spatialGrid.size;
  }

  /** Read-only snapshot of all obstacles for debug visualization. */
  public getDebugObstacles(): ReadonlyArray<Readonly<StructuralObstacle>> {
    return this._obstacles;
  }

  /* ═════════════════════════════════════════════════════════════════════
     INTERNALS — Shape inference
     ═════════════════════════════════════════════════════════════════════ */

  /**
   * Heuristic mapping from `TileDef` tags → exact collision geometry.
   *
   * Rules:
   *   • Tags containing 'pillar', 'column', 'post', 'cylinder' → Circle r=0.55
   *   • Everything else that blocksMovement → AABB 2.0×2.0 (full tile)
   */
  private _inferShapeFromTileDef(def: TileDef, gridX: number, gridZ: number): CollisionShape | null {
    const tags = def.tags.map((t) => t.toLowerCase());
    const isPillar = tags.some(
      (t) => t.includes("pillar") || t.includes("column") || t.includes("post") || t.includes("cylinder")
    );

    const worldX = gridX * this._cellSize + this._cellSize * 0.5;
    const worldZ = gridZ * this._cellSize + this._cellSize * 0.5;

    if (isPillar) {
      return {
        kind: CollisionShapeKind.CIRCLE,
        cx: worldX,
        cz: worldZ,
        radius: 0.55,
      };
    }

    const half = this._cellSize * 0.5;
    return {
      kind: CollisionShapeKind.AABB,
      minX: worldX - half,
      minZ: worldZ - half,
      maxX: worldX + half,
      maxZ: worldZ + half,
    };
  }

  /* ═════════════════════════════════════════════════════════════════════
     INTERNALS — Spatial index
     ═════════════════════════════════════════════════════════════════════ */

  private _addObstacle(
    gridX: number,
    gridZ: number,
    layer: number,
    tileId: string,
    shape: CollisionShape
  ): void {
    const obstacle: StructuralObstacle = {
      id: this._nextObstacleId++,
      gridX,
      gridZ,
      layer,
      tileId,
      shape,
    };

    const idx = this._obstacles.length;
    this._obstacles.push(obstacle);

    // Spatial key derived from world position (one cell == one tile by default)
    const worldX = gridX * this._cellSize + this._cellSize * 0.5;
    const worldZ = gridZ * this._cellSize + this._cellSize * 0.5;
    const cellX = Math.floor(worldX * this._invCellSize);
    const cellZ = Math.floor(worldZ * this._invCellSize);
    const key = `${cellX},${cellZ}`;

    let cell = this._spatialGrid.get(key);
    if (!cell) {
      cell = { obstacles: [] };
      this._spatialGrid.set(key, cell);
    }
    cell.obstacles.push(idx);
  }

  /** Populate `_queryCache` with obstacle indices from the 3×3 neighbourhood. */
  private _gatherCandidates(px: number, pz: number): void {
    const cellX = Math.floor(px * this._invCellSize);
    const cellZ = Math.floor(pz * this._invCellSize);

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const key = `${cellX + dx},${cellZ + dz}`;
        const cell = this._spatialGrid.get(key);
        if (!cell) continue;

        const count = cell.obstacles.length;
        for (let i = 0; i < count; i++) {
          this._queryCache[this._queryCount++] = cell.obstacles[i];
        }
      }
    }
  }

  /* ═════════════════════════════════════════════════════════════════════
     INTERNALS — AABB vs Capsule (2.5D projection)
     ═════════════════════════════════════════════════════════════════════ */

  /**
   * Resolve a single AABB vs upright-capsule contact.
   *
   * The capsule is projected onto the XZ plane as a circle with radius
   * `_playerRadius`.  When the circle center lies inside the AABB, the
   * minimum-overlap axis is chosen to push the player out.
   *
   * Velocity is projected onto the collision tangent plane (slide response).
   */
  private _resolveAABBvsCapsule(
    px: number,
    pz: number,
    vx: number,
    vz: number,
    aabb: Readonly<AABBShape>,
    out: CollisionResult
  ): void {
    // Fast broad rejection
    if (
      px + this._playerRadius < aabb.minX ||
      px - this._playerRadius > aabb.maxX ||
      pz + this._playerRadius < aabb.minZ ||
      pz - this._playerRadius > aabb.maxZ
    ) {
      out.collided = false;
      return;
    }

    const insideX = px >= aabb.minX && px <= aabb.maxX;
    const insideZ = pz >= aabb.minZ && pz <= aabb.maxZ;

    // ── Case A: circle center is inside the AABB ─────────────────────────
    if (insideX && insideZ) {
      const penLeft = px - aabb.minX;
      const penRight = aabb.maxX - px;
      const penBottom = pz - aabb.minZ;
      const penTop = aabb.maxZ - pz;

      const overlapLeft = this._playerRadius - penLeft;
      const overlapRight = this._playerRadius - penRight;
      const overlapBottom = this._playerRadius - penBottom;
      const overlapTop = this._playerRadius - penTop;

      // Fully contained circle → no collision
      if (overlapLeft <= 0 && overlapRight <= 0 && overlapBottom <= 0 && overlapTop <= 0) {
        out.collided = false;
        return;
      }

      // Minimum positive overlap axis
      let minOverlap = Infinity;
      let nx = 0;
      let nz = 0;

      if (overlapLeft > 0 && overlapLeft < minOverlap) {
        minOverlap = overlapLeft;
        nx = -1;
        nz = 0;
      }
      if (overlapRight > 0 && overlapRight < minOverlap) {
        minOverlap = overlapRight;
        nx = 1;
        nz = 0;
      }
      if (overlapBottom > 0 && overlapBottom < minOverlap) {
        minOverlap = overlapBottom;
        nx = 0;
        nz = -1;
      }
      if (overlapTop > 0 && overlapTop < minOverlap) {
        minOverlap = overlapTop;
        nx = 0;
        nz = 1;
      }

      if (minOverlap === Infinity) {
        out.collided = false;
        return;
      }

      const pushDist = minOverlap + this._skinWidth;
      out.posX = px + nx * pushDist;
      out.posZ = pz + nz * pushDist;

      // Slide response: strip normal component from velocity
      const velDotN = vx * nx + vz * nz;
      if (velDotN < 0) {
        out.velX = (vx - velDotN * nx) * this._impactDampening;
        out.velZ = (vz - velDotN * nz) * this._impactDampening;
      } else {
        out.velX = vx;
        out.velZ = vz;
      }

      out.collided = true;
      return;
    }

    // ── Case B: circle center outside AABB ──────────────────────────────
    const closestX = Math.max(aabb.minX, Math.min(px, aabb.maxX));
    const closestZ = Math.max(aabb.minZ, Math.min(pz, aabb.maxZ));
    const dx = px - closestX;
    const dz = pz - closestZ;
    const distSq = dx * dx + dz * dz;

    if (distSq >= this._playerRadius * this._playerRadius) {
      out.collided = false;
      return;
    }

    const dist = Math.sqrt(distSq);
    let nx: number;
    let nz: number;

    if (dist > 1e-4) {
      nx = dx / dist;
      nz = dz / dist;
    } else {
      // Degenerate: push away from AABB centre
      const cx = (aabb.minX + aabb.maxX) * 0.5;
      const cz = (aabb.minZ + aabb.maxZ) * 0.5;
      const cdx = px - cx;
      const cdz = pz - cz;
      const cdist = Math.sqrt(cdx * cdx + cdz * cdz);
      if (cdist > 1e-4) {
        nx = cdx / cdist;
        nz = cdz / cdist;
      } else {
        nx = 0;
        nz = 1;
      }
    }

    const penetration = this._playerRadius - dist;
    const clampedPen = Math.min(penetration, this._maxPenetration);
    const pushDist = clampedPen + this._skinWidth;

    out.posX = px + nx * pushDist;
    out.posZ = pz + nz * pushDist;

    const velDotN = vx * nx + vz * nz;
    if (velDotN < 0) {
      out.velX = (vx - velDotN * nx) * this._impactDampening;
      out.velZ = (vz - velDotN * nz) * this._impactDampening;
    } else {
      out.velX = vx;
      out.velZ = vz;
    }

    out.collided = true;
  }

  /* ═════════════════════════════════════════════════════════════════════
     INTERNALS — Circle vs Circle
     ═════════════════════════════════════════════════════════════════════ */

  /**
   * Resolve a single Circle vs Circle contact (pillars, posts).
   */
  private _resolveCirclevsCircle(
    px: number,
    pz: number,
    vx: number,
    vz: number,
    circle: Readonly<CircleShape>,
    out: CollisionResult
  ): void {
    const dx = px - circle.cx;
    const dz = pz - circle.cz;
    const distSq = dx * dx + dz * dz;
    const combinedRadius = this._playerRadius + circle.radius;

    if (distSq >= combinedRadius * combinedRadius) {
      out.collided = false;
      return;
    }

    const dist = Math.sqrt(distSq);
    let nx: number;
    let nz: number;

    if (dist > 1e-4) {
      nx = dx / dist;
      nz = dz / dist;
    } else {
      nx = 0;
      nz = 1;
    }

    const penetration = combinedRadius - dist;
    const clampedPen = Math.min(penetration, this._maxPenetration);
    const pushDist = clampedPen + this._skinWidth;

    out.posX = px + nx * pushDist;
    out.posZ = pz + nz * pushDist;

    const velDotN = vx * nx + vz * nz;
    if (velDotN < 0) {
      out.velX = (vx - velDotN * nx) * this._impactDampening;
      out.velZ = (vz - velDotN * nz) * this._impactDampening;
    } else {
      out.velX = vx;
      out.velZ = vz;
    }

    out.collided = true;
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   RE-EXPORTS (convenience for consumers)
   ─────────────────────────────────────────────────────────────────────────── */

export type { WorldCollisionSystemOptions, StructuralObstacle, CollisionShape, CollisionResult };
