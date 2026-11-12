import { z } from "zod";
import { BookStatus, ItemCondition, ItemStatus, RoomType } from "../../generated/prisma/client.js";
import { paginationSchema } from "../../utils/pagination.js";

export const idParams = z.object({ id: z.uuid() });

const reason = z.string().trim().min(3, "Give a reason (at least 3 characters)").max(500);
const optionalText = (max: number) => z.string().trim().max(max).nullish();

/** Filters shared by the asset list, the CSV export and the label sheet. */
export const assetFilterSchema = z.object({
  departmentId: z.uuid().optional(),
  q: z.string().trim().max(120).optional(),
  categoryId: z.uuid().optional(),
  /** A location id, or "none" for items with no recorded location. */
  locationId: z.union([z.uuid(), z.literal("none")]).optional(),
  building: z.string().trim().max(120).optional(),
  status: z.enum(ItemStatus).optional(),
  condition: z.enum(ItemCondition).optional(),
  bookStatus: z.enum(BookStatus).optional(),
  kind: z.enum(["individual", "bulk"]).optional(),
  /** Disposed items are hidden unless asked for (they stay searchable). */
  includeDisposed: z.stringbool().default(false),
});

export const listAssetsQuery = assetFilterSchema.extend(paginationSchema.shape).extend({
  sort: z.enum(["tag", "-tag", "description", "location", "-updated", "condition"]).default("tag"),
});

export const exportQuery = assetFilterSchema;

export const labelsQuery = assetFilterSchema.extend({
  /** Comma-separated item ids; overrides the filters when given. */
  ids: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.uuid()).max(500).optional()),
  size: z.enum(["small", "large"]).default("small"),
});

export const updateAssetSchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime(),
    serialNo: optionalText(120),
    custodian: optionalText(120),
    condition: z.enum(ItemCondition),
    // Disposal and transfers have their own workflows.
    status: z.enum(ItemStatus).exclude(["DISPOSED"]),
    bulkQty: z.number().int().min(1).max(100000),
    note: optionalText(500),
  })
  .partial()
  .required({ expectedUpdatedAt: true });

export const TRANSFER_TYPES = ["ROOM_TO_ROOM", "TO_STORE", "FROM_STORE", "TO_REPAIR", "RETURN_FROM_REPAIR", "LOAN", "RETURN_FROM_LOAN"] as const;

export const transferSchema = z.object({
  ids: z.array(z.uuid()).min(1, "Pick at least one item").max(200, "Transfer at most 200 items at a time"),
  toLocationId: z.uuid({ error: "Pick the destination room" }),
  type: z.enum(TRANSFER_TYPES).default("ROOM_TO_ROOM"),
  reason,
});

export const disposeSchema = z.object({
  expectedUpdatedAt: z.iso.datetime(),
  reason,
  boardRef: z.string().trim().max(80).nullish(),
});

export const deleteSchema = z.object({ reason });

export const findingSchema = z.object({
  observedLocationId: z.uuid({ error: "Pick where the item was found" }),
  note: optionalText(500),
});

// ─── Rooms / locations ──────────────────────────────────────────────────

const locationCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{2,30}$/, "Use 2–30 letters, numbers and dashes, e.g. FB-LH-01");

export const listRoomsQuery = z.object({
  departmentId: z.uuid().optional(),
  q: z.string().trim().max(120).optional(),
  roomType: z.enum(RoomType).optional(),
  building: z.string().trim().max(120).optional(),
});

export const createRoomSchema = z.object({
  departmentId: z.uuid().optional(),
  code: locationCode,
  name: z.string().trim().min(2, "Name is too short").max(120),
  building: optionalText(120),
  floor: optionalText(30),
  roomType: z.enum(RoomType).default("OTHER"),
});

export const updateRoomSchema = createRoomSchema.omit({ departmentId: true }).partial().extend({ expectedUpdatedAt: z.iso.datetime() });

export const movementsQuery = paginationSchema.extend({
  departmentId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  q: z.string().trim().max(120).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export const summaryQuery = z.object({ departmentId: z.uuid().optional(), building: z.string().trim().max(120).optional() });

export type AssetFilter = z.infer<typeof assetFilterSchema>;
export type ListAssetsQuery = z.infer<typeof listAssetsQuery>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
export type TransferInput = z.infer<typeof transferSchema>;
export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type UpdateRoomInput = z.infer<typeof updateRoomSchema>;
export type MovementsQuery = z.infer<typeof movementsQuery>;
