import { decode, encode, type BinaryInput } from "./binary.js";
import { invoke } from "./transport.js";

export interface ClipboardImage {
  width: number;
  height: number;
  /** The image as PNG bytes. */
  data: Uint8Array;
}

/** The system clipboard. */
export const clipboard = {
  /** Resolves to an empty string when the clipboard holds no text. */
  readText: () => invoke<string>("clipboard.readText"),
  writeText: (text: string) => invoke<null>("clipboard.writeText", { text }),
  hasText: () => invoke<boolean>("clipboard.hasText"),
  clear: () => invoke<null>("clipboard.clear"),

  /**
   * The clipboard's image as PNG bytes, or `null` when it holds no image.
   *
   * ```ts
   * const image = await clipboard.readImage();
   * if (image) {
   *   const url = URL.createObjectURL(new Blob([image.data], { type: "image/png" }));
   *   document.querySelector("img").src = url;
   * }
   * ```
   */
  async readImage(): Promise<ClipboardImage | null> {
    const result = await invoke<{
      width: number;
      height: number;
      data: string;
    } | null>("clipboard.readImage");

    return result && { ...result, data: decode(result.data) };
  },

  /**
   * Put a PNG on the clipboard.
   *
   * The clipboard itself holds raw pixels, so this is converted on the way -
   * an image without an alpha channel is fine.
   */
  writeImage: (png: BinaryInput) =>
    invoke<null>("clipboard.writeImage", { data: encode(png) }),

  hasImage: () => invoke<boolean>("clipboard.hasImage"),
};
