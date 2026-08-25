import type { Bitmap } from "./png.js";

/**
 * Scale an image down by averaging the source pixels each target pixel covers.
 *
 * Box filtering rather than nearest-neighbour, because an icon downscaled by
 * picking one pixel in sixteen looks like a mistake at 32x32 - which is the
 * size people actually see.
 *
 * Alpha is premultiplied before averaging and divided back out afterwards.
 * Averaging straight RGBA mixes the colour of fully transparent pixels into
 * the visible ones, which puts a dark halo around anything with a soft edge.
 */
export function resize(source: Bitmap, size: number): Bitmap {
  if (source.width === size && source.height === size) return source;

  const pixels = new Uint8Array(size * size * 4);
  const scaleX = source.width / size;
  const scaleY = source.height / size;

  for (let y = 0; y < size; y += 1) {
    const top = Math.floor(y * scaleY);
    const bottom = Math.max(top + 1, Math.min(source.height, Math.ceil((y + 1) * scaleY)));

    for (let x = 0; x < size; x += 1) {
      const left = Math.floor(x * scaleX);
      const right = Math.max(left + 1, Math.min(source.width, Math.ceil((x + 1) * scaleX)));

      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      let count = 0;

      for (let sy = top; sy < bottom; sy += 1) {
        for (let sx = left; sx < right; sx += 1) {
          const at = (sy * source.width + sx) * 4;
          const a = source.pixels[at + 3]!;
          red += source.pixels[at]! * a;
          green += source.pixels[at + 1]! * a;
          blue += source.pixels[at + 2]! * a;
          alpha += a;
          count += 1;
        }
      }

      const to = (y * size + x) * 4;
      if (alpha === 0) {
        // Fully transparent: there is no colour to recover, and dividing by
        // zero would invent one.
        pixels[to] = 0;
        pixels[to + 1] = 0;
        pixels[to + 2] = 0;
        pixels[to + 3] = 0;
        continue;
      }

      pixels[to] = Math.round(red / alpha);
      pixels[to + 1] = Math.round(green / alpha);
      pixels[to + 2] = Math.round(blue / alpha);
      pixels[to + 3] = Math.round(alpha / count);
    }
  }

  return { width: size, height: size, pixels };
}
