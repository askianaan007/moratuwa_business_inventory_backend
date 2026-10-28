import type { LabCheckStatus, Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import type { PlanGeometry } from "../rooms/plan-geometry.js";
import { loadRoomView } from "../rooms/room-view.js";

type Db = Prisma.TransactionClient | typeof prisma;

export const STATUSES: LabCheckStatus[] = ["WORKING", "NOT_WORKING", "NEEDS_REPAIR", "MISSING", "REMOVED", "NOT_CHECKED"];
export const FAULTY: LabCheckStatus[] = ["NOT_WORKING", "NEEDS_REPAIR", "MISSING"];

/** Higher wins when one desk has several items. */
const SEVERITY: Record<LabCheckStatus, number> = { WORKING: 1, NOT_CHECKED: 2, REMOVED: 3, NEEDS_REPAIR: 4, NOT_WORKING: 5, MISSING: 6 };

export const STATUS_LABEL: Record<LabCheckStatus, string> = {
  WORKING: "Working",
  NOT_WORKING: "Not working",
  NEEDS_REPAIR: "Needs repair",
  MISSING: "Missing",
  REMOVED: "Removed",
  NOT_CHECKED: "Not checked",
};

/** Short codes used in printed tables (readable in black and white). */
export const STATUS_CODE: Record<LabCheckStatus, string> = {
  WORKING: "OK",
  NOT_WORKING: "NW",
  NEEDS_REPAIR: "NR",
  MISSING: "MS",
  REMOVED: "RM",
  NOT_CHECKED: "NC",
};

type Counts = Record<LabCheckStatus, number>;
const emptyCounts = (): Counts => ({ WORKING: 0, NOT_WORKING: 0, NEEDS_REPAIR: 0, MISSING: 0, REMOVED: 0, NOT_CHECKED: 0 });

export interface ReportLine {
  positionCode: string | null;
  stationLabel: string | null;
  itemCode: string;
  typeName: string;
  status: LabCheckStatus;
  reason: string | null;
  notes: string | null;
  actionTaken: string | null;
  followUp: string | null;
}

/** Everything a report needs, as plain JSON. Stored in LabAuditSnapshot.data. */
export interface ReportData {
  schema: 1;
  kind: "DRAFT" | "SUBMITTED" | "APPROVED";
  revision: number | null;
  generatedAt: string;
  settings: {
    institution: string;
    faculty: string | null;
    departmentTitle: string;
    hodName: string | null;
    hodDesignation: string;
    checkedByLabel: string;
    footerNote: string | null;
  };
  room: { code: string; name: string; building: string | null; floor: string | null; roomType: string };
  audit: {
    id: string;
    reference: string;
    period: string;
    periodLabel: string;
    auditorName: string;
    auditorDesignation: string | null;
    startedOn: string;
    completedOn: string | null;
    status: string;
    generalRemarks: string | null;
    recommendations: string | null;
    submittedAt: string | null;
    submittedBy: string | null;
    approvedAt: string | null;
    approvedBy: string | null;
    decisionComment: string | null;
  };
  counts: {
    seats: number;
    pcSeats: number;
    emptyTables: number;
    gaps: number;
    instructorDesks: number;
    workstations: number;
    fixtures: number;
    checks: number;
    checked: number;
    completion: number;
    byStatus: Counts;
  };
  types: { code: string; name: string; byStatus: Counts }[];
  plan: PlanGeometry;
  deskStatus: Record<string, LabCheckStatus>;
  fixtureStatus: Record<string, LabCheckStatus>;
  stationColumns: { code: string; name: string }[];
  workstations: {
    number: number | null;
    positionCode: string | null;
    label: string;
    cells: Record<string, { itemCode: string; status: LabCheckStatus }[]>;
    remarks: string | null;
  }[];
  faults: (ReportLine & { monthsOutstanding: number })[];
  fixtures: ReportLine[];
  tables: ReportLine[];
  notChecked: ReportLine[];
  workstationsDown: { positionCode: string | null; label: string; allMissing: boolean }[];
  configurationGaps: { typeName: string; positions: string[] }[];
  findings: string[];
  comparison: {
    previousReference: string;
    previousPeriodLabel: string;
    newFaults: string[];
    fixed: string[];
    stillFaulty: string[];
  } | null;
  history: { to: string; actor: string; at: string; comment: string | null }[];
}

const dateOnly = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
export const periodKey = (d: Date) => d.toISOString().slice(0, 7);
export const periodLabel = (d: Date) => d.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Builds the report from the database. Called once at submit/approve time and
 * frozen into a snapshot; afterwards reports are rendered from the snapshot only.
 */
export async function buildReportData(
  db: Db,
  auditId: string,
  opts: { kind: ReportData["kind"]; revision: number | null; at: Date },
): Promise<ReportData> {
  const audit = await db.labAudit.findUniqueOrThrow({
    where: { id: auditId },
    include: {
      location: true,
      department: { include: { reportSettings: true } },
      checks: { orderBy: { sortKey: "asc" }, include: { faultReason: { select: { label: true } } } },
      transitions: { orderBy: { at: "asc" }, include: { actor: { select: { name: true } } } },
    },
  });
  // Sequential: usually runs inside the submit/approve transaction.
  const view = await loadRoomView(db, audit.locationId);
  const defaultTypes = await db.equipmentType.findMany({
    where: { isActive: true, isDefault: true, scope: { in: ["WORKSTATION", "BOTH"] } },
    orderBy: { sortOrder: "asc" },
  });
  const previous = await db.labAudit.findMany({
    where: { locationId: audit.locationId, status: "APPROVED", period: { lt: audit.period } },
    orderBy: { period: "desc" },
    take: 12,
    select: { id: true, reference: true, period: true, checks: { select: { targetKey: true, status: true, itemCode: true } } },
  });

  const line = (c: (typeof audit.checks)[number]): ReportLine => ({
    positionCode: c.positionCode,
    stationLabel: c.stationLabel,
    itemCode: c.itemCode,
    typeName: c.typeName,
    status: c.status,
    reason: [c.faultReason?.label, c.reasonText].filter(Boolean).join(" — ") || null,
    notes: c.notes,
    actionTaken: c.actionTaken,
    followUp: c.followUp,
  });

  // ── counts ──
  const byStatus = emptyCounts();
  const typeCounts = new Map<string, { code: string; name: string; byStatus: Counts }>();
  for (const c of audit.checks) {
    byStatus[c.status]++;
    const name = c.typeCode === "SEAT" ? "Tables without a PC" : c.typeName;
    const t = typeCounts.get(c.typeCode) ?? { code: c.typeCode, name, byStatus: emptyCounts() };
    t.byStatus[c.status]++;
    typeCounts.set(c.typeCode, t);
  }
  const seats = view.blocks.flatMap((b) => b.rows.flatMap((r) => r.seats));
  const total = audit.checks.length;
  const checked = total - byStatus.NOT_CHECKED;

  // ── plan colouring ──
  const deskStatus: Record<string, LabCheckStatus> = {};
  const fixtureStatus: Record<string, LabCheckStatus> = {};
  const seatByWorkstation = new Map(view.workstations.filter((w) => w.seatId).map((w) => [w.id, w.seatId!]));
  const worst = (map: Record<string, LabCheckStatus>, key: string, status: LabCheckStatus) => {
    const current = map[key];
    if (!current || SEVERITY[status] > SEVERITY[current] || (current === "WORKING" && status === "NOT_CHECKED")) map[key] = status;
  };
  for (const c of audit.checks) {
    if (c.seatId) worst(deskStatus, c.seatId, c.status);
    else if (c.workstationId && seatByWorkstation.has(c.workstationId)) worst(deskStatus, seatByWorkstation.get(c.workstationId)!, c.status);
    else if (c.equipmentId) fixtureStatus[c.equipmentId] = c.status;
  }

  // ── workstation register ──
  // Named as on the room plan now; rows are already in walking order (left-most PC first).
  const wsLive = new Map(view.workstations.map((w) => [w.id, w]));
  const columns = new Map<string, string>();
  const register = new Map<string, ReportData["workstations"][number]>();
  for (const c of audit.checks) {
    if (!c.workstationId || c.targetKind !== "EQUIPMENT") continue;
    columns.set(c.typeCode, c.typeName);
    const row = register.get(c.workstationId) ?? {
      number: register.size + 1,
      positionCode: wsLive.get(c.workstationId)?.positionCode ?? c.positionCode,
      label: wsLive.get(c.workstationId)?.label ?? c.stationLabel ?? c.itemCode,
      cells: {},
      remarks: null,
    };
    (row.cells[c.typeCode] ??= []).push({ itemCode: c.itemCode, status: c.status });
    if (c.status !== "WORKING" && c.status !== "NOT_CHECKED") {
      const note = `${c.itemCode}: ${line(c).reason ?? STATUS_LABEL[c.status]}`;
      row.remarks = row.remarks ? `${row.remarks}; ${note}` : note;
    }
    register.set(c.workstationId, row);
  }
  const workstations = [...register.values()];

  // ── history across approved months ──
  const isFaulty = (s: LabCheckStatus) => FAULTY.includes(s);
  const monthsOutstanding = (targetKey: string) => {
    let n = 1;
    for (const prev of previous) {
      const hit = prev.checks.find((c) => c.targetKey === targetKey);
      if (!hit || !isFaulty(hit.status)) break;
      n++;
    }
    return n;
  };

  const faultChecks = audit.checks.filter((c) => FAULTY.includes(c.status) || c.status === "REMOVED");
  const faults = faultChecks.map((c) => ({ ...line(c), monthsOutstanding: c.status === "REMOVED" ? 0 : monthsOutstanding(c.targetKey) }));

  const workstationsDown = workstations
    .filter((w) => {
      const all = Object.values(w.cells).flat();
      return all.length > 0 && all.every((cell) => cell.status === "NOT_WORKING" || cell.status === "MISSING");
    })
    .map((w) => ({
      positionCode: w.positionCode,
      label: w.label,
      allMissing: Object.values(w.cells).flat().every((cell) => cell.status === "MISSING"),
    }));

  const configurationGaps = defaultTypes
    .map((type) => ({
      typeName: type.name,
      positions: workstations.filter((w) => !w.cells[type.code]).map((w) => w.positionCode ?? w.label),
    }))
    .filter((gap) => gap.positions.length > 0);

  // ── comparison with the previous approved audit ──
  const last = previous[0];
  let comparison: ReportData["comparison"] = null;
  if (last) {
    const before = new Map(last.checks.map((c) => [c.targetKey, c.status]));
    const nowFaulty = audit.checks.filter((c) => isFaulty(c.status));
    comparison = {
      previousReference: last.reference,
      previousPeriodLabel: periodLabel(last.period),
      newFaults: nowFaulty.filter((c) => !isFaulty(before.get(c.targetKey) ?? "WORKING")).map((c) => c.itemCode),
      stillFaulty: nowFaulty.filter((c) => isFaulty(before.get(c.targetKey) ?? "WORKING")).map((c) => c.itemCode),
      fixed: audit.checks
        .filter((c) => c.status === "WORKING" && isFaulty(before.get(c.targetKey) ?? "WORKING"))
        .map((c) => c.itemCode),
    };
  }

  // ── findings ──
  const completion = total ? Math.floor((checked / total) * 100) : 100;
  const faultyStations = workstations.filter((w) => Object.values(w.cells).flat().some((cell) => isFaulty(cell.status))).length;
  const findings: string[] = [];
  findings.push(`${checked} of ${total} items inspected (${completion}% complete).`);
  if (workstations.length) findings.push(`${faultyStations} of ${workstations.length} workstations have at least one fault.`);
  if (workstationsDown.length) findings.push(`${workstationsDown.length} workstation(s) completely out of service: ${workstationsDown.map((w) => w.positionCode ?? w.label).join(", ")}.`);
  if (byStatus.MISSING) findings.push(`${byStatus.MISSING} item(s) missing — follow up required.`);
  const longRunning = faults.filter((f) => f.monthsOutstanding >= 2);
  if (longRunning.length) findings.push(`${longRunning.length} fault(s) outstanding for two or more consecutive audits.`);
  if (comparison) findings.push(`Since ${comparison.previousPeriodLabel}: ${comparison.newFaults.length} new fault(s), ${comparison.fixed.length} fixed.`);
  if (byStatus.NOT_CHECKED) findings.push(`${byStatus.NOT_CHECKED} item(s) could not be inspected; reasons are listed in the report.`);

  const lastOf = (to: string) => [...audit.transitions].reverse().find((t) => t.to === to);
  const submitted = lastOf("SUBMITTED");
  const decided = [...audit.transitions].reverse().find((t) => t.to === "APPROVED" || t.to === "RETURNED");
  const settings = audit.department.reportSettings;

  return {
    schema: 1,
    kind: opts.kind,
    revision: opts.revision,
    generatedAt: opts.at.toISOString(),
    settings: {
      institution: settings?.institution ?? "",
      faculty: settings?.faculty ?? null,
      departmentTitle: settings?.departmentTitle ?? audit.department.name,
      hodName: settings?.hodName ?? null,
      hodDesignation: settings?.hodDesignation ?? "Head of Department",
      checkedByLabel: settings?.checkedByLabel ?? "Checked by",
      footerNote: settings?.footerNote ?? null,
    },
    room: { code: audit.location.code, name: audit.location.name, building: audit.location.building, floor: audit.location.floor, roomType: audit.location.roomType },
    audit: {
      id: audit.id,
      reference: audit.reference,
      period: periodKey(audit.period),
      periodLabel: periodLabel(audit.period),
      auditorName: audit.auditorName,
      auditorDesignation: audit.auditorDesignation,
      startedOn: dateOnly(audit.startedOn)!,
      completedOn: dateOnly(audit.completedOn),
      status: opts.kind === "DRAFT" ? audit.status : opts.kind,
      generalRemarks: audit.generalRemarks,
      recommendations: audit.recommendations,
      submittedAt: submitted?.at.toISOString() ?? (opts.kind === "SUBMITTED" ? opts.at.toISOString() : null),
      submittedBy: submitted?.actor.name ?? null,
      approvedAt: opts.kind === "APPROVED" ? opts.at.toISOString() : null,
      approvedBy: opts.kind === "APPROVED" ? (decided?.actor.name ?? null) : null,
      decisionComment: decided?.comment ?? null,
    },
    counts: {
      seats: seats.filter((s) => s.kind !== "NO_TABLE").length,
      pcSeats: seats.filter((s) => s.kind === "PC").length,
      emptyTables: seats.filter((s) => s.kind === "EMPTY_TABLE").length,
      gaps: seats.filter((s) => s.kind === "NO_TABLE").length,
      instructorDesks: seats.filter((s) => s.kind === "INSTRUCTOR").length,
      workstations: workstations.length,
      fixtures: audit.checks.filter((c) => c.targetKind === "EQUIPMENT" && !c.workstationId).length,
      checks: total,
      checked,
      completion,
      byStatus,
    },
    types: [...typeCounts.values()],
    plan: view.plan,
    deskStatus,
    fixtureStatus,
    stationColumns: [...columns].map(([code, name]) => ({ code, name })),
    workstations,
    faults,
    fixtures: audit.checks.filter((c) => c.targetKind === "EQUIPMENT" && !c.workstationId).map(line),
    tables: audit.checks.filter((c) => c.targetKind === "SEAT").map(line),
    notChecked: audit.checks.filter((c) => c.status === "NOT_CHECKED").map(line),
    workstationsDown,
    configurationGaps,
    findings,
    comparison,
    history: audit.transitions.map((t) => ({ to: t.to, actor: t.actor.name, at: t.at.toISOString(), comment: t.comment })),
  };
}
