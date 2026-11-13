import {
  BoxGeometry,
  BufferGeometry,
  DodecahedronGeometry,
  Float32BufferAttribute,
  IcosahedronGeometry,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  TetrahedronGeometry,
  Vector3,
} from "three";
import type { Sides } from "./board-math.ts";

// The dice as solids: their faces, the numbers printed on them, and how each one comes to rest with a
// given number up. No page here, so tests can check it.

// A number printed on a face, in the face's own frame: x right and y up, scaled so the farthest corner is 1.
export interface Label {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly angle: number; // clockwise from upright, in radians
  readonly mark: boolean; // underlined, so a 6 and a 9 can't be mistaken
}

export interface Face {
  readonly normal: Vector3;
  readonly up: Vector3; // in the face's plane, towards the top of its number
  readonly right: Vector3;
  readonly centre: Vector3;
  readonly radius: number;
  readonly corners: readonly Vector3[]; // anticlockwise, seen from outside
  readonly points: readonly (readonly [number, number])[]; // the corners in the face's frame
  readonly labels: readonly Label[];
}

export interface Shape {
  readonly sides: Sides;
  readonly faces: readonly Face[];
  readonly size: number; // how big it looks beside the others
  readonly font: number; // a number's height, as a share of a face's texture
  readonly tilt: number; // see restingFrame
  // For each number, the direction that turns to face up and the direction that turns to the top of the view.
  readonly tops: ReadonlyMap<
    number,
    { readonly normal: Vector3; readonly up: Vector3 }
  >;
}

// Where the face up points once a die rests, and where the top of its number points: at you, leaning
// `tilt` towards the top of the view so a little of the faces in front shows. A d6 and a d4 lean most:
// straight on, a d6 looks like a flat square and a d4 hides its numbers at its point.
export function restingFrame(tilt: number): { view: Vector3; up: Vector3 } {
  return {
    view: new Vector3(0, tilt, 1).normalize(),
    up: new Vector3(0, 1, -tilt).normalize(),
  };
}
// How much of a face's texture cell its corners reach, so neighbouring cells don't bleed in.
export const INSET = 0.94;

const SIZE: Record<Sides, number> = {
  4: 1.3,
  6: 1.15,
  8: 1.1,
  10: 1.05,
  12: 1,
  20: 1,
};
const TILT: Record<Sides, number> = {
  4: 0.5,
  6: 0.35,
  8: 0.12,
  10: 0.15,
  12: 0.12,
  20: 0.12,
};
const FONT: Record<Sides, number> = {
  4: 0.3,
  6: 0.5,
  8: 0.34,
  10: 0.32,
  12: 0.4,
  20: 0.3,
};

function average(points: readonly Vector3[]): Vector3 {
  const sum = new Vector3();
  for (const point of points) sum.add(point);
  return sum.divideScalar(points.length);
}

// The corners of one face, in order round its normal.
function inOrder(points: Vector3[], normal: Vector3): Vector3[] {
  const centre = average(points);
  const x = (points[0] ?? centre).clone().sub(centre).normalize();
  const y = normal.clone().cross(x);
  const angle = (point: Vector3): number => {
    const d = point.clone().sub(centre);
    return Math.atan2(d.dot(y), d.dot(x));
  };
  return points.sort((a, b) => angle(a) - angle(b));
}

// The flat faces of a solid, each from the triangles that share its plane.
function polygonsOf(geometry: BufferGeometry): Vector3[][] {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = flat.getAttribute("position");
  const groups: { normal: Vector3; points: Vector3[] }[] = [];
  for (let i = 0; i + 2 < position.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) =>
      new Vector3().fromBufferAttribute(position, i + k),
    ) as [Vector3, Vector3, Vector3];
    const normal = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    if (normal.dot(a) < 0) normal.negate();
    let group = groups.find((g) => g.normal.dot(normal) > 0.999);
    if (!group) {
      group = { normal, points: [] };
      groups.push(group);
    }
    for (const point of [a, b, c]) {
      if (!group.points.some((p) => p.distanceTo(point) < 1e-6)) {
        group.points.push(point);
      }
    }
  }
  return groups.map(({ normal, points }) => inOrder(points, normal));
}

// A d10's ten kites: two poles and a zigzag ring between them. The ring's height keeps each kite flat.
export function d10Polygons(): Vector3[][] {
  const tenth = Math.PI / 5;
  const ring = (1 - Math.cos(tenth)) / (1 + Math.cos(tenth));
  const top = new Vector3(0, 0, 1);
  const bottom = new Vector3(0, 0, -1);
  const upper = (k: number): Vector3 =>
    new Vector3(Math.cos(2 * k * tenth), Math.sin(2 * k * tenth), ring);
  const lower = (k: number): Vector3 =>
    new Vector3(
      Math.cos((2 * k + 1) * tenth),
      Math.sin((2 * k + 1) * tenth),
      -ring,
    );
  const kites: Vector3[][] = [];
  for (let k = 0; k < 5; k += 1) {
    kites.push([top, upper(k), lower(k), upper(k + 1)]);
    kites.push([bottom, lower(k), upper(k + 1), lower(k + 1)]);
  }
  return kites.map((kite) => {
    const normal = average(kite).normalize();
    return inOrder(
      kite.map((p) => p.clone()),
      normal,
    );
  });
}

function polygonsFor(sides: Sides): Vector3[][] {
  switch (sides) {
    case 4:
      return polygonsOf(new TetrahedronGeometry(1, 0));
    case 6:
      return polygonsOf(new BoxGeometry(1, 1, 1));
    case 8:
      return polygonsOf(new OctahedronGeometry(1, 0));
    case 10:
      return d10Polygons();
    case 12:
      return polygonsOf(new DodecahedronGeometry(1, 0));
    case 20:
      return polygonsOf(new IcosahedronGeometry(1, 0));
  }
}

// A face's frame, with its number's top towards its farthest corner (a d10's pole), or towards an edge on a d6.
function frameOf(
  sides: Sides,
  corners: Vector3[],
): Omit<Face, "labels" | "points"> & { points: [number, number][] } {
  const centre = average(corners);
  const a = corners[0] ?? centre;
  const b = corners[1] ?? centre;
  const normal = b.clone().sub(a).cross(centre.clone().sub(a)).normalize();
  let top = sides === 6 ? a.clone().add(b).multiplyScalar(0.5) : a;
  for (const corner of corners) {
    if (
      sides !== 6 &&
      corner.distanceTo(centre) > top.distanceTo(centre) + 1e-6
    ) {
      top = corner;
    }
  }
  const up = top.clone().sub(centre).normalize();
  const right = up.clone().cross(normal);
  const radius = Math.max(...corners.map((c) => c.distanceTo(centre)));
  const points = corners.map((c): [number, number] => {
    const d = c.clone().sub(centre);
    return [d.dot(right) / radius, d.dot(up) / radius];
  });
  return { normal, up, right, centre, radius, corners, points };
}

const shapes = new Map<Sides, Shape>();

export function shapeOf(sides: Sides): Shape {
  const known = shapes.get(sides);
  if (known) return known;
  const polygons = polygonsFor(sides);
  // Every die fits the same sphere, then SIZE evens out how big each looks.
  const reach = Math.max(...polygons.flat().map((p) => p.length()));
  const frames = polygons.map((corners) =>
    frameOf(
      sides,
      corners.map((c) => c.clone().divideScalar(reach)),
    ),
  );
  const tops = new Map<number, { normal: Vector3; up: Vector3 }>();
  const mark = (value: number): boolean =>
    sides >= 8 && (value === 6 || value === 9);
  let faces: Face[];
  if (sides === 4) {
    // A d4 reads at its top corner: each face prints the number of each of its corners, beside it.
    const corners: Vector3[] = [];
    for (const frame of frames) {
      for (const c of frame.corners) {
        if (!corners.some((k) => k.distanceTo(c) < 1e-6)) corners.push(c);
      }
    }
    const valueAt = (c: Vector3): number =>
      1 + corners.findIndex((k) => k.distanceTo(c) < 1e-6);
    corners.forEach((corner, i) => {
      const normal = corner.clone().normalize();
      const other = corners[(i + 1) % corners.length] ?? corner;
      // Another corner turns away from you, so the face across from it, which shows this number, faces you.
      const up = other
        .clone()
        .sub(normal.clone().multiplyScalar(other.dot(normal)))
        .normalize();
      tops.set(i + 1, { normal, up });
    });
    faces = frames.map((frame) => ({
      ...frame,
      labels: frame.corners.map((c, k) => {
        const [x, y] = frame.points[k] ?? [0, 0];
        const value = valueAt(c);
        return {
          text: String(value),
          x: x * 0.55,
          y: y * 0.55,
          angle: Math.atan2(x, y),
          mark: false,
        };
      }),
    }));
  } else {
    // Opposite faces add up to one more than the sides, as on a real die.
    const values: number[] = frames.map(() => 0);
    let next = 1;
    frames.forEach((frame, i) => {
      if (values[i]) return;
      values[i] = next;
      let across = i;
      frames.forEach((other, j) => {
        if (
          other.normal.dot(frame.normal) <
          (frames[across]?.normal.dot(frame.normal) ?? 1)
        ) {
          across = j;
        }
      });
      if (across !== i && !values[across]) values[across] = sides + 1 - next;
      next += 1;
    });
    faces = frames.map((frame, i) => {
      const value = values[i] ?? 0;
      tops.set(value, { normal: frame.normal, up: frame.up });
      return {
        ...frame,
        labels: [
          { text: String(value), x: 0, y: 0, angle: 0, mark: mark(value) },
        ],
      };
    });
  }
  const shape: Shape = {
    sides,
    faces,
    size: SIZE[sides],
    font: FONT[sides],
    tilt: TILT[sides],
    tops,
  };
  shapes.set(sides, shape);
  return shape;
}

// The turn that brings `value` to face up with its number upright. A value off the die rests as its nearest.
export function restingTurn(shape: Shape, value: number): Quaternion {
  const top =
    shape.tops.get(Math.min(shape.sides, Math.max(1, Math.round(value)))) ??
    shape.tops.get(1);
  if (!top) return new Quaternion();
  const from = new Matrix4().makeBasis(
    top.up.clone().cross(top.normal),
    top.up,
    top.normal,
  );
  const { view, up } = restingFrame(shape.tilt);
  const to = new Matrix4().makeBasis(up.clone().cross(view), up, view);
  return new Quaternion().setFromRotationMatrix(to.multiply(from.transpose()));
}

// Where a face's point lands in its cell of a texture laid out `columns` wide and `rows` high.
export function cellPoint(
  index: number,
  columns: number,
  rows: number,
  x: number,
  y: number,
): [number, number] {
  const column = index % columns;
  const row = Math.floor(index / columns);
  return [
    (column + 0.5 + (x * INSET) / 2) / columns,
    1 - (row + 0.5 - (y * INSET) / 2) / rows,
  ];
}

export function gridOf(shape: Shape): { columns: number; rows: number } {
  const columns = Math.ceil(Math.sqrt(shape.faces.length));
  return { columns, rows: Math.ceil(shape.faces.length / columns) };
}

// The solid, flat-shaded, each face mapped to its own cell of the die's texture.
export function geometryOf(shape: Shape): BufferGeometry {
  const { columns, rows } = gridOf(shape);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  shape.faces.forEach((face, index) => {
    for (let k = 1; k + 1 < face.corners.length; k += 1) {
      for (const at of [0, k, k + 1]) {
        const corner = face.corners[at];
        const [x, y] = face.points[at] ?? [0, 0];
        if (!corner) continue;
        positions.push(corner.x, corner.y, corner.z);
        normals.push(face.normal.x, face.normal.y, face.normal.z);
        uvs.push(...cellPoint(index, columns, rows, x, y));
      }
    }
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  return geometry;
}
