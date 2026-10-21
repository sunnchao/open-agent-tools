const store: Record<string, string> = {};
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => {
    store[k] = v;
  },
  removeItem: (k: string) => {
    delete store[k];
  },
  clear: () => {
    for (const k of Object.keys(store)) delete store[k];
  },
  key: (i: number) => Object.keys(store)[i] ?? null,
  get length() {
    return Object.keys(store).length;
  },
};
if (!g.TextEncoder) {
  const { TextEncoder, TextDecoder } = (await import("node:util").catch(() => ({
    TextEncoder: undefined,
    TextDecoder: undefined,
  }))) as unknown as { TextEncoder?: unknown; TextDecoder?: unknown };
  if (TextEncoder) g.TextEncoder = TextEncoder;
  if (TextDecoder) g.TextDecoder = TextDecoder;
}
export {};
