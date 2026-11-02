import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { assertInScope, departmentScope, requireDepartment } from "../../utils/scope.js";
import type { CreateListInput, UnitInput, UpdateListInput } from "./serial-lists.schema.js";

type Tx = Prisma.TransactionClient;

const unitInclude = {
  components: { orderBy: { sortOrder: "asc" } },
} satisfies Prisma.SerialUnitInclude;

/** Loads a live list the user may see (404 for other departments). */
async function loadList(user: AuthUser, id: string, db: Tx | typeof prisma = prisma) {
  const list = await db.serialList.findFirst({ where: { id, deletedAt: null } });
  if (!list) throw AppError.notFound("Serial list");
  assertInScope(user, list.departmentId, "Serial list");
  return list;
}

/**
 * A serial number may appear only once per list. Barcode readers make double
 * scans easy, so name the unit that already has it.
 */
async function assertNoDuplicates(tx: Tx, listId: string, input: UnitInput, exceptUnitId?: string) {
  const existing = await tx.serialComponent.findMany({
    where: {
      unit: { listId, ...(exceptUnitId && { id: { not: exceptUnitId } }) },
      OR: input.components.map((c) => ({ serialNo: { equals: c.serialNo, mode: "insensitive" as const } })),
    },
    select: { serialNo: true, kind: true, unit: { select: { productNumber: true, label: true } } },
  });
  if (!existing.length) return;

  const taken = new Map(existing.map((e) => [e.serialNo.toUpperCase(), e]));
  const details = input.components.flatMap((c, i) => {
    const hit = taken.get(c.serialNo.toUpperCase());
    return hit
      ? [{ path: `components.${i}.serialNo`, message: `Already in this list: ${hit.kind} of ${hit.unit.label ?? hit.unit.productNumber}` }]
      : [];
  });
  throw new AppError(409, "DUPLICATE_SERIAL", "A serial number is already in this list", details);
}

const componentRows = (input: UnitInput) =>
  input.components.map((c, i) => ({ kind: c.kind, serialNo: c.serialNo, brand: c.brand, model: c.model, sortOrder: i }));

// ─── Lists ──────────────────────────────────────────────────────────────

export async function list(user: AuthUser, requestedDepartment?: string) {
  const departmentId = departmentScope(user, requestedDepartment);
  const lists = await prisma.serialList.findMany({
    where: { deletedAt: null, ...(departmentId && { departmentId }) },
    orderBy: { updatedAt: "desc" },
    include: {
      createdBy: { select: { name: true } },
      _count: { select: { units: true } },
    },
  });
  const partCounts = new Map<string, number>();
  if (lists.length) {
    const rows = await prisma.serialComponent.findMany({
      where: { unit: { listId: { in: lists.map((l) => l.id) } } },
      select: { unit: { select: { listId: true } } },
    });
    for (const row of rows) partCounts.set(row.unit.listId, (partCounts.get(row.unit.listId) ?? 0) + 1);
  }
  return lists.map(({ _count, ...l }) => ({ ...l, units: _count.units, parts: partCounts.get(l.id) ?? 0 }));
}

export async function get(user: AuthUser, id: string) {
  await loadList(user, id);
  return prisma.serialList.findUniqueOrThrow({
    where: { id },
    include: {
      createdBy: { select: { name: true } },
      department: { select: { id: true, code: true, name: true } },
      units: { orderBy: { sortOrder: "asc" }, include: unitInclude },
    },
  });
}

export async function create(user: AuthUser, input: CreateListInput) {
  const { departmentId: requested, ...fields } = input;
  const departmentId = requireDepartment(user, requested);
  return prisma.$transaction(async (tx) => {
    const created = await tx.serialList.create({ data: { ...fields, departmentId, createdById: user.id } });
    await logActivity(tx, { actorId: user.id, action: "create", tableName: "serial_lists", rowId: created.id, after: created });
    return created;
  });
}

export async function update(user: AuthUser, id: string, input: UpdateListInput) {
  return prisma.$transaction(async (tx) => {
    const before = await loadList(user, id, tx);
    const after = await tx.serialList.update({ where: { id }, data: input });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "serial_lists", rowId: id, before, after });
    return after;
  });
}

/** Soft delete: the rows stay for the activity log. */
export async function remove(user: AuthUser, id: string) {
  await prisma.$transaction(async (tx) => {
    const before = await loadList(user, id, tx);
    await tx.serialList.update({ where: { id }, data: { deletedAt: new Date() } });
    await logActivity(tx, { actorId: user.id, action: "delete", tableName: "serial_lists", rowId: id, before });
  });
}

// ─── Units ──────────────────────────────────────────────────────────────

export async function addUnit(user: AuthUser, listId: string, input: UnitInput) {
  return prisma.$transaction(async (tx) => {
    await loadList(user, listId, tx);
    await assertNoDuplicates(tx, listId, input);
    const last = await tx.serialUnit.aggregate({ where: { listId }, _max: { sortOrder: true } });
    const unit = await tx.serialUnit.create({
      data: {
        listId,
        productNumber: input.productNumber,
        label: input.label,
        sortOrder: (last._max.sortOrder ?? 0) + 1,
        components: { create: componentRows(input) },
      },
      include: unitInclude,
    });
    await tx.serialList.update({ where: { id: listId }, data: { updatedAt: new Date() } });
    await logActivity(tx, { actorId: user.id, action: "create", tableName: "serial_units", rowId: unit.id, after: unit });
    return unit;
  });
}

export async function updateUnit(user: AuthUser, listId: string, unitId: string, input: UnitInput) {
  return prisma.$transaction(async (tx) => {
    await loadList(user, listId, tx);
    const before = await tx.serialUnit.findFirst({ where: { id: unitId, listId }, include: unitInclude });
    if (!before) throw AppError.notFound("Unit");
    await assertNoDuplicates(tx, listId, input, unitId);
    await tx.serialComponent.deleteMany({ where: { unitId } });
    const after = await tx.serialUnit.update({
      where: { id: unitId },
      data: { productNumber: input.productNumber, label: input.label, components: { create: componentRows(input) } },
      include: unitInclude,
    });
    await tx.serialList.update({ where: { id: listId }, data: { updatedAt: new Date() } });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "serial_units", rowId: unitId, before, after });
    return after;
  });
}

export async function removeUnit(user: AuthUser, listId: string, unitId: string) {
  await prisma.$transaction(async (tx) => {
    await loadList(user, listId, tx);
    const before = await tx.serialUnit.findFirst({ where: { id: unitId, listId }, include: unitInclude });
    if (!before) throw AppError.notFound("Unit");
    await tx.serialUnit.delete({ where: { id: unitId } });
    await tx.serialList.update({ where: { id: listId }, data: { updatedAt: new Date() } });
    await logActivity(tx, { actorId: user.id, action: "delete", tableName: "serial_units", rowId: unitId, before });
  });
}

// ─── Report ─────────────────────────────────────────────────────────────

/** Everything the PDF needs, including the department's report header. */
export async function reportData(user: AuthUser, id: string) {
  const detail = await get(user, id);
  const settings = await prisma.reportSettings.findUnique({ where: { departmentId: detail.departmentId } });
  return {
    list: detail,
    settings: {
      institution: settings?.institution ?? "",
      faculty: settings?.faculty ?? null,
      departmentTitle: settings?.departmentTitle ?? detail.department.name,
      hodName: settings?.hodName ?? null,
      hodDesignation: settings?.hodDesignation ?? "Head of Department",
      checkedByLabel: settings?.checkedByLabel ?? "Checked by",
      footerNote: settings?.footerNote ?? null,
    },
    preparedBy: user.name,
    generatedAt: new Date().toISOString(),
  };
}

export type SerialReportData = Awaited<ReturnType<typeof reportData>>;
