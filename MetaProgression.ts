/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  METAPROGRESSION.ts — Lead Systems Designer Module
 *  Dark Gothic Horde-Survival Rogue-Lite  |  Vampire Survivors × Diablo
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  ISOLATED RESPONSIBILITIES:
 *    • Persistent account state (gold, unlocks, meta-stat ranks)
 *    • Encrypted local-save serialization pipeline
 *    • Dark-fantasy HTML5 Main Menu UI (Character Select + Gold Shop)
 *    • Atomic purchase validation & permanent multiplier matrix
 *
 *  ZERO GAMEPLAY LOGIC — this module touches nothing but menu states,
 *  meta-currency transactions, and multiplier tracking arrays.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

/* ──────────────────────────────────────────────────────────────────────────────
   SECTION 0 — ASSET REGISTRY (maps to uploaded production asset library)
   ────────────────────────────────────────────────────────────────────────────── */

export const ASSETS = {
  CHAR_PORTRAITS: {
    HERETIC:     '/mnt/agents/upload/a1426963-5087-4d1e-8a40-c0998754c160.jpeg',
    NECROMANCER: '/mnt/agents/upload/a1426963-5087-4d1e-8a40-c0998754c160.jpeg',
    PALADIN:     '/mnt/agents/upload/a1426963-5087-4d1e-8a40-c0998754c160.jpeg',
    ROGUE:       '/mnt/agents/upload/a1426963-5087-4d1e-8a40-c0998754c160.jpeg',
    VAMPIRE:     '/mnt/agents/upload/004083ac-df00-4d90-8c98-135c75d562ea.jpeg',
  } as const,
  UI_KIT:       '/mnt/agents/upload/7455d353-ac94-4a1a-bea3-f305f19ca915.jpeg',
  CARD_FRAMES:  '/mnt/agents/upload/24bf8886-6f18-408e-b14b-4d50bcf2c40c.jpeg',
  BADGES:       '/mnt/agents/upload/2883d3fe-e676-427c-97d6-860410614bc5.jpeg',
  EMBLEM:       '/mnt/agents/upload/a8a150b4-f07c-41d2-9908-79e39c1daf8b.jpeg',
  NUMBERS:      '/mnt/agents/upload/6e824a9c-4751-4cea-a41d-8a43f9ed4ea2.jpeg',
  STAT_ICONS:   '/mnt/agents/upload/cbce0ecf-87e8-479b-b2fe-1c6e9db3cec8.jpeg',
  POWERUPS:     '/mnt/agents/upload/36ca3f26-7158-411f-83c2-03a7c50ce300.jpeg',
  BG_CATHEDRAL: '/mnt/agents/upload/cfdef6f7-1c60-48e4-aab1-f7b70287f06f.jpeg',
  CRYSTALS:     '/mnt/agents/upload/f19bd9b9-85f5-44c8-8d47-2f2d408ee607.jpeg',
  WEAPONS:      '/mnt/agents/upload/Gemini_Generated_Image_.jpeg',
} as const;

/* ──────────────────────────────────────────────────────────────────────────────
   SECTION 1 — TYPE DEFINITIONS
   ────────────────────────────────────────────────────────────────────────────── */

export type MetaStatId =
  | 'might' | 'fortitude' | 'alacrity' | 'greed'
  | 'celerity' | 'aegis' | 'vision' | 'arcana';

export type CharacterId = 'heretic' | 'necromancer' | 'paladin' | 'rogue' | 'vampire';

export interface MetaProgressionSaveData {
  version: number;
  totalGoldAccumulated: number;
  currentGoldBalance: number;
  unlockedCharacters: CharacterId[];
  metaStatRanks: Record<MetaStatId, number>;
  timestamp: number;
  checksum: string;
}

export interface MultiplierMatrix {
  damage: number; maxHealth: number; moveSpeed: number; goldGain: number;
  attackSpeed: number; armor: number; pickupRange: number; abilityPower: number;
}

export interface MetaStatDefinition {
  id: MetaStatId; name: string; description: string;
  maxRanks: number; multiplierPerRank: number;
  baseCost: number; costScaling: number; iconIndex: number;
}

export interface CharacterProfile {
  id: CharacterId; name: string; title: string; lore: string;
  portraitUrl: string; spriteSheetUrl?: string;
  startingWeapon: string; isUnlockedByDefault: boolean;
  unlockCostGold: number;
  baselineStats: { maxHealth: number; damage: number; moveSpeed: number; attackSpeed: number; armor: number; pickupRange: number; };
  frameStyle: 'lava' | 'chain' | 'spiked' | 'dragon';
}

export interface PurchaseResult {
  success: boolean;
  error?: 'INSUFFICIENT_GOLD' | 'MAX_RANK_REACHED' | 'ALREADY_UNLOCKED' | 'INVALID_TARGET';
  newBalance?: number; newRank?: number;
}

export type MetaUIEvent =
  | { type: 'GOLD_CHANGED'; newBalance: number; delta: number }
  | { type: 'CHARACTER_UNLOCKED'; characterId: CharacterId }
  | { type: 'META_STAT_RANKED_UP'; statId: MetaStatId; newRank: number }
  | { type: 'SCREEN_CHANGED'; screen: 'MAIN_MENU' | 'CHAR_SELECT' | 'GOLD_SHOP' }
  | { type: 'SAVE_COMPLETED' }
  | { type: 'SAVE_ERROR'; message: string };

/* ──────────────────────────────────────────────────────────────────────────────
   SECTION 2 — STATIC DATA TABLES (designer-authored balance)
   ────────────────────────────────────────────────────────────────────────────── */

export const META_STAT_DEFINITIONS: MetaStatDefinition[] = [
  { id: 'might',      name: 'Might',      description: 'Increases all damage dealt by +2% per rank.',     maxRanks: 5, multiplierPerRank: 0.02, baseCost: 100, costScaling: 1.6, iconIndex: 0 },
  { id: 'fortitude',  name: 'Fortitude',  description: 'Increases maximum health by +5% per rank.',       maxRanks: 5, multiplierPerRank: 0.05, baseCost: 100, costScaling: 1.5, iconIndex: 8 },
  { id: 'alacrity',   name: 'Alacrity',   description: 'Increases movement speed by +3% per rank.',     maxRanks: 5, multiplierPerRank: 0.03, baseCost: 150, costScaling: 1.7, iconIndex: 2 },
  { id: 'greed',      name: 'Greed',      description: 'Increases gold gained from all sources by +5% per rank.', maxRanks: 5, multiplierPerRank: 0.05, baseCost: 200, costScaling: 1.8, iconIndex: 5 },
  { id: 'celerity',   name: 'Celerity',   description: 'Increases attack speed by +3% per rank.',       maxRanks: 5, multiplierPerRank: 0.03, baseCost: 150, costScaling: 1.6, iconIndex: 3 },
  { id: 'aegis',      name: 'Aegis',      description: 'Reduces incoming damage by +2% armor per rank.', maxRanks: 5, multiplierPerRank: 0.02, baseCost: 120, costScaling: 1.5, iconIndex: 1 },
  { id: 'vision',     name: 'Vision',     description: 'Increases pickup & magnet range by +4% per rank.', maxRanks: 5, multiplierPerRank: 0.04, baseCost: 180, costScaling: 1.7, iconIndex: 4 },
  { id: 'arcana',     name: 'Arcana',     description: 'Increases ability & spell power by +3% per rank.', maxRanks: 5, multiplierPerRank: 0.03, baseCost: 160, costScaling: 1.6, iconIndex: 7 },
];

export const CHARACTER_PROFILES: CharacterProfile[] = [
  {
    id: 'heretic', name: 'The Heretic', title: 'Dark Apostle',
    lore: 'A fallen cleric who traded divine light for forbidden knowledge. Wields cursed scripture that burns foes with unholy flame.',
    portraitUrl: ASSETS.CHAR_PORTRAITS.HERETIC, startingWeapon: 'Unholy Rosary',
    isUnlockedByDefault: true, unlockCostGold: 0,
    baselineStats: { maxHealth: 120, damage: 10, moveSpeed: 4.0, attackSpeed: 1.0, armor: 2, pickupRange: 3.0 },
    frameStyle: 'lava',
  },
  {
    id: 'necromancer', name: 'The Necromancer', title: 'Lord of the Dead',
    lore: 'A skeletal sorcerer who commands the grave. His green necrotic flame consumes the living and raises the fallen.',
    portraitUrl: ASSETS.CHAR_PORTRAITS.NECROMANCER, startingWeapon: 'Bone Staff',
    isUnlockedByDefault: false, unlockCostGold: 2500,
    baselineStats: { maxHealth: 90, damage: 14, moveSpeed: 3.6, attackSpeed: 0.9, armor: 1, pickupRange: 3.5 },
    frameStyle: 'chain',
  },
  {
    id: 'paladin', name: 'The Paladin', title: 'Iron Martyr',
    lore: 'A zealot clad in spiked black iron. His mace crushes heretics, and his faith is his shield—brutal, unyielding, absolute.',
    portraitUrl: ASSETS.CHAR_PORTRAITS.PALADIN, startingWeapon: 'Spiked Mace',
    isUnlockedByDefault: false, unlockCostGold: 3000,
    baselineStats: { maxHealth: 160, damage: 8, moveSpeed: 3.4, attackSpeed: 0.8, armor: 5, pickupRange: 2.5 },
    frameStyle: 'spiked',
  },
  {
    id: 'rogue', name: 'The Rogue', title: 'Shadow of the Cathedral',
    lore: 'An assassin who moves like smoke. Twin runic daggers find the throat before the victim knows death has arrived.',
    portraitUrl: ASSETS.CHAR_PORTRAITS.ROGUE, startingWeapon: 'Runic Daggers',
    isUnlockedByDefault: false, unlockCostGold: 2000,
    baselineStats: { maxHealth: 100, damage: 12, moveSpeed: 5.0, attackSpeed: 1.3, armor: 1, pickupRange: 3.0 },
    frameStyle: 'dragon',
  },
  {
    id: 'vampire', name: 'The Crimson Countess', title: 'Blood Architect',
    lore: 'A vampire aristocrat who commands blood itself. Her wings carry her above the horde as she rains hemomantic destruction.',
    portraitUrl: ASSETS.CHAR_PORTRAITS.VAMPIRE, spriteSheetUrl: ASSETS.CHAR_PORTRAITS.VAMPIRE,
    startingWeapon: 'Blood Orb', isUnlockedByDefault: false, unlockCostGold: 5000,
    baselineStats: { maxHealth: 110, damage: 13, moveSpeed: 4.2, attackSpeed: 1.1, armor: 2, pickupRange: 4.0 },
    frameStyle: 'lava',
  },
];

/* ──────────────────────────────────────────────────────────────────────────────
   SECTION 3 — SECURE SAVE HOOK (encryption + atomic I/O)
   ────────────────────────────────────────────────────────────────────────────── */

const SAVE_KEY = 'gothic_survivor_meta_v1';
const OBFUSCATION_KEY = 'G0th1c_Surv1v0r_S4lv4t10n_K3y_2026';

export class SecureSaveHook {
  private static xor(input: string, key: string): string {
    let out = '';
    for (let i = 0; i < input.length; i++) {
      out += String.fromCharCode(input.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  }

  private static checksum(data: Omit<MetaProgressionSaveData, 'checksum'>): string {
    const payload = `${data.version}:${data.totalGoldAccumulated}:${data.currentGoldBalance}:${data.timestamp}`;
    let hash = 0;
    for (let i = 0; i < payload.length; i++) {
      hash = ((hash << 5) - hash + payload.charCodeAt(i)) | 0;
    }
    return hash.toString(16);
  }

  static save(state: MetaProgressionSaveData): void {
    const payload = { ...state, checksum: this.checksum(state) };
    const encrypted = this.xor(JSON.stringify(payload), OBFUSCATION_KEY);
    localStorage.setItem(SAVE_KEY, btoa(encrypted));
  }

  static load(): MetaProgressionSaveData | null {
    try {
      const encoded = localStorage.getItem(SAVE_KEY);
      if (!encoded) return null;
      const json = this.xor(atob(encoded), OBFUSCATION_KEY);
      const data = JSON.parse(json) as MetaProgressionSaveData;
      if (data.checksum !== this.checksum(data)) {
        console.warn('[SecureSaveHook] Checksum mismatch — possible tampering.');
        return null;
      }
      return data;
    } catch (err) {
      console.error('[SecureSaveHook] Load failed:', err);
      return null;
    }
  }

  static wipe(): void { localStorage.removeItem(SAVE_KEY); }
  static exportString(): string | null { return localStorage.getItem(SAVE_KEY); }
  static importString(encoded: string): boolean {
    try {
      const json = this.xor(atob(encoded), OBFUSCATION_KEY);
      const data = JSON.parse(json) as MetaProgressionSaveData;
      if (data.checksum !== this.checksum(data)) return false;
      localStorage.setItem(SAVE_KEY, encoded);
      return true;
    } catch { return false; }
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
   SECTION 4 — METAPROGRESSION MANAGER (pure state machine)
   ────────────────────────────────────────────────────────────────────────────── */

export class MetaProgressionManager {
  private _totalGoldAccumulated = 0;
  private _currentGoldBalance = 0;
  private _unlockedCharacters = new Set<CharacterId>(['heretic']);
  private _metaStatRanks = new Map<MetaStatId, number>();
  private _listeners = new Set<(event: MetaUIEvent) => void>();
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    META_STAT_DEFINITIONS.forEach((d) => this._metaStatRanks.set(d.id, 0));
    this._hydrateFromDisk();
  }

  /* ── Event System ── */
  subscribe(listener: (event: MetaUIEvent) => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }
  /** Emit an event through the manager's pub-sub bus. Used by renderer for screen-change events. */
  emit(event: MetaUIEvent): void {
    this._listeners.forEach((fn) => { try { fn(event); } catch (e) { console.error(e); } });
  }
  private _emit(event: MetaUIEvent): void { this.emit(event); }

  /* ── Persistence ── */
  private _hydrateFromDisk(): void {
    const saved = SecureSaveHook.load();
    if (!saved) return;
    this._totalGoldAccumulated = saved.totalGoldAccumulated;
    this._currentGoldBalance = saved.currentGoldBalance;
    this._unlockedCharacters = new Set(saved.unlockedCharacters);
    Object.entries(saved.metaStatRanks).forEach(([id, r]) => this._metaStatRanks.set(id as MetaStatId, r));
  }

  private _serialize(): MetaProgressionSaveData {
    const metaStatRanks: Record<MetaStatId, number> = { might: 0, fortitude: 0, alacrity: 0, greed: 0, celerity: 0, aegis: 0, vision: 0, arcana: 0 };
    this._metaStatRanks.forEach((r, id) => metaStatRanks[id] = r);
    return { version: 1, totalGoldAccumulated: this._totalGoldAccumulated, currentGoldBalance: this._currentGoldBalance, unlockedCharacters: Array.from(this._unlockedCharacters), metaStatRanks, timestamp: Date.now(), checksum: '' };
  }

  persist(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      try { SecureSaveHook.save(this._serialize()); this._emit({ type: 'SAVE_COMPLETED' }); }
      catch (err) { this._emit({ type: 'SAVE_ERROR', message: String(err) }); }
    }, 250);
  }

  persistSync(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    try { SecureSaveHook.save(this._serialize()); this._emit({ type: 'SAVE_COMPLETED' }); }
    catch (err) { this._emit({ type: 'SAVE_ERROR', message: String(err) }); }
  }

  /* ── Gold Economy ── */
  get totalGoldAccumulated(): number { return this._totalGoldAccumulated; }
  get currentGoldBalance(): number { return this._currentGoldBalance; }

  addGold(amount: number): void {
    if (amount <= 0) return;
    this._totalGoldAccumulated += amount;
    this._currentGoldBalance += amount;
    this._emit({ type: 'GOLD_CHANGED', newBalance: this._currentGoldBalance, delta: amount });
    this.persist();
  }

  private _deductGold(amount: number): boolean {
    if (amount <= 0) return true;
    if (this._currentGoldBalance < amount) return false;
    const prev = this._currentGoldBalance;
    this._currentGoldBalance -= amount;
    this._emit({ type: 'GOLD_CHANGED', newBalance: this._currentGoldBalance, delta: this._currentGoldBalance - prev });
    return true;
  }

  /* ── Character Unlock System ── */
  getUnlockedCharacters(): CharacterId[] { return Array.from(this._unlockedCharacters); }
  isCharacterUnlocked(id: CharacterId): boolean { return this._unlockedCharacters.has(id); }
  getCharacterProfile(id: CharacterId): CharacterProfile | undefined { return CHARACTER_PROFILES.find((c) => c.id === id); }
  getAllCharacterProfiles(): CharacterProfile[] { return CHARACTER_PROFILES; }

  unlockCharacter(id: CharacterId): PurchaseResult {
    const profile = this.getCharacterProfile(id);
    if (!profile) return { success: false, error: 'INVALID_TARGET' };
    if (this._unlockedCharacters.has(id)) return { success: false, error: 'ALREADY_UNLOCKED' };
    if (!this._deductGold(profile.unlockCostGold)) return { success: false, error: 'INSUFFICIENT_GOLD' };
    this._unlockedCharacters.add(id);
    this.persist();
    this._emit({ type: 'CHARACTER_UNLOCKED', characterId: id });
    return { success: true, newBalance: this._currentGoldBalance };
  }

  /* ── Meta-Stat Rank System ── */
  getMetaStatRank(id: MetaStatId): number { return this._metaStatRanks.get(id) ?? 0; }
  getMetaStatDefinition(id: MetaStatId): MetaStatDefinition | undefined { return META_STAT_DEFINITIONS.find((d) => d.id === id); }

  getMetaStatNextCost(id: MetaStatId): number {
    const def = this.getMetaStatDefinition(id);
    if (!def) return Infinity;
    const rank = this.getMetaStatRank(id);
    if (rank >= def.maxRanks) return Infinity;
    return Math.floor(def.baseCost * Math.pow(def.costScaling, rank));
  }

  buyMetaStatRank(id: MetaStatId): PurchaseResult {
    const def = this.getMetaStatDefinition(id);
    if (!def) return { success: false, error: 'INVALID_TARGET' };
    const currentRank = this.getMetaStatRank(id);
    if (currentRank >= def.maxRanks) return { success: false, error: 'MAX_RANK_REACHED' };
    const cost = this.getMetaStatNextCost(id);
    if (!this._deductGold(cost)) return { success: false, error: 'INSUFFICIENT_GOLD' };
    const newRank = currentRank + 1;
    this._metaStatRanks.set(id, newRank);
    this.persist();
    this._emit({ type: 'META_STAT_RANKED_UP', statId: id, newRank });
    return { success: true, newBalance: this._currentGoldBalance, newRank };
  }

  /* ── Multiplier Matrix (consumed by gameplay systems at run-start) ── */
  buildMultiplierMatrix(): MultiplierMatrix {
    const m = (id: MetaStatId) => {
      const def = this.getMetaStatDefinition(id);
      const rank = this.getMetaStatRank(id);
      return def ? 1 + rank * def.multiplierPerRank : 1;
    };
    return {
      damage: m('might'), maxHealth: m('fortitude'), moveSpeed: m('alacrity'), goldGain: m('greed'),
      attackSpeed: m('celerity'), armor: m('aegis'), pickupRange: m('vision'), abilityPower: m('arcana'),
    };
  }

  /* ── Dev Tools ── */
  resetAllProgression(): void {
    this._totalGoldAccumulated = 0; this._currentGoldBalance = 0;
    this._unlockedCharacters = new Set<CharacterId>(['heretic']);
    META_STAT_DEFINITIONS.forEach((d) => this._metaStatRanks.set(d.id, 0));
    this.persistSync();
  }
  devAddGold(amount: number): void { this.addGold(amount); }
}

/* ──────────────────────────────────────────────────────────────────────────────
   SECTION 5 — DARK FANTASY UI RENDERER (HTML5 menu screens)
   ────────────────────────────────────────────────────────────────────────────── */

interface UIRendererConfig { containerSelector: string; manager: MetaProgressionManager; }

export class MetaMenuUIRenderer {
  private _container: HTMLElement;
  private _manager: MetaProgressionManager;
  private _unsub: (() => void) | null = null;
  private _currentScreen: 'MAIN_MENU' | 'CHAR_SELECT' | 'GOLD_SHOP' = 'MAIN_MENU';

  constructor(cfg: UIRendererConfig) {
    const el = document.querySelector(cfg.containerSelector);
    if (!el) throw new Error(`MetaMenuUIRenderer: container "${cfg.containerSelector}" not found`);
    this._container = el as HTMLElement;
    this._manager = cfg.manager;
    this._injectStyles();
    this._unsub = this._manager.subscribe((e) => this._onEvent(e));
  }

  destroy(): void { if (this._unsub) this._unsub(); this._container.innerHTML = ''; }

  private _injectStyles(): void {
    if (document.getElementById('meta-menu-styles')) return;
    const s = document.createElement('style');
    s.id = 'meta-menu-styles';
    s.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&family=Cinzel+Decorative:wght@700&display=swap');
      :root { --gothic-bg:#0a0a0c; --gothic-panel:#121218; --gothic-border:#2a1f1f; --gothic-gold:#c9a84c; --gothic-gold-dim:#8a7340; --gothic-red:#8b1a1a; --gothic-red-glow:#ff2a2a; --gothic-text:#d4c9b0; --gothic-text-dim:#6b6250; --gothic-green:#3d8b3d; }
      .meta-menu-root { position:fixed; inset:0; background:var(--gothic-bg); font-family:'Cinzel',serif; color:var(--gothic-text); overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; }
      .meta-menu-root::before { content:''; position:absolute; inset:0; background:url('${ASSETS.BG_CATHEDRAL}') center/cover no-repeat; opacity:0.18; pointer-events:none; }
      .mm-main { position:relative; z-index:2; display:flex; flex-direction:column; align-items:center; gap:24px; animation:mmFadeIn 0.8s ease-out; }
      @keyframes mmFadeIn { from{opacity:0;transform:translateY(30px)} to{opacity:1;transform:translateY(0)} }
      .mm-emblem { width:220px; height:220px; background:url('${ASSETS.EMBLEM}') center/contain no-repeat; filter:drop-shadow(0 0 30px rgba(201,168,76,0.3)); animation:mmPulse 4s ease-in-out infinite; }
      @keyframes mmPulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.03)} }
      .mm-title { font-family:'Cinzel Decorative',serif; font-size:3.2rem; font-weight:900; color:var(--gothic-gold); text-shadow:0 0 40px rgba(201,168,76,0.4),0 2px 4px rgba(0,0,0,0.9); letter-spacing:4px; text-transform:uppercase; margin:0; }
      .mm-subtitle { font-size:1rem; color:var(--gothic-text-dim); letter-spacing:6px; text-transform:uppercase; margin-top:-12px; }
      .mm-gold-bar { display:flex; align-items:center; gap:10px; background:linear-gradient(90deg,rgba(201,168,76,0.1),rgba(201,168,76,0.2),rgba(201,168,76,0.1)); border:1px solid var(--gothic-gold-dim); padding:8px 28px; border-radius:4px; font-size:1.1rem; font-weight:700; color:var(--gothic-gold); }
      .mm-gold-bar .mm-crystal { width:24px; height:24px; background:url('${ASSETS.CRYSTALS}') no-repeat; background-size:900% 400%; background-position:66.6% 33.3%; filter:drop-shadow(0 0 6px rgba(180,120,255,0.6)); }
      .mm-btn-row { display:flex; gap:20px; margin-top:12px; }
      .mm-btn { position:relative; font-family:'Cinzel',serif; font-size:1rem; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:16px 48px; background:linear-gradient(180deg,rgba(30,20,20,0.95),rgba(15,10,10,0.98)); border:2px solid var(--gothic-border); color:var(--gothic-gold-dim); cursor:pointer; transition:all 0.25s ease; clip-path:polygon(10% 0,100% 0,100% 70%,90% 100%,0 100%,0 30%); }
      .mm-btn:hover { color:var(--gothic-gold); border-color:var(--gothic-gold); transform:translateY(-2px); box-shadow:0 8px 30px rgba(201,168,76,0.15); }
      .mm-btn:active { transform:translateY(0); }
      .mm-btn-primary { border-color:var(--gothic-red); color:var(--gothic-red-glow); }
      .mm-btn-primary:hover { border-color:var(--gothic-red-glow); box-shadow:0 8px 30px rgba(139,26,26,0.3); }
      .mm-screen { position:relative; z-index:2; width:100%; max-width:1200px; padding:40px; animation:mmSlideIn 0.5s ease-out; }
      @keyframes mmSlideIn { from{opacity:0;transform:translateX(40px)} to{opacity:1;transform:translateX(0)} }
      .mm-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:32px; border-bottom:1px solid var(--gothic-border); padding-bottom:16px; }
      .mm-header h2 { font-family:'Cinzel Decorative',serif; font-size:2rem; color:var(--gothic-gold); margin:0; text-shadow:0 0 20px rgba(201,168,76,0.3); }
      .mm-back { background:none; border:1px solid var(--gothic-border); color:var(--gothic-text-dim); padding:8px 20px; font-family:'Cinzel',serif; cursor:pointer; transition:all 0.2s; font-size:0.85rem; letter-spacing:2px; }
      .mm-back:hover { color:var(--gothic-gold); border-color:var(--gothic-gold); }
      .mm-char-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:24px; }
      .mm-char-card { position:relative; background:var(--gothic-panel); border:2px solid var(--gothic-border); border-radius:6px; overflow:hidden; cursor:pointer; transition:all 0.3s ease; display:flex; flex-direction:column; }
      .mm-char-card:hover { border-color:var(--gothic-gold-dim); transform:translateY(-4px); box-shadow:0 12px 40px rgba(0,0,0,0.6),0 0 20px rgba(201,168,76,0.08); }
      .mm-char-card.locked { opacity:0.55; filter:grayscale(0.7); }
      .mm-char-card.locked:hover { opacity:0.75; filter:grayscale(0.4); }
      .mm-char-card.selected { border-color:var(--gothic-gold); box-shadow:0 0 30px rgba(201,168,76,0.2),inset 0 0 20px rgba(201,168,76,0.05); }
      .mm-char-portrait-wrap { position:relative; height:200px; overflow:hidden; background:#000; }
      .mm-char-portrait { width:100%; height:100%; object-fit:cover; transition:transform 0.5s ease; }
      .mm-char-card:hover .mm-char-portrait { transform:scale(1.08); }
      .mm-char-frame-overlay { position:absolute; inset:0; pointer-events:none; border:3px solid transparent; border-image:linear-gradient(135deg,var(--gothic-gold-dim),transparent 30%,transparent 70%,var(--gothic-gold-dim)) 1; }
      .mm-char-lock { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; background:rgba(0,0,0,0.65); gap:8px; }
      .mm-char-lock-icon { width:48px; height:48px; background:url('${ASSETS.BADGES}') no-repeat; background-size:200% 100%; background-position:0 0; opacity:0.8; }
      .mm-char-lock-cost { color:var(--gothic-gold); font-weight:700; font-size:0.95rem; display:flex; align-items:center; gap:6px; }
      .mm-char-info { padding:16px; display:flex; flex-direction:column; gap:6px; }
      .mm-char-name { font-family:'Cinzel Decorative',serif; font-size:1.15rem; color:var(--gothic-gold); margin:0; }
      .mm-char-title { font-size:0.75rem; color:var(--gothic-text-dim); letter-spacing:3px; text-transform:uppercase; margin-top:-4px; }
      .mm-char-weapon { font-size:0.8rem; color:var(--gothic-red-glow); display:flex; align-items:center; gap:6px; }
      .mm-char-weapon::before { content:''; display:inline-block; width:14px; height:14px; background:url('${ASSETS.WEAPONS}') no-repeat; background-size:1400% 400%; background-position:0 0; }
      .mm-char-stats { display:grid; grid-template-columns:1fr 1fr; gap:4px 12px; margin-top:8px; font-size:0.72rem; color:var(--gothic-text-dim); }
      .mm-char-stat { display:flex; justify-content:space-between; }
      .mm-char-stat span:last-child { color:var(--gothic-text); font-weight:700; }
      .mm-char-select-btn { margin:0 16px 16px; padding:10px; background:linear-gradient(180deg,rgba(201,168,76,0.15),rgba(201,168,76,0.05)); border:1px solid var(--gothic-gold-dim); color:var(--gothic-gold); font-family:'Cinzel',serif; font-size:0.85rem; font-weight:700; letter-spacing:2px; text-transform:uppercase; cursor:pointer; transition:all 0.2s; }
      .mm-char-select-btn:hover { background:linear-gradient(180deg,rgba(201,168,76,0.3),rgba(201,168,76,0.1)); border-color:var(--gothic-gold); }
      .mm-char-select-btn:disabled { opacity:0.4; cursor:not-allowed; background:rgba(255,255,255,0.03); border-color:var(--gothic-border); color:var(--gothic-text-dim); }
      .mm-shop-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:20px; }
      .mm-shop-card { position:relative; background:linear-gradient(180deg,rgba(18,18,24,0.98),rgba(10,10,14,0.98)); border:2px solid var(--gothic-border); border-radius:6px; padding:20px; display:flex; flex-direction:column; gap:12px; transition:all 0.3s ease; }
      .mm-shop-card:hover { border-color:var(--gothic-gold-dim); box-shadow:0 8px 30px rgba(0,0,0,0.5); }
      .mm-shop-card.maxed { opacity:0.5; border-color:var(--gothic-green); }
      .mm-shop-header { display:flex; align-items:center; gap:14px; }
      .mm-shop-icon { width:56px; height:56px; background:url('${ASSETS.STAT_ICONS}') no-repeat; background-size:300% 300%; border-radius:50%; border:2px solid var(--gothic-border); flex-shrink:0; }
      .mm-shop-title-group { display:flex; flex-direction:column; }
      .mm-shop-name { font-family:'Cinzel Decorative',serif; font-size:1.1rem; color:var(--gothic-gold); }
      .mm-shop-rank { font-size:0.75rem; color:var(--gothic-text-dim); display:flex; align-items:center; gap:6px; }
      .mm-rank-pip { width:8px; height:8px; border-radius:1px; background:var(--gothic-border); transform:rotate(45deg); transition:all 0.3s; }
      .mm-rank-pip.filled { background:var(--gothic-gold); box-shadow:0 0 6px rgba(201,168,76,0.5); }
      .mm-shop-desc { font-size:0.8rem; color:var(--gothic-text-dim); line-height:1.5; min-height:36px; }
      .mm-shop-current { font-size:0.8rem; color:var(--gothic-text); }
      .mm-shop-current strong { color:var(--gothic-gold); }
      .mm-shop-buy-row { display:flex; align-items:center; justify-content:space-between; margin-top:auto; padding-top:12px; border-top:1px solid var(--gothic-border); }
      .mm-shop-cost { display:flex; align-items:center; gap:8px; font-size:1rem; font-weight:700; color:var(--gothic-gold); }
      .mm-shop-cost.unaffordable { color:var(--gothic-red-glow); }
      .mm-shop-buy-btn { padding:8px 24px; background:linear-gradient(180deg,rgba(139,26,26,0.3),rgba(139,26,26,0.1)); border:1px solid var(--gothic-red); color:var(--gothic-red-glow); font-family:'Cinzel',serif; font-size:0.8rem; font-weight:700; letter-spacing:2px; text-transform:uppercase; cursor:pointer; transition:all 0.2s; clip-path:polygon(8% 0,100% 0,100% 75%,92% 100%,0 100%,0 25%); }
      .mm-shop-buy-btn:hover:not(:disabled) { background:linear-gradient(180deg,rgba(139,26,26,0.5),rgba(139,26,26,0.2)); border-color:var(--gothic-red-glow); box-shadow:0 0 15px rgba(139,26,26,0.2); }
      .mm-shop-buy-btn:disabled { opacity:0.3; cursor:not-allowed; border-color:var(--gothic-border); color:var(--gothic-text-dim); background:rgba(255,255,255,0.02); }
      .mm-shop-max-badge { font-size:0.75rem; color:var(--gothic-green); font-weight:700; letter-spacing:2px; }
      .mm-toast-container { position:fixed; top:24px; right:24px; z-index:1000; display:flex; flex-direction:column; gap:10px; pointer-events:none; }
      .mm-toast { background:rgba(10,10,14,0.95); border:1px solid var(--gothic-gold-dim); padding:12px 24px; color:var(--gothic-gold); font-size:0.85rem; font-weight:700; letter-spacing:1px; animation:mmToastIn 0.4s ease, mmToastOut 0.4s ease 2.6s forwards; clip-path:polygon(5% 0,100% 0,100% 80%,95% 100%,0 100%,0 20%); }
      .mm-toast.error { border-color:var(--gothic-red); color:var(--gothic-red-glow); }
      @keyframes mmToastIn { from{opacity:0;transform:translateX(40px)} to{opacity:1;transform:translateX(0)} }
      @keyframes mmToastOut { to{opacity:0;transform:translateX(40px)} }
    `;
    document.head.appendChild(s);
  }

  private _onEvent(evt: MetaUIEvent): void {
    switch (evt.type) {
      case 'GOLD_CHANGED': this._updateGoldDisplays(); break;
      case 'CHARACTER_UNLOCKED': this._showToast(`${this._manager.getCharacterProfile(evt.characterId)?.name} Unlocked!`); if (this._currentScreen === 'CHAR_SELECT') this.renderCharacterSelect(); break;
      case 'META_STAT_RANKED_UP': this._showToast(`${this._manager.getMetaStatDefinition(evt.statId)?.name} Rank ${evt.newRank}!`); if (this._currentScreen === 'GOLD_SHOP') this.renderGoldShop(); break;
      case 'SAVE_ERROR': this._showToast('Save Error: ' + evt.message, true); break;
    }
  }

  private _updateGoldDisplays(): void {
    this._container.querySelectorAll('.mm-gold-display').forEach((el) => { el.textContent = this._manager.currentGoldBalance.toLocaleString(); });
  }

  private _showToast(msg: string, isError = false): void {
    let c = document.querySelector('.mm-toast-container') as HTMLElement;
    if (!c) { c = document.createElement('div'); c.className = 'mm-toast-container'; document.body.appendChild(c); }
    const t = document.createElement('div');
    t.className = `mm-toast ${isError ? 'error' : ''}`; t.textContent = msg;
    c.appendChild(t); setTimeout(() => t.remove(), 3000);
  }

  /* ── Main Menu ── */
  renderMainMenu(): void {
    this._currentScreen = 'MAIN_MENU';
    this._manager.persist();
    this._container.innerHTML = `
      <div class="meta-menu-root">
        <div class="mm-main">
          <div class="mm-emblem"></div>
          <h1 class="mm-title">Sanctum of Ash</h1>
          <p class="mm-subtitle">Survive the Endless Night</p>
          <div class="mm-gold-bar"><div class="mm-crystal"></div><span class="mm-gold-display">${this._manager.currentGoldBalance.toLocaleString()}</span></div>
          <div class="mm-btn-row">
            <button class="mm-btn mm-btn-primary" id="mm-btn-play">Enter the Sanctum</button>
            <button class="mm-btn" id="mm-btn-chars">Choose Vessel</button>
            <button class="mm-btn" id="mm-btn-shop">Gold Shop</button>
          </div>
        </div>
      </div>`;
    this._container.querySelector('#mm-btn-play')?.addEventListener('click', () => this._emit({ type: 'SCREEN_CHANGED', screen: 'MAIN_MENU' }));
    this._container.querySelector('#mm-btn-chars')?.addEventListener('click', () => this.renderCharacterSelect());
    this._container.querySelector('#mm-btn-shop')?.addEventListener('click', () => this.renderGoldShop());
  }

  /* ── Character Selection ── */
  renderCharacterSelect(): void {
    this._currentScreen = 'CHAR_SELECT';
    const profiles = this._manager.getAllCharacterProfiles();
    const unlocked = new Set(this._manager.getUnlockedCharacters());
    const cards = profiles.map((p) => {
      const isUnlocked = unlocked.has(p.id);
      const lockHtml = isUnlocked ? '' : `<div class="mm-char-lock"><div class="mm-char-lock-icon"></div><div class="mm-char-lock-cost"><div class="mm-crystal" style="width:16px;height:16px;background-size:900% 400%;background-position:66.6% 33.3%;"></div>${p.unlockCostGold.toLocaleString()}</div></div>`;
      const frameColor = { lava: '#c94a1a', chain: '#8a8a8a', spiked: '#5a3a3a', dragon: '#6b3d8b' }[p.frameStyle];
      return `<div class="mm-char-card ${isUnlocked ? '' : 'locked'}" data-char-id="${p.id}">
        <div class="mm-char-portrait-wrap">
          <img class="mm-char-portrait" src="${p.portraitUrl}" alt="${p.name}" loading="lazy" />
          <div class="mm-char-frame-overlay" style="border-image-source:linear-gradient(135deg,${frameColor},transparent 30%,transparent 70%,${frameColor});"></div>
          ${lockHtml}
        </div>
        <div class="mm-char-info">
          <h3 class="mm-char-name">${p.name}</h3>
          <div class="mm-char-title">${p.title}</div>
          <div class="mm-char-weapon">${p.startingWeapon}</div>
          <div class="mm-char-stats">
            <div class="mm-char-stat"><span>Health</span><span>${p.baselineStats.maxHealth}</span></div>
            <div class="mm-char-stat"><span>Damage</span><span>${p.baselineStats.damage}</span></div>
            <div class="mm-char-stat"><span>Speed</span><span>${p.baselineStats.moveSpeed}</span></div>
            <div class="mm-char-stat"><span>Armor</span><span>${p.baselineStats.armor}</span></div>
          </div>
        </div>
        <button class="mm-char-select-btn" data-char-action="${isUnlocked ? 'select' : 'unlock'}" data-char-id="${p.id}" ${!isUnlocked && this._manager.currentGoldBalance < p.unlockCostGold ? 'disabled' : ''}>${isUnlocked ? 'Select Vessel' : 'Unlock'}</button>
      </div>`;
    }).join('');

    this._container.innerHTML = `
      <div class="meta-menu-root">
        <div class="mm-screen">
          <div class="mm-header">
            <h2>Choose Your Vessel</h2>
            <div style="display:flex;align-items:center;gap:16px;">
              <div class="mm-gold-bar"><div class="mm-crystal"></div><span class="mm-gold-display">${this._manager.currentGoldBalance.toLocaleString()}</span></div>
              <button class="mm-back" id="mm-btn-back">← Return</button>
            </div>
          </div>
          <div class="mm-char-grid">${cards}</div>
        </div>
      </div>`;

    this._container.querySelector('#mm-btn-back')?.addEventListener('click', () => this.renderMainMenu());
    this._container.querySelectorAll('.mm-char-select-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const t = e.currentTarget as HTMLElement;
        const charId = t.dataset.charId as CharacterId;
        if (t.dataset.charAction === 'unlock') {
          const result = this._manager.unlockCharacter(charId);
          if (!result.success) this._showToast(result.error === 'INSUFFICIENT_GOLD' ? 'Not enough gold, hunter.' : 'Cannot unlock.', true);
        } else {
          this._showToast(`${this._manager.getCharacterProfile(charId)?.name} selected.`);
          this._emit({ type: 'SCREEN_CHANGED', screen: 'MAIN_MENU' });
        }
      });
    });
  }

  /* ── Gold Shop ── */
  renderGoldShop(): void {
    this._currentScreen = 'GOLD_SHOP';
    const cards = META_STAT_DEFINITIONS.map((def) => {
      const currentRank = this._manager.getMetaStatRank(def.id);
      const isMaxed = currentRank >= def.maxRanks;
      const cost = this._manager.getMetaStatNextCost(def.id);
      const canAfford = this._manager.currentGoldBalance >= cost;
      const currentMult = (currentRank * def.multiplierPerRank * 100).toFixed(0);
      const nextMult = ((currentRank + 1) * def.multiplierPerRank * 100).toFixed(0);
      const col = def.iconIndex % 3, row = Math.floor(def.iconIndex / 3);
      const bgPos = `${(col / 2) * 100}% ${(row / 2) * 100}%`;
      const pips = Array.from({ length: def.maxRanks }, (_, i) => `<div class="mm-rank-pip ${i < currentRank ? 'filled' : ''}"></div>`).join('');
      return `<div class="mm-shop-card ${isMaxed ? 'maxed' : ''}" data-stat-id="${def.id}">
        <div class="mm-shop-header">
          <div class="mm-shop-icon" style="background-position:${bgPos};"></div>
          <div class="mm-shop-title-group">
            <div class="mm-shop-name">${def.name}</div>
            <div class="mm-shop-rank">${pips}</div>
          </div>
        </div>
        <div class="mm-shop-desc">${def.description}</div>
        <div class="mm-shop-current">Current: <strong>+${currentMult}%</strong>${!isMaxed ? ` → Next: <strong>+${nextMult}%</strong>` : ''}</div>
        <div class="mm-shop-buy-row">
          ${isMaxed ? '<span class="mm-shop-max-badge">MAXIMUM RANK</span>' : `<div class="mm-shop-cost ${canAfford ? 'affordable' : 'unaffordable'}"><div class="mm-crystal" style="width:16px;height:16px;background-size:900% 400%;background-position:66.6% 33.3%;"></div>${cost.toLocaleString()}</div><button class="mm-shop-buy-btn" data-stat-id="${def.id}" ${!canAfford ? 'disabled' : ''}>Purchase</button>`}
        </div>
      </div>`;
    }).join('');

    this._container.innerHTML = `
      <div class="meta-menu-root">
        <div class="mm-screen">
          <div class="mm-header">
            <h2>Gold Shop</h2>
            <div style="display:flex;align-items:center;gap:16px;">
              <div class="mm-gold-bar"><div class="mm-crystal"></div><span class="mm-gold-display">${this._manager.currentGoldBalance.toLocaleString()}</span></div>
              <button class="mm-back" id="mm-btn-back">← Return</button>
            </div>
          </div>
          <div class="mm-shop-grid">${cards}</div>
        </div>
      </div>`;

    this._container.querySelector('#mm-btn-back')?.addEventListener('click', () => this.renderMainMenu());
    this._container.querySelectorAll('.mm-shop-buy-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const statId = (e.currentTarget as HTMLElement).dataset.statId as MetaStatId;
        const result = this._manager.buyMetaStatRank(statId);
        if (!result.success) this._showToast(result.error === 'INSUFFICIENT_GOLD' ? 'Not enough gold.' : 'Maximum rank reached.', true);
      });
    });
  }

  private _emit(event: MetaUIEvent): void {
    this._manager.emit(event);
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
   SECTION 6 — MODULE EXPORTS & USAGE EXAMPLE
   ────────────────────────────────────────────────────────────────────────────── */

/**
 * Bootstrap the entire meta-menu system in one call.
 * Usage:
 *   import { bootstrapMetaMenu } from './MetaProgression';
 *   const menu = bootstrapMetaMenu('#game-ui');
 *   menu.renderer.renderMainMenu();
 */
export function bootstrapMetaMenu(containerSelector: string) {
  const manager = new MetaProgressionManager();
  const renderer = new MetaMenuUIRenderer({ containerSelector, manager });
  return { manager, renderer };
}

/** Debug console helper for designers */
(window as any).metaDebug = {
  reset: () => { const m = new MetaProgressionManager(); m.resetAllProgression(); location.reload(); },
  gold: (n: number) => { const m = new MetaProgressionManager(); m.devAddGold(n); },
  matrix: () => { const m = new MetaProgressionManager(); console.table(m.buildMultiplierMatrix()); },
  exportSave: () => console.log(SecureSaveHook.exportString()),
};
