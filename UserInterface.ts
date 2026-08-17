/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UserInterface.ts
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Dark-Gothic DOM Overlay & Level-Up Pause Manager
 *
 *  Responsibilities (strict boundary):
 *    • DOM layout injection, CSS theme orchestration, responsive HUD
 *    • Cinematic XP bar, health readout, survival clock, kill counter
 *    • Level-up modal with backdrop blur, 3 randomized upgrade cards
 *    • Mouse-event binding, upgrade application, game-loop freeze/unfreeze
 *    • Atmospheric UI particles (ember drift, blood motes)
 *    • Sprite-sheet slicing pipeline for upgrade-card iconography
 *
 *  Dependencies (injected via constructor):
 *    • IGameLoop      – pause() / resume() / isPaused()
 *    • IInventory     – getUpgradeOptions(n) / applyUpgrade(id)
 *    • IPlayerStats   – health, maxHealth, xp, maxXp, level, survivalTime, kills
 *
 *  Asset Integration:
 *    • Dagger sheet      → Sinner's Quills  (projectile)
 *    • Scythe sheet      → Whirling Halberds (orbital)
 *    • Shield sheet      → Defensive passives
 *    • Blood-vortex      → Blood Siphon / Abyssal Rift
 *    • Necrotic VFX      → Grave Burst / Font of Torment
 *    • Skeleton sheet    → Plague Swarm
 *    • Knight sheet      → Player portrait / defeat state
 *
 *  ═══════════════════════════════════════════════════════════════════════════════
 */

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 0 — TYPE DEFINITIONS & INTERFACES
// ═══════════════════════════════════════════════════════════════════════════════

export type Rarity = "common" | "rare" | "epic" | "legendary";

export interface IUpgradeOption {
  id: string;
  name: string;
  description: string;
  /** Which sprite-sheet config key to use for the card icon */
  spriteKey: string;
  /** Frame index inside the sprite sheet (0-based) */
  frameIndex: number;
  rarity: Rarity;
  maxLevel: number;
  currentLevel: number;
  category: "weapon" | "passive" | "spell";
}

export interface IInventoryManager {
  /** Return *n* distinct upgrade candidates. */
  getUpgradeOptions(count: number): IUpgradeOption[];
  /** Commit an upgrade by id. */
  applyUpgrade(upgradeId: string): void;
}

export interface IGameLoop {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

export interface IPlayerStats {
  health: number;
  maxHealth: number;
  xp: number;
  maxXp: number;
  level: number;
  survivalTime: number; // seconds
  kills: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — SPRITE-SHEET SLICER PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Describes a single sprite-sheet asset so the UI can extract individual
 * frames for upgrade-card icons, portraits, or mini-animations.
 */
export interface ISpriteSheetConfig {
  /** Absolute or relative URL to the image asset */
  src: string;
  /** Total frames in the sheet (used for validation) */
  totalFrames: number;
  /** Columns in the grid */
  cols: number;
  /** Rows in the grid */
  rows: number;
  /** Width of one frame in pixels */
  frameWidth: number;
  /** Height of one frame in pixels */
  frameHeight: number;
  /** Gap between frames (horizontal) */
  gapX?: number;
  /** Gap between frames (vertical) */
  gapY?: number;
  /** Offset from left edge to first frame */
  offsetX?: number;
  /** Offset from top edge to first frame */
  offsetY?: number;
}

/**
 * Central registry of all uploaded game assets mapped to logical keys.
 * These configs feed the CSS background-position slicing used by upgrade cards.
 */
export const SPRITE_SHEET_REGISTRY: Record<string, ISpriteSheetConfig> = {
  // ── Daggers (Sinner's Quills) ──────────────────────────────────────────────
  // 6 cols x 4 rows = 24 frames, 64x64 each, ~2px gap
  daggers: {
    src: "./assets/sprites/daggers_sheet.png",
    totalFrames: 24,
    cols: 6,
    rows: 4,
    frameWidth: 64,
    frameHeight: 64,
    gapX: 2,
    gapY: 2,
    offsetX: 0,
    offsetY: 0,
  },

  // ── Scythes (Whirling Halberds / Unholy Orbit) ─────────────────────────────
  // 7 cols x 4 rows = 28 frames, 80x80 each
  scythes: {
    src: "./assets/sprites/scythes_sheet.png",
    totalFrames: 28,
    cols: 7,
    rows: 4,
    frameWidth: 80,
    frameHeight: 80,
    gapX: 2,
    gapY: 2,
    offsetX: 0,
    offsetY: 0,
  },

  // ── Shields (Defensive Passives) ───────────────────────────────────────────
  // 4 cols x 2 rows = 8 frames, 96x96 each
  shields: {
    src: "./assets/sprites/shields_sheet.png",
    totalFrames: 8,
    cols: 4,
    rows: 2,
    frameWidth: 96,
    frameHeight: 96,
    gapX: 4,
    gapY: 4,
    offsetX: 0,
    offsetY: 0,
  },

  // ── Blood Vortex (Blood Siphon / Abyssal Rift) ─────────────────────────────
  // 7x7 ring around center, each ~48x48
  bloodVortex: {
    src: "./assets/sprites/blood_vortex_sheet.png",
    totalFrames: 32,
    cols: 7,
    rows: 5,
    frameWidth: 48,
    frameHeight: 48,
    gapX: 0,
    gapY: 0,
    offsetX: 0,
    offsetY: 0,
  },

  // ── Necrotic Eruption VFX (Grave Burst / Font of Torment) ───────────────────
  // 4 cols x 4 rows = 16 frames, 128x128 each (large VFX)
  necroticVfx: {
    src: "./assets/sprites/necrotic_eruption_sheet.png",
    totalFrames: 16,
    cols: 4,
    rows: 4,
    frameWidth: 128,
    frameHeight: 128,
    gapX: 0,
    gapY: 0,
    offsetX: 0,
    offsetY: 0,
  },

  // ── Skeletons (Plague Swarm / Enemies) ─────────────────────────────────────
  // 12 cols x 5 rows = 60 frames, 48x48 each
  skeletons: {
    src: "./assets/sprites/skeletons_sheet.png",
    totalFrames: 60,
    cols: 12,
    rows: 5,
    frameWidth: 48,
    frameHeight: 48,
    gapX: 1,
    gapY: 1,
    offsetX: 0,
    offsetY: 0,
  },

  // ── Gothic Knight (Player portrait / defeat) ─────────────────────────────
  // 6 cols x 3 rows = 18 frames, 72x72 each
  knight: {
    src: "./assets/sprites/knight_sheet.png",
    totalFrames: 18,
    cols: 6,
    rows: 3,
    frameWidth: 72,
    frameHeight: 72,
    gapX: 2,
    gapY: 2,
    offsetX: 0,
    offsetY: 0,
  },
};

/**
 * Utility class that computes CSS background-position values for any frame
 * inside a registered sprite sheet.  This lets upgrade cards show crisp
 * sliced icons without creating dozens of DOM <img> nodes.
 */
export class SpriteSheetSlicer {
  /**
   * Returns a CSS-ready `background-position` string for the requested frame.
   */
  static getBackgroundPosition(
    config: ISpriteSheetConfig,
    frameIndex: number
  ): string {
    const clamped = Math.max(0, Math.min(frameIndex, config.totalFrames - 1));
    const col = clamped % config.cols;
    const row = Math.floor(clamped / config.cols);

    const offX = (config.offsetX ?? 0) + col * (config.frameWidth + (config.gapX ?? 0));
    const offY = (config.offsetY ?? 0) + row * (config.frameHeight + (config.gapY ?? 0));

    return `-${offX}px -${offY}px`;
  }

  /**
   * Returns a CSS-ready `background-size` string that preserves the full
   * sheet dimensions so the slice is pixel-perfect.
   */
  static getBackgroundSize(config: ISpriteSheetConfig): string {
    const totalW =
      config.cols * config.frameWidth +
      (config.cols - 1) * (config.gapX ?? 0) +
      (config.offsetX ?? 0) * 2;
    const totalH =
      config.rows * config.frameHeight +
      (config.rows - 1) * (config.gapY ?? 0) +
      (config.offsetY ?? 0) * 2;
    return `${totalW}px ${totalH}px`;
  }

  /**
   * Convenience: build a complete CSS background declaration for a frame.
   */
  static buildBackgroundStyle(
    config: ISpriteSheetConfig,
    frameIndex: number
  ): Partial<CSSStyleDeclaration> {
    return {
      backgroundImage: `url('${config.src}')`,
      backgroundPosition: this.getBackgroundPosition(config, frameIndex),
      backgroundSize: this.getBackgroundSize(config),
      backgroundRepeat: "no-repeat",
      width: `${config.frameWidth}px`,
      height: `${config.frameHeight}px`,
    } as Partial<CSSStyleDeclaration>;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — UI PARTICLE SYSTEM (Atmospheric DOM Particles)
// ═══════════════════════════════════════════════════════════════════════════════

interface IParticleConfig {
  count: number;
  spawnRate: number; // ms between spawns
  colors: string[];
  minSize: number;
  maxSize: number;
  minLife: number; // ms
  maxLife: number;
  driftX: number; // px per frame
  driftY: number;
  container: HTMLElement;
}

/**
 * Lightweight CSS-driven particle emitter for UI ambience.
 * Spawns absolutely-positioned divs that drift, fade, and die.
 * Zero canvas involvement — pure DOM overlay.
 */
class UIParticleSystem {
  private particles: HTMLElement[] = [];
  private timer: number | null = null;
  private running = false;
  private config: IParticleConfig;
  private rafId = 0;

  constructor(config: IParticleConfig) {
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleSpawn();
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    cancelAnimationFrame(this.rafId);
    this.particles.forEach((p) => p.remove());
    this.particles = [];
  }

  private scheduleSpawn(): void {
    if (!this.running) return;
    this.timer = window.setTimeout(() => {
      this.spawn();
      this.scheduleSpawn();
    }, this.config.spawnRate);
  }

  private spawn(): void {
    if (this.particles.length >= this.config.count) return;

    const el = document.createElement("div");
    const size =
      this.config.minSize +
      Math.random() * (this.config.maxSize - this.config.minSize);
    const color =
      this.config.colors[Math.floor(Math.random() * this.config.colors.length)];
    const life =
      this.config.minLife +
      Math.random() * (this.config.maxLife - this.config.minLife);

    el.style.position = "absolute";
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.backgroundColor = color;
    el.style.borderRadius = Math.random() > 0.5 ? "50%" : "2px";
    el.style.left = `${Math.random() * 100}%`;
    el.style.top = `${Math.random() * 100}%`;
    el.style.opacity = "0";
    el.style.pointerEvents = "none";
    el.style.boxShadow = `0 0 ${size * 2}px ${color}`;
    el.style.transition = `opacity ${life * 0.3}ms ease-in, transform ${life}ms linear`;
    el.style.zIndex = "5";

    // Custom data attributes for per-frame animation
    (el as any).__uiParticle = {
      born: performance.now(),
      life,
      vx: (Math.random() - 0.5) * this.config.driftX,
      vy: -Math.random() * this.config.driftY, // upward drift default
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
    };

    this.config.container.appendChild(el);
    this.particles.push(el);

    // Trigger fade-in on next frame
    requestAnimationFrame(() => {
      el.style.opacity = `${0.4 + Math.random() * 0.6}`;
    });
  }

  private loop(): void {
    if (!this.running) return;
    const now = performance.now();

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const el = this.particles[i];
      const data = (el as any).__uiParticle;
      const age = now - data.born;

      if (age >= data.life) {
        el.remove();
        this.particles.splice(i, 1);
        continue;
      }

      // Drift
      data.x += data.vx * 0.016;
      data.y += data.vy * 0.016;
      el.style.left = `${data.x}%`;
      el.style.top = `${data.y}%`;

      // Fade near death
      const fadeStart = data.life * 0.7;
      if (age > fadeStart) {
        const fade = 1 - (age - fadeStart) / (data.life - fadeStart);
        el.style.opacity = `${Math.max(0, fade * 0.8)}`;
      }
    }

    this.rafId = requestAnimationFrame(() => this.loop());
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — DYNAMIC CSS THEME INJECTION
// ═══════════════════════════════════════════════════════════════════════════════

const UI_CSS_ID = "gothic-ui-theme";

/**
 * Injects the full dark-gothic stylesheet into <head>.
 * Uses CSS custom properties for a centralised palette.
 */
function injectGothicCSS(): void {
  if (document.getElementById(UI_CSS_ID)) return;

  const style = document.createElement("style");
  style.id = UI_CSS_ID;
  style.textContent = `
    /* ── Google Fonts ───────────────────────────────────────────────────── */
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;800&family=Cinzel+Decorative:wght@700&display=swap');

    /* ── CSS Custom Properties (Theme Palette) ────────────────────────── */
    :root {
      --g-font-primary: 'Cinzel', 'Trajan Pro', 'Georgia', serif;
      --g-font-decorative: 'Cinzel Decorative', 'Cinzel', serif;

      --g-bg-void:        #050508;
      --g-bg-dark:        #0a0a0f;
      --g-bg-panel:       #111118;
      --g-bg-panel-hover: #1a1a24;
      --g-bg-card:        #0d0d12;

      --g-crimson-deep:   #4a0000;
      --g-crimson-mid:    #8b0000;
      --g-crimson-bright: #dc143c;
      --g-crimson-glow:   #ff0040;

      --g-gold-dim:       #8a6d1f;
      --g-gold-mid:       #c9a227;
      --g-gold-bright:    #ffd700;

      --g-silver-dim:     #4a4a52;
      --g-silver-mid:     #8a8a96;
      --g-silver-bright:  #c8c8d4;

      --g-rarity-common:    #9e9e9e;
      --g-rarity-rare:      #4488ff;
      --g-rarity-epic:      #aa44ff;
      --g-rarity-legendary: #ffaa00;

      --g-border-metal:   linear-gradient(135deg, #2a2a30 0%, #5a5a66 50%, #2a2a30 100%);
      --g-border-gold:    linear-gradient(135deg, #6b5318 0%, #ffd700 50%, #6b5318 100%);
      --g-border-crimson: linear-gradient(135deg, #4a0000 0%, #ff0040 50%, #4a0000 100%);

      --g-shadow-soft:    0 4px 20px rgba(0,0,0,0.8);
      --g-shadow-glow-crimson: 0 0 12px rgba(220,20,60,0.4), 0 0 30px rgba(220,20,60,0.15);
      --g-shadow-glow-gold:    0 0 12px rgba(255,215,0,0.3), 0 0 30px rgba(255,215,0,0.1);
      --g-text-glow:      0 0 8px rgba(220,20,60,0.6), 0 0 2px rgba(0,0,0,0.9);
      --g-text-glow-gold: 0 0 8px rgba(255,215,0,0.5), 0 0 2px rgba(0,0,0,0.9);

      --g-anim-pulse:     pulse-glow 2.5s ease-in-out infinite;
      --g-anim-shimmer:   bar-shimmer 2s linear infinite;
    }

    @keyframes pulse-glow {
      0%, 100% { box-shadow: 0 0 8px rgba(220,20,60,0.3); }
      50%      { box-shadow: 0 0 20px rgba(220,20,60,0.6), 0 0 40px rgba(220,20,60,0.2); }
    }

    @keyframes bar-shimmer {
      0%   { background-position: -200% center; }
      100% { background-position: 200% center; }
    }

    @keyframes float-up {
      0%   { transform: translateY(0) scale(1); opacity: 0.6; }
      100% { transform: translateY(-20px) scale(0.8); opacity: 0; }
    }

    @keyframes card-enter {
      0%   { transform: translateY(40px) scale(0.9); opacity: 0; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }

    @keyframes modal-fade-in {
      0%   { opacity: 0; }
      100% { opacity: 1; }
    }

    @keyframes title-glow {
      0%, 100% { text-shadow: 0 0 10px rgba(255,215,0,0.4), 0 0 30px rgba(255,215,0,0.15); }
      50%      { text-shadow: 0 0 20px rgba(255,215,0,0.7), 0 0 50px rgba(255,215,0,0.3); }
    }

    @keyframes damage-flash {
      0%   { opacity: 0.6; }
      100% { opacity: 0; }
    }

    @keyframes clock-tick {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.05); }
    }

    @keyframes level-badge-pulse {
      0%, 100% { box-shadow: 0 0 6px rgba(255,215,0,0.3); }
      50%      { box-shadow: 0 0 14px rgba(255,215,0,0.6), 0 0 28px rgba(255,215,0,0.2); }
    }

    /* ── Root UI Container ──────────────────────────────────────────────── */
    #gothic-game-ui {
      position: fixed;
      inset: 0;
      pointer-events: none;
      font-family: var(--g-font-primary);
      color: var(--g-silver-bright);
      z-index: 1000;
      overflow: hidden;
    }

    #gothic-game-ui * {
      box-sizing: border-box;
    }

    /* ── HUD Layer ────────────────────────────────────────────────────────── */
    #ui-hud {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      padding: 16px 24px;
      pointer-events: none;
    }

    /* ── XP Bar (Cinematic Top Bar) ───────────────────────────────────────── */
    #ui-xp-bar-container {
      position: relative;
      width: 100%;
      max-width: 720px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      gap: 12px;
      pointer-events: auto;
    }

    #ui-xp-bar-track {
      flex: 1;
      height: 18px;
      background: var(--g-bg-panel);
      border: 2px solid transparent;
      border-image: var(--g-border-metal) 1;
      border-radius: 4px;
      overflow: hidden;
      position: relative;
      box-shadow: var(--g-shadow-soft), inset 0 2px 8px rgba(0,0,0,0.6);
    }

    #ui-xp-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(
        90deg,
        var(--g-crimson-deep) 0%,
        var(--g-crimson-mid) 30%,
        var(--g-crimson-bright) 60%,
        var(--g-crimson-glow) 100%
      );
      background-size: 200% 100%;
      animation: var(--g-anim-shimmer);
      transition: width 0.4s cubic-bezier(0.22, 1, 0.36, 1);
      position: relative;
    }

    #ui-xp-bar-fill::after {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(
        90deg,
        transparent 0%,
        rgba(255,255,255,0.15) 50%,
        transparent 100%
      );
      background-size: 200% 100%;
      animation: var(--g-anim-shimmer);
    }

    #ui-xp-bar-glow {
      position: absolute;
      inset: -4px;
      border-radius: 6px;
      opacity: 0;
      transition: opacity 0.3s;
      pointer-events: none;
      animation: var(--g-anim-pulse);
    }

    #ui-xp-bar-container.near-levelup #ui-xp-bar-glow {
      opacity: 1;
      box-shadow: 0 0 16px rgba(255,0,64,0.5), 0 0 40px rgba(255,0,64,0.2);
    }

    #ui-level-badge {
      min-width: 56px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      background: var(--g-bg-panel);
      border: 2px solid var(--g-gold-dim);
      border-radius: 4px;
      font-family: var(--g-font-decorative);
      font-size: 11px;
      font-weight: 700;
      color: var(--g-gold-bright);
      text-shadow: var(--g-text-glow-gold);
      letter-spacing: 1px;
      padding: 0 10px;
      animation: level-badge-pulse 3s ease-in-out infinite;
      white-space: nowrap;
    }

    #ui-level-value {
      font-size: 14px;
      color: #fff;
    }

    /* ── Health Container (Bottom-Left) ───────────────────────────────────── */
    #ui-health-container {
      display: flex;
      align-items: center;
      gap: 10px;
      pointer-events: auto;
    }

    #ui-health-icon {
      width: 28px;
      height: 28px;
      background: var(--g-crimson-mid);
      border: 2px solid var(--g-crimson-bright);
      border-radius: 50% 50% 50% 4px;
      transform: rotate(-45deg);
      box-shadow: 0 0 10px rgba(220,20,60,0.4);
      position: relative;
      flex-shrink: 0;
    }

    #ui-health-icon::after {
      content: '';
      position: absolute;
      inset: 4px;
      background: var(--g-crimson-glow);
      border-radius: 50%;
      opacity: 0.6;
    }

    #ui-health-bar {
      width: 180px;
      height: 14px;
      background: var(--g-bg-panel);
      border: 2px solid transparent;
      border-image: var(--g-border-metal) 1;
      border-radius: 3px;
      overflow: hidden;
      position: relative;
      box-shadow: inset 0 2px 6px rgba(0,0,0,0.7);
    }

    #ui-health-fill {
      height: 100%;
      width: 100%;
      background: linear-gradient(
        90deg,
        var(--g-crimson-deep) 0%,
        var(--g-crimson-mid) 40%,
        var(--g-crimson-bright) 100%
      );
      transition: width 0.25s cubic-bezier(0.22, 1, 0.36, 1);
      position: relative;
    }

    #ui-health-fill::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 40%;
      background: linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 100%);
    }

    #ui-health-text {
      font-size: 13px;
      font-weight: 600;
      color: var(--g-silver-bright);
      text-shadow: var(--g-text-glow);
      min-width: 70px;
      text-align: right;
      letter-spacing: 0.5px;
    }

    #ui-health-value { color: #fff; }
    #ui-health-max   { color: var(--g-silver-mid); }

    /* ── Survival Clock (Bottom-Right) ──────────────────────────────────── */
    #ui-clock-container {
      display: flex;
      align-items: center;
      gap: 8px;
      pointer-events: auto;
      background: rgba(10,10,15,0.7);
      border: 1px solid var(--g-silver-dim);
      border-radius: 6px;
      padding: 6px 14px;
      backdrop-filter: blur(4px);
    }

    #ui-clock-icon {
      font-size: 16px;
      filter: drop-shadow(0 0 4px rgba(255,215,0,0.4));
      animation: clock-tick 1s ease-in-out infinite;
    }

    #ui-clock-value {
      font-family: var(--g-font-decorative);
      font-size: 16px;
      font-weight: 700;
      color: var(--g-gold-bright);
      text-shadow: var(--g-text-glow-gold);
      letter-spacing: 2px;
      min-width: 60px;
      text-align: center;
    }

    /* ── Score / Kill Counter (Top-Right) ───────────────────────────────── */
    #ui-score-container {
      position: absolute;
      top: 16px;
      right: 24px;
      text-align: right;
      pointer-events: auto;
    }

    #ui-score-value {
      font-family: var(--g-font-decorative);
      font-size: 28px;
      font-weight: 800;
      color: var(--g-gold-bright);
      text-shadow: var(--g-text-glow-gold);
      line-height: 1;
    }

    #ui-score-label {
      font-size: 9px;
      font-weight: 600;
      color: var(--g-silver-mid);
      letter-spacing: 3px;
      text-transform: uppercase;
      margin-top: 2px;
    }

    /* ── Damage Flash Overlay ─────────────────────────────────────────────── */
    #ui-damage-flash {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, rgba(180,0,0,0) 0%, rgba(180,0,0,0.35) 100%);
      opacity: 0;
      pointer-events: none;
      z-index: 50;
    }

    #ui-damage-flash.active {
      animation: damage-flash 0.4s ease-out forwards;
    }

    /* ── Level-Up Modal ─────────────────────────────────────────────────── */
    #ui-levelup-modal {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      z-index: 200;
      pointer-events: auto;
    }

    #ui-levelup-modal.visible {
      display: flex;
      animation: modal-fade-in 0.35s ease-out forwards;
    }

    #ui-levelup-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(5,5,8,0.88);
      backdrop-filter: blur(10px) saturate(0.6);
      z-index: 0;
    }

    #ui-levelup-content {
      position: relative;
      z-index: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 32px;
      padding: 40px;
      max-width: 960px;
      width: 90%;
    }

    #ui-levelup-title {
      font-family: var(--g-font-decorative);
      font-size: 38px;
      font-weight: 700;
      color: var(--g-gold-bright);
      text-shadow: var(--g-text-glow-gold);
      letter-spacing: 6px;
      text-transform: uppercase;
      margin: 0;
      animation: title-glow 3s ease-in-out infinite;
      text-align: center;
    }

    #ui-levelup-subtitle {
      font-size: 13px;
      color: var(--g-silver-mid);
      letter-spacing: 4px;
      text-transform: uppercase;
      margin-top: -24px;
    }

    #ui-levelup-cards {
      display: flex;
      gap: 24px;
      justify-content: center;
      flex-wrap: wrap;
      width: 100%;
    }

    /* ── Upgrade Card ─────────────────────────────────────────────────────── */
    .ui-upgrade-card {
      position: relative;
      width: 260px;
      background: var(--g-bg-card);
      border: 2px solid var(--g-silver-dim);
      border-radius: 8px;
      padding: 20px;
      cursor: pointer;
      transition:
        transform 0.25s cubic-bezier(0.22, 1, 0.36, 1),
        box-shadow 0.25s ease,
        border-color 0.25s ease;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      animation: card-enter 0.5s cubic-bezier(0.22, 1, 0.36, 1) forwards;
      opacity: 0;
      overflow: hidden;
    }

    .ui-upgrade-card:nth-child(1) { animation-delay: 0.1s; }
    .ui-upgrade-card:nth-child(2) { animation-delay: 0.2s; }
    .ui-upgrade-card:nth-child(3) { animation-delay: 0.3s; }

    .ui-upgrade-card::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 8px;
      padding: 2px;
      background: linear-gradient(135deg, transparent 40%, rgba(255,255,255,0.06) 50%, transparent 60%);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
    }

    .ui-upgrade-card:hover {
      transform: translateY(-6px) scale(1.02);
    }

    /* Rarity border colours */
    .ui-upgrade-card.rarity-common    { border-color: var(--g-rarity-common); }
    .ui-upgrade-card.rarity-rare      { border-color: var(--g-rarity-rare); }
    .ui-upgrade-card.rarity-epic      { border-color: var(--g-rarity-epic); }
    .ui-upgrade-card.rarity-legendary { border-color: var(--g-rarity-legendary); }

    .ui-upgrade-card.rarity-common:hover    { box-shadow: 0 8px 30px rgba(158,158,158,0.15), 0 0 20px rgba(158,158,158,0.1); }
    .ui-upgrade-card.rarity-rare:hover      { box-shadow: 0 8px 30px rgba(68,136,255,0.2), 0 0 20px rgba(68,136,255,0.15); }
    .ui-upgrade-card.rarity-epic:hover      { box-shadow: 0 8px 30px rgba(170,68,255,0.2), 0 0 20px rgba(170,68,255,0.15); }
    .ui-upgrade-card.rarity-legendary:hover { box-shadow: 0 8px 30px rgba(255,170,0,0.25), 0 0 20px rgba(255,170,0,0.2); }

    /* Card Icon Frame */
    .ui-card-icon-frame {
      width: 80px;
      height: 80px;
      border: 2px solid var(--g-silver-dim);
      border-radius: 6px;
      background: var(--g-bg-panel);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      overflow: hidden;
      box-shadow: inset 0 2px 8px rgba(0,0,0,0.6);
    }

    .ui-card-icon-frame .ui-card-icon {
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }

    /* Rarity glow behind icon */
    .ui-card-icon-frame::after {
      content: '';
      position: absolute;
      inset: 0;
      opacity: 0.15;
      pointer-events: none;
    }
    .rarity-common    .ui-card-icon-frame::after { background: var(--g-rarity-common); }
    .rarity-rare      .ui-card-icon-frame::after { background: var(--g-rarity-rare); }
    .rarity-epic      .ui-card-icon-frame::after { background: var(--g-rarity-epic); }
    .rarity-legendary .ui-card-icon-frame::after { background: var(--g-rarity-legendary); }

    .ui-card-name {
      font-family: var(--g-font-decorative);
      font-size: 15px;
      font-weight: 700;
      color: #fff;
      text-align: center;
      text-shadow: 0 0 6px rgba(0,0,0,0.8);
      letter-spacing: 1px;
    }

    .ui-card-desc {
      font-size: 11px;
      line-height: 1.5;
      color: var(--g-silver-mid);
      text-align: center;
      min-height: 48px;
    }

    .ui-card-meta {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 2px;
      text-transform: uppercase;
    }

    .ui-card-rarity {
      padding: 2px 8px;
      border-radius: 3px;
      background: rgba(255,255,255,0.05);
    }
    .rarity-common    .ui-card-rarity { color: var(--g-rarity-common); }
    .rarity-rare      .ui-card-rarity { color: var(--g-rarity-rare); }
    .rarity-epic      .ui-card-rarity { color: var(--g-rarity-epic); }
    .rarity-legendary .ui-card-rarity { color: var(--g-rarity-legendary); }

    .ui-card-level {
      color: var(--g-silver-dim);
    }
    .ui-card-level span {
      color: var(--g-gold-mid);
    }

    /* ── Responsive Tweaks ──────────────────────────────────────────────── */
    @media (max-width: 768px) {
      #ui-xp-bar-container { max-width: 100%; padding: 0 8px; }
      #ui-health-bar { width: 120px; }
      .ui-upgrade-card { width: 220px; padding: 16px; }
      #ui-levelup-title { font-size: 26px; }
    }
  `;

  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 4 — USERINTERFACE CLASS
// ═══════════════════════════════════════════════════════════════════════════════

export class UserInterface {
  // ── DOM References ───────────────────────────────────────────────────────
  private root: HTMLDivElement | null = null;
  private hud: HTMLDivElement | null = null;
  private xpBarFill: HTMLDivElement | null = null;
  private xpBarContainer: HTMLDivElement | null = null;
  private levelValue: HTMLSpanElement | null = null;
  private healthFill: HTMLDivElement | null = null;
  private healthValue: HTMLSpanElement | null = null;
  private healthMax: HTMLSpanElement | null = null;
  private clockValue: HTMLDivElement | null = null;
  private scoreValue: HTMLDivElement | null = null;
  private damageFlash: HTMLDivElement | null = null;
  private levelUpModal: HTMLDivElement | null = null;
  private levelUpCards: HTMLDivElement | null = null;
  private levelUpTitle: HTMLHeadingElement | null = null;

  // ── State ──────────────────────────────────────────────────────────────────
  private isLevelUpOpen = false;
  private lastHealth = -1;
  private particleSystem: UIParticleSystem | null = null;

  // ── Dependencies ───────────────────────────────────────────────────────────
  constructor(
    private gameLoop: IGameLoop,
    private inventory: IInventoryManager,
    private canvasContainer: HTMLElement
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  //  PUBLIC LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /** Boot the UI: inject CSS, build DOM, start ambience. */
  init(): void {
    injectGothicCSS();
    this.buildDOM();
    this.startAmbience();
  }

  /** Tear everything down. */
  destroy(): void {
    this.particleSystem?.stop();
    if (this.root && this.root.parentNode) {
      this.root.parentNode.removeChild(this.root);
    }
    const css = document.getElementById(UI_CSS_ID);
    if (css) css.remove();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PUBLIC UPDATE METHODS (called each frame / on event)
  // ═══════════════════════════════════════════════════════════════════════════

  /** Sync the entire HUD from a stats snapshot. */
  updateHUD(stats: IPlayerStats): void {
    this.updateHealth(stats.health, stats.maxHealth);
    this.updateXP(stats.xp, stats.maxXp, stats.level);
    this.updateClock(stats.survivalTime);
    this.updateScore(stats.kills);
  }

  /** Update health bar and numeric readout. */
  updateHealth(current: number, max: number): void {
    if (!this.healthFill || !this.healthValue || !this.healthMax) return;

    const pct = Math.max(0, Math.min(100, (current / max) * 100));
    this.healthFill.style.width = `${pct}%`;
    this.healthValue.textContent = Math.ceil(current).toString();
    this.healthMax.textContent = Math.ceil(max).toString();

    // Flash when taking damage
    if (this.lastHealth > 0 && current < this.lastHealth) {
      this.flashDamage();
    }
    this.lastHealth = current;
  }

  /** Update XP bar, level badge, and near-level-up glow. */
  updateXP(current: number, max: number, level: number): void {
    if (!this.xpBarFill || !this.levelValue || !this.xpBarContainer) return;

    const pct = Math.max(0, Math.min(100, (current / max) * 100));
    this.xpBarFill.style.width = `${pct}%`;
    this.levelValue.textContent = level.toString();

    // Pulse glow when > 80% XP
    if (pct >= 80) {
      this.xpBarContainer.classList.add("near-levelup");
    } else {
      this.xpBarContainer.classList.remove("near-levelup");
    }
  }

  /** Update survival clock (MM:SS format). */
  updateClock(seconds: number): void {
    if (!this.clockValue) return;
    const m = Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0");
    const s = Math.floor(seconds % 60)
      .toString()
      .padStart(2, "0");
    this.clockValue.textContent = `${m}:${s}`;
  }

  /** Update kill counter. */
  updateScore(kills: number): void {
    if (!this.scoreValue) return;
    this.scoreValue.textContent = kills.toLocaleString();
  }

  /** Trigger a brief red vignette flash. */
  flashDamage(): void {
    if (!this.damageFlash) return;
    this.damageFlash.classList.remove("active");
    // Force reflow
    void this.damageFlash.offsetWidth;
    this.damageFlash.classList.add("active");
    setTimeout(() => {
      this.damageFlash?.classList.remove("active");
    }, 450);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LEVEL-UP MODAL (Pause Orchestration)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Open the level-up modal, freeze the game loop, and present 3 random
   * upgrade options from the inventory manager.
   */
  openLevelUp(): void {
    if (this.isLevelUpOpen) return;
    this.isLevelUpOpen = true;

    // Freeze gameplay
    this.gameLoop.pause();

    // Fetch candidates
    const options = this.inventory.getUpgradeOptions(3);

    // Render cards
    this.renderUpgradeCards(options);

    // Show modal
    if (this.levelUpModal) {
      this.levelUpModal.classList.add("visible");
    }
  }

  /** Close the modal and resume the game loop cleanly. */
  closeLevelUp(): void {
    if (!this.isLevelUpOpen) return;
    this.isLevelUpOpen = false;

    if (this.levelUpModal) {
      this.levelUpModal.classList.remove("visible");
    }
    if (this.levelUpCards) {
      this.levelUpCards.innerHTML = "";
    }

    // Resume gameplay
    this.gameLoop.resume();
  }

  /** Query whether the level-up screen is currently open. */
  getIsLevelUpOpen(): boolean {
    return this.isLevelUpOpen;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE DOM BUILDERS
  // ═══════════════════════════════════════════════════════════════════════════

  private buildDOM(): void {
    this.root = document.createElement("div");
    this.root.id = "gothic-game-ui";

    // ── HUD ──────────────────────────────────────────────────────────────────
    this.hud = document.createElement("div");
    this.hud.id = "ui-hud";

    // XP Bar
    this.xpBarContainer = document.createElement("div");
    this.xpBarContainer.id = "ui-xp-bar-container";

    const xpTrack = document.createElement("div");
    xpTrack.id = "ui-xp-bar-track";
    this.xpBarFill = document.createElement("div");
    this.xpBarFill.id = "ui-xp-bar-fill";
    const xpGlow = document.createElement("div");
    xpGlow.id = "ui-xp-bar-glow";
    xpTrack.appendChild(this.xpBarFill);
    xpTrack.appendChild(xpGlow);

    const levelBadge = document.createElement("div");
    levelBadge.id = "ui-level-badge";
    levelBadge.innerHTML = `LVL <span id="ui-level-value">1</span>`;
    this.levelValue = levelBadge.querySelector("#ui-level-value") as HTMLSpanElement;

    this.xpBarContainer.appendChild(xpTrack);
    this.xpBarContainer.appendChild(levelBadge);

    // Health
    const healthContainer = document.createElement("div");
    healthContainer.id = "ui-health-container";
    const healthIcon = document.createElement("div");
    healthIcon.id = "ui-health-icon";
    const healthBar = document.createElement("div");
    healthBar.id = "ui-health-bar";
    this.healthFill = document.createElement("div");
    this.healthFill.id = "ui-health-fill";
    healthBar.appendChild(this.healthFill);
    const healthText = document.createElement("div");
    healthText.id = "ui-health-text";
    healthText.innerHTML = `<span id="ui-health-value">100</span> / <span id="ui-health-max">100</span>`;
    this.healthValue = healthText.querySelector("#ui-health-value") as HTMLSpanElement;
    this.healthMax = healthText.querySelector("#ui-health-max") as HTMLSpanElement;
    healthContainer.appendChild(healthIcon);
    healthContainer.appendChild(healthBar);
    healthContainer.appendChild(healthText);

    // Clock
    const clockContainer = document.createElement("div");
    clockContainer.id = "ui-clock-container";
    const clockIcon = document.createElement("div");
    clockIcon.id = "ui-clock-icon";
    clockIcon.textContent = "\u{23F3}"; // ⏳
    this.clockValue = document.createElement("div");
    this.clockValue.id = "ui-clock-value";
    this.clockValue.textContent = "00:00";
    clockContainer.appendChild(clockIcon);
    clockContainer.appendChild(this.clockValue);

    // Score
    const scoreContainer = document.createElement("div");
    scoreContainer.id = "ui-score-container";
    this.scoreValue = document.createElement("div");
    this.scoreValue.id = "ui-score-value";
    this.scoreValue.textContent = "0";
    const scoreLabel = document.createElement("div");
    scoreLabel.id = "ui-score-label";
    scoreLabel.textContent = "SOULS REAPED";
    scoreContainer.appendChild(this.scoreValue);
    scoreContainer.appendChild(scoreLabel);

    // Damage flash
    this.damageFlash = document.createElement("div");
    this.damageFlash.id = "ui-damage-flash";

    // Assemble HUD
    this.hud.appendChild(this.xpBarContainer);
    this.hud.appendChild(healthContainer);
    this.hud.appendChild(clockContainer);
    this.hud.appendChild(scoreContainer);
    this.hud.appendChild(this.damageFlash);

    // ── Level-Up Modal ───────────────────────────────────────────────────────
    this.levelUpModal = document.createElement("div");
    this.levelUpModal.id = "ui-levelup-modal";

    const backdrop = document.createElement("div");
    backdrop.id = "ui-levelup-backdrop";

    const content = document.createElement("div");
    content.id = "ui-levelup-content";

    this.levelUpTitle = document.createElement("h2");
    this.levelUpTitle.id = "ui-levelup-title";
    this.levelUpTitle.textContent = "CHOOSE YOUR BOON";

    const subtitle = document.createElement("div");
    subtitle.id = "ui-levelup-subtitle";
    subtitle.textContent = "The darkness offers power... at a price";

    this.levelUpCards = document.createElement("div");
    this.levelUpCards.id = "ui-levelup-cards";

    content.appendChild(this.levelUpTitle);
    content.appendChild(subtitle);
    content.appendChild(this.levelUpCards);

    this.levelUpModal.appendChild(backdrop);
    this.levelUpModal.appendChild(content);

    // ── Assemble Root ────────────────────────────────────────────────────────
    this.root.appendChild(this.hud);
    this.root.appendChild(this.levelUpModal);

    // Mount into the canvas container (or body as fallback)
    const mountTarget = this.canvasContainer || document.body;
    mountTarget.appendChild(this.root);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE UPGRADE CARD RENDERING
  // ═══════════════════════════════════════════════════════════════════════════

  private renderUpgradeCards(options: IUpgradeOption[]): void {
    if (!this.levelUpCards) return;
    this.levelUpCards.innerHTML = "";

    options.forEach((opt, index) => {
      const card = this.buildUpgradeCard(opt, index);
      this.levelUpCards!.appendChild(card);
    });
  }

  private buildUpgradeCard(option: IUpgradeOption, index: number): HTMLDivElement {
    const card = document.createElement("div");
    card.className = `ui-upgrade-card rarity-${option.rarity}`;
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", `Select upgrade: ${option.name}`);

    // ── Icon Frame with sliced sprite ────────────────────────────────────────
    const iconFrame = document.createElement("div");
    iconFrame.className = "ui-card-icon-frame";

    const iconEl = document.createElement("div");
    iconEl.className = "ui-card-icon";

    // Resolve sprite config
    const spriteConfig = SPRITE_SHEET_REGISTRY[option.spriteKey];
    if (spriteConfig) {
      const bg = SpriteSheetSlicer.buildBackgroundStyle(spriteConfig, option.frameIndex);
      iconEl.style.backgroundImage = bg.backgroundImage!;
      iconEl.style.backgroundPosition = bg.backgroundPosition!;
      iconEl.style.backgroundSize = bg.backgroundSize!;
      iconEl.style.backgroundRepeat = "no-repeat";
      iconEl.style.width = bg.width!;
      iconEl.style.height = bg.height!;
      iconEl.style.transform = "scale(1.2)"; // Slight upscale for visibility
    } else {
      // Fallback: show a placeholder rune
      iconEl.style.width = "48px";
      iconEl.style.height = "48px";
      iconEl.style.display = "flex";
      iconEl.style.alignItems = "center";
      iconEl.style.justifyContent = "center";
      iconEl.style.fontSize = "28px";
      iconEl.textContent = "\u{2620}"; // ☠
      iconEl.style.color = "var(--g-crimson-bright)";
    }

    iconFrame.appendChild(iconEl);

    // ── Name ─────────────────────────────────────────────────────────────────
    const nameEl = document.createElement("div");
    nameEl.className = "ui-card-name";
    nameEl.textContent = option.name;

    // ── Description ──────────────────────────────────────────────────────────
    const descEl = document.createElement("div");
    descEl.className = "ui-card-desc";
    descEl.textContent = option.description;

    // ── Meta Row (Rarity + Level) ────────────────────────────────────────────
    const metaEl = document.createElement("div");
    metaEl.className = "ui-card-meta";

    const rarityEl = document.createElement("span");
    rarityEl.className = "ui-card-rarity";
    rarityEl.textContent = option.rarity;

    const levelEl = document.createElement("span");
    levelEl.className = "ui-card-level";
    levelEl.innerHTML = `LVL <span>${option.currentLevel}</span> / ${option.maxLevel}`;

    metaEl.appendChild(rarityEl);
    metaEl.appendChild(levelEl);

    // ── Assemble Card ────────────────────────────────────────────────────────
    card.appendChild(iconFrame);
    card.appendChild(nameEl);
    card.appendChild(descEl);
    card.appendChild(metaEl);

    // ── Interaction ──────────────────────────────────────────────────────────
    const onSelect = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.handleUpgradeSelect(option.id);
    };

    card.addEventListener("click", onSelect);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        onSelect(e);
      }
    });

    // Hover sound cue (if audio manager is available globally)
    card.addEventListener("mouseenter", () => {
      // Dispatch a custom event that the AudioManager can listen for
      window.dispatchEvent(
        new CustomEvent("ui-hover", { detail: { element: "upgrade-card" } })
      );
    });

    return card;
  }

  private handleUpgradeSelect(upgradeId: string): void {
    // Apply the upgrade via inventory manager
    this.inventory.applyUpgrade(upgradeId);

    // Close modal and resume
    this.closeLevelUp();

    // Dispatch success event for audio / VFX hooks
    window.dispatchEvent(
      new CustomEvent("upgrade-selected", { detail: { upgradeId } })
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE AMBIENCE
  // ═══════════════════════════════════════════════════════════════════════════

  private startAmbience(): void {
    if (!this.root) return;

    // Ember & blood-mote particles drifting upward
    this.particleSystem = new UIParticleSystem({
      count: 30,
      spawnRate: 400,
      colors: [
        "#dc143c", // crimson
        "#8b0000", // dark red
        "#ff0040", // bright red
        "#c9a227", // gold ember
        "#4a0000", // deep crimson
      ],
      minSize: 2,
      maxSize: 5,
      minLife: 3000,
      maxLife: 7000,
      driftX: 20,
      driftY: 15,
      container: this.root,
    });

    this.particleSystem.start();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 5 — USAGE EXAMPLE (commented, for integration reference)
// ═══════════════════════════════════════════════════════════════════════════════

/*
  // ── In your main game bootstrap ────────────────────────────────────────────
  import { UserInterface, IGameLoop, IInventoryManager, IPlayerStats } from "./UserInterface";

  const gameLoop: IGameLoop = {
    pause()  { engine.stopRenderLoop(); },
    resume() { engine.runRenderLoop(() => { scene.render(); }); },
    isPaused() { return !engine.isRunning; },
  };

  const inventory: IInventoryManager = {
    getUpgradeOptions(count) { return myWeaponManager.rollUpgrades(count); },
    applyUpgrade(id)         { myWeaponManager.levelUpAbility(id); },
  };

  const ui = new UserInterface(gameLoop, inventory, document.getElementById("game-container")!);
  ui.init();

  // ── In your game loop ──────────────────────────────────────────────────────
  ui.updateHUD({
    health: player.health,
    maxHealth: player.maxHealth,
    xp: player.xp,
    maxXp: player.xpToNext,
    level: player.level,
    survivalTime: elapsedSeconds,
    kills: enemyManager.killCount,
  });

  // ── On level-up event ─────────────────────────────────────────────────────
  if (player.xp >= player.xpToNext) {
    player.levelUp();
    ui.openLevelUp();
  }

  // ── Cleanup on game over ──────────────────────────────────────────────────
  ui.destroy();
*/
