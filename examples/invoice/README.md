# Invoice Printer

A small React app that prints what it generated - an invoice - and never its
own window.

- Edit the entries: add new ones with the form under the table, remove old
  ones with the ✕ on each row. Totals follow along.
- **Print invoice** builds the invoice HTML from the current entries - the
  data in [`src/invoice.ts`](src/invoice.ts) plus your edits - and calls
  `print.document({ html })`. The dialog that opens is the platform's own.
- **Print invoice PDF** builds the same entries as a PDF with the
  dependency-free generator in [`src/pdf.ts`](src/pdf.ts), writes it to a
  temp file, and calls `print.document({ pdfPath })` with it - then removes
  the file once the dialog closes. Temp needs both sides of the filesystem
  scope for that: writing the file is a write, printing it is a read.

## Why the print HTML is self-contained

The runtime renders that HTML in a hidden view of its own, which knows
nothing of this app's CSS. `renderInvoiceHtml` therefore inlines every style
the printed page needs: no classes, no stylesheet, no external anything. The
screen stays React and [`src/style.css`](src/style.css); the paper is a
string. Two renderings of the same data, on purpose.

## Run it

```bash
pnpm install   # once, from the repo root
cd examples/invoice
pnpm dev       # `vantail dev`: the app in a native window, with HMR
```
