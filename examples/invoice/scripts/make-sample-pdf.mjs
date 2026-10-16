/**
 * Regenerate `public/sample-invoice.pdf`.
 *
 * A minimal one-page PDF 1.4 with correct cross-reference offsets, so the
 * `pdfPath` demo in this example prints a real document. Run from the
 * example directory:
 *
 *   node scripts/make-sample-pdf.mjs
 *
 * Helvetica is a base-14 font: every PDF viewer already has it, so the file
 * needs no embedded fonts.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const lines = [
  ["Invoice INV-2049", 20, 750],
  ["Paper Planes Co. - 14 Cloud Lane, Portsburg", 12, 722],
  ["Bill to: Harbour Books Ltd., 9 Quay Street", 12, 704],
  ["", 12, 686],
  ["Glider, folding x120 @ $1.20 ......... $144.00", 12, 668],
  ["Glider, deluxe x25 @ $4.90 ........... $122.50", 12, 650],
  ["Custom print run x1 @ $85.00 .......... $85.00", 12, 632],
  ["", 12, 614],
  ["Subtotal $351.50   Tax (19%) $66.79", 12, 596],
  ["Total $418.29", 14, 574],
];

const escape = (s) =>
  s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

const content = [
  ...lines.flatMap(([text, size, y]) => [
    `BT /F1 ${size} Tf 72 ${y} Td (${escape(text)}) Tj ET`,
  ]),
].join("\n");

const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
    "/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
];

let out = "%PDF-1.4\n";
const offsets = [0];
for (let i = 0; i < objects.length; i += 1) {
  offsets.push(Buffer.byteLength(out));
  out += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefAt = Buffer.byteLength(out);
out += `xref\n0 ${objects.length + 1}\n`;
out += "0000000000 65535 f \n";
for (let i = 1; i <= objects.length; i += 1) {
  out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
out += `startxref\n${xrefAt}\n%%EOF\n`;

writeFileSync(join(root, "public", "sample-invoice.pdf"), out);
console.log(`wrote public/sample-invoice.pdf (${Buffer.byteLength(out)} bytes)`);
