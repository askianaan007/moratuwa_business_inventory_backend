import { createHash } from "node:crypto";
import type { LabAuditStatus, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { AuthUser } from "../../types/express.js";
import { logActivity } from "../../utils/activity-log.js";
import { AppError } from "../../utils/app-error.js";
import { pageMeta, toSkipTake } from "../../utils/pagination.js";
import { assertInScope, departmentScope } from "../../utils/scope.js";
import { loadRoomForUser, loadRoomView } from "../rooms/room-view.js";
import { buildReportData, periodKey, STATUSES, type ReportData } from "./lab-audit-report.js";
import { buildTargets, type AuditTarget } from "./lab-audit-targets.js";
import type { BulkInput, CheckChange, ListAuditsQuery, StartAuditInput, UpdateAuditInput } from "./lab-audits.schema.js";

type Tx = Prisma.TransactionClient;

const EDITABLE: LabAuditStatus[] = ["DRAFT", "RETURNED"];
const toPeriod = (yyyyMm: string) => new Date(`${yyyyMm}-01T00:00:00.000Z`);
const todayUtc = () => new Date(new Date().toISOString().slice(0, 10));

const versionConflict = () =>
  new AppError(409, "VERSION_CONFLICT", "This audit was changed by someone else. Reload and try again.");

async function loadAudit(user: AuthUser, id: string, db: Tx | typeof prisma = prisma) {
  const audit = await db.labAudit.findUnique({ where: { id } });
  if (!audit) throw AppError.notFound("Audit");
  assertInScope(user, audit.departmentId, "Audit");
  return audit;
}

function assertEditable(audit: { status: LabAuditStatus }) {
  if (!EDITABLE.includes(audit.status)) {
    throw AppError.locked(`This audit is ${audit.status.toLowerCase()} and can no longer be changed`);
  }
}

/** Bumps the audit version only if nobody else did first. */
async function bumpAudit(tx: Tx, id: string, expectedVersion: number, data: Prisma.LabAuditUncheckedUpdateManyInput = {}) {
  const done = await tx.labAudit.updateMany({ where: { id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
  if (!done.count) throw versionConflict();
}

const progressSelect = { status: true } as const;

function summarize(checks: { status: (typeof STATUSES)[number] }[]) {
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<(typeof STATUSES)[number], number>;
  for (const c of checks) byStatus[c.status]++;
  const total = checks.length;
  const checked = total - byStatus.NOT_CHECKED;
  return { total, checked, completion: total ? Math.floor((checked / total) * 100) : 100, byStatus };
}

// ─── Reading ────────────────────────────────────────────────────────────

export async function list(user: AuthUser, query: ListAuditsQuery) {
  const departmentId = departmentScope(user, query.departmentId);
  const where: Prisma.LabAuditWhereInput = {
    ...(departmentId && { departmentId }),
    ...(query.roomId && { locationId: query.roomId }),
    ...(query.period && { period: toPeriod(query.period) }),
    ...(query.status && { status: query.status }),
  };
  const [audits, total] = await Promise.all([
    prisma.labAudit.findMany({
      where,
      orderBy: [{ period: "desc" }, { reference: "asc" }],
      ...toSkipTake(query),
      include: {
        location: { select: { id: true, code: true, name: true } },
        checks: { select: progressSelect },
        snapshots: { orderBy: { revision: "desc" }, take: 1, select: { revision: true, kind: true, createdAt: true } },
      },
    }),
    prisma.labAudit.count({ where }),
  ]);
  return {
    data: audits.map(({ checks, snapshots, ...audit }) => ({ ...audit, progress: summarize(checks), latestSnapshot: snapshots[0] ?? null })),
    meta: pageMeta(query, total),
  };
}

/** Rooms in scope with this month's audit (if any) and its progress. */
export async function overview(user: AuthUser, query: { departmentId?: string; period?: string }) {
  const departmentId = departmentScope(user, query.departmentId);
  const period = toPeriod(query.period ?? new Date().toISOString().slice(0, 7));
  const rooms = await prisma.location.findMany({
    where: { deletedAt: null, roomType: { in: ["LAB", "CLASSROOM"] }, ...(departmentId && { departmentId }) },
    orderBy: { code: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      roomType: true,
      _count: { select: { workstations: { where: { deletedAt: null } }, blocks: { where: { deletedAt: null } } } },
      labAudits: {
        where: { period },
        select: { id: true, status: true, reference: true, auditorName: true, updatedAt: true, checks: { select: progressSelect } },
      },
    },
  });
  return {
    period: periodKey(period),
    rooms: rooms.map(({ labAudits, _count, ...room }) => {
      const audit = labAudits[0];
      return {
        ...room,
        workstationCount: _count.workstations,
        hasLayout: _count.blocks > 0,
        audit: audit ? { id: audit.id, status: audit.status, reference: audit.reference, auditorName: audit.auditorName, updatedAt: audit.updatedAt, progress: summarize(audit.checks) } : null,
      };
    }),
  };
}

export async function get(user: AuthUser, id: string) {
  await loadAudit(user, id);
  const audit = await prisma.labAudit.findUniqueOrThrow({
    where: { id },
    include: {
      location: { select: { id: true, code: true, name: true, building: true, floor: true, roomType: true } },
      createdBy: { select: { id: true, name: true } },
      checks: {
        orderBy: { sortKey: "asc" },
        include: { faultReason: { select: { id: true, label: true } }, checkedBy: { select: { id: true, name: true } } },
      },
      transitions: { orderBy: { at: "asc" }, include: { actor: { select: { id: true, name: true } } } },
      snapshots: { orderBy: { revision: "desc" }, select: { id: true, revision: true, kind: true, sha256: true, createdAt: true } },
    },
  });
  const view = await loadRoomView(prisma, audit.locationId);
  const performers = new Set([audit.createdById, ...audit.checks.map((c) => c.checkedById).filter(Boolean)]);
  return {
    ...audit,
    summary: summarize(audit.checks),
    plan: view.plan,
    blocks: view.blocks,
    canDecide: (user.role === "ADMIN" || user.role === "HOD") && !performers.has(user.id),
  };
}

// ─── Starting ───────────────────────────────────────────────────────────

function targetData(auditId: string, t: AuditTarget, addedAfterStart = false): Prisma.LabAuditCheckCreateManyInput {
  const { suggestion, ...fields } = t;
  return { ...fields, auditId, addedAfterStart, suggestedStatus: suggestion?.status ?? null, suggestedReason: suggestion?.reason ?? null };
}

export async function start(user: AuthUser, input: StartAuditInput) {
  const period = toPeriod(input.period);
  const startedOn = new Date(input.startedOn);
  if (startedOn > todayUtc()) throw AppError.badRequest("The start date cannot be in the future");

  // Read everything up front: the database is remote, and doing these reads
  // inside the transaction pushed it past its timeout on larger rooms.
  const room = await loadRoomForUser(user, input.roomId);
  if (room.roomType !== "LAB" && room.roomType !== "CLASSROOM") throw AppError.badRequest("Only labs and classrooms can be audited");
  const view = await loadRoomView(prisma, room.id);
  if (!view.blocks.length) throw AppError.badRequest("Set up the room layout before starting an audit");
  const department = await prisma.department.findUniqueOrThrow({ where: { id: room.departmentId } });

  const rows = buildTargets(view).map((t) => targetData("", t));

  // Last approved month's observations become hints only; nothing counts as inspected.
  const previous = input.copyFromPrevious
    ? await prisma.labAudit.findFirst({
        where: { locationId: room.id, status: "APPROVED", period: { lt: period } },
        orderBy: { period: "desc" },
        include: { checks: { include: { faultReason: { select: { label: true } } } } },
      })
    : null;
  if (previous) {
    const byKey = new Map(previous.checks.map((c) => [c.targetKey, c]));
    for (const row of rows) {
      const prev = byKey.get(row.targetKey);
      if (!prev || prev.status === "NOT_CHECKED" || row.suggestedStatus) continue;
      row.suggestedStatus = prev.status;
      row.suggestedReason = [prev.faultReason?.label, prev.reasonText].filter(Boolean).join(" — ") || null;
    }
  }

  const prefix = room.code.startsWith(`${department.code}-`) ? room.code : `${department.code}-${room.code}`;
  const id = await prisma.$transaction(
    async (tx) => {
      // The targets were built from this layout version; refuse if it changed since.
      const current = await tx.location.findUniqueOrThrow({ where: { id: room.id }, select: { layoutVersion: true } });
      if (current.layoutVersion !== room.layoutVersion) throw AppError.conflict("The room layout changed while starting the audit. Please try again.");
      const existing = await tx.labAudit.findUnique({ where: { locationId_period: { locationId: room.id, period } } });
      if (existing) throw AppError.conflict(`An audit for ${input.period} already exists for this room (${existing.reference})`);

      const audit = await tx.labAudit.create({
        data: {
          departmentId: room.departmentId,
          locationId: room.id,
          period,
          reference: `LA-${prefix}-${input.period}`,
          auditorName: input.auditorName,
          auditorDesignation: input.auditorDesignation ?? null,
          startedOn,
          layoutVersionAtStart: room.layoutVersion,
          createdById: user.id,
          copiedFromAuditId: previous?.id ?? null,
        },
      });

      if (rows.length) await tx.labAuditCheck.createMany({ data: rows.map((row) => ({ ...row, auditId: audit.id })) });
      await tx.labAuditTransition.create({ data: { auditId: audit.id, from: null, to: "DRAFT", actorId: user.id } });
      await logActivity(tx, { actorId: user.id, action: "start", tableName: "lab_audits", rowId: audit.id, after: { ...audit, checks: rows.length } });
      return audit.id;
    },
    { timeout: 30_000 },
  );
  return get(user, id);
}

// ─── Editing ────────────────────────────────────────────────────────────

export async function updateHeader(user: AuthUser, id: string, input: UpdateAuditInput) {
  await prisma.$transaction(async (tx) => {
    const before = await loadAudit(user, id, tx);
    assertEditable(before);
    const { expectedVersion, startedOn, completedOn, ...fields } = input;
    const start = startedOn ? new Date(startedOn) : before.startedOn;
    const done = completedOn === undefined ? before.completedOn : completedOn ? new Date(completedOn) : null;
    if (done && done < start) throw AppError.badRequest("The completion date cannot be before the start date");
    if (done && done > todayUtc()) throw AppError.badRequest("The completion date cannot be in the future");
    await bumpAudit(tx, id, expectedVersion, {
      ...fields,
      ...(startedOn && { startedOn: start }),
      ...(completedOn !== undefined && { completedOn: done }),
    });
    await logActivity(tx, { actorId: user.id, action: "update", tableName: "lab_audits", rowId: id, before, after: input });
  });
  return get(user, id);
}

const NEEDS_REASON = new Set(["NOT_WORKING", "NEEDS_REPAIR", "MISSING", "REMOVED"]);

/**
 * Saves observations. All-or-nothing: if any check was changed by someone
 * else since the client read it, nothing is written and the current rows come
 * back as 409 details. A change whose mutationId was already applied (a retry
 * after a lost response) is treated as done.
 */
export async function updateChecks(user: AuthUser, id: string, changes: CheckChange[]) {
  return prisma.$transaction(async (tx) => {
    const audit = await loadAudit(user, id, tx);
    assertEditable(audit);

    const ids = [...new Set(changes.map((c) => c.checkId))];
    if (ids.length !== changes.length) throw AppError.badRequest("Each check may appear only once per request");
    const current = await tx.labAuditCheck.findMany({ where: { auditId: id, id: { in: ids } } });
    const byId = new Map(current.map((c) => [c.id, c]));
    if (current.length !== ids.length) throw AppError.badRequest("Some checks do not belong to this audit");

    const pending = changes.filter((c) => byId.get(c.checkId)!.lastMutationId !== c.mutationId);
    const conflicts = pending.filter((c) => byId.get(c.checkId)!.version !== c.expectedVersion);
    if (conflicts.length) {
      throw new AppError(
        409,
        "VERSION_CONFLICT",
        "Someone else updated these items. Review their changes.",
        conflicts.map((c) => ({ path: c.checkId, message: "Changed by someone else", current: byId.get(c.checkId) })),
      );
    }

    const reasonIds = [...new Set(pending.map((c) => c.faultReasonId).filter(Boolean))] as string[];
    if (reasonIds.length) {
      const found = await tx.faultReason.count({ where: { id: { in: reasonIds } } });
      if (found !== reasonIds.length) throw AppError.badRequest("Unknown fault reason");
    }

    const now = new Date();
    for (const change of pending) {
      const needsReason = NEEDS_REASON.has(change.status);
      if (needsReason && !change.faultReasonId && !change.reasonText) {
        throw new AppError(400, "VALIDATION_ERROR", "Pick or type a reason", [{ path: `${change.checkId}.reasonText`, message: "Pick or type a reason" }]);
      }
      const keepReason = needsReason || change.status === "NOT_CHECKED";
      const done = await tx.labAuditCheck.updateMany({
        where: { id: change.checkId, version: change.expectedVersion },
        data: {
          status: change.status,
          faultReasonId: keepReason ? (change.faultReasonId ?? null) : null,
          reasonText: keepReason ? (change.reasonText ?? null) : null,
          notes: change.notes ?? null,
          actionTaken: change.actionTaken ?? null,
          followUp: change.followUp ?? null,
          checkedAt: change.status === "NOT_CHECKED" ? null : now,
          checkedById: change.status === "NOT_CHECKED" ? null : user.id,
          lastMutationId: change.mutationId,
          version: { increment: 1 },
        },
      });
      if (!done.count) throw versionConflict();
    }

    if (pending.length) {
      await logActivity(tx, {
        actorId: user.id,
        action: "record_checks",
        tableName: "lab_audits",
        rowId: id,
        after: pending.map((c) => ({ checkId: c.checkId, status: c.status, reason: c.reasonText ?? c.faultReasonId ?? null })),
      });
    }
    return tx.labAuditCheck.findMany({
      where: { id: { in: ids } },
      include: { faultReason: { select: { id: true, label: true } }, checkedBy: { select: { id: true, name: true } } },
    });
  });
}

/** "All working" for one PC or one row. Never overwrites an observation already made unless asked. */
export async function bulk(user: AuthUser, id: string, input: BulkInput) {
  return prisma.$transaction(async (tx) => {
    const audit = await loadAudit(user, id, tx);
    assertEditable(audit);

    let where: Prisma.LabAuditCheckWhereInput;
    if ("workstationId" in input.scope) {
      where = { workstationId: input.scope.workstationId };
    } else {
      const seats = await tx.seat.findMany({ where: { rowId: input.scope.rowId, deletedAt: null }, select: { id: true } });
      const seatIds = seats.map((s) => s.id);
      const workstations = await tx.workstation.findMany({ where: { seatId: { in: seatIds }, deletedAt: null }, select: { id: true } });
      where = { OR: [{ seatId: { in: seatIds } }, { workstationId: { in: workstations.map((w) => w.id) } }] };
    }
    const result = await tx.labAuditCheck.updateMany({
      where: {
        auditId: id,
        AND: [where, { OR: [{ lastMutationId: null }, { lastMutationId: { not: input.mutationId } }] }],
        ...(input.onlyUnchecked && { status: "NOT_CHECKED" }),
      },
      data: {
        status: "WORKING",
        faultReasonId: null,
        reasonText: null,
        checkedAt: new Date(),
        checkedById: user.id,
        lastMutationId: input.mutationId,
        version: { increment: 1 },
      },
    });
    if (result.count) {
      await logActivity(tx, { actorId: user.id, action: "bulk_working", tableName: "lab_audits", rowId: id, after: { scope: input.scope, updated: result.count } });
    }
    const checks = await tx.labAuditCheck.findMany({
      where: { auditId: id, ...where },
      include: { faultReason: { select: { id: true, label: true } }, checkedBy: { select: { id: true, name: true } } },
    });
    return { updated: result.count, checks };
  });
}

/** Items installed or retired since the audit started. */
async function targetChanges(tx: Tx | typeof prisma, auditId: string, locationId: string) {
  const view = await loadRoomView(tx, locationId);
  const checks = await tx.labAuditCheck.findMany({
    where: { auditId },
    select: { id: true, targetKey: true, equipmentId: true, itemCode: true, targetRetiredAfterStart: true },
  });
  const targets = buildTargets(view);
  const known = new Set(checks.map((c) => c.targetKey));
  const live = new Set(targets.map((t) => t.targetKey));
  return {
    added: targets.filter((t) => !known.has(t.targetKey)),
    retired: checks.filter((c) => c.equipmentId && !live.has(c.targetKey) && !c.targetRetiredAfterStart),
  };
}

export async function previewTargets(user: AuthUser, id: string) {
  const audit = await loadAudit(user, id);
  const { added, retired } = await targetChanges(prisma, id, audit.locationId);
  return {
    added: added.map((t) => ({ itemCode: t.itemCode, typeName: t.typeName, positionCode: t.positionCode })),
    retired: retired.map((c) => ({ checkId: c.id, itemCode: c.itemCode })),
  };
}

export async function syncTargets(user: AuthUser, id: string, expectedVersion: number) {
  await prisma.$transaction(async (tx) => {
    const audit = await loadAudit(user, id, tx);
    assertEditable(audit);
    await bumpAudit(tx, id, expectedVersion);
    const { added, retired } = await targetChanges(tx, id, audit.locationId);
    if (added.length) await tx.labAuditCheck.createMany({ data: added.map((t) => targetData(id, t, true)), skipDuplicates: true });
    if (retired.length) {
      await tx.labAuditCheck.updateMany({ where: { id: { in: retired.map((c) => c.id) } }, data: { targetRetiredAfterStart: true, version: { increment: 1 } } });
    }
    await logActivity(tx, { actorId: user.id, action: "sync_targets", tableName: "lab_audits", rowId: id, after: { added: added.length, retired: retired.length } });
  });
  return get(user, id);
}

// ─── Workflow ───────────────────────────────────────────────────────────

async function freezeSnapshot(tx: Tx, auditId: string, kind: "SUBMITTED" | "APPROVED", userId: string) {
  const last = await tx.labAuditSnapshot.aggregate({ where: { auditId }, _max: { revision: true } });
  const revision = (last._max.revision ?? 0) + 1;
  const data = await buildReportData(tx, auditId, { kind, revision, at: new Date() });
  const json = JSON.stringify(data);
  const sha256 = createHash("sha256").update(json).digest("hex");
  await tx.labAuditSnapshot.create({ data: { auditId, revision, kind, data: JSON.parse(json) as Prisma.InputJsonValue, sha256, createdById: userId } });
  return { revision, sha256 };
}

/** Problems that block submission, listed so the auditor can fix them all at once. */
async function submissionProblems(tx: Tx, auditId: string) {
  const checks = await tx.labAuditCheck.findMany({ where: { auditId }, orderBy: { sortKey: "asc" } });
  const problems: { path: string; message: string }[] = [];
  if (!checks.length) problems.push({ path: "checks", message: "This audit has nothing to inspect" });
  for (const c of checks) {
    const hasReason = Boolean(c.faultReasonId || c.reasonText);
    if (c.status === "NOT_CHECKED" && !hasReason) {
      problems.push({ path: c.id, message: `${c.itemCode} (${c.positionCode ?? c.typeName}) is not checked — inspect it or say why it could not be` });
    }
  }
  return problems;
}

export async function submit(user: AuthUser, id: string, expectedVersion: number) {
  await prisma.$transaction(
    async (tx) => {
      const audit = await loadAudit(user, id, tx);
      assertEditable(audit);
      const problems = await submissionProblems(tx, id);
      if (problems.length) {
        throw new AppError(400, "AUDIT_INCOMPLETE", `${problems.length} item(s) need attention before submitting`, problems.slice(0, 50));
      }
      await bumpAudit(tx, id, expectedVersion, { status: "SUBMITTED", completedOn: audit.completedOn ?? todayUtc() });
      await tx.labAuditTransition.create({ data: { auditId: id, from: audit.status, to: "SUBMITTED", actorId: user.id } });
      const snapshot = await freezeSnapshot(tx, id, "SUBMITTED", user.id);
      await logActivity(tx, { actorId: user.id, action: "submit", tableName: "lab_audits", rowId: id, after: snapshot });
    },
    { timeout: 30_000 },
  );
  return get(user, id);
}

/** HOD approval or return. Nobody approves an audit they started or inspected. */
export async function decide(user: AuthUser, id: string, input: { expectedVersion: number; decision: "APPROVED" | "RETURNED"; comment?: string | null }) {
  await prisma.$transaction(
    async (tx) => {
      const audit = await loadAudit(user, id, tx);
      if (audit.status !== "SUBMITTED") throw AppError.conflict("Only submitted audits can be approved or returned");
      const inspected = await tx.labAuditCheck.count({ where: { auditId: id, checkedById: user.id } });
      if (audit.createdById === user.id || inspected > 0) throw AppError.forbidden("You cannot approve an audit you carried out");

      await bumpAudit(tx, id, input.expectedVersion, { status: input.decision });
      await tx.labAuditTransition.create({ data: { auditId: id, from: "SUBMITTED", to: input.decision, actorId: user.id, comment: input.comment ?? null } });
      const snapshot = input.decision === "APPROVED" ? await freezeSnapshot(tx, id, "APPROVED", user.id) : null;
      await logActivity(tx, {
        actorId: user.id,
        action: input.decision === "APPROVED" ? "approve" : "return",
        tableName: "lab_audits",
        rowId: id,
        after: { comment: input.comment, snapshot },
      });
    },
    { timeout: 30_000 },
  );
  return get(user, id);
}

/** Admin-only correction path. Earlier snapshots stay; the next submission becomes a new revision. */
export async function reopen(user: AuthUser, id: string, input: { expectedVersion: number; reason: string }) {
  await prisma.$transaction(async (tx) => {
    const audit = await loadAudit(user, id, tx);
    if (audit.status !== "APPROVED" && audit.status !== "SUBMITTED") throw AppError.conflict("Only submitted or approved audits can be reopened");
    await bumpAudit(tx, id, input.expectedVersion, { status: "RETURNED" });
    await tx.labAuditTransition.create({ data: { auditId: id, from: audit.status, to: "RETURNED", actorId: user.id, comment: `Reopened: ${input.reason}` } });
    await logActivity(tx, { actorId: user.id, action: "reopen", tableName: "lab_audits", rowId: id, after: { reason: input.reason } });
  });
  return get(user, id);
}

// ─── Reports ────────────────────────────────────────────────────────────

/**
 * Report data from a frozen snapshot (latest, or a given revision). Drafts and
 * returned audits without a snapshot get a live preview marked DRAFT.
 */
export async function reportData(user: AuthUser, id: string, revision?: number): Promise<{ data: ReportData; revision: number | null }> {
  const audit = await loadAudit(user, id);
  const snapshot = await prisma.labAuditSnapshot.findFirst({
    where: { auditId: id, ...(revision && { revision }) },
    orderBy: { revision: "desc" },
  });
  if (revision && !snapshot) throw AppError.notFound("Report revision");
  if (snapshot && (revision || !EDITABLE.includes(audit.status))) {
    return { data: snapshot.data as unknown as ReportData, revision: snapshot.revision };
  }
  return { data: await buildReportData(prisma, id, { kind: "DRAFT", revision: null, at: new Date() }), revision: null };
}

/**
 * Read-only comparison with the ledger. Nothing here changes ledger entries or
 * asset items; differences are listed for a person to review.
 */
export async function discrepancies(user: AuthUser, id: string) {
  const audit = await loadAudit(user, id);
  const checks = await prisma.labAuditCheck.findMany({
    where: { auditId: id, equipment: { assetItemId: { not: null } } },
    orderBy: { sortKey: "asc" },
    include: { equipment: { include: { assetItem: { include: { location: { select: { code: true, name: true } } } } } } },
  });
  const rows: { itemCode: string; tagCode: string; issue: string }[] = [];
  for (const c of checks) {
    const asset = c.equipment?.assetItem;
    if (!asset) continue;
    if (asset.locationId !== audit.locationId) {
      rows.push({ itemCode: c.itemCode, tagCode: asset.tagCode, issue: `Ledger location is ${asset.location?.code ?? "not set"}` });
    }
    if ((c.status === "NOT_WORKING" || c.status === "NEEDS_REPAIR") && asset.condition === "GOOD") {
      rows.push({ itemCode: c.itemCode, tagCode: asset.tagCode, issue: `Observed ${c.status === "NOT_WORKING" ? "not working" : "needing repair"}; ledger condition is Good` });
    }
    if (c.status === "MISSING" && asset.status !== "MISSING") {
      rows.push({ itemCode: c.itemCode, tagCode: asset.tagCode, issue: "Observed missing; ledger status is not Missing" });
    }
  }
  return rows;
}
