import type { Request, Response } from "express";
import { currentUser } from "../../middlewares/authenticate.js";
import { idParams, moveItemSchema, tagParams, updateItemSchema } from "./items.schema.js";
import * as itemsService from "./items.service.js";

export async function getByTag(req: Request, res: Response) {
  const { tagCode } = tagParams.parse(req.params);
  res.json({ data: await itemsService.getByTag(currentUser(req), tagCode) });
}

export async function get(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await itemsService.get(currentUser(req), id) });
}

export async function update(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await itemsService.update(currentUser(req), id, updateItemSchema.parse(req.body)) });
}

export async function move(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.status(201).json({ data: await itemsService.move(currentUser(req), id, moveItemSchema.parse(req.body)) });
}
