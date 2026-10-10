import { invoke } from "./transport.js";
import { VantailError } from "./error.js";

/**
 * What to print. Exactly one of the two must be present.
 */
export interface PrintDocumentOptions {
  /**
   * A complete, self-contained HTML document to render and print.
   *
   * Inline the styles it needs: the page is rendered in a hidden view that
   * knows nothing of the application's own CSS.
   */
  html?: string;
  /** A PDF file on disk to send to the printer. */
  pdfPath?: string;
}

/**
 * Print application-generated content through the native print dialog.
 *
 * This never prints the application's own window. There is no way to name a
 * window here at all: the runtime renders the given HTML (or the given PDF
 * file) in a hidden view of its own, shows the platform's print dialog for
 * that content, and destroys the view when the dialog closes.
 *
 * The dialog itself is the authorisation - the user picks the printer, the
 * copies and the page range, or cancels - so there is no permission flag for
 * this. A `pdfPath` still has to be readable under `permissions.filesystem`,
 * exactly as if the application had read it itself.
 *
 * ```ts
 * import { print } from "@vantail/api";
 *
 * await print.document({ html: invoiceHtml });
 * await print.document({ pdfPath: "/path/to/invoice.pdf" });
 * ```
 *
 * Resolves once the dialog has closed, whether the user printed or
 * cancelled.
 */
export const print = {
  document: (options: PrintDocumentOptions): Promise<void> => {
    const hasHtml = options.html !== undefined;
    const hasPdf = options.pdfPath !== undefined;
    if (hasHtml === hasPdf) {
      return Promise.reject(
        new VantailError(
          "INVALID_ARGUMENT",
          "Pass exactly one of `html` or `pdfPath` to `print.document`.",
        ),
      );
    }
    return invoke<void>("print.document", {
      ...(hasHtml ? { html: options.html } : { pdfPath: options.pdfPath }),
    });
  },
};
