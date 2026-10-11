# Invoice Printer

A small React app showing the intended shape of `print.document`: the app
holds data (line items, totals, tax, the issuer), builds a **generated
document** from it, and prints that - never its own UI.

## Run it

From this directory:

```bash
pnpm dev     # same as `vantail dev`: the app in a native window, with HMR
```

Two buttons:

- **Print invoice** calls `print.document({ html })` with the invoice HTML
  built from the current line items. Edit a quantity and print again - the
  document follows the data.
- **Print sample PDF** calls `print.document({ pdfPath })` with
  `public/sample-invoice.pdf`, resolved through `os.resourceDir()`. It is the
  secondary path for content that already exists as a file.

## Why the HTML is self-contained

The string passed to `print.document` renders in a hidden view that never
loads the app's stylesheet. So `buildInvoiceHtml` in `src/invoice.ts`
carries every rule it needs as inline styles: what prints looks right
regardless of the app's own CSS, and the app can be restyled without
changing the printout. Keep user data escaped on the way in (`escape`
in the same file) - an item description is untrusted input to a document.

## Permissions

Printing itself needs none: the native dialog is the authorisation, and the
only thing printable is the explicit `html`/`pdfPath` - the app window is
never reachable. The config grants `filesystem.read: ["$RESOURCE/**"]` for
one reason only: the sample PDF ships in `public/` and reading it is a file
read like any other. Remove the second button and the grant goes with it.

`public/sample-invoice.pdf` is generated - see
`scripts/make-sample-pdf.mjs` (`node scripts/make-sample-pdf.mjs`).
