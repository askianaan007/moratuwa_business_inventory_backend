import type { Equipment, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { equipmentSelect, loadRoomForUser } from "../rooms/room-view.js";
import { codeKey, equipmentCode, generateDefaultEquipment, slotKey } from "./equipment-keys.js";
import type { CreateEquipmentInput, MoveEquipmentInput, ReplaceEquipmentInput, UpdateEquipmentInput } from "./equipment.schema.js";

type Tx = Prisma.TransactionClient;

const versionConflict = () =>
  new AppError(409, "VERSION_CONFLICT", "This item was changed by someone else. Reload and try again.");

/** Loads a live (or, with `allowRetired`, any) equipment row the user may see. */
async function loadEquipment(user: AuthUser, id: string, tx: Tx | typeof prisma = prisma, allowRetired = false) {
  const item = await tx.equipment.findUnique({ where: { id }, include: { type: true } });
  if (!item) throw AppError.notFound("Equipment");
  await loadRoomForUser(user, item.locationId, tx);
  if (!allowRetired && item.state === "RETIRED") throw AppError.conflict("Retired equipment cannot be changed");
  return item;
}

/** Guarded write: only applies when nobody changed the row since the client read it. */
async function updateVersioned(tx: Tx, id: string, expectedVersion: number, data: Prisma.EquipmentUncheckedUpdateManyInput) {
  const done = await tx.equipment.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
  if (!done.count) throw versionConflict();
  return tx.equipment.findUniqueOrThrow({ where: { id }, select: equipmentSelect });
}

/** Checks the workstation belongs to the room and the slot is allowed for the type. */
async function assertSlot(tx: Tx, locationId: string, workstationId: string, type: { id: string; scope: string; maxPerWorkstation: number; name: string }, slot: number) {
  if (type.scope === "ROOM") throw AppError.badRequest(`${type.name} is a room item and cannot be attached to a PC`);
  if (slot > type.maxPerWorkstation) throw AppError.badRequest(`A PC can have at most ${type.maxPerWorkstation} × ${type.name}`);
  const ws = await tx.workstation.findFirst({ where: { id: workstationId, locationId, deletedAt: null } });
  if (!ws) throw AppError.badRequest("Workstation not found in this room");
  const taken = await tx.equipment.findUnique({ where: { activeSlotKey: slotKey(workstationId, type.id, slot) } });
  if (taken) throw AppError.conflict(`That PC already has a ${type.name}${slot > 1 ? ` #${slot}` : ""} (${taken.code})`);
  return ws;
}

/** Same department, not disposed, not linked to another live item. Returns warnings, never blocks on category. */
async function checkAsset(tx: Tx, departmentId: string, assetItemId: string, typeCategoryId: string | null, selfId?: string) {
  const asset = await tx.assetItem.findFirst({
    where: { id: assetItemId, deletedAt: null },
    include: { ledgerEntry: { select: { departmentId: true, categoryId: true } } },
  });
  if (!asset || asset.ledgerEntry.departmentId !== departmentId) throw AppError.badRequest("Ledger item not found in this department");
  if (asset.status === "DISPOSED") throw AppError.badRequest("Disposed ledger items cannot be linked");
  const other = await tx.equipment.findUnique({ where: { activeAssetKey: assetItemId } });
  if (other && other.id !== selfId) throw AppError.conflict(`That ledger item is already linked to ${other.code}`);
  const warnings: string[] = [];
  if (typeCategoryId && asset.ledgerEntry.categoryId && typeCategoryId !== asset.ledgerEntry.categoryId) {
    warnings.push("The ledger item is filed under a different category than this equipment type.");
  }
  return { asset, warnings };
}

export async function listForRoom(user: AuthUser, roomId: string, includeRetired: boolean) {
  await loadRoomForUser(user, roomId);
  return prisma.equipment.findMany({
    where: { locationId: roomId, ...(includeRetired ? {} : { state: { not: "RETIRED" } }) },
    orderBy: [{ type: { sortOrder: "asc" } }, { number: "asc" }, { slot: "asc" }],
    select: { ...equipmentSelect, retiredAt: true, retiredReason: true },
  });
}

export async function create(user: AuthUser, roomId: string, input: CreateEquipmentInput) {
  return prisma.$transaction(async (tx) => {
    const room = await loadRoomForUser(user, roomId, tx);
    const type = await tx.equipmentType.findFirst({ where: { id: input.typeId, isActive: true } });
    if (!type) throw AppError.badRequest("Equipment type not found or inactive");

    let number = input.number;
    if (input.workstationId) {
      const ws = await assertSlot(tx, roomId, input.workstationId, type, input.slot);
      number ??= ws.number;
    } else {
      if (type.scope === "WORKSTATION") throw AppError.badRequest(`${type.name} must be attached to a PC`);
      const max = await tx.equipment.aggregate({
        where: { locationId: roomId, typeId: type.id, workstationId: null, state: { not: "RETIRED" } },
        _max: { number: true },
      });
      number ??= (max._max.number ?? 0) + 1;
    }
    const code = input.code ?? equipmentCode(type.codePrefix, number) + (input.slot > 1 ? `-${input.slot}` : "");
    const warnings: string[] = [];

    const created = await tx.equipment.create({
      data: {
        departmentId: room.departmentId,
        locationId: roomId,
        workstationId: input.workstationId ?? null,
        typeId: type.id,
        slot: input.workstationId ? input.slot : 1,
        code,
        number,
        brand: input.brand ?? null,
        modelNo: input.modelNo ?? null,
        serialNo: input.serialNo ?? null,
        wall: input.workstationId ? null : (input.wall ?? "FRONT"),
        x: input.x ?? null,
        y: input.y ?? null,
        notes: input.notes ?? null,
        activeCodeKey: codeKey(roomId, code),
        activeSlotKey: input.workstationId ? slotKey(input.workstationId, type.id, input.slot) : null,
      },
      select: equipmentSelect,
    });
    await logActivity(tx, { actorId: user.id, action: "create", tableName: "equipment", rowId: created.id, after: created });
    return { item: created, warnings };
  });
}

export async function update(user: AuthUser, id: string, input: UpdateEquipmentInput) {
  return prisma.$transaction(async (tx) => {
    const before = await loadEquipment(user, id, tx);
    const { expectedVersion, ...fields } = input;
    const after = await updateVersioned(tx, id, expectedVersion, {
      ...fields,
      ...(fields.code && { activeCodeKey: codeKey(before.locationId, fields.code) }),
    });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "equipment", rowId: id, before, after });
    return after;
  });
}

/**
 * Swaps in a new physical unit. The old row is kept (retired, or at repair
 * without a slot); the new row points back at it and by default keeps the
 * same code, because the sticker on the desk stays.
 */
export async function replace(user: AuthUser, id: string, input: ReplaceEquipmentInput) {
  return prisma.$transaction(async (tx) => {
    const old = await loadEquipment(user, id, tx);
    const now = new Date();
    const retire = input.oldState === "RETIRED";
    await updateVersioned(tx, id, input.expectedVersion, {
      state: input.oldState,
      activeCodeKey: null,
      activeSlotKey: null,
      ...(retire && { retiredAt: now, retiredReason: input.reason, activeAssetKey: null }),
      ...(!retire && { workstationId: null, notes: [old.notes, `At repair: ${input.reason}`].filter(Boolean).join("\n") }),
    });

    const code = input.code ?? old.code;
    const warnings: string[] = [];
    if (input.assetItemId) warnings.push(...(await checkAsset(tx, old.departmentId, input.assetItemId, old.type.categoryId)).warnings);

    const created = await tx.equipment.create({
      data: {
        departmentId: old.departmentId,
        locationId: old.locationId,
        workstationId: old.workstationId,
        typeId: old.typeId,
        slot: old.slot,
        code,
        number: old.number,
        brand: input.brand ?? null,
        modelNo: input.modelNo ?? null,
        serialNo: input.serialNo ?? null,
        wall: old.wall,
        x: old.x,
        y: old.y,
        replacesId: old.id,
        assetItemId: input.assetItemId ?? null,
        activeCodeKey: codeKey(old.locationId, code),
        activeSlotKey: old.workstationId ? slotKey(old.workstationId, old.typeId, old.slot) : null,
        activeAssetKey: input.assetItemId ?? null,
      },
      select: equipmentSelect,
    });
    await logActivity(tx, {
      actorId: user.id,
      action: "replace",
      tableName: "equipment",
      rowId: old.id,
      before: old,
      after: { reason: input.reason, oldState: input.oldState, replacedBy: created.id, code },
    });
    return { item: created, warnings };
  });
}

/** Moves an item to another PC (or makes it unassigned). Its code stays. */
export async function move(user: AuthUser, id: string, input: MoveEquipmentInput) {
  return prisma.$transaction(async (tx) => {
    const before = await loadEquipment(user, id, tx);
    if (input.workstationId === before.workstationId && input.slot === before.slot) throw AppError.badRequest("The item is already there");
    if (input.workstationId) await assertSlot(tx, before.locationId, input.workstationId, before.type, input.slot);
    else if (before.type.scope === "WORKSTATION") throw AppError.badRequest(`${before.type.name} must stay on a PC; replace or retire it instead`);

    const after = await updateVersioned(tx, id, input.expectedVersion, {
      workstationId: input.workstationId,
      slot: input.workstationId ? input.slot : 1,
      activeSlotKey: input.workstationId ? slotKey(input.workstationId, before.typeId, input.slot) : null,
      ...(!input.workstationId && { wall: before.wall ?? "FRONT" }),
    });
    await logActivity(tx, {
      actorId: user.id,
      action: "move",
      tableName: "equipment",
      rowId: id,
      before: { workstationId: before.workstationId, slot: before.slot },
      after: { workstationId: input.workstationId, slot: input.slot, reason: input.reason },
    });
    return after;
  });
}

/** Sent for repair but still expected back in the same place. */
export async function sendToRepair(user: AuthUser, id: string, input: { expectedVersion: number; reason: string }) {
  return setState(user, id, input.expectedVersion, "AT_REPAIR", input.reason, "repair");
}

export async function returnFromRepair(user: AuthUser, id: string, input: { expectedVersion: number; reason?: string }) {
  return prisma.$transaction(async (tx) => {
    const before = await loadEquipment(user, id, tx);
    if (before.state !== "AT_REPAIR") throw AppError.conflict("Only items at repair can be returned");
    // Its code or slot may have been taken by a replacement in the meantime.
    const codeFree = !(await tx.equipment.findUnique({ where: { activeCodeKey: codeKey(before.locationId, before.code) } }));
    if (!codeFree) throw AppError.conflict(`Code ${before.code} is now used by another item. Give this one a new code first.`);
    const slotFree = before.workstationId
      ? !(await tx.equipment.findUnique({ where: { activeSlotKey: slotKey(before.workstationId, before.typeId, before.slot) } }))
      : true;
    const after = await updateVersioned(tx, id, input.expectedVersion, {
      state: "IN_SERVICE",
      activeCodeKey: codeKey(before.locationId, before.code),
      ...(before.workstationId && slotFree
        ? { activeSlotKey: slotKey(before.workstationId, before.typeId, before.slot) }
        : { workstationId: null, activeSlotKey: null }),
    });
    await logActivity(tx, { actorId: user.id, action: "return_from_repair", tableName: "equipment", rowId: id, before, after: { reason: input.reason } });
    return after;
  });
}

export async function retire(user: AuthUser, id: string, input: { expectedVersion: number; reason: string }) {
  return setState(user, id, input.expectedVersion, "RETIRED", input.reason, "retire");
}

async function setState(user: AuthUser, id: string, expectedVersion: number, state: "AT_REPAIR" | "RETIRED", reason: string, action: string) {
  return prisma.$transaction(async (tx) => {
    const before = await loadEquipment(user, id, tx);
    if (before.state === state) throw AppError.conflict(`The item is already ${state === "RETIRED" ? "retired" : "at repair"}`);
    const after = await updateVersioned(tx, id, expectedVersion, {
      state,
      ...(state === "RETIRED"
        ? { retiredAt: new Date(), retiredReason: reason, activeCodeKey: null, activeSlotKey: null, activeAssetKey: null }
        : { notes: [before.notes, `At repair: ${reason}`].filter(Boolean).join("\n") }),
    });
    await logActivity(tx, { actorId: user.id, action, tableName: "equipment", rowId: id, before, after: { reason } });
    return after;
  });
}

/** Links to an existing ledger item. Never changes the ledger item itself. */
export async function linkAsset(user: AuthUser, id: string, input: { expectedVersion: number; assetItemId: string }) {
  return prisma.$transaction(async (tx) => {
    const before = await loadEquipment(user, id, tx);
    const { asset, warnings } = await checkAsset(tx, before.departmentId, input.assetItemId, before.type.categoryId, id);
    if (asset.locationId && asset.locationId !== before.locationId) {
      warnings.push("The ledger records this item in a different location. It is listed as a discrepancy for review.");
    }
    const item = await updateVersioned(tx, id, input.expectedVersion, { assetItemId: asset.id, activeAssetKey: asset.id });
    await logActivity(tx, { actorId: user.id, action: "link_asset", tableName: "equipment", rowId: id, before: { assetItemId: before.assetItemId }, after: { assetItemId: asset.id } });
    return { item, warnings };
  });
}

export async function unlinkAsset(user: AuthUser, id: string, input: { expectedVersion: number }) {
  return prisma.$transaction(async (tx) => {
    const before = await loadEquipment(user, id, tx);
    const after = await updateVersioned(tx, id, input.expectedVersion, { assetItemId: null, activeAssetKey: null });
    await logActivity(tx, { actorId: user.id, action: "unlink_asset", tableName: "equipment", rowId: id, before: { assetItemId: before.assetItemId } });
    return after;
  });
}

/** Replacement chain (older and newer units), recent audit results and change log. */
export async function history(user: AuthUser, id: string) {
  const item = await loadEquipment(user, id, prisma, true);
  const chain: Equipment[] = [];
  let cursor: Equipment | null = item;
  while (cursor?.replacesId && chain.length < 50) {
    cursor = await prisma.equipment.findUnique({ where: { id: cursor.replacesId } });
    if (cursor) chain.push(cursor);
  }
  const newer = await prisma.equipment.findMany({ where: { replacesId: id }, orderBy: { installedAt: "asc" } });
  const ids = [id, ...chain.map((e) => e.id), ...newer.map((e) => e.id)];
  const [checks, log] = await Promise.all([
    prisma.labAuditCheck.findMany({
      where: { equipmentId: { in: ids } },
      orderBy: { audit: { period: "desc" } },
      take: 24,
      select: {
        id: true,
        itemCode: true,
        status: true,
        reasonText: true,
        faultReason: { select: { label: true } },
        audit: { select: { id: true, period: true, reference: true, status: true } },
      },
    }),
    prisma.activityLog.findMany({
      where: { tableName: "equipment", rowId: { in: ids } },
      orderBy: { at: "desc" },
      take: 50,
      select: { id: true, action: true, at: true, after: true, rowId: true, actor: { select: { name: true } } },
    }),
  ]);
  const brief = (e: Equipment) => ({ id: e.id, code: e.code, serialNo: e.serialNo, state: e.state, installedAt: e.installedAt, retiredAt: e.retiredAt, retiredReason: e.retiredReason });
  return { item: brief(item), older: chain.map(brief), newer: newer.map(brief), checks, log };
}

export async function generate(user: AuthUser, roomId: string, dryRun: boolean) {
  const room = await loadRoomForUser(user, roomId);
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await generateDefaultEquipment(tx, roomId, room.departmentId);
      if (dryRun) throw new DryRun(result);
      await logActivity(tx, { actorId: user.id, action: "generate_equipment", tableName: "locations", rowId: roomId, after: result });
      return { ...result, dryRun: false };
    });
  } catch (err) {
    if (err instanceof DryRun) return { ...err.result, dryRun: true };
    throw err;
  }
}

/** Thrown to roll back a dry run while still returning what would have happened. */
class DryRun extends Error {
  constructor(readonly result: { created: number; skipped: string[] }) {
    super("dry run");
  }
}
