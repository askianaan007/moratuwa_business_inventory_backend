import { Router, type Request, type Response } from "express";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { prisma } from "../../lib/prisma.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import {
  createEquipmentSchema,
  createReasonSchema,
  createTypeSchema,
  generateQuery,
  idParams,
  linkAssetSchema,
  listEquipmentQuery,
  listReasonsQuery,
  moveEquipmentSchema,
  replaceEquipmentSchema,
  returnSchema,
  roomParams,
  stateChangeSchema,
  unlinkAssetSchema,
  updateEquipmentSchema,
  updateReasonSchema,
  updateTypeSchema,
} from "./equipment.schema.js";
import * as equipment from "./equipment.service.js";

const editors = authorize("ADMIN", "HOD", "TECHNICAL_OFFICER");
const configurers = authorize("ADMIN", "HOD");
const admins = authorize("ADMIN");

// ─── Equipment ──────────────────────────────────────────────────────────

async function listForRoom(req: Request, res: Response) {
  const { roomId } = roomParams.parse(req.params);
  const { includeRetired } = listEquipmentQuery.parse(req.query);
  res.json({ data: await equipment.listForRoom(currentUser(req), roomId, includeRetired) });
}

async function create(req: Request, res: Response) {
  const { roomId } = roomParams.parse(req.params);
  const { item, warnings } = await equipment.create(currentUser(req), roomId, createEquipmentSchema.parse(req.body));
  res.status(201).json({ data: item, meta: { warnings } });
}

async function generate(req: Request, res: Response) {
  const { roomId } = roomParams.parse(req.params);
  const { dryRun } = generateQuery.parse(req.query);
  res.json({ data: await equipment.generate(currentUser(req), roomId, dryRun) });
}

async function update(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await equipment.update(currentUser(req), id, updateEquipmentSchema.parse(req.body)) });
}

async function replace(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { item, warnings } = await equipment.replace(currentUser(req), id, replaceEquipmentSchema.parse(req.body));
  res.status(201).json({ data: item, meta: { warnings } });
}

async function move(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await equipment.move(currentUser(req), id, moveEquipmentSchema.parse(req.body)) });
}

async function repair(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await equipment.sendToRepair(currentUser(req), id, stateChangeSchema.parse(req.body)) });
}

async function returnFromRepair(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await equipment.returnFromRepair(currentUser(req), id, returnSchema.parse(req.body)) });
}

async function retire(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await equipment.retire(currentUser(req), id, stateChangeSchema.parse(req.body)) });
}

async function linkAsset(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { item, warnings } = await equipment.linkAsset(currentUser(req), id, linkAssetSchema.parse(req.body));
  res.json({ data: item, meta: { warnings } });
}

async function unlinkAsset(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await equipment.unlinkAsset(currentUser(req), id, unlinkAssetSchema.parse(req.body)) });
}

async function history(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await equipment.history(currentUser(req), id) });
}

export const roomEquipmentRoutes = Router({ mergeParams: true });
roomEquipmentRoutes.get("/", listForRoom);
roomEquipmentRoutes.post("/", editors, create);
roomEquipmentRoutes.post("/generate", configurers, generate);

export const equipmentRoutes = Router();
equipmentRoutes.patch("/:id", editors, update);
equipmentRoutes.get("/:id/history", history);
equipmentRoutes.post("/:id/replace", editors, replace);
equipmentRoutes.post("/:id/move", editors, move);
equipmentRoutes.post("/:id/repair", editors, repair);
equipmentRoutes.post("/:id/return", editors, returnFromRepair);
equipmentRoutes.post("/:id/retire", editors, retire);
equipmentRoutes.post("/:id/link-asset", editors, linkAsset);
equipmentRoutes.post("/:id/unlink-asset", editors, unlinkAsset);

// ─── Equipment types (global, like categories) ──────────────────────────

async function listTypes(_req: Request, res: Response) {
  const types = await prisma.equipmentType.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { category: { select: { id: true, code: true, name: true } } },
  });
  res.json({ data: types });
}

/** Only one type may name the PC; switching it moves the flag in one transaction. */
async function clearOtherPrimary(tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0], keepId: string) {
  await tx.equipmentType.updateMany({ where: { isPrimary: true, id: { not: keepId } }, data: { isPrimary: false } });
}

async function createType(req: Request, res: Response) {
  const actor = currentUser(req);
  const input = createTypeSchema.parse(req.body);
  const type = await prisma.$transaction(async (tx) => {
    const created = await tx.equipmentType.create({ data: input });
    if (created.isPrimary) await clearOtherPrimary(tx, created.id);
    await logActivity(tx, { actorId: actor.id, action: "create", tableName: "equipment_types", rowId: created.id, after: created });
    return created;
  });
  res.status(201).json({ data: type });
}

async function updateType(req: Request, res: Response) {
  const actor = currentUser(req);
  const { id } = idParams.parse(req.params);
  const input = updateTypeSchema.parse(req.body);
  const type = await prisma.$transaction(async (tx) => {
    const before = await tx.equipmentType.findUnique({ where: { id } });
    if (!before) throw AppError.notFound("Equipment type");
    const after = await tx.equipmentType.update({ where: { id }, data: input });
    if (after.isPrimary) await clearOtherPrimary(tx, id);
    await logActivity(tx, { actorId: actor.id, action: "update", tableName: "equipment_types", rowId: id, before, after });
    return after;
  });
  res.json({ data: type });
}

export const equipmentTypesRoutes = Router();
equipmentTypesRoutes.get("/", listTypes);
equipmentTypesRoutes.post("/", admins, createType);
equipmentTypesRoutes.patch("/:id", admins, updateType);

// ─── Fault reasons ──────────────────────────────────────────────────────

async function listReasons(req: Request, res: Response) {
  const query = listReasonsQuery.parse(req.query);
  const reasons = await prisma.faultReason.findMany({
    where: {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.typeId && { OR: [{ typeId: query.typeId }, { typeId: null }] }),
    },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    select: { id: true, typeId: true, label: true, group: true, sortOrder: true, isActive: true },
  });
  res.json({ data: reasons });
}

async function createReason(req: Request, res: Response) {
  const actor = currentUser(req);
  const input = createReasonSchema.parse(req.body);
  const reason = await prisma.$transaction(async (tx) => {
    const created = await tx.faultReason.create({ data: { ...input, typeId: input.typeId ?? null } });
    await logActivity(tx, { actorId: actor.id, action: "create", tableName: "fault_reasons", rowId: created.id, after: created });
    return created;
  });
  res.status(201).json({ data: reason });
}

/** Reasons are switched off, never deleted, so old audit lines keep their text. */
async function updateReason(req: Request, res: Response) {
  const actor = currentUser(req);
  const { id } = idParams.parse(req.params);
  const input = updateReasonSchema.parse(req.body);
  const reason = await prisma.$transaction(async (tx) => {
    const before = await tx.faultReason.findUnique({ where: { id } });
    if (!before) throw AppError.notFound("Fault reason");
    const after = await tx.faultReason.update({ where: { id }, data: input });
    await logActivity(tx, { actorId: actor.id, action: "update", tableName: "fault_reasons", rowId: id, before, after });
    return after;
  });
  res.json({ data: reason });
}

export const faultReasonsRoutes = Router();
faultReasonsRoutes.get("/", listReasons);
faultReasonsRoutes.post("/", admins, createReason);
faultReasonsRoutes.patch("/:id", admins, updateReason);
