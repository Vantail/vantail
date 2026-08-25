import { clipboard } from "@vantail/api";
import { panel, type Panel } from "../ui.js";

/** The system clipboard, text and images. */
export function clipboardPanel(): Panel {
  const p = panel("clipboard", "clipboard", "The system clipboard, shared with every other application.");

  const text = p.input("text to copy", "copied from the Vantail showcase");
  p.row(
    text,
    p.button("writeText()", () => clipboard.writeText(text.value)),
    p.button("readText()", () => clipboard.readText()),
  );

  p.row(
    p.button("hasText()", () => clipboard.hasText()),
    p.button("hasImage()", () => clipboard.hasImage()),
    p.button("clear()", () => clipboard.clear()),
  );

  p.row(
    p.button("readImage()", async () => {
      const image = await clipboard.readImage();
      if (!image) return "no image on the clipboard - copy one and try again";
      return `${image.width}x${image.height}, ${image.data.length} bytes of PNG`;
    }),
  );
  p.note("Read and write are separate permissions: an app can be allowed to paste without being allowed to snoop.");

  return p;
}
