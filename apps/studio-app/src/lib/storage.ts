/** 跨端 KV：优先 AsyncStorage，缺失时回退内存（单测/Node）。 */
type KV = {
  getItem(k: string): Promise<string | null> | string | null;
  setItem(k: string, v: string): Promise<void> | void;
  removeItem(k: string): Promise<void> | void;
};

let memory: Record<string, string> = {};
const memoryStore: KV = {
  getItem: (k) => memory[k] ?? null,
  setItem: (k, v) => {
    memory[k] = v;
  },
  removeItem: (k) => {
    delete memory[k];
  },
};

let asyncBackend: KV | null = null;
export function setStorageBackend(backend: KV | null): void {
  asyncBackend = backend;
  if (backend === null) memory = {};
}
async function backend(): Promise<KV> {
  if (asyncBackend) return asyncBackend;
  try {
    const mod = (await import("@react-native-async-storage/async-storage").catch(
      () => null,
    )) as unknown as { default?: KV } | null;
    if (mod?.default?.getItem) {
      asyncBackend = mod.default;
      return asyncBackend;
    }
  } catch {
    /* fallback memory */
  }
  return memoryStore;
}
export async function storageGet(key: string): Promise<string | null> {
  const b = await backend();
  return (await b.getItem(key)) ?? null;
}
export async function storageSet(key: string, value: string): Promise<void> {
  const b = await backend();
  await b.setItem(key, value);
}
export async function storageRemove(key: string): Promise<void> {
  const b = await backend();
  await b.removeItem(key);
}
/** 同步 fallback（单测/纯函数路径使用）。 */
export const syncMemoryStorage: KV = memoryStore;
export function __resetMemory(): void {
  memory = {};
}
