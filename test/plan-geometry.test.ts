import { describe, expect, it } from "vitest";
import { computePlan, positionCode, type LayoutBlock } from "../src/modules/rooms/plan-geometry.js";

const block = (code: string, rows: string[][]): LayoutBlock => ({
  id: code,
  code,
  name: `Block ${code}`,
  rows: rows.map((kinds, ri) => ({
    id: `${code}${ri}`,
    label: String(ri + 1),
    seats: kinds.map((kind, si) => ({ id: `${code}${ri}-${si}`, kind: kind as "PC" })),
  })),
});

describe("positionCode", () => {
  it("formats block, row and seat", () => {
    expect(positionCode("A", "3", 2)).toBe("A-R3-S2");
  });
});

describe("computePlan", () => {
  const a = block("A", [["PC", "PC", "PC", "PC"], ["PC", "EMPTY_TABLE"], ["NO_TABLE", "PC"]]);
  const b = block("B", Array.from({ length: 8 }, () => ["PC", "PC"]));
  const plan = computePlan([a, b], [
    { id: "ac1", code: "AC-01", typeCode: "AC", typeName: "AC", wall: "LEFT", x: null, y: null },
    { id: "tv1", code: "TV-01", typeCode: "TV", typeName: "TV", wall: "FRONT", x: 50, y: 10 },
  ]);

  it("draws every seat, including gaps, with its position code", () => {
    expect(plan.desks).toHaveLength(4 + 2 + 2 + 16);
    expect(plan.desks.find((d) => d.seatId === "A2-1")?.positionCode).toBe("A-R3-S2");
  });

  it("places blocks left to right with an aisle and rows top to bottom", () => {
    const [blockA, blockB] = plan.blocks;
    expect(blockB!.x).toBeGreaterThan(blockA!.x + blockA!.w);
    const r1 = plan.desks.find((d) => d.seatId === "B0-0")!;
    const r8 = plan.desks.find((d) => d.seatId === "B7-0")!;
    expect(r8.y).toBeGreaterThan(r1.y);
  });

  it("fits everything inside the canvas", () => {
    for (const d of plan.desks) {
      expect(d.x + d.w).toBeLessThanOrEqual(plan.width);
      expect(d.y + d.h).toBeLessThanOrEqual(plan.height);
    }
  });

  it("honours explicit fixture positions and spreads the rest along their wall", () => {
    const tv = plan.fixtures.find((f) => f.equipmentId === "tv1")!;
    expect(tv.x).toBeCloseTo(plan.width / 2, 0);
    const ac = plan.fixtures.find((f) => f.equipmentId === "ac1")!;
    expect(ac.x).toBeLessThan(plan.blocks[0]!.x);
  });
});
