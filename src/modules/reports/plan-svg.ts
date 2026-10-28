import type { LabCheckStatus } from "../../generated/prisma/client.js";
import type { PlanGeometry } from "../rooms/plan-geometry.js";

/**
 * Print version of the room plan as an SVG string (for the PDF). Statuses use
 * fill shade AND a letter code so the plan reads in black and white.
 */
const FILL: Record<LabCheckStatus, string> = {
  WORKING: "#e8f5e9",
  NOT_CHECKED: "#ffffff",
  REMOVED: "#eeeeee",
  NEEDS_REPAIR: "#fff3cd",
  NOT_WORKING: "#f8d7da",
  MISSING: "#f8d7da",
};
const MARK: Record<LabCheckStatus, string> = { WORKING: "OK", NOT_CHECKED: "NC", REMOVED: "RM", NEEDS_REPAIR: "NR", NOT_WORKING: "NW", MISSING: "MS" };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function planSvg(plan: PlanGeometry, deskStatus: Record<string, LabCheckStatus>, fixtureStatus: Record<string, LabCheckStatus>) {
  const parts: string[] = [];
  const { width: w, height: h, board } = plan;
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);
  parts.push(`<rect x="1" y="1" width="${w - 2}" height="${h - 2}" fill="#fff" stroke="#000" stroke-width="2"/>`);
  parts.push(`<rect x="${board.x}" y="${board.y}" width="${board.w}" height="${board.h}" fill="#333"/>`);
  parts.push(`<text x="${board.x + board.w / 2}" y="${board.y + 12}" font-size="10" fill="#fff" text-anchor="middle">FRONT · BOARD</text>`);

  for (const b of plan.blocks) {
    parts.push(`<text x="${b.x + 28}" y="${b.y + 14}" font-size="11" font-weight="bold" fill="#000">Block ${esc(b.code)} · ${esc(b.name)}</text>`);
  }
  for (const r of plan.rows) {
    parts.push(`<text x="${r.x + 12}" y="${r.y + 4}" font-size="10" fill="#444" text-anchor="middle">R${esc(r.label)}</text>`);
  }
  for (const d of plan.desks) {
    if (d.kind === "NO_TABLE") continue;
    const status = deskStatus[d.seatId];
    const dashed = d.kind === "EMPTY_TABLE" ? ` stroke-dasharray="4 3"` : "";
    const fill = status ? FILL[status] : "#fff";
    const heavy = status === "NOT_WORKING" || status === "MISSING" ? 2.5 : 1;
    parts.push(`<rect x="${d.x}" y="${d.y}" width="${d.w}" height="${d.h}" rx="4" fill="${fill}" stroke="#000" stroke-width="${heavy}"${dashed}/>`);
    const title = d.kind === "EMPTY_TABLE" ? "empty" : d.kind === "INSTRUCTOR" && !d.label ? "instr." : (d.label ?? "");
    parts.push(`<text x="${d.x + d.w / 2}" y="${d.y + 17}" font-size="10" font-weight="bold" text-anchor="middle" fill="#000">${esc(title)}</text>`);
    parts.push(`<text x="${d.x + d.w / 2}" y="${d.y + 30}" font-size="8" text-anchor="middle" fill="#333">S${d.seatNumber}${status ? ` · ${MARK[status]}` : ""}</text>`);
  }
  for (const f of plan.fixtures) {
    const status = fixtureStatus[f.equipmentId];
    parts.push(`<rect x="${f.x - 22}" y="${f.y - 9}" width="44" height="18" rx="9" fill="${status ? FILL[status] : "#fff"}" stroke="#000"/>`);
    parts.push(`<text x="${f.x}" y="${f.y + 3}" font-size="8" text-anchor="middle" fill="#000">${esc(f.code)}${status ? ` ${MARK[status]}` : ""}</text>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
