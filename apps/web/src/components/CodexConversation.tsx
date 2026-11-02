/**
 * Codex Conversation component - Chat with Codex using ChatGPT subscription.
 */
import { useState, useRef, useEffect } from "react";
import { apiPath } from "../api";
import { uuid } from "../uuid";
import { Markdown } from "./Markdown";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

interface CodexModel {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

export function CodexConversation() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("gpt-5.4");
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Load available models
    fetch(apiPath("/api/chatgpt/models"))
      .then((res) => res.json())
      .then((data) => {
        setModels(data.models || []);
        if (data.models?.length > 0) {
          setSelectedModel(data.models[0].id);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    if (!input.trim() || loading) return;

    const userMessage: Message = {
      id: uuid(),
      role: "user",
      content: input.trim(),
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);
    setError(null);

    const assistantMessage: Message = {
      id: uuid(),
      role: "assistant",
      content: "",
      createdAt: Date.now(),
    };

    setMessages((prev) => [...prev, assistantMessage]);

    try {
      const response = await fetch(apiPath("/api/chatgpt/codex"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: selectedModel,
          messages: [
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: userMessage.content },
          ],
        }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      // Parse SSE stream
      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const chunk = JSON.parse(line.slice(6));

              if (chunk.type === "text") {
                assistantMessage.content += chunk.text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMessage.id ? { ...m } : m
                  )
                );
              } else if (chunk.type === "error") {
                throw new Error(chunk.error);
              }
            } catch {
              // ignore parse errors
            }
          }
        }
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="codex-conversation">
      <div className="codex-conversation-header">
        <h3>ChatGPT Codex</h3>
        <select
          value={selectedModel}
          onChange={(e) => setSelectedModel(e.target.value)}
          disabled={loading}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </div>

      <div className="codex-conversation-messages">
        {messages.length === 0 && (
          <div className="codex-conversation-empty">
            <p>开始与 Codex 对话</p>
            <p className="codex-conversation-hint">
              使用你的 ChatGPT 订阅访问最新的 GPT-5 模型
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={`codex-message codex-message-${msg.role}`}>
            <div className="codex-message-avatar">
              {msg.role === "user" ? "👤" : "🤖"}
            </div>
            <div className="codex-message-content">
              <Markdown text={msg.content} />
            </div>
          </div>
        ))}

        {loading && messages[messages.length - 1]?.content === "" && (
          <div className="codex-message codex-message-assistant">
            <div className="codex-message-avatar">🤖</div>
            <div className="codex-message-content">
              <span className="codex-typing-indicator">思考中...</span>
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {error && <div className="codex-conversation-error">{error}</div>}

      <div className="codex-conversation-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
          disabled={loading}
          rows={3}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          {loading ? "发送中..." : "发送"}
        </button>
      </div>
    </div>
  );
}
