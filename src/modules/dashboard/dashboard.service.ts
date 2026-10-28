import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { departmentScope } from "../../utils/scope.js";

export async function summary(user: AuthUser, requestedDepartmentId?: string) {
  const departmentId = departmentScope(user, requestedDepartmentId);
  const entryWhere = { deletedAt: null, ...(departmentId && { departmentId }) };
  const itemWhere = { deletedAt: null, ...(departmentId && { ledgerEntry: { departmentId } }) };

  const [entries, totals, items, pendingBook, awaitingApproval, needsAttention, missing, recent] = await Promise.all([
    prisma.ledgerEntry.count({ where: entryWhere }),
    prisma.ledgerEntry.aggregate({ where: entryWhere, _sum: { value: true } }),
    prisma.assetItem.count({ where: itemWhere }),
    prisma.ledgerEntry.count({ where: { ...entryWhere, bookStatus: "PENDING_BOOK" } }),
    prisma.ledgerEntry.count({ where: { ...entryWhere, approvalStatus: "SUBMITTED" } }),
    prisma.assetItem.count({ where: { ...itemWhere, condition: { in: ["NEEDS_REPAIR", "DAMAGED"] } } }),
    prisma.assetItem.count({ where: { ...itemWhere, status: "MISSING" } }),
    prisma.ledgerEntry.findMany({
      where: entryWhere,
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, entryDate: true, description: true, brand: true, quantity: true, value: true, bookStatus: true },
    }),
  ]);

  return {
    entries,
    items,
    totalValue: totals._sum.value?.toFixed(2) ?? "0.00",
    pendingBook,
    awaitingApproval,
    needsAttention,
    missing,
    recent,
  };
}
