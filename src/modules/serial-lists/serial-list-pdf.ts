import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces.js";
import { pdfmake } from "../reports/pdfmake.js";
import type { SerialReportData } from "./serial-lists.service.js";

/** A4 in points, 15 mm side/top margins, 18 mm bottom (footer). */
const MARGINS: [number, number, number, number] = [43, 50, 43, 51];

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Colombo" });
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Colombo" });

const tableLayout = {
  hLineWidth: (i: number) => (i === 0 || i === 1 ? 1 : 0.5),
  vLineWidth: () => 0.5,
  hLineColor: () => "#555",
  vLineColor: () => "#999",
  paddingLeft: () => 4,
  paddingRight: () => 4,
  paddingTop: () => 3,
  paddingBottom: () => 3,
};

/** Part / Brand / Model / Serial number columns inside each unit row. */
const PART_WIDTHS = [55, 60, 75, "*"];

const th = (text: string): TableCell => ({ text, bold: true, fillColor: "#e6e6e6" });
const heading = (text: string): Content => ({ text, style: "h2", margin: [0, 10, 0, 5] });

export async function renderSerialListPdf(input: SerialReportData): Promise<Buffer> {
  // pdfmake writes layout data into the definition it is given.
  const { list, settings, preparedBy, generatedAt } = structuredClone(input);
  const partCount = list.units.reduce((n, u) => n + u.components.length, 0);

  // One row per unit, its parts in a nested table, so a set never splits across pages.
  const partsTable = (rows: TableCell[][], header = false): TableCell => ({
    table: { widths: PART_WIDTHS, body: rows },
    layout: {
      ...tableLayout,
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
      vLineWidth: (i: number) => (i === 0 || i === PART_WIDTHS.length ? 0 : 0.5),
      hLineColor: () => (header ? "#555" : "#bbb"),
    },
    margin: [-4, -3, -4, -3],
  });
  const registerBody: TableCell[][] = list.units.map((unit, i) => [
    String(i + 1),
    unit.label ?? "—",
    { text: unit.productNumber, bold: true },
    partsTable(unit.components.map((c) => [c.kind, c.brand ?? "—", c.model ?? "—", { text: c.serialNo, bold: true }])),
  ]);
  const registerHeader: TableCell[] = [th("No"), th("Label"), th("Product number"), partsTable([["Part", "Brand", "Model", "Serial number"].map(th)], true)];

  // Count of parts by type and brand.
  const byKind = new Map<string, Map<string, number>>();
  for (const c of list.units.flatMap((u) => u.components)) {
    const brands = byKind.get(c.kind) ?? new Map<string, number>();
    brands.set(c.brand ?? "—", (brands.get(c.brand ?? "—") ?? 0) + 1);
    byKind.set(c.kind, brands);
  }
  const summaryBody: TableCell[][] = [...byKind].flatMap(([kind, brands]) =>
    [...brands].map(([brand, n], j): TableCell[] => [j === 0 ? { text: kind, bold: true } : "", brand, String(n)]),
  );
  summaryBody.push([{ text: "Total parts", bold: true }, "", { text: String(partCount), bold: true }]);

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
        { text: "Serial Number Register", style: "title" },
        { text: list.title, alignment: "center", bold: true },
        list.location ? { text: list.location, alignment: "center" } : "",
      ],
      margin: [0, 0, 0, 10],
    },
    {
      table: {
        widths: ["auto", "*", "auto", "*"],
        body: [
          [th("Units"), String(list.units.length), th("Parts"), String(partCount)],
          [th("Prepared by"), preparedBy, th("Generated"), fmtDateTime(generatedAt)],
        ],
      },
      layout: tableLayout,
      fontSize: 9,
      margin: [0, 0, 0, 6],
    },
    list.notes ? { text: list.notes, fontSize: 9, margin: [0, 2, 0, 4] } : "",
    heading("1. Register"),
    registerBody.length
      ? {
          table: { headerRows: 1, dontBreakRows: true, widths: [18, 50, 90, "*"], body: [registerHeader, ...registerBody] },
          layout: tableLayout,
          fontSize: 8.5,
          margin: [0, 0, 0, 10],
        }
      : { text: "No units recorded.", italics: true, color: "#555" },
    {
      unbreakable: true,
      stack: [
        heading("2. Summary by part and brand"),
        partCount
          ? { table: { headerRows: 1, widths: [120, "*", 50], body: [[th("Part"), th("Brand"), th("Count")], ...summaryBody] }, layout: tableLayout, fontSize: 9 }
          : { text: "—", italics: true },
      ],
    },
    {
      unbreakable: true,
      margin: [0, 24, 0, 0],
      stack: [
        {
          columns: [
            signature("Prepared by", preparedBy, null, fmtDate(generatedAt)),
            signature(settings.checkedByLabel, null, null, null),
            signature(settings.hodDesignation, settings.hodName, settings.hodDesignation, null),
          ],
          columnGap: 16,
          fontSize: 9,
        },
        settings.footerNote ? { text: settings.footerNote, fontSize: 7.5, color: "#555", margin: [0, 8, 0, 0] } : "",
      ],
    },
  ];

  const generated = new Date(generatedAt);
  const doc: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: MARGINS,
    info: {
      title: `${list.title} — Serial Number Register`,
      author: preparedBy,
      creator: "LabLedger",
      producer: "LabLedger",
      creationDate: generated,
      modDate: generated,
    },
    header: (page) =>
      page === 1 ? "" : { text: `${list.title} · Serial Number Register`, fontSize: 7.5, color: "#555", margin: [MARGINS[0], 24, MARGINS[2], 0] },
    footer: (page, pages) => ({
      columns: [
        { text: `Generated ${fmtDateTime(generatedAt)}`, fontSize: 7.5 },
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
