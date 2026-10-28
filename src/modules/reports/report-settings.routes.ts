import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { prisma } from "../../lib/prisma.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { requireDepartment } from "../../utils/scope.js";

// ─── Schemas ────────────────────────────────────────────────────────────

const optional = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);

const query = z.object({ departmentId: z.uuid().optional() });

const updateSchema = z.object({
  departmentId: z.uuid().optional(),
  expectedVersion: z.number().int().min(0).nullable(), // null when creating
  institution: z.string().trim().max(160),
  faculty: optional(160),
  departmentTitle: z.string().trim().min(2).max(160),
  hodName: optional(120),
  hodDesignation: optional(120),
  checkedByLabel: optional(60),
  footerNote: optional(500),
});

// ─── Handlers ───────────────────────────────────────────────────────────

/** Header and signature text printed on lab audit reports. */
async function get(req: Request, res: Response) {
  const user = currentUser(req);
  const departmentId = requireDepartment(user, query.parse(req.query).departmentId);
  const [settings, department] = await Promise.all([
    prisma.reportSettings.findUnique({ where: { departmentId } }),
    prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, code: true, name: true } }),
  ]);
  if (!department) throw AppError.notFound("Department");
  res.json({
    data: settings ?? {
      departmentId,
      institution: "",
      faculty: null,
      departmentTitle: department.name,
      hodName: null,
      hodDesignation: "Head of Department",
      checkedByLabel: "Checked by",
      footerNote: null,
      version: null,
    },
  });
}

async function update(req: Request, res: Response) {
  const user = currentUser(req);
  const { departmentId: requested, expectedVersion, ...fields } = updateSchema.parse(req.body);
  const departmentId = requireDepartment(user, requested);

  const saved = await prisma.$transaction(async (tx) => {
    const before = await tx.reportSettings.findUnique({ where: { departmentId } });
    if (!before) {
      if (expectedVersion !== null) throw new AppError(409, "VERSION_CONFLICT", "Settings were removed. Reload and try again.");
      const created = await tx.reportSettings.create({ data: { ...fields, departmentId } });
      await logActivity(tx, { actorId: user.id, action: "create", tableName: "report_settings", rowId: departmentId, after: created });
      return created;
    }
    const done = await tx.reportSettings.updateMany({
      where: { departmentId, version: expectedVersion ?? -1 },
      data: { ...fields, version: { increment: 1 } },
    });
    if (!done.count) throw new AppError(409, "VERSION_CONFLICT", "Someone else changed these settings. Reload and try again.");
    const after = await tx.reportSettings.findUniqueOrThrow({ where: { departmentId } });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "report_settings", rowId: departmentId, before, after });
    return after;
  });
  res.json({ data: saved });
}

// ─── Routes ─────────────────────────────────────────────────────────────

export const reportSettingsRoutes = Router();
reportSettingsRoutes.get("/", get);
reportSettingsRoutes.patch("/", authorize("ADMIN", "HOD"), update);
