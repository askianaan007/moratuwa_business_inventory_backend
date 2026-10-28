import { randomUUID } from "node:crypto";
import type { Prisma, SeatKind } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { departmentScope, requireDepartment } from "../../utils/scope.js";
import { codeKey, equipmentCode, generateDefaultEquipment, numberKey } from "../equipment/equipment-keys.js";
import { computePlan, type LayoutBlock } from "./plan-geometry.js";
import { loadRoomForUser, loadRoomView, serializeRoomView, type RoomView } from "./room-view.js";
import type { CreateRoomInput, LayoutInput, UpdateRoomInput } from "./rooms.schema.js";

type Tx = Prisma.TransactionClient;

const versionConflict = (what: string) =>
  new AppError(409, "VERSION_CONFLICT", `${what} was changed by someone else. Reload and try again.`);

// ─── Rooms ──────────────────────────────────────────────────────────────

export async function list(user: AuthUser, query: { departmentId?: string; roomType?: "LAB" | "CLASSROOM" }) {
  const departmentId = departmentScope(user, query.departmentId);
  const rooms = await prisma.location.findMany({
    where: {
      deletedAt: null,
      ...(departmentId && { departmentId }),
      roomType: query.roomType ?? { in: ["LAB", "CLASSROOM"] },
    },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      building: true,
      floor: true,
      roomType: true,
      departmentId: true,
      _count: {
        select: {
          workstations: { where: { deletedAt: null } },
          equipment: { where: { state: { not: "RETIRED" } } },
          blocks: { where: { deletedAt: null } },
        },
      },
      labAudits: {
        orderBy: { period: "desc" },
        take: 1,
        select: { id: true, period: true, status: true, reference: true },
      },
    },
  });
  return rooms.map(({ _count, labAudits, ...room }) => ({
    ...room,
    workstationCount: _count.workstations,
    equipmentCount: _count.equipment,
    hasLayout: _count.blocks > 0,
    lastAudit: labAudits[0] ?? null,
  }));
}

export async function get(user: AuthUser, id: string) {
  await loadRoomForUser(user, id);
  return serializeRoomView(await loadRoomView(prisma, id));
}

export async function create(user: AuthUser, input: CreateRoomInput) {
  return prisma.$transaction(async (tx) => {
    if ("locationId" in input) {
      const before = await loadRoomForUser(user, input.locationId, tx);
      const after = await tx.location.update({ where: { id: before.id }, data: { roomType: input.roomType } });
      await logActivity(tx, { actorId: user.id, action: "make_room", tableName: "locations", rowId: after.id, before, after });
      return after;
    }
    const { departmentId: requested, ...fields } = input;
    const departmentId = requireDepartment(user, requested);
    const created = await tx.location.create({ data: { ...fields, departmentId } });
    await logActivity(tx, { actorId: user.id, action: "create", tableName: "locations", rowId: created.id, after: created });
    return created;
  });
}

export async function update(user: AuthUser, id: string, input: UpdateRoomInput) {
  return prisma.$transaction(async (tx) => {
    const before = await loadRoomForUser(user, id, tx);
    const after = await tx.location.update({ where: { id }, data: input });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "locations", rowId: id, before, after });
    return after;
  });
}

// ─── Layout ─────────────────────────────────────────────────────────────

/**
 * Works out what saving `input` would change. Ids in the input refer to
 * existing blocks, rows and seats; nodes without an id are new. Order comes
 * from array position. Nothing is written here.
 */
function planLayout(view: RoomView, input: LayoutInput) {
  const blocks = new Map(view.blocks.map((b) => [b.id, b]));
  const rows = new Map(view.blocks.flatMap((b) => b.rows.map((r) => [r.id, r] as const)));
  const seats = new Map(view.blocks.flatMap((b) => b.rows.flatMap((r) => r.seats.map((s) => [s.id, s] as const))));
  const wsById = new Map(view.workstations.map((w) => [w.id, w]));
  const seen = new Set<string>();

  const claim = (id: string | undefined, known: Map<string, unknown>, what: string) => {
    if (!id) return;
    if (!known.has(id)) throw AppError.badRequest(`Unknown ${what} in layout. Reload and try again.`);
    if (seen.has(id)) throw AppError.badRequest(`The same ${what} appears twice in the layout`);
    seen.add(id);
  };

  const codes = new Set<string>();
  let tempId = 0;
  const proposed: LayoutBlock[] = [];
  const blockers: string[] = [];
  const needsWorkstation: string[] = []; // seat ids (or temp ids) of PC seats without a workstation
  let seatsAdded = 0;
  let seatsChanged = 0;

  for (const block of input.blocks) {
    claim(block.id, blocks, "block");
    if (codes.has(block.code)) throw AppError.badRequest(`Block code ${block.code} is used twice`);
    codes.add(block.code);
    const labels = new Set<string>();

    proposed.push({
      id: block.id ?? `new-${++tempId}`,
      code: block.code,
      name: block.name,
      rows: block.rows.map((row) => {
        claim(row.id, rows, "row");
        const label = row.label.toUpperCase();
        if (labels.has(label)) throw AppError.badRequest(`Row ${label} appears twice in block ${block.code}`);
        labels.add(label);

        return {
          id: row.id ?? `new-${++tempId}`,
          label,
          seats: row.seats.map((seat) => {
            claim(seat.id, seats, "seat");
            const existing = seat.id ? seats.get(seat.id) : undefined;
            if (!existing) seatsAdded++;
            else if (existing.kind !== seat.kind) seatsChanged++;

            const ws = existing?.workstationId ? wsById.get(existing.workstationId) : undefined;
            if (ws && seat.kind !== "PC" && seat.kind !== "INSTRUCTOR") {
              blockers.push(`${existing!.positionCode} holds ${ws.label}. Move or retire that PC before changing the seat.`);
            }
            const id = seat.id ?? `new-${++tempId}`;
            if (seat.kind === "PC" && !ws) needsWorkstation.push(id);
            return { id, kind: seat.kind, workstationId: ws?.id ?? null, label: ws?.label ?? (seat.kind === "PC" ? "New PC" : null) };
          }),
        };
      }),
    });
  }

  const removedSeats = [...seats.values()].filter((s) => !seen.has(s.id));
  for (const seat of removedSeats) {
    const ws = seat.workstationId ? wsById.get(seat.workstationId) : undefined;
    if (ws) blockers.push(`${seat.positionCode} holds ${ws.label}. Move or retire that PC before removing the seat.`);
  }
  const removedRows = [...rows.keys()].filter((id) => !seen.has(id));
  const removedBlocks = [...blocks.keys()].filter((id) => !seen.has(id));

  // Any change to codes, labels, kinds or order changes position codes.
  const signature = (list: { code: string; rows: { label: string; seats: { id: string; kind: string }[] }[] }[]) =>
    JSON.stringify(list.map((b) => [b.code, b.rows.map((r) => [r.label, r.seats.map((s) => [s.id, s.kind])])]));
  const structural = signature(proposed) !== signature(view.blocks);

  return {
    proposed,
    blockers,
    needsWorkstation,
    structural,
    removed: { blocks: removedBlocks, rows: removedRows, seats: removedSeats.map((s) => s.id) },
    diff: {
      blocks: proposed.length,
      rows: proposed.reduce((n, b) => n + b.rows.length, 0),
      seats: proposed.reduce((n, b) => n + b.rows.reduce((m, r) => m + r.seats.length, 0), 0),
      pcSeats: proposed.reduce((n, b) => n + b.rows.reduce((m, r) => m + r.seats.filter((s) => s.kind === "PC").length, 0), 0),
      seatsAdded,
      seatsChanged,
      seatsRemoved: removedSeats.length,
      rowsRemoved: removedRows.length,
      blocksRemoved: removedBlocks.length,
      workstationsToCreate: input.createWorkstations ? needsWorkstation.length : 0,
    },
  };
}

function assertNoOpenAudit(view: RoomView, structural: boolean) {
  if (structural && view.openAudit) {
    throw AppError.conflict(
      `Audit ${view.openAudit.reference} is ${view.openAudit.status.toLowerCase()}. Finish or approve it before changing the layout.`,
    );
  }
}

export async function previewLayout(user: AuthUser, id: string, input: LayoutInput) {
  await loadRoomForUser(user, id);
  const view = await loadRoomView(prisma, id);
  const plan = planLayout(view, input);
  const blockers = [...plan.blockers];
  if (plan.structural && view.openAudit) {
    blockers.unshift(`Audit ${view.openAudit.reference} is ${view.openAudit.status.toLowerCase()}; layout changes must wait.`);
  }
  if (input.expectedLayoutVersion !== view.room.layoutVersion) {
    blockers.unshift("Someone else changed this layout. Reload before saving.");
  }
  const fixtures = view.fixtures.map((f) => ({ id: f.id, code: f.code, typeCode: f.type.code, typeName: f.type.name, wall: f.wall, x: f.x, y: f.y }));
  return { diff: plan.diff, blockers, plan: computePlan(plan.proposed, fixtures) };
}

export async function applyLayout(user: AuthUser, id: string, input: LayoutInput) {
  await prisma.$transaction(
    async (tx) => {
      const location = await loadRoomForUser(user, id, tx);
      const view = await loadRoomView(tx, id);
      const plan = planLayout(view, input);
      assertNoOpenAudit(view, plan.structural);
      if (plan.blockers.length) {
        throw new AppError(409, "LAYOUT_BLOCKED", plan.blockers[0]!, plan.blockers.map((message) => ({ path: "blocks", message })));
      }

      const locked = await tx.location.updateMany({
        where: { id, layoutVersion: input.expectedLayoutVersion },
        data: { layoutVersion: { increment: 1 } },
      });
      if (!locked.count) throw versionConflict("This layout");

      const now = new Date();
      if (plan.removed.seats.length) await tx.seat.updateMany({ where: { id: { in: plan.removed.seats } }, data: { deletedAt: now } });
      if (plan.removed.rows.length) await tx.roomRow.updateMany({ where: { id: { in: plan.removed.rows } }, data: { deletedAt: now } });
      if (plan.removed.blocks.length) await tx.roomBlock.updateMany({ where: { id: { in: plan.removed.blocks } }, data: { deletedAt: now } });

      // Write the tree with as few round trips as possible: new nodes get ids
      // here and go in with createMany; existing nodes are updated only when
      // something changed. (One query per seat took >30 s on a remote DB.)
      const oldBlocks = new Map(view.blocks.map((b) => [b.id, b]));
      const oldRows = new Map(view.blocks.flatMap((b) => b.rows.map((r) => [r.id, { ...r, blockId: b.id }] as const)));
      const oldSeats = new Map(view.blocks.flatMap((b) => b.rows.flatMap((r) => r.seats.map((st) => [st.id, { ...st, rowId: r.id }] as const))));
      const newBlocks: Prisma.RoomBlockCreateManyInput[] = [];
      const newRows: Prisma.RoomRowCreateManyInput[] = [];
      const newSeats: Prisma.SeatCreateManyInput[] = [];
      const blockUpdates: { id: string; data: { code: string; name: string; order: number } }[] = [];
      const rowUpdates: { id: string; data: { blockId: string; label: string; order: number } }[] = [];
      const seatUpdates: { id: string; data: { rowId: string; order: number; kind: SeatKind; note: string | null } }[] = [];
      const realSeatId = new Map<string, string>();

      for (const [bi, block] of input.blocks.entries()) {
        const blockData = { code: block.code, name: block.name, order: bi + 1 };
        const blockId = block.id ?? randomUUID();
        const oldBlock = block.id ? oldBlocks.get(block.id) : undefined;
        if (!oldBlock) newBlocks.push({ id: blockId, locationId: id, ...blockData });
        else if (oldBlock.code !== blockData.code || oldBlock.name !== blockData.name || oldBlock.order !== blockData.order) blockUpdates.push({ id: blockId, data: blockData });

        for (const [ri, row] of block.rows.entries()) {
          const rowData = { blockId, label: row.label.toUpperCase(), order: ri + 1 };
          const rowId = row.id ?? randomUUID();
          const oldRow = row.id ? oldRows.get(row.id) : undefined;
          if (!oldRow) newRows.push({ id: rowId, ...rowData });
          else if (oldRow.blockId !== blockId || oldRow.label !== rowData.label || oldRow.order !== rowData.order) rowUpdates.push({ id: rowId, data: rowData });

          for (const [si, seat] of row.seats.entries()) {
            const seatData = { rowId, order: si + 1, kind: seat.kind, note: seat.note ?? null };
            const seatId = seat.id ?? randomUUID();
            const oldSeat = seat.id ? oldSeats.get(seat.id) : undefined;
            if (!oldSeat) newSeats.push({ id: seatId, ...seatData });
            else if (oldSeat.rowId !== rowId || oldSeat.order !== seatData.order || oldSeat.kind !== seatData.kind || (oldSeat.note ?? null) !== seatData.note) {
              seatUpdates.push({ id: seatId, data: seatData });
            }
            realSeatId.set(plan.proposed[bi]!.rows[ri]!.seats[si]!.id, seatId);
          }
        }
      }

      if (newBlocks.length) await tx.roomBlock.createMany({ data: newBlocks });
      for (const u of blockUpdates) await tx.roomBlock.update({ where: { id: u.id }, data: u.data });
      if (newRows.length) await tx.roomRow.createMany({ data: newRows });
      for (const u of rowUpdates) await tx.roomRow.update({ where: { id: u.id }, data: u.data });
      if (newSeats.length) await tx.seat.createMany({ data: newSeats });
      for (const u of seatUpdates) await tx.seat.update({ where: { id: u.id }, data: u.data });

      let created = 0;
      if (input.createWorkstations && plan.needsWorkstation.length) {
        const max = await tx.workstation.aggregate({ where: { locationId: id, deletedAt: null }, _max: { number: true } });
        let next = (max._max.number ?? 0) + 1;
        const data: Prisma.WorkstationCreateManyInput[] = plan.needsWorkstation.map((tempOrReal) => {
          const seatId = realSeatId.get(tempOrReal)!;
          const number = next++;
          return { departmentId: location.departmentId, locationId: id, seatId, number, activeSeatKey: seatId, activeNumberKey: numberKey(id, number) };
        });
        await tx.workstation.createMany({ data });
        created = data.length;
      }
      const equipment = input.generateEquipment ? await generateDefaultEquipment(tx, id, location.departmentId) : null;

      await logActivity(tx, {
        actorId: user.id,
        action: "update_layout",
        tableName: "locations",
        rowId: id,
        before: { layoutVersion: input.expectedLayoutVersion },
        after: { ...plan.diff, workstationsCreated: created, equipmentCreated: equipment?.created ?? 0, equipmentSkipped: equipment?.skipped ?? [] },
      });
    },
    { timeout: 60_000, maxWait: 10_000 },
  );
  return get(user, id);
}

// ─── Renumbering ────────────────────────────────────────────────────────

/** PCs numbered in reading order (block → row → seat), unplaced PCs last. */
function planRenumber(view: RoomView) {
  const placedOrder = view.blocks.flatMap((b) => b.rows.flatMap((r) => r.seats.map((s) => s.workstationId).filter(Boolean))) as string[];
  const unplaced = view.workstations.filter((w) => !w.seatId).map((w) => w.id);
  const order = [...placedOrder, ...unplaced];
  const byId = new Map(view.workstations.map((w) => [w.id, w]));
  const liveCodes = new Set(view.equipment.map((e) => e.code));

  const workstations = order
    .map((wsId, i) => ({ ws: byId.get(wsId)!, newNumber: i + 1 }))
    .filter(({ ws, newNumber }) => ws.number !== newNumber)
    .map(({ ws, newNumber }) => ({ id: ws.id, label: ws.label, positionCode: ws.positionCode, from: ws.number, to: newNumber }));

  const renamed = new Set<string>();
  const equipment: { id: string; from: string; to: string; number: number }[] = [];
  const skipped: string[] = [];
  for (const change of workstations) {
    for (const item of byId.get(change.id)!.equipment) {
      // Only codes that follow the PC number move with it; custom codes stay.
      if (item.code !== equipmentCode(item.type.codePrefix, change.from)) continue;
      const to = equipmentCode(item.type.codePrefix, change.to);
      equipment.push({ id: item.id, from: item.code, to, number: change.to });
      renamed.add(item.code);
    }
  }
  // A new code may collide with an item that is not itself being renamed.
  const finalCodes = equipment.filter((e) => {
    const clash = liveCodes.has(e.to) && !renamed.has(e.to);
    if (clash) skipped.push(`${e.from} → ${e.to} (code already used)`);
    return !clash;
  });
  return { workstations, equipment: finalCodes, skipped };
}

export async function previewRenumber(user: AuthUser, id: string) {
  await loadRoomForUser(user, id);
  return planRenumber(await loadRoomView(prisma, id));
}

export async function applyRenumber(user: AuthUser, id: string, expectedLayoutVersion: number) {
  await prisma.$transaction(async (tx) => {
    await loadRoomForUser(user, id, tx);
    const view = await loadRoomView(tx, id);
    assertNoOpenAudit(view, true);
    const plan = planRenumber(view);

    const locked = await tx.location.updateMany({
      where: { id, layoutVersion: expectedLayoutVersion },
      data: { layoutVersion: { increment: 1 } },
    });
    if (!locked.count) throw versionConflict("This room");

    // Two phases so swapped numbers never collide on the unique keys.
    await tx.workstation.updateMany({ where: { id: { in: plan.workstations.map((w) => w.id) } }, data: { activeNumberKey: null } });
    await tx.equipment.updateMany({ where: { id: { in: plan.equipment.map((e) => e.id) } }, data: { activeCodeKey: null } });
    for (const w of plan.workstations) {
      await tx.workstation.update({
        where: { id: w.id },
        data: { number: w.to, activeNumberKey: numberKey(id, w.to), version: { increment: 1 } },
      });
    }
    for (const e of plan.equipment) {
      await tx.equipment.update({
        where: { id: e.id },
        data: { code: e.to, number: e.number, activeCodeKey: codeKey(id, e.to), version: { increment: 1 } },
      });
    }
    await logActivity(tx, { actorId: user.id, action: "renumber", tableName: "locations", rowId: id, after: plan });
  });
  return get(user, id);
}

// ─── Workstations ───────────────────────────────────────────────────────

async function loadWorkstation(user: AuthUser, id: string, tx: Tx) {
  const ws = await tx.workstation.findFirst({ where: { id, deletedAt: null } });
  if (!ws) throw AppError.notFound("Workstation");
  await loadRoomForUser(user, ws.locationId, tx);
  return ws;
}

/** Seat must be live, in the same room, a PC/instructor desk, and free. */
async function assertFreeSeat(tx: Tx, locationId: string, seatId: string) {
  const seat = await tx.seat.findFirst({
    where: { id: seatId, deletedAt: null, row: { deletedAt: null, block: { locationId, deletedAt: null } } },
  });
  if (!seat) throw AppError.badRequest("Seat not found in this room");
  if (seat.kind !== "PC" && seat.kind !== "INSTRUCTOR") throw AppError.badRequest("Only PC or instructor desks can hold a workstation");
  const taken = await tx.workstation.findUnique({ where: { activeSeatKey: seatId } });
  if (taken) throw AppError.conflict("That seat already has a workstation");
  return seat;
}

export async function createWorkstation(user: AuthUser, input: { seatId: string; generateEquipment: boolean }) {
  const seat = await prisma.seat.findFirst({ where: { id: input.seatId, deletedAt: null }, include: { row: { include: { block: true } } } });
  if (!seat) throw AppError.notFound("Seat");
  const locationId = seat.row.block.locationId;

  await prisma.$transaction(async (tx) => {
    const location = await loadRoomForUser(user, locationId, tx);
    await assertFreeSeat(tx, locationId, seat.id);
    const max = await tx.workstation.aggregate({ where: { locationId, deletedAt: null }, _max: { number: true } });
    const number = (max._max.number ?? 0) + 1;
    const ws = await tx.workstation.create({
      data: { departmentId: location.departmentId, locationId, seatId: seat.id, number, activeSeatKey: seat.id, activeNumberKey: numberKey(locationId, number) },
    });
    if (input.generateEquipment) await generateDefaultEquipment(tx, locationId, location.departmentId);
    await logActivity(tx, { actorId: user.id, action: "create", tableName: "workstations", rowId: ws.id, after: ws });
  });
  return get(user, locationId);
}

export async function updateWorkstation(user: AuthUser, id: string, input: { expectedVersion: number; labelOverride: string | null }) {
  return prisma.$transaction(async (tx) => {
    const before = await loadWorkstation(user, id, tx);
    const done = await tx.workstation.updateMany({
      where: { id, version: input.expectedVersion },
      data: { labelOverride: input.labelOverride || null, version: { increment: 1 } },
    });
    if (!done.count) throw versionConflict("This workstation");
    const after = await tx.workstation.findUniqueOrThrow({ where: { id } });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "workstations", rowId: id, before, after });
    return after;
  });
}

export async function moveWorkstation(user: AuthUser, id: string, input: { expectedVersion: number; seatId: string }) {
  const locationId = await prisma.$transaction(async (tx) => {
    const before = await loadWorkstation(user, id, tx);
    const view = await loadRoomView(tx, before.locationId);
    assertNoOpenAudit(view, true);
    await assertFreeSeat(tx, before.locationId, input.seatId);
    const done = await tx.workstation.updateMany({
      where: { id, version: input.expectedVersion },
      data: { seatId: input.seatId, activeSeatKey: input.seatId, version: { increment: 1 } },
    });
    if (!done.count) throw versionConflict("This workstation");
    await logActivity(tx, {
      actorId: user.id,
      action: "move",
      tableName: "workstations",
      rowId: id,
      before: { seatId: before.seatId },
      after: { seatId: input.seatId },
    });
    return before.locationId;
  });
  return get(user, locationId);
}

/** Takes a PC out of service. Its equipment is retired with it, or must be moved first. */
export async function retireWorkstation(
  user: AuthUser,
  id: string,
  input: { expectedVersion: number; reason: string; retireEquipment: boolean },
) {
  const locationId = await prisma.$transaction(async (tx) => {
    const before = await loadWorkstation(user, id, tx);
    const attached = await tx.equipment.findMany({ where: { workstationId: id, state: { not: "RETIRED" } } });
    if (attached.length && !input.retireEquipment) {
      throw AppError.conflict(`This PC still has ${attached.length} items. Move them or choose to retire them too.`);
    }
    const now = new Date();
    if (attached.length) {
      await tx.equipment.updateMany({
        where: { id: { in: attached.map((e) => e.id) } },
        data: {
          state: "RETIRED",
          retiredAt: now,
          retiredReason: input.reason,
          activeCodeKey: null,
          activeSlotKey: null,
          activeAssetKey: null,
          version: { increment: 1 },
        },
      });
    }
    const done = await tx.workstation.updateMany({
      where: { id, version: input.expectedVersion },
      data: { deletedAt: now, activeSeatKey: null, activeNumberKey: null, version: { increment: 1 } },
    });
    if (!done.count) throw versionConflict("This workstation");
    await logActivity(tx, {
      actorId: user.id,
      action: "retire",
      tableName: "workstations",
      rowId: id,
      before,
      after: { reason: input.reason, retiredEquipment: attached.map((e) => e.code) },
    });
    return before.locationId;
  });
  return get(user, locationId);
}

