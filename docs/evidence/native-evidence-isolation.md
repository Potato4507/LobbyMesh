# Isolated native desktop evidence — 2026-10-30

Desktop smoke now provisions an exclusive per-run dist/desktop-evidence-PID-time directory and passes it to each existing native fixture. Screenshots remain there after completion/failure. Main/focused modes, profiles, assertions and30-second process bounds are unchanged. Explicit --update-evidence selects canonical docs/evidence output; malformed, duplicate or conflicting options reject before creating output or launching Electron.

The shared fixture path helper accepts only canonical lobbymesh PNG source names from docs/evidence and absolute output roots; all screenshots, including direct overlay captures and the final reported path, use it. Temporary profile cleanup remains separate and does not erase evidence. Normal checks no longer rewrite tracked screenshots, which allows a subsequent Windows package to retain sourceDirty false without restoring files.

Focused3/3 and full Node221/221, typecheck/lint206, full five-process native Windows suite pass. Negative CLI cases execute in a fresh empty working directory and leave it empty, independent of existing dist or parallel tests. Actual full native run dist/desktop-evidence-19516-1793376846276 contains13 PNGs, trackedEvidenceUpdated false; git status contains only owned source/test edits and no PNG changes. The explicit canonical path mapping is unit tested; canonical rewriting was not invoked during this acceptance.

This changes verification output ownership only. Existing synthetic voice/session/interaction proof boundaries remain; no physical audio, LAN/NAT or release claim. Additional hosted Windows work remains blocked on private-repository billing verification under the no-paid-infrastructure constraint; no extra hosted job was enabled.
