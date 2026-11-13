import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  DIE_SIDES,
  damageFaces,
} from "../plugins/systems/dnd5.5e/ui/board-math.ts";
import {
  d10Polygons,
  restingFrame,
  restingTurn,
  shapeOf,
} from "../plugins/systems/dnd5.5e/ui/dice-shapes.ts";

describe("the 3D dice", () => {
  it("has as many faces as sides, each numbered once", () => {
    for (const sides of DIE_SIDES) {
      const shape = shapeOf(sides);
      expect(shape.faces).toHaveLength(sides);
      expect([...shape.tops.keys()].sort((a, b) => a - b)).toEqual(
        Array.from({ length: sides }, (_, i) => i + 1),
      );
    }
  });

  it("keeps each of a d10's kites flat", () => {
    for (const kite of d10Polygons()) {
      const [a, b, c, d] = kite as [Vector3, Vector3, Vector3, Vector3];
      const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
      expect(Math.abs(d.clone().sub(a).dot(normal))).toBeLessThan(1e-9);
    }
  });

  it("comes to rest with every number up and upright", () => {
    for (const sides of DIE_SIDES) {
      const shape = shapeOf(sides);
      const { view: VIEW_UP, up: SCREEN_UP } = restingFrame(shape.tilt);
      for (let value = 1; value <= sides; value += 1) {
        const turn = restingTurn(shape, value);
        const top = shape.tops.get(value);
        if (!top) throw new Error(`d${String(sides)} has no ${String(value)}`);
        const normal = top.normal.clone().applyQuaternion(turn);
        const up = top.up.clone().applyQuaternion(turn);
        expect(normal.distanceTo(VIEW_UP)).toBeLessThan(1e-6);
        expect(up.distanceTo(SCREEN_UP)).toBeLessThan(1e-6);
        // And no other face (or a d4's other corner) faces up more.
        const facing = (v: Vector3): number =>
          v.clone().applyQuaternion(turn).dot(VIEW_UP);
        if (sides === 4) continue;
        const best = shape.faces.reduce((a, b) =>
          facing(a.normal) >= facing(b.normal) ? a : b,
        );
        expect(best.labels[0]?.text).toBe(String(value));
      }
    }
  });

  it("prints a d4's number at the corner that ends up on top", () => {
    const shape = shapeOf(4);
    const VIEW_UP = restingFrame(shape.tilt).view;
    for (let value = 1; value <= 4; value += 1) {
      const turn = restingTurn(shape, value);
      const corners = shape.faces.flatMap((face) =>
        face.corners.map((corner, k) => ({
          corner,
          text: face.labels[k]?.text,
        })),
      );
      const top = corners.reduce((a, b) =>
        a.corner.clone().applyQuaternion(turn).dot(VIEW_UP) >=
        b.corner.clone().applyQuaternion(turn).dot(VIEW_UP)
          ? a
          : b,
      );
      expect(top.text).toBe(String(value));
    }
  });
});

describe("the damage dice's faces", () => {
  const random = (): number => 0.37;

  it("adds up to the damage less the bonus, each face on its die", () => {
    const faces = damageFaces("2d6+1d4+3", 14, false, random);
    expect(faces.map((f) => f.sides)).toEqual([6, 6, 4]);
    expect(faces.reduce((sum, f) => sum + f.value, 0)).toBe(11);
    for (const face of faces) {
      expect(face.value).toBeGreaterThanOrEqual(1);
      expect(face.value).toBeLessThanOrEqual(face.sides);
    }
  });

  it("doubles the dice on a critical hit and reads a negative bonus", () => {
    const faces = damageFaces("1d8-1", 9, true, random);
    expect(faces).toHaveLength(2);
    expect(faces.reduce((sum, f) => sum + f.value, 0)).toBe(10);
  });

  it("stays on the dice when the damage can't fit them", () => {
    expect(damageFaces("1d6+2", 1, false, random).map((f) => f.value)).toEqual([
      1,
    ]);
    expect(damageFaces("1d6", 40, false, random).map((f) => f.value)).toEqual([
      6,
    ]);
    expect(damageFaces("7", 7, false, random)).toEqual([]);
  });
});
