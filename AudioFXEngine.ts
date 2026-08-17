// =============================================================================
// AudioFXEngine.ts
// Principal Audio Programmer & Sound Designer Module
// =============================================================================
// Architecture:
//   - Master Gain -> 3 Busses (Music | Ambient | Combat)
//   - Per-source chain: BufferSource -> Lowpass -> StereoPanner -> Gain -> Bus
//   - Listener-driven spatial update loop for pan/cutoff/attenuation
//   - Combat polyphony hard-cap at 32 with priority + distance eviction
//   - Music layer crossfader with exponential gain ramps
// =============================================================================

export type AudioBus = 'music' | 'ambient' | 'combat';

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface SoundRegistryEntry {
  /** Game event tag used to trigger playback */
  event: string;
  /** Relative or absolute URL to the decoded audio asset */
  src: string;
  /** Target mixer bus */
  bus: AudioBus;
  /** Priority 1–10 (10 = critical). Used for combat eviction. */
  priority: number;
  /** Loop flag (primarily for music/ambient) */
  loop: boolean;
  /** If true, spatial panner + lowpass + distance attenuation is applied */
  spatial: boolean;
  /** Base volume 0.0–1.0 */
  volume?: number;
  /** Max audible distance in world units (default 50) */
  maxDistance?: number;
  /** Playback rate variance for organic variation (0 = none) */
  pitchVar?: number;
}

export interface ActiveSound {
  id: number;
  entry: SoundRegistryEntry;
  sourceNode: AudioBufferSourceNode;
  gainNode: GainNode;
  pannerNode: StereoPannerNode;
  filterNode: BiquadFilterNode;
  position: Vector3;
  startTime: number;
}

interface MusicLayer {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioFXEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;

  private readonly busses: Record<AudioBus, GainNode> = {
    music: null as unknown as GainNode,
    ambient: null as unknown as GainNode,
    combat: null as unknown as GainNode,
  };

  private readonly registry = new Map<string, SoundRegistryEntry>();
  private readonly buffers = new Map<string, AudioBuffer>();
  private activeSounds: ActiveSound[] = [];

  private listenerPos: Vector3 = { x: 0, y: 0, z: 0 };
  private nextId = 0;

  // Polyphony ceiling for the combat bus
  private readonly MAX_COMBAT_POLYPHONY = 32;

  // Crossfade state
  private currentMusic: MusicLayer | null = null;
  private nextMusic: MusicLayer | null = null;

  // ---------------------------------------------------------------------------
  // 1. Initialization & Bus Construction
  // ---------------------------------------------------------------------------

  /**
   * Boot the Web Audio graph.
   * Call once after a user gesture to satisfy autoplay policies.
   */
  public async init(): Promise<void> {
    const AudioCtx =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    this.ctx = new AudioCtx();

    // Master mixer -> destination
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1.0;
    this.masterGain.connect(this.ctx.destination);

    // Three distinct control busses
    (['music', 'ambient', 'combat'] as AudioBus[]).forEach((bus) => {
      const gain = this.ctx!.createGain();
      gain.gain.value = 1.0;
      gain.connect(this.masterGain!);
      this.busses[bus] = gain;
    });
  }

  // ---------------------------------------------------------------------------
  // 2. Registry & Asset Buffering
  // ---------------------------------------------------------------------------

  /** Feed the engine its data-driven sound registry array. */
  public registerSounds(entries: SoundRegistryEntry[]): void {
    entries.forEach((e) => this.registry.set(e.event, e));
  }

  /** Parallel decode of every unique src in the registry. */
  public async preload(): Promise<void> {
    if (!this.ctx) throw new Error('AudioFXEngine not initialized');
    const jobs: Promise<void>[] = [];
    const seen = new Set<string>();

    this.registry.forEach((entry) => {
      if (!seen.has(entry.src)) {
        seen.add(entry.src);
        jobs.push(this.loadBuffer(entry.src));
      }
    });

    await Promise.all(jobs);
  }

  private async loadBuffer(src: string): Promise<void> {
    try {
      const res = await fetch(src);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arr = await res.arrayBuffer();
      const buf = await this.ctx!.decodeAudioData(arr);
      this.buffers.set(src, buf);
    } catch (err) {
      console.error(`[AudioFXEngine] Failed to load ${src}`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Playback & Polyphony Limiter
  // ---------------------------------------------------------------------------

  /**
   * Trigger a registered event.
   * @param event   Registry event tag
   * @param position World-space Vector3 (ignored if entry.spatial === false)
   * @returns       Active sound ID, or null if dropped/evicted
   */
  public playEvent(event: string, position?: Vector3): number | null {
    const entry = this.registry.get(event);
    if (!entry || !this.ctx) return null;

    const buffer = this.buffers.get(entry.src);
    if (!buffer) {
      console.warn(`[AudioFXEngine] Buffer missing for event "${event}"`);
      return null;
    }

    // ---- Combat Polyphony Guard --------------------------------------------
    if (entry.bus === 'combat') {
      const combatSounds = this.activeSounds.filter((s) => s.entry.bus === 'combat');
      if (combatSounds.length >= this.MAX_COMBAT_POLYPHONY) {
        // Sort: lowest priority first, then farthest away
        combatSounds.sort((a, b) => {
          if (a.entry.priority !== b.entry.priority) {
            return a.entry.priority - b.entry.priority;
          }
          return this.sqDistanceToListener(b.position) - this.sqDistanceToListener(a.position);
        });

        const victim = combatSounds[0]; // lowest priority / farthest
        if (victim && victim.entry.priority <= entry.priority) {
          this.stopSound(victim.id);
        } else {
          // New sound is lower priority than everything active; drop it.
          return null;
        }
      }
    }

    // ---- Build per-source DSP chain ----------------------------------------
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = entry.loop;

    // Pitch variance for organic texture
    if (entry.pitchVar && entry.pitchVar > 0) {
      const detune = (Math.random() * 2 - 1) * entry.pitchVar * 100; // cents
      source.detune.value = detune;
    }

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 20000;
    filter.Q.value = 0; // gentle slope

    const panner = this.ctx.createStereoPanner();
    panner.pan.value = 0;

    const gain = this.ctx.createGain();
    gain.gain.value = entry.volume ?? 1.0;

    // Chain: Source -> Lowpass -> Panner -> Gain -> Bus
    source.connect(filter);
    filter.connect(panner);
    panner.connect(gain);
    gain.connect(this.busses[entry.bus]);

    const id = this.nextId++;
    const sound: ActiveSound = {
      id,
      entry,
      sourceNode: source,
      gainNode: gain,
      pannerNode: panner,
      filterNode: filter,
      position: position ?? { x: 0, y: 0, z: 0 },
      startTime: this.ctx.currentTime,
    };

    source.onended = () => this.removeSound(id);
    this.activeSounds.push(sound);

    // Initial spatial bake
    if (entry.spatial) {
      this.updateSoundSpatial(sound);
    }

    source.start();
    return id;
  }

  /** Hard-stop a playing sound and purge it from the active list. */
  public stopSound(id: number): void {
    const sound = this.activeSounds.find((s) => s.id === id);
    if (!sound) return;
    try {
      sound.sourceNode.stop();
    } catch {
      // Already stopped
    }
    this.removeSound(id);
  }

  private removeSound(id: number): void {
    this.activeSounds = this.activeSounds.filter((s) => s.id !== id);
  }

  // ---------------------------------------------------------------------------
  // 4. 3D Spatial Audio Panning Framework
  // ---------------------------------------------------------------------------

  /**
   * Update the isometric camera / listener position.
   * Automatically re-bakes every active spatial source.
   */
  public setListenerPosition(pos: Vector3): void {
    this.listenerPos = { ...pos };
    this.activeSounds.forEach((s) => {
      if (s.entry.spatial) this.updateSoundSpatial(s);
    });
  }

  /**
   * Per-source spatialization math.
   * - Pan: derived from lateral X offset normalized to maxDistance.
   * - Lowpass cutoff: rolled off with Euclidean proximity.
   * - Gain: attenuated by inverse distance law.
   */
  private updateSoundSpatial(sound: ActiveSound): void {
    const now = this.ctx!.currentTime;
    const maxDist = sound.entry.maxDistance ?? 50;
    const dx = sound.position.x - this.listenerPos.x;
    const dy = sound.position.y - this.listenerPos.y;
    const dz = sound.position.z - this.listenerPos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

    // Stereo pan: clamped -1..1 based on lateral displacement
    const pan = Math.max(-1, Math.min(1, dx / maxDist));
    sound.pannerNode.pan.setTargetAtTime(pan, now, 0.05);

    // Lowpass frequency roll-off: closer = brighter
    const cutoff = Math.max(400, 20000 * Math.max(0, 1 - dist / maxDist));
    sound.filterNode.frequency.setTargetAtTime(cutoff, now, 0.05);

    // Distance attenuation
    const baseVol = sound.entry.volume ?? 1.0;
    const attenuation = Math.max(0, 1 - dist / maxDist);
    sound.gainNode.gain.setTargetAtTime(baseVol * attenuation, now, 0.05);
  }

  private sqDistanceToListener(pos: Vector3): number {
    const dx = pos.x - this.listenerPos.x;
    const dy = pos.y - this.listenerPos.y;
    const dz = pos.z - this.listenerPos.z;
    return dx * dx + dy * dy + dz * dz;
  }

  // ---------------------------------------------------------------------------
  // 5. Crossfading Loop System (Music Layers)
  // ---------------------------------------------------------------------------

  /**
   * Seamlessly crossfade from the current music loop to a new registry event.
   * @param event    Target music layer event tag
   * @param duration Crossfade time in seconds (default 3.0)
   */
  public crossfadeMusic(event: string, duration = 3.0): void {
    const entry = this.registry.get(event);
    if (!entry || !this.ctx) return;
    if (entry.bus !== 'music') {
      console.warn(`[AudioFXEngine] Event "${event}" is not a music bus entry.`);
      return;
    }

    const buffer = this.buffers.get(entry.src);
    if (!buffer) return;

    const nextGain = this.ctx.createGain();
    nextGain.gain.setValueAtTime(0, this.ctx.currentTime);
    nextGain.connect(this.busses.music);

    const nextSource = this.ctx.createBufferSource();
    nextSource.buffer = buffer;
    nextSource.loop = true;
    nextSource.connect(nextGain);

    const now = this.ctx.currentTime;
    const targetVol = entry.volume ?? 1.0;

    // Fade out incumbent
    if (this.currentMusic) {
      this.currentMusic.gain.gain.setTargetAtTime(0, now, duration / 3);
      this.currentMusic.source.stop(now + duration + 0.5);
    }

    // Fade in newcomer
    nextGain.gain.setTargetAtTime(targetVol, now, duration / 3);
    nextSource.start(now);

    this.nextMusic = { source: nextSource, gain: nextGain };

    // Promote to current after fade completes
    window.setTimeout(() => {
      this.currentMusic = this.nextMusic;
      this.nextMusic = null;
    }, duration * 1000);
  }

  // ---------------------------------------------------------------------------
  // 6. Utility / Mixer Controls
  // ---------------------------------------------------------------------------

  /** Set per-bus master gain (0.0–1.0+) */
  public setBusVolume(bus: AudioBus, volume: number): void {
    if (!this.ctx || !this.busses[bus]) return;
    this.busses[bus].gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1);
  }

  /** Set global master gain */
  public setMasterVolume(volume: number): void {
    if (!this.ctx || !this.masterGain) return;
    this.masterGain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.1);
  }

  /** Pause audio context (e.g., on tab blur) */
  public suspend(): Promise<void> {
    return this.ctx?.suspend() ?? Promise.resolve();
  }

  /** Resume audio context (e.g., on tab focus) */
  public resume(): Promise<void> {
    return this.ctx?.resume() ?? Promise.resolve();
  }

  /** Diagnostic: number of active voices */
  public get activeVoiceCount(): number {
    return this.activeSounds.length;
  }
}

// =============================================================================
// Example Data-Driven Registry (consumes the above API)
// =============================================================================
export const EXAMPLE_SOUND_REGISTRY: SoundRegistryEntry[] = [
  // Music layers
  {
    event: 'music_outdoor_mansion',
    src: 'assets/audio/music/mansion_exterior.ogg',
    bus: 'music',
    priority: 10,
    loop: true,
    spatial: false,
    volume: 0.75,
  },
  {
    event: 'music_indoor_crypt',
    src: 'assets/audio/music/crypt_interior.ogg',
    bus: 'music',
    priority: 10,
    loop: true,
    spatial: false,
    volume: 0.75,
  },

  // Ambient
  {
    event: 'amb_wind_gothic',
    src: 'assets/audio/amb/wind_howl.ogg',
    bus: 'ambient',
    priority: 5,
    loop: true,
    spatial: false,
    volume: 0.4,
  },
  {
    event: 'amb_abyssal_rift',
    src: 'assets/audio/amb/rift_hum.ogg',
    bus: 'ambient',
    priority: 6,
    loop: true,
    spatial: true,
    volume: 0.6,
    maxDistance: 30,
  },

  // Combat FX
  {
    event: 'sfx_bone_shatter',
    src: 'assets/audio/combat/bone_break.ogg',
    bus: 'combat',
    priority: 3,
    loop: false,
    spatial: true,
    volume: 0.9,
    maxDistance: 40,
    pitchVar: 0.15,
  },
  {
    event: 'sfx_swarm_spawn',
    src: 'assets/audio/combat/swarm_crawl.ogg',
    bus: 'combat',
    priority: 4,
    loop: false,
    spatial: true,
    volume: 0.7,
    maxDistance: 50,
    pitchVar: 0.2,
  },
  {
    event: 'sfx_barrel_explode',
    src: 'assets/audio/combat/explosion_small.ogg',
    bus: 'combat',
    priority: 7,
    loop: false,
    spatial: true,
    volume: 1.0,
    maxDistance: 60,
  },
  {
    event: 'sfx_player_spell_cast',
    src: 'assets/audio/combat/spell_cast.ogg',
    bus: 'combat',
    priority: 9,
    loop: false,
    spatial: false,
    volume: 0.85,
  },
];
