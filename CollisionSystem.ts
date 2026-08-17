import { Scene, Vector3, Observer, Nullable } from "@babylonjs/core";

/**
 * Static prop types derived from the `decor_props.png` asset sheet.
 * Maps visual prop categories to their physical collision radii.
 * Extend this registry when new slices are added to the atlas.
 */
export enum PropType {
    PILLAR = "pillar",
    SPIKED_BARRICADE = "spiked_barricade",
    RUBBLE = "rubble",
    STATUE = "statue",
    CRATE = "crate",
    WALL_FRAGMENT = "wall_fragment"
}

/**
 * Collision radii in world units for each prop type.
 * Tuned to tightly fit the visual footprint of the sliced sprite.
 */
const PROP_COLLISION_RADIUS: Record<PropType, number> = {
    [PropType.PILLAR]: 0.55,
    [PropType.SPIKED_BARRICADE]: 1.15,
    [PropType.RUBBLE]: 0.75,
    [PropType.STATUE]: 0.65,
    [PropType.CRATE]: 0.45,
    [PropType.WALL_FRAGMENT]: 0.85
};

/**
 * Lightweight obstacle descriptor used in the hot collision loop.
 * Contains only scalar data—no mesh references—to guarantee cache-friendly iteration.
 */
interface ObstacleData {
    /** World-space X coordinate */
    x: number;
    /** World-space Z coordinate (Y in 3D space is ignored for 2.5D collision) */
    z: number;
    /** Collision radius in world units */
    radius: number;
    /** Prop classification for debugging and radius lookup */
    type: PropType;
    /** Whether this slot is actively participating in collision */
    active: boolean;
}

/**
 * High-precision static collision resolver optimized for hundreds of environment props.
 *
 * Design constraints:
 * - Zero mesh-to-mesh bounding-box tests; pure scalar distance-squared checks.
 * - Zero Vector3 allocations inside the per-frame hot loop.
 * - Hooks into Babylon's `onBeforeRenderObservable` for deterministic, frame-synced resolution.
 * - Handles position correction and velocity dampening only; no gameplay logic.
 */
export class CollisionResolver {
    private readonly scene: Scene;

    /** Circular buffer of obstacle slots to avoid GC churn in dynamic environments */
    private obstaclePool: ObstacleData[] = [];
    /** Number of currently active obstacles */
    private activeObstacleCount = 0;

    /** Mutable reference to the player's world position (updated in-place) */
    private playerPosition: Vector3;
    /** Mutable reference to the player's velocity vector (updated in-place) */
    private playerVelocity: Vector3;
    /** Player collision radius in world units */
    private playerRadius: number;

    /** Babylon render-loop observer handle */
    private renderObserver: Nullable<Observer<Scene>> = null;

    // ─── Tunable constants ───
    /** Tiny epsilon added to penetration resolution to prevent numerical sticking */
    private readonly SKIN_WIDTH = 0.005;
    /**
     * Velocity dampening factor applied on collision (0.0 = full stop, 1.0 = no friction).
     * A value of 0.85 gives a subtle 'heavy impact' feel without feeling sticky.
     */
    private readonly IMPACT_DAMPENING = 0.85;
    /**
     * Maximum penetration depth allowed per frame before clamping.
     * Guards against tunneling when delta-time spikes.
     */
    private readonly MAX_PENETRATION = 2.0;

    /**
     * @param scene - Active Babylon scene.
     * @param playerPosition - Reference to the player's world position vector (mutated).
     * @param playerVelocity - Reference to the player's velocity vector (mutated).
     * @param playerRadius - Circular collision footprint of the player (default 0.4).
     */
    constructor(
        scene: Scene,
        playerPosition: Vector3,
        playerVelocity: Vector3,
        playerRadius = 0.4
    ) {
        this.scene = scene;
        this.playerPosition = playerPosition;
        this.playerVelocity = playerVelocity;
        this.playerRadius = playerRadius;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    //  PUBLIC API — Obstacle management
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Register a single obstacle from raw parameters.
     * Use for procedurally placed or manually tuned props.
     */
    public registerObstacle(position: Vector3, radius: number, type: PropType = PropType.RUBBLE): void {
        const slot = this.acquireSlot();
        slot.x = position.x;
        slot.z = position.z;
        slot.radius = radius;
        slot.type = type;
        slot.active = true;
        this.activeObstacleCount++;
    }

    /**
     * Batch-register obstacles from level data.
     * Prefer this over repeated `registerObstacle` calls to minimize pool churn.
     */
    public loadObstacleBatch(definitions: Array<{ position: Vector3; radius: number; type: PropType }>): void {
        // Pre-grow pool if necessary to avoid mid-loop resizing
        const required = this.activeObstacleCount + definitions.length;
        while (this.obstaclePool.length < required) {
            this.obstaclePool.push(this.createSlot());
        }

        for (const def of definitions) {
            const slot = this.obstaclePool[this.activeObstacleCount];
            slot.x = def.position.x;
            slot.z = def.position.z;
            slot.radius = def.radius;
            slot.type = def.type;
            slot.active = true;
            this.activeObstacleCount++;
        }
    }

    /**
     * Convenience helper: register a prop using its atlas type and world position.
     * Automatically looks up the collision radius from `PROP_COLLISION_RADIUS`.
     *
     * Example (called from your level-builder after slicing `decor_props.png`):
     * ```ts
     * resolver.registerPropFromAtlas(PropType.PILLAR, new Vector3(10, 0, 5));
     * ```
     */
    public registerPropFromAtlas(type: PropType, position: Vector3): void {
        const radius = PROP_COLLISION_RADIUS[type] ?? 0.5;
        this.registerObstacle(position, radius, type);
    }

    /**
     * Remove all obstacles and reset the pool.
     * Call when switching levels or restarting a run.
     */
    public clearObstacles(): void {
        for (let i = 0; i < this.activeObstacleCount; i++) {
            this.obstaclePool[i].active = false;
        }
        this.activeObstacleCount = 0;
    }

    /**
     * Enable the per-frame collision resolver.
     * Idempotent—safe to call multiple times.
     */
    public enable(): void {
        if (this.renderObserver) return;

        this.renderObserver = this.scene.onBeforeRenderObservable.add(() => {
            this.resolveFrame();
        });
    }

    /**
     * Disable the per-frame collision resolver.
     * Idempotent—safe to call multiple times.
     */
    public disable(): void {
        if (!this.renderObserver) return;
        this.scene.onBeforeRenderObservable.remove(this.renderObserver);
        this.renderObserver = null;
    }

    /**
     * Permanently tear down the resolver and release pool memory.
     */
    public dispose(): void {
        this.disable();
        this.obstaclePool = [];
        this.activeObstacleCount = 0;
    }

    /**
     * Update the player radius at runtime (e.g., during a transformation buff).
     */
    public setPlayerRadius(radius: number): void {
        this.playerRadius = radius;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    //  INTERNALS — Hot loop (zero allocations, scalar arithmetic only)
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Core physics step executed every frame before rendering.
     *
     * Algorithm:
     * 1. Cache player position & radius locally (register pressure optimization).
     * 2. Iterate active obstacles; perform squared-distance rejection.
     * 3. On overlap, compute penetration depth and normalized collision normal.
     * 4. Correct player position instantly along the normal.
     * 5. Project velocity onto the tangent plane and dampen.
     */
    private resolveFrame(): void {
        const px = this.playerPosition.x;
        const pz = this.playerPosition.z;
        const pr = this.playerRadius;
        const prSq = pr * pr;

        let velX = this.playerVelocity.x;
        let velZ = this.playerVelocity.z;

        for (let i = 0; i < this.activeObstacleCount; i++) {
            const obs = this.obstaclePool[i];

            // ── Fast squared-distance rejection ──
            const dx = px - obs.x;
            const dz = pz - obs.z;
            const distSq = dx * dx + dz * dz;

            const combinedRadius = pr + obs.radius;
            const combinedRadiusSq = combinedRadius * combinedRadius;

            if (distSq >= combinedRadiusSq) continue; // No collision

            // ── Collision detected: compute exact penetration ──
            const dist = Math.sqrt(distSq);
            let penetration = combinedRadius - dist;

            // Clamp extreme penetrations (tunneling guard)
            if (penetration > this.MAX_PENETRATION) {
                penetration = this.MAX_PENETRATION;
            }

            // ── Collision normal (obstacle → player) ──
            let nx: number;
            let nz: number;

            if (dist > 1e-4) {
                nx = dx / dist;
                nz = dz / dist;
            } else {
                // Degenerate: player exactly at obstacle center; default to +Z push-out
                nx = 0;
                nz = 1;
            }

            // ── Positional correction: push player out of obstacle bounds ──
            const pushDistance = penetration + this.SKIN_WIDTH;
            this.playerPosition.x += nx * pushDistance;
            this.playerPosition.z += nz * pushDistance;

            // ── Velocity response: remove normal component + dampen ──
            const velDotNormal = velX * nx + velZ * nz;

            if (velDotNormal < 0) {
                // Player is moving toward the obstacle; strip the normal component
                velX -= velDotNormal * nx;
                velZ -= velDotNormal * nz;

                // Apply impact dampening to simulate friction/energy loss on slide.
                // We dampen the post-correction velocity to prevent 'wall skating'.
                velX *= this.IMPACT_DAMPENING;
                velZ *= this.IMPACT_DAMPENING;
            }
        }

        // Write back velocity (position was mutated in-place above)
        this.playerVelocity.x = velX;
        this.playerVelocity.z = velZ;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    //  OBJECT POOL — Minimal GC pressure for dynamic level streaming
    // ═══════════════════════════════════════════════════════════════════════════════

    private acquireSlot(): ObstacleData {
        if (this.activeObstacleCount < this.obstaclePool.length) {
            return this.obstaclePool[this.activeObstacleCount++];
        }
        const slot = this.createSlot();
        this.obstaclePool.push(slot);
        this.activeObstacleCount++;
        return slot;
    }

    private createSlot(): ObstacleData {
        return { x: 0, z: 0, radius: 0, type: PropType.RUBBLE, active: false };
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    //  DEBUG / INTROSPECTION
    // ═══════════════════════════════════════════════════════════════════════════════

    /** Number of active obstacles participating in collision. */
    public get activeCount(): number {
        return this.activeObstacleCount;
    }

    /** Get a read-only snapshot of active obstacle data for debug visualization. */
    public getActiveObstacles(): ReadonlyArray<Readonly<ObstacleData>> {
        return this.obstaclePool.slice(0, this.activeObstacleCount);
    }
}
