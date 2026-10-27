# Test matrix

[x] executed, [ ] unexecuted. Tests use synthetic identities and sessions only.

| Area | Unit | Simulation | 2-process | Cross-machine | External API | Security | Release |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Protocol | [x] version / IPC argument rejection | [ ] | [ ] | [ ] | [ ] | [x] malformed version | [ ] |
| Identity | [x] signing, persistence/reset, corrupt storage, wrong key | [ ] | [ ] | [ ] | [ ] | [x] POSIX permissions and tamper | [ ] |
| Record primitive | [x] key/domain signature, expiry, quotas, replay | [ ] | [ ] | [ ] | [ ] | [x] oversized / forged | [ ] |
| Session mock | [x] changes, unsubscribe, copy, provenance | [ ] | [ ] | [ ] | [ ] production provider | [x] refuses verified provenance | [ ] |
| Roster | [x] 0/2/30/100, duplicate names, join/leave | [ ] | [ ] | [ ] | [ ] Roblox roster | [x] whitelist, block, quota | [ ] |
| Simulator | [x] clock only | [ ] network/churn | [ ] | [ ] | [ ] | [ ] | [ ] |
| Desktop | [ ] components | [ ] | [ ] | [ ] | [ ] | [ ] runtime IPC / sandbox | [ ] launch |
| Public discovery | [x] fake, dedup, quota/rate, cleanup, timeout, installed key persistence | [x] two fake adapters | [ ] | [ ] | [ ] success; smoke timed out | [x] malformed key rejection | [ ] |
| Entrypoint search | [x] four-concurrent cap, deadline, auth/version filtering, error states | [x] unreachable/incompatible/stalled | [ ] | [ ] | [ ] | [x] rejects unauthenticated | [ ] |
| Local overlay | [x] XOR order, bucket cap, signed store, expiry, restart | [x] fake announcement only | [ ] | [ ] | [ ] | [x] forged record rejection | [ ] |
| Multi-node overlay / text / voice | [ ] | [ ] | [ ] | [ ] NAT/audio | [ ] | [ ] | [ ] |

Do not infer internet/NAT, audio, Roblox integration, Windows support or release readiness from these tests.
