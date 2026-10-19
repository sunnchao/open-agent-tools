import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Spin } from "antd";
import { PauseCircleOutlined, SendOutlined } from "../../lib/icons.js";
import { MarkdownView } from "../../components/MarkdownView.js";
import type { Message, ToolCall } from "../../types.js";
import { newId } from "../../lib/ids.js";
import { fetchAppProfile, streamAppChat, type AppChatProfile } from "./api.js";
import { applyBranding } from "../branding/applyBranding.js";
import { fetchPublicBranding } from "../branding/api.js";

interface EmployeeAppProps {
  slug: string;
}

/**
 * 员工侧应用入口：只做问答，不暴露 Provider、资源抽屉、会话管理等管理能力。
 *
 * 与 Studio 的 `ChatWorkspace` 刻意分开实现——共用一个组件会让「管理员能配的东西」
 * 迟早以某种形式漏到员工界面上。
 */
export function EmployeeApp({ slug }: EmployeeAppProps) {
  const [profile, setProfile] = useState<AppChatProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef(newId());
  const scrollRef = useRef<HTMLDivElement>(null);

  // 员工入口也要套白标:客户看到的应该是自己的品牌,而不是原厂品牌。
  useEffect(() => {
    let cancelled = false;
    fetchPublicBranding()
      .then((value) => {
        if (!cancelled) applyBranding(value, { documentTitleSuffix: "Knowledge" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchAppProfile(slug)
      .then((value) => {
        if (!cancelled) setProfile(value);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "应用加载失败");
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const send = useCallback(
    (content: string) => {
      const text = content.trim();
      if (!text || streaming) return;
      const userMessage: Message = {
        id: newId(),
        role: "user",
        content: text,
        createdAt: Date.now(),
        status: "complete",
      };
      const assistantId = newId();
      const history = [...messages, userMessage];
      setMessages([
        ...history,
        {
          id: assistantId,
          role: "assistant",
          content: "",
          createdAt: Date.now(),
          status: "streaming",
        },
      ]);
      setInput("");
      setStreaming(true);

      const patch = (update: Partial<Message>) =>
        setMessages((prev) =>
          prev.map((message) => (message.id === assistantId ? { ...message, ...update } : message)),
        );

      controllerRef.current = streamAppChat(
        slug,
        history.map((message) => ({ role: message.role, content: message.content })),
        {
          onDelta: (delta) =>
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, content: message.content + delta }
                  : message,
              ),
            ),
          onToolCall: (call: ToolCall) =>
            setMessages((prev) =>
              prev.map((message) =>
                message.id === assistantId
                  ? { ...message, toolCalls: [...(message.toolCalls ?? []), call] }
                  : message,
              ),
            ),
          onDone: () => {
            patch({ status: "complete" });
            setStreaming(false);
            controllerRef.current = null;
          },
          onError: (error) => {
            patch({ status: "error", errorMessage: error });
            setStreaming(false);
            controllerRef.current = null;
          },
          onStopped: () => {
            patch({ status: "stopped" });
            setStreaming(false);
            controllerRef.current = null;
          },
        },
        {
          sessionId: sessionIdRef.current,
        },
      );
    },
    [messages, slug, streaming],
  );

  if (loadError) {
    // 口令缺失/错误与配额用尽是最常见的两类「打不开」，给可操作的话术而不是裸错误。
    const needsToken = /口令/.test(loadError);
    return (
      <div className="employee-app employee-app--error">
        <h1>{needsToken ? "需要访问口令" : "应用不可用"}</h1>
        <p>{needsToken ? "请使用管理员提供的完整链接打开（链接里带有访问口令）。" : loadError}</p>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="employee-app employee-app--loading">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="employee-app">
      <header className="employee-app__header">
        <div>
          <h1>{profile.name}</h1>
          {profile.description ? <p>{profile.description}</p> : null}
        </div>
      </header>

      <div className="employee-app__messages" ref={scrollRef}>
        <div className="employee-app__inner">
          {messages.length === 0 ? (
            <div className="employee-app__welcome">
              <h2>{profile.welcome || `你好，我是${profile.name}`}</h2>
              {profile.suggestions.length > 0 ? (
                <div className="employee-app__suggestions">
                  {profile.suggestions.map((item) => (
                    <Button
                      key={item.title}
                      onClick={() => send(item.prompt)}
                      className="employee-app__suggestion"
                    >
                      {item.title}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`employee-app__row employee-app__row--${message.role}`}
              >
                <div className="employee-app__bubble">
                  {message.role === "assistant" ? (
                    <>
                      {message.content ? <MarkdownView content={message.content} /> : null}
                      {message.status === "streaming" ? (
                        <span className="employee-app__caret" />
                      ) : null}
                      {message.status === "error" ? (
                        <p className="employee-app__error">{message.errorMessage ?? "请求失败"}</p>
                      ) : null}
                      {message.status === "stopped" ? (
                        <p className="employee-app__stopped">已停止生成</p>
                      ) : null}
                    </>
                  ) : (
                    message.content
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="employee-app__composer">
        <div className="employee-app__inner">
          <Input.TextArea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入你的问题…"
            autoSize={{ minRows: 1, maxRows: 6 }}
            disabled={streaming}
            onPressEnter={(event) => {
              const native = event.nativeEvent as KeyboardEvent;
              if (native.isComposing || event.shiftKey) return;
              event.preventDefault();
              send(input);
            }}
          />
          {streaming ? (
            <Button
              danger
              icon={<PauseCircleOutlined />}
              onClick={() => controllerRef.current?.abort()}
            >
              停止
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<SendOutlined />}
              disabled={!input.trim()}
              onClick={() => send(input)}
            >
              发送
            </Button>
          )}
        </div>
        {profile.quota && profile.quota.dailyTokenBudget > 0 ? (
          <div className="employee-app__inner employee-app__quota">
            今日额度已用 {profile.quota.usedTokensToday.toLocaleString()} /{" "}
            {profile.quota.dailyTokenBudget.toLocaleString()} tokens
          </div>
        ) : null}
      </div>
    </div>
  );
}
