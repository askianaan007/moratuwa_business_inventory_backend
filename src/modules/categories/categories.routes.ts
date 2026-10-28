import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { prisma } from "../../lib/prisma.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { departmentScope } from "../../utils/scope.js";

// ─── Schemas ────────────────────────────────────────────────────────────

const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,15}$/, "Use 2–15 letters, numbers or dashes, e.g. MON");

const createCategorySchema = z.object({
  code,
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional(),
});

/** Deactivate instead of deleting so existing ledger entries keep their category. */
const updateCategorySchema = createCategorySchema.extend({ isActive: z.boolean() }).partial();

const listCategoriesQuery = z.object({
  departmentId: z.uuid().optional(),
  includeInactive: z.stringbool().default(false),
});

const idParams = z.object({ id: z.uuid() });

// ─── Handlers ───────────────────────────────────────────────────────────

/** Categories with a per-category ledger summary (receipts total, entry count) for the user's scope. */
async function list(req: Request, res: Response) {
  const user = currentUser(req);
  const query = listCategoriesQuery.parse(req.query);
  const departmentId = departmentScope(user, query.departmentId);
  const entryWhere = { deletedAt: null, ...(departmentId && { departmentId }) };

  const [categories, entryCounts, receiptTotals] = await Promise.all([
    prisma.category.findMany({
      where: query.includeInactive ? {} : { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, code: true, name: true, description: true, isActive: true },
    }),
    prisma.ledgerEntry.groupBy({ by: ["categoryId"], where: entryWhere, _count: { _all: true } }),
    prisma.ledgerEntry.groupBy({
      by: ["categoryId"],
      where: { ...entryWhere, entryType: "RECEIPT" },
      _sum: { value: true, quantity: true },
    }),
  ]);

  const counts = new Map(entryCounts.map((row) => [row.categoryId, row._count._all]));
  const totals = new Map(receiptTotals.map((row) => [row.categoryId, row._sum]));
  res.json({
    data: categories.map((category) => ({
      ...category,
      entries: counts.get(category.id) ?? 0,
      receivedQuantity: totals.get(category.id)?.quantity ?? 0,
      receivedValue: totals.get(category.id)?.value?.toFixed(2) ?? "0.00",
    })),
  });
}

async function create(req: Request, res: Response) {
  const actor = currentUser(req);
  const input = createCategorySchema.parse(req.body);
  const category = await prisma.$transaction(async (tx) => {
    const created = await tx.category.create({ data: input });
    await logActivity(tx, { actorId: actor.id, action: "create", tableName: "categories", rowId: created.id, after: created });
    return created;
  });
  res.status(201).json({ data: category });
}

async function update(req: Request, res: Response) {
  const actor = currentUser(req);
  const { id } = idParams.parse(req.params);
  const input = updateCategorySchema.parse(req.body);
  const category = await prisma.$transaction(async (tx) => {
    const before = await tx.category.findUnique({ where: { id } });
    if (!before) throw AppError.notFound("Category");
    const after = await tx.category.update({ where: { id }, data: input });
    await logActivity(tx, { actorId: actor.id, action: "update", tableName: "categories", rowId: id, before, after });
    return after;
  });
  res.json({ data: category });
}

// ─── Routes ─────────────────────────────────────────────────────────────

export const categoriesRoutes = Router();
categoriesRoutes.get("/", list);
categoriesRoutes.post("/", authorize("ADMIN"), create);
categoriesRoutes.patch("/:id", authorize("ADMIN"), update);
