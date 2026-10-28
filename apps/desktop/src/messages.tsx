import { type FormEvent, useEffect, useRef, useState } from "react";
import type { NetworkStatus } from "../../../packages/app-dht/src/lifecycle.js";
import type { ContactView, MessageView } from "./messaging.js";

export function Messages({
  connection,
  compact = false,
  onAddContact,
}: {
  connection: NetworkStatus | null;
  compact?: boolean;
  onAddContact?: () => void;
}) {
  const [available, setAvailable] = useState(false),
    [contacts, setContacts] = useState<ContactView[]>([]);
  const [selected, setSelected] = useState(""),
    [history, setHistory] = useState<MessageView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [sending, setSending] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [pollError, setPollError] = useState(false);
  const current = useRef(selected);
  current.current = selected;
  const log = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  useEffect(() => {
    if (connection?.state !== "online") {
      setAvailable(false);
      setContacts([]);
      setHistory([]);
      setSelected("");
      setPollError(false);
      return;
    }
    let active = true,
      busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const summary = await window.companion.messaging();
        if (!active) return;
        setPollError(false);
        setAvailable(summary.available);
        setContacts(summary.contacts);
        const next = summary.contacts.some(
          (contact) => contact.peerId === selected,
        )
          ? selected
          : (summary.contacts[0]?.peerId ?? "");
        if (next !== selected) {
          follow.current = true;
          setSelected(next);
          setHistory([]);
        } else if (next) {
          const messages = await window.companion.messages(next);
          if (active) setHistory(messages);
        } else setHistory([]);
      } catch {
        if (active) {
          setHistory([]);
          setPollError(true);
        }
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [connection?.state, selected]);
  const last = history.at(-1)?.localId;
  useEffect(() => {
    if (last && follow.current && log.current)
      log.current.scrollTop = log.current.scrollHeight;
  }, [last]);
  const draft = drafts[selected] ?? "",
    bytes = new TextEncoder().encode(draft).length;
  const discovered =
    contacts.find((contact) => contact.peerId === selected)?.discovered ===
    true;
  async function send(event: FormEvent) {
    event.preventDefault();
    if (
      !selected ||
      !discovered ||
      !draft.trim() ||
      bytes > 4096 ||
      sending.includes(selected)
    )
      return;
    const peerId = selected,
      text = draft;
    setSending((previous) => [...previous, peerId]);
    setNotice("");
    follow.current = true;
    try {
      await window.companion.sendText(peerId, text);
      setDrafts((previous) =>
        previous[peerId] === text ? { ...previous, [peerId]: "" } : previous,
      );
    } catch {
      if (current.current === peerId)
        setNotice(
          "Delivery was not confirmed. Sending again could create a duplicate.",
        );
    } finally {
      setSending((previous) => previous.filter((id) => id !== peerId));
      if (current.current === peerId) {
        try {
          const messages = await window.companion.messages(peerId);
          if (current.current === peerId) setHistory(messages);
        } catch {
          if (current.current === peerId) setHistory([]);
        }
      }
    }
  }
  async function clear() {
    const peerId = selected;
    try {
      await window.companion.clearMessages(peerId);
      if (current.current === peerId) {
        setHistory([]);
        setNotice("Local conversation cleared.");
      }
    } catch {
      setNotice("Could not clear the conversation.");
    }
  }
  return (
    <section id="messagesPanel" className="panel">
      <h2>Messages</h2>
      {!compact && (
        <p className="hint">
          Only locally approved app contacts can exchange messages. Messages
          stay in memory for up to 15 minutes and are cleared when you
          disconnect. No offline delivery.
        </p>
      )}
      {connection?.state !== "online" ? (
        <p className="empty">Enable peer discovery to use messages.</p>
      ) : !available ? (
        <p className="empty">Messages are unavailable for this connection.</p>
      ) : !contacts.length ? (
        <div className="empty">
          <p>
            No approved contacts yet. Exchange and review contact codes in
            Preferences.
          </p>
          {onAddContact && (
            <button
              id="addContactFromMessages"
              type="button"
              onClick={onAddContact}
            >
              Add a contact
            </button>
          )}
        </div>
      ) : (
        <>
          <label htmlFor="contactSelect">Conversation</label>
          <select
            id="contactSelect"
            value={selected}
            onChange={(event) => {
              follow.current = true;
              setSelected(event.target.value);
              setHistory([]);
              setNotice("");
            }}
          >
            {contacts.map((contact) => (
              <option key={contact.peerId} value={contact.peerId}>
                App contact {contact.peerId.slice(0, 12)} ·{" "}
                {contact.discovered ? "Discovered" : "Not discovered"}
              </option>
            ))}
          </select>
          <div
            id="messageHistory"
            ref={log}
            className="message-history"
            onScroll={() => {
              const element = log.current;
              if (element)
                follow.current =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  40;
            }}
          >
            {!history.length && (
              <p className="hint">No messages in this connection.</p>
            )}
            {history.map((message) => (
              <article
                key={message.localId}
                className={`message ${message.direction}`}
                data-status={message.status}
              >
                <div className="message-meta">
                  <strong>
                    {message.direction === "outgoing" ? "You" : "Contact"}
                  </strong>
                  <time>
                    {new Date(message.at).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <p>{message.text}</p>
                <span className="message-status">
                  {message.status === "acknowledged"
                    ? "Accepted by peer app"
                    : message.status === "sending"
                      ? "Sending…"
                      : message.status === "unconfirmed"
                        ? "Delivery unconfirmed"
                        : "Received"}
                </span>
              </article>
            ))}
          </div>
          <form
            onSubmit={(event) => {
              void send(event);
            }}
          >
            <label htmlFor="messageDraft">Message</label>
            <textarea
              id="messageDraft"
              rows={compact ? 2 : 3}
              maxLength={4096}
              value={draft}
              onChange={(event) => {
                setDrafts((previous) => ({
                  ...previous,
                  [selected]: event.target.value,
                }));
                setNotice("");
              }}
            />
            <div className="message-actions">
              <button
                id="sendMessage"
                type="submit"
                disabled={
                  !selected ||
                  !discovered ||
                  !draft.trim() ||
                  bytes > 4096 ||
                  sending.includes(selected)
                }
              >
                {sending.includes(selected) ? "Sending…" : "Send"}
              </button>
              <button
                id="clearMessages"
                type="button"
                className="secondary"
                disabled={!history.length || sending.includes(selected)}
                onClick={() => {
                  void clear();
                }}
              >
                Clear local conversation
              </button>
              <span className="hint">{bytes}/4096 bytes</span>
            </div>
            {!discovered && (
              <p className="hint">
                This saved contact has not been discovered. Your draft will stay
                here while you wait.
              </p>
            )}
          </form>
        </>
      )}
      <output id="messageNotice" className="notice" aria-live="polite">
        {notice ||
          (pollError
            ? "Conversation unavailable. Check network and contact permissions."
            : "")}
      </output>
    </section>
  );
}
