import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { assertInScope } from "../../utils/scope.js";
import type { MoveItemInput, UpdateItemInput } from "./items.schema.js";

const itemDetailInclude = {
  location: { select: { id: true, code: true, name: true } },
  ledgerEntry: {
    select: {
      id: true,
      departmentId: true,
      entryDate: true,
      receiptNo: true,
      refNo: true,
      description: true,
      brand: true,
      modelNo: true,
      itemCode: true,
      unitPrice: true,
      category: { select: { id: true, code: true, name: true } },
      approvalStatus: true,
    },
  },
  auditRecords: {
    orderBy: { scannedAt: "desc" },
    take: 5,
    select: { id: true, result: true, condition: true, scannedAt: true, scannedBy: { select: { name: true } } },
  },
  movements: {
    orderBy: { movedAt: "desc" },
    take: 10,
    select: {
      id: true,
      movedAt: true,
      reason: true,
      fromLocation: { select: { code: true, name: true } },
      toLocation: { select: { code: true, name: true } },
    },
  },
} satisfies Prisma.AssetItemInclude;

async function loadInScope(user: AuthUser, where: Prisma.AssetItemWhereInput) {
  const item = await prisma.assetItem.findFirst({ where: { ...where, deletedAt: null }, include: itemDetailInclude });
  if (!item) throw AppError.notFound("Item");
  assertInScope(user, item.ledgerEntry.departmentId, "Item");
  return item;
}

/** Used by the QR scanner. */
export function getByTag(user: AuthUser, tagCode: string) {
  return loadInScope(user, { tagCode });
}

export function get(user: AuthUser, id: string) {
  return loadInScope(user, { id });
}

export async function update(user: AuthUser, id: string, input: UpdateItemInput) {
  const before = await loadInScope(user, { id });
  if (before.status === "DISPOSED") throw AppError.conflict("Disposed items cannot be changed");

  return prisma.$transaction(async (tx) => {
    const after = await tx.assetItem.update({ where: { id }, data: input });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "asset_items", rowId: id, before, after });
    return after;
  });
}

export async function move(user: AuthUser, id: string, input: MoveItemInput) {
  const item = await loadInScope(user, { id });
  if (item.status === "DISPOSED") throw AppError.conflict("Disposed items cannot be moved");
  if (item.location?.id === input.toLocationId) throw AppError.badRequest("Item is already at this location");

  return prisma.$transaction(async (tx) => {
    const destination = await tx.location.findFirst({
      where: { id: input.toLocationId, departmentId: item.ledgerEntry.departmentId, deletedAt: null },
    });
    if (!destination) throw AppError.badRequest("Location does not belong to this department");

    const movement = await tx.movement.create({
      data: {
        assetItemId: id,
        fromLocationId: item.location?.id ?? null,
        toLocationId: destination.id,
        reason: input.reason,
        movedById: user.id,
      },
    });
    await tx.assetItem.update({ where: { id }, data: { locationId: destination.id } });
    await logActivity(tx, { actorId: user.id, action: "move", tableName: "asset_items", rowId: id, after: movement });
    return movement;
  });
}
