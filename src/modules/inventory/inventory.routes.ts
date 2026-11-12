import { Router, type Request, type Response } from "express";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { assetsCsv, labelsPdf } from "./inventory-export.js";
import {
  createRoomSchema,
  deleteSchema,
  disposeSchema,
  exportQuery,
  findingSchema,
  idParams,
  labelsQuery,
  listAssetsQuery,
  listRoomsQuery,
  movementsQuery,
  summaryQuery,
  transferSchema,
  updateAssetSchema,
  updateRoomSchema,
} from "./inventory.schema.js";
import * as inventory from "./inventory.service.js";

const editors = authorize("ADMIN", "HOD", "TECHNICAL_OFFICER");
const approvers = authorize("ADMIN", "HOD");
const admins = authorize("ADMIN");

// ─── Handlers ───────────────────────────────────────────────────────────

async function summary(req: Request, res: Response) {
  res.json({ data: await inventory.summary(currentUser(req), summaryQuery.parse(req.query)) });
}

async function listAssets(req: Request, res: Response) {
  res.json(await inventory.listAssets(currentUser(req), listAssetsQuery.parse(req.query)));
}

async function exportAssets(req: Request, res: Response) {
  const where = inventory.assetWhere(currentUser(req), exportQuery.parse(req.query));
  const { csv, count, truncated } = await assetsCsv(where);
  res
    .status(200)
    .type("text/csv; charset=utf-8")
    .setHeader("Content-Disposition", `attachment; filename="asset-register-${new Date().toISOString().slice(0, 10)}.csv"`)
    .setHeader("X-Row-Count", String(count))
    .setHeader("X-Truncated", String(truncated))
    .send(csv);
}

async function labels(req: Request, res: Response) {
  const user = currentUser(req);
  const query = labelsQuery.parse(req.query);
  const where = query.ids ? { ...inventory.assetWhere(user, { includeDisposed: false, departmentId: query.departmentId }), id: { in: query.ids } } : inventory.assetWhere(user, query);
  const { buffer } = await labelsPdf(where, query.size);
  res.status(200).type("application/pdf").setHeader("Content-Disposition", `inline; filename="asset-labels.pdf"`).send(buffer);
}

async function getAsset(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await inventory.getAsset(currentUser(req), id) });
}

async function updateAsset(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await inventory.updateAsset(currentUser(req), id, updateAssetSchema.parse(req.body)) });
}

async function transfer(req: Request, res: Response) {
  res.json({ data: await inventory.transfer(currentUser(req), transferSchema.parse(req.body)) });
}

async function dispose(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await inventory.dispose(currentUser(req), id, disposeSchema.parse(req.body)) });
}

async function deleteAsset(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { reason } = deleteSchema.parse(req.body);
  await inventory.deleteAsset(currentUser(req), id, reason);
  res.status(204).end();
}

async function recordFinding(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.status(201).json({ data: await inventory.recordFinding(currentUser(req), id, findingSchema.parse(req.body)) });
}

async function listFindings(req: Request, res: Response) {
  res.json({ data: await inventory.listFindings(currentUser(req), summaryQuery.parse(req.query)) });
}

async function listRooms(req: Request, res: Response) {
  res.json(await inventory.listRooms(currentUser(req), listRoomsQuery.parse(req.query)));
}

async function getRoom(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await inventory.getRoom(currentUser(req), id) });
}

async function createRoom(req: Request, res: Response) {
  res.status(201).json({ data: await inventory.createRoom(currentUser(req), createRoomSchema.parse(req.body)) });
}

async function updateRoom(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await inventory.updateRoom(currentUser(req), id, updateRoomSchema.parse(req.body)) });
}

async function archiveRoom(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  await inventory.archiveRoom(currentUser(req), id);
  res.status(204).end();
}

async function listMovements(req: Request, res: Response) {
  res.json(await inventory.listMovements(currentUser(req), movementsQuery.parse(req.query)));
}

// ─── Routes ─────────────────────────────────────────────────────────────

export const inventoryRoutes = Router();
inventoryRoutes.get("/summary", summary);
inventoryRoutes.get("/assets", listAssets);
inventoryRoutes.get("/assets.csv", exportAssets);
inventoryRoutes.get("/labels.pdf", labels);
inventoryRoutes.post("/transfers", editors, transfer);
inventoryRoutes.get("/transfers", listMovements);
inventoryRoutes.get("/findings", listFindings);
inventoryRoutes.get("/assets/:id", getAsset);
inventoryRoutes.patch("/assets/:id", editors, updateAsset);
inventoryRoutes.post("/assets/:id/dispose", approvers, dispose);
inventoryRoutes.post("/assets/:id/findings", editors, recordFinding);
inventoryRoutes.delete("/assets/:id", admins, deleteAsset);
inventoryRoutes.get("/rooms", listRooms);
inventoryRoutes.post("/rooms", approvers, createRoom);
inventoryRoutes.get("/rooms/:id", getRoom);
inventoryRoutes.patch("/rooms/:id", approvers, updateRoom);
inventoryRoutes.delete("/rooms/:id", approvers, archiveRoom);
