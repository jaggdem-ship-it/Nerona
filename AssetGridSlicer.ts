/**
 * AssetGridSlicer.ts
 *
 * A pure mathematical layout calculator for Babylon.js sprite and tile atlas slicing.
 * Automates frame coordinate generation, UV atlas cutting with anti-bleed padding,
 * and SpriteManager configuration for grid-aligned texture maps.
 */

export interface AssetLayoutConfig {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  textureWidth?: number;
  textureHeight?: number;
}

export interface SpriteManagerConfig {
  scene: any;
  managerName: string;
  textureUrl: string;
  capacity: number;
  cellSize: number;
}

export class AssetGridSlicer {
  public static readonly ASSET_LAYOUT_REGISTRY: Record<string, AssetLayoutConfig> = {
    "player_idle.png":        { columns: 4, rows: 1, cellWidth: 512, cellHeight: 512 },
    "player_run.png":         { columns: 6, rows: 1, cellWidth: 512, cellHeight: 512 },
    "player_attack.png":      { columns: 5, rows: 1, cellWidth: 512, cellHeight: 512 },
    "player_death.png":       { columns: 6, rows: 1, cellWidth: 512, cellHeight: 512 },
    "player_spellcast.png":   { columns: 6, rows: 1, cellWidth: 512, cellHeight: 512 },
    "character_selection.png": { columns: 2, rows: 2, cellWidth: 512, cellHeight: 512 },

    "skeleton_walk.png":      { columns: 4, rows: 1, cellWidth: 256, cellHeight: 256 },
    "skeleton_attack.png":    { columns: 5, rows: 1, cellWidth: 256, cellHeight: 256 },
    "skeleton_death.png":     { columns: 6, rows: 1, cellWidth: 256, cellHeight: 256 },

    "ghoul_idle.png":         { columns: 4, rows: 1, cellWidth: 256, cellHeight: 256 },
    "ghoul_charge.png":       { columns: 6, rows: 1, cellWidth: 256, cellHeight: 256 },
    "ghoul_death.png":        { columns: 6, rows: 1, cellWidth: 256, cellHeight: 256 },

    "lich_idle.png":          { columns: 4, rows: 1, cellWidth: 256, cellHeight: 256 },
    "lich_cast.png":          { columns: 6, rows: 1, cellWidth: 256, cellHeight: 256 },
    "lich_teleport.png":      { columns: 5, rows: 1, cellWidth: 256, cellHeight: 256 },

    "boss_vampire_lord.png":  { columns: 8, rows: 4, cellWidth: 256, cellHeight: 256 },
    "boss_necromancer.png":   { columns: 8, rows: 4, cellWidth: 256, cellHeight: 256 },
    "boss_abyssal_wyrm.png":  { columns: 8, rows: 3, cellWidth: 256, cellHeight: 256 },

    "crypt_tiles.png":        { columns: 8, rows: 8, cellWidth: 128, cellHeight: 128 },
    "dungeon_tiles.png":      { columns: 8, rows: 8, cellWidth: 128, cellHeight: 128 },
    "cathedral_tiles.png":    { columns: 8, rows: 8, cellWidth: 128, cellHeight: 128 },

    "ui_kit.png":             { columns: 4, rows: 4, cellWidth: 256, cellHeight: 256 },
    "ui_icons.png":           { columns: 8, rows: 8, cellWidth: 64,  cellHeight: 64  },
    "ui_bars.png":            { columns: 4, rows: 2, cellWidth: 256, cellHeight: 64 },

    "spells_arcane.png":      { columns: 5, rows: 3, cellWidth: 256, cellHeight: 256 },
    "spells_necrotic.png":    { columns: 5, rows: 3, cellWidth: 256, cellHeight: 256 },
    "spells_holy.png":        { columns: 5, rows: 3, cellWidth: 256, cellHeight: 256 },
    "particles_gothic.png":   { columns: 8, rows: 4, cellWidth: 128, cellHeight: 128 },

    "loot_weapons.png":       { columns: 6, rows: 4, cellWidth: 128, cellHeight: 128 },
    "loot_armor.png":         { columns: 6, rows: 4, cellWidth: 128, cellHeight: 128 },
    "props_crypt.png":        { columns: 4, rows: 4, cellWidth: 256, cellHeight: 256 },
  };

  public static readonly UV_INSET_PADDING_PX: number = 1.0;

  public static configureUniformSpriteManager(
    scene: any,
    managerName: string,
    textureUrl: string,
    capacity: number,
    cellSize: number
  ): any {
    if (!scene) throw new Error("[AssetGridSlicer] Scene reference is required.");
    if (capacity <= 0) throw new Error("[AssetGridSlicer] Capacity must be positive.");
    if (cellSize <= 0) throw new Error("[AssetGridSlicer] Cell size must be positive.");

    const spriteCellSize = { width: cellSize, height: cellSize };
    const manager = new BABYLON.SpriteManager(managerName, textureUrl, capacity, spriteCellSize, scene);

    if (manager.texture) {
      manager.texture.updateSamplingMode(BABYLON.Texture.NEAREST_NEAREST);
    }
    return manager;
  }

  public static getAtlasUVs(
    columnIndex: number,
    rowIndex: number,
    atlasTotalColumns: number,
    atlasTotalRows: number,
    textureWidthPx?: number,
    textureHeightPx?: number
  ): Float32Array {
    if (atlasTotalColumns <= 0 || atlasTotalRows <= 0) {
      throw new Error(`[AssetGridSlicer] Atlas dimensions must be positive.`);
    }
    if (columnIndex < 0 || columnIndex >= atlasTotalColumns) {
      throw new Error(`[AssetGridSlicer] Column index out of bounds.`);
    }
    if (rowIndex < 0 || rowIndex >= atlasTotalRows) {
      throw new Error(`[AssetGridSlicer] Row index out of bounds.`);
    }

    const inferredWidth = textureWidthPx ?? this.inferTextureWidth(atlasTotalColumns, atlasTotalRows);
    const inferredHeight = textureHeightPx ?? this.inferTextureHeight(atlasTotalColumns, atlasTotalRows);

    const cellWidthPx = inferredWidth / atlasTotalColumns;
    const cellHeightPx = inferredHeight / atlasTotalRows;

    const rawLeft = columnIndex * cellWidthPx;
    const rawRight = rawLeft + cellWidthPx;
    const rawTop = rowIndex * cellHeightPx;
    const rawBottom = rawTop + cellHeightPx;

    const insetLeft = rawLeft + this.UV_INSET_PADDING_PX;
    const insetRight = rawRight - this.UV_INSET_PADDING_PX;
    const insetTop = rawTop + this.UV_INSET_PADDING_PX;
    const insetBottom = rawBottom - this.UV_INSET_PADDING_PX;

    const u1 = insetLeft / inferredWidth;
    const v1 = insetTop / inferredHeight;
    const u2 = insetRight / inferredWidth;
    const v2 = insetTop / inferredHeight;
    const u3 = insetRight / inferredWidth;
    const v3 = insetBottom / inferredHeight;
    const u4 = insetLeft / inferredWidth;
    const v4 = insetBottom / inferredHeight;

    return new Float32Array([u1, v1, u2, v2, u3, v3, u4, v4]);
  }

  public static getAtlasUVsByAssetKey(
    assetKey: string,
    columnIndex: number,
    rowIndex: number
  ): Float32Array {
    const layout = this.ASSET_LAYOUT_REGISTRY[assetKey];
    if (!layout) {
      throw new Error(`[AssetGridSlicer] Asset key '${assetKey}' not found.`);
    }
    const totalWidth = layout.textureWidth ?? layout.columns * layout.cellWidth;
    const totalHeight = layout.textureHeight ?? layout.rows * layout.cellHeight;
    return this.getAtlasUVs(columnIndex, rowIndex, layout.columns, layout.rows, totalWidth, totalHeight);
  }

  public static getAnimationUVSequence(assetKey: string): Float32Array[] {
    const layout = this.ASSET_LAYOUT_REGISTRY[assetKey];
    if (!layout) throw new Error(`[AssetGridSlicer] Unknown asset key: ${assetKey}`);
    const frames: Float32Array[] = [];
    const totalFrames = layout.columns * layout.rows;
    for (let i = 0; i < totalFrames; i++) {
      const col = i % layout.columns;
      const row = Math.floor(i / layout.columns);
      frames.push(this.getAtlasUVsByAssetKey(assetKey, col, row));
    }
    return frames;
  }

  public static getCellPixelBounds(
    columnIndex: number,
    rowIndex: number,
    atlasTotalColumns: number,
    atlasTotalRows: number,
    cellWidthPx: number,
    cellHeightPx: number
  ): { x: number; y: number; width: number; height: number } {
    return {
      x: columnIndex * cellWidthPx,
      y: rowIndex * cellHeightPx,
      width: cellWidthPx,
      height: cellHeightPx,
    };
  }

  private static inferTextureWidth(cols: number, rows: number): number {
    if (cols <= 4 && rows <= 4) return 512 * cols;
    if (cols <= 8 && rows <= 8) return 256 * cols;
    return 128 * cols;
  }

  private static inferTextureHeight(cols: number, rows: number): number {
    if (cols <= 4 && rows <= 4) return 512 * rows;
    if (cols <= 8 && rows <= 8) return 256 * rows;
    return 128 * rows;
  }
}

export const ASSET_LAYOUTS = AssetGridSlicer.ASSET_LAYOUT_REGISTRY;
export const getAtlasUVs = AssetGridSlicer.getAtlasUVs.bind(AssetGridSlicer);
export const getAtlasUVsByAssetKey = AssetGridSlicer.getAtlasUVsByAssetKey.bind(AssetGridSlicer);
export const getAnimationUVSequence = AssetGridSlicer.getAnimationUVSequence.bind(AssetGridSlicer);
export const configureUniformSpriteManager = AssetGridSlicer.configureUniformSpriteManager.bind(AssetGridSlicer);
