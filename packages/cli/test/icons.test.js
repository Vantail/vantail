/**
 * The image pipeline is hand-rolled, so it is checked against PNGs this code
 * did not write and read back by tools that did not produce them.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  buildIcons,
  decode,
  encode,
  loadIcon,
  resize,
} from "../dist/icons/index.js";

const scratch = [];
after(async () => {
  await Promise.all(
    scratch.map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "vantail-icons-"));
  scratch.push(path);
  return path;
}

function have(command) {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A recognisable image: a red square with a transparent quarter. */
function sample(size = 512) {
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 4;
      const transparent = x < size / 2 && y < size / 2;
      pixels[at] = 220;
      pixels[at + 1] = 30;
      pixels[at + 2] = 60;
      pixels[at + 3] = transparent ? 0 : 255;
    }
  }
  return { width: size, height: size, pixels };
}

test("an encoded PNG decodes back to the same pixels", () => {
  const source = sample(64);
  const round = decode(encode(source));

  assert.equal(round.width, 64);
  assert.equal(round.height, 64);
  assert.deepEqual([...round.pixels], [...source.pixels]);
});

test(
  "sips reads what we write, and we read what sips writes",
  { skip: !have("sips") },
  async () => {
    const directory = await temporary();
    const ours = join(directory, "ours.png");
    await writeFile(ours, encode(sample(256)));

    // A tool that did not write it agrees on the dimensions and the alpha.
    const described = execFileSync(
      "sips",
      ["-g", "pixelWidth", "-g", "hasAlpha", ours],
      {
        encoding: "utf8",
      },
    );
    assert.match(described, /pixelWidth: 256/);
    assert.match(described, /hasAlpha: yes/);

    // And the reverse: sips re-encodes it, and our decoder still agrees.
    const theirs = join(directory, "theirs.png");
    execFileSync("sips", ["-s", "format", "png", ours, "--out", theirs], {
      stdio: "ignore",
    });
    const decoded = decode(await readFile(theirs));
    assert.equal(decoded.width, 256);
    // The opaque corner is still opaque and still red.
    const corner = (255 * 256 + 255) * 4;
    assert.deepEqual(
      [...decoded.pixels.slice(corner, corner + 4)],
      [220, 30, 60, 255],
    );
  },
);

test("downscaling averages rather than picking, and keeps alpha clean", () => {
  const small = resize(sample(512), 8);

  assert.equal(small.width, 8);
  // The transparent quarter stays fully transparent...
  assert.equal(small.pixels[3], 0);
  // ...and does not bleed its colour into the opaque part, which is what a
  // naive average over straight RGBA would do.
  const opaque = (7 * 8 + 7) * 4;
  assert.deepEqual(
    [...small.pixels.slice(opaque, opaque + 4)],
    [220, 30, 60, 255],
  );
});

test("an icns holds a PNG for every size macOS asks for", () => {
  const icons = buildIcons(sample(1024));
  assert.equal(icons.icns.subarray(0, 4).toString("ascii"), "icns");
  // The length field covers the whole file, header included.
  assert.equal(icons.icns.readUInt32BE(4), icons.icns.length);

  const entries = [];
  for (let at = 8; at + 8 <= icons.icns.length;) {
    const type = icons.icns.toString("ascii", at, at + 4);
    const length = icons.icns.readUInt32BE(at + 4);
    // Every payload is a PNG, which is what makes this a repackaging job.
    assert.equal(icons.icns.readUInt32BE(at + 8), 0x89504e47);
    // The dimensions live in the PNG's IHDR, 16 bytes past its signature.
    entries.push({ type, width: icons.icns.readUInt32BE(at + 8 + 16) });
    at += length;
  }

  assert.deepEqual(
    entries.map((entry) => entry.type),
    [
      "icp4",
      "ic11",
      "icp5",
      "ic12",
      "ic07",
      "ic13",
      "ic08",
      "ic14",
      "ic09",
      "ic10",
    ],
  );
});

/**
 * The one that actually bites.
 *
 * Every size a Retina screen asks for needs its own entry. Without `ic11`,
 * a 16pt icon in Finder is the 16px bitmap doubled, and it looks broken -
 * which is exactly what shipped before this.
 */
test("an icns carries a 2x entry for every size, not just 1x", () => {
  const { icns } = buildIcons(sample(1024));

  const found = new Map();
  for (let at = 8; at + 8 <= icns.length;) {
    const type = icns.toString("ascii", at, at + 4);
    found.set(type, icns.readUInt32BE(at + 8 + 16));
    at += icns.readUInt32BE(at + 4);
  }

  // point size -> [1x type at N px, 2x type at 2N px]
  const RETINA = [
    [16, "icp4", "ic11"],
    [32, "icp5", "ic12"],
    [128, "ic07", "ic13"],
    [256, "ic08", "ic14"],
    [512, "ic09", "ic10"],
  ];

  for (const [points, single, double] of RETINA) {
    assert.equal(
      found.get(single),
      points,
      `${single} should hold ${points}px`,
    );
    assert.equal(
      found.get(double),
      points * 2,
      `${double} should hold ${points * 2}px`,
    );
  }
});

/**
 * macOS reads `icp6` as 48x48 whatever is inside it, so a 64px image there is
 * an entry nothing asks for.
 */
test("an icns does not use the type macOS misreads", () => {
  const { icns } = buildIcons(sample(1024));
  for (let at = 8; at + 8 <= icns.length;) {
    assert.notEqual(icns.toString("ascii", at, at + 4), "icp6");
    at += icns.readUInt32BE(at + 4);
  }
});

test("an ico's directory points at where the images really are", () => {
  const { ico } = buildIcons(sample(1024));

  assert.equal(ico.readUInt16LE(0), 0); // reserved
  assert.equal(ico.readUInt16LE(2), 1); // 1 = icon, not cursor
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 6);

  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const size = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    // Follow the pointer and check a PNG is actually there.
    assert.equal(
      ico.readUInt32BE(offset),
      0x89504e47,
      `entry ${index} does not point at a PNG`,
    );
    assert.ok(offset + size <= ico.length);
  }

  // 256 does not fit in the one-byte size field and is written as 0.
  const last = 6 + (count - 1) * 16;
  assert.equal(ico.readUInt8(last), 0);
});

test(
  "file(1) recognises both containers",
  { skip: !have("file") },
  async () => {
    const directory = await temporary();
    const icons = buildIcons(sample(1024));
    await writeFile(join(directory, "icon.icns"), icons.icns);
    await writeFile(join(directory, "icon.ico"), icons.ico);

    const described = execFileSync(
      "file",
      [join(directory, "icon.icns"), join(directory, "icon.ico")],
      {
        encoding: "utf8",
      },
    );
    assert.match(described, /Mac OS X icon/);
    assert.match(described, /MS Windows icon resource/);
  },
);

test("a source image that cannot make a good icon is rejected", async () => {
  const directory = await temporary();

  const oblong = join(directory, "oblong.png");
  await writeFile(
    oblong,
    encode({ width: 64, height: 32, pixels: new Uint8Array(64 * 32 * 4) }),
  );
  await assert.rejects(loadIcon(oblong), /has to be square/);

  const tiny = join(directory, "tiny.png");
  await writeFile(tiny, encode(sample(64)));
  // Scaling up would look worse than the platform placeholder.
  await assert.rejects(loadIcon(tiny), /at least 256/);

  const notPng = join(directory, "not.png");
  await writeFile(notPng, "definitely not a png", "utf8");
  await assert.rejects(loadIcon(notPng), /not a PNG/);
});
