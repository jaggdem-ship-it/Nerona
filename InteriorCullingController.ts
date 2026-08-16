import {
    Scene,
    Vector3,
    AbstractMesh,
    Mesh,
    Observer,
    Nullable,
    Node,
} from "@babylonjs/core";

interface BuildingZone {
    id: string;
    bounds: { min: Vector3; max: Vector3 };
    roofAssembly: AbstractMesh[];
    interiorProps: AbstractMesh[];
    linkedOutdoorClutter: AbstractMesh[];
}

interface FadeState {
    currentAlpha: number;
    targetAlpha: number;
    fadeStartTime: number;
    durationMs: number;
    meshes: AbstractMesh[];
    controlsVisibility: boolean;
}

interface InteriorCullingOptions {
    fadeDurationSeconds: number;
    outdoorClutterMaskAlpha: number;
    easing: (t: number) => number;
}

const DEFAULT_OPTIONS: InteriorCullingOptions = {
    fadeDurationSeconds: 0.3,
    outdoorClutterMaskAlpha: 0.15,
    easing: (t: number) => 1 - Math.pow(1 - t, 3),
};

export class InteriorCullingController {
    private readonly scene: Scene;
    private readonly options: InteriorCullingOptions;
    private zones: Map<string, BuildingZone> = new Map();
    private activeZoneId: Nullable<string> = null;
    private renderObserver: Nullable<Observer<Scene>> = null;
    private activeFades: Map<string, FadeState> = new Map();
    private globalOutdoorClutter: Set<AbstractMesh> = new Set();
    private playerNode: Nullable<Node> = null;
    private readonly _tempPosition: Vector3 = new Vector3(0, 0, 0);

    constructor(scene: Scene, options?: Partial<InteriorCullingOptions>) {
        this.scene = scene;
        this.options = { ...DEFAULT_OPTIONS, ...options };
        this.renderObserver = scene.registerBeforeRender(() => this._onBeforeRender());
    }

    public trackPlayer(node: Node): void {
        this.playerNode = node;
    }

    public registerZone(
        id: string,
        minBounds: Vector3,
        maxBounds: Vector3,
        roofAssembly: AbstractMesh[],
        interiorProps: AbstractMesh[],
        linkedOutdoorClutter?: AbstractMesh[]
    ): void {
        if (this.zones.has(id)) {
            console.warn(`[InteriorCullingController] Zone "${id}" already registered. Overwriting.`);
            this._disposeFadeForZone(id);
        }

        roofAssembly.forEach((mesh) => {
            mesh.visibility = 1.0;
            this._ensureAlphaBlend(mesh);
        });

        interiorProps.forEach((mesh) => {
            mesh.visibility = 0.0;
            mesh.setEnabled(false);
            this._ensureAlphaBlend(mesh);
        });

        const zone: BuildingZone = {
            id,
            bounds: { min: minBounds.clone(), max: maxBounds.clone() },
            roofAssembly,
            interiorProps,
            linkedOutdoorClutter: linkedOutdoorClutter ?? [],
        };

        this.zones.set(id, zone);
    }

    public unregisterZone(id: string): void {
        const zone = this.zones.get(id);
        if (!zone) return;

        this._disposeFadeForZone(id);

        zone.roofAssembly.forEach((m) => {
            m.visibility = 1.0;
            m.setEnabled(true);
        });
        zone.interiorProps.forEach((m) => {
            m.visibility = 0.0;
            m.setEnabled(false);
        });

        if (this.activeZoneId === id) {
            this.activeZoneId = null;
            this._restoreGlobalOutdoorClutter();
        }

        this.zones.delete(id);
    }

    public registerGlobalOutdoorClutter(mesh: AbstractMesh): void {
        this.globalOutdoorClutter.add(mesh);
        this._ensureAlphaBlend(mesh);
    }

    public unregisterGlobalOutdoorClutter(mesh: AbstractMesh): void {
        this.globalOutdoorClutter.delete(mesh);
        mesh.visibility = 1.0;
    }

    public dispose(): void {
        if (this.renderObserver) {
            this.scene.unregisterBeforeRender(this.renderObserver);
            this.renderObserver = null;
        }
        this.activeFades.clear();
        this.zones.clear();
        this.globalOutdoorClutter.clear();
        this.activeZoneId = null;
        this.playerNode = null;
    }

    private _onBeforeRender(): void {
        if (!this.playerNode) return;
        this.playerNode.getAbsolutePositionToRef(this._tempPosition);
        const containingZoneId = this._resolveContainingZone(this._tempPosition);

        if (containingZoneId !== this.activeZoneId) {
            if (containingZoneId) {
                this._enterZone(containingZoneId);
            } else {
                this._exitActiveZone();
            }
        }
        this._updateActiveFades();
    }

    private _resolveContainingZone(position: Vector3): Nullable<string> {
        for (const [id, zone] of this.zones) {
            if (this._pointInBounds(position, zone.bounds.min, zone.bounds.max)) {
                return id;
            }
        }
        return null;
    }

    private _pointInBounds(p: Vector3, min: Vector3, max: Vector3): boolean {
        return (
            p.x >= min.x && p.x <= max.x &&
            p.y >= min.y && p.y <= max.y &&
            p.z >= min.z && p.z <= max.z
        );
    }

    private _enterZone(zoneId: string): void {
        const zone = this.zones.get(zoneId);
        if (!zone) return;

        const previousZoneId = this.activeZoneId;
        this.activeZoneId = zoneId;

        this._startFade(`roof_${zoneId}`, zone.roofAssembly, 0.0, true);
        zone.interiorProps.forEach((m) => m.setEnabled(true));
        this._startFade(`props_${zoneId}`, zone.interiorProps, 1.0, false);

        if (zone.linkedOutdoorClutter.length > 0) {
            this._startFade(
                `clutter_local_${zoneId}`,
                zone.linkedOutdoorClutter,
                this.options.outdoorClutterMaskAlpha,
                false
            );
        }

        this._startFade(
            `clutter_global`,
            Array.from(this.globalOutdoorClutter),
            this.options.outdoorClutterMaskAlpha,
            false
        );

        if (previousZoneId) {
            this._exitZone(previousZoneId);
        }
    }

    private _exitActiveZone(): void {
        const zoneId = this.activeZoneId;
        if (!zoneId) return;
        this.activeZoneId = null;
        this._exitZone(zoneId);
        this._restoreGlobalOutdoorClutter();
    }

    private _exitZone(zoneId: string): void {
        const zone = this.zones.get(zoneId);
        if (!zone) return;
        this._startFade(`roof_${zoneId}`, zone.roofAssembly, 1.0, true);
        this._startFade(`props_${zoneId}`, zone.interiorProps, 0.0, true);

        if (zone.linkedOutdoorClutter.length > 0) {
            this._startFade(`clutter_local_${zoneId}`, zone.linkedOutdoorClutter, 1.0, false);
        }
    }

    private _restoreGlobalOutdoorClutter(): void {
        this._startFade(`clutter_global`, Array.from(this.globalOutdoorClutter), 1.0, false);
    }

    private _startFade(
        fadeId: string,
        meshes: AbstractMesh[],
        targetAlpha: number,
        disableOnComplete: boolean
    ): void {
        if (meshes.length === 0) return;
        this.activeFades.delete(fadeId);

        const currentAlphas = meshes.map((m) => (m.isEnabled() ? m.visibility : 0.0));

        const state: FadeState = {
            currentAlpha: currentAlphas[0],
            targetAlpha,
            fadeStartTime: performance.now(),
            durationMs: this.options.fadeDurationSeconds * 1000,
            meshes,
            controlsVisibility: disableOnComplete,
        };

        this.activeFades.set(fadeId, state);
    }

    private _updateActiveFades(): void {
        const now = performance.now();
        for (const [fadeId, state] of this.activeFades) {
            const elapsed = now - state.fadeStartTime;
            let t = Math.min(elapsed / state.durationMs, 1.0);
            t = this.options.easing(t);
            const alpha = this._lerp(state.currentAlpha, state.targetAlpha, t);

            for (const mesh of state.meshes) {
                if (!mesh.isDisposed()) {
                    mesh.visibility = alpha;
                }
            }

            if (t >= 1.0) {
                if (state.controlsVisibility && state.targetAlpha <= 0.0) {
                    for (const mesh of state.meshes) {
                        if (!mesh.isDisposed()) {
                            mesh.setEnabled(false);
                        }
                    }
                }
                this.activeFades.delete(fadeId);
            }
        }
    }

    private _disposeFadeForZone(zoneId: string): void {
        const keys = [`roof_${zoneId}`, `props_${zoneId}`, `clutter_local_${zoneId}`];
        for (const key of keys) {
            this.activeFades.delete(key);
        }
    }

    private _ensureAlphaBlend(mesh: AbstractMesh): void {
        if (mesh instanceof Mesh && mesh.material) {
            mesh.material.alpha = 1.0;
            mesh.material.transparencyMode = 2;
        }
        mesh.visibility = 1.0;
    }

    private _lerp(a: number, b: number, t: number): number {
        return a + (b - a) * t;
    }

    public getActiveZoneId(): Nullable<string> {
        return this.activeZoneId;
    }

    public getZoneCount(): number {
        return this.zones.size;
    }

    public getActiveFadeCount(): number {
        return this.activeFades.size;
    }
}
