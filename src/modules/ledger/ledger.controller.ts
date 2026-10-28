import type { Request, Response } from "express";
import { currentUser } from "../../middlewares/authenticate.js";
import {
  createLedgerEntrySchema,
  decisionSchema,
  idParams,
  listLedgerQuery,
  markWrittenSchema,
  updateLedgerEntrySchema,
} from "./ledger.schema.js";
import * as ledgerService from "./ledger.service.js";

export async function list(req: Request, res: Response) {
  res.json(await ledgerService.list(currentUser(req), listLedgerQuery.parse(req.query)));
}

export async function get(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await ledgerService.get(currentUser(req), id) });
}

export async function create(req: Request, res: Response) {
  const entry = await ledgerService.create(currentUser(req), createLedgerEntrySchema.parse(req.body));
  res.status(201).json({ data: entry });
}

export async function update(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await ledgerService.update(currentUser(req), id, updateLedgerEntrySchema.parse(req.body)) });
}

export async function remove(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  await ledgerService.remove(currentUser(req), id);
  res.status(204).end();
}

export async function markWritten(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await ledgerService.markWrittenInBook(currentUser(req), id, markWrittenSchema.parse(req.body)) });
}

export async function submit(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await ledgerService.submit(currentUser(req), id) });
}

export async function decide(req: Request, res: Response) {
  const { id } = idParams.parse(req.params);
  res.json({ data: await ledgerService.decide(currentUser(req), id, decisionSchema.parse(req.body)) });
}
