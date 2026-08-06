import { emptyChatResources, type Session } from "../types.js";

const STORAGE_KEY = "open-agent-tools.chat.v1";

export function normalizeSession(
  session: Omit<Session, "resources" | "providerId" | "model"> &
    Partial<Pick<Session, "resources" | "providerId" | "model">>,
): Session {
  return {
    ...session,
    providerId: typeof session.providerId === "string" && session.providerId ? session.providerId : undefined,
    model: typeof session.model === "string" && session.model ? session.model : undefined,
    resources: {
      mcpTools: Array.isArray(session.resources?.mcpTools) ? session.resources.mcpTools : [],
      rag: {
        sources: Array.isArray(session.resources?.rag?.sources)
          ? session.resources.rag.sources
          : [],
        topK: Number(session.resources?.rag?.topK) || emptyChatResources().rag.topK,
      },
    },
  };
}

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as Session[]).map(normalizeSession);
  } catch {
    console.warn("Corrupt localStorage sessions — resetting.");
    return [];
  }
}

export function saveSessions(sessions: Session[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
  } catch {
    console.warn("Failed to save sessions to localStorage.");
  }
}

export function clearSessions(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
