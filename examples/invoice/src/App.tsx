import { useState } from "react";
import { filesystem, os, path, print, VantailError } from "@vantail/api";

import {
  invoice as initial,
  money,
  renderInvoiceHtml,
  subtotal,
  total,
  type LineItem,
} from "./invoice.js";
import { renderInvoicePdf } from "./pdf.js";

export function App() {
  const [items, setItems] = useState<LineItem[]>(initial.items);
  const [description, setDescription] = useState("");
  const [qty, setQty] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [status, setStatus] = useState("Nothing printed yet.");

  const data = { ...initial, items };

  function addItem() {
    const parsedQty = Number(qty);
    const parsedPrice = Number(unitPrice);
    if (!description.trim()) {
      setStatus("Give the entry a description first.");
      return;
    }
    if (!Number.isFinite(parsedQty) || parsedQty <= 0) {
      setStatus("Quantity must be a number above zero.");
      return;
    }
    if (!Number.isFinite(parsedPrice) || parsedPrice < 0) {
      setStatus("Price must be a number, zero or more.");
      return;
    }
    setItems((current) => [
      ...current,
      {
        description: description.trim(),
        qty: parsedQty,
        unitPrice: parsedPrice,
      },
    ]);
    setDescription("");
    setQty("1");
    setUnitPrice("");
    setStatus("Entry added.");
  }

  function removeItem(index: number) {
    setItems((current) => current.filter((_, at) => at !== index));
    setStatus("Entry removed.");
  }

  async function printInvoice() {
    setStatus("Opening the print dialog…");
    try {
      // Generated content, not the app UI: this HTML is built from the
      // current entries and carries its own styles.
      await print.document({ html: renderInvoiceHtml(data) });
      setStatus("The dialog closed - printed, or cancelled.");
    } catch (cause) {
      setStatus(
        cause instanceof VantailError
          ? `${cause.code}: ${cause.message}`
          : String(cause),
      );
    }
  }

  async function printInvoicePdf() {
    setStatus("Building the PDF…");
    // The second path: the same entries as a PDF file on disk. Generated
    // here, written to temp, printed, cleaned up - so it always matches
    // what is on screen.
    const pdfPath = path.join(
      await os.tempDir(),
      `vantail-invoice-${data.number}-${Date.now()}.pdf`,
    );
    try {
      await filesystem.writeBinary(pdfPath, renderInvoicePdf(data));
      setStatus("Opening the print dialog…");
      await print.document({ pdfPath });
      setStatus("The dialog closed - printed, or cancelled.");
    } catch (cause) {
      setStatus(
        cause instanceof VantailError
          ? `${cause.code}: ${cause.message}`
          : String(cause),
      );
    } finally {
      // Best effort: a temp file that outlives its dialog is litter.
      await filesystem.remove(pdfPath).catch(() => {});
    }
  }

  return (
    <main>
      <h1>
        Invoice {data.number} <span className="muted">· {data.issuer}</span>
      </h1>

      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th className="num">Amount</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.description}-${index}`}>
              <td>{item.description}</td>
              <td className="num">{item.qty}</td>
              <td className="num">{money(item.unitPrice)}</td>
              <td className="num">{money(item.qty * item.unitPrice)}</td>
              <td className="num">
                <button
                  className="remove"
                  onClick={() => removeItem(index)}
                  aria-label={`Remove ${item.description}`}
                >
                  ✕
                </button>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No entries yet - add one below.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3}>Subtotal</td>
            <td className="num">{money(subtotal(data))}</td>
            <td></td>
          </tr>
          <tr>
            <td colSpan={3}>Total</td>
            <td className="num">{money(total(data))}</td>
            <td></td>
          </tr>
        </tfoot>
      </table>

      <div className="add">
        <input
          placeholder="Description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <input
          placeholder="Qty"
          value={qty}
          inputMode="decimal"
          onChange={(event) => setQty(event.target.value)}
        />
        <input
          placeholder="Price"
          value={unitPrice}
          inputMode="decimal"
          onChange={(event) => setUnitPrice(event.target.value)}
        />
        <button onClick={addItem}>Add entry</button>
      </div>

      <div className="actions">
        <button onClick={() => void printInvoice()}>Print invoice</button>
        <button onClick={() => void printInvoicePdf()}>Print invoice PDF</button>
      </div>

      <p className="status">{status}</p>
    </main>
  );
}
