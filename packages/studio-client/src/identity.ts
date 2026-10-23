import { createCompletedMessage, type Message } from "@open-agent-tools/api-contracts/chat";

/** Generate an ID in both browser and React Native runtimes. */
export function newId(): string {
  const runtime = globalThis as { crypto?: { randomUUID?: () => string } };
  if (runtime.crypto?.randomUUID) return runtime.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Create a client-local message that does not need persistence metadata. */
export function localMessage(role: Message["role"], content: string): Message {
  return createCompletedMessage(role, content, newId(), Date.now());
}
