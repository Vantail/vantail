import { useState } from "react";
import { os, path, print } from "@vantail/api";
import { buildInvoiceHtml, demoInvoice, totals, type LineItem } from "./invoice.js";

const money = (n: number): string => `$${n.toFixed(2)}`;

export function App() {
  const [items, setItems] = useState<LineItem[]>(demoInvoice.items);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);

  const invoice = { ...demoInvoice, items };
  const { subtotal, tax, total } = totals(invoice);

  async function run(label: string, work: () => Promise<{ printed: boolean }>) {
    setBusy(true);
    setStatus(`${label}\u2026`);
    try {
      const { printed } = await work();
      setStatus(printed ? "Sent to the printer." : "Dialog closed - nothing printed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  // The intended shape: data already in the app becomes a self-contained
  // document, and only that document prints. The app UI never can.
  const printInvoice = () =>
    run("Printing invoice", () => print.document({ html: buildInvoiceHtml(invoice) }));

  // The secondary path: a PDF file on disk. It goes through the filesystem
  // read scope like any other read, which is why the config grants
  // `$RESOURCE/**` - the sample ships in `public/`.
  const printSamplePdf = () =>
    run("Printing sample PDF", async () => {
      const pdfPath = path.join(await os.resourceDir(), "sample-invoice.pdf");
      return print.document({ pdfPath });
    });

  return (
    <main>
      <h1>Invoice {demoInvoice.number}</h1>
      <p className="hint">
        Edit the quantities, then print. What prints is a generated document -
        not this window.
      </p>

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Qty</th>
            <th>Unit</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr key={i}>
              <td>{item.description}</td>
              <td>
                <input
                  type="number"
                  min={0}
                  value={item.qty}
                  onChange={(event) => {
                    const qty = Math.max(0, Number(event.target.value) || 0);
                    setItems(items.map((it, j) => (j === i ? { ...it, qty } : it)));
                  }}
                />
              </td>
              <td>{money(item.unitPrice)}</td>
              <td>{money(item.qty * item.unitPrice)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="totals">
        Subtotal {money(subtotal)} &middot; Tax {money(tax)} &middot;{" "}
        <strong>Total {money(total)}</strong>
      </p>

      <div className="row">
        <button disabled={busy} onClick={() => void printInvoice()}>
          Print invoice
        </button>
        <button disabled={busy} onClick={() => void printSamplePdf()}>
          Print sample PDF
        </button>
      </div>

      {status && <p className="status">{status}</p>}
    </main>
  );
}
