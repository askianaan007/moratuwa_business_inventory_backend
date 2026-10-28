import { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { pageMeta, toSkipTake } from "../../utils/pagination.js";
import { assertInScope, departmentScope, requireDepartment } from "../../utils/scope.js";
import { allocateTagCodes } from "./tag-codes.js";
import type {
  CreateLedgerEntryInput,
  DecisionInput,
  ListLedgerQuery,
  MarkWrittenInput,
  UpdateLedgerEntryInput,
} from "./ledger.schema.js";

const entryDetailInclude = {
  department: { select: { id: true, code: true, name: true } },
  createdBy: { select: { id: true, name: true } },
  items: {
    where: { deletedAt: null },
    orderBy: { tagCode: "asc" },
    select: {
      id: true,
      tagCode: true,
      serialNo: true,
      condition: true,
      status: true,
      isBulk: true,
      bulkQty: true,
      location: { select: { id: true, code: true, name: true } },
    },
  },
  approvals: {
    orderBy: { decidedAt: "desc" },
    select: { id: true, status: true, comment: true, decidedAt: true, approver: { select: { id: true, name: true } } },
  },
} satisfies Prisma.LedgerEntryInclude;

const computeValue = (quantity: number, unitPrice: string | Prisma.Decimal) =>
  new Prisma.Decimal(unitPrice).times(quantity).toDecimalPlaces(2);

/** Loads a live entry the user is allowed to see, or throws 404. */
async function findEntryForUser(user: AuthUser, id: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  const entry = await db.ledgerEntry.findFirst({ where: { id, deletedAt: null } });
  if (!entry) throw AppError.notFound("Ledger entry");
  assertInScope(user, entry.departmentId, "Ledger entry");
  return entry;
}

export async function list(user: AuthUser, query: ListLedgerQuery) {
  const departmentId = departmentScope(user, query.departmentId);
  const contains = (value: string) => ({ contains: value, mode: "insensitive" as const });

  const where: Prisma.LedgerEntryWhereInput = {
    deletedAt: null,
    ...(departmentId && { departmentId }),
    ...(query.bookStatus && { bookStatus: query.bookStatus }),
    ...(query.approvalStatus && { approvalStatus: query.approvalStatus }),
    ...((query.from || query.to) && {
      entryDate: {
        ...(query.from && { gte: new Date(query.from) }),
        ...(query.to && { lte: new Date(query.to) }),
      },
    }),
    ...(query.q && {
      OR: [
        { description: contains(query.q) },
        { refNo: contains(query.q) },
        { brand: contains(query.q) },
        { modelNo: contains(query.q) },
        { items: { some: { serialNo: contains(query.q) } } },
        { items: { some: { tagCode: contains(query.q) } } },
      ],
    }),
  };

  const [entries, total] = await Promise.all([
    prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
      ...toSkipTake(query),
      include: { _count: { select: { items: { where: { deletedAt: null } } } } },
    }),
    prisma.ledgerEntry.count({ where }),
  ]);
  return { data: entries, meta: pageMeta(query, total) };
}

export async function get(user: AuthUser, id: string) {
  await findEntryForUser(user, id);
  return prisma.ledgerEntry.findUniqueOrThrow({ where: { id }, include: entryDetailInclude });
}

export async function create(user: AuthUser, input: CreateLedgerEntryInput) {
  const departmentId = requireDepartment(user, input.departmentId);
  const { locationId, isBulk, serialNos, departmentId: _ignored, ...fields } = input;

  return prisma.$transaction(async (tx) => {
    const department = await tx.department.findUnique({ where: { id: departmentId } });
    if (!department) throw AppError.notFound("Department");

    if (locationId) {
      const location = await tx.location.findFirst({ where: { id: locationId, departmentId, deletedAt: null } });
      if (!location) throw AppError.badRequest("Location does not belong to this department");
    }

    const entry = await tx.ledgerEntry.create({
      data: {
        ...fields,
        entryDate: new Date(fields.entryDate),
        value: computeValue(fields.quantity, fields.unitPrice),
        bookStatus: fields.bookPage ? "WRITTEN_IN_BOOK" : "PENDING_BOOK",
        departmentId,
        createdById: user.id,
      },
    });

    const tagCount = isBulk ? 1 : fields.quantity;
    const tags = await allocateTagCodes(tx, department, tagCount);
    await tx.assetItem.createMany({
      data: tags.map((tagCode, i) => ({
        ledgerEntryId: entry.id,
        tagCode,
        serialNo: serialNos[i] || null,
        locationId: locationId ?? null,
        isBulk,
        bulkQty: isBulk ? fields.quantity : null,
      })),
    });

    await logActivity(tx, { actorId: user.id, action: "create", tableName: "ledger_entries", rowId: entry.id, after: entry });
    return tx.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id }, include: entryDetailInclude });
  });
}

export async function update(user: AuthUser, id: string, input: UpdateLedgerEntryInput) {
  return prisma.$transaction(async (tx) => {
    const before = await findEntryForUser(user, id, tx);
    if (before.approvalStatus === "APPROVED" || before.approvalStatus === "SUBMITTED") {
      throw AppError.conflict("Submitted or approved entries are locked. Ask the HOD to reject it first.");
    }

    const after = await tx.ledgerEntry.update({
      where: { id },
      data: {
        ...input,
        ...(input.entryDate && { entryDate: new Date(input.entryDate) }),
        ...(input.unitPrice && { value: computeValue(before.quantity, input.unitPrice) }),
        // An edited, rejected entry goes back to draft.
        ...(before.approvalStatus === "REJECTED" && { approvalStatus: "DRAFT" }),
      },
    });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "ledger_entries", rowId: id, before, after });
    return tx.ledgerEntry.findUniqueOrThrow({ where: { id }, include: entryDetailInclude });
  });
}

/** Soft delete. Only drafts and rejected entries can be removed. */
export async function remove(user: AuthUser, id: string) {
  await prisma.$transaction(async (tx) => {
    const entry = await findEntryForUser(user, id, tx);
    if (entry.approvalStatus !== "DRAFT" && entry.approvalStatus !== "REJECTED") {
      throw AppError.conflict("Only draft or rejected entries can be deleted");
    }
    const now = new Date();
    await tx.ledgerEntry.update({ where: { id }, data: { deletedAt: now } });
    await tx.assetItem.updateMany({ where: { ledgerEntryId: id, deletedAt: null }, data: { deletedAt: now } });
    await logActivity(tx, { actorId: user.id, action: "delete", tableName: "ledger_entries", rowId: id, before: entry });
  });
}

/** Records that the entry has been copied into the physical book. */
export async function markWrittenInBook(user: AuthUser, id: string, input: MarkWrittenInput) {
  return prisma.$transaction(async (tx) => {
    const before = await findEntryForUser(user, id, tx);
    const after = await tx.ledgerEntry.update({
      where: { id },
      data: { bookStatus: "WRITTEN_IN_BOOK", bookPage: input.bookPage, bookVolume: input.bookVolume ?? before.bookVolume },
    });
    await logActivity(tx, { actorId: user.id, action: "mark_written", tableName: "ledger_entries", rowId: id, before, after });
    return after;
  });
}

/** Technical officer sends the entry to the HOD for approval. */
export async function submit(user: AuthUser, id: string) {
  return prisma.$transaction(async (tx) => {
    const entry = await findEntryForUser(user, id, tx);
    if (entry.approvalStatus !== "DRAFT" && entry.approvalStatus !== "REJECTED") {
      throw AppError.conflict(`Entry is already ${entry.approvalStatus.toLowerCase()}`);
    }
    const after = await tx.ledgerEntry.update({ where: { id }, data: { approvalStatus: "SUBMITTED" } });
    await logActivity(tx, { actorId: user.id, action: "submit", tableName: "ledger_entries", rowId: id });
    return after;
  });
}

/** HOD approves or rejects — the digital "Signature of HOD". */
export async function decide(user: AuthUser, id: string, input: DecisionInput) {
  return prisma.$transaction(async (tx) => {
    const entry = await findEntryForUser(user, id, tx);
    if (entry.approvalStatus !== "SUBMITTED") throw AppError.conflict("Only submitted entries can be approved or rejected");
    if (entry.createdById === user.id && user.role !== "ADMIN") {
      throw AppError.forbidden("You cannot approve your own entry");
    }
    await tx.approval.create({
      data: { ledgerEntryId: id, approverId: user.id, status: input.decision, comment: input.comment },
    });
    const after = await tx.ledgerEntry.update({ where: { id }, data: { approvalStatus: input.decision } });
    await logActivity(tx, {
      actorId: user.id,
      action: input.decision === "APPROVED" ? "approve" : "reject",
      tableName: "ledger_entries",
      rowId: id,
      after: { comment: input.comment },
    });
    return after;
  });
}
