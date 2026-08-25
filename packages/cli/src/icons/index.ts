/**
 * Turning one source PNG into the icon formats each platform insists on.
 *
 * macOS wants an `.icns`, Windows wants an `.ico`, Linux wants loose PNGs at
 * theme sizes. All three are containers of PNGs, which is why one source image
 * is enough.
 */

import { readFile } from "node:fs/promises";

import { decode, encode, type Bitmap } from "./png.js";
import { resize } from "./resize.js";

export { decode, encode, resize };
export type { Bitmap };

/**
 * Sizes macOS asks for, and the four-character type that carries each.
 *
 * Every size a Retina display asks for needs its own entry. Without one,
 * macOS scales the next thing it can find: leave out `ic11` and a 16pt icon
 * on a Retina screen is the 16px bitmap doubled, which is what a broken
 * small icon in Finder actually is.
 *
 * The list mirrors what `iconutil` produces. `icp6` is deliberately absent -
 * macOS reads it as 48x48 regardless of what is inside, so writing a 64px
 * image there produces an entry nothing wants.
 */
const ICNS_TYPES: [type: string, size: number][] = [
  ["icp4", 16], // 16pt
  ["ic11", 32], // 16pt @2x
  ["icp5", 32], // 32pt
  ["ic12", 64], // 32pt @2x
  ["ic07", 128], // 128pt
  ["ic13", 256], // 128pt @2x
  ["ic08", 256], // 256pt
  ["ic14", 512], // 256pt @2x
  ["ic09", 512], // 512pt
  ["ic10", 1024], // 512pt @2x
];

/** What Windows shows at each place it shows an icon. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** The hicolor theme sizes a `.desktop` entry is looked up in. */
export const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512];

export interface IconSet {
  source: Bitmap;
  icns: Buffer;
  ico: Buffer;
  /** Keyed by pixel size. */
  png: Map<number, Buffer>;
}

export async function loadIcon(path: string): Promise<Bitmap> {
  const bitmap = decode(await readFile(path));

  if (bitmap.width !== bitmap.height) {
    throw new Error(
      `An icon has to be square; ${path} is ${bitmap.width}x${bitmap.height}.`,
    );
  }
  if (bitmap.width < 256) {
    throw new Error(
      `${path} is ${bitmap.width}x${bitmap.width}. Icons are scaled down, never up - ` +
        `use at least 256x256, and 1024x1024 if you can.`,
    );
  }

  return bitmap;
}

export function buildIcons(source: Bitmap): IconSet {
  // Every size is derived from the source rather than from the size above it,
  // so errors do not compound down the chain.
  const at = new Map<number, Bitmap>();
  const scaled = (size: number) => {
    let bitmap = at.get(size);
    if (!bitmap) {
      bitmap = resize(source, Math.min(size, source.width));
      at.set(size, bitmap);
    }
    return bitmap;
  };

  const png = new Map<number, Buffer>();
  for (const size of new Set([
    ...ICNS_TYPES.map(([, s]) => s),
    ...ICO_SIZES,
    ...LINUX_SIZES,
  ])) {
    png.set(size, encode(scaled(size)));
  }

  return { source, icns: buildIcns(png), ico: buildIco(png), png };
}

/**
 * `.icns` is a magic word, a total length, and a run of typed chunks. Since
 * OS X 10.7 those chunks may hold PNG data directly, which is what makes this
 * a repackaging job rather than an encoding one.
 */
function buildIcns(png: Map<number, Buffer>): Buffer {
  const chunks: Buffer[] = [];

  for (const [type, size] of ICNS_TYPES) {
    const image = png.get(size);
    if (!image) continue;
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(image.length + 8, 4);
    chunks.push(header, image);
  }

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

/**
 * `.ico` is a directory of entries followed by their images. PNG payloads have
 * been accepted since Vista and are what everything writes now.
 */
function buildIco(png: Map<number, Buffer>): Buffer {
  const images = ICO_SIZES.map((size) => ({
    size,
    data: png.get(size)!,
  })).filter((entry) => entry.data);

  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0); // reserved
  directory.writeUInt16LE(1, 2); // 1 = icon
  directory.writeUInt16LE(images.length, 4);

  let offset = directory.length;
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    // 256 is written as 0: the field is one byte and 256 does not fit.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.data.length;
  });

  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}
