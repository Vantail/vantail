import { VantailError } from "./error.js";
import { invoke } from "./transport.js";

export interface PrintDocumentOptions {
  /** Self-contained HTML to render in a view of its own and print. Mutually exclusive with `pdfPath`. */
  html?: string;
  /** Absolute path to an existing PDF file to print. Mutually exclusive with `html`. */
  pdfPath?: string;
}

export interface PrintResult {
  /**
   * Whether the user went through with printing (`false` when cancelled).
   * `null` on Windows, where the print preview does not say.
   */
  printed: boolean | null;
}

function invalid(message: string): VantailError {
  return new VantailError("INVALID_ARGUMENT", message);
}

/**
 * Print application-generated content through the native print dialog.
 *
 * The content source is always explicit - there is deliberately no
 * argument-less `print()` and no `print.currentWindow()`. Only the given
 * `html` or `pdfPath` is rendered, in a view of its own that is never one
 * of the application's windows, so the application's own UI can never be
 * printed through this API.
 *
 * The native dialog is the authorisation: the user picks the printer, copies
 * and page range, or cancels. The promise resolves once the dialog has
 * closed either way.
 */
export const print = {
  document: (options: PrintDocumentOptions): Promise<PrintResult> => {
    const hasHtml =
      typeof options?.html === "string" && options.html.length > 0;
    const hasPdf =
      typeof options?.pdfPath === "string" && options.pdfPath.length > 0;

    if (hasHtml === hasPdf) {
      return Promise.reject(
        invalid(
          "Pass exactly one of `html` or `pdfPath`: " +
            "`print.document({ html })` or `print.document({ pdfPath })`.",
        ),
      );
    }

    return invoke<PrintResult>("print.document", {
      ...(hasHtml ? { html: options.html } : {}),
      ...(hasPdf ? { pdfPath: options.pdfPath } : {}),
    });
  },
};
