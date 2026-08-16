/* ============================================================================
 *  LOOT CHEST SYSTEM — LootChestSystem.ts
 * ============================================================================
 *  A modular reward pipeline for a Babylon.js horde-survival rogue-lite.
 *  Drops physics-enabled chests from elite/boss deaths. On player collision,
 *  freezes the render loop and invokes a cinematic slot-machine overlay that
 *  upgrades already-owned weapons/passives and awards bonus gold.
 * ============================================================================
 *  Architecture:
 *    LootChestManager  →  owns  →  LootChestEntity[] (pooled)
 *                         owns  →  SlotMachineOverlay (singleton DOM overlay)
 *                         owns  →  RewardSelector (algorithm)
 *    Events:
 *      'game:freeze' | 'game:resume'  —  Engine render-loop control
 *      'player:loadout:upgrade'        —  Rank-tier increase
 *      'player:gold:add'              —  Incremental gold bonus
 * ============================================================================ */

import * as BABYLON from '@babylonjs/core';
import { EventEmitter } from 'events';

/* --------------------------------------------------------------------------
 *  TYPE DEFINITIONS
 * -------------------------------------------------------------------------- */

/** Supported rarity tiers for dropped chests. */
export enum ChestRarity {
  COMMON = 'common',
  RARE = 'rare',
  EPIC = 'epic',
  LEGENDARY = 'legendary',
}

/** Discriminated union for loadout item kinds. */
export enum LoadoutItemType {
  WEAPON = 'weapon',
  PASSIVE = 'passive',
}

/** A single entry in the player's active loadout (already owned). */
export interface ILoadoutItem {
  id: string;
  name: string;
  type: LoadoutItemType;
  rank: number;
  maxRank: number;
  iconUrl: string;
  description: string;
}

/** Reward payload produced by the slot-machine selector. */
export interface IReward {
  item: ILoadoutItem;
  newRank: number;
  goldBonus: number;
}

/** Runtime chest configuration. */
export interface IChestConfig {
  rarity: ChestRarity;
  dropPosition: BABYLON.Vector3;
  eliteId: string;
}

/** Constructor options for LootChestManager. */
export interface ILootChestManagerOptions {
  scene: BABYLON.Scene;
  playerMesh: BABYLON.AbstractMesh;
  eventBus: EventEmitter;
  getPlayerLoadout: () => ILoadoutItem[];
  getPlayerGold: () => number;
  addPlayerGold: (amount: number) => void;
  upgradeLoadoutItem: (itemId: string, newRank: number) => void;
  poolSize?: number;
}

/* --------------------------------------------------------------------------
 *  CONSTANTS
 * -------------------------------------------------------------------------- */

const CHEST_GEOMETRY = {
  size: 1.2,
  mass: 5,
  restitution: 0.4,
  friction: 0.6,
};

const SPIN_DURATIONS_MS = [2200, 2800, 3400, 4000, 4600];

const SLOT_CSS_ID = 'lootchest-slot-overlay';

const RARITY_MULTIPLIER: Record<ChestRarity, number> = {
  [ChestRarity.COMMON]: 1.0,
  [ChestRarity.RARE]: 1.5,
  [ChestRarity.EPIC]: 2.2,
  [ChestRarity.LEGENDARY]: 3.5,
};

const REWARD_COUNT_BY_RARITY: Record<ChestRarity, number[]> = {
  [ChestRarity.COMMON]: [1],
  [ChestRarity.RARE]: [1, 3],
  [ChestRarity.EPIC]: [3, 5],
  [ChestRarity.LEGENDARY]: [5],
};

const GOLD_BASE_BONUS = 50;

/* --------------------------------------------------------------------------
 *  REWARD SELECTOR — Pure algorithm, no side effects
 * -------------------------------------------------------------------------- */

class RewardSelector {
  /**
   * Picks 1, 3, or 5 rewards from the player's *already-owned* active loadout.
   * Never introduces new rank-1 items. Only upgrades existing items whose
   * rank < maxRank. If no upgradable items exist, falls back to pure gold.
   */
  static selectRewards(
    loadout: ILoadoutItem[],
    rarity: ChestRarity
  ): { rewards: IReward[]; fallbackGold: number } {
    const upgradable = loadout.filter((i) => i.rank < i.maxRank);

    if (upgradable.length === 0) {
      return {
        rewards: [],
        fallbackGold: Math.floor(GOLD_BASE_BONUS * RARITY_MULTIPLIER[rarity] * 3),
      };
    }

    const counts = REWARD_COUNT_BY_RARITY[rarity];
    const rewardCount = counts[Math.floor(Math.random() * counts.length)];
    const shuffled = RewardSelector._shuffle([...upgradable]);
    const picked = shuffled.slice(0, Math.min(rewardCount, shuffled.length));

    const rewards: IReward[] = picked.map((item) => {
      const newRank = Math.min(item.rank + 1, item.maxRank);
      const goldBonus = Math.floor(
        GOLD_BASE_BONUS *
          RARITY_MULTIPLIER[rarity] *
          (1 + (newRank - item.rank) * 0.5)
      );
      return { item, newRank, goldBonus };
    });

    return { rewards, fallbackGold: 0 };
  }

  private static _shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

/* --------------------------------------------------------------------------
 *  LOOT CHEST ENTITY — Physics interactable, pooled
 * -------------------------------------------------------------------------- */

class LootChestEntity {
  mesh: BABYLON.Mesh;
  body: BABYLON.PhysicsBody | null = null;
  rarity: ChestRarity;
  isActive = false;

  private _glowLayer: BABYLON.HighlightLayer | null = null;
  private _pulseAnim: BABYLON.Animation | null = null;

  constructor(private _scene: BABYLON.Scene, private _poolIndex: number) {
    this.mesh = BABYLON.MeshBuilder.CreateBox(
      `chest_pool_${_poolIndex}`,
      { size: CHEST_GEOMETRY.size },
      _scene
    );
    this.mesh.isVisible = false;
    this.mesh.checkCollisions = true;
    this.rarity = ChestRarity.COMMON;
    this._setupMaterial();
  }

  /** Spawn the chest at world position with an outward physics impulse. */
  spawn(config: IChestConfig): void {
    this.rarity = config.rarity;
    this.isActive = true;
    this.mesh.position.copyFrom(config.dropPosition);
    this.mesh.isVisible = true;
    this.mesh.setEnabled(true);

    // Physics setup (Babylon 6.0+ Havok / Ammo / Cannon)
    if ((this._scene as any).getPhysicsEngine) {
      this._ensurePhysicsBody();
      this.body?.setLinearVelocity(BABYLON.Vector3.Zero());
      this.body?.setAngularVelocity(BABYLON.Vector3.Zero());

      // Pop upward + random outward impulse
      const impulse = new BABYLON.Vector3(
        (Math.random() - 0.5) * 4,
        6 + Math.random() * 3,
        (Math.random() - 0.5) * 4
      );
      this.body?.applyImpulse(impulse, this.mesh.getAbsolutePosition());
    }

    this._applyRarityVisuals();
    this._startIdlePulse();
  }

  deactivate(): void {
    this.isActive = false;
    this.mesh.isVisible = false;
    this.mesh.setEnabled(false);
    this._glowLayer?.removeMesh(this.mesh);
    this._pulseAnim?.stop();
  }

  private _setupMaterial(): void {
    const mat = new BABYLON.StandardMaterial(
      `chest_mat_${this._poolIndex}`,
      this._scene
    );
    mat.specularColor = new BABYLON.Color3(0.3, 0.3, 0.3);
    this.mesh.material = mat;
  }

  private _ensurePhysicsBody(): void {
    if (this.body) return;
    const aggregate = new BABYLON.PhysicsAggregate(
      this.mesh,
      BABYLON.PhysicsShapeType.BOX,
      {
        mass: CHEST_GEOMETRY.mass,
        restitution: CHEST_GEOMETRY.restitution,
        friction: CHEST_GEOMETRY.friction,
      },
      this._scene
    );
    this.body = aggregate.body;
  }

  private _applyRarityVisuals(): void {
    const mat = this.mesh.material as BABYLON.StandardMaterial;
    const colors: Record<ChestRarity, BABYLON.Color3> = {
      [ChestRarity.COMMON]: new BABYLON.Color3(0.55, 0.45, 0.35),
      [ChestRarity.RARE]: new BABYLON.Color3(0.15, 0.45, 0.85),
      [ChestRarity.EPIC]: new BABYLON.Color3(0.65, 0.15, 0.85),
      [ChestRarity.LEGENDARY]: new BABYLON.Color3(0.95, 0.65, 0.1),
    };
    mat.diffuseColor = colors[this.rarity];
    mat.emissiveColor = colors[this.rarity].scale(0.25);

    // Highlight glow
    if (!this._glowLayer) {
      this._glowLayer = new BABYLON.HighlightLayer(
        `chest_glow_${this._poolIndex}`,
        this._scene
      );
    }
    this._glowLayer.addMesh(this.mesh, colors[this.rarity]);
  }

  private _startIdlePulse(): void {
    const frameRate = 30;
    const keys = [
      { frame: 0, value: 1.0 },
      { frame: frameRate, value: 1.12 },
      { frame: frameRate * 2, value: 1.0 },
    ];
    this._pulseAnim = new BABYLON.Animation(
      `chest_pulse_${this._poolIndex}`,
      'scaling',
      frameRate,
      BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
      BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE
    );
    this._pulseAnim.setKeys(
      keys.map((k) => ({
        frame: k.frame,
        value: new BABYLON.Vector3(k.value, k.value, k.value),
      }))
    );
    this.mesh.animations = [this._pulseAnim];
    this._scene.beginAnimation(this.mesh, 0, frameRate * 2, true);
  }

  dispose(): void {
    this.deactivate();
    this._glowLayer?.dispose();
    this.mesh.dispose();
  }
}

/* --------------------------------------------------------------------------
 *  SLOT MACHINE OVERLAY — Fullscreen DOM UI, self-contained
 * -------------------------------------------------------------------------- */

class SlotMachineOverlay {
  private _container: HTMLDivElement | null = null;
  private _isOpen = false;
  private _abortController: AbortController | null = null;

  constructor(private _eventBus: EventEmitter) {}

  /** Inject CSS once per session. */
  static injectStyles(): void {
    if (document.getElementById('lootchest-styles')) return;
    const css = document.createElement('style');
    css.id = 'lootchest-styles';
    css.textContent = `
      /* ---- Root overlay ---- */
      #${SLOT_CSS_ID} {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        background: rgba(4, 2, 8, 0.92);
        backdrop-filter: blur(8px);
        font-family: 'Cinzel', 'Trajan Pro', serif;
        opacity: 0;
        transition: opacity 0.4s ease;
      }
      #${SLOT_CSS_ID}.visible { opacity: 1; }

      /* ---- Title ---- */
      .lc-title {
        color: #d4af37;
        font-size: 3.2rem;
        text-transform: uppercase;
        letter-spacing: 0.18em;
        text-shadow: 0 0 18px rgba(212,175,55,0.45), 0 2px 0 #000;
        margin-bottom: 2.5rem;
        animation: lc-title-in 0.6s ease-out both;
      }
      @keyframes lc-title-in {
        from { opacity: 0; transform: translateY(-30px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      /* ---- Reel track ---- */
      .lc-reel {
        display: flex;
        gap: 1.8rem;
        perspective: 900px;
        margin-bottom: 3rem;
      }

      /* ---- Card ---- */
      .lc-card {
        width: 160px;
        height: 220px;
        position: relative;
        transform-style: preserve-3d;
        border-radius: 14px;
        background: linear-gradient(145deg, #1a0f2e 0%, #0d0618 100%);
        border: 2px solid #3a2555;
        box-shadow: 0 0 0 1px #000, 0 8px 24px rgba(0,0,0,0.7);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: flex-start;
        padding: 12px;
        opacity: 0;
        transform: translateY(40px) rotateX(12deg);
        transition: transform 0.5s cubic-bezier(0.22, 1, 0.36, 1), box-shadow 0.3s ease;
        overflow: hidden;
      }
      .lc-card.visible {
        opacity: 1;
        transform: translateY(0) rotateX(0);
      }
      .lc-card.spinning {
        animation: lc-spin-blur 0.12s linear infinite;
      }
      @keyframes lc-spin-blur {
        0%   { filter: blur(0px) brightness(1); transform: translateY(0) scale(1); }
        50%  { filter: blur(2px) brightness(1.3); transform: translateY(-6px) scale(1.03); }
        100% { filter: blur(0px) brightness(1); transform: translateY(0) scale(1); }
      }
      .lc-card.landed {
        animation: lc-land 0.35s cubic-bezier(0.22, 1, 0.36, 1) forwards;
      }
      @keyframes lc-land {
        0%   { transform: scale(1.15); filter: brightness(2) saturate(1.4); }
        60%  { transform: scale(0.96); filter: brightness(1.1) saturate(1.1); }
        100% { transform: scale(1); filter: brightness(1) saturate(1); }
      }
      .lc-card.flash {
        animation: lc-flash 0.5s ease-out;
      }
      @keyframes lc-flash {
        0%   { box-shadow: 0 0 0 0 rgba(212,175,55,0); border-color: #d4af37; }
        30%  { box-shadow: 0 0 40px 12px rgba(212,175,55,0.35); border-color: #fff5c2; }
        100% { box-shadow: 0 0 0 0 rgba(212,175,55,0); border-color: #d4af37; }
      }

      /* ---- Card internals ---- */
      .lc-card-rank {
        position: absolute;
        top: 8px; right: 10px;
        font-size: 0.75rem;
        color: #a080c0;
        border: 1px solid #4a3060;
        padding: 2px 8px;
        border-radius: 4px;
        background: rgba(0,0,0,0.35);
      }
      .lc-card-icon {
        width: 84px; height: 84px;
        margin-top: 18px;
        border-radius: 10px;
        background: #0a0510;
        border: 1px solid #2a1a3e;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
      }
      .lc-card-icon img {
        width: 100%; height: 100%;
        object-fit: cover;
      }
      .lc-card-name {
        margin-top: 14px;
        font-size: 0.92rem;
        color: #e8ddf5;
        text-align: center;
        line-height: 1.2;
        text-shadow: 0 1px 2px #000;
      }
      .lc-card-type {
        margin-top: 4px;
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.12em;
        color: #8a70a0;
      }
      .lc-card-bonus {
        margin-top: 10px;
        font-size: 0.78rem;
        color: #d4af37;
        font-weight: 600;
        opacity: 0;
        transform: translateY(8px);
        transition: all 0.4s ease 0.1s;
      }
      .lc-card.landed .lc-card-bonus {
        opacity: 1;
        transform: translateY(0);
      }

      /* ---- Gold banner ---- */
      .lc-gold-banner {
        font-size: 1.6rem;
        color: #ffd700;
        text-shadow: 0 0 12px rgba(255,215,0,0.4);
        opacity: 0;
        transform: scale(0.8);
        transition: all 0.5s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .lc-gold-banner.visible {
        opacity: 1;
        transform: scale(1);
      }

      /* ---- Continue hint ---- */
      .lc-continue {
        margin-top: 2.2rem;
        font-size: 0.85rem;
        color: #6a5a7a;
        letter-spacing: 0.15em;
        text-transform: uppercase;
        opacity: 0;
        animation: lc-fade-in 0.6s ease 0.2s forwards;
        cursor: pointer;
        padding: 10px 28px;
        border: 1px solid #3a2555;
        border-radius: 6px;
        transition: all 0.25s ease;
      }
      .lc-continue:hover {
        color: #d4af37;
        border-color: #d4af37;
        background: rgba(212,175,55,0.06);
      }
      @keyframes lc-fade-in {
        to { opacity: 1; }
      }

      /* ---- Particles canvas ---- */
      .lc-particles {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: -1;
      }
    `;
    document.head.appendChild(css);
  }

  /** Open the overlay, run the cinematic sequence, then resolve. */
  async open(rarity: ChestRarity, rewards: IReward[], fallbackGold: number): Promise<void> {
    if (this._isOpen) return;
    this._isOpen = true;
    this._abortController = new AbortController();
    SlotMachineOverlay.injectStyles();
    this._buildDOM(rarity, rewards, fallbackGold);
    document.body.appendChild(this._container!);

    // Force reflow
    requestAnimationFrame(() => this._container!.classList.add('visible'));
    await this._runSequence(rewards, fallbackGold);
  }

  private _buildDOM(rarity: ChestRarity, rewards: IReward[], fallbackGold: number): void {
    const root = document.createElement('div');
    root.id = SLOT_CSS_ID;

    // Particles canvas
    const pCanvas = document.createElement('canvas');
    pCanvas.className = 'lc-particles';
    root.appendChild(pCanvas);

    // Title
    const title = document.createElement('div');
    title.className = 'lc-title';
    title.textContent = this._rarityLabel(rarity) + ' Cache';
    root.appendChild(title);

    // Reel
    const reel = document.createElement('div');
    reel.className = 'lc-reel';
    if (rewards.length === 0) {
      // Fallback gold-only state
      const goldCard = this._createCard(
        {
          item: {
            id: 'fallback',
            name: 'Ancient Coin Purse',
            type: LoadoutItemType.PASSIVE,
            rank: 0,
            maxRank: 0,
            iconUrl: '',
            description: '',
          },
          newRank: 0,
          goldBonus: fallbackGold,
        },
        true
      );
      reel.appendChild(goldCard);
    } else {
      rewards.forEach((r) => reel.appendChild(this._createCard(r, false)));
    }
    root.appendChild(reel);

    // Gold banner
    const goldBanner = document.createElement('div');
    goldBanner.className = 'lc-gold-banner';
    const totalGold = rewards.reduce((s, r) => s + r.goldBonus, fallbackGold);
    goldBanner.textContent = `+${totalGold} Gold`;
    goldBanner.id = 'lc-gold-banner';
    root.appendChild(goldBanner);

    // Continue button
    const cont = document.createElement('div');
    cont.className = 'lc-continue';
    cont.textContent = 'Press  SPACE  or  CLICK  to continue';
    cont.addEventListener('click', () => this._close());
    root.appendChild(cont);

    // Keyboard listener
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.code === 'Space') this._close();
      },
      { signal: this._abortController!.signal }
    );

    this._container = root;

    // Start ambient particles
    this._startParticles(pCanvas);
  }

  private _createCard(reward: IReward, isFallback: boolean): HTMLDivElement {
    const card = document.createElement('div');
    card.className = 'lc-card';
    if (!isFallback) {
      card.innerHTML = `
        <div class="lc-card-rank">Rank ${reward.item.rank} → ${reward.newRank}</div>
        <div class="lc-card-icon">
          <img src="${reward.item.iconUrl}" alt="${reward.item.name}"
            onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2284%22 height=%2284%22%3E%3Crect fill=%22%231a0f2e%22 width=%2284%22 height=%2284%22/%3E%3Ctext fill=%22%235a4070%22 x=%2242%22 y=%2248%22 text-anchor=%22middle%22 font-size=%2226%22%3E?%3C/text%3E%3C/svg%3E'">
        </div>
        <div class="lc-card-name">${reward.item.name}</div>
        <div class="lc-card-type">${reward.item.type}</div>
        <div class="lc-card-bonus">+${reward.goldBonus} Gold</div>
      `;
    } else {
      card.innerHTML = `
        <div class="lc-card-icon" style="background:#1a1205;border-color:#5a4a20">
          <span style="font-size:38px">💰</span>
        </div>
        <div class="lc-card-name">${reward.item.name}</div>
        <div class="lc-card-bonus">+${reward.goldBonus} Gold</div>
      `;
    }
    return card;
  }

  private async _runSequence(rewards: IReward[], fallbackGold: number): Promise<void> {
    const cards = this._container!.querySelectorAll<HTMLDivElement>('.lc-card');
    const goldBanner = this._container!.querySelector<HTMLDivElement>('#lc-gold-banner')!;

    // Staggered reveal + spin
    await new Promise((res) => setTimeout(res, 300));
    cards.forEach((c, i) => {
      setTimeout(() => c.classList.add('visible'), i * 120);
    });
    await new Promise((res) => setTimeout(res, 400));
    cards.forEach((c) => c.classList.add('spinning'));

    // Sequential stop with flash
    for (let i = 0; i < cards.length; i++) {
      const stopDelay = SPIN_DURATIONS_MS[Math.min(i, SPIN_DURATIONS_MS.length - 1)];
      await new Promise((res) =>
        setTimeout(res, stopDelay - (i > 0 ? SPIN_DURATIONS_MS[i - 1] : 0))
      );
      const card = cards[i];
      card.classList.remove('spinning');
      card.classList.add('landed');

      // Trigger flash after land animation settles
      setTimeout(() => {
        card.classList.add('flash');
        // Backend updates happen precisely at flash moment
        if (!fallbackGold && rewards[i]) {
          this._eventBus.emit('player:loadout:upgrade', rewards[i].item.id, rewards[i].newRank);
          this._eventBus.emit('player:gold:add', rewards[i].goldBonus);
        } else if (fallbackGold) {
          this._eventBus.emit('player:gold:add', fallbackGold);
        }
      }, 280);
    }

    // Gold banner pop
    await new Promise((res) => setTimeout(res, 500));
    goldBanner.classList.add('visible');

    // Auto-close after 5s if idle
    setTimeout(() => this._close(), 5000);
  }

  private _close(): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this._abortController?.abort();
    this._container?.classList.remove('visible');
    setTimeout(() => {
      this._container?.remove();
      this._container = null;
      this._eventBus.emit('game:resume');
    }, 400);
  }

  private _rarityLabel(r: ChestRarity): string {
    return {
      [ChestRarity.COMMON]: 'Common',
      [ChestRarity.RARE]: 'Rare',
      [ChestRarity.EPIC]: 'Epic',
      [ChestRarity.LEGENDARY]: 'Legendary',
    }[r];
  }

  private _startParticles(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d')!;
    let w = (canvas.width = window.innerWidth);
    let h = (canvas.height = window.innerHeight);

    const particles: {
      x: number; y: number; vx: number; vy: number;
      life: number; maxLife: number; size: number; color: string;
    }[] = [];

    const spawn = () => {
      particles.push({
        x: Math.random() * w,
        y: h + 10,
        vx: (Math.random() - 0.5) * 1.2,
        vy: -1.5 - Math.random() * 2.5,
        life: 0,
        maxLife: 120 + Math.random() * 100,
        size: 1.5 + Math.random() * 2.5,
        color: `hsla(${30 + Math.random() * 40}, 80%, 60%,`,
      });
    };

    let raf = 0;
    const loop = () => {
      ctx.clearRect(0, 0, w, h);
      if (Math.random() < 0.35) spawn();
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life++;
        const alpha = 1 - p.life / p.maxLife;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.color + alpha + ')';
        ctx.fill();
        if (p.life >= p.maxLife) particles.splice(i, 1);
      }
      raf = requestAnimationFrame(loop);
    };
    loop();

    const onResize = () => {
      w = canvas.width = window.innerWidth;
      h = canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', onResize);
    this._abortController?.signal.addEventListener('abort', () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    });
  }
}

/* --------------------------------------------------------------------------
 *  LOOT CHEST MANAGER — Public API
 * -------------------------------------------------------------------------- */

export class LootChestManager {
  private _pool: LootChestEntity[] = [];
  private _active: LootChestEntity[] = [];
  private _overlay: SlotMachineOverlay;
  private _checkInterval = 0;
  private readonly _CHECK_EVERY_MS = 80;

  constructor(private _opts: ILootChestManagerOptions) {
    this._overlay = new SlotMachineOverlay(_opts.eventBus);
    this._initPool();
    this._opts.scene.onBeforeRenderObservable.add(() => this._tick());
  }

  /** Call when an elite or boss monster dies. Drops a chest at corpse position. */
  dropFromElite(position: BABYLON.Vector3, rarity: ChestRarity, eliteId: string): void {
    const chest = this._acquire();
    if (!chest) {
      console.warn('[LootChestManager] Pool exhausted — increase poolSize');
      return;
    }
    chest.spawn({ rarity, dropPosition: position.clone(), eliteId });
    this._active.push(chest);
  }

  /** Manual cleanup on scene destruction. */
  dispose(): void {
    this._pool.forEach((c) => c.dispose());
    this._pool = [];
    this._active = [];
  }

  private _initPool(): void {
    const size = this._opts.poolSize ?? 24;
    for (let i = 0; i < size; i++) {
      this._pool.push(new LootChestEntity(this._opts.scene, i));
    }
  }

  private _acquire(): LootChestEntity | undefined {
    const free = this._pool.find((c) => !c.isActive);
    return free;
  }

  private _tick(): void {
    this._checkInterval += this._opts.scene.getEngine().getDeltaTime();
    if (this._checkInterval < this._CHECK_EVERY_MS) return;
    this._checkInterval = 0;

    const playerPos = this._opts.playerMesh.absolutePosition;
    const reach = CHEST_GEOMETRY.size * 0.8 + 1.5; // collision radius

    for (let i = this._active.length - 1; i >= 0; i--) {
      const chest = this._active[i];
      if (!chest.isActive) {
        this._active.splice(i, 1);
        continue;
      }
      const dist = BABYLON.Vector3.Distance(chest.mesh.absolutePosition, playerPos);
      if (dist < reach) {
        this._onPlayerCollect(chest, i);
      }
    }
  }

  private _onPlayerCollect(chest: LootChestEntity, activeIndex: number): void {
    // 1. Remove chest visually
    this._active.splice(activeIndex, 1);
    chest.deactivate();

    // 2. Freeze engine render loop
    this._opts.eventBus.emit('game:freeze');

    // 3. Resolve rewards from owned loadout only
    const loadout = this._opts.getPlayerLoadout();
    const { rewards, fallbackGold } = RewardSelector.selectRewards(loadout, chest.rarity);

    // 4. Open cinematic overlay (async, resumes game on close)
    this._overlay.open(chest.rarity, rewards, fallbackGold);
  }
}

/* --------------------------------------------------------------------------
 *  EXPORTS
 * -------------------------------------------------------------------------- */

export { RewardSelector, SlotMachineOverlay, LootChestEntity };
