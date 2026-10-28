/**
 * Top-view geometry of a room. This is the single source of coordinates for
 * the on-screen plan, the PDF and the Word report, so all three always match.
 * Pure functions only — no database access.
 *
 * Orientation: the board / front wall is at the top. Row 1 is nearest the
 * board, seat 1 is leftmost when facing the board.
 */

export type SeatKindValue = "PC" | "EMPTY_TABLE" | "NO_TABLE" | "INSTRUCTOR";
export type Wall = "FRONT" | "BACK" | "LEFT" | "RIGHT" | "CEILING";
export const WALLS: Wall[] = ["FRONT", "BACK", "LEFT", "RIGHT", "CEILING"];

export interface LayoutSeat {
  id: string;
  kind: SeatKindValue;
  workstationId?: string | null;
  label?: string | null;
}
export interface LayoutRow {
  id: string;
  label: string;
  seats: LayoutSeat[];
}
export interface LayoutBlock {
  id: string;
  code: string;
  name: string;
  rows: LayoutRow[];
}
export interface LayoutFixture {
  id: string;
  code: string;
  typeCode: string;
  typeName: string;
  wall: string | null;
  x: number | null;
  y: number | null;
}

export interface PlanDesk {
  seatId: string;
  kind: SeatKindValue;
  x: number;
  y: number;
  w: number;
  h: number;
  positionCode: string;
  blockCode: string;
  rowLabel: string;
  seatNumber: number;
  workstationId: string | null;
  label: string | null;
}

export interface PlanGeometry {
  width: number;
  height: number;
  board: { x: number; y: number; w: number; h: number };
  blocks: { id: string; code: string; name: string; x: number; y: number; w: number; h: number }[];
  rows: { id: string; blockId: string; label: string; x: number; y: number }[];
  desks: PlanDesk[];
  fixtures: { equipmentId: string; code: string; typeCode: string; typeName: string; x: number; y: number; wall: Wall }[];
}

const MARGIN = 16;
const SIDE_BAND = 40; // left/right walls (AC, windows …)
const TOP_BAND = 64; // board + front-wall fixtures
const BOTTOM_BAND = 44; // back wall (door …)
const BLOCK_HEADER = 22;
const ROW_LABEL_W = 28;
const DESK_W = 64;
const DESK_H = 44;
const SEAT_GAP = 6;
const ROW_GAP = 14;
const AISLE = 40;

/** "A-R3-S2": block code, row label, seat number. */
export function positionCode(blockCode: string, rowLabel: string, seatNumber: number) {
  return `${blockCode}-R${rowLabel}-S${seatNumber}`;
}

export function computePlan(blocks: LayoutBlock[], fixtures: LayoutFixture[] = []): PlanGeometry {
  const maxRows = Math.max(1, ...blocks.map((b) => b.rows.length));
  const top = MARGIN + TOP_BAND + BLOCK_HEADER;
  const contentHeight = maxRows * (DESK_H + ROW_GAP) - ROW_GAP;

  const planBlocks: PlanGeometry["blocks"] = [];
  const planRows: PlanGeometry["rows"] = [];
  const desks: PlanDesk[] = [];
  let cursor = MARGIN + SIDE_BAND;

  for (const block of blocks) {
    const maxSeats = Math.max(1, ...block.rows.map((r) => r.seats.length));
    const w = ROW_LABEL_W + maxSeats * DESK_W + (maxSeats - 1) * SEAT_GAP;
    planBlocks.push({ id: block.id, code: block.code, name: block.name, x: cursor, y: top - BLOCK_HEADER, w, h: contentHeight + BLOCK_HEADER });

    block.rows.forEach((row, ri) => {
      const y = top + ri * (DESK_H + ROW_GAP);
      planRows.push({ id: row.id, blockId: block.id, label: row.label, x: cursor, y: y + DESK_H / 2 });
      row.seats.forEach((seat, si) => {
        desks.push({
          seatId: seat.id,
          kind: seat.kind,
          x: cursor + ROW_LABEL_W + si * (DESK_W + SEAT_GAP),
          y,
          w: DESK_W,
          h: DESK_H,
          positionCode: positionCode(block.code, row.label, si + 1),
          blockCode: block.code,
          rowLabel: row.label,
          seatNumber: si + 1,
          workstationId: seat.workstationId ?? null,
          label: seat.label ?? null,
        });
      });
    });
    cursor += w + AISLE;
  }

  const width = Math.max(cursor - AISLE + SIDE_BAND + MARGIN, 320);
  const height = top + contentHeight + BOTTOM_BAND + MARGIN;
  const board = { x: MARGIN + SIDE_BAND, y: MARGIN, w: width - 2 * (MARGIN + SIDE_BAND), h: 16 };

  return { width, height, board, blocks: planBlocks, rows: planRows, desks, fixtures: placeFixtures(fixtures, width, height, top, contentHeight) };
}

/** Explicit x/y (0–100 %) wins; otherwise fixtures are spread evenly along their wall. */
function placeFixtures(fixtures: LayoutFixture[], width: number, height: number, top: number, contentHeight: number) {
  const byWall = new Map<Wall, LayoutFixture[]>();
  for (const f of fixtures) {
    const wall = (WALLS as string[]).includes(f.wall ?? "") ? (f.wall as Wall) : "FRONT";
    byWall.set(wall, [...(byWall.get(wall) ?? []), f]);
  }

  const placed: PlanGeometry["fixtures"] = [];
  for (const [wall, list] of byWall) {
    list.forEach((f, i) => {
      const t = (i + 1) / (list.length + 1);
      let x: number;
      let y: number;
      if (f.x !== null && f.y !== null) {
        x = (f.x / 100) * width;
        y = (f.y / 100) * height;
      } else if (wall === "FRONT" || wall === "CEILING") {
        x = MARGIN + SIDE_BAND + t * (width - 2 * (MARGIN + SIDE_BAND));
        y = wall === "FRONT" ? MARGIN + 38 : MARGIN + 54;
      } else if (wall === "BACK") {
        x = MARGIN + SIDE_BAND + t * (width - 2 * (MARGIN + SIDE_BAND));
        y = height - MARGIN - BOTTOM_BAND / 2;
      } else {
        x = wall === "LEFT" ? MARGIN + SIDE_BAND / 2 : width - MARGIN - SIDE_BAND / 2;
        y = top + t * contentHeight;
      }
      placed.push({ equipmentId: f.id, code: f.code, typeCode: f.typeCode, typeName: f.typeName, x: round(x), y: round(y), wall });
    });
  }
  return placed;
}

const round = (n: number) => Math.round(n * 10) / 10;
