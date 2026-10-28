import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { AppError } from "../../utils/app-error.js";
import { assertInScope } from "../../utils/scope.js";
import { computePlan, positionCode, seatNumber, type LayoutBlock, type LayoutFixture } from "./plan-geometry.js";

type Db = Prisma.TransactionClient | typeof prisma;

/** An audit in one of these states keeps the room's layout frozen. */
export const OPEN_AUDIT_STATUSES = ["DRAFT", "SUBMITTED", "RETURNED"] as const;

/** 7 → "07"; numbers above 99 keep all their digits. */
export const pad = (n: number) => String(n).padStart(2, "0");

export async function loadRoomForUser(user: AuthUser, id: string, db: Db = prisma) {
  const location = await db.location.findFirst({ where: { id, deletedAt: null } });
  if (!location) throw AppError.notFound("Room");
  assertInScope(user, location.departmentId, "Room");
  return location;
}

export const equipmentSelect = {
  id: true,
  code: true,
  number: true,
  slot: true,
  state: true,
  brand: true,
  modelNo: true,
  serialNo: true,
  workstationId: true,
  wall: true,
  x: true,
  y: true,
  notes: true,
  version: true,
  installedAt: true,
  replacesId: true,
  assetItem: { select: { id: true, tagCode: true } },
  type: { select: { id: true, code: true, name: true, isPrimary: true, isAuditable: true, sortOrder: true, scope: true, codePrefix: true } },
} satisfies Prisma.EquipmentSelect;

export type EquipmentView = Prisma.EquipmentGetPayload<{ select: typeof equipmentSelect }>;

/** Display name of a PC: manual label, else its primary (monitor) code, else PC-07. */
export function workstationLabel(
  ws: { id: string; number: number; labelOverride: string | null },
  equipment: (Pick<EquipmentView, "workstationId" | "slot" | "code" | "state"> & { type: { isPrimary: boolean } })[],
) {
  if (ws.labelOverride) return ws.labelOverride;
  const primary = equipment.find((e) => e.workstationId === ws.id && e.type.isPrimary && e.slot === 1 && e.state !== "RETIRED");
  return primary?.code ?? `PC-${pad(ws.number)}`;
}

/** Keeps a PC's name in open audits in step with the room plan. */
export async function syncOpenAuditStationLabel(db: Db, workstationId: string) {
  const ws = await db.workstation.findUniqueOrThrow({ where: { id: workstationId }, select: { id: true, number: true, labelOverride: true } });
  const equipment = await db.equipment.findMany({
    where: { workstationId, state: { not: "RETIRED" } },
    select: { workstationId: true, slot: true, code: true, state: true, type: { select: { isPrimary: true } } },
  });
  await db.labAuditCheck.updateMany({
    where: { workstationId, audit: { status: { in: [...OPEN_AUDIT_STATUSES] } } },
    data: { stationLabel: workstationLabel(ws, equipment) },
  });
}

/**
 * Everything about a room's current layout and equipment, with position
 * codes, workstation labels and plan geometry worked out.
 */
export async function loadRoomView(db: Db, locationId: string) {
  // Sequential on purpose: this may run inside a transaction (one query at a time per connection).
  const location = await db.location.findUniqueOrThrow({
    where: { id: locationId },
    include: { department: { select: { id: true, code: true, name: true } } },
  });
  const blocks = await db.roomBlock.findMany({
    where: { locationId, deletedAt: null },
    orderBy: { order: "asc" },
    include: {
      rows: {
        where: { deletedAt: null },
        orderBy: { order: "asc" },
        include: { seats: { where: { deletedAt: null }, orderBy: { order: "asc" } } },
      },
    },
  });
  const workstations = await db.workstation.findMany({ where: { locationId, deletedAt: null }, orderBy: { number: "asc" } });
  const equipment = await db.equipment.findMany({
    where: { locationId, state: { not: "RETIRED" } },
    orderBy: [{ type: { sortOrder: "asc" } }, { number: "asc" }, { slot: "asc" }],
    select: equipmentSelect,
  });
  const openAudit = await db.labAudit.findFirst({
    where: { locationId, status: { in: [...OPEN_AUDIT_STATUSES] } },
    orderBy: { period: "desc" },
    select: { id: true, status: true, period: true, reference: true },
  });

  const wsBySeat = new Map(workstations.filter((w) => w.seatId).map((w) => [w.seatId!, w]));
  const positionBySeat = new Map<string, string>();
  const layout: LayoutBlock[] = blocks.map((block) => ({
    id: block.id,
    code: block.code,
    name: block.name,
    seatsFromRight: block.seatsFromRight,
    rows: block.rows.map((row) => ({
      id: row.id,
      label: row.label,
      seats: row.seats.map((seat, si) => {
        positionBySeat.set(seat.id, positionCode(block.code, row.label, seatNumber(block, row.seats.length, si)));
        const ws = wsBySeat.get(seat.id);
        return { id: seat.id, kind: seat.kind, workstationId: ws?.id ?? null, label: ws ? workstationLabel(ws, equipment) : null };
      }),
    })),
  }));

  // Room fixtures (AC, TV …) vs. PC parts that are currently not on any PC (spares).
  const fixtures = equipment.filter((e) => !e.workstationId && e.type.scope !== "WORKSTATION");
  const unassigned = equipment.filter((e) => !e.workstationId && e.type.scope === "WORKSTATION");
  const layoutFixtures: LayoutFixture[] = fixtures.map((f) => ({
    id: f.id,
    code: f.code,
    typeCode: f.type.code,
    typeName: f.type.name,
    wall: f.wall,
    x: f.x,
    y: f.y,
  }));

  const workstationViews = workstations.map((ws) => ({
    id: ws.id,
    number: ws.number,
    label: workstationLabel(ws, equipment),
    labelOverride: ws.labelOverride,
    seatId: ws.seatId,
    positionCode: ws.seatId ? (positionBySeat.get(ws.seatId) ?? null) : null,
    version: ws.version,
    equipment: equipment.filter((e) => e.workstationId === ws.id),
  }));

  return {
    room: {
      id: location.id,
      departmentId: location.departmentId,
      department: location.department,
      code: location.code,
      name: location.name,
      building: location.building,
      floor: location.floor,
      roomType: location.roomType,
      layoutVersion: location.layoutVersion,
    },
    blocks: blocks.map((block) => ({
      id: block.id,
      code: block.code,
      name: block.name,
      order: block.order,
      seatsFromRight: block.seatsFromRight,
      rows: block.rows.map((row) => ({
        id: row.id,
        label: row.label,
        order: row.order,
        seats: row.seats.map((seat) => {
          const ws = wsBySeat.get(seat.id);
          return {
            id: seat.id,
            order: seat.order,
            kind: seat.kind,
            note: seat.note,
            positionCode: positionBySeat.get(seat.id)!,
            workstationId: ws?.id ?? null,
          };
        }),
      })),
    })),
    workstations: workstationViews,
    fixtures,
    unassigned,
    /** All live (not retired) equipment in the room. */
    equipment,
    positionBySeat,
    openAudit,
    plan: computePlan(layout, layoutFixtures),
  };
}

export type RoomView = Awaited<ReturnType<typeof loadRoomView>>;

/** JSON-safe version for API responses (drops the internal Map). */
export function serializeRoomView({ positionBySeat: _positions, ...view }: RoomView) {
  return view;
}
