import type { Vector3D } from '@hard-vtt/shared';

export class VectorMath {
    public static distance(v1: Vector3D, v2: Vector3D): number {
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const dz = (v2.z ?? 0) - (v1.z ?? 0);
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    public static magnitude(v: Vector3D): number {
        return Math.sqrt(v.x * v.x + v.y * v.y + (v.z ?? 0) * (v.z ?? 0));
    }

    public static normalize(v: Vector3D): Vector3D {
        const mag = VectorMath.magnitude(v);
        if (mag === 0) return { x: 0, y: 0, z: 0 };
        return { x: v.x / mag, y: v.y / mag, z: (v.z ?? 0) / mag };
    }

    public static direction(from: Vector3D, to: Vector3D): Vector3D {
        return {
            x: to.x - from.x,
            y: to.y - from.y,
            z: (to.z ?? 0) - (from.z ?? 0)
        };
    }

    public static stepTowards(current: Vector3D, target: Vector3D, stepSize: number): Vector3D {
        const dist = VectorMath.distance(current, target);
        if (dist <= stepSize) {
            return { x: target.x, y: target.y, z: target.z ?? 0 };
        }
        const dir = VectorMath.normalize(VectorMath.direction(current, target));
        return {
            x: current.x + dir.x * stepSize,
            y: current.y + dir.y * stepSize,
            z: (current.z ?? 0) + (dir.z ?? 0) * stepSize
        };
    }

    public static add(v1: Vector3D, v2: Vector3D): Vector3D {
        return {
            x: v1.x + v2.x,
            y: v1.y + v2.y,
            z: (v1.z ?? 0) + (v2.z ?? 0)
        };
    }

    public static subtract(v1: Vector3D, v2: Vector3D): Vector3D {
        return {
            x: v1.x - v2.x,
            y: v1.y - v2.y,
            z: (v1.z ?? 0) - (v2.z ?? 0)
        };
    }

    public static scale(v: Vector3D, scalar: number): Vector3D {
        return {
            x: v.x * scalar,
            y: v.y * scalar,
            z: (v.z ?? 0) * scalar
        };
    }
}
