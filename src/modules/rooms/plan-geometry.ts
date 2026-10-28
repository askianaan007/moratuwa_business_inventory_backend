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
  seatsFromRight: boolean;
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
  /** mirrored: drawn with S1 at the right-hand end (blocks on the left half of the room). */
  blocks: { id: string; code: string; name: string; x: number; y: number; w: number; h: number; mirrored: boolean }[];
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

/** Seat number of the si-th seat from the left; blocks may count from the right instead. */
export function seatNumber(block: { seatsFromRight: boolean }, seatCount: number, si: number) {
  return block.seatsFromRight ? seatCount - si : si + 1;
}

/** "A-R3-S2": block code, row label, seat number. */
export function positionCode(blockCode: string, rowLabel: string, seatNumber: number) {
  return `${blockCode}-R${rowLabel}-S${seatNumber}`;
}

/** Column of a desk within its block, counted from the block's left edge as drawn. */
export function deskColumn(block: { x: number; mirrored?: boolean }, desk: { x: number }) {
  return Math.round((desk.x - block.x - (block.mirrored ? 0 : ROW_LABEL_W)) / (DESK_W + SEAT_GAP));
}

export function computePlan(blocks: LayoutBlock[], fixtures: LayoutFixture[] = []): PlanGeometry {
  const pitch = DESK_W + SEAT_GAP;
  const rowsHeight = (rows: number) => Math.max(1, rows) * (DESK_H + ROW_GAP) - ROW_GAP;
  const blockWidth = (block: LayoutBlock) => {
    const maxSeats = Math.max(1, ...block.rows.map((r) => r.seats.length));
    return ROW_LABEL_W + maxSeats * DESK_W + (maxSeats - 1) * SEAT_GAP;
  };

  // Instructor-only blocks stand at the front, centred over the middle aisle;
  // the student blocks sit side by side behind them.
  const isFront = (b: LayoutBlock) => b.rows.length > 0 && b.rows.every((r) => r.seats.every((s) => s.kind === "INSTRUCTOR" || s.kind === "NO_TABLE"));
  const frontBlocks = blocks.filter(isFront);
  const mainBlocks = frontBlocks.length === blocks.length ? blocks : blocks.filter((b) => !isFront(b));
  const front = mainBlocks === blocks ? [] : frontBlocks;

  const left = MARGIN + SIDE_BAND;
  const firstTop = MARGIN + TOP_BAND + BLOCK_HEADER;
  const frontRows = Math.max(0, ...front.map((b) => b.rows.length));
  const mainTop = front.length ? firstTop + rowsHeight(frontRows) + ROW_GAP + BLOCK_HEADER : firstTop;
  const mainRows = Math.max(1, ...mainBlocks.map((b) => b.rows.length));
  const mainWidth = mainBlocks.reduce((n, b) => n + blockWidth(b) + AISLE, 0) - AISLE;
  const frontWidth = front.reduce((n, b) => n + blockWidth(b) + AISLE, 0) - AISLE;
  const span = Math.max(mainWidth, frontWidth, 0);
  // Seats are numbered from the centre aisle outwards, so student blocks on the
  // left half of the room are drawn mirrored: S1 at their right-hand end.
  const roomCentre = left + span / 2;

  const placed = new Map<string, { x: number; top: number; rows: number; mirrored: boolean }>();
  let cursor = left + (span - mainWidth) / 2;
  for (const block of mainBlocks) {
    const w = blockWidth(block);
    placed.set(block.id, { x: cursor, top: mainTop, rows: mainRows, mirrored: cursor + w / 2 < roomCentre });
    cursor += w + AISLE;
  }
  // Centre the desks themselves on the aisle, not desks plus row label.
  cursor = roomCentre - frontWidth / 2 - ROW_LABEL_W / 2;
  for (const block of front) {
    placed.set(block.id, { x: cursor, top: firstTop, rows: frontRows, mirrored: false });
    cursor += blockWidth(block) + AISLE;
  }

  const planBlocks: PlanGeometry["blocks"] = [];
  const planRows: PlanGeometry["rows"] = [];
  const desks: PlanDesk[] = [];
  for (const block of blocks) {
    const { x, top, rows, mirrored } = placed.get(block.id)!;
    const maxSeats = Math.max(1, ...block.rows.map((r) => r.seats.length));
    const w = blockWidth(block);
    planBlocks.push({ id: block.id, code: block.code, name: block.name, x, y: top - BLOCK_HEADER, w, h: rowsHeight(rows) + BLOCK_HEADER, mirrored });

    block.rows.forEach((row, ri) => {
      const y = top + ri * (DESK_H + ROW_GAP);
      // Mirrored blocks carry their row labels on the right, beside S1.
      planRows.push({ id: row.id, blockId: block.id, label: row.label, x: mirrored ? x + w - ROW_LABEL_W : x, y: y + DESK_H / 2 });
      row.seats.forEach((seat, si) => {
        desks.push({
          seatId: seat.id,
          kind: seat.kind,
          x: x + (mirrored ? (maxSeats - 1 - si) * pitch : ROW_LABEL_W + si * pitch),
          y,
          w: DESK_W,
          h: DESK_H,
          positionCode: positionCode(block.code, row.label, seatNumber(block, row.seats.length, si)),
          blockCode: block.code,
          rowLabel: row.label,
          seatNumber: seatNumber(block, row.seats.length, si),
          workstationId: seat.workstationId ?? null,
          label: seat.label ?? null,
        });
      });
    });
  }

  const contentHeight = mainTop + rowsHeight(mainRows) - firstTop;
  const width = Math.max(left + span + SIDE_BAND + MARGIN, 320);
  const height = firstTop + contentHeight + BOTTOM_BAND + MARGIN;
  const board = { x: MARGIN + SIDE_BAND, y: MARGIN, w: width - 2 * (MARGIN + SIDE_BAND), h: 16 };

  return { width, height, board, blocks: planBlocks, rows: planRows, desks, fixtures: placeFixtures(fixtures, width, height, firstTop, contentHeight) };
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
