import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface SessionMessage<Role extends string, Status extends string> {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status?: Status;
  tool_call_id?: string;
  tool_name?: string;
}

interface MessageRow<Role extends string, Status extends string> {
  id: string;
  sessionId: string;
  role: Role;
  content: string;
  createdAt: number;
  status: Status | null;
  toolCallId: string | null;
  toolName: string | null;
}

/** Read a user table's column names for non-destructive SQLite migrations. */
export function sqliteTableColumns(db: DatabaseSync, table: string): Set<string> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`invalid SQLite table name: ${table}`);
  }
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function messageFromRow<Role extends string, Status extends string>(
  row: MessageRow<Role, Status>,
): SessionMessage<Role, Status> {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: row.createdAt,
    ...(row.status ? { status: row.status } : {}),
    ...(row.toolCallId ? { tool_call_id: row.toolCallId } : {}),
    ...(row.toolName ? { tool_name: row.toolName } : {}),
  };
}

/** The caller owns schema migrations, connection lifetime and session visibility. */
export class SqliteSessionStore<Role extends string, Status extends string> {
  constructor(
    private readonly db: DatabaseSync,
    private readonly completeStatus: Status,
  ) {}

  messagesFor(sessionIds: readonly string[]): Map<string, SessionMessage<Role, Status>[]> {
    const result = new Map<string, SessionMessage<Role, Status>[]>(
      sessionIds.map((id) => [id, []]),
    );
    const ids = [...result.keys()];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = this.db
        .prepare(
          `
        SELECT id, session_id AS sessionId, role, content, created_at AS createdAt, status,
               tool_call_id AS toolCallId, tool_name AS toolName
        FROM messages WHERE session_id IN (${batch.map(() => "?").join(", ")})
        ORDER BY session_id, position ASC
      `,
        )
        .all(...batch) as unknown as MessageRow<Role, Status>[];
      for (const row of rows) result.get(row.sessionId)!.push(messageFromRow(row));
    }
    return result;
  }

  renameSession(id: string, title: string): boolean {
    return (
      this.db
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
        .run(title, Date.now(), id).changes > 0
    );
  }

  deleteSession(id: string): boolean {
    return this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0;
  }

  touchSession(id: string, updatedAt = Date.now()): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(updatedAt, id);
  }

  addMessage(
    sessionId: string,
    message: Omit<SessionMessage<Role, Status>, "id" | "createdAt"> & {
      id?: string;
      createdAt?: number;
    },
    options: { returnExisting?: boolean } = {},
  ): SessionMessage<Role, Status> | null {
    const session = this.db
      .prepare("SELECT id, title FROM sessions WHERE id = ?")
      .get(sessionId) as { id: string; title: string } | undefined;
    if (!session) return null;
    const id = message.id ?? randomUUID();
    const createdAt = message.createdAt ?? Date.now();
    const status = message.status ?? this.completeStatus;
    if (options.returnExisting) {
      const existing = this.db
        .prepare(
          `
        SELECT id, session_id AS sessionId, role, content, created_at AS createdAt, status,
               tool_call_id AS toolCallId, tool_name AS toolName FROM messages WHERE id = ?
      `,
        )
        .get(id) as MessageRow<Role, Status> | undefined;
      if (existing) {
        if (existing.sessionId !== sessionId || existing.role !== message.role) return null;
        return { ...messageFromRow(existing), status: existing.status ?? this.completeStatus };
      }
    }
    const row = this.db
      .prepare("SELECT COALESCE(MAX(position), -1) AS maxPos FROM messages WHERE session_id = ?")
      .get(sessionId) as { maxPos: number };
    this.db
      .prepare(
        `
      INSERT INTO messages (id, session_id, role, content, created_at, status, position, tool_call_id, tool_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        sessionId,
        message.role,
        message.content,
        createdAt,
        status,
        row.maxPos + 1,
        message.tool_call_id ?? null,
        message.tool_name ?? null,
      );
    if (session.title === "New chat" && message.role === "user") {
      const trimmed = message.content.trim().replace(/\n/g, " ");
      const title = trimmed.length > 32 ? `${trimmed.slice(0, 32)}…` : trimmed || "New chat";
      this.db
        .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
        .run(title, createdAt, sessionId);
    } else this.touchSession(sessionId, createdAt);
    return {
      id,
      role: message.role,
      content: message.content,
      createdAt,
      status,
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_name ? { tool_name: message.tool_name } : {}),
    };
  }

  updateMessage(
    messageId: string,
    patch: { content?: string; status?: Status },
  ): SessionMessage<Role, Status> | null {
    const existing = this.db
      .prepare(
        `
      SELECT id, session_id AS sessionId, role, content, created_at AS createdAt, status
      FROM messages WHERE id = ?
    `,
      )
      .get(messageId) as MessageRow<Role, Status> | undefined;
    if (!existing) return null;
    const content = patch.content ?? existing.content;
    const status = patch.status ?? existing.status ?? this.completeStatus;
    this.db
      .prepare("UPDATE messages SET content = ?, status = ? WHERE id = ?")
      .run(content, status, messageId);
    this.touchSession(existing.sessionId);
    return { id: existing.id, role: existing.role, content, createdAt: existing.createdAt, status };
  }

  deleteMessage(messageId: string): boolean {
    const existing = this.db
      .prepare("SELECT session_id AS sessionId FROM messages WHERE id = ?")
      .get(messageId) as { sessionId: string } | undefined;
    if (!existing) return false;
    this.db.prepare("DELETE FROM messages WHERE id = ?").run(messageId);
    this.touchSession(existing.sessionId);
    return true;
  }
}
