import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type ISectionOptions,
} from "docx";
import type { LabCheckStatus } from "../../generated/prisma/client.js";
import { STATUSES, STATUS_CODE, STATUS_LABEL, type ReportData } from "../lab-audits/lab-audit-report.js";
import { deskColumn } from "../rooms/plan-geometry.js";

/**
 * Editable Word version of the report, built from the same snapshot as the
 * PDF. The plan is drawn as a table grid (one cell per desk) so it stays
 * editable and prints cleanly in black and white.
 */

// A4 in twentieths of a point; 15 mm margins (851 twips), 18 mm bottom.
const PAGE = { width: 11906, height: 16838, margin: { top: 851, right: 851, bottom: 1020, left: 851, header: 400, footer: 450 } };
const FONT = "Calibri";

const SHADE: Record<LabCheckStatus, string> = {
  WORKING: "E8F5E9",
  NOT_CHECKED: "FFFFFF",
  REMOVED: "EEEEEE",
  NEEDS_REPAIR: "FFF3CD",
  NOT_WORKING: "F8D7DA",
  MISSING: "F8D7DA",
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" });

const run = (text: string, opts: { bold?: boolean; size?: number; italics?: boolean; color?: string } = {}) =>
  new TextRun({ text, font: FONT, size: opts.size ?? 18, bold: opts.bold, italics: opts.italics, color: opts.color });

const para = (text: string, opts: { bold?: boolean; size?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; italics?: boolean } = {}) =>
  new Paragraph({ alignment: opts.align, spacing: { after: opts.after ?? 60 }, children: [run(text, opts)] });

const heading = (text: string) =>
  new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, keepNext: true, children: [run(text, { bold: true, size: 22 })] });

function cell(text: string, opts: { bold?: boolean; shade?: string; size?: number; width?: number } = {}) {
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 30, bottom: 30, left: 70, right: 70 },
    ...(opts.shade && { shading: { type: ShadingType.CLEAR, color: "auto", fill: opts.shade } }),
    ...(opts.width && { width: { size: opts.width, type: WidthType.DXA } }),
    children: text.split("\n").map((line) => new Paragraph({ children: [run(line, { bold: opts.bold, size: opts.size ?? 16 })] })),
  });
}

const statusCell = (status: LabCheckStatus, text?: string) => cell(text ?? STATUS_CODE[status], { shade: SHADE[status], bold: status !== "WORKING" });

/** Header row repeats on every page; rows never split across pages. */
function table(headers: string[], rows: TableCell[][], empty = "None."): (Paragraph | Table)[] {
  if (!rows.length) return [para(empty, { italics: true })];
  return [
    new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.AUTOFIT,
      rows: [
        new TableRow({ tableHeader: true, cantSplit: true, children: headers.map((h) => cell(h, { bold: true, shade: "E6E6E6" })) }),
        ...rows.map((children) => new TableRow({ cantSplit: true, children })),
      ],
    }),
    para("", { after: 120 }),
  ];
}

/** One small table per block: rows × seats, each desk showing its label and status code. */
function planTables(report: ReportData): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  for (const block of report.plan.blocks) {
    const rows = report.plan.rows.filter((r) => r.blockId === block.id);
    out.push(para(`Block ${block.code} · ${block.name}`, { bold: true, after: 40 }));
    const maxSeats = Math.max(1, ...rows.map((r) => report.plan.desks.filter((d) => d.blockCode === block.code && d.rowLabel === r.label).length));
    out.push(
      new Table({
        layout: TableLayoutType.FIXED,
        rows: rows.map((r) => {
          // Placed by drawn column, so mirrored blocks match the plan.
          const desks = new Map(report.plan.desks.filter((d) => d.blockCode === block.code && d.rowLabel === r.label).map((d) => [deskColumn(block, d), d]));
          return new TableRow({
            cantSplit: true,
            children: [
              cell(`R${r.label}`, { bold: true, width: 520 }),
              ...Array.from({ length: maxSeats }, (_, i) => {
                const d = desks.get(i);
                if (!d || d.kind === "NO_TABLE") return cell("", { width: 1050 });
                const status = report.deskStatus[d.seatId];
                const title = d.kind === "EMPTY_TABLE" ? "empty" : (d.label ?? (d.kind === "INSTRUCTOR" ? "instr." : ""));
                return cell(`${title}\nS${d.seatNumber}${status ? ` ${STATUS_CODE[status]}` : ""}`, {
                  width: 1050,
                  size: 14,
                  ...(status && { shade: SHADE[status] }),
                });
              }),
            ],
          });
        }),
      }),
      para("", { after: 80 }),
    );
  }
  if (report.plan.fixtures.length) {
    out.push(
      para(
        "Room items: " +
          report.plan.fixtures
            .map((f) => `${f.code} (${f.wall.toLowerCase()})${report.fixtureStatus[f.equipmentId] ? ` ${STATUS_CODE[report.fixtureStatus[f.equipmentId]!]}` : ""}`)
            .join(", "),
        { size: 16 },
      ),
    );
  }
  out.push(para(STATUSES.map((s) => `${STATUS_CODE[s]} = ${STATUS_LABEL[s]}`).join(" · "), { size: 14, after: 120 }));
  return out;
}

const lineRows = (lines: ReportData["fixtures"]) =>
  lines.map((l) => [cell(l.itemCode, { bold: true }), cell(l.typeName), cell(l.positionCode ?? "—"), statusCell(l.status, STATUS_LABEL[l.status]), cell(l.reason ?? l.notes ?? "—")]);

function signatureTable(report: ReportData) {
  const { audit, settings } = report;
  const block = (title: string, name: string | null, sub: string | null, date: string | null) =>
    new TableCell({
      borders: { top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } },
      children: [
        para(title, { bold: true, after: 500 }),
        para("……………………………………", { after: 20 }),
        para(name ?? "Name:", { after: 20 }),
        para(sub ?? " ", { size: 16, after: 20 }),
        para(`Date: ${date ?? "………………"}`, { size: 16 }),
      ],
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        cantSplit: true,
        children: [
          block("Prepared by", audit.auditorName, audit.auditorDesignation, fmtDate(audit.completedOn)),
          block(settings.checkedByLabel, null, null, null),
          block(settings.hodDesignation, settings.hodName, settings.hodDesignation, audit.approvedAt ? fmtDate(audit.approvedAt) : null),
        ],
      }),
    ],
  });
}

export async function renderDocx(report: ReportData): Promise<Buffer> {
  const { audit, room, settings, counts } = report;
  const roomLine = [room.name, room.code, room.building, room.floor && `Floor ${room.floor}`].filter(Boolean).join(" · ");
  const cols = report.stationColumns;

  const header = new Header({
    children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [run(`${audit.reference} · ${room.name} · ${audit.periodLabel}`, { size: 14, color: "555555" })] })],
  });
  const footer = new Footer({
    children: [
      new Paragraph({
        children: [
          run(`${audit.reference}${report.revision ? ` · rev ${report.revision}` : ""} · Generated ${fmtDateTime(report.generatedAt)}    Page `, { size: 14 }),
          new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 14 }),
          run(" of ", { size: 14 }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES], font: FONT, size: 14 }),
        ],
      }),
    ],
  });

  const typeRows = report.types.map((t) => [cell(t.name), ...STATUSES.map((s) => cell(t.byStatus[s] ? String(t.byStatus[s]) : "–"))]);
  typeRows.push([cell("Total", { bold: true }), ...STATUSES.map((s) => cell(String(counts.byStatus[s]), { bold: true }))]);

  const registerRows = report.workstations.map((w) => [
    cell(w.number === null ? "" : String(w.number)),
    cell(w.positionCode ?? "—"),
    cell(w.label, { bold: true }),
    ...cols.map((c) => {
      const cells = w.cells[c.code];
      if (!cells?.length) return cell("—");
      const worst = cells.find((x) => x.status !== "WORKING") ?? cells[0]!;
      return statusCell(worst.status, cells.map((x) => STATUS_CODE[x.status]).join("/"));
    }),
    cell(w.remarks ?? "", { size: 14 }),
  ]);

  const faultRows = report.faults.map((f) => [
    cell(f.positionCode ?? "—"),
    cell(f.stationLabel ?? "—"),
    cell(f.itemCode, { bold: true }),
    cell(f.typeName),
    statusCell(f.status, STATUS_LABEL[f.status]),
    cell(f.reason ?? "—"),
    cell([f.actionTaken, f.followUp && `Follow-up: ${f.followUp}`].filter(Boolean).join("\n") || "—"),
    cell(f.monthsOutstanding ? String(f.monthsOutstanding) : "–"),
  ]);

  const main: (Paragraph | Table)[] = [
    ...(settings.institution ? [para(settings.institution, { bold: true, size: 26, align: AlignmentType.CENTER })] : []),
    ...(settings.faculty ? [para(settings.faculty, { align: AlignmentType.CENTER })] : []),
    para(settings.departmentTitle, { bold: true, align: AlignmentType.CENTER }),
    para("Monthly Computer Lab Audit Report", { bold: true, size: 30, align: AlignmentType.CENTER }),
    para(roomLine, { align: AlignmentType.CENTER }),
    para(`Reporting month: ${audit.periodLabel} · Reference: ${audit.reference}`, { align: AlignmentType.CENTER, after: 160 }),
    ...(report.kind === "DRAFT" ? [para("DRAFT — not submitted", { bold: true, align: AlignmentType.CENTER, after: 160 })] : []),
    ...table(
      ["Auditor", "Designation", "Started", "Completed", "Status"],
      [[cell(audit.auditorName), cell(audit.auditorDesignation ?? "—"), cell(fmtDate(audit.startedOn)), cell(fmtDate(audit.completedOn)), cell(report.kind)]],
    ),
    heading("1. Summary"),
    ...table(
      ["Positions", "PCs", "Empty tables", "Room items", "Items", "Inspected", "Completion"],
      [[counts.seats, counts.workstations, counts.emptyTables, counts.fixtures, counts.checks, counts.checked].map((n) => cell(String(n))).concat(cell(`${counts.completion}%`, { bold: true }))],
    ),
    ...table(["Equipment type", ...STATUSES.map((s) => STATUS_LABEL[s])], typeRows),
    heading("2. Key findings"),
    ...report.findings.map((f) => new Paragraph({ bullet: { level: 0 }, children: [run(f)] })),
    heading("3. Room plan (board at the top)"),
    ...planTables(report),
    heading("4. Fault register"),
    ...table(["Position", "PC", "Item", "Type", "Status", "Reason", "Action / follow-up", "Months"], faultRows, "No faults recorded."),
  ];

  const register: (Paragraph | Table)[] = [
    heading("5. Workstation register"),
    ...table(["No", "Position", "PC", ...cols.map((c) => c.code), "Remarks"], registerRows, "No workstations."),
  ];

  const rest: (Paragraph | Table)[] = [
    heading("6. Room equipment"),
    ...table(["Item", "Type", "Location", "Status", "Reason / notes"], lineRows(report.fixtures), "No room equipment registered."),
    heading("7. Tables without a PC"),
    ...table(["Position", "Type", "Location", "Status", "Reason / notes"], lineRows(report.tables)),
    ...(report.notChecked.length ? [heading("Items not inspected"), ...table(["Item", "Type", "Location", "Status", "Reason"], lineRows(report.notChecked))] : []),
    ...(report.workstationsDown.length || report.configurationGaps.length
      ? [
          heading("8. Out of service & configuration gaps"),
          ...report.workstationsDown.map((w) => para(`${w.positionCode ?? "—"} ${w.label}: ${w.allMissing ? "workstation missing" : "completely out of service"}`)),
          ...report.configurationGaps.map((g) => para(`No ${g.typeName} registered at: ${g.positions.join(", ")}`)),
        ]
      : []),
    heading("9. Comparison with the previous approved audit"),
    ...(report.comparison
      ? [
          para(`Previous: ${report.comparison.previousReference} (${report.comparison.previousPeriodLabel})`),
          para(`New faults (${report.comparison.newFaults.length}): ${report.comparison.newFaults.join(", ") || "none"}`),
          para(`Fixed (${report.comparison.fixed.length}): ${report.comparison.fixed.join(", ") || "none"}`),
          para(`Still faulty (${report.comparison.stillFaulty.length}): ${report.comparison.stillFaulty.join(", ") || "none"}`),
        ]
      : [para("No previous approved audit for this room.", { italics: true })]),
    heading("10. Remarks and recommendations"),
    para(audit.generalRemarks || "—"),
    ...(audit.recommendations ? [para(`Recommendations: ${audit.recommendations}`)] : []),
    para("", { after: 200 }),
    signatureTable(report),
    ...(audit.approvedAt ? [para(`Approved in the system by ${audit.approvedBy ?? "—"} on ${fmtDateTime(audit.approvedAt)}.`, { size: 16 })] : []),
    ...(settings.footerNote ? [para(settings.footerNote, { size: 14 })] : []),
  ];

  const portrait = { page: { size: { width: PAGE.width, height: PAGE.height }, margin: PAGE.margin } };
  const wide = cols.length > 7;
  const sections: ISectionOptions[] = wide
    ? [
        { properties: portrait, headers: { default: header }, footers: { default: footer }, children: main },
        {
          properties: { page: { size: { width: PAGE.width, height: PAGE.height, orientation: PageOrientation.LANDSCAPE }, margin: PAGE.margin } },
          headers: { default: header },
          footers: { default: footer },
          children: register,
        },
        { properties: portrait, headers: { default: header }, footers: { default: footer }, children: rest },
      ]
    : [{ properties: portrait, headers: { default: header }, footers: { default: footer }, children: [...main, ...register, ...rest] }];

  const doc = new Document({
    creator: "LabLedger",
    title: `${audit.reference} — Monthly Lab Audit`,
    description: `${room.name} ${audit.periodLabel}`,
    styles: { default: { document: { run: { font: FONT, size: 18 } } } },
    sections,
  });
  return Packer.toBuffer(doc);
}
