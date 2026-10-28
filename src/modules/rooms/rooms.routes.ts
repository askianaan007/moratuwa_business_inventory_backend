import { Router, type Request, type Response } from "express";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import {
  createRoomSchema,
  createWorkstationSchema,
  idParams,
  layoutSchema,
  listRoomsQuery,
  moveWorkstationSchema,
  renumberSchema,
  retireWorkstationSchema,
  updateRoomSchema,
  updateWorkstationSchema,
} from "./rooms.schema.js";
import * as rooms from "./rooms.service.js";

// Layout and PC placement are set up by admins and HODs (repot-v2 §8).
const configurers = authorize("ADMIN", "HOD");

// ─── Handlers ───────────────────────────────────────────────────────────

async function list(req: Request, res: Response) {
  res.json({ data: await rooms.list(currentUser(req), listRoomsQuery.parse(req.query)) });
}

async function get(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.get(currentUser(req), id) });
}

async function create(req: Request, res: Response) {
  res.status(201).json({ data: await rooms.create(currentUser(req), createRoomSchema.parse(req.body)) });
}

async function update(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.update(currentUser(req), id, updateRoomSchema.parse(req.body)) });
}

async function previewLayout(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.previewLayout(currentUser(req), id, layoutSchema.parse(req.body)) });
}

async function applyLayout(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.applyLayout(currentUser(req), id, layoutSchema.parse(req.body)) });
}

async function previewRenumber(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.previewRenumber(currentUser(req), id) });
}

async function applyRenumber(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const { expectedLayoutVersion } = renumberSchema.parse(req.body);
  res.json({ data: await rooms.applyRenumber(currentUser(req), id, expectedLayoutVersion) });
}

async function createWorkstation(req: Request, res: Response) {
  res.status(201).json({ data: await rooms.createWorkstation(currentUser(req), createWorkstationSchema.parse(req.body)) });
}

async function updateWorkstation(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.updateWorkstation(currentUser(req), id, updateWorkstationSchema.parse(req.body)) });
}

async function moveWorkstation(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.moveWorkstation(currentUser(req), id, moveWorkstationSchema.parse(req.body)) });
}

async function retireWorkstation(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await rooms.retireWorkstation(currentUser(req), id, retireWorkstationSchema.parse(req.body)) });
}

// ─── Routes ─────────────────────────────────────────────────────────────

export const roomsRoutes = Router();
roomsRoutes.get("/", list);
roomsRoutes.post("/", configurers, create);
roomsRoutes.get("/:id", get);
roomsRoutes.patch("/:id", configurers, update);
roomsRoutes.post("/:id/layout/preview", configurers, previewLayout);
roomsRoutes.post("/:id/layout", configurers, applyLayout);
roomsRoutes.post("/:id/renumber/preview", configurers, previewRenumber);
roomsRoutes.post("/:id/renumber", configurers, applyRenumber);

export const workstationsRoutes = Router();
workstationsRoutes.post("/", configurers, createWorkstation);
workstationsRoutes.patch("/:id", configurers, updateWorkstation);
workstationsRoutes.post("/:id/move", configurers, moveWorkstation);
workstationsRoutes.post("/:id/retire", configurers, retireWorkstation);
