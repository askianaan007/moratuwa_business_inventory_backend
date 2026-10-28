import { createRequire } from "node:module";
import path from "node:path";
import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces.js";
import type { LabCheckStatus } from "../../generated/prisma/client.js";
import { STATUSES, STATUS_CODE, STATUS_LABEL, type ReportData } from "../lab-audits/lab-audit-report.js";
import { planSvg } from "./plan-svg.js";

// pdfmake is CommonJS and exports a pre-built instance.
const require = createRequire(import.meta.url);
const pdfmake = require("pdfmake") as typeof import("pdfmake");
const fontDir = path.join(path.dirname(require.resolve("pdfmake/package.json")), "fonts", "Roboto");
pdfmake.setFonts({
  Roboto: {
    normal: path.join(fontDir, "Roboto-Regular.ttf"),
    bold: path.join(fontDir, "Roboto-Medium.ttf"),
    italics: path.join(fontDir, "Roboto-Italic.ttf"),
    bolditalics: path.join(fontDir, "Roboto-MediumItalic.ttf"),
  },
});
// Reports never fetch anything: no remote URLs, and only the bundled fonts on disk.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((file) => path.resolve(file).startsWith(fontDir));

/** A4 in points, 15 mm side/top margins, 18 mm bottom (footer). */
const MARGINS: [number, number, number, number] = [43, 50, 43, 51];
const CONTENT_WIDTH = 595.28 - MARGINS[0] - MARGINS[2];

const SHADE: Record<LabCheckStatus, string> = {
  WORKING: "#e8f5e9",
  NOT_CHECKED: "#ffffff",
  REMOVED: "#eeeeee",
  NEEDS_REPAIR: "#fff3cd",
  NOT_WORKING: "#f8d7da",
  MISSING: "#f8d7da",
};

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }) : "—";
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" });

const tableLayout = {
  hLineWidth: (i: number) => (i === 0 || i === 1 ? 1 : 0.5),
  vLineWidth: () => 0.5,
  hLineColor: () => "#555",
  vLineColor: () => "#999",
  paddingLeft: () => 4,
  paddingRight: () => 4,
  paddingTop: () => 2.5,
  paddingBottom: () => 2.5,
};

const th = (text: string): TableCell => ({ text, bold: true, fillColor: "#e6e6e6" });
const statusCell = (status: LabCheckStatus, text?: string): TableCell => ({ text: text ?? STATUS_CODE[status], fillColor: SHADE[status], bold: status !== "WORKING" });

function table(headers: string[], body: TableCell[][], widths: (string | number)[], empty = "None."): Content {
  if (!body.length) return { text: empty, italics: true, color: "#555", margin: [0, 0, 0, 8] };
  return {
    table: { headerRows: 1, dontBreakRows: true, widths, body: [headers.map(th), ...body] },
    layout: tableLayout,
    fontSize: 8.5,
    margin: [0, 0, 0, 10],
  };
}

const heading = (text: string): Content => ({ text, style: "h2", margin: [0, 10, 0, 5] });

export async function renderPdf(input: ReportData): Promise<Buffer> {
  // pdfmake writes layout data into the definition it is given; never let it touch the snapshot.
  const report = structuredClone(input);
  const { audit, room, settings, counts } = report;
  const roomLine = [room.name, room.code, room.building, room.floor && `Floor ${room.floor}`].filter(Boolean).join(" · ");

  const summaryBody: TableCell[][] = [
    [th("Positions"), th("PCs"), th("Empty tables"), th("Room items"), th("Items"), th("Inspected"), th("Completion")],
    [
      String(counts.seats),
      String(counts.workstations),
      String(counts.emptyTables),
      String(counts.fixtures),
      String(counts.checks),
      String(counts.checked),
      { text: `${counts.completion}%`, bold: true },
    ],
  ];

  const typeBody: TableCell[][] = report.types.map((t) => [t.name, ...STATUSES.map((s) => (t.byStatus[s] ? String(t.byStatus[s]) : "–"))]);
  typeBody.push([{ text: "Total", bold: true }, ...STATUSES.map((s) => ({ text: String(counts.byStatus[s]), bold: true }))]);

  const planContent: Content = report.plan.desks.length
    ? {
        svg: planSvg(report.plan, report.deskStatus, report.fixtureStatus),
        fit: [CONTENT_WIDTH, Math.min(400, (CONTENT_WIDTH / report.plan.width) * report.plan.height)],
        alignment: "center",
      }
    : { text: "No layout configured.", italics: true };

  const legend: Content = {
    text: STATUSES.map((s) => `${STATUS_CODE[s]} = ${STATUS_LABEL[s]}`).join("   ·   ") + "   ·   dashed = empty table",
    fontSize: 7.5,
    color: "#333",
    margin: [0, 4, 0, 8],
  };

  const cols = report.stationColumns;
  const wide = cols.length > 7;
  const registerBody: TableCell[][] = report.workstations.map((w) => [
    w.number === null ? "" : String(w.number),
    w.positionCode ?? "—",
    { text: w.label, bold: true },
    ...cols.map((c): TableCell => {
      const cells = w.cells[c.code];
      if (!cells?.length) return { text: "—", color: "#777" };
      const worst = cells.find((x) => x.status !== "WORKING") ?? cells[0]!;
      return statusCell(worst.status, cells.map((x) => STATUS_CODE[x.status]).join("/"));
    }),
    { text: w.remarks ?? "", fontSize: 7.5 },
  ]);

  const faultsBody: TableCell[][] = report.faults.map((f) => [
    f.positionCode ?? "—",
    f.stationLabel ?? "—",
    { text: f.itemCode, bold: true },
    f.typeName,
    statusCell(f.status, STATUS_LABEL[f.status]),
    f.reason ?? "—",
    [f.actionTaken, f.followUp && `Follow-up: ${f.followUp}`].filter(Boolean).join("\n") || "—",
    f.monthsOutstanding ? String(f.monthsOutstanding) : "–",
  ]);

  const lineBody = (lines: ReportData["fixtures"]) =>
    lines.map((l): TableCell[] => [{ text: l.itemCode, bold: true }, l.typeName, l.positionCode ?? "—", statusCell(l.status, STATUS_LABEL[l.status]), l.reason ?? l.notes ?? "—"]);

  const signature = (title: string, name: string | null, sub: string | null, date: string | null): Content => ({
    stack: [
      { text: title, bold: true, margin: [0, 0, 0, 26] },
      { canvas: [{ type: "line", x1: 0, y1: 0, x2: 150, y2: 0, lineWidth: 0.8 }] },
      { text: name ?? "Name: ……………………………", margin: [0, 3, 0, 0] },
      { text: sub ?? " ", fontSize: 8, color: "#444" },
      { text: `Date: ${date ?? "……………………"}`, fontSize: 8, margin: [0, 2, 0, 0] },
    ],
  });

  const content: Content[] = [
    {
      stack: [
        settings.institution ? { text: settings.institution, style: "inst" } : "",
        settings.faculty ? { text: settings.faculty, alignment: "center" } : "",
        { text: settings.departmentTitle, alignment: "center", bold: true },
        { text: "Monthly Computer Lab Audit Report", style: "title" },
        { text: `${roomLine}`, alignment: "center" },
        { text: `Reporting month: ${audit.periodLabel}   ·   Reference: ${audit.reference}`, alignment: "center", margin: [0, 2, 0, 0] },
      ],
      margin: [0, 0, 0, 10],
    },
    {
      table: {
        widths: ["auto", "*", "auto", "*"],
        body: [
          [th("Auditor"), audit.auditorName, th("Designation"), audit.auditorDesignation ?? "—"],
          [th("Audit started"), fmtDate(audit.startedOn), th("Completed"), fmtDate(audit.completedOn)],
          [th("Submitted"), audit.submittedAt ? fmtDateTime(audit.submittedAt) : "—", th("Status"), report.kind === "DRAFT" ? "DRAFT (not submitted)" : report.kind],
        ],
      },
      layout: tableLayout,
      fontSize: 9,
      margin: [0, 0, 0, 8],
    },
    heading("1. Summary"),
    { table: { widths: Array(7).fill("*"), body: summaryBody }, layout: tableLayout, fontSize: 9, margin: [0, 0, 0, 6] },
    table(["Equipment type", ...STATUSES.map((s) => STATUS_LABEL[s])], typeBody, ["*", ...STATUSES.map(() => 48)]),
    heading("2. Key findings"),
    { ul: report.findings, fontSize: 9, margin: [0, 0, 0, 6] },
    // Heading, plan and legend stay on one page.
    { unbreakable: true, stack: [heading("3. Room plan (top view, board at the top)"), planContent, legend] },
    heading("4. Fault register"),
    table(
      ["Position", "PC", "Item", "Type", "Status", "Reason", "Action / follow-up", "Months"],
      faultsBody,
      [44, 44, 46, 50, 52, "*", 90, 30],
      "No faults recorded.",
    ),
    {
      ...((wide ? { pageBreak: "before", pageOrientation: "landscape" } : {}) as object),
      stack: [
        heading("5. Workstation register"),
        table(["No", "Position", "PC", ...cols.map((c) => c.code), "Remarks"], registerBody, [18, 46, 48, ...cols.map(() => 30), "*"], "No workstations."),
      ],
    } as Content,
    ...(wide ? [{ text: "", pageBreak: "before", pageOrientation: "portrait" } as Content] : []),
    heading("6. Room equipment"),
    table(["Item", "Type", "Location", "Status", "Reason / notes"], lineBody(report.fixtures), [50, 80, 70, 60, "*"], "No room equipment registered."),
    heading("7. Tables without a PC"),
    table(["Position", "Type", "Location", "Status", "Reason / notes"], lineBody(report.tables), [50, 80, 70, 60, "*"], "None."),
  ];

  if (report.notChecked.length) {
    content.push(heading("Items not inspected"), table(["Item", "Type", "Location", "Status", "Reason"], lineBody(report.notChecked), [50, 80, 70, 60, "*"]));
  }
  if (report.workstationsDown.length || report.configurationGaps.length) {
    content.push(heading("8. Out of service & configuration gaps"));
    if (report.workstationsDown.length) {
      content.push({
        ul: report.workstationsDown.map((w) => `${w.positionCode ?? "—"} ${w.label}: ${w.allMissing ? "workstation missing" : "completely out of service"}`),
        fontSize: 9,
        margin: [0, 0, 0, 4],
      });
    }
    for (const gap of report.configurationGaps) {
      content.push({ text: `No ${gap.typeName} registered at: ${gap.positions.join(", ")}`, fontSize: 9, margin: [0, 0, 0, 2] });
    }
  }

  content.push(heading("9. Comparison with the previous approved audit"));
  content.push(
    report.comparison
      ? {
          fontSize: 9,
          stack: [
            `Previous: ${report.comparison.previousReference} (${report.comparison.previousPeriodLabel})`,
            `New faults (${report.comparison.newFaults.length}): ${report.comparison.newFaults.join(", ") || "none"}`,
            `Fixed (${report.comparison.fixed.length}): ${report.comparison.fixed.join(", ") || "none"}`,
            `Still faulty (${report.comparison.stillFaulty.length}): ${report.comparison.stillFaulty.join(", ") || "none"}`,
          ],
        }
      : { text: "No previous approved audit for this room.", italics: true, fontSize: 9 },
  );

  content.push({
    unbreakable: true,
    stack: [
      heading("10. Remarks and recommendations"),
      { text: audit.generalRemarks || "—", fontSize: 9, margin: [0, 0, 0, 4] },
      { text: audit.recommendations ? `Recommendations: ${audit.recommendations}` : "", fontSize: 9, margin: [0, 0, 0, 14] },
      {
        columns: [
          signature("Prepared by", audit.auditorName, audit.auditorDesignation, fmtDate(audit.completedOn)),
          signature(settings.checkedByLabel, null, null, null),
          signature(settings.hodDesignation, settings.hodName, settings.hodDesignation, audit.approvedAt ? fmtDate(audit.approvedAt) : null),
        ],
        columnGap: 16,
        fontSize: 9,
      },
      audit.approvedAt
        ? { text: `Approved in the system by ${audit.approvedBy ?? "—"} on ${fmtDateTime(audit.approvedAt)}.`, fontSize: 8, margin: [0, 10, 0, 0] }
        : "",
      settings.footerNote ? { text: settings.footerNote, fontSize: 7.5, color: "#555", margin: [0, 8, 0, 0] } : "",
    ],
  });

  const generated = new Date(report.generatedAt);
  const doc: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: MARGINS,
    info: {
      title: `${audit.reference} — Monthly Lab Audit`,
      author: audit.auditorName,
      subject: `${room.name} ${audit.periodLabel}`,
      creator: "LabLedger",
      producer: "LabLedger",
      creationDate: generated,
      modDate: generated,
    },
    ...(report.kind === "DRAFT" && { watermark: { text: "DRAFT", opacity: 0.08, bold: true } }),
    header: (page) =>
      page === 1
        ? ""
        : { text: `${audit.reference} · ${room.name} · ${audit.periodLabel}`, fontSize: 7.5, color: "#555", margin: [MARGINS[0], 24, MARGINS[2], 0] },
    footer: (page, pages) => ({
      columns: [
        { text: `${audit.reference}${report.revision ? ` · rev ${report.revision}` : ""} · Generated ${fmtDateTime(report.generatedAt)}`, fontSize: 7.5 },
        { text: `Page ${page} of ${pages}`, alignment: "right", fontSize: 7.5 },
      ],
      margin: [MARGINS[0], 18, MARGINS[2], 0],
      color: "#444",
    }),
    content,
    defaultStyle: { font: "Roboto", fontSize: 9.5, lineHeight: 1.15 },
    styles: {
      inst: { fontSize: 13, bold: true, alignment: "center" },
      title: { fontSize: 15, bold: true, alignment: "center", margin: [0, 6, 0, 2] },
      h2: { fontSize: 11, bold: true },
    },
  };

  return pdfmake.createPdf(doc).getBuffer();
}
