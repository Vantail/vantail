/**
 * The invoice, as data and as printable HTML.
 *
 * The HTML is self-contained on purpose: every rule it needs travels inside
 * the string as inline styles, because it renders in a hidden view that never
 * loads the app's stylesheet. A printout that depended on the app's CSS would
 * print the app's look by accident - or nothing at all.
 */

export interface LineItem {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface Invoice {
  number: string;
  issued: string;
  due: string;
  from: { name: string; lines: string[] };
  to: { name: string; lines: string[] };
  items: LineItem[];
  /** e.g. 0.19 for 19% VAT. */
  taxRate: number;
}

export const demoInvoice: Invoice = {
  number: "INV-2049",
  issued: "2026-10-11",
  due: "2026-11-10",
  from: {
    name: "Paper Planes Co.",
    lines: ["14 Cloud Lane", "Portsburg", "hello@paperplanes.example"],
  },
  to: {
    name: "Harbour Books Ltd.",
    lines: ["9 Quay Street", "Portsburg", "accounts@harbourbooks.example"],
  },
  items: [
    { description: "Glider, folding", qty: 120, unitPrice: 1.2 },
    { description: "Glider, deluxe", qty: 25, unitPrice: 4.9 },
    { description: "Custom print run", qty: 1, unitPrice: 85.0 },
  ],
  taxRate: 0.19,
};

export function totals(invoice: Invoice): {
  subtotal: number;
  tax: number;
  total: number;
} {
  const subtotal = invoice.items.reduce(
    (sum, item) => sum + item.qty * item.unitPrice,
    0,
  );
  const tax = subtotal * invoice.taxRate;
  return { subtotal, tax, total: subtotal + tax };
}

const money = (n: number): string =>
  `$${n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;

const escape = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** A complete document: inline styles, no external CSS, no app classes. */
export function buildInvoiceHtml(invoice: Invoice): string {
  const { subtotal, tax, total } = totals(invoice);
  const rows = invoice.items
    .map(
      (item) => `<tr>
        <td style="padding: 8px 0; border-bottom: 1px solid #ddd;">${escape(item.description)}</td>
        <td style="padding: 8px 0; border-bottom: 1px solid #ddd; text-align: right;">${item.qty}</td>
        <td style="padding: 8px 0; border-bottom: 1px solid #ddd; text-align: right;">${money(item.unitPrice)}</td>
        <td style="padding: 8px 0; border-bottom: 1px solid #ddd; text-align: right;">${money(item.qty * item.unitPrice)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Georgia, 'Times New Roman', serif; color: #111; padding: 48px; max-width: 680px;">
  <h1 style="font-size: 24px; margin: 0 0 4px;">Invoice ${escape(invoice.number)}</h1>
  <p style="color: #555; margin: 0 0 24px;">Issued ${escape(invoice.issued)} &middot; due ${escape(invoice.due)}</p>
  <table style="width: 100%; border-collapse: collapse; margin-bottom: 24px;">
    <tr>
      <td style="vertical-align: top;"><strong>${escape(invoice.from.name)}</strong><br>${invoice.from.lines.map(escape).join("<br>")}</td>
      <td style="vertical-align: top;"><strong>${escape(invoice.to.name)}</strong><br>${invoice.to.lines.map(escape).join("<br>")}</td>
    </tr>
  </table>
  <table style="width: 100%; border-collapse: collapse;">
    <tr>
      <th style="text-align: left; border-bottom: 2px solid #111; padding: 8px 0;">Item</th>
      <th style="text-align: right; border-bottom: 2px solid #111; padding: 8px 0;">Qty</th>
      <th style="text-align: right; border-bottom: 2px solid #111; padding: 8px 0;">Unit</th>
      <th style="text-align: right; border-bottom: 2px solid #111; padding: 8px 0;">Amount</th>
    </tr>
    ${rows}
    <tr><td colspan="3" style="text-align: right; padding: 8px 0;">Subtotal</td><td style="text-align: right; padding: 8px 0;">${money(subtotal)}</td></tr>
    <tr><td colspan="3" style="text-align: right; padding: 8px 0;">Tax (${(invoice.taxRate * 100).toFixed(0)}%)</td><td style="text-align: right; padding: 8px 0;">${money(tax)}</td></tr>
    <tr><td colspan="3" style="text-align: right; padding: 8px 0; font-size: 18px;"><strong>Total</strong></td><td style="text-align: right; padding: 8px 0; font-size: 18px;"><strong>${money(total)}</strong></td></tr>
  </table>
</body>
</html>`;
}
