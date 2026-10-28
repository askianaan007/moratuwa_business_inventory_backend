import type { LabCheckStatus } from "../../generated/prisma/client.js";
import type { RoomView } from "../rooms/room-view.js";

/** One thing an audit must look at, with the display fields frozen into the check. */
export interface AuditTarget {
  targetKind: "EQUIPMENT" | "SEAT";
  equipmentId: string | null;
  seatId: string | null;
  targetKey: string;
  sortKey: string;
  positionCode: string | null;
  workstationId: string | null;
  stationLabel: string | null;
  typeCode: string;
  typeName: string;
  itemCode: string;
  serialNo: string | null;
  assetTag: string | null;
  suggestion: { status: LabCheckStatus; reason: string } | null;
}

const p3 = (n: number) => String(n).padStart(3, "0");

const WALL_LABEL: Record<string, string> = {
  FRONT: "Front wall",
  BACK: "Back wall",
  LEFT: "Left wall",
  RIGHT: "Right wall",
  CEILING: "Ceiling",
};

const SEAT_TARGET: Record<string, string> = {
  EMPTY_TABLE: "Empty table",
  INSTRUCTOR: "Instructor desk",
  PC: "PC position (no PC registered)",
};

/**
 * Everything to inspect in the room right now: each live auditable item
 * (PC parts, fixtures, spares) and each table without a PC. Gaps are skipped.
 * Sorted in walking order: block → row → seat → equipment type.
 */
export function buildTargets(view: RoomView): AuditTarget[] {
  const seatBase = new Map<string, string>();
  view.blocks.forEach((block, bi) =>
    block.rows.forEach((row, ri) => row.seats.forEach((seat, si) => seatBase.set(seat.id, `${p3(bi + 1)}-${p3(ri + 1)}-${p3(si + 1)}`))),
  );

  const targets: AuditTarget[] = [];
  const equipmentTarget = (
    e: RoomView["equipment"][number],
    base: string,
    position: string | null,
    ws: { id: string; label: string } | null,
  ): AuditTarget => ({
    targetKind: "EQUIPMENT",
    equipmentId: e.id,
    seatId: null,
    targetKey: `E:${e.id}`,
    sortKey: `${base}-${p3(e.type.sortOrder)}-${e.slot}`,
    positionCode: position,
    workstationId: ws?.id ?? null,
    stationLabel: ws?.label ?? null,
    typeCode: e.type.code,
    typeName: e.type.name,
    itemCode: e.code,
    serialNo: e.serialNo,
    assetTag: e.assetItem?.tagCode ?? null,
    suggestion: e.state === "AT_REPAIR" ? { status: "REMOVED", reason: "At repair" } : null,
  });

  for (const ws of view.workstations) {
    const base = ws.seatId ? (seatBase.get(ws.seatId) ?? `X-${p3(ws.number)}`) : `X-${p3(ws.number)}`;
    for (const e of ws.equipment) {
      if (e.type.isAuditable) targets.push(equipmentTarget(e, base, ws.positionCode ?? "Not placed", { id: ws.id, label: ws.label }));
    }
  }
  for (const e of view.fixtures) {
    if (e.type.isAuditable) targets.push(equipmentTarget(e, `Y-${p3(e.type.sortOrder)}-${e.code}`, WALL_LABEL[e.wall ?? "FRONT"] ?? "Room", null));
  }
  for (const e of view.unassigned) {
    if (e.type.isAuditable) targets.push(equipmentTarget(e, `Z-${e.code}`, "Spare / not on a PC", null));
  }

  for (const block of view.blocks) {
    for (const row of block.rows) {
      for (const seat of row.seats) {
        if (seat.kind === "NO_TABLE" || seat.workstationId) continue;
        targets.push({
          targetKind: "SEAT",
          equipmentId: null,
          seatId: seat.id,
          targetKey: `S:${seat.id}`,
          sortKey: `${seatBase.get(seat.id)}-000-0`,
          positionCode: seat.positionCode,
          workstationId: null,
          stationLabel: null,
          typeCode: "SEAT",
          typeName: SEAT_TARGET[seat.kind] ?? "Table",
          itemCode: seat.positionCode,
          serialNo: null,
          assetTag: null,
          suggestion: null,
        });
      }
    }
  }
  return targets.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
}
