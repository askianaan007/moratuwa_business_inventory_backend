import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

type Db = Prisma.TransactionClient | typeof prisma;

interface ActivityInput {
  actorId: string | null;
  action: string;
  tableName: string;
  rowId: string;
  before?: unknown;
  after?: unknown;
}

/** Converts Decimals/Dates to plain JSON for storage. */
const toJson = (value: unknown) =>
  value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);

/** Appends to the immutable activity log. Pass the transaction client when inside one. */
export function logActivity(db: Db, input: ActivityInput) {
  return db.activityLog.create({
    data: {
      actorId: input.actorId,
      action: input.action,
      tableName: input.tableName,
      rowId: input.rowId,
      before: toJson(input.before),
      after: toJson(input.after),
    },
  });
}
