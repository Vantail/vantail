/**
 * A minimal one-page PDF for the current invoice, built by hand.
 *
 * No dependency: a text-only invoice needs five objects (catalog, pages,
 * page, content stream, Helvetica) and a correct cross-reference table. The
 * table is byte offsets, so everything is assembled as UTF-8 bytes with the
 * offsets measured - not guessed - as it goes. Non-ASCII input stays valid
 * input: it encodes to UTF-8 and the offsets still land, even if Helvetica
 * itself only draws the ASCII half of it properly.
 */

import { money, subtotal, type Invoice } from "./invoice.js";

/** Parentheses and backslashes end a PDF literal string; escape them. */
function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function text(
  size: number,
  x: number,
  y: number,
  value: string,
): string {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${escapePdfText(value)}) Tj ET`;
}

/**
 * The invoice as a complete PDF file, ready to write to disk and print.
 * Pure - no I/O, no runtime calls - so it is testable without a window.
 */
export function renderInvoicePdf(data: Invoice): Uint8Array {
  const encoder = new TextEncoder();

  let y = 760;
  const lines = [
    text(20, 72, y, `Invoice ${data.number}`),
    text(11, 72, (y -= 22), `${data.issuer} - ${data.issuerEmail}`),
  ];
  y -= 18;
  lines.push(`0.6 w 72 ${y} m 523 ${y} l S`);

  for (const item of data.items) {
    y -= 20;
    lines.push(text(11, 72, y, `${item.description}  x${item.qty}`));
    lines.push(text(11, 440, y, money(item.qty * item.unitPrice)));
  }

  y -= 20;
  lines.push(`0.6 w 72 ${y} m 523 ${y} l S`);
  y -= 22;
  lines.push(text(13, 72, y, `Total  ${money(subtotal(data))}`));
  y -= 24;
  lines.push(text(10, 72, y, "Thank you for your business."));

  const content = lines.join("\n") + "\n";
  const contentBytes = encoder.encode(content);

  const objects: Uint8Array[] = [
    encoder.encode("<< /Type /Catalog /Pages 2 0 R >>"),
    encoder.encode("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    encoder.encode(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R " +
        "/Resources << /Font << /F1 5 0 R >> >> >>",
    ),
    concat([
      encoder.encode(`<< /Length ${contentBytes.length} >>\nstream\n`),
      contentBytes,
      encoder.encode("endstream"),
    ]),
    encoder.encode("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];

  const parts: Uint8Array[] = [encoder.encode("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(length);
    const header = encoder.encode(`${index + 1} 0 obj\n`);
    const footer = encoder.encode("\nendobj\n");
    parts.push(header, object, footer);
    length += header.length + object.length + footer.length;
  }

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  xref +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${length}\n%%EOF`;

  return concat([...parts, encoder.encode(xref)]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
