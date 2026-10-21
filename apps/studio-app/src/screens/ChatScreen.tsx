import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
  useWindowDimensions,
} from "react-native";
import {
  Button,
  Chip,
  FAB,
  Icon,
  IconButton,
  Modal,
  Surface,
  Text,
  TextInput,
  useTheme,
} from "react-native-paper";
import {
  createSessionApi,
  deleteSessionApi,
  fetchSessions,
  streamChat,
} from "../api/chat";
import {
  fetchResourceCatalog,
  fetchProviderModels,
  fetchProviders,
  type ProviderMetadata,
  type ResourceCatalog,
} from "../api/misc";
import {
  emptyChatResources,
  normalizeSessions,
  type ChatResourceBinding,
  type Message,
  type Session,
} from "../lib/types";
import { newId } from "../lib/ids";
import { storageGet, storageSet } from "../lib/storage";
import { Btn, ErrorText, Loading, OptionBar } from "../components/ui";
import { ChatResourceSheet } from "../components/ChatResourceSheet";

const CACHE_KEY = "open-agent-tools.chat.v1";

function autoTitle(content: string): string {
  const t = content.trim().replace(/\n/g, " ");
  return t.length > 32 ? `${t.slice(0, 32)}…` : t || "New chat";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptySession(): Session {
  return {
    id: newId(),
    title: "New chat",
    messages: [],
    updatedAt: Date.now(),
    resources: emptyChatResources(),
  };
}

export function ChatScreen() {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const wide = width >= 920;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState("");
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [catalog, setCatalog] = useState<ResourceCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const abortRef = useRef<{ abort: () => void } | null>(null);
  const listRef = useRef<FlatList<Message>>(null);
  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  useEffect(() => {
    let alive = true;
    const fallback = emptySession();
    setReady(false);
    setBootError(null);
    void (async () => {
      try {
        const raw = await storageGet(CACHE_KEY).catch(() => null);
        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) throw new Error("Invalid cached sessions");
          const local = normalizeSessions(parsed);
          if (local.length > 0) {
            if (!alive) return;
            setSessions(local);
            setActiveId(local[0]!.id);
            setReady(true);
            return;
          }
        }
        const loaded = await fetchSessions();
        const source = loaded.length > 0 ? loaded : [await createSessionApi()];
        const list = normalizeSessions(source);
        if (list.length === 0) throw new Error("服务端未返回有效会话");
        if (!alive) return;
        setSessions(list);
        setActiveId(list[0]!.id);
        await storageSet(CACHE_KEY, JSON.stringify(list)).catch(() => undefined);
      } catch (e) {
        if (!alive) return;
        setBootError(errorMessage(e));
        setSessions([fallback]);
        setActiveId(fallback.id);
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reloadTick]);

  useEffect(() => {
    let alive = true;
    fetchProviders()
      .then((items) => {
        if (alive) setProviders(items.filter((p) => p.enabled));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const refreshCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    fetchResourceCatalog()
      .then((c) => setCatalog(c))
      .catch((e: unknown) => setCatalogError(errorMessage(e)))
      .finally(() => setCatalogLoading(false));
  }, []);

  useEffect(() => {
    refreshCatalog();
  }, [refreshCatalog]);

  useEffect(() => {
    if (!ready || sessions.length === 0) return;
    const t = setTimeout(() => {
      void storageSet(CACHE_KEY, JSON.stringify(sessions)).catch(() => undefined);
    }, 250);
    return () => clearTimeout(t);
  }, [sessions, ready]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const patchMessage = useCallback(
    (sessionId: string, messageId: string, patch: Partial<Message>) => {
      setSessions((prev) =>
        prev.map((s) =>
          s.id !== sessionId
            ? s
            : {
                ...s,
                updatedAt: Date.now(),
                messages: s.messages.map((m) =>
                  m.id === messageId ? { ...m, ...patch, id: patch.id ?? m.id } : m,
                ),
              },
        ),
      );
    },
    [],
  );

  const updateResources = useCallback((sessionId: string, resources: ChatResourceBinding) => {
    setSessions((prev) =>
      prev.map((x) => (x.id === sessionId ? { ...x, updatedAt: Date.now(), resources } : x)),
    );
  }, []);

  const updateRouting = useCallback(
    (sessionId: string, routing: { providerId?: string; model?: string }) => {
      setSessions((prev) =>
        prev.map((x) =>
          x.id === sessionId
            ? {
                ...x,
                updatedAt: Date.now(),
                ...(routing.providerId !== undefined ? { providerId: routing.providerId } : {}),
                ...(routing.model !== undefined ? { model: routing.model } : {}),
              }
            : x,
        ),
      );
    },
    [],
  );

  const send = useCallback(() => {
    if (!active || streaming) return;
    const content = input.trim();
    if (!content) return;
    setActionError(null);
    const userMsg: Message = {
      id: newId(),
      role: "user",
      content,
      createdAt: Date.now(),
      status: "complete",
    };
    const assistantId = newId();
    const assistant: Message = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      status: "streaming",
    };
    const titlePatch = active.messages.length === 0 ? { title: autoTitle(content) } : {};
    setSessions((prev) =>
      prev.map((s) =>
        s.id === active.id
          ? {
              ...s,
              ...titlePatch,
              updatedAt: Date.now(),
              messages: [...s.messages, userMsg, assistant],
            }
          : s,
      ),
    );
    setInput("");
    setStreaming(true);
    let liveId = assistantId;
    const history = [...active.messages, userMsg]
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));
    const fallbackProvider = providers[0];
    const providerId = active.providerId ?? fallbackProvider?.id;
    const model = active.model ?? fallbackProvider?.models[0];
    abortRef.current = streamChat(
      history,
      model,
      {
        onDelta: (d) =>
          setSessions((prev) =>
            prev.map((s) =>
              s.id === active.id
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === liveId ? { ...m, content: m.content + d } : m,
                    ),
                  }
                : s,
            ),
          ),
        onAssistantMessageId: (id) => {
          const prev = liveId;
          liveId = id;
          patchMessage(active.id, prev, { id });
        },
        onRagCitations: (c) => patchMessage(active.id, liveId, { ragCitations: c }),
        onUsage: (u) => patchMessage(active.id, liveId, { usage: u }),
        onToolCall: (call) =>
          setSessions((prev) =>
            prev.map((s) =>
              s.id === active.id
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === liveId
                        ? {
                            ...m,
                            toolCalls: [...(m.toolCalls ?? []), { ...call, status: "pending" }],
                          }
                        : m,
                    ),
                  }
                : s,
            ),
          ),
        onToolResult: ({ id, name, result, ui, error }) =>
          setSessions((prev) =>
            prev.map((s) =>
              s.id === active.id
                ? {
                    ...s,
                    messages: s.messages.map((m) =>
                      m.id === liveId
                        ? {
                            ...m,
                            toolCalls: (m.toolCalls ?? []).map((t) =>
                              id && t.id !== id && t.name !== name
                                ? t
                                : {
                                    ...t,
                                    name,
                                    ...(result !== undefined ? { result } : {}),
                                    ...(ui !== undefined
                                      ? {
                                          ui: ui as Message["uiBlocks"] extends Array<infer U>
                                            ? U
                                            : never,
                                        }
                                      : {}),
                                    ...(error !== undefined ? { error } : {}),
                                    status: error ? "error" : "done",
                                  },
                            ),
                          }
                        : m,
                    ),
                  }
                : s,
            ),
          ),
        onDone: (meta) => {
          if (meta?.assistantMessageId && meta.assistantMessageId !== liveId)
            patchMessage(active.id, liveId, { id: meta.assistantMessageId });
          patchMessage(active.id, meta?.assistantMessageId ?? liveId, {
            status: "complete",
            ...(meta?.usage ? { usage: meta.usage } : {}),
          });
          setStreaming(false);
          abortRef.current = null;
        },
        onError: (e) => {
          patchMessage(active.id, liveId, { status: "error", errorMessage: e });
          setActionError(e);
          setStreaming(false);
          abortRef.current = null;
        },
        onStopped: () => {
          patchMessage(active.id, liveId, { status: "stopped" });
          setStreaming(false);
          abortRef.current = null;
        },
      },
      {
        sessionId: active.id,
        userMessage: { id: userMsg.id, content },
        resources: active.resources,
        ...(providerId ? { providerId } : {}),
      },
    );
  }, [active, input, streaming, patchMessage, providers]);

  const newSession = () => {
    const local = emptySession();
    setSessions((prev) => [local, ...prev]);
    setActiveId(local.id);
    setHistoryOpen(false);
    setActionError(null);
    void createSessionApi({ id: local.id, title: local.title }).catch((e: unknown) =>
      setActionError(`会话已保存在本地，但同步到服务端失败：${errorMessage(e)}`),
    );
  };

  const removeActive = () => {
    if (!active) return;
    setActionError(null);
    void deleteSessionApi(active.id).catch((e: unknown) =>
      setActionError(`删除服务端会话失败：${errorMessage(e)}`),
    );
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== active.id);
      const result = next.length > 0 ? next : [emptySession()];
      setActiveId(result[0]!.id);
      return result;
    });
  };

  const activeProvider =
    providers.find((x) => x.id === (active?.providerId ?? providers[0]?.id)) ?? null;

  if (!ready) {
    return (
      <View style={[styles.loadingWrap, { backgroundColor: theme.colors.background }]}>
        <Loading label="正在载入会话…" />
      </View>
    );
  }

  const sessionList = (
    <View style={styles.sessionPane}>
      <View style={styles.sessionHeader}>
        <View style={{ flex: 1 }}>
          <Text variant="titleLarge" style={styles.paneTitle}>
            会话
          </Text>
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {sessions.length} 个对话 · {providers.length || "默认"} 个模型通道
          </Text>
        </View>
        <IconButton
          icon="plus"
          mode="contained-tonal"
          accessibilityLabel="新建会话"
          onPress={newSession}
        />
      </View>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={styles.sessionList}
        renderItem={({ item }) => {
          const selected = item.id === activeId;
          return (
            <Surface
              elevation={0}
              style={[
                styles.sessionItem,
                {
                  backgroundColor: selected
                    ? theme.colors.secondaryContainer
                    : theme.colors.surface,
                  borderColor: selected
                    ? theme.colors.secondaryContainer
                    : theme.colors.outlineVariant,
                },
              ]}
              onTouchEnd={() => {
                setActiveId(item.id);
                setHistoryOpen(false);
              }}
            >
              <Text
                variant="titleSmall"
                numberOfLines={1}
                style={{
                  color: selected ? theme.colors.onSecondaryContainer : theme.colors.onSurface,
                }}
              >
                {item.title}
              </Text>
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {item.messages.length} 条消息 · {new Date(item.updatedAt).toLocaleDateString()}
              </Text>
            </Surface>
          );
        }}
        ListEmptyComponent={<Text style={{ color: theme.colors.onSurfaceVariant }}>暂无会话</Text>}
      />
      {active ? (
        <Button
          mode="text"
          icon="delete-outline"
          textColor={theme.colors.error}
          onPress={removeActive}
          style={styles.deleteButton}
        >
          删除当前会话
        </Button>
      ) : null}
    </View>
  );

  const messages = active?.messages ?? [];

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 64 : 0}
      style={[styles.wrap, { backgroundColor: theme.colors.background }]}
    >
      {wide ? sessionList : null}
      <View style={styles.main}>
        <View style={styles.chatTopbar}>
          {!wide ? (
            <IconButton
              icon="history"
              accessibilityLabel="会话历史"
              onPress={() => setHistoryOpen(true)}
            />
          ) : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="titleMedium" numberOfLines={1} style={styles.chatTitle}>
              {active?.title ?? "对话"}
            </Text>
            <Text
              variant="bodySmall"
              numberOfLines={1}
              style={{ color: theme.colors.onSurfaceVariant }}
            >
              {activeProvider?.name ?? "默认模型通道"}
              {active?.model ? ` · ${active.model}` : ""}
            </Text>
          </View>
          <IconButton
            icon="tune-variant"
            accessibilityLabel="配置对话资源"
            onPress={() => setSheetOpen(true)}
            disabled={!active}
          />
          <IconButton
            icon="swap-horizontal"
            accessibilityLabel="切换模型"
            onPress={() => setModelOpen(true)}
            disabled={!active || providers.length === 0}
          />
        </View>
        {bootError ? (
          <ErrorText message={bootError} onRetry={() => setReloadTick((t) => t + 1)} />
        ) : null}
        {actionError ? <ErrorText message={actionError} /> : null}
        {catalogError && !sheetOpen ? (
          <ErrorText message={catalogError} onRetry={refreshCatalog} />
        ) : null}
        {active ? (
          <>
            <View style={styles.quickBar}>
              <Chip compact icon="book-open-variant" onPress={() => setSheetOpen(true)}>
                {`RAG ${active.resources.rag.sources.length}`}
              </Chip>
              <Chip compact icon="database-outline" onPress={() => setSheetOpen(true)}>
                {`SQL ${active.resources.sqlSources.length}`}
              </Chip>
              <Chip compact icon="api" onPress={() => setSheetOpen(true)}>
                {`Tools ${active.resources.mcpTools.length}`}
              </Chip>
            </View>
            <FlatList
              ref={listRef}
              data={messages}
              keyExtractor={(m) => m.id}
              contentContainerStyle={styles.messageList}
              keyboardShouldPersistTaps="handled"
              onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
              renderItem={({ item }) => <MessageRow message={item} />}
              ListEmptyComponent={
                <View style={styles.emptyChat}>
                  <View
                    style={[styles.emptyIcon, { backgroundColor: theme.colors.primaryContainer }]}
                  >
                    <Icon
                      source="message-text-outline"
                      size={34}
                      color={theme.colors.onPrimaryContainer}
                    />
                  </View>
                  <Text variant="headlineSmall" style={styles.emptyTitle}>
                    从一个问题开始
                  </Text>
                  <Text
                    variant="bodyMedium"
                    style={[styles.emptyCopy, { color: theme.colors.onSurfaceVariant }]}
                  >
                    挂载知识库、数据源和 MCP 工具后，模型会在对话中按需调用。
                  </Text>
                </View>
              }
            />
            <Surface
              elevation={2}
              style={[styles.composer, { backgroundColor: theme.colors.surface }]}
            >
              <TextInput
                mode="flat"
                placeholder="输入问题"
                value={input}
                onChangeText={setInput}
                multiline
                dense
                style={styles.composerInput}
                disabled={streaming}
              />
              {streaming ? (
                <Button
                  mode="contained"
                  icon="stop"
                  buttonColor={theme.colors.error}
                  textColor={theme.colors.onError}
                  onPress={() => abortRef.current?.abort()}
                >
                  停止
                </Button>
              ) : (
                <IconButton
                  icon="arrow-up"
                  mode="contained"
                  accessibilityLabel="发送消息"
                  onPress={send}
                  disabled={!input.trim()}
                />
              )}
            </Surface>
          </>
        ) : (
          <View style={styles.emptyChat}>
            <Text variant="titleMedium">暂无会话</Text>
            <Button mode="contained" onPress={newSession} style={{ marginTop: 12 }}>
              新建会话
            </Button>
          </View>
        )}
        {active ? (
          <ChatResourceSheet
            visible={sheetOpen}
            catalog={catalog}
            loading={catalogLoading}
            error={catalogError}
            resources={active.resources}
            onClose={() => setSheetOpen(false)}
            onRefresh={refreshCatalog}
            onChange={(r) => updateResources(active.id, r)}
          />
        ) : null}
        {active ? (
          <Modal
            visible={modelOpen}
            onDismiss={() => setModelOpen(false)}
            contentContainerStyle={[
              styles.modelModal,
              { backgroundColor: theme.colors.surface },
            ]}
          >
            <Text variant="titleLarge" style={styles.modelTitle}>
              模型通道
            </Text>
            <Text
              variant="bodySmall"
              style={{ color: theme.colors.onSurfaceVariant, marginBottom: 14 }}
            >
              当前会话独立选择 Provider 与模型，不影响其他会话。
            </Text>
            <OptionBar
              options={providers.map((x) => x.id)}
              value={active.providerId ?? providers[0]?.id ?? ""}
              onChange={(pid) => {
                updateRouting(active.id, { providerId: pid, model: undefined });
                setModels([]);
              }}
              labels={Object.fromEntries(providers.map((x) => [x.id, x.name]))}
            />
            <ModelRow
              provider={activeProvider}
              model={active.model}
              models={models}
              onModels={setModels}
              onPick={(m) => updateRouting(active.id, { model: m })}
            />
            <Btn title="完成" onPress={() => setModelOpen(false)} />
          </Modal>
        ) : null}
        {!wide && historyOpen ? (
          <Surface
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: theme.colors.background, zIndex: 20 },
            ]}
          >
            <View style={styles.mobileHistoryHeader}>
              <IconButton
                icon="arrow-left"
                accessibilityLabel="关闭会话历史"
                onPress={() => setHistoryOpen(false)}
              />
              <Text variant="titleLarge">会话历史</Text>
              <IconButton
                icon="plus"
                mode="contained-tonal"
                accessibilityLabel="新建会话"
                onPress={newSession}
              />
            </View>
            {sessionList}
          </Surface>
        ) : null}
        <FAB
          icon="plus"
          accessibilityLabel="新建会话"
          style={[styles.fab, { backgroundColor: theme.colors.primary }]}
          color={theme.colors.onPrimary}
          onPress={newSession}
          visible={wide && !streaming}
        />
      </View>
    </KeyboardAvoidingView>
  );
}

function MessageRow({ message }: { message: Message }) {
  const theme = useTheme();
  const isUser = message.role === "user";
  const toolErrors = (message.toolCalls ?? []).filter((tool) => tool.status === "error").length;
  return (
    <View style={[styles.messageRow, isUser ? styles.messageRowUser : null]}>
      {!isUser ? (
        <View style={[styles.avatar, { backgroundColor: theme.colors.primaryContainer }]}>
          <Icon source="creation-outline" size={18} color={theme.colors.onPrimaryContainer} />
        </View>
      ) : null}
      <View
        style={[
          styles.messageBubble,
          isUser
            ? { backgroundColor: theme.colors.primary, borderBottomRightRadius: 4 }
            : {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.outlineVariant,
                borderWidth: 1,
                borderBottomLeftRadius: 4,
              },
        ]}
      >
        {!isUser ? (
          <Text
            variant="labelSmall"
            style={{ color: theme.colors.onSurfaceVariant, marginBottom: 5 }}
          >
            ASSISTANT
            {message.status === "streaming" ? " · 正在生成" : ""}
          </Text>
        ) : null}
        <Text
          variant="bodyMedium"
          selectable
          style={[
            styles.messageText,
            { color: isUser ? theme.colors.onPrimary : theme.colors.onSurface },
          ]}
        >
          {message.content ||
            (message.status === "streaming"
              ? "思考中…"
              : message.status === "stopped"
                ? "已停止生成"
                : "")}
        </Text>
        {message.toolCalls?.length ? (
          <View style={styles.toolSummary}>
            <Icon
              source={toolErrors ? "alert-circle-outline" : "check-circle-outline"}
              size={14}
              color={
                isUser
                  ? theme.colors.onPrimary
                  : toolErrors
                    ? theme.colors.error
                    : theme.colors.primary
              }
            />
            <Text
              variant="labelSmall"
              style={{ color: isUser ? theme.colors.onPrimary : theme.colors.onSurfaceVariant }}
            >
              {`工具调用 ${message.toolCalls.length} 次${toolErrors ? ` · ${toolErrors} 次失败` : ""}`}
            </Text>
          </View>
        ) : null}
        {message.ragCitations?.length ? (
          <Text
            variant="labelSmall"
            style={{
              color: isUser ? theme.colors.onPrimary : theme.colors.onSurfaceVariant,
              marginTop: 5,
            }}
          >
            {`引用 ${message.ragCitations.length} 段知识库内容`}
          </Text>
        ) : null}
        {message.usage ? (
          <Text
            variant="labelSmall"
            style={{
              color: isUser ? theme.colors.onPrimary : theme.colors.onSurfaceVariant,
              marginTop: 5,
            }}
          >
            {`${message.usage.inputTokens} in / ${message.usage.outputTokens} out tokens`}
          </Text>
        ) : null}
        {message.errorMessage ? (
          <Text variant="bodySmall" style={{ color: theme.colors.error, marginTop: 8 }}>
            {message.errorMessage}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function ModelRow({
  provider,
  model,
  models,
  onModels,
  onPick,
}: {
  provider: ProviderMetadata | null;
  model: string | undefined;
  models: string[];
  onModels: (models: string[]) => void;
  onPick: (model: string) => void;
}) {
  const theme = useTheme();
  const list = models.length > 0 ? models : (provider?.models ?? []);
  React.useEffect(() => {
    if (!provider || models.length > 0 || (provider.models ?? []).length > 0) return;
    let alive = true;
    void fetchProviderModels(provider.id)
      .then((fetched) => {
        if (alive) onModels(fetched);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [provider, models.length, onModels]);
  if (!provider || list.length === 0) {
    return (
      <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}>
        该通道没有可用模型
      </Text>
    );
  }
  return (
    <View style={{ marginTop: 8 }}>
      <Text variant="labelMedium" style={{ marginBottom: 8 }}>
        模型
      </Text>
      <OptionBar options={list} value={model ?? list[0]!} onChange={onPick} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, flexDirection: "row" },
  loadingWrap: { flex: 1, justifyContent: "center" },
  sessionPane: {
    width: 280,
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: "transparent",
  },
  sessionHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 8,
  },
  paneTitle: { fontWeight: "700" },
  sessionList: { paddingHorizontal: 12, paddingBottom: 20 },
  sessionItem: {
    borderWidth: 1,
    borderRadius: 13,
    padding: 12,
    marginBottom: 7,
  },
  deleteButton: { alignSelf: "flex-start", marginHorizontal: 12, marginBottom: 12 },
  main: { flex: 1, minWidth: 0 },
  chatTopbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  chatTitle: { fontWeight: "700" },
  quickBar: {
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 16,
    paddingVertical: 8,
    flexWrap: "wrap",
  },
  messageList: {
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 18,
    gap: 14,
    flexGrow: 1,
  },
  messageRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    maxWidth: "92%",
  },
  messageRowUser: { alignSelf: "flex-end", justifyContent: "flex-end" },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 3,
  },
  messageBubble: {
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexShrink: 1,
  },
  messageText: { lineHeight: 22 },
  toolSummary: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 7 },
  emptyChat: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 32,
    paddingVertical: 48,
  },
  emptyIcon: {
    width: 68,
    height: 68,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
  },
  emptyTitle: { fontWeight: "700", letterSpacing: -0.3 },
  emptyCopy: { textAlign: "center", maxWidth: 360, marginTop: 8, lineHeight: 21 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 4,
    marginHorizontal: 12,
    marginBottom: 10,
    paddingLeft: 12,
    paddingRight: 6,
    paddingVertical: 5,
    borderRadius: 20,
  },
  composerInput: { flex: 1, backgroundColor: "transparent", maxHeight: 130 },
  mobileHistoryHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  fab: { position: "absolute", right: 18, bottom: 18 },
  modelModal: { marginHorizontal: 20, borderRadius: 24, padding: 22 },
  modelTitle: { fontWeight: "700", marginBottom: 4 },
});
