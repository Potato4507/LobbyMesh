import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (!root) throw new Error("MISSING_ROOT");
createRoot(root).render(
  <main>
    <h1>Companion</h1>
    <p>Development preview · Offline</p>
    <h2>Roblox session unavailable</h2>
    <p>
      A supported automatic session provider has not been verified. No session
      identifiers are requested.
    </p>
    <p>
      Microphone off. No capture or network activity starts in this preview.
    </p>
    <h2>Your privacy</h2>
    <p>
      Participation will require consent. Peer connections reveal network
      addresses to connected peers. Direct connectivity is not guaranteed.
    </p>
  </main>,
);
