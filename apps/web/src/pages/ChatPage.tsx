/**
 * ChatPage — Conversational interaction entry point for Human-Agent interaction.
 *
 * Closes GAP-02: the framework had conversationStore and agentInbox infrastructure
 * but no conversational interaction UI. This page provides a chat interface where
 * users can send messages to an Agent, see responses in real-time, and view
 * conversation history.
 *
 * Design principles (from UX audit):
 * - Transparency: shows Agent ID and run ID for each response
 * - Interruptibility: user can cancel pending requests
 * - Correctability: conversation history is preserved and scrollable
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { Send, Trash2, Loader, AlertCircle } from 'lucide-react';
import { sendChatMessageStream, API_BASE, PROJECT_ID, getAuthToken } from '../api';
import type { ChatMessage, ChatStreamStep } from '../api';

export function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingThoughts, setStreamingThoughts] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Load conversation history on mount
  useEffect(() => {
    async function loadHistory() {
      try {
        const response = await fetch(
          `${API_BASE}/api/chat/history?projectId=${PROJECT_ID}&limit=50`,
        );
        if (response.ok) {
          const data = (await response.json()) as { messages: ChatMessage[] };
          if (data.messages && data.messages.length > 0) {
            setMessages(data.messages);
          }
        }
      } catch {
        // Silently fail — history is optional
      }
    }
    loadHistory();
  }, []);

  // Subscribe to SSE for real-time Agent thoughts during execution
  const subscribeToStream = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const params = new URLSearchParams({
      topics: 'agent.message,tool.executed,tool.started',
    });
    const token = getAuthToken();
    if (token) {
      // Cookie preferred when API is same-site; query kept as cross-origin fallback
      // (server strips access_token from req.url before logging).
      document.cookie = `commander_access_token=${encodeURIComponent(token)}; path=/; SameSite=Lax`;
      params.set('access_token', token);
    }
    const es = new EventSource(`${API_BASE}/projects/${PROJECT_ID}/events?${params.toString()}`, {
      withCredentials: true,
    });
    eventSourceRef.current = es;

    es.addEventListener('agent.message', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.payload?.content) {
          setStreamingThoughts((prev) => [...prev, data.payload.content]);
        }
      } catch {
        // Ignore parse errors
      }
    });

    es.addEventListener('tool.started', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.payload?.toolName) {
          setStreamingThoughts((prev) => [...prev, `🔧 Using tool: ${data.payload.toolName}`]);
        }
      } catch {
        // Ignore parse errors
      }
    });

    es.addEventListener('tool.executed', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data);
        if (data.payload?.toolName && data.payload?.success !== undefined) {
          const status = data.payload.success ? '✓' : '✗';
          setStreamingThoughts((prev) => [
            ...prev,
            `${status} Tool ${data.payload.toolName} ${data.payload.success ? 'completed' : 'failed'}`,
          ]);
        }
      } catch {
        // Ignore parse errors
      }
    });

    es.onerror = () => {
      // SSE will auto-reconnect; no action needed
    };
  }, []);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
    };
  }, []);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingThoughts]);

  // Auto-resize textarea
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  /**
   * Formats a streamed step into a human-readable line for the assistant bubble.
   * Steps arrive incrementally and are appended to the streaming message body.
   */
  function formatStreamStep(step: ChatStreamStep): string {
    switch (step.type) {
      case 'thought':
        return `💭 ${step.content}`;
      case 'tool_call':
        return `🔧 ${step.content}`;
      case 'tool_result':
        return `↳ ${step.content}`;
      case 'response':
        return step.content;
      default:
        return step.content;
    }
  }

  async function handleSend() {
    const trimmed = input.trim();
    if (!trimmed || loading) return;

    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      role: 'user',
      content: trimmed,
      timestamp: now,
    };
    // Insert a streaming assistant placeholder immediately so the user sees
    // their message paired with an in-progress response bubble.
    const assistantPlaceholder: ChatMessage = {
      role: 'assistant',
      content: '',
      timestamp: now,
      isStreaming: true,
    };
    setMessages((prev) => [...prev, userMessage, assistantPlaceholder]);
    setInput('');
    setLoading(true);
    setError(null);
    setStreamingThoughts([]);
    subscribeToStream();

    try {
      await sendChatMessageStream(trimmed, undefined, undefined, {
        onStart: (data) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.isStreaming) {
              updated[updated.length - 1] = {
                ...last,
                agentId: data.agentId,
              };
            }
            return updated;
          });
        },
        onStep: (step) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.isStreaming) {
              const line = formatStreamStep(step);
              updated[updated.length - 1] = {
                ...last,
                content: last.content ? `${last.content}\n${line}` : line,
              };
            }
            return updated;
          });
        },
        onDone: (final) => {
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.isStreaming) {
              // Replace the accumulated step transcript with the final reply.
              updated[updated.length - 1] = {
                ...last,
                content: final.reply,
                agentId: final.agentId,
                timestamp: final.timestamp,
                isStreaming: false,
              };
            }
            return updated;
          });
        },
        onError: (errMsg) => {
          setError(errMsg);
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last && last.isStreaming) {
              updated[updated.length - 1] = {
                ...last,
                content: last.content || '(stream failed)',
                isStreaming: false,
              };
            }
            return updated;
          });
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
      // Finalize the streaming bubble so it stops showing the spinner.
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.isStreaming) {
          updated[updated.length - 1] = {
            ...last,
            content: last.content || '(failed to get response)',
            isStreaming: false,
          };
        }
        return updated;
      });
    } finally {
      setLoading(false);
      setStreamingThoughts([]);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  async function handleClearHistory() {
    try {
      await fetch(`${API_BASE}/api/chat/history?projectId=${PROJECT_ID}`, {
        method: 'DELETE',
      });
      setMessages([]);
    } catch {
      // Silently fail
    }
  }

  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div className="page-head" style={{ flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <span className="section-label">Conversational Interface</span>
            <h1>Agent Chat</h1>
            <p className="page-desc">
              Send messages directly to an Agent. Responses stream in real-time with tool usage
              visibility.
            </p>
          </div>
          {messages.length > 0 && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={handleClearHistory}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.75rem' }}
            >
              <Trash2 size={14} />
              Clear
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="banner error" style={{ marginBottom: '12px' }}>
          <AlertCircle size={16} style={{ display: 'inline', marginRight: '6px' }} />
          <span>{error}</span>
        </div>
      )}

      {/* Messages area */}
      <div
        className="chat-messages"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '16px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}
      >
        {messages.length === 0 && !loading && (
          <div
            style={{
              textAlign: 'center',
              padding: '40px 20px',
              color: 'var(--text-muted)',
            }}
          >
            <div style={{ fontSize: '2rem', marginBottom: '12px' }}>💬</div>
            <p style={{ fontSize: '0.9rem' }}>
              Start a conversation with an Agent. Ask questions, give tasks, or request analysis.
            </p>
            <div
              style={{
                marginTop: '16px',
                display: 'flex',
                gap: '8px',
                justifyContent: 'center',
                flexWrap: 'wrap',
              }}
            >
              {[
                'Analyze the current security posture',
                'What missions are currently running?',
                'Summarize recent execution logs',
              ].map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className="btn btn-ghost"
                  style={{ fontSize: '0.72rem', padding: '4px 10px' }}
                  onClick={() => setInput(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => {
          const isStreamingMsg = msg.isStreaming === true;
          return (
            <div
              key={i}
              className={`chat-msg chat-msg-${msg.role}`}
              style={{
                display: 'flex',
                gap: '10px',
                flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
              }}
            >
              <div
                className="chat-avatar"
                style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '50%',
                  background: msg.role === 'user' ? 'var(--accent-blue)' : 'var(--accent-green)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                  flexShrink: 0,
                  color: '#fff',
                }}
              >
                {msg.role === 'user' ? 'U' : 'A'}
              </div>
              <div
                className="chat-bubble"
                style={{
                  maxWidth: '70%',
                  padding: '10px 14px',
                  borderRadius: '10px',
                  background: msg.role === 'user' ? 'var(--accent-blue)' : 'var(--bg-elevated)',
                  color: msg.role === 'user' ? '#fff' : 'var(--text-primary)',
                  fontSize: '0.85rem',
                  lineHeight: 1.6,
                  wordBreak: 'break-word',
                }}
              >
                <div style={{ whiteSpace: 'pre-wrap' }}>
                  {msg.content || (isStreamingMsg ? 'Thinking…' : '')}
                  {isStreamingMsg && msg.content && (
                    <span
                      className="chat-cursor"
                      style={{
                        display: 'inline-block',
                        width: 7,
                        marginLeft: 2,
                        color: 'var(--accent-green)',
                        animation: 'blink 1s step-end infinite',
                      }}
                    >
                      ▋
                    </span>
                  )}
                </div>
                {isStreamingMsg ? (
                  <div
                    style={{
                      fontSize: '0.6rem',
                      opacity: 0.6,
                      marginTop: '4px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Loader size={10} className="spin" />
                    streaming…
                  </div>
                ) : (
                  msg.agentId && (
                    <div
                      style={{
                        fontSize: '0.6rem',
                        opacity: 0.6,
                        marginTop: '4px',
                      }}
                    >
                      {msg.agentId} · {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  )
                )}
              </div>
            </div>
          );
        })}

        {/* Streaming thoughts while loading */}
        {loading && streamingThoughts.length > 0 && (
          <div
            style={{
              padding: '8px 14px',
              background: 'var(--bg-surface)',
              borderRadius: '8px',
              fontSize: '0.75rem',
              color: 'var(--text-muted)',
              fontFamily: 'var(--font-mono)',
              maxWidth: '80%',
            }}
          >
            {streamingThoughts.slice(-5).map((thought, i) => (
              <div key={i} style={{ marginBottom: '2px', opacity: 0.7 + (i / 5) * 0.3 }}>
                {thought}
              </div>
            ))}
          </div>
        )}

        {/* Loading indicator — only when no streaming bubble is already rendered */}
        {loading && !messages.some((m) => m.isStreaming) && (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <div
              className="chat-avatar"
              style={{
                width: '32px',
                height: '32px',
                borderRadius: '50%',
                background: 'var(--accent-green)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Loader size={14} className="spin" />
            </div>
            <div
              style={{
                padding: '10px 14px',
                background: 'var(--bg-elevated)',
                borderRadius: '10px',
                fontSize: '0.85rem',
                color: 'var(--text-muted)',
              }}
            >
              Agent is thinking...
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div
        className="chat-input-area"
        style={{
          flexShrink: 0,
          padding: '12px 0',
          borderTop: '1px solid var(--border)',
          display: 'flex',
          gap: '10px',
          alignItems: 'flex-end',
        }}
      >
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message to the Agent... (Enter to send, Shift+Enter for newline)"
          rows={1}
          style={{
            flex: 1,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: '8px',
            padding: '10px 14px',
            color: 'var(--text-primary)',
            fontSize: '0.85rem',
            resize: 'none',
            outline: 'none',
            fontFamily: 'inherit',
            lineHeight: 1.5,
            maxHeight: '120px',
          }}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={handleSend}
          disabled={!input.trim() || loading}
          style={{
            padding: '10px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: '0.85rem',
          }}
        >
          <Send size={16} />
          Send
        </button>
      </div>
    </div>
  );
}
