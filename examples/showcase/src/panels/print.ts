import { print } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * The native print dialog, for content the app generated.
 *
 * What this prints is the HTML below - a small invoice rendered in a hidden
 * view the runtime owns - and never the showcase window itself. There is no
 * call that prints the app UI, which is the whole safety property.
 */
export function printPanel(): Panel {
  const p = panel(
    "print",
    "print",
    "The system print dialog for generated content. The dialog is the authorisation, so there is no permission flag.",
  );

  p.row(
    p.button("print an invoice", () => print.document({ html: invoiceHtml() })),
  );
  p.note(
    "That renders the invoice below in a hidden view, shows the platform's print dialog for it, and tears the view down when the dialog closes.",
  );

  // The shape is the safety property: content is always explicit, so asking
  // for both - or neither - is rejected before anything renders.
  p.row(
    p.button("html and pdfPath together", () =>
      print.document({ html: invoiceHtml(), pdfPath: "/tmp/invoice.pdf" }),
    ),
    p.button("neither", () => print.document({})),
  );
  p.note("Both are refused with INVALID_ARGUMENT: exactly one source is required.");

  return p;
}

/**
 * Self-contained by necessity: the hidden view knows nothing of this app's
 * CSS, so everything the printed page needs travels with it.
 */
function invoiceHtml(): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Georgia, serif; color: #111; padding: 48px; max-width: 640px;">
  <h1 style="font-size: 22px; margin: 0 0 4px;">Invoice INV-1042</h1>
  <p style="color: #555; margin: 0 0 24px;">Acme Studio &middot; acme@example.com</p>
  <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
    <tr style="border-bottom: 2px solid #111;">
      <th style="text-align: left; padding: 8px 4px;">Item</th>
      <th style="text-align: right; padding: 8px 4px;">Qty</th>
      <th style="text-align: right; padding: 8px 4px;">Price</th>
    </tr>
    <tr style="border-bottom: 1px solid #ccc;">
      <td style="padding: 8px 4px;">Sketchbook, A4</td>
      <td style="text-align: right; padding: 8px 4px;">2</td>
      <td style="text-align: right; padding: 8px 4px;">$18.00</td>
    </tr>
    <tr style="border-bottom: 1px solid #ccc;">
      <td style="padding: 8px 4px;">Ink set, 12 colours</td>
      <td style="text-align: right; padding: 8px 4px;">1</td>
      <td style="text-align: right; padding: 8px 4px;">$34.50</td>
    </tr>
    <tr>
      <td style="padding: 8px 4px; font-weight: bold;">Total</td>
      <td></td>
      <td style="text-align: right; padding: 8px 4px; font-weight: bold;">$70.50</td>
    </tr>
  </table>
  <p style="color: #555; font-size: 13px; margin-top: 24px;">Thank you for your business.</p>
</body>
</html>`;
}
