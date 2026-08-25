/**
 * Binary data on the wire.
 *
 * The IPC channel carries JSON, so bytes travel as base64. That costs a third
 * again in size and has to be built in memory on both sides, which is why the
 * runtime caps binary calls at 64 MB rather than pretending this is a stream.
 */

/** Bytes accepted by `filesystem.writeBinary`. */
export type BinaryInput = Uint8Array | ArrayBuffer | ArrayBufferView;

export function toBytes(input: BinaryInput): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

export function encode(input: BinaryInput): string {
  const bytes = toBytes(input);

  // Newer engines have this and it is markedly faster on large buffers.
  const fast = (bytes as { toBase64?: () => string }).toBase64;
  if (typeof fast === "function") return fast.call(bytes);

  // btoa takes a string of code units, and a spread of a large array blows
  // the argument limit - hence the chunking.
  let binary = "";
  const CHUNK = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

export function decode(base64: string): Uint8Array {
  const fast = (
    Uint8Array as unknown as { fromBase64?: (value: string) => Uint8Array }
  ).fromBase64;
  if (typeof fast === "function") return fast(base64);

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
