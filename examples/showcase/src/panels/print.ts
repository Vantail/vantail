import { print, VantailError } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/**
 * Printing application-generated content.
 *
 * Worth knowing: there is no call that prints the current window. Only an
 * explicit `html` string or `pdfPath` file renders, in a hidden view that is
 * never attached to this window - so what prints is the invoice below, never
 * the showcase itself. The native dialog is the authorisation: it resolves
 * once the dialog closes, whether the user printed or cancelled.
 */
export function printPanel(): Panel {
  const p = panel(
    "print",
    "print",
    "The native print dialog for generated content - never for this window.",
  );

  const invoiceHtml = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="font-family: Georgia, serif; color: #111; padding: 48px;">
<h1 style="font-size: 22px;">Invoice INV-2049</h1>
<p>Paper Planes Co. &mdash; 14 Cloud Lane</p>
<table style="width: 100%; border-collapse: collapse; margin-top: 24px;">
<tr><th align="left">Item</th><th align="right">Qty</th><th align="right">Price</th></tr>
<tr><td>Glider, folding</td><td align="right">3</td><td align="right">$12.00</td></tr>
<tr><td>Glider, deluxe</td><td align="right">1</td><td align="right">$24.50</td></tr>
<tr><td colspan="2" align="right"><strong>Total</strong></td><td align="right"><strong>$60.50</strong></td></tr>
</table>
</body></html>`;

  p.row(
    p.button("document({ html })", () => print.document({ html: invoiceHtml })),
  );
  p.note("Opens the system print dialog for the invoice above. The showcase page itself is never printable.");

  // The safety property, shown refusing: the source must always be explicit.
  p.row(
    p.button("document({}) refuses", async () => {
      try {
        await print.document({});
        return "unexpectedly printed";
      } catch (error) {
        if (VantailError.is(error, "INVALID_ARGUMENT")) return `refused: ${error.code}`;
        throw error;
      }
    }),
    p.button("document({ html, pdfPath }) refuses", async () => {
      try {
        await print.document({ html: "<p>x</p>", pdfPath: "/tmp/x.pdf" });
        return "unexpectedly printed";
      } catch (error) {
        if (VantailError.is(error, "INVALID_ARGUMENT")) return `refused: ${error.code}`;
        throw error;
      }
    }),
  );
  p.note("Both or neither source is INVALID_ARGUMENT - there is no call that prints the current window.");

  return p;
}
