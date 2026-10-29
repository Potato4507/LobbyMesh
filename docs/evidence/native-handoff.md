# Native handoff isolation — 2026-10-28

/goal: isolate the locally established-but-silent stream observed in app RPC without changing production transport behavior.

/steps: `scripts/native-handoff.mjs` runs one local bootstrap and two independent Node workers. Each worker listens on an ephemeral transport identity and echoes only fixed nonsecret bytes. There is no app RPC, application identity, discovery topic, profile, renderer, user message or public bootstrap. Transport keys cross only owned-process IPC and are absent from the output. Each worker serializes its own eight attempts. The driver first runs each direction alone (16 attempts total), then both directions concurrently (16 total). Each attempt has a1500ms timeout; tracked streams have3000ms cleanup and the parent has a90000ms total process deadline. All owned processes must exit0 with zero active streams on normal completion. No dependency files, firewall rules or production settings are edited.

Environment verified live: Windows, Node24.22.1, pnpm11.25.0, hyperdht6.35.0, @hyperswarm/secret-stream6.9.2. The client-side `reply` phase means the native local connect event fired, not that the receiver accepted the stream or received bytes. This command is an observation, not an all-success regression test; a zero exit means bounded observations and cleanup checks completed.

| Experiment | One direction at a time | Bidirectional | Receiver admissions |
| --- | --- | --- | --- |
| Native defaults | 16/16 success | 15/16 success;1 timeout | 15 /16 |
| `--reusable-socket` | 16/16 success | 15/16 success;1 timeout | 15 /16 |
| `--no-lan` | 0/16 success | 0/16 success | 0 /0 |
| `--fully-bootstrapped` | 16/16 success | 15/16 success;1 timeout | 15 /16 |

Default raw trace: native-handoff-default.json. The retained final default timeout was1512ms after local establishment; neither server saw an invalid payload and both were idle after the trials. A preceding default run independently showed the same31/32 pattern. `--no-lan` produced28 timeouts and4 transport errors, all without server admission. The fully bootstrapped trace is native-handoff-bootstrapped.json; it still shows one missing incoming admission. Each variant exited0/zero owned streams. These small local samples do not establish failure probability, WAN behavior, or that the same underlying bug explains every app timeout.

Commands (explicit, outside the default test suite):

```powershell
pnpm diagnose:handoff
pnpm diagnose:handoff --reusable-socket
pnpm diagnose:handoff --no-lan
pnpm diagnose:handoff --fully-bootstrapped
```

The native library alone reproduces the symptom; app framing, Ed25519 authentication and NetworkOverlay scheduling are not required for this reproduction. Keep app authentication, existing bounded pre-dispatch retry and conservative production scheduling. The alternative options tested here do not resolve this local fixture. No all-clear or code-level root cause is claimed.

Read-only upstream lookup through the connected GitHub tool found [HyperDHT issue304](https://github.com/holepunchto/hyperdht/issues/304), open when fetched on2026-10-28. It reports a similar client-established/server-absent LAN race on earlier versions. A [follow-up comment](https://github.com/holepunchto/hyperdht/issues/304#issuecomment-6046682074) proposes server-side handshake abort as its cause and reports that waiting for full bootstrap helped its separate Linux fixture. Our Windows6.35.0 experiment does not confirm that workaround. These are related upstream reports, not proof that our exact path shares their cause. No issue/comment was posted, upstream reproduction executed or dependency modified.

/proof: all four local experiments completed with cleanup checks. Retained final JSON includes cleanupVerified=true. Typecheck and final lint138 files pass. Source/application regression remains122/122 plus the later native overlay/credential smoke. No fresh physical mic, game, cross-NAT or packaged-pair acceptance was performed.

/next: inspect the pinned native server's same-host handshake/abort path against the reports; prefer a minimal trusted diagnostic counter or controlled package comparison over speculative production retries or weaker authentication. Keep any comparison dependencies isolated from the repository lockfile and deployed artifact.
