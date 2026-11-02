import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
// pdfmake is CommonJS and exports a pre-built instance.
export const pdfmake = require("pdfmake") as typeof import("pdfmake");
// The fonts come from pdfmake's bundled font module and are written to the temp
// folder once. Reading the .ttf files from node_modules by path broke on
// Vercel: serverless bundles leave out files that are only read at runtime.
// They must be real files: the room-plan SVG opens its fonts by path.
const vfsFonts = require("pdfmake/build/vfs_fonts.js") as Record<string, string>;
const fontDir = path.join(os.tmpdir(), "labledger-fonts");
mkdirSync(fontDir, { recursive: true });
const font = (file: string) => {
  const target = path.join(fontDir, file);
  if (!existsSync(target)) {
    if (!vfsFonts[file]) throw new Error(`pdfmake font ${file} is missing`);
    writeFileSync(target, Buffer.from(vfsFonts[file], "base64"));
  }
  return target;
};
pdfmake.setFonts({
  Roboto: {
    normal: font("Roboto-Regular.ttf"),
    bold: font("Roboto-Medium.ttf"),
    italics: font("Roboto-Italic.ttf"),
    bolditalics: font("Roboto-MediumItalic.ttf"),
  },
});
// Reports never fetch anything: no remote URLs, and only those font files.
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((file) => path.resolve(file).startsWith(fontDir));
