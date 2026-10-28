import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { prisma } from "../../lib/prisma.js";
import { logActivity } from "../../utils/activity-log.js";
import { departmentScope, requireDepartment } from "../../utils/scope.js";

// ─── Schemas ────────────────────────────────────────────────────────────

const createDepartmentSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{2,10}$/, "Use 2–10 letters/numbers, e.g. ELEC"),
  name: z.string().trim().min(2).max(120),
});

const listLocationsQuery = z.object({ departmentId: z.uuid().optional() });

const createLocationSchema = z.object({
  departmentId: z.uuid().optional(),
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,30}$/, "Use letters, numbers and dashes, e.g. ELEC-LAB-02"),
  name: z.string().trim().min(2).max(120),
  building: z.string().trim().max(120).optional(),
  floor: z.string().trim().max(30).optional(),
});

// ─── Handlers ───────────────────────────────────────────────────────────

async function listDepartments(req: Request, res: Response) {
  const user = currentUser(req);
  const departmentId = departmentScope(user);
  const departments = await prisma.department.findMany({
    where: departmentId ? { id: departmentId } : {},
    orderBy: { name: "asc" },
    select: { id: true, code: true, name: true },
  });
  res.json({ data: departments });
}

async function createDepartment(req: Request, res: Response) {
  const actor = currentUser(req);
  const input = createDepartmentSchema.parse(req.body);
  const department = await prisma.$transaction(async (tx) => {
    const created = await tx.department.create({ data: input });
    await logActivity(tx, { actorId: actor.id, action: "create", tableName: "departments", rowId: created.id, after: created });
    return created;
  });
  res.status(201).json({ data: department });
}

async function listLocations(req: Request, res: Response) {
  const user = currentUser(req);
  const { departmentId } = listLocationsQuery.parse(req.query);
  const scope = departmentScope(user, departmentId);
  const locations = await prisma.location.findMany({
    where: { deletedAt: null, ...(scope ? { departmentId: scope } : {}) },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, building: true, floor: true, departmentId: true },
  });
  res.json({ data: locations });
}

async function createLocation(req: Request, res: Response) {
  const actor = currentUser(req);
  const { departmentId: requested, ...input } = createLocationSchema.parse(req.body);
  const departmentId = requireDepartment(actor, requested);
  const location = await prisma.$transaction(async (tx) => {
    const created = await tx.location.create({ data: { ...input, departmentId } });
    await logActivity(tx, { actorId: actor.id, action: "create", tableName: "locations", rowId: created.id, after: created });
    return created;
  });
  res.status(201).json({ data: location });
}

// ─── Routes ─────────────────────────────────────────────────────────────

export const organisationRoutes = Router();
organisationRoutes.get("/departments", listDepartments);
organisationRoutes.post("/departments", authorize("ADMIN"), createDepartment);
organisationRoutes.get("/locations", listLocations);
organisationRoutes.post("/locations", authorize("ADMIN", "HOD", "TECHNICAL_OFFICER"), createLocation);
