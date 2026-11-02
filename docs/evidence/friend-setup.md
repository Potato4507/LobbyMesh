# Private Windows friend setup

Final clean installer source: `99457cf33b6919e06a07f58e234fffc1861fe925`.
Delivery: `dist/friend-setup-1793588129133-310a05ff/delivery/LobbyMesh-Setup.exe`
(171,443,455 bytes). SHA256:
`fc3a3c3787d888226bcbed294825e4633870b2c740b1479d741a771cd1997acb`.
`friend-final-setup.json` records actual installed-payload verification, installed
executable launch and preservation-aware uninstall. `friend-final-registration.json`
independently verifies this final executable's normal per-user Start-menu and
Installed-apps registration, then restoration of all pre-test absences.
`realShortcutsTested:false` in the isolated build summary describes that isolated
build stage only; the separate normal-registration test passed afterward.
The final setup and application runtime are both from clean committed source.
The executable is NotSigned. Forward the single setup file; the user instructions
are also embedded in the installation and supplied alongside the executable.
The installer-source GitHub verify job succeeded: frozen install, Pi shell syntax,
typecheck, lint, full Node tests and build. See `friend-installer-ci.json`.

Implemented `pnpm package:friend`: a single per-user Windows x64 setup executable,
Start-menu entry and Windows Installed-apps uninstaller. The recipient needs no
developer tools. First use still requires a display name, peer-discovery consent
and mutual contact-code approval. Voice remains optional and starts muted.

The builder refuses dirty source by default, checks that the application source
still matches the retained clean Windows package, verifies every payload file and
the pinned manifest, and compiles with a checksum-pinned portable NSIS toolchain.
It then actually installs into an exclusive temporary directory, verifies installed
bytes, runs the installed executable with an isolated profile, and uninstalls.
It checks that every known payload file is gone while unrelated files and the
isolated profile survive. No administrative privileges or real app profile are used.

NSIS 3.13 archive and compiler hashes are recorded in each build summary. The
[official download page](https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13.zip/download)
publishes the archive digest; the full compiler license notices accompany setup.
The initial solid-LZMA build exceeded its 180-second compile deadline; its scratch
files are retained. Zlib compilation and the development install smoke succeeded.

Development setup SHA256:
`645809b88da46dedac0a2195e5135f8a8e82ebb59c945e37e35c05fcda9c951b`.
Its actual normal per-user registration was also tested, starting with no existing
installation, shortcut or uninstall key. The Start-menu target and quoted uninstall
command matched; uninstall restored all three initial absences. See
`friend-development-registration.json`. This test did not launch the app or touch
the real profile. A later source revision adds a running-app guard to uninstall;
final clean setup evidence is recorded separately after compilation.

Verification: full Node suite 266 total, 265 passed, one POSIX-only skip; typecheck
and lint pass. Focused installer tests pass after the final welcome/uninstall text
change. Existing application runtime `95d1072` retains its complete ten-stage
Windows verification in `windows-lan-repair-complete-summary.json`.

Additional retained measurements:

- `friend-public-pair.json`: two independent SAME_HOST processes authenticate and
  read a signed record through public bootstrap. Not a cross-network test.
- `native-bilateral-reuse.json`: diagnostic flag now enables reuse on both server
  and client and asserts actual server state. 32/32 native exchanges passed with
  zero active/invalid/aborted streams; cached routes remained zero. No production
  reuse setting changed or route-recovery benefit established.
- `pi-fresh-warm-udp.json`: prior physical LAN fresh/warm UDP probes succeeded in
  both directions within 1500 ms. This does not repair or prove native application
  delivery; the separately recorded Windows/Pi application failure remains open.

Latest pre-installer CI at `e7e3c48`, run 41225156808, succeeded. The original
repository URL now redirects to Potato4507/LobbyMesh; existing Git origin and
development branch are preserved. No tests, security checks or deadlines weakened.

This is an **unsigned private preview**, not RELEASE_READY. Real external-network
delivery, fresh-friend-machine acceptance, hardware audio and actual Roblox use
remain unverified. Direct connectivity can fail on restrictive home networks.
