import * as BABYLON from "@babylonjs/core";

/**
 * EngineCore.ts
 * Isolated Babylon.js engine initialization with WebGPU primary / WebGL2 fallback.
 * Handles scene fog, isometric tracking camera, render loop, and lifecycle.
 */

export interface EngineCoreConfig {
  canvas: HTMLCanvasElement;
  cameraTarget?: BABYLON.Vector3;
}

export interface EngineCoreInstance {
  engine: BABYLON.Engine;
  scene: BABYLON.Scene;
  camera: BABYLON.UniversalCamera;
  dispose: () => void;
}

/** Global pause state checked every frame. */
export let isPaused = false;

/** Set the global pause state. */
export function setPaused(value: boolean): void {
  isPaused = value;
}

/** Get the global pause state. */
export function getPaused(): boolean {
  return isPaused;
}

/**
 * Creates the engine with WebGPU as primary and WebGL2 fallback.
 */
async function createEngine(canvas: HTMLCanvasElement): Promise<BABYLON.Engine> {
  const options: BABYLON.EngineOptions = {
    adaptToDeviceRatio: true,
    antialias: true,
    preserveDrawingBuffer: false,
    stencil: true,
  };

  // EngineFactory tries WebGPU first, then falls back to WebGL2 automatically.
  const engine = await BABYLON.EngineFactory.CreateAsync(canvas, options);

  console.log(`EngineCore: Using ${engine.name}`);
  return engine;
}

/**
 * Configures the dark-fantasy scene environment.
 */
function createScene(engine: BABYLON.Engine): BABYLON.Scene {
  const scene = new BABYLON.Scene(engine);

  // Near pitch-black clear color
  const clearColor = new BABYLON.Color3(0.02, 0.02, 0.03);
  scene.clearColor = clearColor.toColor4(1.0);
  scene.ambientColor = new BABYLON.Color3(0.1, 0.1, 0.15);

  // Exponential squared fog for gothic darkness fade
  scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
  scene.fogDensity = 0.09;
  scene.fogColor = clearColor.clone();

  // Performance optimizations
  scene.autoClear = true;
  scene.autoClearDepthAndStencil = true;

  return scene;
}

/**
 * Creates a fixed isometric tracking camera.
 */
function createCamera(
  scene: BABYLON.Scene,
  target: BABYLON.Vector3 = BABYLON.Vector3.Zero()
): BABYLON.UniversalCamera {
  const position = new BABYLON.Vector3(0, 15, -11);
  const camera = new BABYLON.UniversalCamera("IsometricCamera", position, scene);

  // Lock camera to look at the target (tracking behavior)
  camera.lockedTarget = target;

  // Isometric-friendly settings
  camera.fov = 0.8; // Narrower FOV reduces perspective distortion
  camera.minZ = 0.1;
  camera.maxZ = 1000;

  // Inputs are disabled to keep it fixed; movement is handled externally if needed
  camera.inputs.clear();

  return camera;
}

/**
 * Sets up the master render loop and window resize listeners.
 */
function setupLifecycle(engine: BABYLON.Engine, scene: BABYLON.Scene): () => void {
  // Render loop
  engine.runRenderLoop(() => {
    if (!isPaused) {
      scene.render();
    }
  });

  // Resize handler
  const onResize = () => {
    engine.resize();
  };
  window.addEventListener("resize", onResize);

  // Visibility API pause (optional but good for tab switching)
  const onVisibilityChange = () => {
    isPaused = document.hidden;
  };
  document.addEventListener("visibilitychange", onVisibilityChange);

  // Dispose function
  return () => {
    window.removeEventListener("resize", onResize);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    engine.dispose();
  };
}

/**
 * Initializes the complete engine core.
 */
export async function initEngineCore(config: EngineCoreConfig): Promise<EngineCoreInstance> {
  const { canvas, cameraTarget = BABYLON.Vector3.Zero() } = config;

  const engine = await createEngine(canvas);
  const scene = createScene(engine);
  const camera = createCamera(scene, cameraTarget);
  const dispose = setupLifecycle(engine, scene);

  return { engine, scene, camera, dispose };
}
