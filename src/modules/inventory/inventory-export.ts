import type { Content, TDocumentDefinitions } from "pdfmake/interfaces.js";
import { env } from "../../config/env.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/prisma.js";
import { pdfmake } from "../reports/pdfmake.js";

const MAX_ROWS = 20_000;
const conditionLabel = { GOOD: "Good", NEEDS_REPAIR: "Needs repair", DAMAGED: "Damaged", UNSERVICEABLE: "Unserviceable" } as const;
const statusLabel = { IN_USE: "In use", IN_STORE: "In store", ON_LOAN: "On loan", MISSING: "Missing", DISPOSED: "Disposed" } as const;
const bookLabel = { PENDING_BOOK: "Not in book", WRITTEN_IN_BOOK: "In book", SYSTEM_ONLY: "System only" } as const;

const exportSelect = {
  tagCode: true,
  serialNo: true,
  custodian: true,
  condition: true,
  status: true,
  isBulk: true,
  bulkQty: true,
  location: { select: { code: true, name: true, building: true, floor: true } },
  ledgerEntry: {
    select: {
      description: true,
      brand: true,
      modelNo: true,
      itemCode: true,
      entryDate: true,
      receiptNo: true,
      refNo: true,
      unitPrice: true,
      bookVolume: true,
      bookPage: true,
      bookStatus: true,
      category: { select: { name: true } },
      department: { select: { code: true } },
    },
  },
} satisfies Prisma.AssetItemSelect;

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Quote everything; neutralise spreadsheet formulas typed into free-text fields.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** Asset register as CSV (opens directly in Excel; UTF-8 with BOM). */
export async function assetsCsv(where: Prisma.AssetItemWhereInput) {
  const rows = await prisma.assetItem.findMany({ where, orderBy: [{ location: { code: "asc" } }, { tagCode: "asc" }], take: MAX_ROWS, select: exportSelect });
  const header = ["Tag", "Description", "Category", "Brand", "Model", "Item code", "Serial no", "Quantity", "Room code", "Room", "Building", "Floor", "Custodian", "Condition", "Status", "Book volume", "Book page", "Book status", "Entry date", "Receipt / ref", "Unit price (LKR)", "Department"];
  const lines = rows.map((r) =>
    [
      r.tagCode,
      r.ledgerEntry.description,
      r.ledgerEntry.category?.name,
      r.ledgerEntry.brand,
      r.ledgerEntry.modelNo,
      r.ledgerEntry.itemCode,
      r.serialNo,
      r.isBulk ? (r.bulkQty ?? 1) : 1,
      r.location?.code,
      r.location?.name,
      r.location?.building,
      r.location?.floor,
      r.custodian,
      conditionLabel[r.condition],
      statusLabel[r.status],
      r.ledgerEntry.bookVolume,
      r.ledgerEntry.bookPage,
      bookLabel[r.ledgerEntry.bookStatus],
      r.ledgerEntry.entryDate.toISOString().slice(0, 10),
      r.ledgerEntry.receiptNo ?? r.ledgerEntry.refNo,
      r.ledgerEntry.unitPrice.toFixed(2),
      r.ledgerEntry.department.code,
    ]
      .map(cell)
      .join(","),
  );
  return { csv: `﻿${[header.map(cell).join(","), ...lines].join("\r\n")}\r\n`, count: rows.length, truncated: rows.length === MAX_ROWS };
}

/** Stable link printed in each QR code. Only the tag is encoded; data stays in the database. */
function itemUrl(tag: string) {
  const base = env.APP_URL ?? env.CORS_ORIGINS[0];
  return base ? `${base.replace(/\/$/, "")}/items/${encodeURIComponent(tag)}` : tag;
}

/**
 * A4 label sheet. "small": 3 × 8 labels (70 × 37 mm), "large": 2 × 5.
 * Each label shows the QR, the tag in large type, the description and room.
 */
export async function labelsPdf(where: Prisma.AssetItemWhereInput, size: "small" | "large") {
  const rows = await prisma.assetItem.findMany({
    where,
    orderBy: [{ location: { code: "asc" } }, { tagCode: "asc" }],
    take: 500,
    select: { tagCode: true, location: { select: { code: true } }, ledgerEntry: { select: { description: true, department: { select: { code: true } } } } },
  });
  const cols = size === "small" ? 3 : 2;
  const perPage = size === "small" ? 24 : 10;
  const width = 595.28 / cols;
  const height = size === "small" ? 105 : 168;
  const qr = size === "small" ? 72 : 120;

  const label = (r: (typeof rows)[number]): Content => ({
    columns: [
      { width: qr, qr: itemUrl(r.tagCode), fit: qr, eccLevel: "M", margin: [0, 2, 0, 0] },
      {
        stack: [
          { text: r.tagCode, bold: true, noWrap: true, fontSize: size === "small" ? 7.5 : 11 },
          { text: r.ledgerEntry.description.slice(0, 60), fontSize: size === "small" ? 7 : 9, margin: [0, 2, 0, 0] },
          { text: [r.location?.code, r.ledgerEntry.department.code].filter(Boolean).join(" · "), fontSize: 6.5, color: "#555", margin: [0, 2, 0, 0] },
        ],
        width: "*",
        margin: [6, 2, 0, 0],
      },
    ],
    columnGap: 0,
  });

  const content: Content[] = [];
  for (let p = 0; p < rows.length; p += perPage) {
    const page = rows.slice(p, p + perPage);
    const body = [];
    for (let i = 0; i < page.length; i += cols) {
      body.push(Array.from({ length: cols }, (_, c) => (page[i + c] ? label(page[i + c]!) : { text: "" })));
    }
    content.push({
      table: { widths: Array(cols).fill(width - 22), heights: height - 10, body, dontBreakRows: true },
      layout: { hLineWidth: () => 0.3, vLineWidth: () => 0.3, hLineColor: () => "#bbb", vLineColor: () => "#bbb", paddingLeft: () => 8, paddingTop: () => 6 },
      ...(p + perPage < rows.length && { pageBreak: "after" as const }),
    });
  }
  if (!content.length) content.push({ text: "No items match.", italics: true });

  const doc: TDocumentDefinitions = {
    pageSize: "A4",
    pageMargins: [8, 12, 8, 12],
    info: { title: "Asset labels", creator: "LabLedger" },
    defaultStyle: { font: "Roboto" },
    content,
  };
  const pdf = pdfmake.createPdf(doc);
  return { buffer: await pdf.getBuffer(), count: rows.length };
}
