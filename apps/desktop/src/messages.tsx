import { type FormEvent, useEffect, useRef, useState } from "react";
import type { NetworkStatus } from "../../../packages/app-dht/src/lifecycle.js";
import { unconfirmedLabel } from "../../../packages/protocol/src/delivery.js";
import type { ContactView, MessageView } from "./messaging.js";
import { VoiceControls } from "./voice-controls.js";

export function Messages({
  connection,
  compact = false,
  onAddContact,
  active = true,
  onMicrophone,
  onBlockContact,
  contactPending = false,
}: {
  connection: NetworkStatus | null;
  compact?: boolean;
  onAddContact?: () => void;
  active?: boolean;
  onMicrophone?: (value: "off" | "capturing" | "unknown") => void;
  onBlockContact?: (peerId: string) => Promise<boolean>;
  contactPending?: boolean;
}) {
  const [available, setAvailable] = useState(false),
    [contacts, setContacts] = useState<ContactView[]>([]);
  const [selected, setSelected] = useState(""),
    [history, setHistory] = useState<MessageView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({}),
    [sending, setSending] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [pollError, setPollError] = useState(false);
  const [blocking, setBlocking] = useState(false);
  const [canceling, setCanceling] = useState<string[]>([]);
  const cancellations = useRef(new Set<string>()),
    noticeRevision = useRef(0);
  const [clearing, setClearing] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchPending = useRef(false);
  const clearPending = useRef(false),
    historyRevision = useRef(0);
  const current = useRef(selected);
  current.current = selected;
  const log = useRef<HTMLElement>(null),
    follow = useRef(true);
  const [following, setFollowing] = useState(true);
  useEffect(() => {
    follow.current = true;
    setFollowing(true);
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
      const revision = historyRevision.current;
      try {
        const summary = await window.companion.messaging();
        if (!active || current.current !== selected) return;
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
          if (
            active &&
            current.current === next &&
            revision === historyRevision.current &&
            !clearPending.current
          )
            setHistory(messages);
        } else setHistory([]);
      } catch {
        if (
          active &&
          revision === historyRevision.current &&
          !clearPending.current
        ) {
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
    if (!last) {
      follow.current = true;
      setFollowing(true);
    }
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
      !draft.trim() ||
      bytes > 4096 ||
      sending.includes(selected) ||
      clearPending.current
    )
      return;
    const peerId = selected,
      text = draft;
    const revision = historyRevision.current;
    const notice = ++noticeRevision.current;
    setSending((previous) => [...previous, peerId]);
    setNotice("");
    follow.current = true;
    try {
      await window.companion.sendText(peerId, text);
      if (revision === historyRevision.current)
        setDrafts((previous) =>
          previous[peerId] === text ? { ...previous, [peerId]: "" } : previous,
        );
    } catch {
      if (
        current.current === peerId &&
        revision === historyRevision.current &&
        notice === noticeRevision.current
      )
        setNotice(
          "Delivery was not confirmed. Sending again could create a duplicate.",
        );
    } finally {
      setSending((previous) => previous.filter((id) => id !== peerId));
      if (
        current.current === peerId &&
        revision === historyRevision.current &&
        !clearPending.current
      ) {
        try {
          const messages = await window.companion.messages(peerId);
          if (
            current.current === peerId &&
            revision === historyRevision.current &&
            !clearPending.current
          )
            setHistory(messages);
        } catch {
          if (
            current.current === peerId &&
            revision === historyRevision.current
          )
            setHistory([]);
        }
      }
    }
  }
  async function clear() {
    const peerId = selected;
    if (!peerId || clearPending.current) return;
    clearPending.current = true;
    historyRevision.current++;
    setClearing(true);
    try {
      await window.companion.clearMessages(peerId);
      if (current.current === peerId) {
        setHistory([]);
        setNotice(
          "Local conversation cleared. This does not delete the other person's copy.",
        );
      }
    } catch {
      if (current.current === peerId)
        setNotice("Could not clear the conversation.");
    } finally {
      historyRevision.current++;
      clearPending.current = false;
      setClearing(false);
    }
  }
  async function cancel(message: MessageView) {
    const { peerId, localId } = message;
    if (
      cancellations.current.has(localId) ||
      clearPending.current ||
      current.current !== peerId
    )
      return;
    cancellations.current.add(localId);
    setCanceling((previous) => [...previous, localId]);
    const revision = historyRevision.current,
      notice = ++noticeRevision.current;
    try {
      const result = await window.companion.cancelMessage({ peerId, localId });
      if (
        current.current === peerId &&
        revision === historyRevision.current &&
        notice === noticeRevision.current
      )
        setNotice(
          result.canceled
            ? "Cancellation requested. The peer may already have received this message."
            : "The send has already finished. Check its delivery status.",
        );
    } catch {
      if (
        current.current === peerId &&
        revision === historyRevision.current &&
        notice === noticeRevision.current
      )
        setNotice(
          "Could not confirm cancellation. Check the delivery status before sending again.",
        );
    } finally {
      cancellations.current.delete(localId);
      setCanceling((previous) => previous.filter((id) => id !== localId));
    }
  }
  async function blockSelected() {
    const peerId = current.current;
    if (!peerId || !onBlockContact || blocking || contactPending) return;
    setBlocking(true);
    current.current = "";
    setSelected("");
    setContacts((previous) =>
      previous.filter((contact) => contact.peerId !== peerId),
    );
    setHistory([]);
    setDrafts((previous) => {
      const next = { ...previous };
      delete next[peerId];
      return next;
    });
    setNotice("Blocking selected app contact…");
    try {
      const saved = await onBlockContact(peerId);
      setNotice(
        saved
          ? "Contact blocked on this device. Its local conversation was cleared. Manage blocks in Preferences."
          : "Block could not be confirmed. Disconnect in Overview to stop communication, then review contact permissions.",
      );
    } catch {
      setNotice(
        "Block could not be confirmed. Disconnect in Overview to stop communication, then review contact permissions.",
      );
    } finally {
      setBlocking(false);
    }
  }
  async function findContact() {
    const peerId = current.current;
    if (!peerId || searchPending.current || connection?.state !== "online")
      return;
    searchPending.current = true;
    setSearching(true);
    const revision = historyRevision.current,
      notice = ++noticeRevision.current;
    setNotice("Looking for this approved app contact…");
    try {
      const result = await window.companion.rediscoverContact(peerId);
      if (
        current.current === peerId &&
        revision === historyRevision.current &&
        notice === noticeRevision.current
      )
        setNotice(
          result.state === "found"
            ? "Verified connection details found for this approved app contact. Reachability and the peer's permissions still apply."
            : result.state === "not-located"
              ? "Contact not located in this attempt. They may be offline or unreachable."
              : "Contact search was incomplete. You can try again later.",
        );
    } catch {
      if (
        current.current === peerId &&
        revision === historyRevision.current &&
        notice === noticeRevision.current
      )
        setNotice(
          "Contact search stopped, is already running, or was requested too recently. Wait a few seconds and check connection and contact permissions before trying again.",
        );
    } finally {
      searchPending.current = false;
      setSearching(false);
    }
  }
  return (
    <section id="messagesPanel" className="panel">
      <h2>Messages</h2>
      {!compact && (
        <VoiceControls
          {...(onMicrophone ? { onMicrophone } : {})}
          peerId={selected}
          discovered={discovered}
          online={connection?.state === "online"}
          active={active}
        />
      )}
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
                {contact.discovered
                  ? "Connection details known"
                  : "Waiting for discovery"}
              </option>
            ))}
          </select>
          <div className="message-actions">
            <button
              id="findContact"
              type="button"
              className="secondary"
              disabled={!selected || searching || contactPending || blocking}
              onClick={() => void findContact()}
            >
              {searching ? "Looking for contact…" : "Find contact"}
            </button>
            <span className="hint">
              Look for current connection details for this approved app contact.
            </span>
          </div>
          {!compact && onBlockContact && (
            <div className="message-actions">
              <button
                id="blockConversationContact"
                type="button"
                className="secondary"
                disabled={!selected || contactPending || blocking}
                onClick={() => {
                  void blockSelected();
                }}
              >
                Block selected contact
              </button>
              <span className="hint">
                Stops this app contact's messages and calls, and clears its
                local conversation. Other contacts stay connected.
              </span>
            </div>
          )}
          <section
            id="messageHistory"
            ref={log}
            className="message-history"
            aria-label="Conversation messages"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Labelled scrollable history needs keyboard scrolling and a focus destination after Jump to latest.
            tabIndex={0}
            onScroll={() => {
              const element = log.current;
              if (element) {
                const latest =
                  element.scrollHeight -
                    element.scrollTop -
                    element.clientHeight <
                  40;
                follow.current = latest;
                setFollowing(latest);
              }
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
                        ? unconfirmedLabel(message.failure)
                        : "Received"}
                </span>
                {message.direction === "outgoing" &&
                  message.status === "sending" && (
                    <button
                      type="button"
                      className="secondary message-cancel"
                      aria-describedby="messageCancelHint"
                      data-cancel-send={message.localId}
                      disabled={canceling.includes(message.localId) || clearing}
                      onClick={() => void cancel(message)}
                    >
                      {canceling.includes(message.localId)
                        ? "Stopping…"
                        : "Stop send"}
                    </button>
                  )}
              </article>
            ))}
          </section>
          {!!history.length && !following && (
            <button
              id="jumpToLatest"
              type="button"
              className="secondary"
              aria-controls="messageHistory"
              onClick={() => {
                const element = log.current;
                follow.current = true;
                setFollowing(true);
                if (element) {
                  element.scrollTop = element.scrollHeight;
                  element.focus({ preventScroll: true });
                }
              }}
            >
              Jump to latest
            </button>
          )}
          {history.some(
            (message) =>
              message.direction === "outgoing" && message.status === "sending",
          ) && (
            <p id="messageCancelHint" className="hint">
              Stopping a send stops local waiting and retries. The peer may
              already have the message.
            </p>
          )}
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
                  !draft.trim() ||
                  bytes > 4096 ||
                  sending.includes(selected) ||
                  clearing
                }
              >
                {sending.includes(selected) ? "Sending…" : "Send"}
              </button>
              <button
                id="clearMessages"
                type="button"
                className="secondary"
                disabled={!history.length || clearing}
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
                This contact's connection details are not known yet. Your draft
                stays here if delivery is not confirmed. Sending first looks for
                this approved contact.
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
