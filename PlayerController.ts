import { Vector3, MeshBuilder, Mesh, Scene, ActionManager, ExecuteCodeAction, AbstractMesh } from "@babylonjs/core";

/**
 * PlayerController.ts
 * -------------------
 * Modular player management and controller for a Babylon.js isometric
 * horde-survival rogue-lite. Handles input, movement physics, camera
 * tracking, and core player state (health, XP, passive modifiers).
 *
 * No rendering, sprite, weapon, or enemy logic lives here.
 */

export interface PlayerStatsSnapshot {
    health: number;
    maxHealth: number;
    playerLevel: number;
    playerXP: number;
    xpNeeded: number;
    baseSpeed: number;
    moveSpeedMultiplier: number;
    passiveDamageMod: number;
    passiveArmor: number;
    passiveCritChance: number;
    passiveCritDamage: number;
    passiveAttackSpeed: number;
    passivePickupRadius: number;
    passiveMaxHealthMod: number;
    passiveRegen: number;
}

export class PlayerController {
    // ─── Core Scene References ─────────────────────────────────────────
    private _scene: Scene;
    private _camera: any; // Isometric camera reference (duck-typed for flexibility)

    // ─── Physical Body ─────────────────────────────────────────────────
    /** Invisible logical collision capsule — the player's physical tracking body. */
    public readonly body: Mesh;

    // ─── Movement State ────────────────────────────────────────────────
    private _baseSpeed: number = 8.0;
    private _moveSpeedMultiplier: number = 1.0;
    private _velocity: Vector3 = Vector3.Zero();
    private _inputDirection: Vector3 = Vector3.Zero();
    private _isMoving: boolean = false;

    // ─── Input State ───────────────────────────────────────────────────
    private _keysPressed: Set<string> = new Set();
    private _inputMap: Map<string, boolean> = new Map();

    // ─── Camera Offset ─────────────────────────────────────────────────
    private _cameraOffset: Vector3 = new Vector3(0, 25, -25);
    private _cameraLerpFactor: number = 0.12;

    // ─── Health & Vitality ─────────────────────────────────────────────
    public health: number = 100;
    public maxHealth: number = 100;

    // ─── Level & Progression ───────────────────────────────────────────
    public playerLevel: number = 1;
    public playerXP: number = 0;
    public xpNeeded: number = 100;
    private _xpCurveBase: number = 100;
    private _xpCurveExponent: number = 1.5;

    // ─── Passive Modification Coefficients ─────────────────────────────
    public passiveDamageMod: number = 1.0;      // Multiplier to outgoing damage
    public passiveArmor: number = 0.0;          // Flat damage reduction
    public passiveCritChance: number = 0.05;    // 0.0 – 1.0
    public passiveCritDamage: number = 1.5;     // Multiplier on crit
    public passiveAttackSpeed: number = 1.0;    // Multiplier to attack cooldowns
    public passivePickupRadius: number = 1.0;   // Multiplier to XP/gold pickup range
    public passiveMaxHealthMod: number = 1.0;   // Multiplier to max health
    public passiveRegen: number = 0.0;          // Health per second

    // ─── Lifecycle Hooks ───────────────────────────────────────────────
    private _onLevelUpCallbacks: Array<(newLevel: number) => void> = [];
    private _onDeathCallbacks: Array<() => void> = [];
    private _onXPGainCallbacks: Array<(amount: number, total: number) => void> = [];

    // ─── Internal Flags ──────────────────────────────────────────────
    private _isAlive: boolean = true;
    private _isPaused: boolean = false;
    private _disposeObserver: any = null;

    /**
     * @param scene      The active Babylon.js scene.
     * @param camera     The isometric camera to track the player.
     * @param startPos   Initial world-space position for the player.
     */
    constructor(scene: Scene, camera: any, startPos: Vector3 = Vector3.Zero()) {
        this._scene = scene;
        this._camera = camera;

        // ── Build invisible collision capsule ───────────────────────────
        this.body = MeshBuilder.CreateCapsule(
            "player_body",
            {
                height: 2.0,
                radius: 0.5,
                tessellation: 8,
                subdivisions: 4,
            },
            scene
        );
        this.body.position = startPos.clone();
        this.body.isVisible = false;           // Invisible logical body
        this.body.isPickable = false;          // No raycast picking
        this.body.checkCollisions = true;      // Enable collision detection
        this.body.ellipsoid = new Vector3(0.5, 1.0, 0.5);
        this.body.ellipsoidOffset = new Vector3(0, 1.0, 0);

        // ── Wire up keyboard input ──────────────────────────────────
        this._bindKeyboardInput();

        // ── Register per-frame update loop ────────────────────────────
        this._disposeObserver = scene.onBeforeRenderObservable.add(() => {
            this._update();
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — State Accessors
    // ═══════════════════════════════════════════════════════════════════

    /** Current world-space position of the player. */
    public get position(): Vector3 {
        return this.body.position.clone();
    }

    public set position(value: Vector3) {
        this.body.position.copyFrom(value);
    }

    /** Whether the player is currently pressing any movement key. */
    public get isMoving(): boolean {
        return this._isMoving;
    }

    /** Whether the player is alive. */
    public get isAlive(): boolean {
        return this._isAlive;
    }

    /** Base movement speed (units per second). */
    public get baseSpeed(): number {
        return this._baseSpeed;
    }

    public set baseSpeed(value: number) {
        this._baseSpeed = Math.max(0, value);
    }

    /** Dynamic multiplier applied to baseSpeed every frame. */
    public get moveSpeedMultiplier(): number {
        return this._moveSpeedMultiplier;
    }

    public set moveSpeedMultiplier(value: number) {
        this._moveSpeedMultiplier = Math.max(0, value);
    }

    /** Effective speed = baseSpeed * moveSpeedMultiplier. */
    public get effectiveSpeed(): number {
        return this._baseSpeed * this._moveSpeedMultiplier;
    }

    /** Normalized movement direction from last frame's input. */
    public get movementDirection(): Vector3 {
        return this._inputDirection.clone();
    }

    /** Capture a complete snapshot of all player stats. */
    public getStatsSnapshot(): PlayerStatsSnapshot {
        return {
            health: this.health,
            maxHealth: this.maxHealth,
            playerLevel: this.playerLevel,
            playerXP: this.playerXP,
            xpNeeded: this.xpNeeded,
            baseSpeed: this._baseSpeed,
            moveSpeedMultiplier: this._moveSpeedMultiplier,
            passiveDamageMod: this.passiveDamageMod,
            passiveArmor: this.passiveArmor,
            passiveCritChance: this.passiveCritChance,
            passiveCritDamage: this.passiveCritDamage,
            passiveAttackSpeed: this.passiveAttackSpeed,
            passivePickupRadius: this.passivePickupRadius,
            passiveMaxHealthMod: this.passiveMaxHealthMod,
            passiveRegen: this.passiveRegen,
        };
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — Health & Damage
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Apply incoming damage, reduced by passiveArmor.
     * Triggers death callbacks if health drops to 0.
     */
    public takeDamage(amount: number): void {
        if (!this._isAlive || this._isPaused) return;

        const actualDamage = Math.max(0, amount - this.passiveArmor);
        this.health = Math.max(0, this.health - actualDamage);

        if (this.health <= 0) {
            this._die();
        }
    }

    /** Heal the player, clamped to maxHealth. */
    public heal(amount: number): void {
        if (!this._isAlive) return;
        this.health = Math.min(this.maxHealth, this.health + amount);
    }

    /** Restore health to full. */
    public fullHeal(): void {
        this.health = this.maxHealth;
    }

    /** Recalculate max health from base + passive modifier. Call after modifier changes. */
    public recalcMaxHealth(baseMax: number = 100): void {
        const oldMax = this.maxHealth;
        this.maxHealth = baseMax * this.passiveMaxHealthMod;
        // Preserve health percentage when max changes
        const ratio = oldMax > 0 ? this.health / oldMax : 1;
        this.health = Math.min(this.maxHealth, this.health + (this.maxHealth - oldMax) * ratio);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — XP & Leveling
    // ═══════════════════════════════════════════════════════════════════

    /** Award XP. Handles level-ups and overflow XP automatically. */
    public gainXP(amount: number): void {
        if (!this._isAlive || amount <= 0) return;

        this.playerXP += amount;
        this._onXPGainCallbacks.forEach((cb) => cb(amount, this.playerXP));

        // Handle multiple level-ups from large XP dumps
        while (this.playerXP >= this.xpNeeded) {
            this.playerXP -= this.xpNeeded;
            this._levelUp();
        }
    }

    /** Force-set the XP requirement for the next level. */
    public setXPNeeded(value: number): void {
        this.xpNeeded = Math.max(1, value);
    }

    /** Recalculate xpNeeded based on the exponential curve. */
    public recalcXPNeeded(): void {
        this.xpNeeded = Math.floor(
            this._xpCurveBase * Math.pow(this.playerLevel, this._xpCurveExponent)
        );
    }

    /** Progress toward next level as a 0.0–1.0 ratio. */
    public get levelProgress(): number {
        return Math.min(1, this.playerXP / this.xpNeeded);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — Passive Modifiers
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Apply a batch of passive modifier changes.
     * @param mods Partial object of modifiers to add (can be negative).
     */
    public applyPassiveMods(mods: Partial<Omit<PlayerStatsSnapshot, "health" | "maxHealth" | "playerLevel" | "playerXP" | "xpNeeded">>): void {
        if (mods.passiveDamageMod !== undefined) this.passiveDamageMod += mods.passiveDamageMod;
        if (mods.passiveArmor !== undefined) this.passiveArmor += mods.passiveArmor;
        if (mods.passiveCritChance !== undefined) this.passiveCritChance = Math.max(0, Math.min(1, this.passiveCritChance + mods.passiveCritChance));
        if (mods.passiveCritDamage !== undefined) this.passiveCritDamage += mods.passiveCritDamage;
        if (mods.passiveAttackSpeed !== undefined) this.passiveAttackSpeed += mods.passiveAttackSpeed;
        if (mods.passivePickupRadius !== undefined) this.passivePickupRadius += mods.passivePickupRadius;
        if (mods.passiveMaxHealthMod !== undefined) {
            this.passiveMaxHealthMod += mods.passiveMaxHealthMod;
            this.recalcMaxHealth();
        }
        if (mods.passiveRegen !== undefined) this.passiveRegen += mods.passiveRegen;
        if (mods.baseSpeed !== undefined) this.baseSpeed += mods.baseSpeed;
        if (mods.moveSpeedMultiplier !== undefined) this.moveSpeedMultiplier += mods.moveSpeedMultiplier;
    }

    /** Reset all passive modifiers to their base values. */
    public resetPassives(): void {
        this.passiveDamageMod = 1.0;
        this.passiveArmor = 0.0;
        this.passiveCritChance = 0.05;
        this.passiveCritDamage = 1.5;
        this.passiveAttackSpeed = 1.0;
        this.passivePickupRadius = 1.0;
        this.passiveMaxHealthMod = 1.0;
        this.passiveRegen = 0.0;
        this.recalcMaxHealth();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PUBLIC API — Lifecycle & Control
    // ═══════════════════════════════════════════════════════════════════

    /** Pause movement and regen processing. Input is still captured. */
    public pause(): void {
        this._isPaused = true;
        this._velocity = Vector3.Zero();
        this._inputDirection = Vector3.Zero();
        this._isMoving = false;
    }

    /** Resume normal update processing. */
    public resume(): void {
        this._isPaused = false;
    }

    /** Teleport the player to a new position instantly. */
    public teleport(position: Vector3): void {
        this.body.position.copyFrom(position);
        this._snapCameraToPlayer();
    }

    /** Register a callback invoked on level-up. */
    public onLevelUp(callback: (newLevel: number) => void): void {
        this._onLevelUpCallbacks.push(callback);
    }

    /** Register a callback invoked on player death. */
    public onDeath(callback: () => void): void {
        this._onDeathCallbacks.push(callback);
    }

    /** Register a callback invoked whenever XP is gained. */
    public onXPGain(callback: (amount: number, total: number) => void): void {
        this._onXPGainCallbacks.push(callback);
    }

    /** Full cleanup — removes observers and disposes the capsule mesh. */
    public dispose(): void {
        if (this._disposeObserver) {
            this._scene.onBeforeRenderObservable.remove(this._disposeObserver);
            this._disposeObserver = null;
        }
        this._unbindKeyboardInput();
        this.body.dispose();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PRIVATE — Input Binding
    // ═══════════════════════════════════════════════════════════════════

    private _bindKeyboardInput(): void {
        const actionManager = new ActionManager(this._scene);
        this._scene.actionManager = actionManager;

        // Key Down
        actionManager.registerAction(
            new ExecuteCodeAction(ActionManager.OnKeyDownTrigger, (evt) => {
                const key = evt.sourceEvent.key.toLowerCase();
                this._keysPressed.add(key);
                this._inputMap.set(key, true);
            })
        );

        // Key Up
        actionManager.registerAction(
            new ExecuteCodeAction(ActionManager.OnKeyUpTrigger, (evt) => {
                const key = evt.sourceEvent.key.toLowerCase();
                this._keysPressed.delete(key);
                this._inputMap.set(key, false);
            })
        );
    }

    private _unbindKeyboardInput(): void {
        // Babylon's ActionManager cleans up with the scene;
        // we just clear our local tracking.
        this._keysPressed.clear();
        this._inputMap.clear();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PRIVATE — Per-Frame Update
    // ═══════════════════════════════════════════════════════════════════

    private _update(): void {
        if (!this._isAlive || this._isPaused) return;

        const deltaTime = this._scene.getEngine().getDeltaTime() / 1000;

        // 1. Resolve input → normalized direction vector
        this._resolveInputDirection();

        // 2. Apply movement
        this._applyMovement(deltaTime);

        // 3. Regenerate health passively
        this._applyRegen(deltaTime);

        // 4. Sync camera to player
        this._updateCamera(deltaTime);
    }

    /**
     * High-frequency keyboard resolution.
     * Monitors WASD and Arrow Keys every frame, collapsing them into a
     * single normalized Vector3 movement direction.
     */
    private _resolveInputDirection(): void {
        let x = 0;
        let z = 0;

        // W / Up Arrow
        if (this._inputMap.get("w") || this._inputMap.get("arrowup")) {
            z += 1;
        }
        // S / Down Arrow
        if (this._inputMap.get("s") || this._inputMap.get("arrowdown")) {
            z -= 1;
        }
        // A / Left Arrow
        if (this._inputMap.get("a") || this._inputMap.get("arrowleft")) {
            x -= 1;
        }
        // D / Right Arrow
        if (this._inputMap.get("d") || this._inputMap.get("arrowright")) {
            x += 1;
        }

        if (x !== 0 || z !== 0) {
            this._inputDirection.set(x, 0, z);
            this._inputDirection.normalize();
            this._isMoving = true;
        } else {
            this._inputDirection.setAll(0);
            this._isMoving = false;
        }
    }

    /**
     * Smoothly move the capsule body along the resolved direction.
     * Uses moveWithCollisions for world collision awareness.
     */
    private _applyMovement(deltaTime: number): void {
        if (!this._isMoving) {
            this._velocity.scaleInPlace(0.85); // Quick decay when no input
            if (this._velocity.length() < 0.01) {
                this._velocity.setAll(0);
            }
            return;
        }

        const speed = this.effectiveSpeed;
        const targetVelocity = this._inputDirection.scale(speed);

        // Smooth velocity interpolation (light inertia feel)
        this._velocity = Vector3.Lerp(this._velocity, targetVelocity, 0.25);

        // Compute frame displacement
        const displacement = this._velocity.scale(deltaTime);

        // Move with collision detection
        this.body.moveWithCollisions(displacement);
    }

    /** Passive health regeneration per second. */
    private _applyRegen(deltaTime: number): void {
        if (this.passiveRegen > 0 && this.health < this.maxHealth) {
            this.health = Math.min(
                this.maxHealth,
                this.health + this.passiveRegen * deltaTime
            );
        }
    }

    /**
     * Smoothly update the isometric camera to maintain a locked offset
     * behind/above the player.
     */
    private _updateCamera(_deltaTime: number): void {
        if (!this._camera) return;

        const targetPos = this.body.position.add(this._cameraOffset);

        // Lerp camera position for smooth follow
        this._camera.position = Vector3.Lerp(
            this._camera.position,
            targetPos,
            this._cameraLerpFactor
        );

        // Always look at the player
        this._camera.setTarget(this.body.position);
    }

    /** Instant camera snap — used after teleport. */
    private _snapCameraToPlayer(): void {
        if (!this._camera) return;
        this._camera.position = this.body.position.add(this._cameraOffset);
        this._camera.setTarget(this.body.position.clone());
    }

    // ═══════════════════════════════════════════════════════════════════
    //  PRIVATE — Leveling & Death
    // ═══════════════════════════════════════════════════════════════════

    private _levelUp(): void {
        this.playerLevel += 1;
        this.recalcXPNeeded();

        // Slight passive bonuses on level-up
        this.maxHealth += 10;
        this.health = this.maxHealth; // Full heal on level-up

        this._onLevelUpCallbacks.forEach((cb) => cb(this.playerLevel));
    }

    private _die(): void {
        this._isAlive = false;
        this._velocity.setAll(0);
        this._inputDirection.setAll(0);
        this._isMoving = false;
        this._onDeathCallbacks.forEach((cb) => cb());
    }
}
