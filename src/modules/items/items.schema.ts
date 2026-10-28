import { z } from "zod";
import { ItemCondition, ItemStatus } from "../../generated/prisma/client.js";

export const idParams = z.object({ id: z.uuid() });

export const tagParams = z.object({
  tagCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{5,40}$/, "Invalid tag code"),
});

export const updateItemSchema = z
  .object({
    serialNo: z.string().trim().max(120).nullable(),
    custodian: z.string().trim().max(120).nullable(),
    condition: z.enum(ItemCondition),
    // Disposal has its own workflow; it cannot be set directly.
    status: z.enum(ItemStatus).exclude(["DISPOSED"]),
  })
  .partial();

export const moveItemSchema = z.object({
  toLocationId: z.uuid(),
  reason: z.string().trim().max(500).optional(),
});

export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type MoveItemInput = z.infer<typeof moveItemSchema>;
