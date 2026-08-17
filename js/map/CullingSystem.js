export class CullingSystem {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;
        this.cullDistance = 60;
    }

    update(entities) {
        const camPos = this.camera.position;
        for (const e of entities) {
            if (!e.sprite && !e.mesh) continue;
            const pos = e.sprite ? e.sprite.position : e.mesh.position;
            const dx = pos.x - camPos.x;
            const dz = pos.z - camPos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            const visible = dist < this.cullDistance;
            if (e.sprite) e.sprite.isVisible = visible && e.alive !== false;
            if (e.mesh) e.mesh.isVisible = visible;
        }
    }

    cullProps(props) {
        const camPos = this.camera.position;
        for (const p of props) {
            if (!p.mesh) continue;
            const dx = p.x - camPos.x;
            const dz = p.z - camPos.z;
            p.mesh.isVisible = Math.sqrt(dx * dx + dz * dz) < this.cullDistance;
        }
    }
}
