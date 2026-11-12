import type { ItemStatus, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { pageMeta, toSkipTake } from "../../utils/pagination.js";
import { assertInScope, departmentScope, requireDepartment } from "../../utils/scope.js";
import type {
  AssetFilter,
  CreateRoomInput,
  ListAssetsQuery,
  MovementsQuery,
  TRANSFER_TYPES,
  TransferInput,
  UpdateAssetInput,
  UpdateRoomInput,
} from "./inventory.schema.js";

type TransferType = (typeof TRANSFER_TYPES)[number];

const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });
const VERIFY_WINDOW_DAYS = 90;

export const TRANSFER_LABEL: Record<TransferType, string> = {
  ROOM_TO_ROOM: "Room to room",
  TO_STORE: "To store",
  FROM_STORE: "From store",
  TO_REPAIR: "Sent for repair",
  RETURN_FROM_REPAIR: "Returned from repair",
  LOAN: "Temporary loan",
  RETURN_FROM_LOAN: "Returned from loan",
};

/** Status an item takes after a completed transfer. */
const STATUS_AFTER: Record<TransferType, ItemStatus> = {
  ROOM_TO_ROOM: "IN_USE",
  TO_STORE: "IN_STORE",
  FROM_STORE: "IN_USE",
  TO_REPAIR: "IN_USE",
  RETURN_FROM_REPAIR: "IN_USE",
  LOAN: "ON_LOAN",
  RETURN_FROM_LOAN: "IN_USE",
};

// ─── Assets ─────────────────────────────────────────────────────────────

export function assetWhere(user: AuthUser, filter: AssetFilter): Prisma.AssetItemWhereInput {
  const departmentId = departmentScope(user, filter.departmentId);
  const q = filter.q;
  const page = q && /^\d{1,5}$/.test(q) ? Number(q) : undefined;
  return {
    deletedAt: null,
    ledgerEntry: {
      deletedAt: null,
      ...(departmentId && { departmentId }),
      ...(filter.categoryId && { categoryId: filter.categoryId }),
      ...(filter.bookStatus && { bookStatus: filter.bookStatus }),
    },
    ...(filter.locationId === "none" ? { locationId: null } : filter.locationId ? { locationId: filter.locationId } : {}),
    ...(filter.building && { location: { building: { equals: filter.building, mode: "insensitive" } } }),
    ...(filter.status ? { status: filter.status } : !filter.includeDisposed && { status: { not: "DISPOSED" } }),
    ...(filter.condition && { condition: filter.condition }),
    ...(filter.kind && { isBulk: filter.kind === "bulk" }),
    ...(q && {
      OR: [
        { tagCode: contains(q) },
        { serialNo: contains(q) },
        { custodian: contains(q) },
        { ledgerEntry: { description: contains(q) } },
        { ledgerEntry: { brand: contains(q) } },
        { ledgerEntry: { modelNo: contains(q) } },
        { ledgerEntry: { itemCode: contains(q) } },
        { ledgerEntry: { receiptNo: contains(q) } },
        { ledgerEntry: { refNo: contains(q) } },
        { ledgerEntry: { bookVolume: contains(q) } },
        { location: { code: contains(q) } },
        { location: { name: contains(q) } },
        { equipment: { some: { code: contains(q), state: { not: "RETIRED" } } } },
        ...(page !== undefined ? [{ ledgerEntry: { bookPage: page } }] : []),
      ],
    }),
  };
}

const assetListSelect = {
  id: true,
  tagCode: true,
  serialNo: true,
  custodian: true,
  condition: true,
  status: true,
  isBulk: true,
  bulkQty: true,
  updatedAt: true,
  location: { select: { id: true, code: true, name: true, building: true, floor: true, roomType: true } },
  ledgerEntry: {
    select: {
      id: true,
      departmentId: true,
      description: true,
      brand: true,
      modelNo: true,
      itemCode: true,
      entryDate: true,
      bookVolume: true,
      bookPage: true,
      bookStatus: true,
      category: { select: { id: true, code: true, name: true } },
    },
  },
  equipment: {
    where: { state: { not: "RETIRED" } },
    take: 1,
    select: { id: true, code: true, locationId: true, workstation: { select: { number: true } } },
  },
} satisfies Prisma.AssetItemSelect;

const ORDER: Record<ListAssetsQuery["sort"], Prisma.AssetItemOrderByWithRelationInput[]> = {
  tag: [{ tagCode: "asc" }],
  "-tag": [{ tagCode: "desc" }],
  description: [{ ledgerEntry: { description: "asc" } }, { tagCode: "asc" }],
  location: [{ location: { code: "asc" } }, { tagCode: "asc" }],
  "-updated": [{ updatedAt: "desc" }],
  condition: [{ condition: "desc" }, { tagCode: "asc" }],
};

export async function listAssets(user: AuthUser, query: ListAssetsQuery) {
  const where = assetWhere(user, query);
  const [items, total] = await Promise.all([
    prisma.assetItem.findMany({ where, orderBy: ORDER[query.sort], ...toSkipTake(query), select: assetListSelect }),
    prisma.assetItem.count({ where }),
  ]);
  return { data: items, meta: pageMeta(query, total) };
}

async function loadAsset(user: AuthUser, id: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const item = await db.assetItem.findFirst({
    where: { id, deletedAt: null },
    include: { ledgerEntry: { select: { departmentId: true, approvalStatus: true, description: true } }, location: true, equipment: { where: { state: { not: "RETIRED" } } } },
  });
  if (!item) throw AppError.notFound("Asset");
  assertInScope(user, item.ledgerEntry.departmentId, "Asset");
  return item;
}

export async function getAsset(user: AuthUser, id: string) {
  await loadAsset(user, id);
  const item = await prisma.assetItem.findUniqueOrThrow({
    where: { id },
    include: {
      location: { select: { id: true, code: true, name: true, building: true, floor: true, roomType: true } },
      ledgerEntry: {
        select: {
          id: true,
          departmentId: true,
          entryType: true,
          entryDate: true,
          receiptNo: true,
          sinNo: true,
          refNo: true,
          description: true,
          brand: true,
          modelNo: true,
          serialNo: true,
          itemCode: true,
          quantity: true,
          unitPrice: true,
          remark: true,
          hodSigned: true,
          bookVolume: true,
          bookPage: true,
          bookStatus: true,
          approvalStatus: true,
          department: { select: { id: true, code: true, name: true } },
          category: { select: { id: true, code: true, name: true } },
          _count: { select: { items: { where: { deletedAt: null } } } },
        },
      },
      movements: {
        orderBy: { movedAt: "desc" },
        select: {
          id: true,
          movedAt: true,
          reason: true,
          fromLocation: { select: { id: true, code: true, name: true } },
          toLocation: { select: { id: true, code: true, name: true } },
          movedBy: { select: { name: true } },
        },
      },
      auditRecords: {
        orderBy: { scannedAt: "desc" },
        take: 20,
        select: {
          id: true,
          result: true,
          condition: true,
          note: true,
          scannedAt: true,
          scannedBy: { select: { name: true } },
          observedLocation: { select: { id: true, code: true, name: true } },
          session: { select: { title: true } },
        },
      },
      disposal: { select: { reason: true, boardRef: true, disposedAt: true, approvedBy: { select: { name: true } } } },
      equipment: {
        orderBy: { installedAt: "desc" },
        select: {
          id: true,
          code: true,
          state: true,
          installedAt: true,
          retiredAt: true,
          type: { select: { name: true } },
          location: { select: { id: true, code: true, name: true } },
          workstation: { select: { number: true } },
        },
      },
    },
  });

  const equipmentIds = item.equipment.map((e) => e.id);
  const [labChecks, log, sameSerial] = await Promise.all([
    equipmentIds.length
      ? prisma.labAuditCheck.findMany({
          where: { equipmentId: { in: equipmentIds }, audit: { status: { in: ["SUBMITTED", "APPROVED"] } } },
          orderBy: { audit: { period: "desc" } },
          take: 12,
          select: {
            id: true,
            status: true,
            reasonText: true,
            checkedAt: true,
            faultReason: { select: { label: true } },
            audit: { select: { id: true, period: true, reference: true } },
          },
        })
      : [],
    prisma.activityLog.findMany({
      where: { tableName: "asset_items", rowId: id },
      orderBy: { at: "desc" },
      take: 30,
      select: { id: true, action: true, at: true, after: true, actor: { select: { name: true } } },
    }),
    item.serialNo
      ? prisma.assetItem.findMany({
          where: { id: { not: id }, deletedAt: null, serialNo: { equals: item.serialNo, mode: "insensitive" } },
          select: { id: true, tagCode: true },
          take: 5,
        })
      : [],
  ]);

  const lastSeen = [item.auditRecords[0]?.scannedAt, ...labChecks.map((c) => c.checkedAt)].filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const lastFinding = item.auditRecords[0] ?? null;
  const warnings: string[] = [];
  if (sameSerial.length) warnings.push(`Serial number also used by ${sameSerial.map((s) => s.tagCode).join(", ")}`);
  if (!item.locationId && item.status !== "DISPOSED") warnings.push("No room recorded for this item");
  if (item.ledgerEntry.bookStatus === "PENDING_BOOK") warnings.push("Not yet written in the inventory book");
  if (lastFinding?.result === "FOUND_ELSEWHERE" && lastFinding.observedLocation?.id !== item.locationId) {
    warnings.push(`Last seen in ${lastFinding.observedLocation?.code ?? "another room"}, but registered in ${item.location?.code ?? "no room"}`);
  }

  return { ...item, labChecks, log, duplicates: sameSerial, lastSeen, warnings };
}

export async function updateAsset(user: AuthUser, id: string, input: UpdateAssetInput) {
  const { expectedUpdatedAt, note, ...data } = input;
  await prisma.$transaction(async (tx) => {
    const before = await loadAsset(user, id, tx);
    if (before.status === "DISPOSED") throw AppError.conflict("Disposed items cannot be changed");
    if (data.bulkQty !== undefined && !before.isBulk) throw AppError.badRequest("Only bulk (quantity) records have a quantity");
    const done = await tx.assetItem.updateMany({ where: { id, updatedAt: new Date(expectedUpdatedAt) }, data });
    if (!done.count) throw AppError.conflict("Someone else changed this item. Reload and try again.");
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "asset_items", rowId: id, before, after: { ...data, note } });
  });
  return getAsset(user, id);
}

export async function transfer(user: AuthUser, input: TransferInput) {
  return prisma.$transaction(
    async (tx) => {
      const ids = [...new Set(input.ids)];
      const items = await tx.assetItem.findMany({
        where: { id: { in: ids }, deletedAt: null },
        include: {
          ledgerEntry: { select: { departmentId: true } },
          location: { select: { code: true } },
          equipment: { where: { state: { not: "RETIRED" } }, select: { code: true, location: { select: { code: true } } } },
        },
      });
      if (items.length !== ids.length) throw AppError.notFound("Asset");
      for (const item of items) assertInScope(user, item.ledgerEntry.departmentId, "Asset");

      const departments = new Set(items.map((i) => i.ledgerEntry.departmentId));
      if (departments.size > 1) throw AppError.badRequest("Items from different departments must be transferred separately");
      const departmentId = items[0]!.ledgerEntry.departmentId;
      const destination = await tx.location.findFirst({ where: { id: input.toLocationId, deletedAt: null } });
      if (!destination || destination.departmentId !== departmentId) throw AppError.badRequest("The destination room is not in this item's department");

      const problems: { path: string; message: string }[] = [];
      for (const item of items) {
        if (item.status === "DISPOSED") problems.push({ path: item.id, message: `${item.tagCode} is disposed` });
        const linked = item.equipment[0];
        if (linked) {
          problems.push({
            path: item.id,
            message: `${item.tagCode} is fitted as ${linked.code} in ${linked.location.code}. Move or replace it from that lab room first.`,
          });
        }
      }
      if (problems.length) throw new AppError(409, "TRANSFER_BLOCKED", problems[0]!.message, problems);

      const moving = items.filter((i) => i.locationId !== destination.id);
      const skipped = items.filter((i) => i.locationId === destination.id).map((i) => i.tagCode);
      if (!moving.length) throw AppError.badRequest(`Already in ${destination.code}`);

      const reason = `${TRANSFER_LABEL[input.type]}: ${input.reason}`;
      const movedAt = new Date();
      await tx.movement.createMany({
        data: moving.map((i) => ({ assetItemId: i.id, fromLocationId: i.locationId, toLocationId: destination.id, reason, movedAt, movedById: user.id })),
      });
      await tx.assetItem.updateMany({
        where: { id: { in: moving.map((i) => i.id) } },
        data: { locationId: destination.id, status: STATUS_AFTER[input.type] },
      });
      if (input.type === "TO_REPAIR") {
        await tx.assetItem.updateMany({ where: { id: { in: moving.map((i) => i.id) }, condition: "GOOD" }, data: { condition: "NEEDS_REPAIR" } });
      }
      await tx.activityLog.createMany({
        data: moving.map((i) => ({
          actorId: user.id,
          action: "transfer",
          tableName: "asset_items",
          rowId: i.id,
          before: { location: i.location?.code ?? null, status: i.status },
          after: { location: destination.code, status: STATUS_AFTER[input.type], type: input.type, reason: input.reason },
        })),
      });
      return { moved: moving.length, skipped, to: { id: destination.id, code: destination.code, name: destination.name } };
    },
    { timeout: 30_000 },
  );
}

export async function dispose(user: AuthUser, id: string, input: { expectedUpdatedAt: string; reason: string; boardRef?: string | null }) {
  await prisma.$transaction(async (tx) => {
    const item = await loadAsset(user, id, tx);
    if (item.status === "DISPOSED") throw AppError.conflict("This item is already disposed");
    const linked = item.equipment[0];
    if (linked) throw AppError.conflict(`Fitted as ${linked.code} in a lab. Retire or replace it from the lab room first.`);
    const done = await tx.assetItem.updateMany({ where: { id, updatedAt: new Date(input.expectedUpdatedAt) }, data: { status: "DISPOSED" } });
    if (!done.count) throw AppError.conflict("Someone else changed this item. Reload and try again.");
    await tx.disposal.create({ data: { assetItemId: id, reason: input.reason, boardRef: input.boardRef ?? null, approvedById: user.id } });
    await logActivity(tx, { actorId: user.id, action: "dispose", tableName: "asset_items", rowId: id, before: { status: item.status }, after: input });
  });
  return getAsset(user, id);
}

/**
 * Removes a record entered by mistake. Anything with history (moves, audits,
 * disposal, lab use) or belonging to an approved book entry must be disposed
 * instead, so audited assets are never destroyed.
 */
export async function deleteAsset(user: AuthUser, id: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const item = await loadAsset(user, id, tx);
    const [moves, audits, everFitted] = await Promise.all([
      tx.movement.count({ where: { assetItemId: id } }),
      tx.auditRecord.count({ where: { assetItemId: id } }),
      tx.equipment.count({ where: { assetItemId: id } }),
    ]);
    const blockers = [
      item.ledgerEntry.approvalStatus === "APPROVED" && "its ledger entry is approved",
      item.status === "DISPOSED" && "it is disposed",
      moves > 0 && `it has ${moves} transfer(s)`,
      audits > 0 && `it has ${audits} audit record(s)`,
      everFitted > 0 && "it was used as lab equipment",
    ].filter(Boolean);
    if (blockers.length) throw AppError.conflict(`Cannot delete: ${blockers.join(", ")}. Dispose it instead so the history is kept.`);
    await tx.assetItem.update({ where: { id }, data: { deletedAt: new Date() } });
    await logActivity(tx, { actorId: user.id, action: "delete", tableName: "asset_items", rowId: id, before: item, after: { reason } });
  });
}

/** Spot checks go into one open audit session per department and month. */
async function spotCheckSession(tx: Prisma.TransactionClient, departmentId: string, userId: string) {
  const now = new Date();
  const title = `Spot checks ${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const existing = await tx.auditSession.findFirst({ where: { departmentId, title, status: "OPEN" } });
  return existing ?? tx.auditSession.create({ data: { departmentId, title, startedById: userId } });
}

/**
 * Asset finder: records where an item was physically seen. The registered
 * location is never changed here; a mismatch stays open until someone
 * transfers the item or confirms it back in its registered room.
 */
export async function recordFinding(user: AuthUser, id: string, input: { observedLocationId: string; note?: string | null }) {
  return prisma.$transaction(async (tx) => {
    const item = await loadAsset(user, id, tx);
    const observed = await tx.location.findFirst({ where: { id: input.observedLocationId, deletedAt: null } });
    if (!observed) throw AppError.badRequest("Unknown room");
    assertInScope(user, observed.departmentId, "Room");
    const session = await spotCheckSession(tx, item.ledgerEntry.departmentId, user.id);
    const result = observed.id === item.locationId ? "FOUND" : "FOUND_ELSEWHERE";
    const record = await tx.auditRecord.create({
      data: { sessionId: session.id, assetItemId: id, result, condition: item.condition, observedLocationId: observed.id, note: input.note ?? null, scannedById: user.id },
    });
    if (result === "FOUND" && item.status === "MISSING") await tx.assetItem.update({ where: { id }, data: { status: "IN_USE" } });
    await logActivity(tx, { actorId: user.id, action: result === "FOUND" ? "verified" : "found_elsewhere", tableName: "asset_items", rowId: id, after: { observed: observed.code, registered: item.location?.code ?? null, note: input.note } });
    return { result, record };
  });
}

/** Items last seen somewhere other than their registered room, newest first. */
export async function listFindings(user: AuthUser, query: { departmentId?: string }) {
  const departmentId = departmentScope(user, query.departmentId);
  const records = await prisma.auditRecord.findMany({
    where: { result: "FOUND_ELSEWHERE", assetItem: { deletedAt: null, ...(departmentId && { ledgerEntry: { departmentId } }) } },
    orderBy: { scannedAt: "desc" },
    take: 200,
    select: {
      id: true,
      note: true,
      scannedAt: true,
      scannedBy: { select: { name: true } },
      observedLocation: { select: { id: true, code: true, name: true } },
      assetItem: {
        select: {
          id: true,
          tagCode: true,
          status: true,
          locationId: true,
          location: { select: { code: true, name: true } },
          ledgerEntry: { select: { description: true } },
          auditRecords: { orderBy: { scannedAt: "desc" }, take: 1, select: { id: true } },
          movements: { orderBy: { movedAt: "desc" }, take: 1, select: { movedAt: true } },
        },
      },
    },
  });
  return records
    .filter((r) => r.assetItem && r.assetItem.auditRecords[0]?.id === r.id) // only the latest finding per item
    .map(({ assetItem, ...r }) => {
      const a = assetItem!;
      const movedSince = a.movements[0] && a.movements[0].movedAt > r.scannedAt;
      return {
        ...r,
        asset: { id: a.id, tagCode: a.tagCode, description: a.ledgerEntry.description, status: a.status, location: a.location },
        resolved: Boolean(movedSince || a.locationId === r.observedLocation?.id || a.status === "DISPOSED"),
      };
    });
}

// ─── Rooms ──────────────────────────────────────────────────────────────

async function loadRoom(user: AuthUser, id: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const room = await db.location.findFirst({ where: { id, deletedAt: null } });
  if (!room) throw AppError.notFound("Room");
  assertInScope(user, room.departmentId, "Room");
  return room;
}

export async function listRooms(user: AuthUser, query: { departmentId?: string; q?: string; roomType?: Prisma.LocationWhereInput["roomType"]; building?: string }) {
  const departmentId = departmentScope(user, query.departmentId);
  const scope = { deletedAt: null, ...(departmentId && { departmentId }) };
  const [rooms, counts, buildings] = await Promise.all([
    prisma.location.findMany({
      where: {
        ...scope,
        ...(query.roomType && { roomType: query.roomType }),
        ...(query.building && { building: { equals: query.building, mode: "insensitive" } }),
        ...(query.q && { OR: [{ code: contains(query.q) }, { name: contains(query.q) }, { building: contains(query.q) }] }),
      },
      orderBy: [{ building: "asc" }, { floor: "asc" }, { code: "asc" }],
      select: {
        id: true,
        code: true,
        name: true,
        building: true,
        floor: true,
        roomType: true,
        departmentId: true,
        updatedAt: true,
        department: { select: { code: true, name: true } },
        _count: { select: { workstations: { where: { deletedAt: null } }, equipment: { where: { state: { not: "RETIRED" } } } } },
      },
    }),
    prisma.assetItem.groupBy({
      by: ["locationId", "condition"],
      where: { deletedAt: null, status: { not: "DISPOSED" }, locationId: { not: null }, ...(departmentId && { ledgerEntry: { departmentId } }) },
      _count: { _all: true },
    }),
    prisma.location.findMany({ where: { ...scope, building: { not: null } }, distinct: ["building"], select: { building: true }, orderBy: { building: "asc" } }),
  ]);

  const byRoom = new Map<string, { assets: number; attention: number }>();
  for (const c of counts) {
    const entry = byRoom.get(c.locationId!) ?? { assets: 0, attention: 0 };
    entry.assets += c._count._all;
    if (c.condition !== "GOOD") entry.attention += c._count._all;
    byRoom.set(c.locationId!, entry);
  }
  return {
    data: rooms.map(({ _count, ...r }) => ({
      ...r,
      assets: byRoom.get(r.id)?.assets ?? 0,
      needsAttention: byRoom.get(r.id)?.attention ?? 0,
      workstations: _count.workstations,
      labEquipment: _count.equipment,
    })),
    meta: { buildings: buildings.map((b) => b.building!) },
  };
}

export async function getRoom(user: AuthUser, id: string) {
  await loadRoom(user, id);
  const [room, items, movements, findings, openAudit] = await Promise.all([
    prisma.location.findUniqueOrThrow({
      where: { id },
      select: {
        id: true,
        code: true,
        name: true,
        building: true,
        floor: true,
        roomType: true,
        departmentId: true,
        updatedAt: true,
        createdAt: true,
        department: { select: { id: true, code: true, name: true } },
        _count: { select: { workstations: { where: { deletedAt: null } }, equipment: { where: { state: { not: "RETIRED" } } }, blocks: { where: { deletedAt: null } } } },
      },
    }),
    prisma.assetItem.findMany({
      where: { locationId: id, deletedAt: null, status: { not: "DISPOSED" } },
      select: { condition: true, status: true, isBulk: true, bulkQty: true, ledgerEntry: { select: { category: { select: { id: true, code: true, name: true } } } } },
    }),
    prisma.movement.findMany({
      where: { OR: [{ toLocationId: id }, { fromLocationId: id }] },
      orderBy: { movedAt: "desc" },
      take: 10,
      select: {
        id: true,
        movedAt: true,
        reason: true,
        fromLocation: { select: { id: true, code: true } },
        toLocation: { select: { id: true, code: true } },
        movedBy: { select: { name: true } },
        assetItem: { select: { id: true, tagCode: true, ledgerEntry: { select: { description: true } } } },
      },
    }),
    prisma.auditRecord.count({ where: { observedLocationId: id, result: "FOUND_ELSEWHERE", assetItem: { locationId: { not: id } } } }),
    prisma.labAudit.findFirst({ where: { locationId: id, status: { in: ["DRAFT", "SUBMITTED", "RETURNED"] } }, select: { id: true, reference: true, status: true } }),
  ]);

  const categories = new Map<string, { id: string | null; code: string; name: string; records: number; units: number; attention: number }>();
  let units = 0;
  for (const item of items) {
    const cat = item.ledgerEntry.category;
    const key = cat?.id ?? "none";
    const entry = categories.get(key) ?? { id: cat?.id ?? null, code: cat?.code ?? "—", name: cat?.name ?? "Uncategorised", records: 0, units: 0, attention: 0 };
    const qty = item.isBulk ? (item.bulkQty ?? 1) : 1;
    entry.records++;
    entry.units += qty;
    if (item.condition !== "GOOD") entry.attention += qty;
    units += qty;
    categories.set(key, entry);
  }
  const { _count, ...info } = room;
  return {
    ...info,
    workstations: _count.workstations,
    labEquipment: _count.equipment,
    hasLayout: _count.blocks > 0,
    totals: { records: items.length, units, attention: items.filter((i) => i.condition !== "GOOD").length },
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    movements,
    foundHereElsewhere: findings,
    openAudit,
  };
}

export async function createRoom(user: AuthUser, input: CreateRoomInput) {
  const { departmentId: requested, ...data } = input;
  const departmentId = requireDepartment(user, requested);
  return prisma.$transaction(async (tx) => {
    const department = await tx.department.findUnique({ where: { id: departmentId } });
    if (!department) throw AppError.badRequest("Unknown department");
    const clash = await tx.location.findFirst({ where: { departmentId, code: data.code, deletedAt: null } });
    if (clash) throw new AppError(409, "CONFLICT", `Room code ${data.code} is already used`, [{ path: "code", message: "Already used in this department" }]);
    const created = await tx.location.create({ data: { ...data, departmentId } });
    await logActivity(tx, { actorId: user.id, action: "create", tableName: "locations", rowId: created.id, after: created });
    return created;
  });
}

export async function updateRoom(user: AuthUser, id: string, input: UpdateRoomInput) {
  const { expectedUpdatedAt, ...data } = input;
  return prisma.$transaction(async (tx) => {
    const before = await loadRoom(user, id, tx);
    if (data.code && data.code !== before.code) {
      const clash = await tx.location.findFirst({ where: { departmentId: before.departmentId, code: data.code, deletedAt: null, id: { not: id } } });
      if (clash) throw new AppError(409, "CONFLICT", `Room code ${data.code} is already used`, [{ path: "code", message: "Already used in this department" }]);
    }
    const done = await tx.location.updateMany({ where: { id, updatedAt: new Date(expectedUpdatedAt) }, data });
    if (!done.count) throw AppError.conflict("Someone else changed this room. Reload and try again.");
    const after = await tx.location.findUniqueOrThrow({ where: { id } });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "locations", rowId: id, before, after });
    return after;
  });
}

/** Archives an empty room. Rooms that still hold anything must be emptied first. */
export async function archiveRoom(user: AuthUser, id: string) {
  await prisma.$transaction(async (tx) => {
    const room = await loadRoom(user, id, tx);
    const [items, equipment, workstations, audits] = await Promise.all([
      tx.assetItem.count({ where: { locationId: id, deletedAt: null, status: { not: "DISPOSED" } } }),
      tx.equipment.count({ where: { locationId: id, state: { not: "RETIRED" } } }),
      tx.workstation.count({ where: { locationId: id, deletedAt: null } }),
      tx.labAudit.count({ where: { locationId: id, status: { in: ["DRAFT", "SUBMITTED", "RETURNED"] } } }),
    ]);
    const blockers = [
      items && `${items} asset(s)`,
      equipment && `${equipment} lab item(s)`,
      workstations && `${workstations} PC(s)`,
      audits && "an open lab audit",
    ].filter(Boolean);
    if (blockers.length) throw AppError.conflict(`${room.code} still has ${blockers.join(", ")}. Transfer or retire them first.`);
    await tx.location.update({ where: { id }, data: { deletedAt: new Date() } });
    await logActivity(tx, { actorId: user.id, action: "archive", tableName: "locations", rowId: id, before: room });
  });
}

// ─── Movements & summary ────────────────────────────────────────────────

export async function listMovements(user: AuthUser, query: MovementsQuery) {
  const departmentId = departmentScope(user, query.departmentId);
  const where: Prisma.MovementWhereInput = {
    assetItem: { deletedAt: null, ...(departmentId && { ledgerEntry: { departmentId } }) },
    ...(query.locationId && { OR: [{ fromLocationId: query.locationId }, { toLocationId: query.locationId }] }),
    ...((query.from || query.to) && {
      movedAt: { ...(query.from && { gte: new Date(query.from) }), ...(query.to && { lt: new Date(new Date(query.to).getTime() + 86_400_000) }) },
    }),
    ...(query.q && {
      AND: [{ OR: [{ assetItem: { tagCode: contains(query.q) } }, { assetItem: { ledgerEntry: { description: contains(query.q) } } }, { reason: contains(query.q) }] }],
    }),
  };
  const [rows, total] = await Promise.all([
    prisma.movement.findMany({
      where,
      orderBy: { movedAt: "desc" },
      ...toSkipTake(query),
      select: {
        id: true,
        movedAt: true,
        reason: true,
        fromLocation: { select: { id: true, code: true, name: true } },
        toLocation: { select: { id: true, code: true, name: true } },
        movedBy: { select: { name: true } },
        assetItem: { select: { id: true, tagCode: true, ledgerEntry: { select: { description: true } } } },
      },
    }),
    prisma.movement.count({ where }),
  ]);
  return { data: rows, meta: pageMeta(query, total) };
}

export async function summary(user: AuthUser, query: { departmentId?: string; building?: string }) {
  const departmentId = departmentScope(user, query.departmentId);
  const itemWhere: Prisma.AssetItemWhereInput = {
    deletedAt: null,
    ledgerEntry: { deletedAt: null, ...(departmentId && { departmentId }) },
    ...(query.building && { location: { building: { equals: query.building, mode: "insensitive" } } }),
  };
  const live: Prisma.AssetItemWhereInput = { ...itemWhere, status: { not: "DISPOSED" } };
  const cutoff = new Date(Date.now() - VERIFY_WINDOW_DAYS * 86_400_000);
  const roomWhere = { deletedAt: null, ...(departmentId && { departmentId }), ...(query.building && { building: { equals: query.building, mode: "insensitive" as const } }) };

  const [items, rooms, buildings, unverified, moves30, findings, pendingBook] = await Promise.all([
    prisma.assetItem.findMany({
      where: live,
      select: {
        condition: true,
        status: true,
        isBulk: true,
        bulkQty: true,
        locationId: true,
        location: { select: { id: true, code: true, name: true, building: true } },
        ledgerEntry: { select: { category: { select: { id: true, code: true, name: true } } } },
      },
    }),
    prisma.location.count({ where: roomWhere }),
    prisma.location.findMany({ where: { ...roomWhere, building: { not: null } }, distinct: ["building"], select: { building: true } }),
    prisma.assetItem.count({
      where: {
        ...live,
        auditRecords: { none: { scannedAt: { gte: cutoff } } },
        equipment: { none: { checks: { some: { checkedAt: { gte: cutoff } } } } },
      },
    }),
    prisma.movement.count({ where: { movedAt: { gte: new Date(Date.now() - 30 * 86_400_000) }, assetItem: itemWhere } }),
    listFindings(user, { departmentId }),
    prisma.assetItem.count({ where: { ...live, ledgerEntry: { ...(itemWhere.ledgerEntry as object), bookStatus: "PENDING_BOOK" } } }),
  ]);

  const tally = <K extends string>(keys: (i: (typeof items)[number]) => K) => {
    const out = {} as Record<K, number>;
    for (const i of items) out[keys(i)] = (out[keys(i)] ?? 0) + 1;
    return out;
  };
  const group = (key: (i: (typeof items)[number]) => { id: string; code: string; name: string } | null) => {
    const map = new Map<string, { id: string | null; code: string; name: string; records: number; units: number; attention: number }>();
    for (const i of items) {
      const g = key(i);
      const k = g?.id ?? "none";
      const e = map.get(k) ?? { id: g?.id ?? null, code: g?.code ?? "—", name: g?.name ?? "None", records: 0, units: 0, attention: 0 };
      e.records++;
      e.units += i.isBulk ? (i.bulkQty ?? 1) : 1;
      if (i.condition !== "GOOD") e.attention++;
      map.set(k, e);
    }
    return [...map.values()].sort((a, b) => b.units - a.units);
  };

  const individual = items.filter((i) => !i.isBulk).length;
  return {
    rooms,
    buildings: buildings.length,
    records: items.length,
    individual,
    bulkRecords: items.length - individual,
    bulkUnits: items.filter((i) => i.isBulk).reduce((n, i) => n + (i.bulkQty ?? 1), 0),
    byStatus: tally((i) => i.status),
    byCondition: tally((i) => i.condition),
    unlocated: items.filter((i) => !i.locationId).length,
    unverified,
    verifyWindowDays: VERIFY_WINDOW_DAYS,
    movesLast30Days: moves30,
    openFindings: findings.filter((f) => !f.resolved).length,
    pendingBook,
    byCategory: group((i) => i.ledgerEntry.category),
    byRoom: group((i) => i.location).slice(0, 12),
  };
}
