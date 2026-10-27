import type {
  SessionIdentity,
  SessionProvider,
} from "../../protocol/src/index.js";
// Test-only: never promoted to a production provider.
export class MockSessionProvider implements SessionProvider {
  private session: SessionIdentity | null = null;
  private handlers = new Set<(session: SessionIdentity | null) => void>();
  async current(): Promise<SessionIdentity | null> {
    return this.session ? { ...this.session } : null;
  }
  subscribe(handler: (session: SessionIdentity | null) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  set(session: SessionIdentity | null): void {
    if (
      session &&
      (session.evidenceSource !== "test" ||
        session.verification !== "mock" ||
        !session.jobId ||
        !session.placeId ||
        !session.universeId)
    )
      throw new Error("TEST_EVIDENCE_ONLY");
    this.session = session ? { ...session } : null;
    for (const handler of this.handlers)
      handler(this.session ? { ...this.session } : null);
  }
}
