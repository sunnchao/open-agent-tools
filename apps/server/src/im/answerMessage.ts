import { askChat } from "./chatClient.js";
import { recordImChatAudit, type ImChatAuditInput } from "./audit.js";
import { chunkText } from "./text.js";
import { buildImSessionId, type ImConfig, type ImMessageEvent } from "./types.js";
import { logDebugDuration, logTrace } from "../trace.js";

interface AnswerMessageDeps {
  reply: (text: string) => Promise<void>;
  askChat?: typeof askChat;
  resolveSenderName?: (actor: string) => Promise<string | null>;
  recordAudit?: typeof recordImChatAudit;
}

/** Shared chat/reply/audit flow; platform adapters own event parsing and reply transport. */
export async function answerImMessage(
  config: ImConfig,
  event: ImMessageEvent,
  deps: AnswerMessageDeps,
): Promise<void> {
  if (event.text === null) return;
  const question = event.text;
  const startedAt = Date.now();
  const { platform, chatId, chatType, senderOpenId: actor } = event;
  const sessionId = buildImSessionId(platform, chatId, chatType, actor);
  // Resolve directory names alongside chat; resolution failures leave the audit name empty.
  const actorNamePromise =
    actor && deps.resolveSenderName
      ? deps.resolveSenderName(actor).catch(() => null)
      : Promise.resolve(event.senderName);

  function audit(
    input: Pick<
      ImChatAuditInput,
      "answer" | "status" | "error" | "actorName" | "toolCalls" | "citations"
    >,
  ): void {
    try {
      (deps.recordAudit ?? recordImChatAudit)({
        channelId: config.channelId ?? null,
        channelName: config.name,
        platform,
        sessionId,
        workspace: config.workspaceId ?? null,
        actor: actor ?? null,
        actorName: input.actorName ?? null,
        chatType,
        conversationId: chatId,
        question,
        answer: input.answer,
        status: input.status,
        error: input.error ?? null,
        durationMs: Date.now() - startedAt,
        toolCalls: input.toolCalls ?? 0,
        citations: input.citations ?? 0,
      });
    } catch (error) {
      // Audit failures must not interrupt replies or trigger a second error reply.
      logTrace(`im.${platform}.audit_error`, { error: String(error) }, "error");
    }
  }

  try {
    const [answer, actorName] = await Promise.all([
      (deps.askChat ?? askChat)({
        baseUrl: config.chatBaseUrl,
        question,
        sessionId,
        sources: config.ragSources,
        topK: config.ragTopK,
        sqlSources: config.sqlSources,
        mcpTools: config.mcpTools,
        ...(config.workspaceId ? { workspaceId: config.workspaceId } : {}),
        im: {
          ...(config.channelId ? { channelId: config.channelId } : {}),
          ...(actor ? { actor } : {}),
          chatType,
        },
      }),
      actorNamePromise,
    ]);
    logDebugDuration(`im.${platform}.ask_chat`, startedAt, {
      chatId,
      contentLength: answer.content.length,
    });
    const parts = chunkText(answer.content);
    for (const part of parts.length > 0 ? parts : ["（没有生成回答内容）"]) {
      await deps.reply(part);
    }
    audit({
      answer: parts.length > 0 ? answer.content : "",
      status: "ok",
      actorName,
      toolCalls: answer.toolCalls.length,
      citations: answer.citations,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logTrace(`im.${platform}.chat_error`, { error: message }, "error");
    const actorName = await actorNamePromise;
    await deps.reply(`抱歉，处理失败：${message.slice(0, 300)}`);
    audit({ answer: "", status: "error", error: message, actorName });
  }
}
