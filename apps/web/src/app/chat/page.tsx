"use client";

import { useState, useRef, useEffect } from "react";
import { useGateway } from "../../context/gateway";

interface ChatActionDetail {
  name: string;
  ok: boolean;
  summary: string;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  actions?: string[];
  actionDetails?: ChatActionDetail[];
}

export default function ChatPage() {
  const { apiFetch } = useGateway();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      role: "system",
      content:
        "Project management assistant with auto-configuration.\nPrior user/assistant turns are sent with each message for context.\n\nExamples:\n- \"Flower / extension connected?\"\n- \"Add a task with 2 bees: one for YouTube research, one for summarizing\"\n- \"Set waggle to browser on district X\"\n- \"List bridges\" / \"Clear bridge pipeline start\"\n- \"Pending approvals?\"",
      timestamp: new Date().toISOString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setError("");

    const historyPayload = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    try {
      const data = await apiFetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ message: text, history: historyPayload }),
      });

      const aiMsg: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: "assistant",
        content: data.reply ?? "No response",
        timestamp: new Date().toISOString(),
        actions: data.actions,
        actionDetails: data.actionDetails,
      };
      setMessages((prev) => [...prev, aiMsg]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to get response";
      setError(msg);
      const errMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: "system",
        content: `Error: ${msg}`,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="page-container" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 60px)" }}>
      <header className="page-header">
        <div>
          <h1>Chat</h1>
          <p className="page-subtitle">Project graph + Flower / relay / settings status</p>
        </div>
      </header>

      {error && <p className="page-error">{error}</p>}

      <div style={{
        flex: 1,
        overflowY: "auto",
        padding: "1rem 0",
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
      }}>
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: "flex",
              justifyContent: msg.role === "user" ? "flex-end" : "flex-start",
            }}
          >
            <div style={{
              maxWidth: "75%",
              padding: "0.75rem 1rem",
              borderRadius: "12px",
              background: msg.role === "user"
                ? "var(--accent, #4f46e5)"
                : msg.role === "system"
                  ? "var(--bg-2, #f5f5f5)"
                  : "#fff",
              color: msg.role === "user" ? "#fff" : "var(--text, #333)",
              border: msg.role === "assistant" ? "1px solid var(--line, #e5e5e5)" : "none",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: "14px",
              lineHeight: "1.6",
              boxShadow: msg.role === "assistant" ? "0 1px 3px rgba(0,0,0,0.06)" : "none",
            }}>
              {msg.role === "system" && <div style={{ fontWeight: 600, marginBottom: "0.25rem", fontSize: "12px", opacity: 0.6 }}>System</div>}
              {msg.actions && msg.actions.length > 0 && (
                <div style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "0.25rem",
                  marginBottom: "0.5rem",
                }}>
                  {msg.actions.map((a, i) => (
                    <span key={i} style={{
                      fontSize: "11px",
                      padding: "2px 8px",
                      borderRadius: "10px",
                      background: a.includes("OK") ? "#dcfce7" : "#fef2f2",
                      color: a.includes("OK") ? "#166534" : "#991b1b",
                      fontWeight: 500,
                    }}>{a}</span>
                  ))}
                </div>
              )}
              {msg.actionDetails && msg.actionDetails.length > 0 && (
                <details style={{ marginBottom: "0.5rem", fontSize: "12px", opacity: 0.85 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 500 }}>Tool details</summary>
                  <ul style={{ margin: "0.35rem 0 0 1rem", padding: 0 }}>
                    {msg.actionDetails.map((d, i) => (
                      <li key={i} style={{ marginBottom: "0.25rem" }}>
                        <span style={{ color: d.ok ? "#166534" : "#991b1b" }}>{d.name}</span>
                        {d.summary ? `: ${d.summary}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{
              padding: "0.75rem 1rem",
              borderRadius: "12px",
              background: "#fff",
              border: "1px solid var(--line, #e5e5e5)",
              fontSize: "14px",
              color: "var(--text-muted, #999)",
            }}>
              Thinking...
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{
        display: "flex",
        gap: "0.5rem",
        padding: "0.75rem 0",
        borderTop: "1px solid var(--line, #e5e5e5)",
      }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          className="input"
          rows={1}
          style={{
            flex: 1,
            resize: "none",
            minHeight: "42px",
            maxHeight: "120px",
          }}
          disabled={loading}
        />
        <button
          className="btn-primary"
          onClick={handleSend}
          disabled={loading || !input.trim()}
          style={{ alignSelf: "flex-end" }}
        >
          {loading ? "..." : "Send"}
        </button>
      </div>
    </div>
  );
}
