/**
 * One-off: UPS becomes optional equipment instead of something every PC has.
 *
 *  1. The UPS type stops being a default, so new PCs no longer get one.
 *  2. Auto-created UPS placeholders are retired (kept for history, never
 *     deleted): live UPS items with no serial, brand, model, notes or ledger
 *     link, which is everything the generator creates.
 *  3. Their checks are removed from open audits (draft / submitted / returned).
 *     Approved audits are never touched.
 *
 * Real UPSs are then added back on the PCs that have one (room page → PC →
 * Add equipment). Safe to run again: it only acts on what is still left.
 *
 * Usage:  npx tsx --env-file=.env prisma/scripts/make-ups-optional.ts            (preview)
 *         npx tsx --env-file=.env prisma/scripts/make-ups-optional.ts --apply    (write)
 */
import { prisma } from "../../src/lib/prisma.js";
import { logActivity } from "../../src/utils/activity-log.js";

const OPEN = ["DRAFT", "SUBMITTED", "RETURNED"] as const;
const REASON = "Auto-created placeholder: UPS is optional equipment";

async function main() {
  const apply = process.argv.includes("--apply");
  const type = await prisma.equipmentType.findUnique({ where: { code: "UPS" } });
  if (!type) throw new Error("No UPS equipment type found");

  const placeholders = await prisma.equipment.findMany({
    where: { typeId: type.id, state: { not: "RETIRED" }, serialNo: null, brand: null, modelNo: null, notes: null, assetItemId: null },
    select: { id: true, code: true },
    orderBy: { code: "asc" },
  });
  const ids = placeholders.map((e) => e.id);
  const kept = await prisma.equipment.count({ where: { typeId: type.id, state: { not: "RETIRED" }, id: { notIn: ids } } });
  const openChecks = await prisma.labAuditCheck.findMany({
    where: { equipmentId: { in: ids }, audit: { status: { in: [...OPEN] } } },
    select: { id: true, status: true, audit: { select: { reference: true } } },
  });
  const byAudit = new Map<string, Record<string, number>>();
  for (const c of openChecks) {
    const counts = byAudit.get(c.audit.reference) ?? {};
    counts[c.status] = (counts[c.status] ?? 0) + 1;
    byAudit.set(c.audit.reference, counts);
  }
  const closedChecks = await prisma.labAuditCheck.count({ where: { equipmentId: { in: ids }, audit: { status: { notIn: [...OPEN] } } } });

  console.log(`UPS type default: ${type.isDefault} → false`);
  console.log(`UPS placeholders to retire: ${placeholders.length}${placeholders.length ? ` (${placeholders[0]!.code} … ${placeholders.at(-1)!.code})` : ""}`);
  console.log(`UPS items kept (have serial/brand/model/notes/ledger link): ${kept}`);
  console.log(`Checks to remove from open audits: ${openChecks.length}`, Object.fromEntries(byAudit));
  console.log(`Checks in approved audits (left as they are): ${closedChecks}`);
  if (!apply) {
    console.log("\nPreview only. Run again with --apply to make these changes.");
    return;
  }

  const admin = await prisma.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  await prisma.$transaction(
    async (tx) => {
      await tx.equipmentType.update({ where: { id: type.id }, data: { isDefault: false } });
      if (openChecks.length) await tx.labAuditCheck.deleteMany({ where: { id: { in: openChecks.map((c) => c.id) } } });
      // Same fields the app's own Retire sets, so codes and slots are freed.
      const retired = await tx.equipment.updateMany({
        where: { id: { in: ids }, state: { not: "RETIRED" } },
        data: { state: "RETIRED", retiredAt: new Date(), retiredReason: REASON, activeCodeKey: null, activeSlotKey: null, activeAssetKey: null, version: { increment: 1 } },
      });
      await logActivity(tx, {
        actorId: admin?.id ?? null,
        action: "make_ups_optional",
        tableName: "equipment_types",
        rowId: type.id,
        before: { isDefault: type.isDefault },
        after: { isDefault: false, retired: placeholders.map((e) => e.code), removedOpenChecks: openChecks.length },
      });
      console.log(`\nDone: UPS no longer default, ${retired.count} placeholders retired, ${openChecks.length} open-audit checks removed.`);
    },
    { timeout: 60_000 },
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
