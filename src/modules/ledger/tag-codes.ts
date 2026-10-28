import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";

/**
 * Reserves `count` consecutive tag numbers for a department and year and
 * returns the tag codes, e.g. UOM-ELEC-2026-00001. The counter row is updated
 * atomically inside the caller's transaction, so concurrent requests never
 * receive the same number.
 */
export async function allocateTagCodes(
  tx: Prisma.TransactionClient,
  department: { id: string; code: string },
  count: number,
): Promise<string[]> {
  const year = new Date().getFullYear();
  const counter = await tx.tagCounter.upsert({
    where: { departmentId_year: { departmentId: department.id, year } },
    create: { departmentId: department.id, year, last: count },
    update: { last: { increment: count } },
  });

  const first = counter.last - count + 1;
  return Array.from(
    { length: count },
    (_, i) => `${env.TAG_PREFIX}-${department.code}-${year}-${String(first + i).padStart(5, "0")}`,
  );
}
