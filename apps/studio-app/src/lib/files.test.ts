import { describe, expect, it, vi } from "vitest";

vi.mock("./nativeFiles", () => ({
  getDocumentAsync: vi.fn(),
  getFileInfo: vi.fn(),
  getFileSystemCacheDirectory: vi.fn(),
  isSharingAvailable: vi.fn(),
  readFileAsBase64: vi.fn(),
  shareFile: vi.fn(),
  writeFileFromBase64: vi.fn(),
}));

import {
  base64ToBytes,
  bytesToBase64,
  sha256DigestOf,
  sha256HexBytes,
  sha256HexText,
} from "./files";

describe("files lib", () => {
  it("round-trips base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255, 72, 101, 108, 108, 111]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytes(bytesToBase64(new Uint8Array([1])))).toEqual(new Uint8Array([1]));
    expect(base64ToBytes(bytesToBase64(new Uint8Array([1, 2])))).toEqual(new Uint8Array([1, 2]));
  });
  it("matches known sha256 vectors", () => {
    expect(sha256HexText("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(sha256HexText("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256DigestOf(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256HexBytes(new Uint8Array([104, 105]))).toBe(sha256HexText("hi"));
  });
});
