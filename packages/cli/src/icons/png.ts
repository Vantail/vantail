/**
 * Just enough PNG to turn one source image into every size an icon needs.
 *
 * A dependency would do more, but the job here is narrow - decode what a
 * designer exports, scale it down, write it back out - and a native image
 * library is an odd thing for a tool whose whole pitch is that you do not need
 * a compiler. What is *not* supported fails loudly rather than quietly
 * producing a wrong icon.
 */

import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Bitmap {
  width: number;
  height: number;
  /** Straight (not premultiplied) RGBA, 8 bits per channel. */
  pixels: Uint8Array;
}

export function decode(source: Buffer): Bitmap {
  if (!source.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("That is not a PNG file");
  }

  let header: { width: number; height: number; depth: number; color: number } | undefined;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const data: Buffer[] = [];

  for (let at = 8; at + 8 <= source.length; ) {
    const length = source.readUInt32BE(at);
    const type = source.toString("ascii", at + 4, at + 8);
    const body = source.subarray(at + 8, at + 8 + length);
    at += 12 + length; // length + type + data + crc

    if (type === "IHDR") {
      const interlace = body.readUInt8(12);
      if (interlace !== 0) {
        throw new Error("Interlaced PNGs are not supported - save it without interlacing");
      }
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        depth: body.readUInt8(8),
        color: body.readUInt8(9),
      };
    } else if (type === "PLTE") palette = Buffer.from(body);
    else if (type === "tRNS") transparency = Buffer.from(body);
    else if (type === "IDAT") data.push(Buffer.from(body));
    else if (type === "IEND") break;
  }

  if (!header) throw new Error("That PNG has no header chunk");
  if (header.depth !== 8) {
    throw new Error(
      `Only 8-bit PNGs are supported; this one is ${header.depth}-bit. Re-export it as 8-bit.`,
    );
  }

  const channels = CHANNELS[header.color];
  if (channels === undefined) {
    throw new Error(`Unsupported PNG colour type ${header.color}`);
  }

  const raw = inflateSync(Buffer.concat(data));
  const scanlines = unfilter(raw, header.width, header.height, channels);

  return {
    width: header.width,
    height: header.height,
    pixels: toRgba(scanlines, header, channels, palette, transparency),
  };
}

/** Bytes per pixel in the raw scanline data, by PNG colour type. */
const CHANNELS: Record<number, number | undefined> = {
  0: 1, // greyscale
  2: 3, // truecolour
  3: 1, // palette index
  4: 2, // greyscale + alpha
  6: 4, // truecolour + alpha
};

/**
 * Reverse the per-scanline filters.
 *
 * Every row is prefixed with a filter byte and encoded relative to its left
 * neighbour, the row above, or both. This is where a PNG decoder is usually
 * wrong, so it follows the spec's names exactly.
 */
function unfilter(raw: Buffer, width: number, height: number, channels: number): Buffer {
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  for (let row = 0; row < height; row += 1) {
    const filter = raw.readUInt8(row * (stride + 1));
    const from = row * (stride + 1) + 1;
    const to = row * stride;
    const above = to - stride;

    for (let index = 0; index < stride; index += 1) {
      const value = raw[from + index]!;
      const left = index >= channels ? out[to + index - channels]! : 0;
      const up = row > 0 ? out[above + index]! : 0;
      const upLeft = row > 0 && index >= channels ? out[above + index - channels]! : 0;

      let restored: number;
      switch (filter) {
        case 0:
          restored = value;
          break;
        case 1:
          restored = value + left;
          break;
        case 2:
          restored = value + up;
          break;
        case 3:
          restored = value + ((left + up) >> 1);
          break;
        case 4:
          restored = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`Unknown PNG filter type ${filter} on row ${row}`);
      }
      out[to + index] = restored & 0xff;
    }
  }

  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const dLeft = Math.abs(estimate - left);
  const dUp = Math.abs(estimate - up);
  const dUpLeft = Math.abs(estimate - upLeft);
  if (dLeft <= dUp && dLeft <= dUpLeft) return left;
  return dUp <= dUpLeft ? up : upLeft;
}

function toRgba(
  scanlines: Buffer,
  header: { width: number; height: number; color: number },
  channels: number,
  palette: Buffer | undefined,
  transparency: Buffer | undefined,
): Uint8Array {
  const count = header.width * header.height;
  const pixels = new Uint8Array(count * 4);

  for (let index = 0; index < count; index += 1) {
    const from = index * channels;
    const to = index * 4;

    switch (header.color) {
      case 0: {
        const grey = scanlines[from]!;
        pixels[to] = grey;
        pixels[to + 1] = grey;
        pixels[to + 2] = grey;
        pixels[to + 3] = 255;
        break;
      }
      case 2:
        pixels[to] = scanlines[from]!;
        pixels[to + 1] = scanlines[from + 1]!;
        pixels[to + 2] = scanlines[from + 2]!;
        pixels[to + 3] = 255;
        break;
      case 3: {
        if (!palette) throw new Error("That PNG uses a palette but has no palette chunk");
        const entry = scanlines[from]! * 3;
        pixels[to] = palette[entry]!;
        pixels[to + 1] = palette[entry + 1]!;
        pixels[to + 2] = palette[entry + 2]!;
        // tRNS gives palette entries an alpha; entries past its end are opaque.
        pixels[to + 3] = transparency?.[scanlines[from]!] ?? 255;
        break;
      }
      case 4: {
        const grey = scanlines[from]!;
        pixels[to] = grey;
        pixels[to + 1] = grey;
        pixels[to + 2] = grey;
        pixels[to + 3] = scanlines[from + 1]!;
        break;
      }
      default:
        pixels[to] = scanlines[from]!;
        pixels[to + 1] = scanlines[from + 1]!;
        pixels[to + 2] = scanlines[from + 2]!;
        pixels[to + 3] = scanlines[from + 3]!;
    }
  }

  return pixels;
}

export function encode(bitmap: Bitmap): Buffer {
  const stride = bitmap.width * 4;
  const raw = Buffer.alloc((stride + 1) * bitmap.height);

  for (let row = 0; row < bitmap.height; row += 1) {
    // Filter 0 (None). Icons are small; the extra bytes are not worth the
    // complexity of choosing a filter per row.
    raw[row * (stride + 1)] = 0;
    Buffer.from(bitmap.pixels.buffer, bitmap.pixels.byteOffset + row * stride, stride).copy(
      raw,
      row * (stride + 1) + 1,
    );
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(bitmap.width, 0);
  header.writeUInt32BE(bitmap.height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // RGBA

  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const payload = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload) >>> 0);
  return Buffer.concat([length, payload, crc]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
