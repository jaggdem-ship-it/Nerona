/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PauseMenu.ts
 *  ─────────────────────────────────────────────────────────────────────────────
 *  Modular Settings Pause Interface — Gothic Horde-Survival Rogue-Lite
 *
 *  Responsibilities (strict boundary):
 *    • ESC key & HUD pause-button input capture
 *    • Global engine freeze / unfreeze via isPaused flag
 *    • Dark gothic DOM overlay panel with atmospheric particles
 *    • Live inventory inspection: active weapons + passives with exact ranks
 *    • Real-time audio slider binding (Master / SFX / Music buses)
 *    • Resume Run  → close panel, restore engine tick
 *    • Abandon Run → full memory flush, route to MAIN_MENU boot screen
 *
 *  Dependencies (injected via constructor):
 *    • IGameLoop      – pause() / resume() / isPaused()
 *    • WeaponManager  – getActiveWeapons() / getAllWeapons()
 *    • GameFlowController – transitionTo(MAIN_MENU) / hardReset()
 *    • ISoundMixer    – Master / SFX / Music volume buses (Module 11 contract)
 *
 *  ═══════════════════════════════════════════════════════════════════════════════
 */

import { setPaused, getPaused } from "./EngineCore";
import {
  GameFlowController,
  EngineState,
  MemoryHygiene,
} from "./GameFlowController";
import { WeaponManager, BaseActiveWeapon } from "./WeaponEngine";
import { SpriteSheetSlicer, SPRITE_SHEET_REGISTRY } from "./UserInterface";

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 0 — TYPE DEFINITIONS & EXTERNAL CONTRACTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimal game-loop contract used to freeze / thaw simulation.
 * This is intentionally narrow so any tick controller can satisfy it.
 */
export interface IGameLoop {
  pause(): void;
  resume(): void;
  isPaused(): boolean;
}

/**
 * Sound-mixer bus contract expected from Module 11.
 * The PauseMenu does NOT own audio assets; it only drives the mixer's
 * gain nodes through these typed accessors.
 */
export interface ISoundMixer {
  /** Master output gain (0.0 – 1.0) */
  masterVolume: number;
  /** Sound-effects bus gain (0.0 – 1.0) */
  sfxVolume: number;
  /** Music / ambient bus gain (0.0 – 1.0) */
  musicVolume: number;

  /** Subscribe to volume changes on a specific bus. Returns unsubscribe fn. */
  onVolumeChange(bus: "master" | "sfx" | "music", cb: (v: number) => void): () => void;

  /** Mute toggle (preserves underlying volume values). */
  muted: boolean;
}

/**
 * Passive item descriptor.  The PauseMenu treats passives as a separate
 * inventory lane from active weapons.  This interface is satisfied by
 * whatever stat-modifier system the project uses.
 */
export interface IPassiveItem {
  id: string;
  name: string;
  description: string;
  rank: number; // 1–5
  maxRank: number;
  iconSpriteKey: string;
  iconFrameIndex: number;
}

/**
 * Aggregated inventory snapshot delivered to the pause panel.
 */
export interface IInventorySnapshot {
  weapons: BaseActiveWeapon[];
  passives: IPassiveItem[];
}

/**
 * Configuration bundle for PauseMenu instantiation.
 */
export interface IPauseMenuConfig {
  /** The DOM node that hosts the overlay (usually document.body). */
  parentElement: HTMLElement;
  /** Game loop controller for freeze / thaw. */
  gameLoop: IGameLoop;
  /** Weapon manager for active-weapon introspection. */
  weaponManager: WeaponManager;
  /** Optional passive inventory provider. */
  passiveProvider?: () => IPassiveItem[];
  /** Audio mixer from Module 11. */
  soundMixer: ISoundMixer;
  /** Game flow controller for state routing (Abandon Run). */
  flowController: GameFlowController;
  /** Babylon scene used for memory hygiene on abandon. */
  scene: import("@babylonjs/core").Scene;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — CSS THEME INJECTION (Pause-Panel Specific)
// ═══════════════════════════════════════════════════════════════════════════════

const PAUSE_CSS_ID = "gothic-pause-theme";

function injectPauseCSS(): void {
  if (document.getElementById(PAUSE_CSS_ID)) return;

  const style = document.createElement("style");
  style.id = PAUSE_CSS_ID;
  style.textContent = `
    /* ── Pause Root ─────────────────────────────────────────────────────── */
    #gothic-pause-overlay {
      position: fixed;
      inset: 0;
      z-index: 3000;
      display: none;
      align-items: center;
      justify-content: center;
      font-family: var(--g-font-primary, 'Cinzel', 'Georgia', serif);
      color: var(--g-silver-bright, #c8c8d4);
      pointer-events: auto;
      opacity: 0;
      transition: opacity 0.35s cubic-bezier(0.22, 1, 0.36, 1);
    }

    #gothic-pause-overlay.visible {
      display: flex;
      opacity: 1;
    }

    #gothic-pause-backdrop {
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at 50% 40%, rgba(8,8,14,0.92) 0%, rgba(3,3,5,0.98) 100%);
      backdrop-filter: blur(12px) saturate(0.5);
      z-index: 0;
    }

    /* ── Particle Canvas Layer ──────────────────────────────────────────── */
    #gothic-pause-particles {
      position: absolute;
      inset: 0;
      z-index: 1;
      pointer-events: none;
    }

    /* ── Main Panel ─────────────────────────────────────────────────────── */
    #gothic-pause-panel {
      position: relative;
      z-index: 2;
      width: 92%;
      max-width: 1100px;
      max-height: 90vh;
      display: flex;
      flex-direction: column;
      gap: 0;
      background: linear-gradient(180deg, rgba(16,16,22,0.95) 0%, rgba(10,10,15,0.98) 100%);
      border: 2px solid transparent;
      border-image: linear-gradient(135deg, #2a2a30 0%, #5a5a66 30%, #8b0000 70%, #2a2a30 100%) 1;
      box-shadow:
        0 0 0 1px rgba(0,0,0,0.8),
        0 20px 60px rgba(0,0,0,0.9),
        0 0 40px rgba(139,0,0,0.15);
      overflow: hidden;
      animation: pause-panel-enter 0.45s cubic-bezier(0.22, 1, 0.36, 1) forwards;
    }

    @keyframes pause-panel-enter {
      0%   { transform: translateY(30px) scale(0.96); opacity: 0; }
      100% { transform: translateY(0) scale(1); opacity: 1; }
    }

    /* ── Panel Header ───────────────────────────────────────────────────── */
    #gothic-pause-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 20px 28px;
      background: linear-gradient(90deg, transparent 0%, rgba(139,0,0,0.08) 50%, transparent 100%);
      border-bottom: 1px solid rgba(90,90,102,0.25);
    }

    #gothic-pause-title {
      font-family: var(--g-font-decorative, 'Cinzel Decorative', serif);
      font-size: 26px;
      font-weight: 700;
      color: var(--g-gold-bright, #ffd700);
      text-shadow: 0 0 12px rgba(255,215,0,0.35), 0 0 2px rgba(0,0,0,0.9);
      letter-spacing: 5px;
      text-transform: uppercase;
      margin: 0;
    }

    #gothic-pause-subtitle {
      font-size: 11px;
      color: var(--g-silver-mid, #8a8a96);
      letter-spacing: 3px;
      text-transform: uppercase;
      margin-top: 4px;
    }

    #gothic-pause-close-btn {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(20,20,28,0.8);
      border: 1px solid var(--g-silver-dim, #4a4a52);
      border-radius: 6px;
      color: var(--g-silver-mid, #8a8a96);
      font-size: 20px;
      cursor: pointer;
      transition: all 0.2s ease;
      flex-shrink: 0;
    }

    #gothic-pause-close-btn:hover {
      border-color: var(--g-crimson-bright, #dc143c);
      color: var(--g-crimson-bright, #dc143c);
      box-shadow: 0 0 12px rgba(220,20,60,0.25);
      transform: scale(1.05);
    }

    /* ── Panel Body (Split) ─────────────────────────────────────────────── */
    #gothic-pause-body {
      display: flex;
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: #4a0000 #0a0a0f;
    }

    #gothic-pause-body::-webkit-scrollbar {
      width: 6px;
    }
    #gothic-pause-body::-webkit-scrollbar-track {
      background: #0a0a0f;
    }
    #gothic-pause-body::-webkit-scrollbar-thumb {
      background: #4a0000;
      border-radius: 3px;
    }

    /* ── Inventory Column ───────────────────────────────────────────────── */
    #gothic-pause-inventory {
      flex: 1.4;
      padding: 24px 28px;
      border-right: 1px solid rgba(90,90,102,0.15);
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    .pause-section-title {
      font-family: var(--g-font-decorative, 'Cinzel Decorative', serif);
      font-size: 14px;
      font-weight: 700;
      color: var(--g-gold-mid, #c9a227);
      letter-spacing: 3px;
      text-transform: uppercase;
      margin: 0 0 8px 0;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .pause-section-title::after {
      content: '';
      flex: 1;
      height: 1px;
      background: linear-gradient(90deg, rgba(201,162,39,0.4) 0%, transparent 100%);
    }

    /* ── Inventory Grid ─────────────────────────────────────────────────── */
    .pause-inventory-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
      gap: 12px;
    }

    .pause-inv-card {
      background: linear-gradient(135deg, rgba(13,13,18,0.9) 0%, rgba(18,18,26,0.9) 100%);
      border: 1px solid rgba(90,90,102,0.3);
      border-radius: 6px;
      padding: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      transition: all 0.2s ease;
      position: relative;
      overflow: hidden;
    }

    .pause-inv-card::before {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 6px;
      padding: 1px;
      background: linear-gradient(135deg, rgba(255,255,255,0.04) 0%, transparent 60%);
      -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
      -webkit-mask-composite: xor;
      mask-composite: exclude;
      pointer-events: none;
    }

    .pause-inv-card:hover {
      border-color: rgba(139,0,0,0.5);
      transform: translateY(-2px);
      box-shadow: 0 6px 20px rgba(0,0,0,0.5), 0 0 15px rgba(139,0,0,0.1);
    }

    .pause-inv-icon {
      width: 48px;
      height: 48px;
      border: 1px solid rgba(90,90,102,0.4);
      border-radius: 4px;
      background: rgba(0,0,0,0.4);
      flex-shrink: 0;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
      position: relative;
    }

    .pause-inv-icon::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: 4px;
      box-shadow: inset 0 2px 6px rgba(0,0,0,0.6);
      pointer-events: none;
    }

    .pause-inv-info {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .pause-inv-name {
      font-family: var(--g-font-decorative, 'Cinzel Decorative', serif);
      font-size: 12px;
      font-weight: 700;
      color: #fff;
      letter-spacing: 1px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pause-inv-rank {
      font-size: 10px;
      color: var(--g-silver-mid, #8a8a96);
      letter-spacing: 1px;
      text-transform: uppercase;
    }

    .pause-inv-rank span {
      color: var(--g-gold-mid, #c9a227);
      font-weight: 700;
    }

    .pause-rank-dots {
      display: flex;
      gap: 3px;
      margin-top: 2px;
    }

    .pause-rank-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: rgba(90,90,102,0.4);
      transition: background 0.2s ease;
    }

    .pause-rank-dot.filled {
      background: var(--g-crimson-bright, #dc143c);
      box-shadow: 0 0 4px rgba(220,20,60,0.5);
    }

    .pause-rank-dot.max {
      background: var(--g-gold-bright, #ffd700);
      box-shadow: 0 0 4px rgba(255,215,0,0.5);
    }

    /* ── Settings Column ────────────────────────────────────────────────── */
    #gothic-pause-settings {
      flex: 1;
      padding: 24px 28px;
      display: flex;
      flex-direction: column;
      gap: 24px;
      min-width: 280px;
    }

    /* ── Audio Sliders ──────────────────────────────────────────────────── */
    .pause-audio-group {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .pause-slider-row {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .pause-slider-label {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 11px;
      letter-spacing: 2px;
      text-transform: uppercase;
      color: var(--g-silver-mid, #8a8a96);
    }

    .pause-slider-value {
      font-family: var(--g-font-decorative, 'Cinzel Decorative', serif);
      color: var(--g-gold-mid, #c9a227);
      font-weight: 700;
      min-width: 36px;
      text-align: right;
    }

    .pause-slider-track {
      position: relative;
      width: 100%;
      height: 6px;
      background: rgba(0,0,0,0.5);
      border-radius: 3px;
      border: 1px solid rgba(90,90,102,0.25);
      overflow: visible;
      cursor: pointer;
    }

    .pause-slider-fill {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      background: linear-gradient(90deg, var(--g-crimson-deep, #4a0000) 0%, var(--g-crimson-bright, #dc143c) 100%);
      border-radius: 3px;
      pointer-events: none;
      transition: width 0.05s linear;
    }

    .pause-slider-thumb {
      position: absolute;
      top: 50%;
      width: 16px;
      height: 16px;
      background: radial-gradient(circle at 35% 35%, #ff4d6d 0%, #8b0000 100%);
      border: 2px solid #1a1a1a;
      border-radius: 50%;
      transform: translate(-50%, -50%);
      box-shadow: 0 0 8px rgba(220,20,60,0.4), 0 2px 4px rgba(0,0,0,0.5);
      cursor: grab;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
      z-index: 2;
    }

    .pause-slider-thumb:hover {
      transform: translate(-50%, -50%) scale(1.2);
      box-shadow: 0 0 14px rgba(220,20,60,0.6), 0 2px 6px rgba(0,0,0,0.5);
    }

    .pause-slider-thumb.dragging {
      cursor: grabbing;
      transform: translate(-50%, -50%) scale(1.3);
      box-shadow: 0 0 20px rgba(220,20,60,0.8), 0 3px 8px rgba(0,0,0,0.6);
    }

    .pause-slider-track:hover .pause-slider-fill {
      filter: brightness(1.15);
    }

    /* ── Action Cards ───────────────────────────────────────────────────── */
    #gothic-pause-actions {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-top: auto;
      padding-top: 16px;
      border-top: 1px solid rgba(90,90,102,0.2);
    }

    .pause-action-card {
      position: relative;
      padding: 16px 20px;
      border-radius: 6px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 14px;
      transition: all 0.25s cubic-bezier(0.22, 1, 0.36, 1);
      overflow: hidden;
      border: 1px solid transparent;
    }

    .pause-action-card::before {
      content: '';
      position: absolute;
      inset: 0;
      opacity: 0.06;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }

    .pause-action-card:hover::before {
      opacity: 0.12;
    }

    .pause-action-card:hover {
      transform: translateX(4px);
    }

    .pause-action-card.resume {
      background: linear-gradient(90deg, rgba(0,60,30,0.25) 0%, rgba(0,40,20,0.15) 100%);
      border-color: rgba(0,180,90,0.3);
    }
    .pause-action-card.resume::before { background: #00b45a; }
    .pause-action-card.resume:hover {
      border-color: rgba(0,220,110,0.6);
      box-shadow: 0 0 20px rgba(0,180,90,0.15), 0 4px 12px rgba(0,0,0,0.4);
    }

    .pause-action-card.abandon {
      background: linear-gradient(90deg, rgba(80,0,0,0.25) 0%, rgba(40,0,0,0.15) 100%);
      border-color: rgba(180,0,0,0.3);
    }
    .pause-action-card.abandon::before { background: #b40000; }
    .pause-action-card.abandon:hover {
      border-color: rgba(255,0,0,0.6);
      box-shadow: 0 0 20px rgba(180,0,0,0.2), 0 4px 12px rgba(0,0,0,0.4);
    }

    .pause-action-icon {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      font-size: 18px;
      flex-shrink: 0;
      position: relative;
      z-index: 1;
    }

    .pause-action-card.resume .pause-action-icon {
      background: rgba(0,180,90,0.15);
      color: #00e060;
    }
    .pause-action-card.abandon .pause-action-icon {
      background: rgba(180,0,0,0.15);
      color: #ff3333;
    }

    .pause-action-text {
      display: flex;
      flex-direction: column;
      gap: 2px;
      position: relative;
      z-index: 1;
    }

    .pause-action-title {
      font-family: var(--g-font-decorative, 'Cinzel Decorative', serif);
      font-size: 14px;
      font-weight: 700;
      letter-spacing: 1px;
    }

    .pause-action-card.resume .pause-action-title { color: #00e060; }
    .pause-action-card.abandon .pause-action-title { color: #ff4444; }

    .pause-action-desc {
      font-size: 10px;
      color: var(--g-silver-mid, #8a8a96);
      letter-spacing: 1px;
    }

    /* ── Empty State ────────────────────────────────────────────────────── */
    .pause-empty-state {
      text-align: center;
      padding: 24px;
      color: var(--g-silver-dim, #4a4a52);
      font-size: 12px;
      letter-spacing: 1px;
      font-style: italic;
    }

    /* ── Responsive ─────────────────────────────────────────────────────── */
    @media (max-width: 768px) {
      #gothic-pause-body { flex-direction: column; }
      #gothic-pause-inventory { border-right: none; border-bottom: 1px solid rgba(90,90,102,0.15); }
      .pause-inventory-grid { grid-template-columns: 1fr; }
      #gothic-pause-title { font-size: 18px; letter-spacing: 3px; }
    }
  `;

  document.head.appendChild(style);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — AUDIO SLIDER COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Self-contained gothic-styled volume slider.
 * Binds bi-directionally to an ISoundMixer bus.
 */
class VolumeSlider {
  private _container: HTMLDivElement;
  private _track: HTMLDivElement;
  private _fill: HTMLDivElement;
  private _thumb: HTMLDivElement;
  private _valueLabel: HTMLSpanElement;
  private _unsubscribe: (() => void) | null = null;
  private _dragging = false;

  constructor(
    private readonly _bus: "master" | "sfx" | "music",
    private readonly _label: string,
    private readonly _mixer: ISoundMixer,
    parent: HTMLElement
  ) {
    this._container = document.createElement("div");
    this._container.className = "pause-slider-row";

    const header = document.createElement("div");
    header.className = "pause-slider-label";
    header.innerHTML = `<span>${_label}</span>`;
    this._valueLabel = document.createElement("span");
    this._valueLabel.className = "pause-slider-value";
    header.appendChild(this._valueLabel);

    this._track = document.createElement("div");
    this._track.className = "pause-slider-track";
    this._track.setAttribute("role", "slider");
    this._track.setAttribute("aria-label", `${_label} volume`);
    this._track.setAttribute("aria-valuemin", "0");
    this._track.setAttribute("aria-valuemax", "100");
    this._track.tabIndex = 0;

    this._fill = document.createElement("div");
    this._fill.className = "pause-slider-fill";

    this._thumb = document.createElement("div");
    this._thumb.className = "pause-slider-thumb";

    this._track.appendChild(this._fill);
    this._track.appendChild(this._thumb);
    this._container.appendChild(header);
    this._container.appendChild(this._track);
    parent.appendChild(this._container);

    this._bindEvents();
    this._syncFromMixer();

    // Bi-directional: listen for external mixer changes
    this._unsubscribe = _mixer.onVolumeChange(_bus, (v) => {
      this._render(v);
    });
  }

  dispose(): void {
    this._unsubscribe?.();
    this._container.remove();
  }

  private _bindEvents(): void {
    // Mouse / touch drag
    const startDrag = (e: MouseEvent | TouchEvent) => {
      e.preventDefault();
      this._dragging = true;
      this._thumb.classList.add("dragging");
      this._updateFromPointer(e);
    };

    const moveDrag = (e: MouseEvent | TouchEvent) => {
      if (!this._dragging) return;
      this._updateFromPointer(e);
    };

    const endDrag = () => {
      if (!this._dragging) return;
      this._dragging = false;
      this._thumb.classList.remove("dragging");
    };

    this._track.addEventListener("mousedown", startDrag);
    this._track.addEventListener("touchstart", startDrag, { passive: false });

    window.addEventListener("mousemove", moveDrag);
    window.addEventListener("touchmove", moveDrag, { passive: false });

    window.addEventListener("mouseup", endDrag);
    window.addEventListener("touchend", endDrag);

    // Keyboard accessibility
    this._track.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 0.1 : 0.05;
      let current = this._getBusVolume();
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        current = Math.max(0, current - step);
        this._setBusVolume(current);
      } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        current = Math.min(1, current + step);
        this._setBusVolume(current);
      } else if (e.key === "Home") {
        e.preventDefault();
        this._setBusVolume(1);
      } else if (e.key === "End") {
        e.preventDefault();
        this._setBusVolume(0);
      }
    });

    // Click-to-set
    this._track.addEventListener("click", (e) => {
      if (this._dragging) return;
      this._updateFromPointer(e);
    });
  }

  private _updateFromPointer(e: MouseEvent | TouchEvent): void {
    const rect = this._track.getBoundingClientRect();
    const clientX = "touches" in e ? e.touches[0].clientX : e.clientX;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    this._setBusVolume(ratio);
  }

  private _setBusVolume(v: number): void {
    const rounded = Math.round(v * 100) / 100;
    switch (this._bus) {
      case "master":
        this._mixer.masterVolume = rounded;
        break;
      case "sfx":
        this._mixer.sfxVolume = rounded;
        break;
      case "music":
        this._mixer.musicVolume = rounded;
        break;
    }
    this._render(rounded);
  }

  private _getBusVolume(): number {
    switch (this._bus) {
      case "master":
        return this._mixer.masterVolume;
      case "sfx":
        return this._mixer.sfxVolume;
      case "music":
        return this._mixer.musicVolume;
    }
  }

  private _syncFromMixer(): void {
    this._render(this._getBusVolume());
  }

  private _render(v: number): void {
    const pct = Math.round(v * 100);
    this._fill.style.width = `${pct}%`;
    this._thumb.style.left = `${pct}%`;
    this._valueLabel.textContent = `${pct}%`;
    this._track.setAttribute("aria-valuenow", String(pct));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — INVENTORY CARD BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Builds DOM inventory cards for weapons and passives.
 * Uses the project's existing sprite-sheet registry for pixel-perfect icons.
 */
class InventoryCardBuilder {
  /**
   * Creates a weapon inspection card showing name, rank, and rank pips.
   */
  static createWeaponCard(weapon: BaseActiveWeapon): HTMLElement {
    const card = document.createElement("div");
    card.className = "pause-inv-card";

    // Icon via sprite sheet slicing
    const iconWrap = document.createElement("div");
    iconWrap.className = "pause-inv-icon";
    const spriteCfg = SPRITE_SHEET_REGISTRY[weapon.config.spriteKey];
    if (spriteCfg) {
      const bg = SpriteSheetSlicer.buildBackgroundStyle(spriteCfg, 0);
      Object.assign(iconWrap.style, {
        backgroundImage: bg.backgroundImage,
        backgroundPosition: bg.backgroundPosition,
        backgroundSize: bg.backgroundSize,
        backgroundRepeat: bg.backgroundRepeat,
        width: "48px",
        height: "48px",
      });
    }

    const info = document.createElement("div");
    info.className = "pause-inv-info";

    const name = document.createElement("div");
    name.className = "pause-inv-name";
    name.textContent = weapon.config.displayName ?? weapon.config.key;

    const rank = document.createElement("div");
    rank.className = "pause-inv-rank";
    rank.innerHTML = `Rank <span>${weapon.level}</span> / ${weapon.config.maxLevel}`;

    const dots = document.createElement("div");
    dots.className = "pause-rank-dots";
    for (let i = 1; i <= weapon.config.maxLevel; i++) {
      const dot = document.createElement("div");
      dot.className = "pause-rank-dot";
      if (i <= weapon.level) {
        dot.classList.add("filled");
        if (weapon.level >= weapon.config.maxLevel) dot.classList.add("max");
      }
      dots.appendChild(dot);
    }

    info.appendChild(name);
    info.appendChild(rank);
    info.appendChild(dots);
    card.appendChild(iconWrap);
    card.appendChild(info);

    return card;
  }

  /**
   * Creates a passive item inspection card.
   */
  static createPassiveCard(passive: IPassiveItem): HTMLElement {
    const card = document.createElement("div");
    card.className = "pause-inv-card";

    const iconWrap = document.createElement("div");
    iconWrap.className = "pause-inv-icon";
    const spriteCfg = SPRITE_SHEET_REGISTRY[passive.iconSpriteKey];
    if (spriteCfg) {
      const bg = SpriteSheetSlicer.buildBackgroundStyle(spriteCfg, passive.iconFrameIndex);
      Object.assign(iconWrap.style, {
        backgroundImage: bg.backgroundImage,
        backgroundPosition: bg.backgroundPosition,
        backgroundSize: bg.backgroundSize,
        backgroundRepeat: bg.backgroundRepeat,
        width: "48px",
        height: "48px",
      });
    }

    const info = document.createElement("div");
    info.className = "pause-inv-info";

    const name = document.createElement("div");
    name.className = "pause-inv-name";
    name.textContent = passive.name;

    const rank = document.createElement("div");
    rank.className = "pause-inv-rank";
    rank.innerHTML = `Rank <span>${passive.rank}</span> / ${passive.maxRank}`;

    const dots = document.createElement("div");
    dots.className = "pause-rank-dots";
    for (let i = 1; i <= passive.maxRank; i++) {
      const dot = document.createElement("div");
      dot.className = "pause-rank-dot";
      if (i <= passive.rank) {
        dot.classList.add("filled");
        if (passive.rank >= passive.maxRank) dot.classList.add("max");
      }
      dots.appendChild(dot);
    }

    info.appendChild(name);
    info.appendChild(rank);
    info.appendChild(dots);
    card.appendChild(iconWrap);
    card.appendChild(info);

    return card;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 4 — ATMOSPHERIC PARTICLE CANVAS (Pause Overlay)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lightweight canvas-based particle backdrop for the pause menu.
 * Renders drifting ember motes and slow blood-coloured dust.
 * Self-contained: starts on open, stops on close to save battery.
 */
class PauseParticleCanvas {
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;
  private _rafId = 0;
  private _running = false;
  private _particles: Array<{
    x: number; y: number; vx: number; vy: number;
    life: number; maxLife: number; size: number; color: string;
  }> = [];

  constructor(parent: HTMLElement) {
    this._canvas = document.createElement("canvas");
    this._canvas.id = "gothic-pause-particles";
    this._canvas.style.position = "absolute";
    this._canvas.style.inset = "0";
    this._canvas.style.zIndex = "1";
    this._canvas.style.pointerEvents = "none";
    parent.appendChild(this._canvas);

    this._ctx = this._canvas.getContext("2d")!;
    this._resize();

    const ro = new ResizeObserver(() => this._resize());
    ro.observe(parent);
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._spawnBatch(40);
    this._loop();
  }

  stop(): void {
    this._running = false;
    cancelAnimationFrame(this._rafId);
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
    this._particles = [];
  }

  dispose(): void {
    this.stop();
    this._canvas.remove();
  }

  private _resize(): void {
    const rect = this._canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this._canvas.width = rect.width * dpr;
    this._canvas.height = rect.height * dpr;
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private _spawnBatch(count: number): void {
    const rect = this._canvas.getBoundingClientRect();
    const colors = ["#8b0000", "#dc143c", "#4a0000", "#ff0040", "#c9a227"];
    for (let i = 0; i < count; i++) {
      this._particles.push({
        x: Math.random() * rect.width,
        y: Math.random() * rect.height,
        vx: (Math.random() - 0.5) * 0.4,
        vy: -0.15 - Math.random() * 0.35,
        life: 0,
        maxLife: 3000 + Math.random() * 5000,
        size: 1 + Math.random() * 2.5,
        color: colors[Math.floor(Math.random() * colors.length)],
      });
    }
  }

  private _loop(): void {
    if (!this._running) return;
    const ctx = this._ctx;
    const rect = this._canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, rect.width, rect.height);

    const now = performance.now();

    for (let i = this._particles.length - 1; i >= 0; i--) {
      const p = this._particles[i];
      p.life += 16.67;
      p.x += p.vx;
      p.y += p.vy;

      if (p.life >= p.maxLife || p.y < -10 || p.x < -10 || p.x > rect.width + 10) {
        // Respawn at bottom with new params
        p.x = Math.random() * rect.width;
        p.y = rect.height + 5;
        p.life = 0;
        p.maxLife = 3000 + Math.random() * 5000;
        p.vx = (Math.random() - 0.5) * 0.4;
        p.vy = -0.15 - Math.random() * 0.35;
        continue;
      }

      const alpha = Math.sin((p.life / p.maxLife) * Math.PI) * 0.5;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    this._rafId = requestAnimationFrame(() => this._loop());
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 5 — PAUSE MENU CONTROLLER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Central pause-menu controller.
 *
 * Usage:
 *   const pauseMenu = new PauseMenu(config);
 *   pauseMenu.mount();          // inject DOM, bind listeners
 *   // ESC or HUD button auto-handled
 *   pauseMenu.open();           // manual open
 *   pauseMenu.close();          // manual close
 *   pauseMenu.dispose();        // full teardown
 */
export class PauseMenu {
  private _config: IPauseMenuConfig;
  private _overlay: HTMLDivElement | null = null;
  private _backdrop: HTMLDivElement | null = null;
  private _panel: HTMLDivElement | null = null;
  private _inventoryWeaponsGrid: HTMLDivElement | null = null;
  private _inventoryPassivesGrid: HTMLDivElement | null = null;
  private _sliders: VolumeSlider[] = [];
  private _particles: PauseParticleCanvas | null = null;

  private _onKeyDown: (e: KeyboardEvent) => void;
  private _hudPauseBtn: HTMLElement | null = null;
  private _hudPauseListener: (() => void) | null = null;

  private _isOpen = false;
  private _disposed = false;

  // Unsubscribe handles for external mixer listeners
  private _mixerUnsubs: Array<() => void> = [];

  constructor(config: IPauseMenuConfig) {
    this._config = config;

    this._onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Esc") {
        e.preventDefault();
        this.toggle();
      }
    };
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Build DOM and attach global listeners. Safe to call once. */
  mount(): void {
    if (this._disposed) return;
    injectPauseCSS();
    this._buildDOM();
    window.addEventListener("keydown", this._onKeyDown);
    this._bindHudPauseButton();
  }

  /** Show pause panel, freeze engine. */
  open(): void {
    if (this._disposed || this._isOpen) return;
    this._isOpen = true;

    // 1. Freeze core engine tick
    setPaused(true);
    this._config.gameLoop.pause();

    // 2. Refresh inventory display
    this._refreshInventory();

    // 3. Show overlay with animation
    this._overlay!.classList.add("visible");
    this._particles?.start();

    // 4. Sync sliders to current mixer state
    for (const slider of this._sliders) {
      // sliders auto-sync via their onVolumeChange subscriptions
    }

    // 5. Trap focus inside modal for accessibility
    this._trapFocus();

    // 6. Notify via event bus if available
    this._config.flowController.eventBus.emit("pause:opened", undefined);
  }

  /** Hide pause panel, resume engine. */
  close(): void {
    if (this._disposed || !this._isOpen) return;
    this._isOpen = false;

    // 1. Unfreeze engine
    setPaused(false);
    this._config.gameLoop.resume();

    // 2. Hide overlay
    this._overlay!.classList.remove("visible");
    this._particles?.stop();

    // 3. Return focus to canvas
    this._config.flowController["_canvas"]?.focus?.();

    // 4. Notify
    this._config.flowController.eventBus.emit("pause:closed", undefined);
  }

  /** Toggle open / closed. */
  toggle(): void {
    if (this._isOpen) this.close();
    else this.open();
  }

  /** Returns true if the pause menu is currently open. */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * Full teardown: removes DOM, unbinds listeners, disposes particles.
   * Call this when the gameplay scene is destroyed.
   */
  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;

    this.close();
    window.removeEventListener("keydown", this._onKeyDown);

    for (const unsub of this._mixerUnsubs) unsub();
    this._mixerUnsubs = [];

    for (const slider of this._sliders) slider.dispose();
    this._sliders = [];

    this._particles?.dispose();
    this._particles = null;

    if (this._hudPauseBtn && this._hudPauseListener) {
      this._hudPauseBtn.removeEventListener("click", this._hudPauseListener);
    }

    this._overlay?.remove();
    this._overlay = null;
  }

  // ── DOM Construction ──────────────────────────────────────────────────────

  private _buildDOM(): void {
    const parent = this._config.parentElement;

    // Root overlay
    const overlay = document.createElement("div");
    overlay.id = "gothic-pause-overlay";

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.id = "gothic-pause-backdrop";
    overlay.appendChild(backdrop);

    // Particle layer
    this._particles = new PauseParticleCanvas(overlay);

    // Main panel
    const panel = document.createElement("div");
    panel.id = "gothic-pause-panel";

    // Header
    const header = document.createElement("div");
    header.id = "gothic-pause-header";
    header.innerHTML = `
      <div>
        <div id="gothic-pause-title">Paused</div>
        <div id="gothic-pause-subtitle">The horde awaits…</div>
      </div>
    `;

    const closeBtn = document.createElement("button");
    closeBtn.id = "gothic-pause-close-btn";
    closeBtn.innerHTML = "&#10005;"; // ×
    closeBtn.setAttribute("aria-label", "Close pause menu");
    closeBtn.addEventListener("click", () => this.close());
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Body (split)
    const body = document.createElement("div");
    body.id = "gothic-pause-body";

    // ── Inventory Column ──
    const invCol = document.createElement("div");
    invCol.id = "gothic-pause-inventory";

    // Weapons section
    const wepTitle = document.createElement("h3");
    wepTitle.className = "pause-section-title";
    wepTitle.textContent = "Active Weapons";
    invCol.appendChild(wepTitle);

    this._inventoryWeaponsGrid = document.createElement("div");
    this._inventoryWeaponsGrid.className = "pause-inventory-grid";
    invCol.appendChild(this._inventoryWeaponsGrid);

    // Passives section
    const passTitle = document.createElement("h3");
    passTitle.className = "pause-section-title";
    passTitle.textContent = "Passive Relics";
    invCol.appendChild(passTitle);

    this._inventoryPassivesGrid = document.createElement("div");
    this._inventoryPassivesGrid.className = "pause-inventory-grid";
    invCol.appendChild(this._inventoryPassivesGrid);

    body.appendChild(invCol);

    // ── Settings Column ──
    const setCol = document.createElement("div");
    setCol.id = "gothic-pause-settings";

    const audioTitle = document.createElement("h3");
    audioTitle.className = "pause-section-title";
    audioTitle.textContent = "Audio";
    setCol.appendChild(audioTitle);

    const audioGroup = document.createElement("div");
    audioGroup.className = "pause-audio-group";

    this._sliders.push(
      new VolumeSlider("master", "Master", this._config.soundMixer, audioGroup)
    );
    this._sliders.push(
      new VolumeSlider("sfx", "Sound Effects", this._config.soundMixer, audioGroup)
    );
    this._sliders.push(
      new VolumeSlider("music", "Music", this._config.soundMixer, audioGroup)
    );

    setCol.appendChild(audioGroup);

    // ── Action Cards ──
    const actions = document.createElement("div");
    actions.id = "gothic-pause-actions";

    // Resume Run
    const resumeCard = document.createElement("div");
    resumeCard.className = "pause-action-card resume";
    resumeCard.setAttribute("role", "button");
    resumeCard.setAttribute("tabindex", "0");
    resumeCard.innerHTML = `
      <div class="pause-action-icon">&#9654;</div>
      <div class="pause-action-text">
        <div class="pause-action-title">Resume Run</div>
        <div class="pause-action-desc">Return to the slaughter</div>
      </div>
    `;
    resumeCard.addEventListener("click", () => this.close());
    resumeCard.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.close();
      }
    });
    actions.appendChild(resumeCard);

    // Abandon Run
    const abandonCard = document.createElement("div");
    abandonCard.className = "pause-action-card abandon";
    abandonCard.setAttribute("role", "button");
    abandonCard.setAttribute("tabindex", "0");
    abandonCard.innerHTML = `
      <div class="pause-action-icon">&#10007;</div>
      <div class="pause-action-text">
        <div class="pause-action-title">Abandon Run</div>
        <div class="pause-action-desc">Flee to the main menu</div>
      </div>
    `;
    abandonCard.addEventListener("click", () => this._onAbandonRun());
    abandonCard.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this._onAbandonRun();
      }
    });
    actions.appendChild(abandonCard);

    setCol.appendChild(actions);
    body.appendChild(setCol);

    panel.appendChild(body);
    overlay.appendChild(panel);
    parent.appendChild(overlay);

    this._overlay = overlay;
    this._backdrop = backdrop;
    this._panel = panel;
  }

  // ── Inventory Rendering ───────────────────────────────────────────────────

  private _refreshInventory(): void {
    // Weapons
    const weapons = this._config.weaponManager.getActiveWeapons();
    this._inventoryWeaponsGrid!.innerHTML = "";

    if (weapons.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pause-empty-state";
      empty.textContent = "No weapons equipped.";
      this._inventoryWeaponsGrid!.appendChild(empty);
    } else {
      for (const w of weapons) {
        this._inventoryWeaponsGrid!.appendChild(InventoryCardBuilder.createWeaponCard(w));
      }
    }

    // Passives
    const passives = this._config.passiveProvider?.() ?? [];
    this._inventoryPassivesGrid!.innerHTML = "";

    if (passives.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pause-empty-state";
      empty.textContent = "No passive relics acquired.";
      this._inventoryPassivesGrid!.appendChild(empty);
    } else {
      for (const p of passives) {
        this._inventoryPassivesGrid!.appendChild(InventoryCardBuilder.createPassiveCard(p));
      }
    }
  }

  // ── HUD Pause Button Binding ──────────────────────────────────────────────

  /**
   * Attempts to bind to an existing HUD pause button by ID.
   * Falls back gracefully if the button is not yet mounted.
   */
  private _bindHudPauseButton(): void {
    // Look for the standard HUD pause button ID
    const btn = document.getElementById("ui-pause-btn");
    if (!btn) {
      // Retry once after a short delay (HUD may mount after PauseMenu)
      setTimeout(() => {
        const retryBtn = document.getElementById("ui-pause-btn");
        if (retryBtn) this._attachHudListener(retryBtn);
      }, 500);
      return;
    }
    this._attachHudListener(btn);
  }

  private _attachHudListener(btn: HTMLElement): void {
    this._hudPauseBtn = btn;
    this._hudPauseListener = () => this.toggle();
    btn.addEventListener("click", this._hudPauseListener);
  }

  // ── Abandon Run Flow ──────────────────────────────────────────────────────

  /**
   * Executes the full abandon-run sequence:
   *   1. Close pause panel
   *   2. Flush memory (object pools, particles, transient assets)
   *   3. Hard-reset GameFlowController to BOOT → MAIN_MENU
   */
  private async _onAbandonRun(): Promise<void> {
    // Confirm if run has progressed meaningfully (> 30 seconds)
    const elapsed = this._config.flowController.conditionMonitor.getElapsedSeconds();
    if (elapsed > 30) {
      const confirmed = window.confirm(
        "Abandon this run? All progress will be lost to the void."
      );
      if (!confirmed) return;
    }

    // 1. Close overlay immediately for responsiveness
    this._isOpen = false;
    this._overlay!.classList.remove("visible");
    this._particles?.stop();

    // 2. Unpause engine so scene cleanup can run unhindered
    setPaused(false);

    // 3. Memory hygiene — deterministic cleanup
    const scene = this._config.scene;
    MemoryHygiene.unbindKeyboardListeners(scene);
    MemoryHygiene.haltParticleEmitters(scene);
    MemoryHygiene.flushThinInstanceArrays(scene);
    MemoryHygiene.purgeTransientAssets(scene);
    MemoryHygiene.scrubSceneReferences(scene);
    MemoryHygiene.requestGarbageCollection();

    // 4. Dispose this pause menu
    this.dispose();

    // 5. Route to main menu via GameFlowController
    const gfc = this._config.flowController;
    try {
      await gfc.transitionTo(EngineState.MAIN_MENU, { trigger: "returnToMenu" });
    } catch (err) {
      console.error("[PauseMenu] Abandon-run transition failed:", err);
      // Nuclear fallback: hard reset
      await gfc.hardReset();
    }
  }

  // ── Accessibility ─────────────────────────────────────────────────────────

  private _trapFocus(): void {
    // Simple focus trap: focus the close button first
    const closeBtn = this._overlay!.querySelector<HTMLElement>("#gothic-pause-close-btn");
    closeBtn?.focus();

    // TODO: full Tab-cycle trapping if a11y requirements increase
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SECTION 6 — FACTORY EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convenience factory that mounts and returns a fully wired PauseMenu.
 */
export function createPauseMenu(config: IPauseMenuConfig): PauseMenu {
  const menu = new PauseMenu(config);
  menu.mount();
  return menu;
}

export {
  PauseMenu as default,
  VolumeSlider,
  InventoryCardBuilder,
  PauseParticleCanvas,
};
