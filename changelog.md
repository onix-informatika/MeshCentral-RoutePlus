# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Known Issues]
- None. Please feel free to submit an issue via [GitHub](https://github.com/onix-informatika/MeshCentral-RoutePlus) if you find anything.

## [0.1.8.10] - 2026-05-12
### Fixed
- Force-rebuild source-agent routes after repeated pre-active tunnel failures or tunnel setup timeouts, and destroy tracked client sockets before recreating the listener. This clears MeshAgent accept queues that get stuck with MSSQL pre-login sockets in `CLOSE-WAIT`.

## [0.1.8.9] - 2026-05-12
### Fixed
- Add a tunnel setup timeout that closes not-yet-active client sockets and triggers the existing health/restart path instead of leaving paused SQL pre-login sockets stuck in `CLOSE-WAIT`.
- Buffer early client bytes while the MeshCentral relay is being established, then flush them once the tunnel is active. This avoids leaving MSSQL pre-login data paused in the source-agent socket when relay setup stalls.

## [0.1.8.8] - 2026-05-11
### Fixed
- Match MeshCentral Router's tunnel framing by stripping the relay data-type byte before forwarding bytes to the mapped TCP target. This prevents framed relay bytes from corrupting MSSQL pre-login handshakes on RoutePlus tunnels.

## [0.1.8.7] - 2026-05-11
### Fixed
- Use an absolute future relay expiration timestamp instead of `expire: 0`, which MeshCentral's relay layer treats as already expired.
- Refresh online source-agent route auth every 30 minutes so long-lived listeners do not keep using stale relay cookies.

## [0.1.8.6] - 2026-05-11
### Fixed
- Use explicit MeshCentral route auth cookies for long-lived RoutePlus service tunnels so mapped ports do not soft-disconnect after the default one-hour websocket auth window.
- Start persisted routes when the source agent checks in, even when the web UI user session is not open.
- Refresh dependent routes when a mapped target agent checks in.
- Close local listeners and report a route error when MeshCentral knows the mapped target agent is offline, instead of leaving a local port open that cannot reach the remote service.
- Report unexpected MeshCentral HTTP responses from relay requests so expired or rejected relay auth is visible.

## [0.1.8.5] - 2026-05-11
### Fixed
- Store MeshCentral relay auth per route instead of using one global auth cookie across all active mappings.
- Refresh active route settings when MeshCentral sends a rebuild command for an already-listening mapping.
- Enable TCP keepalive and `NoDelay` for local and relay sockets used by long-running SQL tunnels.
- Probe the mapped target port after failed tunnel handshakes and recreate the RoutePlus listener only when the target-port probe fails.
- Count TCP/websocket tunnel cleanup once so normal MSSQL client disconnects do not trigger route recreation.

## [0.1.8.4] - 2026-03-19
### Fixed
- Stop relying on the agent's `mesh.ServerUrl` for RoutePlus relay setup; the server now sends an explicit `meshrelay.ashx` URL so source-agent tunnels build a valid relay destination.

## [0.1.8.3] - 2026-03-19
### Fixed
- Report agent-side relay startup errors back to the UI instead of silently closing the local tunnel.
- Auto-remove failed duplicate forced-port mappings when an existing RoutePlus mapping already owns the same source port.
- Normalize blank source ports to `0` to avoid `NaN` leaking into saved mappings.

## [0.1.8.2] - 2026-03-19
### Fixed
- Reject duplicate forced source ports before creating dead mappings.
- Clean up stale RoutePlus mappings that point to deleted devices.
- Show clear UI errors when a forced source port is unavailable.
- Prevent the RoutePlus page from breaking when a saved mapping references a missing device.

## [0.1.8-onix.1] - 2026-02-19
### Fixed
- Route tunnel cleanup and stability improvements for repeated MSSQL forwarding (fork build).
- Fork metadata now points to `onix-informatika/MeshCentral-RoutePlus`.

## [0.1.7] - 2025-03-03
### Fixed
- Merge PR fixing potential MeshCentral ping control channel interference issues (PR#22; thanks Daniel)

## [0.1.6] - 2025-01-14
### Fixed
- Merge PR fixing MeshCentral 1.1.35+ compatibility

## [0.1.5] - 2022-03-12
### Fixed
- Compatibility with MeshCentral => 0.9.98 (promise requirement removed from MeshCentral, nedb moved to @yetzt/nedb)

## [0.1.4] - 2021-10-07
### Fixed
- Compatibility with MeshCentral > 0.9.7

## [0.1.3] - 2020-04-21
### Fixed
- RDP file download issue in FireFox for some OS's would show "Server Disconnected"
- Make "RoutePlus RDP" link on devices add/remove on current device without refreshing the page or switching devices first

## [0.1.2] - 2020-04-08
### Fixed
- Changed display so that computer list and mappings do not overlap on smaller resolutions

## [0.1.1] - 2020-04-08
### Added
- Added destination IP (target IP) for accessing remote node network

## [0.1.0] - 2020-04-08
### Added
- Ability to set a static source port. If the chosen port is unavailable (e.g. in use), the mapping will be disabled until it is free and the map is reinstantiated.
### Fixed
- Added rPi icon option (was previously displaying blank)
- Stability fixes for keeping the same randomly generated port. This should reduce the number of times the port is changed for some users.

## [0.0.7] - 2020-04-05
### Fixed
- Remove unused call for mesh name that broke support for the new "Individual Device Permissions" users

## [0.0.6] - 2020-03-07
### Fixed
- Prevent race condition with conflicting plugins changing the app views directory by using absolute paths

## [0.0.5] - 2020-01-08
### Fix
- Cleanup console messages for currentNode not yet avail

## [0.0.4] - 2020-01-03
### Fix
- Fix so that adding / removing multiple plugins only yields one RoutePlus settings link

## [0.0.3] - 2019-12-31
### Added
- Option to add an RDP link to the device landing page. Applies to RDP and Custom protocols. If checked, will add a link to download an RDP file.

## [0.0.2] - 2019-12-29
### Fixed
- Better integrated route selection settings into MeshCentral interface (no more popout)

## [0.0.1] - 2019-12-26
### Added
- Released initial version
