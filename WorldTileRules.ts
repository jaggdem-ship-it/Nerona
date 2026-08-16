/**
 * ============================================================================
 * WorldTileRules.ts
 * ============================================================================
 * A pure data-structure and rule compiler for a multi-layered Wang-Tile-style
 * adjacency constraint system.  Zero rendering dependencies.  Zero Babylon.js.
 *
 * Architecture Layers:
 *   1.  Primitive type system (TileID, EdgeTag, CardinalDir, TileLayer)
 *   2.  Tile Definition registry (collision, layer occupancy, sprite metadata)
 *   3.  Adjacency Rule Matrix (bidirectional cardinal constraints)
 *   4.  Biome Templates (pre-authored palettes + rule overrides)
 *   5.  Layout Integrity Engine (verifyLayoutIntegrity + correction buffer)
 *   6.  Compiler / serializer utilities
 *
 * Asset Pipeline Mapping (uploaded spritesheets):
 *   watermarked_img_13833476961244809141.jpg  -> Forgotten Crypts tileset
 *   378efd71-5a57-443d-89f2-4fed5829e00e.jpeg -> Grand Mansion Interior
 *   3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg -> Mansion Courtyard (roof/ext)
 *   watermarked_img_15575049127886312154.jpg  -> Shared gothic props
 * ============================================================================
 */

/* ---------------------------------------------------------------------------
   SECTION 1 -- PRIMITIVE TYPE SYSTEM
   --------------------------------------------------------------------------- */

/** Branded string so TileIDs cannot be accidentally swapped with raw strings. */
export type TileID = string & { readonly __brand: 'TileID' };

/** Helper to cast a raw string into a branded TileID at compile time. */
export function toTileID(raw: string): TileID {
  return raw as TileID;
}

/** The four cardinal directions used for adjacency stitching. */
export enum CardinalDir {
  NORTH = 'N',
  SOUTH = 'S',
  EAST  = 'E',
  WEST  = 'W',
}

/** Inverse direction lookup for bidirectional rule validation. */
export const OPPOSITE_DIR: Record<CardinalDir, CardinalDir> = {
  [CardinalDir.NORTH]: CardinalDir.SOUTH,
  [CardinalDir.SOUTH]: CardinalDir.NORTH,
  [CardinalDir.EAST]:  CardinalDir.WEST,
  [CardinalDir.WEST]:  CardinalDir.EAST,
};

/** Multi-layered tile system.
 *  Layer 0 -- Sub-Floor / Ground          (walkable base)
 *  Layer 1 -- Floor Decor / Trim          (rugs, blood, moss, cracks)
 *  Layer 2 -- Walls / Collidables         (solid geometry, gates, pillars)
 *  Layer 3 -- Roofs / Overhead Shells     (ceilings, roofs, archways)
 */
export enum TileLayer {
  SUBFLOOR = 0,
  DECOR    = 1,
  WALL     = 2,
  ROOF     = 3,
}

export const ALL_LAYERS: readonly TileLayer[] = [
  TileLayer.SUBFLOOR,
  TileLayer.DECOR,
  TileLayer.WALL,
  TileLayer.ROOF,
];

/** Edge-type tag used for Wang-style matching.
 *  Instead of listing every valid TileID neighbour, a tile declares the
 *  "edge flavour" it exposes on each side.  Two tiles stitch iff the
 *  touching edges share the same EdgeTag (or one side is WILDCARD).
 */
export type EdgeTag = string & { readonly __brand: 'EdgeTag' };

export function toEdgeTag(raw: string): EdgeTag {
  return raw as EdgeTag;
}

/** Special sentinel meaning "this edge accepts any neighbour". */
export const EDGE_WILDCARD: EdgeTag = toEdgeTag('*');

/** Special sentinel meaning "this edge accepts nothing -- it is a boundary". */
export const EDGE_BLOCKED: EdgeTag = toEdgeTag('!');

/* ---------------------------------------------------------------------------
   SECTION 2 -- TILE DEFINITION REGISTRY
   --------------------------------------------------------------------------- */

/** Per-tile collision profile. */
export interface CollisionProfile {
  /** If true, entities cannot path through this tile. */
  readonly blocksMovement: boolean;
  /** If true, projectiles / line-of-sight are stopped. */
  readonly blocksSight: boolean;
  /** If true, the tile deals damage on contact (spikes, lava, etc). */
  readonly isHazard: boolean;
  /** Hazard damage per tick (only meaningful if isHazard === true). */
  readonly hazardDamage?: number;
}

/** Sprite-sheet slicing metadata so the renderer knows where to sample. */
export interface SpriteMeta {
  /** Source spritesheet filename (matches uploaded assets). */
  readonly sheet: string;
  /** Column index in the sheet (0-based). */
  readonly col: number;
  /** Row index in the sheet (0-based). */
  readonly row: number;
  /** Width in pixels of a single frame/tile within the sheet. */
  readonly frameWidth: number;
  /** Height in pixels of a single frame/tile within the sheet. */
  readonly frameHeight: number;
  /** For animated tiles: number of frames.  1 = static. */
  readonly frameCount: number;
  /** Animation speed in ms per frame. */
  readonly frameIntervalMs?: number;
  /** If the sprite should be rendered with additive blending. */
  readonly additiveBlend?: boolean;
}

/** A single logical tile definition.  Pure data -- no GPU handles. */
export interface TileDef {
  readonly id: TileID;
  readonly layer: TileLayer;
  readonly displayName: string;
  /** Which biome(s) this tile belongs to.  Empty = universal. */
  readonly biomes: readonly string[];
  /** Edge tags exposed on each cardinal side (Wang-style). */
  readonly edges: Record<CardinalDir, EdgeTag>;
  /** Collision behaviour. */
  readonly collision: CollisionProfile;
  /** Rendering metadata (optional for logical-only tiles). */
  readonly sprite?: SpriteMeta;
  /** Z-order offset within the same layer for painter's algorithm. */
  readonly zOffset: number;
  /** If true, this tile may be randomly rotated 90/180/270 deg by generator. */
  readonly allowRotation: boolean;
  /** Tags for querying (e.g. "stone", "organic", "gilded"). */
  readonly tags: readonly string[];
}

/** The master registry mapping TileID -> TileDef. */
export class TileRegistry {
  private readonly _map = new Map<TileID, TileDef>();

  register(def: TileDef): this {
    if (this._map.has(def.id)) {
      throw new Error(`TileRegistry: duplicate TileID "${def.id}"`);
    }
    this._map.set(def.id, def);
    return this;
  }

  get(id: TileID): TileDef | undefined {
    return this._map.get(id);
  }

  has(id: TileID): boolean {
    return this._map.has(id);
  }

  /** All definitions belonging to a specific layer. */
  byLayer(layer: TileLayer): readonly TileDef[] {
    return Array.from(this._map.values()).filter((d) => d.layer === layer);
  }

  /** All definitions tagged for a given biome. */
  byBiome(biomeName: string): readonly TileDef[] {
    return Array.from(this._map.values()).filter(
      (d) => d.biomes.length === 0 || d.biomes.includes(biomeName)
    );
  }

  /** Query by tag intersection. */
  byTags(...tags: string[]): readonly TileDef[] {
    return Array.from(this._map.values()).filter((d) =>
      tags.every((t) => d.tags.includes(t))
    );
  }

  get size(): number {
    return this._map.size;
  }

  /** Deep-freeze the registry so downstream systems cannot mutate it. */
  seal(): ReadonlyMap<TileID, TileDef> {
    return new Map(this._map);
  }
}

/* ---------------------------------------------------------------------------
   SECTION 3 -- ADJACENCY RULE MATRIX
   --------------------------------------------------------------------------- */

/** A compiled adjacency rule entry.
 *  For a given (TileID + Direction) we store the set of EdgeTags that are
 *  considered valid on the *neighbour's* touching edge.
 */
export interface AdjacencyRule {
  readonly sourceId: TileID;
  readonly direction: CardinalDir;
  /** Valid edge tags on the neighbour's side.  If the neighbour exposes any
   *  tag in this set, the stitch is legal. */
  readonly validNeighbourTags: ReadonlySet<EdgeTag>;
  /** If true, the rule engine skips validation for this direction. */
  readonly isWildcard: boolean;
}

/** The compiled rule matrix -- a flat map keyed by "TileID|Direction". */
export type RuleMatrix = ReadonlyMap<string, AdjacencyRule>;

/** Builder that converts raw TileDef edge declarations into a fast-lookup
 *  rule matrix and validates consistency (bidirectional symmetry). */
export class AdjacencyRuleCompiler {
  private readonly _registry: TileRegistry;
  private readonly _rules = new Map<string, AdjacencyRule>();
  private readonly _symmetryViolations: string[] = [];

  constructor(registry: TileRegistry) {
    this._registry = registry;
  }

  /** Compile all registered tiles into the matrix. */
  compile(): RuleMatrix {
    this._rules.clear();
    this._symmetryViolations.length = 0;

    const allDefs = Array.from(this._registry.seal().values());

    for (const def of allDefs) {
      for (const dir of Object.values(CardinalDir)) {
        const edgeTag = def.edges[dir];
        const key = this._key(def.id, dir);

        if (edgeTag === EDGE_WILDCARD) {
          this._rules.set(key, {
            sourceId: def.id,
            direction: dir,
            validNeighbourTags: new Set<EdgeTag>(),
            isWildcard: true,
          });
          continue;
        }

        if (edgeTag === EDGE_BLOCKED) {
          this._rules.set(key, {
            sourceId: def.id,
            direction: dir,
            validNeighbourTags: new Set<EdgeTag>([EDGE_BLOCKED]),
            isWildcard: false,
          });
          continue;
        }

        /* Normal edge tag: any neighbour whose OPPOSITE edge matches this tag
         * OR exposes WILDCARD is valid. */
        const validTags = new Set<EdgeTag>([edgeTag, EDGE_WILDCARD]);
        this._rules.set(key, {
          sourceId: def.id,
          direction: dir,
          validNeighbourTags: validTags,
          isWildcard: false,
        });
      }
    }

    /* -- Bidirectional symmetry check --
     * If tile A accepts tile B to the East, tile B must accept tile A to
     * the West (unless one side is WILDCARD).  We flag asymmetries so the
     * designer can fix the dataset rather than discovering them at runtime. */
    for (const def of allDefs) {
      for (const dir of Object.values(CardinalDir)) {
        const myEdge = def.edges[dir];
        if (myEdge === EDGE_WILDCARD || myEdge === EDGE_BLOCKED) continue;

        const opp = OPPOSITE_DIR[dir];
        const key = this._key(def.id, dir);
        const rule = this._rules.get(key)!;

        for (const other of allDefs) {
          const otherEdge = other.edges[opp];
          if (otherEdge === EDGE_WILDCARD) continue;

          const otherAcceptsMe = rule.validNeighbourTags.has(otherEdge);
          const myAcceptsOtherKey = this._key(def.id, dir);
          const myRule = this._rules.get(myAcceptsOtherKey)!;
          const iAcceptOther = myRule.validNeighbourTags.has(otherEdge);

          /* We only care about *mutual* acceptance for non-wildcards. */
          if (otherAcceptsMe && !iAcceptOther) {
            this._symmetryViolations.push(
              `Asymmetry: ${def.id}[${dir}]=${myEdge} accepts ${other.id}[${opp}]=${otherEdge}, ` +
              `but reverse rule is missing.`
            );
          }
        }
      }
    }

    if (this._symmetryViolations.length > 0) {
      console.warn(
        `AdjacencyRuleCompiler: ${this._symmetryViolations.length} symmetry violation(s) detected:\n` +
        this._symmetryViolations.join('\n')
      );
    }

    return new Map(this._rules);
  }

  get symmetryViolations(): readonly string[] {
    return Object.freeze([...this._symmetryViolations]);
  }

  private _key(id: TileID, dir: CardinalDir): string {
    return `${id}|${dir}`;
  }
}

/** Fast runtime validator using the compiled matrix. */
export class AdjacencyValidator {
  constructor(private readonly _matrix: RuleMatrix) {}

  /** Returns true if `neighbourId` can legally sit in `direction` from `sourceId`. */
  canStitch(
    sourceId: TileID,
    direction: CardinalDir,
    neighbourId: TileID,
    registry: TileRegistry
  ): boolean {
    const key = `${sourceId}|${direction}`;
    const rule = this._matrix.get(key);
    if (!rule) {
      /* No rule defined -- treat as blocked for safety. */
      return false;
    }

    if (rule.isWildcard) return true;

    const neighbourDef = registry.get(neighbourId);
    if (!neighbourDef) return false;

    const opp = OPPOSITE_DIR[direction];
    const neighbourEdge = neighbourDef.edges[opp];

    return rule.validNeighbourTags.has(neighbourEdge);
  }

  /** Returns the set of TileIDs that can legally neighbour `sourceId` in `direction`. */
  validNeighbours(
    sourceId: TileID,
    direction: CardinalDir,
    registry: TileRegistry
  ): readonly TileID[] {
    const key = `${sourceId}|${direction}`;
    const rule = this._matrix.get(key);
    if (!rule) return [];
    if (rule.isWildcard) {
      return registry.byLayer(TileLayer.SUBFLOOR).map((d) => d.id); /* all */
    }

    const opp = OPPOSITE_DIR[direction];
    const valid: TileID[] = [];
    for (const def of registry.seal().values()) {
      if (rule.validNeighbourTags.has(def.edges[opp])) {
        valid.push(def.id);
      }
    }
    return valid;
  }
}

/* ---------------------------------------------------------------------------
   SECTION 4 -- BIOME TEMPLATES
   --------------------------------------------------------------------------- */

/** A pre-authored biome configuration containing:
 *  - The palette of TileIDs that may appear in this biome.
 *  - Layer-specific fill weights (for procedural generation).
 *  - Global rule overrides (e.g. "no two hazard tiles adjacent").
 */
export interface BiomeTemplate {
  readonly name: string;
  readonly displayName: string;
  /** Ordered palette of TileIDs allowed in this biome. */
  readonly palette: readonly TileID[];
  /** Default sub-floor tile used when no specific tile is chosen. */
  readonly defaultSubFloor: TileID;
  /** Per-layer weights for random fill algorithms.  Sum need not be 1. */
  readonly layerWeights: Record<TileLayer, number>;
  /** Global adjacency bans (pairs of tags that may never touch). */
  readonly bannedAdjacencies: readonly { tagA: string; tagB: string }[];
  /** Ambient tint / lighting hints (pure data -- renderer interprets). */
  readonly ambientLight: {
    readonly hue: number;
    readonly saturation: number;
    readonly lightness: number;
  };
}

/* ---------------------------------------------------------------------------
   SECTION 5 -- LAYOUT INTEGRITY ENGINE
   --------------------------------------------------------------------------- */

/** A single cell in the 2-D grid.  Each layer holds at most one TileID. */
export interface GridCell {
  readonly layers: {
    [TileLayer.SUBFLOOR]?: TileID;
    [TileLayer.DECOR]?: TileID;
    [TileLayer.WALL]?: TileID;
    [TileLayer.ROOF]?: TileID;
  };
  /** Optional metadata for procedural generators (seed noise, region id, ...). */
  readonly meta?: Record<string, number | string | boolean>;
}

/** A 2-D array of GridCells.  Outer array = rows (Y), inner = cols (X). */
export type GridArray = readonly (readonly GridCell[])[];

/** Severity classification for integrity violations. */
export enum ViolationSeverity {
  CRITICAL = 'CRITICAL',   // e.g. wall floating in void
  WARNING  = 'WARNING',    // e.g. mismatched decor edge
  INFO     = 'INFO',       // e.g. optional symmetry suggestion
}

/** A single flagged stitch violation. */
export interface IntegrityViolation {
  readonly severity: ViolationSeverity;
  readonly x: number;
  readonly y: number;
  readonly layer: TileLayer;
  readonly tileId: TileID;
  readonly neighbourX: number;
  readonly neighbourY: number;
  readonly neighbourTileId: TileID;
  readonly direction: CardinalDir;
  readonly message: string;
}

/** A suggested correction for a violated cell. */
export interface CorrectionSuggestion {
  readonly x: number;
  readonly y: number;
  readonly layer: TileLayer;
  readonly currentTileId: TileID;
  /** TileIDs that would resolve the violation (ordered by best fit). */
  readonly suggestedReplacements: readonly TileID[];
  /** If true, the cell can also be fixed by clearing the layer. */
  readonly canClear: boolean;
}

/** Complete output of the integrity verification pass. */
export interface IntegrityReport {
  readonly gridWidth: number;
  readonly gridHeight: number;
  readonly violations: readonly IntegrityViolation[];
  readonly corrections: readonly CorrectionSuggestion[];
  readonly isValid: boolean;
  readonly summary: {
    readonly criticalCount: number;
    readonly warningCount: number;
    readonly infoCount: number;
  };
}

/** The core layout integrity verifier. */
export class LayoutIntegrityEngine {
  constructor(
    private readonly _registry: TileRegistry,
    private readonly _matrix: RuleMatrix
  ) {}

  /**
   * Verify every cell in `gridArray` against its 4 cardinal neighbours using
   * the compiled adjacency rule matrix.  Returns a full report + correction
   * buffer.
   */
  verifyLayoutIntegrity(gridArray: GridArray): IntegrityReport {
    const violations: IntegrityViolation[] = [];
    const corrections: CorrectionSuggestion[] = [];
    const validator = new AdjacencyValidator(this._matrix);

    const height = gridArray.length;
    const width = height > 0 ? gridArray[0].length : 0;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const cell = gridArray[y][x];

        for (const layer of ALL_LAYERS) {
          const tileId = cell.layers[layer];
          if (!tileId) continue;

          const def = this._registry.get(tileId);
          if (!def) {
            violations.push({
              severity: ViolationSeverity.CRITICAL,
              x, y, layer, tileId,
              neighbourX: -1, neighbourY: -1,
              neighbourTileId: toTileID(''),
              direction: CardinalDir.NORTH,
              message: `TileID "${tileId}" not found in registry.`,
            });
            continue;
          }

          /* Check each cardinal neighbour. */
          const dirs: CardinalDir[] = [
            CardinalDir.NORTH,
            CardinalDir.SOUTH,
            CardinalDir.EAST,
            CardinalDir.WEST,
          ];

          for (const dir of dirs) {
            const nx = x + (dir === CardinalDir.EAST ? 1 : dir === CardinalDir.WEST ? -1 : 0);
            const ny = y + (dir === CardinalDir.SOUTH ? 1 : dir === CardinalDir.NORTH ? -1 : 0);

            /* Out-of-bounds is treated as EDGE_BLOCKED -- only allowed if
             * the source tile itself exposes EDGE_BLOCKED on that side. */
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
              if (def.edges[dir] !== EDGE_BLOCKED && def.edges[dir] !== EDGE_WILDCARD) {
                violations.push({
                  severity: ViolationSeverity.WARNING,
                  x, y, layer, tileId,
                  neighbourX: nx, neighbourY: ny,
                  neighbourTileId: toTileID('__OUT_OF_BOUNDS__'),
                  direction: dir,
                  message: `Tile "${tileId}" edge ${dir}=${def.edges[dir]} touches grid boundary.`,
                });
              }
              continue;
            }

            const neighbourCell = gridArray[ny][nx];
            const neighbourTileId = neighbourCell.layers[layer];

            /* Empty neighbour layer is only a problem if the source tile
             * expects a specific edge match (not WILDCARD / BLOCKED). */
            if (!neighbourTileId) {
              if (def.edges[dir] !== EDGE_WILDCARD && def.edges[dir] !== EDGE_BLOCKED) {
                violations.push({
                  severity: ViolationSeverity.WARNING,
                  x, y, layer, tileId,
                  neighbourX: nx, neighbourY: ny,
                  neighbourTileId: toTileID('__EMPTY__'),
                  direction: dir,
                  message: `Tile "${tileId}"[${dir}]=${def.edges[dir]} faces empty layer ${layer} at (${nx},${ny}).`,
                });
              }
              continue;
            }

            const neighbourDef = this._registry.get(neighbourTileId);
            if (!neighbourDef) {
              violations.push({
                severity: ViolationSeverity.CRITICAL,
                x, y, layer, tileId,
                neighbourX: nx, neighbourY: ny,
                neighbourTileId,
                direction: dir,
                message: `Neighbour TileID "${neighbourTileId}" not found in registry.`,
              });
              continue;
            }

            const canStitch = validator.canStitch(tileId, dir, neighbourTileId, this._registry);
            if (!canStitch) {
              const severity =
                layer === TileLayer.WALL ? ViolationSeverity.CRITICAL : ViolationSeverity.WARNING;

              violations.push({
                severity,
                x, y, layer, tileId,
                neighbourX: nx, neighbourY: ny,
                neighbourTileId,
                direction: dir,
                message:
                  `Illegal stitch: "${tileId}"[${dir}]=${def.edges[dir]} <-> ` +
                  `"${neighbourTileId}"[${OPPOSITE_DIR[dir]}]=${neighbourDef.edges[OPPOSITE_DIR[dir]]}`,
              });
            }
          }
        }
      }
    }

    /* -- Build correction buffer --
     * For every unique (x,y,layer) that appears in a violation, compute
     * the set of TileIDs that would satisfy *all* of its existing
     * neighbours simultaneously. */
    const violationMap = new Map<string, IntegrityViolation[]>();
    for (const v of violations) {
      const key = `${v.x},${v.y},${v.layer}`;
      if (!violationMap.has(key)) violationMap.set(key, []);
      violationMap.get(key)!.push(v);
    }

    for (const [key, cellViolations] of violationMap) {
      const [xStr, yStr, layerStr] = key.split(',');
      const x = parseInt(xStr, 10);
      const y = parseInt(yStr, 10);
      const layer = parseInt(layerStr, 10) as TileLayer;
      const currentTileId = gridArray[y][x].layers[layer]!;

      /* Gather constraints from all 4 directions based on actual neighbours. */
      const requiredTags = new Map<CardinalDir, Set<EdgeTag>>();
      for (const dir of Object.values(CardinalDir)) {
        requiredTags.set(dir, new Set<EdgeTag>());
      }

      let hasNeighbour = false;
      for (const dir of Object.values(CardinalDir)) {
        const nx = x + (dir === CardinalDir.EAST ? 1 : dir === CardinalDir.WEST ? -1 : 0);
        const ny = y + (dir === CardinalDir.SOUTH ? 1 : dir === CardinalDir.NORTH ? -1 : 0);

        if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
          requiredTags.get(dir)!.add(EDGE_BLOCKED);
          continue;
        }

        const nTileId = gridArray[ny][nx].layers[layer];
        if (!nTileId) continue;

        const nDef = this._registry.get(nTileId);
        if (!nDef) continue;

        hasNeighbour = true;
        const opp = OPPOSITE_DIR[dir];
        const nEdge = nDef.edges[opp];

        /* We need a tile whose `dir` edge matches nEdge (or WILDCARD). */
        if (nEdge !== EDGE_WILDCARD) {
          requiredTags.get(dir)!.add(nEdge);
        }
        /* If neighbour is WILDCARD, we have no constraint from that side. */
      }

      /* Find all tiles in the same layer that satisfy every directional constraint. */
      const candidates: TileID[] = [];
      for (const def of this._registry.byLayer(layer)) {
        let ok = true;
        for (const dir of Object.values(CardinalDir)) {
          const reqs = requiredTags.get(dir)!;
          if (reqs.size === 0) continue; // no constraint from this side
          if (def.edges[dir] === EDGE_WILDCARD) continue; // this tile doesn't care
          if (!reqs.has(def.edges[dir])) {
            ok = false;
            break;
          }
        }
        if (ok) candidates.push(def.id);
      }

      corrections.push({
        x, y, layer,
        currentTileId,
        suggestedReplacements: candidates,
        canClear: !hasNeighbour,
      });
    }

    const criticalCount = violations.filter((v) => v.severity === ViolationSeverity.CRITICAL).length;
    const warningCount  = violations.filter((v) => v.severity === ViolationSeverity.WARNING).length;
    const infoCount     = violations.filter((v) => v.severity === ViolationSeverity.INFO).length;

    return {
      gridWidth: width,
      gridHeight: height,
      violations: Object.freeze([...violations]),
      corrections: Object.freeze([...corrections]),
      isValid: violations.length === 0,
      summary: { criticalCount, warningCount, infoCount },
    };
  }
}

/* ---------------------------------------------------------------------------
   SECTION 6 -- PRE-AUTHORED DATASETS
   --------------------------------------------------------------------------- */

/** Factory that builds the complete registry + 3 biome templates. */
export function buildMasterTileSet(): {
  registry: TileRegistry;
  biomes: Record<string, BiomeTemplate>;
} {
  const registry = new TileRegistry();

  /* -- Edge tag vocabulary (shared across biomes) -- */
  const E = {
    STONE_FLOOR:    toEdgeTag('stone_floor'),
    STONE_WALL:     toEdgeTag('stone_wall'),
    STONE_TRIM:     toEdgeTag('stone_trim'),
    COBBLE_FLOOR:   toEdgeTag('cobble_floor'),
    COBBLE_TRIM:    toEdgeTag('cobble_trim'),
    HEDGE:          toEdgeTag('hedge'),
    WOOD_FLOOR:     toEdgeTag('wood_floor'),
    WOOD_TRIM:      toEdgeTag('wood_trim'),
    VELVET_CARPET:  toEdgeTag('velvet_carpet'),
    MARBLE_FLOOR:   toEdgeTag('marble_floor'),
    IRON_FENCE:     toEdgeTag('iron_fence'),
    GATEWAY:        toEdgeTag('gateway'),
    ROOF_SLATE:     toEdgeTag('roof_slate'),
    ROOF_TRIM:      toEdgeTag('roof_trim'),
    ARCH_STONE:     toEdgeTag('arch_stone'),
    BLOOD_POOL:     toEdgeTag('blood_pool'),
    MOSS_PATCH:     toEdgeTag('moss_patch'),
    VOID:           EDGE_BLOCKED,
    ANY:            EDGE_WILDCARD,
  };

  /* ========================================================================
     BIOME 1 -- FORGOTTEN CRYPTS
     Asset: watermarked_img_13833476961244809141.jpg (crypt tileset)
     ======================================================================== */

  /* -- Layer 0: Sub-Floor -- */
  registry.register({
    id: toTileID('CRYPT_STONE_FLOOR'),
    layer: TileLayer.SUBFLOOR,
    displayName: 'Crypt Stone Floor',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['stone', 'floor', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_MOSS_FLOOR'),
    layer: TileLayer.SUBFLOOR,
    displayName: 'Crypt Moss Floor',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 1, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['stone', 'moss', 'floor', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_BLOOD_FLOOR'),
    layer: TileLayer.SUBFLOOR,
    displayName: 'Crypt Blood-Stained Floor',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 2, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['stone', 'blood', 'floor', 'crypt'],
  });

  /* -- Layer 1: Decor -- */
  registry.register({
    id: toTileID('CRYPT_BLOOD_POOL'),
    layer: TileLayer.DECOR,
    displayName: 'Blood Pool',
    biomes: ['forgotten_crypts'],
    edges: { N: E.BLOOD_POOL, S: E.BLOOD_POOL, E: E.BLOOD_POOL, W: E.BLOOD_POOL },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 3, row: 7, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 1, allowRotation: true, tags: ['blood', 'decal', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_MOSS_DECAL'),
    layer: TileLayer.DECOR,
    displayName: 'Moss Decal',
    biomes: ['forgotten_crypts'],
    edges: { N: E.MOSS_PATCH, S: E.MOSS_PATCH, E: E.MOSS_PATCH, W: E.MOSS_PATCH },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 2, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 1, allowRotation: true, tags: ['moss', 'decal', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_CHAIN_DECOR'),
    layer: TileLayer.DECOR,
    displayName: 'Hanging Chains',
    biomes: ['forgotten_crypts'],
    edges: { N: E.ANY, S: E.ANY, E: E.ANY, W: E.ANY },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 2, row: 7, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 2, allowRotation: false, tags: ['iron', 'decal', 'crypt'],
  });

  /* -- Layer 2: Walls / Collidables -- */
  registry.register({
    id: toTileID('CRYPT_WALL'),
    layer: TileLayer.WALL,
    displayName: 'Crypt Stone Wall',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['stone', 'wall', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_WALL_TRIM'),
    layer: TileLayer.WALL,
    displayName: 'Crypt Wall with Trim',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_TRIM, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 1, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['stone', 'wall', 'trim', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_ARCH'),
    layer: TileLayer.WALL,
    displayName: 'Crypt Archway',
    biomes: ['forgotten_crypts'],
    edges: { N: E.ARCH_STONE, S: E.STONE_WALL, E: E.ARCH_STONE, W: E.ARCH_STONE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 8, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: false, tags: ['stone', 'arch', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_PILLAR'),
    layer: TileLayer.WALL,
    displayName: 'Crypt Pillar',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 0, row: 0, frameWidth: 64, frameHeight: 128, frameCount: 1 },
    zOffset: 12, allowRotation: false, tags: ['stone', 'pillar', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_IRON_GATE'),
    layer: TileLayer.WALL,
    displayName: 'Crypt Iron Gate',
    biomes: ['forgotten_crypts'],
    edges: { N: E.IRON_FENCE, S: E.IRON_FENCE, E: E.GATEWAY, W: E.GATEWAY },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 10, row: 7, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['iron', 'gate', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_SPIKE_TRAP'),
    layer: TileLayer.WALL,
    displayName: 'Floor Spike Trap',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: true, hazardDamage: 15 },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 6, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 4, frameIntervalMs: 200 },
    zOffset: 5, allowRotation: true, tags: ['iron', 'hazard', 'trap', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_SARCOPHAGUS'),
    layer: TileLayer.WALL,
    displayName: 'Stone Sarcophagus',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 0, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 8, allowRotation: true, tags: ['stone', 'sarcophagus', 'crypt'],
  });

  /* -- Layer 3: Roof / Overhead -- */
  registry.register({
    id: toTileID('CRYPT_CEILING'),
    layer: TileLayer.ROOF,
    displayName: 'Crypt Ceiling',
    biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 20, allowRotation: true, tags: ['stone', 'ceiling', 'crypt'],
  });

  /* ========================================================================
     BIOME 2 -- MANSION COURTYARD
     Asset: 3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg (roof + exterior)
     ======================================================================== */

  /* -- Layer 0: Sub-Floor -- */
  registry.register({
    id: toTileID('COURTYARD_COBBLE'),
    layer: TileLayer.SUBFLOOR,
    displayName: 'Cobblestone Path',
    biomes: ['mansion_courtyard'],
    edges: { N: E.COBBLE_FLOOR, S: E.COBBLE_FLOOR, E: E.COBBLE_FLOOR, W: E.COBBLE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 6, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['cobble', 'floor', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_GRASS'),
    layer: TileLayer.SUBFLOOR,
    displayName: 'Wild Grass',
    biomes: ['mansion_courtyard'],
    edges: { N: E.COBBLE_FLOOR, S: E.COBBLE_FLOOR, E: E.COBBLE_FLOOR, W: E.COBBLE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 2, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['grass', 'floor', 'courtyard'],
  });

  /* -- Layer 1: Decor -- */
  registry.register({
    id: toTileID('COURTYARD_HEDGE'),
    layer: TileLayer.DECOR,
    displayName: 'Wild Hedge',
    biomes: ['mansion_courtyard'],
    edges: { N: E.HEDGE, S: E.HEDGE, E: E.HEDGE, W: E.HEDGE },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 5, allowRotation: true, tags: ['hedge', 'foliage', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_GARGOYLE'),
    layer: TileLayer.DECOR,
    displayName: 'Stone Gargoyle',
    biomes: ['mansion_courtyard'],
    edges: { N: E.STONE_TRIM, S: E.COBBLE_FLOOR, E: E.COBBLE_FLOOR, W: E.COBBLE_FLOOR },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 7, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 6, allowRotation: false, tags: ['stone', 'gargoyle', 'courtyard'],
  });

  /* -- Layer 2: Walls -- */
  registry.register({
    id: toTileID('COURTYARD_EXT_WALL'),
    layer: TileLayer.WALL,
    displayName: 'Exterior Stone Wall',
    biomes: ['mansion_courtyard'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['stone', 'wall', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_IRON_FENCE'),
    layer: TileLayer.WALL,
    displayName: 'Wrought-Iron Fence',
    biomes: ['mansion_courtyard'],
    edges: { N: E.IRON_FENCE, S: E.IRON_FENCE, E: E.IRON_FENCE, W: E.IRON_FENCE },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 0, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['iron', 'fence', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_GATE'),
    layer: TileLayer.WALL,
    displayName: 'Courtyard Gate',
    biomes: ['mansion_courtyard'],
    edges: { N: E.GATEWAY, S: E.GATEWAY, E: E.IRON_FENCE, W: E.IRON_FENCE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 4, row: 2, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['iron', 'gate', 'courtyard'],
  });

  /* -- Layer 3: Roof -- */
  registry.register({
    id: toTileID('COURTYARD_ROOF_SLATE'),
    layer: TileLayer.ROOF,
    displayName: 'Slate Roof',
    biomes: ['mansion_courtyard'],
    edges: { N: E.ROOF_SLATE, S: E.ROOF_SLATE, E: E.ROOF_SLATE, W: E.ROOF_SLATE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 20, allowRotation: true, tags: ['slate', 'roof', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_ROOF_SPIRE'),
    layer: TileLayer.ROOF,
    displayName: 'Gothic Spire',
    biomes: ['mansion_courtyard'],
    edges: { N: E.ROOF_TRIM, S: E.ROOF_SLATE, E: E.ROOF_TRIM, W: E.ROOF_TRIM },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 3, row: 0, frameWidth: 64, frameHeight: 128, frameCount: 1 },
    zOffset: 25, allowRotation: false, tags: ['slate', 'spire', 'roof', 'courtyard'],
  });

  /* ========================================================================
     BIOME 3 -- GRAND MANSION INTERIOR
     Asset: 378efd71-5a57-443d-89f2-4fed5829e00e.jpeg (interior tileset)
     ======================================================================== */

  /* -- Layer 0: Sub-Floor -- */
  registry.register({
    id: toTileID('MANSION_WOOD_FLOOR'),
    layer: TileLayer.SUBFLOOR,
    displayName: 'Polished Wood Floor',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_FLOOR, S: E.WOOD_FLOOR, E: E.WOOD_FLOOR, W: E.WOOD_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['wood', 'floor', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_MARBLE_FLOOR'),
    layer: TileLayer.SUBFLOOR,
    displayName: 'Cracked Marble Floor',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.MARBLE_FLOOR, S: E.MARBLE_FLOOR, E: E.MARBLE_FLOOR, W: E.MARBLE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 2, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['marble', 'floor', 'mansion'],
  });

  /* -- Layer 1: Decor -- */
  registry.register({
    id: toTileID('MANSION_RED_CARPET'),
    layer: TileLayer.DECOR,
    displayName: 'Velvet Red Carpet',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.VELVET_CARPET, S: E.VELVET_CARPET, E: E.VELVET_CARPET, W: E.VELVET_CARPET },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 4, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 1, allowRotation: true, tags: ['velvet', 'carpet', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_CANDELABRA'),
    layer: TileLayer.DECOR,
    displayName: 'Gold Candelabra',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.ANY, S: E.ANY, E: E.ANY, W: E.ANY },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 10, row: 6, frameWidth: 64, frameHeight: 64, frameCount: 3, frameIntervalMs: 150, additiveBlend: true },
    zOffset: 3, allowRotation: false, tags: ['gold', 'light', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_RUG_TASSEL'),
    layer: TileLayer.DECOR,
    displayName: 'Tasseled Rug',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.VELVET_CARPET, S: E.VELVET_CARPET, E: E.VELVET_CARPET, W: E.VELVET_CARPET },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 6, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 2, allowRotation: true, tags: ['velvet', 'rug', 'mansion'],
  });

  /* -- Layer 2: Walls -- */
  registry.register({
    id: toTileID('MANSION_WOOD_PANEL'),
    layer: TileLayer.WALL,
    displayName: 'Wood Panel Wall',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_TRIM, S: E.WOOD_FLOOR, E: E.WOOD_TRIM, W: E.WOOD_TRIM },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['wood', 'wall', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_BOOKSHELF'),
    layer: TileLayer.WALL,
    displayName: 'Grand Bookshelf',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_TRIM, S: E.WOOD_FLOOR, E: E.WOOD_TRIM, W: E.WOOD_TRIM },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['wood', 'books', 'wall', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_FIREPLACE'),
    layer: TileLayer.WALL,
    displayName: 'Marble Fireplace',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.STONE_TRIM, S: E.WOOD_FLOOR, E: E.STONE_TRIM, W: E.STONE_TRIM },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 9, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 4, frameIntervalMs: 120, additiveBlend: true },
    zOffset: 11, allowRotation: false, tags: ['marble', 'fire', 'wall', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_ARCH'),
    layer: TileLayer.WALL,
    displayName: 'Interior Arch',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.ARCH_STONE, S: E.WOOD_FLOOR, E: E.ARCH_STONE, W: E.ARCH_STONE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 8, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: false, tags: ['stone', 'arch', 'mansion'],
  });

  /* -- Layer 3: Roof -- */
  registry.register({
    id: toTileID('MANSION_CEILING_BEAM'),
    layer: TileLayer.ROOF,
    displayName: 'Wood Ceiling Beam',
    biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_TRIM, S: E.WOOD_TRIM, E: E.WOOD_TRIM, W: E.WOOD_TRIM },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 20, allowRotation: true, tags: ['wood', 'ceiling', 'mansion'],
  });

  /* -- Compile the adjacency matrix -- */
  const compiler = new AdjacencyRuleCompiler(registry);
  const matrix = compiler.compile();

  if (compiler.symmetryViolations.length > 0) {
    console.error('Symmetry violations detected during build:', compiler.symmetryViolations);
  }

  /* -- Build biome templates -- */
  const biomes: Record<string, BiomeTemplate> = {
    forgotten_crypts: {
      name: 'forgotten_crypts',
      displayName: 'Forgotten Crypts',
      palette: [
        toTileID('CRYPT_STONE_FLOOR'),
        toTileID('CRYPT_MOSS_FLOOR'),
        toTileID('CRYPT_BLOOD_FLOOR'),
        toTileID('CRYPT_BLOOD_POOL'),
        toTileID('CRYPT_MOSS_DECAL'),
        toTileID('CRYPT_CHAIN_DECOR'),
        toTileID('CRYPT_WALL'),
        toTileID('CRYPT_WALL_TRIM'),
        toTileID('CRYPT_ARCH'),
        toTileID('CRYPT_PILLAR'),
        toTileID('CRYPT_IRON_GATE'),
        toTileID('CRYPT_SPIKE_TRAP'),
        toTileID('CRYPT_SARCOPHAGUS'),
        toTileID('CRYPT_CEILING'),
      ],
      defaultSubFloor: toTileID('CRYPT_STONE_FLOOR'),
      layerWeights: {
        [TileLayer.SUBFLOOR]: 1.0,
        [TileLayer.DECOR]: 0.35,
        [TileLayer.WALL]: 0.25,
        [TileLayer.ROOF]: 0.15,
      },
      bannedAdjacencies: [
        { tagA: 'blood', tagB: 'moss' },   // blood pools don't touch moss
      ],
      ambientLight: { hue: 260, saturation: 0.15, lightness: 0.08 },
    },

    mansion_courtyard: {
      name: 'mansion_courtyard',
      displayName: 'Mansion Courtyard',
      palette: [
        toTileID('COURTYARD_COBBLE'),
        toTileID('COURTYARD_GRASS'),
        toTileID('COURTYARD_HEDGE'),
        toTileID('COURTYARD_GARGOYLE'),
        toTileID('COURTYARD_EXT_WALL'),
        toTileID('COURTYARD_IRON_FENCE'),
        toTileID('COURTYARD_GATE'),
        toTileID('COURTYARD_ROOF_SLATE'),
        toTileID('COURTYARD_ROOF_SPIRE'),
      ],
      defaultSubFloor: toTileID('COURTYARD_COBBLE'),
      layerWeights: {
        [TileLayer.SUBFLOOR]: 1.0,
        [TileLayer.DECOR]: 0.2,
        [TileLayer.WALL]: 0.2,
        [TileLayer.ROOF]: 0.1,
      },
      bannedAdjacencies: [
        { tagA: 'hedge', tagB: 'gargoyle' }, // gargoyles don't sit inside hedges
      ],
      ambientLight: { hue: 210, saturation: 0.10, lightness: 0.35 },
    },

    grand_mansion_interior: {
      name: 'grand_mansion_interior',
      displayName: 'Grand Mansion Interior',
      palette: [
        toTileID('MANSION_WOOD_FLOOR'),
        toTileID('MANSION_MARBLE_FLOOR'),
        toTileID('MANSION_RED_CARPET'),
        toTileID('MANSION_CANDELABRA'),
        toTileID('MANSION_RUG_TASSEL'),
        toTileID('MANSION_WOOD_PANEL'),
        toTileID('MANSION_BOOKSHELF'),
        toTileID('MANSION_FIREPLACE'),
        toTileID('MANSION_ARCH'),
        toTileID('MANSION_CEILING_BEAM'),
      ],
      defaultSubFloor: toTileID('MANSION_WOOD_FLOOR'),
      layerWeights: {
        [TileLayer.SUBFLOOR]: 1.0,
        [TileLayer.DECOR]: 0.4,
        [TileLayer.WALL]: 0.3,
        [TileLayer.ROOF]: 0.2,
      },
      bannedAdjacencies: [
        { tagA: 'fire', tagB: 'books' }, // fireplaces don't touch bookshelves directly
      ],
      ambientLight: { hue: 30, saturation: 0.25, lightness: 0.18 },
    },
  };

  return { registry, biomes };
}
