import type { Content, TableCell, TDocumentDefinitions } from "pdfmake/interfaces.js";
import { pdfmake } from "../reports/pdfmake.js";
import type { SerialReportData } from "./serial-lists.service.js";

/** A4 in points, 15 mm side/top margins, 18 mm bottom (footer). */
const MARGINS: [number, number, number, number] = [43, 50, 43, 51];
const PORTRAIT_WIDTH = 595.28 - MARGINS[0] - MARGINS[2];
const LANDSCAPE_WIDTH = 841.89 - MARGINS[0] - MARGINS[2];
const FONT_SIZE = 8.5;

/** Rough printed width of a Roboto string (plus a little slack): enough to size columns to their content. */
const textWidth = (text: string, bold = false) => text.length * FONT_SIZE * (bold ? 0.64 : 0.56) + 3;
/** pdfmake widths exclude each cell's left/right padding (4 + 4) and its border line. */
const CELL_EXTRA = 8.5;
const fit = (values: string[], { min, max, bold = false }: { min: number; max: number; bold?: boolean }) =>
  Math.min(max, Math.max(min, ...values.map((v) => textWidth(v, bold))));

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

/** Layout for the two-row register header: heavier lines around it. */
const registerLayout = {
  ...tableLayout,
  hLineWidth: (i: number) => (i === 0 || i === 2 ? 1 : 0.5),
};

const th = (text: string) => ({ text, bold: true, fillColor: "#e6e6e6" });
const heading = (text: string): Content => ({ text, style: "h2", margin: [0, 10, 0, 5] });

export async function renderSerialListPdf(input: SerialReportData): Promise<Buffer> {
  // pdfmake writes layout data into the definition it is given.
  const { list, settings, preparedBy, generatedAt } = structuredClone(input);
  const partCount = list.units.reduce((n, u) => n + u.components.length, 0);

  const register = registerTable(list.units);
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
    list.units.length ? register.content : { text: "No units recorded.", italics: true, color: "#555" },
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
    pageOrientation: register.landscape ? "landscape" : "portrait",
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

type Unit = SerialReportData["list"]["units"][number];

const brandModel = (c: { brand: string | null; model: string | null }) => [c.brand, c.model].filter(Boolean).join(" ") || "—";

/**
 * The register, one row per unit. Usually every unit has the same parts (a
 * monitor and a CPU), so each part type gets its own column group: serial,
 * brand / model and, when any is recorded, product code. Columns are sized to
 * their content, and the page turns landscape only when they do not fit
 * portrait. Lists that do not fit that shape (a unit with two parts of the same
 * type, or many part types) list each unit's parts in a nested table instead.
 */
function registerTable(units: Unit[]): { content: Content; landscape: boolean } {
  const kinds = [...new Set(units.flatMap((u) => u.components.map((c) => c.kind)))];
  const oneOfEach = units.every((u) => new Set(u.components.map((c) => c.kind)).size === u.components.length);

  const fixedWidths = [
    16,
    fit(units.map((u) => u.label ?? "—"), { min: 34, max: 60 }),
    fit(units.map((u) => u.productNumber), { min: 56, max: 110, bold: true }),
  ];
  const fixedHeader = (row: 0 | 1): TableCell[] =>
    row === 0 ? [{ ...th("No"), rowSpan: 2 } as TableCell, { ...th("Label"), rowSpan: 2 } as TableCell, { ...th("Product number"), rowSpan: 2 } as TableCell] : [{}, {}, {}] as TableCell[];
  const fixedCells = (u: Unit, i: number, fill?: string): TableCell[] => [
    { text: String(i + 1), fillColor: fill },
    { text: u.label ?? "—", fillColor: fill },
    { text: u.productNumber, bold: true, fillColor: fill },
  ];
  const shade = (i: number) => (i % 2 ? "#f5f5f5" : undefined);

  if (oneOfEach && kinds.length <= 4) {
    const groups = kinds.map((kind) => {
      const parts = units.map((u) => u.components.find((c) => c.kind === kind));
      const present = parts.filter((c): c is NonNullable<typeof c> => Boolean(c));
      const withCode = present.some((c) => c.productCode);
      return {
        kind,
        parts,
        withCode,
        widths: [
          fit(present.map((c) => c.serialNo), { min: 60, max: 170, bold: true }),
          fit(present.map(brandModel), { min: 55, max: 120 }),
          ...(withCode ? [fit(present.map((c) => c.productCode ?? ""), { min: 55, max: 110 })] : []),
        ],
      };
    });

    const natural = [...fixedWidths, ...groups.flatMap((g) => g.widths)];
    const total = natural.reduce((a, b) => a + b, 0);
    const room = (page: number) => page - natural.length * CELL_EXTRA - 1;
    if (total <= room(LANDSCAPE_WIDTH)) {
      const landscape = total > room(PORTRAIT_WIDTH);
      // Share the spare width out proportionally, so the table spans the page.
      const scale = room(landscape ? LANDSCAPE_WIDTH : PORTRAIT_WIDTH) / total;
      const widths = natural.map((w) => Math.floor(w * scale * 10) / 10);

      const header0: TableCell[] = [
        ...fixedHeader(0),
        ...groups.flatMap((g) => [{ ...th(g.kind), colSpan: g.widths.length, alignment: "center" } as TableCell, ...Array<TableCell>(g.widths.length - 1).fill({})]),
      ];
      const header1: TableCell[] = [
        ...fixedHeader(1),
        ...groups.flatMap((g) => [th("Serial number"), th("Brand / model"), ...(g.withCode ? [th("Product code")] : [])]),
      ];
      const body: TableCell[][] = units.map((u, i) => [
        ...fixedCells(u, i, shade(i)),
        ...groups.flatMap((g): TableCell[] => {
          const c = g.parts[i];
          return [
            { text: c?.serialNo ?? "—", bold: Boolean(c), fillColor: shade(i) },
            { text: c ? brandModel(c) : "—", fillColor: shade(i) },
            ...(g.withCode ? [{ text: c?.productCode ?? "—", fillColor: shade(i) }] : []),
          ];
        }),
      ]);

      return {
        landscape,
        content: {
          table: { headerRows: 2, dontBreakRows: true, widths, body: [header0, header1, ...body] },
          layout: registerLayout,
          fontSize: FONT_SIZE,
          margin: [0, 0, 0, 10],
        },
      };
    }
  }

  // Fallback: each unit's parts in a nested table, so a set never splits across pages.
  const withCode = units.some((u) => u.components.some((c) => c.productCode));
  const partWidths = [50, 70, ...(withCode ? [70] : []), "*"];
  const partsTable = (rows: TableCell[][], header = false): TableCell => ({
    table: { widths: partWidths, body: rows },
    layout: {
      ...tableLayout,
      hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i === 0 || i === node.table.body.length ? 0 : 0.5),
      vLineWidth: (i: number) => (i === 0 || i === partWidths.length ? 0 : 0.5),
      hLineColor: () => (header ? "#555" : "#bbb"),
    },
    margin: [-4, -3, -4, -3],
  });
  const row = (c: Unit["components"][number]): TableCell[] => [c.kind, brandModel(c), ...(withCode ? [c.productCode ?? "—"] : []), { text: c.serialNo, bold: true }];
  return {
    landscape: true,
    content: {
      table: {
        headerRows: 1,
        dontBreakRows: true,
        widths: [16, fixedWidths[1]!, fixedWidths[2]!, "*"],
        body: [
          [th("No"), th("Label"), th("Product number"), partsTable([["Part", "Brand / model", ...(withCode ? ["Product code"] : []), "Serial number"].map(th)], true)],
          ...units.map((u, i): TableCell[] => [String(i + 1), u.label ?? "—", { text: u.productNumber, bold: true }, partsTable(u.components.map(row))]),
        ],
      },
      layout: tableLayout,
      fontSize: FONT_SIZE,
      margin: [0, 0, 0, 10],
    },
  };
}
