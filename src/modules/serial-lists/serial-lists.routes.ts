import { Router, type Request, type Response } from "express";
import { authorize, currentUser } from "../../middlewares/authenticate.js";
import { renderSerialListPdf } from "./serial-list-pdf.js";
import { createListSchema, idParams, listQuery, unitParams, unitSchema, updateListSchema } from "./serial-lists.schema.js";
import * as lists from "./serial-lists.service.js";

const editors = authorize("ADMIN", "HOD", "TECHNICAL_OFFICER");

// ─── Handlers ───────────────────────────────────────────────────────────

async function list(req: Request, res: Response) {
  res.json({ data: await lists.list(currentUser(req), listQuery.parse(req.query).departmentId) });
}

async function get(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await lists.get(currentUser(req), id) });
}

async function create(req: Request, res: Response) {
  res.status(201).json({ data: await lists.create(currentUser(req), createListSchema.parse(req.body)) });
}

async function update(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await lists.update(currentUser(req), id, updateListSchema.parse(req.body)) });
}

async function remove(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  await lists.remove(currentUser(req), id);
  res.status(204).end();
}

async function addUnit(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.status(201).json({ data: await lists.addUnit(currentUser(req), id, unitSchema.parse(req.body)) });
}

async function updateUnit(req: Request, res: Response) {
  const { id, unitId } = unitParams.parse(req.params);
  res.json({ data: await lists.updateUnit(currentUser(req), id, unitId, unitSchema.parse(req.body)) });
}

async function removeUnit(req: Request, res: Response) {
  const { id, unitId } = unitParams.parse(req.params);
  await lists.removeUnit(currentUser(req), id, unitId);
  res.status(204).end();
}

async function pdf(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  const data = await lists.reportData(currentUser(req), id);
  const file = await renderSerialListPdf(data);
  const name = `${data.list.title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "serial-list"}.pdf`;
  res
    .status(200)
    .type("application/pdf")
    .setHeader("Content-Disposition", `${req.query.inline === "1" ? "inline" : "attachment"}; filename="${name}"`)
    .send(file);
}

// ─── Routes ─────────────────────────────────────────────────────────────

export const serialListsRoutes = Router();
serialListsRoutes.get("/", list);
serialListsRoutes.post("/", editors, create);
serialListsRoutes.get("/:id", get);
serialListsRoutes.patch("/:id", editors, update);
serialListsRoutes.delete("/:id", editors, remove);
serialListsRoutes.get("/:id/report.pdf", pdf);
serialListsRoutes.post("/:id/units", editors, addUnit);
serialListsRoutes.patch("/:id/units/:unitId", editors, updateUnit);
serialListsRoutes.delete("/:id/units/:unitId", editors, removeUnit);
