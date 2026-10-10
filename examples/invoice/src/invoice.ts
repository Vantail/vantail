/**
 * The invoice, and the HTML it prints as.
 *
 * Screen and paper are two different renderings of the same data. The screen
 * is React and `style.css`; the paper is the string below, with every style
 * inline. That duplication is the point: the hidden view that prints knows
 * nothing of this app's CSS, so the print HTML carries all of its own.
 */

export interface LineItem {
  description: string;
  qty: number;
  unitPrice: number;
}

export interface Invoice {
  number: string;
  issuer: string;
  issuerEmail: string;
  items: LineItem[];
  taxRate: number;
}

export const invoice: Invoice = {
  number: "INV-1042",
  issuer: "Acme Studio",
  issuerEmail: "acme@example.com",
  items: [
    { description: "Sketchbook, A4", qty: 2, unitPrice: 18.0 },
    { description: "Ink set, 12 colours", qty: 1, unitPrice: 34.5 },
  ],
  taxRate: 0.0,
};

export function subtotal(data: Invoice): number {
  return data.items.reduce((sum, item) => sum + item.qty * item.unitPrice, 0);
}

export function total(data: Invoice): number {
  return subtotal(data) * (1 + data.taxRate);
}

export function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * A complete document, self-contained: inline styles, no classes, no
 * external anything. Whatever renders this - the hidden print view, a
 * browser tab, a PDF converter - sees the same page.
 */
export function renderInvoiceHtml(data: Invoice): string {
  const rows = data.items
    .map(
      (item) => `
    <tr style="border-bottom: 1px solid #cccccc;">
      <td style="padding: 8px 4px;">${escapeHtml(item.description)}</td>
      <td style="text-align: right; padding: 8px 4px;">${item.qty}</td>
      <td style="text-align: right; padding: 8px 4px;">${money(item.unitPrice)}</td>
      <td style="text-align: right; padding: 8px 4px;">${money(item.qty * item.unitPrice)}</td>
    </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Georgia, serif; color: #111111; padding: 48px; max-width: 640px;">
  <h1 style="font-size: 22px; margin: 0 0 4px;">Invoice ${escapeHtml(data.number)}</h1>
  <p style="color: #555555; margin: 0 0 24px;">${escapeHtml(data.issuer)} &middot; ${escapeHtml(data.issuerEmail)}</p>
  <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
    <tr style="border-bottom: 2px solid #111111;">
      <th style="text-align: left; padding: 8px 4px;">Item</th>
      <th style="text-align: right; padding: 8px 4px;">Qty</th>
      <th style="text-align: right; padding: 8px 4px;">Price</th>
      <th style="text-align: right; padding: 8px 4px;">Amount</th>
    </tr>
    ${rows}
    <tr>
      <td style="padding: 8px 4px; font-weight: bold;">Total</td>
      <td></td>
      <td></td>
      <td style="text-align: right; padding: 8px 4px; font-weight: bold;">${money(total(data))}</td>
    </tr>
  </table>
  <p style="color: #555555; font-size: 13px; margin-top: 24px;">Thank you for your business.</p>
</body>
</html>`;
}
