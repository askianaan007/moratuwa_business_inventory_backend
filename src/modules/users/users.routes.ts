import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { Role } from "../../generated/prisma/client.js";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { prisma } from "../../lib/prisma.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { hashPassword } from "../../utils/password.js";
import { pageMeta, paginationSchema, toSkipTake } from "../../utils/pagination.js";
import { passwordSchema } from "../auth/auth.schema.js";
import { publicUserSelect } from "../auth/auth.service.js";

// ─── Schemas ────────────────────────────────────────────────────────────

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.email().max(254).transform((email) => email.toLowerCase()),
  role: z.enum(Role),
  departmentId: z.uuid().nullable(),
  password: passwordSchema,
});

const updateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    role: z.enum(Role),
    departmentId: z.uuid().nullable(),
    isActive: z.boolean(),
  })
  .partial();

const idParams = z.object({ id: z.uuid() });

const userSelect = { ...publicUserSelect, isActive: true, lastLoginAt: true, createdAt: true } as const;

// ─── Handlers ───────────────────────────────────────────────────────────

async function list(req: Request, res: Response) {
  const paging = paginationSchema.parse(req.query);
  const [users, total] = await Promise.all([
    prisma.user.findMany({ select: userSelect, orderBy: { name: "asc" }, ...toSkipTake(paging) }),
    prisma.user.count(),
  ]);
  res.json({ data: users, meta: pageMeta(paging, total) });
}

async function create(req: Request, res: Response) {
  const actor = currentUser(req);
  const { password, ...input } = createUserSchema.parse(req.body);
  if (input.role !== "ADMIN" && !input.departmentId) {
    throw AppError.badRequest("Non-admin users must belong to a department");
  }

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: { ...input, passwordHash: await hashPassword(password) },
      select: userSelect,
    });
    await logActivity(tx, { actorId: actor.id, action: "create", tableName: "users", rowId: created.id, after: created });
    return created;
  });
  res.status(201).json({ data: user });
}

async function update(req: Request, res: Response) {
  const actor = currentUser(req);
  const { id } = idParams.parse(req.params);
  const input = updateUserSchema.parse(req.body);
  if (id === actor.id && (input.role || input.isActive === false)) {
    throw AppError.badRequest("You cannot change your own role or deactivate yourself");
  }

  const user = await prisma.$transaction(async (tx) => {
    const before = await tx.user.findUnique({ where: { id }, select: userSelect });
    if (!before) throw AppError.notFound("User");
    const after = await tx.user.update({ where: { id }, data: input, select: userSelect });
    // Deactivation signs the user out everywhere.
    if (input.isActive === false) {
      await tx.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await logActivity(tx, { actorId: actor.id, action: "update", tableName: "users", rowId: id, before, after });
    return after;
  });
  res.json({ data: user });
}

// ─── Routes (admin only) ────────────────────────────────────────────────

export const usersRoutes = Router();
usersRoutes.use(authorize("ADMIN"));
usersRoutes.get("/", list);
usersRoutes.post("/", create);
usersRoutes.patch("/:id", update);
