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

/** Edge-type tag used for Wang-style matching. */
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

export interface CollisionProfile {
  readonly blocksMovement: boolean;
  readonly blocksSight: boolean;
  readonly isHazard: boolean;
  readonly hazardDamage?: number;
}

export interface SpriteMeta {
  readonly sheet: string;
  readonly col: number;
  readonly row: number;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
  readonly frameIntervalMs?: number;
  readonly additiveBlend?: boolean;
}

export interface TileDef {
  readonly id: TileID;
  readonly layer: TileLayer;
  readonly displayName: string;
  readonly biomes: readonly string[];
  readonly edges: Record<CardinalDir, EdgeTag>;
  readonly collision: CollisionProfile;
  readonly sprite?: SpriteMeta;
  readonly zOffset: number;
  readonly allowRotation: boolean;
  readonly tags: readonly string[];
}

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

  byLayer(layer: TileLayer): readonly TileDef[] {
    return Array.from(this._map.values()).filter((d) => d.layer === layer);
  }

  byBiome(biomeName: string): readonly TileDef[] {
    return Array.from(this._map.values()).filter(
      (d) => d.biomes.length === 0 || d.biomes.includes(biomeName)
    );
  }

  byTags(...tags: string[]): readonly TileDef[] {
    return Array.from(this._map.values()).filter((d) =>
      tags.every((t) => d.tags.includes(t))
    );
  }

  get size(): number {
    return this._map.size;
  }

  seal(): ReadonlyMap<TileID, TileDef> {
    return new Map(this._map);
  }
}

/* ---------------------------------------------------------------------------
   SECTION 3 -- ADJACENCY RULE MATRIX
   --------------------------------------------------------------------------- */

export interface AdjacencyRule {
  readonly sourceId: TileID;
  readonly direction: CardinalDir;
  readonly validNeighbourTags: ReadonlySet<EdgeTag>;
  readonly isWildcard: boolean;
}

export type RuleMatrix = ReadonlyMap<string, AdjacencyRule>;

export class AdjacencyRuleCompiler {
  private readonly _registry: TileRegistry;
  private readonly _rules = new Map<string, AdjacencyRule>();
  private readonly _symmetryViolations: string[] = [];

  constructor(registry: TileRegistry) {
    this._registry = registry;
  }

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

        const validTags = new Set<EdgeTag>([edgeTag, EDGE_WILDCARD]);
        this._rules.set(key, {
          sourceId: def.id,
          direction: dir,
          validNeighbourTags: validTags,
          isWildcard: false,
        });
      }
    }

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

export class AdjacencyValidator {
  constructor(private readonly _matrix: RuleMatrix) {}

  canStitch(
    sourceId: TileID,
    direction: CardinalDir,
    neighbourId: TileID,
    registry: TileRegistry
  ): boolean {
    const key = `${sourceId}|${direction}`;
    const rule = this._matrix.get(key);
    if (!rule) {
      return false;
    }

    if (rule.isWildcard) return true;

    const neighbourDef = registry.get(neighbourId);
    if (!neighbourDef) return false;

    const opp = OPPOSITE_DIR[direction];
    const neighbourEdge = neighbourDef.edges[opp];

    return rule.validNeighbourTags.has(neighbourEdge);
  }

  validNeighbours(
    sourceId: TileID,
    direction: CardinalDir,
    registry: TileRegistry
  ): readonly TileID[] {
    const key = `${sourceId}|${direction}`;
    const rule = this._matrix.get(key);
    if (!rule) return [];
    if (rule.isWildcard) {
      return registry.byLayer(TileLayer.SUBFLOOR).map((d) => d.id);
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

export interface BiomeTemplate {
  readonly name: string;
  readonly displayName: string;
  readonly palette: readonly TileID[];
  readonly defaultSubFloor: TileID;
  readonly layerWeights: Record<TileLayer, number>;
  readonly bannedAdjacencies: readonly { tagA: string; tagB: string }[];
  readonly ambientLight: {
    readonly hue: number;
    readonly saturation: number;
    readonly lightness: number;
  };
}

/* ---------------------------------------------------------------------------
   SECTION 5 -- LAYOUT INTEGRITY ENGINE
   --------------------------------------------------------------------------- */

export interface GridCell {
  readonly layers: {
    [TileLayer.SUBFLOOR]?: TileID;
    [TileLayer.DECOR]?: TileID;
    [TileLayer.WALL]?: TileID;
    [TileLayer.ROOF]?: TileID;
  };
  readonly meta?: Record<string, number | string | boolean>;
}

export type GridArray = readonly (readonly GridCell[])[];

export enum ViolationSeverity {
  CRITICAL = 'CRITICAL',
  WARNING  = 'WARNING',
  INFO     = 'INFO',
}

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

export interface CorrectionSuggestion {
  readonly x: number;
  readonly y: number;
  readonly layer: TileLayer;
  readonly currentTileId: TileID;
  readonly suggestedReplacements: readonly TileID[];
  readonly canClear: boolean;
}

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

export class LayoutIntegrityEngine {
  constructor(
    private readonly _registry: TileRegistry,
    private readonly _matrix: RuleMatrix
  ) {}

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

          const dirs: CardinalDir[] = [
            CardinalDir.NORTH,
            CardinalDir.SOUTH,
            CardinalDir.EAST,
            CardinalDir.WEST,
          ];

          for (const dir of dirs) {
            const nx = x + (dir === CardinalDir.EAST ? 1 : dir === CardinalDir.WEST ? -1 : 0);
            const ny = y + (dir === CardinalDir.SOUTH ? 1 : dir === CardinalDir.NORTH ? -1 : 0);

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

        if (nEdge !== EDGE_WILDCARD) {
          requiredTags.get(dir)!.add(nEdge);
        }
      }

      const candidates: TileID[] = [];
      for (const def of this._registry.byLayer(layer)) {
        let ok = true;
        for (const dir of Object.values(CardinalDir)) {
          const reqs = requiredTags.get(dir)!;
          if (reqs.size === 0) continue;
          if (def.edges[dir] === EDGE_WILDCARD) continue;
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

export function buildMasterTileSet(): {
  registry: TileRegistry;
  biomes: Record<string, BiomeTemplate>;
} {
  const registry = new TileRegistry();

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

  /* BIOME 1 -- FORGOTTEN CRYPTS */
  registry.register({
    id: toTileID('CRYPT_STONE_FLOOR'), layer: TileLayer.SUBFLOOR,
    displayName: 'Crypt Stone Floor', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['stone', 'floor', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_MOSS_FLOOR'), layer: TileLayer.SUBFLOOR,
    displayName: 'Crypt Moss Floor', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 1, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['stone', 'moss', 'floor', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_BLOOD_FLOOR'), layer: TileLayer.SUBFLOOR,
    displayName: 'Crypt Blood-Stained Floor', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 2, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['stone', 'blood', 'floor', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_BLOOD_POOL'), layer: TileLayer.DECOR,
    displayName: 'Blood Pool', biomes: ['forgotten_crypts'],
    edges: { N: E.BLOOD_POOL, S: E.BLOOD_POOL, E: E.BLOOD_POOL, W: E.BLOOD_POOL },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 3, row: 7, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 1, allowRotation: true, tags: ['blood', 'decal', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_MOSS_DECAL'), layer: TileLayer.DECOR,
    displayName: 'Moss Decal', biomes: ['forgotten_crypts'],
    edges: { N: E.MOSS_PATCH, S: E.MOSS_PATCH, E: E.MOSS_PATCH, W: E.MOSS_PATCH },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 2, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 1, allowRotation: true, tags: ['moss', 'decal', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_CHAIN_DECOR'), layer: TileLayer.DECOR,
    displayName: 'Hanging Chains', biomes: ['forgotten_crypts'],
    edges: { N: E.ANY, S: E.ANY, E: E.ANY, W: E.ANY },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 2, row: 7, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 2, allowRotation: false, tags: ['iron', 'decal', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_WALL'), layer: TileLayer.WALL,
    displayName: 'Crypt Stone Wall', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['stone', 'wall', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_WALL_TRIM'), layer: TileLayer.WALL,
    displayName: 'Crypt Wall with Trim', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_TRIM, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 1, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['stone', 'wall', 'trim', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_ARCH'), layer: TileLayer.WALL,
    displayName: 'Crypt Archway', biomes: ['forgotten_crypts'],
    edges: { N: E.ARCH_STONE, S: E.STONE_WALL, E: E.ARCH_STONE, W: E.ARCH_STONE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 8, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: false, tags: ['stone', 'arch', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_PILLAR'), layer: TileLayer.WALL,
    displayName: 'Crypt Pillar', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 0, row: 0, frameWidth: 64, frameHeight: 128, frameCount: 1 },
    zOffset: 12, allowRotation: false, tags: ['stone', 'pillar', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_IRON_GATE'), layer: TileLayer.WALL,
    displayName: 'Crypt Iron Gate', biomes: ['forgotten_crypts'],
    edges: { N: E.IRON_FENCE, S: E.IRON_FENCE, E: E.GATEWAY, W: E.GATEWAY },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 10, row: 7, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['iron', 'gate', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_SPIKE_TRAP'), layer: TileLayer.WALL,
    displayName: 'Floor Spike Trap', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_FLOOR, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: true, hazardDamage: 15 },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 6, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 4, frameIntervalMs: 200 },
    zOffset: 5, allowRotation: true, tags: ['iron', 'hazard', 'trap', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_SARCOPHAGUS'), layer: TileLayer.WALL,
    displayName: 'Stone Sarcophagus', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_FLOOR, E: E.STONE_FLOOR, W: E.STONE_FLOOR },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 0, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 8, allowRotation: true, tags: ['stone', 'sarcophagus', 'crypt'],
  });

  registry.register({
    id: toTileID('CRYPT_CEILING'), layer: TileLayer.ROOF,
    displayName: 'Crypt Ceiling', biomes: ['forgotten_crypts'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 0, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 20, allowRotation: true, tags: ['stone', 'ceiling', 'crypt'],
  });

  /* BIOME 2 -- MANSION COURTYARD */
  registry.register({
    id: toTileID('COURTYARD_COBBLE'), layer: TileLayer.SUBFLOOR,
    displayName: 'Cobblestone Path', biomes: ['mansion_courtyard'],
    edges: { N: E.COBBLE_FLOOR, S: E.COBBLE_FLOOR, E: E.COBBLE_FLOOR, W: E.COBBLE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 6, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['cobble', 'floor', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_GRASS'), layer: TileLayer.SUBFLOOR,
    displayName: 'Wild Grass', biomes: ['mansion_courtyard'],
    edges: { N: E.COBBLE_FLOOR, S: E.COBBLE_FLOOR, E: E.COBBLE_FLOOR, W: E.COBBLE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_13833476961244809141.jpg', col: 2, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['grass', 'floor', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_HEDGE'), layer: TileLayer.DECOR,
    displayName: 'Wild Hedge', biomes: ['mansion_courtyard'],
    edges: { N: E.HEDGE, S: E.HEDGE, E: E.HEDGE, W: E.HEDGE },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 5, allowRotation: true, tags: ['hedge', 'foliage', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_GARGOYLE'), layer: TileLayer.DECOR,
    displayName: 'Stone Gargoyle', biomes: ['mansion_courtyard'],
    edges: { N: E.STONE_TRIM, S: E.COBBLE_FLOOR, E: E.COBBLE_FLOOR, W: E.COBBLE_FLOOR },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 7, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 6, allowRotation: false, tags: ['stone', 'gargoyle', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_EXT_WALL'), layer: TileLayer.WALL,
    displayName: 'Exterior Stone Wall', biomes: ['mansion_courtyard'],
    edges: { N: E.STONE_WALL, S: E.STONE_WALL, E: E.STONE_WALL, W: E.STONE_WALL },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['stone', 'wall', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_IRON_FENCE'), layer: TileLayer.WALL,
    displayName: 'Wrought-Iron Fence', biomes: ['mansion_courtyard'],
    edges: { N: E.IRON_FENCE, S: E.IRON_FENCE, E: E.IRON_FENCE, W: E.IRON_FENCE },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 0, row: 1, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['iron', 'fence', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_GATE'), layer: TileLayer.WALL,
    displayName: 'Courtyard Gate', biomes: ['mansion_courtyard'],
    edges: { N: E.GATEWAY, S: E.GATEWAY, E: E.IRON_FENCE, W: E.IRON_FENCE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: 'watermarked_img_15575049127886312154.jpg', col: 4, row: 2, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['iron', 'gate', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_ROOF_SLATE'), layer: TileLayer.ROOF,
    displayName: 'Slate Roof', biomes: ['mansion_courtyard'],
    edges: { N: E.ROOF_SLATE, S: E.ROOF_SLATE, E: E.ROOF_SLATE, W: E.ROOF_SLATE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 0, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 20, allowRotation: true, tags: ['slate', 'roof', 'courtyard'],
  });

  registry.register({
    id: toTileID('COURTYARD_ROOF_SPIRE'), layer: TileLayer.ROOF,
    displayName: 'Gothic Spire', biomes: ['mansion_courtyard'],
    edges: { N: E.ROOF_TRIM, S: E.ROOF_SLATE, E: E.ROOF_TRIM, W: E.ROOF_TRIM },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '3a20d947-abb5-461c-8568-1c42fe8fbfe1.jpeg', col: 3, row: 0, frameWidth: 64, frameHeight: 128, frameCount: 1 },
    zOffset: 25, allowRotation: false, tags: ['slate', 'spire', 'roof', 'courtyard'],
  });

  /* BIOME 3 -- GRAND MANSION INTERIOR */
  registry.register({
    id: toTileID('MANSION_WOOD_FLOOR'), layer: TileLayer.SUBFLOOR,
    displayName: 'Polished Wood Floor', biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_FLOOR, S: E.WOOD_FLOOR, E: E.WOOD_FLOOR, W: E.WOOD_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['wood', 'floor', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_MARBLE_FLOOR'), layer: TileLayer.SUBFLOOR,
    displayName: 'Cracked Marble Floor', biomes: ['grand_mansion_interior'],
    edges: { N: E.MARBLE_FLOOR, S: E.MARBLE_FLOOR, E: E.MARBLE_FLOOR, W: E.MARBLE_FLOOR },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 2, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 0, allowRotation: true, tags: ['marble', 'floor', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_RED_CARPET'), layer: TileLayer.DECOR,
    displayName: 'Velvet Red Carpet', biomes: ['grand_mansion_interior'],
    edges: { N: E.VELVET_CARPET, S: E.VELVET_CARPET, E: E.VELVET_CARPET, W: E.VELVET_CARPET },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 4, row: 0, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 1, allowRotation: true, tags: ['velvet', 'carpet', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_CANDELABRA'), layer: TileLayer.DECOR,
    displayName: 'Gold Candelabra', biomes: ['grand_mansion_interior'],
    edges: { N: E.ANY, S: E.ANY, E: E.ANY, W: E.ANY },
    collision: { blocksMovement: true, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 10, row: 6, frameWidth: 64, frameHeight: 64, frameCount: 3, frameIntervalMs: 150, additiveBlend: true },
    zOffset: 3, allowRotation: false, tags: ['gold', 'light', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_RUG_TASSEL'), layer: TileLayer.DECOR,
    displayName: 'Tasseled Rug', biomes: ['grand_mansion_interior'],
    edges: { N: E.VELVET_CARPET, S: E.VELVET_CARPET, E: E.VELVET_CARPET, W: E.VELVET_CARPET },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 6, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 2, allowRotation: true, tags: ['velvet', 'rug', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_WOOD_PANEL'), layer: TileLayer.WALL,
    displayName: 'Wood Panel Wall', biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_TRIM, S: E.WOOD_FLOOR, E: E.WOOD_TRIM, W: E.WOOD_TRIM },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['wood', 'wall', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_BOOKSHELF'), layer: TileLayer.WALL,
    displayName: 'Grand Bookshelf', biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_TRIM, S: E.WOOD_FLOOR, E: E.WOOD_TRIM, W: E.WOOD_TRIM },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: true, tags: ['wood', 'books', 'wall', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_FIREPLACE'), layer: TileLayer.WALL,
    displayName: 'Marble Fireplace', biomes: ['grand_mansion_interior'],
    edges: { N: E.STONE_TRIM, S: E.WOOD_FLOOR, E: E.STONE_TRIM, W: E.STONE_TRIM },
    collision: { blocksMovement: true, blocksSight: true, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 9, row: 3, frameWidth: 64, frameHeight: 64, frameCount: 4, frameIntervalMs: 120, additiveBlend: true },
    zOffset: 11, allowRotation: false, tags: ['marble', 'fire', 'wall', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_ARCH'), layer: TileLayer.WALL,
    displayName: 'Interior Arch', biomes: ['grand_mansion_interior'],
    edges: { N: E.ARCH_STONE, S: E.WOOD_FLOOR, E: E.ARCH_STONE, W: E.ARCH_STONE },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 8, row: 5, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 10, allowRotation: false, tags: ['stone', 'arch', 'mansion'],
  });

  registry.register({
    id: toTileID('MANSION_CEILING_BEAM'), layer: TileLayer.ROOF,
    displayName: 'Wood Ceiling Beam', biomes: ['grand_mansion_interior'],
    edges: { N: E.WOOD_TRIM, S: E.WOOD_TRIM, E: E.WOOD_TRIM, W: E.WOOD_TRIM },
    collision: { blocksMovement: false, blocksSight: false, isHazard: false },
    sprite: { sheet: '378efd71-5a57-443d-89f2-4fed5829e00e.jpeg', col: 0, row: 4, frameWidth: 64, frameHeight: 64, frameCount: 1 },
    zOffset: 20, allowRotation: true, tags: ['wood', 'ceiling', 'mansion'],
  });

  const compiler = new AdjacencyRuleCompiler(registry);
  const matrix = compiler.compile();

  if (compiler.symmetryViolations.length > 0) {
    console.error('Symmetry violations detected during build:', compiler.symmetryViolations);
  }

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
        { tagA: 'blood', tagB: 'moss' },
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
        { tagA: 'hedge', tagB: 'gargoyle' },
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
        { tagA: 'fire', tagB: 'books' },
      ],
      ambientLight: { hue: 30, saturation: 0.25, lightness: 0.18 },
    },
  };

  return { registry, biomes };
}

/* ---------------------------------------------------------------------------
   SECTION 7 -- UTILITY / SERIALIZATION HELPERS
   --------------------------------------------------------------------------- */

export function serializeGrid(grid: GridArray): string {
  const rows = grid.map((row) =>
    row.map((cell) => ({
      l0: cell.layers[TileLayer.SUBFLOOR] ?? null,
      l1: cell.layers[TileLayer.DECOR] ?? null,
      l2: cell.layers[TileLayer.WALL] ?? null,
      l3: cell.layers[TileLayer.ROOF] ?? null,
      m: cell.meta ?? undefined,
    }))
  );
  return JSON.stringify({ version: 1, width: rows[0]?.length ?? 0, height: rows.length, rows });
}

export function deserializeGrid(json: string): GridArray {
  const parsed = JSON.parse(json);
  if (parsed.version !== 1) throw new Error(`Unsupported grid version ${parsed.version}`);

  return parsed.rows.map((row: any[]) =>
    row.map((cell: any) => ({
      layers: {
        [TileLayer.SUBFLOOR]: cell.l0 ? toTileID(cell.l0) : undefined,
        [TileLayer.DECOR]: cell.l1 ? toTileID(cell.l1) : undefined,
        [TileLayer.WALL]: cell.l2 ? toTileID(cell.l2) : undefined,
        [TileLayer.ROOF]: cell.l3 ? toTileID(cell.l3) : undefined,
      },
      meta: cell.m,
    }))
  );
}

export function formatIntegrityReport(report: IntegrityReport): string {
  const lines: string[] = [];
  lines.push(`╔══════════════════════════════════════════════════════════════╗`);
  lines.push(`║          WORLD TILE INTEGRITY REPORT                         ║`);
  lines.push(`╠══════════════════════════════════════════════════════════════╣`);
  lines.push(`║ Grid Size     : ${report.gridWidth}x${report.gridHeight}`.padEnd(63) + `║`);
  lines.push(`║ Valid         : ${report.isValid ? 'YES' : 'NO'}`.padEnd(63) + `║`);
  lines.push(`║ Critical      : ${report.summary.criticalCount}`.padEnd(63) + `║`);
  lines.push(`║ Warnings      : ${report.summary.warningCount}`.padEnd(63) + `║`);
  lines.push(`║ Info          : ${report.summary.infoCount}`.padEnd(63) + `║`);
  lines.push(`╠══════════════════════════════════════════════════════════════╣`);

  if (report.violations.length === 0) {
    lines.push(`║  No violations detected.                                     ║`);
  } else {
    for (const v of report.violations) {
      const sev = v.severity.padStart(8);
      lines.push(`║ [${sev}] (${v.x},${v.y}) L${v.layer} "${v.tileId}"`.padEnd(63) + `║`);
      lines.push(`║        → ${v.direction} (${v.neighbourX},${v.neighbourY}) "${v.neighbourTileId}"`.padEnd(63) + `║`);
      lines.push(`║        ${v.message.slice(0, 58)}`.padEnd(63) + `║`);
    }
  }

  lines.push(`╠══════════════════════════════════════════════════════════════╣`);
  lines.push(`║ CORRECTION BUFFER (${report.corrections.length} entries)`.padEnd(63) + `║`);
  lines.push(`╚══════════════════════════════════════════════════════════════╝`);

  for (const c of report.corrections.slice(0, 10)) {
    lines.push(`  • (${c.x},${c.y}) L${c.layer}: replace "${c.currentTileId}" with one of [${c.suggestedReplacements.slice(0, 5).join(', ')}${c.suggestedReplacements.length > 5 ? '…' : ''}]`);
  }
  if (report.corrections.length > 10) {
    lines.push(`  … and ${report.corrections.length - 10} more.`);
  }

  return lines.join('\n');
}

/* ---------------------------------------------------------------------------
   SECTION 8 -- EXPORTED CONVENIENCE API
   --------------------------------------------------------------------------- */

export function createWorldTileEngine(): {
  registry: TileRegistry;
  biomes: Record<string, BiomeTemplate>;
  matrix: RuleMatrix;
  engine: LayoutIntegrityEngine;
} {
  const { registry, biomes } = buildMasterTileSet();
  const compiler = new AdjacencyRuleCompiler(registry);
  const matrix = compiler.compile();
  const engine = new LayoutIntegrityEngine(registry, matrix);
  return { registry, biomes, matrix, engine };
}

export function verifyLayoutIntegrity(gridArray: GridArray): IntegrityReport {
  const { engine } = createWorldTileEngine();
  return engine.verifyLayoutIntegrity(gridArray);
}

/* ---------------------------------------------------------------------------
   SECTION 9 -- EXAMPLE / SMOKE TEST (commented out; run manually)
   --------------------------------------------------------------------------- */

/*
import { verifyLayoutIntegrity, TileLayer, toTileID, GridArray } from './WorldTileRules';

const testGrid: GridArray = [
  [
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR'), [TileLayer.WALL]: toTileID('CRYPT_WALL') } },
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR'), [TileLayer.WALL]: toTileID('CRYPT_WALL') } },
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR'), [TileLayer.WALL]: toTileID('CRYPT_WALL') } },
  ],
  [
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR') } },
    { layers: { [TileLayer.SUBFLOOR]: toTileID('MANSION_WOOD_FLOOR'), [TileLayer.WALL]: toTileID('MANSION_WOOD_PANEL') } },
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR') } },
  ],
  [
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR'), [TileLayer.WALL]: toTileID('CRYPT_WALL') } },
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR'), [TileLayer.WALL]: toTileID('CRYPT_ARCH') } },
    { layers: { [TileLayer.SUBFLOOR]: toTileID('CRYPT_STONE_FLOOR'), [TileLayer.WALL]: toTileID('CRYPT_WALL') } },
  ],
];

const report = verifyLayoutIntegrity(testGrid);
console.log(formatIntegrityReport(report));
*/
