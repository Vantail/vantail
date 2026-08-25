/**
 * Writing `.tar.gz` update archives.
 *
 * Shelling out to `tar` would be shorter, but the runtime has to be able to
 * unpack whatever this produces on every platform, and Windows' bundled
 * `tar` is not the same program as the one on macOS. A few hundred lines of
 * ustar is a smaller risk than that difference.
 *
 * Only what a Vantail bundle actually contains is supported: directories and
 * regular files, with the executable bit preserved. No symlinks, no hard
 * links, no sparse files.
 */

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, posix, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

interface Entry {
  /** Path inside the archive, always with forward slashes. */
  name: string;
  absolute: string;
  isDirectory: boolean;
  size: number;
  mode: number;
  mtime: number;
}

/**
 * Archive `root` under its own name, gzipped.
 *
 * The single top-level entry is the convention the runtime relies on when it
 * unpacks an update: whatever is in there is the new application.
 */
export async function tarGzip(root: string): Promise<Buffer> {
  return gzipSync(await tarball(root, basename(root)), { level: 9 });
}

/**
 * Archive the *contents* of a directory rather than the directory itself,
 * with the `./` prefix Debian expects inside a `.deb`.
 */
export async function tarGzipContents(root: string): Promise<Buffer> {
  return gzipSync(await tarball(root, "."), { level: 9 });
}

async function tarball(root: string, top: string): Promise<Buffer> {
  const entries = await collect(root, top);
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    blocks.push(...header(entry));
    if (!entry.isDirectory) {
      const data = await read(entry.absolute, entry.size);
      blocks.push(data, padding(data.length));
    }
  }

  // Two zero blocks mark the end of the archive.
  blocks.push(Buffer.alloc(BLOCK * 2));

  return Buffer.concat(blocks);
}

async function collect(root: string, top: string): Promise<Entry[]> {
  const entries: Entry[] = [];

  const walk = async (absolute: string): Promise<void> => {
    const info = await stat(absolute);
    const inside = relative(root, absolute).split(sep).filter(Boolean);
    // `posix.join(".", "usr")` is `usr`, but a .deb's members are `./usr` by
    // convention - so the prefix is kept rather than normalised away.
    const name =
      top === "." ? `./${inside.join("/")}` : posix.join(top, ...inside);

    if (info.isDirectory()) {
      // The archive root itself is implied by its members.
      if (inside.length > 0 || top !== ".") {
        entries.push({
        name: `${name}/`,
        absolute,
        isDirectory: true,
        size: 0,
        mode: info.mode & 0o777,
        mtime: Math.floor(info.mtimeMs / 1000),
        });
      }
      // Sorted so the same input always produces the same archive.
      const children = (await readdir(absolute)).sort();
      for (const child of children) {
        await walk(join(absolute, child));
      }
      return;
    }

    if (!info.isFile()) {
      throw new Error(`Cannot archive ${absolute}: only files and directories are supported`);
    }

    entries.push({
      name,
      absolute,
      isDirectory: false,
      size: info.size,
      mode: info.mode & 0o777,
      mtime: Math.floor(info.mtimeMs / 1000),
    });
  };

  await walk(root);
  return entries;
}

function header(entry: Entry): Buffer[] {
  const split = splitName(entry.name);
  if (!split) {
    // GNU long name: the real path goes in its own entry ahead of the header.
    return [...longName(entry.name), ...header({ ...entry, name: truncate(entry.name) })];
  }

  const block = Buffer.alloc(BLOCK);
  write(block, split.name, 0, NAME_MAX);
  octal(block, entry.mode, 100, 8);
  octal(block, 0, 108, 8); // uid
  octal(block, 0, 116, 8); // gid
  octal(block, entry.size, 124, 12);
  octal(block, entry.mtime, 136, 12);
  block.write(entry.isDirectory ? "5" : "0", 156, 1, "ascii");
  block.write("ustar\0", 257, 6, "ascii");
  block.write("00", 263, 2, "ascii");
  write(block, split.prefix, 345, PREFIX_MAX);
  checksum(block);

  return [block];
}

/** The GNU `././@LongLink` entry that carries a path over 255 bytes. */
function longName(name: string): Buffer[] {
  const payload = Buffer.from(`${name}\0`, "utf8");
  const block = Buffer.alloc(BLOCK);

  write(block, "././@LongLink", 0, NAME_MAX);
  octal(block, 0, 100, 8);
  octal(block, 0, 108, 8);
  octal(block, 0, 116, 8);
  octal(block, payload.length, 124, 12);
  octal(block, 0, 136, 12);
  block.write("L", 156, 1, "ascii");
  block.write("ustar ", 257, 6, "ascii");
  block.write(" \0", 263, 2, "ascii");
  checksum(block);

  return [block, payload, padding(payload.length)];
}

/**
 * ustar splits a long path across `prefix` and `name`, at a `/`. Returns
 * `undefined` when no split is short enough on both sides.
 */
function splitName(name: string): { name: string; prefix: string } | undefined {
  if (Buffer.byteLength(name) <= NAME_MAX) return { name, prefix: "" };

  const parts = name.split("/");
  for (let at = 1; at < parts.length; at += 1) {
    const prefix = parts.slice(0, at).join("/");
    const rest = parts.slice(at).join("/");
    if (Buffer.byteLength(prefix) <= PREFIX_MAX && Buffer.byteLength(rest) <= NAME_MAX) {
      return { name: rest, prefix };
    }
  }
  return undefined;
}

function truncate(name: string): string {
  const bytes = Buffer.from(name, "utf8").subarray(0, NAME_MAX - 1);
  return bytes.toString("utf8");
}

function write(block: Buffer, value: string, offset: number, length: number): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`"${value}" does not fit in ${length} bytes of a tar header`);
  }
  bytes.copy(block, offset);
}

function octal(block: Buffer, value: number, offset: number, length: number): void {
  // Numeric fields are octal, zero-padded, and NUL-terminated.
  const text = Math.max(0, Math.trunc(value)).toString(8).padStart(length - 1, "0");
  if (text.length > length - 1) {
    throw new Error(`${value} is too large for a ${length}-byte tar field`);
  }
  block.write(`${text}\0`, offset, length, "ascii");
}

/** The checksum is computed with its own field read as spaces. */
function checksum(block: Buffer): void {
  block.fill(0x20, 148, 156);
  let total = 0;
  for (const byte of block) total += byte;
  block.write(`${total.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}

function padding(length: number): Buffer {
  const remainder = length % BLOCK;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - remainder);
}

async function read(path: string, size: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(chunk as Buffer);
  }
  const data = Buffer.concat(chunks);
  if (data.length !== size) {
    throw new Error(`${path} changed size while it was being archived`);
  }
  return data;
}
