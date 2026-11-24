# Changelog

All notable changes to **Lumina Photo · 光影本地相册** will be documented in this file.

## [1.2.0] - 2026-11-23

### Security
- **Full `allowedLibraryIds` Isolation**: Enforced scoped library authorization across people mutations (`/api/people/:id`, `/api/people/merge`, `/api/people/recluster`, `/api/faces/:faceId/reassign`), virtual albums (`PATCH`/`DELETE`, `coverMediaId`, `DELETE /api/albums/:id/media`), tags, smart albums, folder album covers, system info/SSE events, and AI status/semantic search.
- **Session Expiration & Server-Side Revocation**: Added 30-day token expiration (`exp`) and SQLite-backed `revoked_sessions` revocation on logout; automatically sets cookie `Secure` behind HTTPS/trusted proxies.
- **Reverse Proxy Hardening**: Added `LUMINA_TRUST_PROXY` (`trustProxy`) so `X-Forwarded-Host` and `X-Forwarded-For` / `X-Real-IP` are only trusted from loopback or explicitly trusted proxies, preventing remote CSRF Origin spoofing and shared rate-limit bucket lockouts.
- **Backup & Upload Safety**: Stripped user credentials (`users`), active `shares`, `revoked_sessions`, and passcode/secret settings from exported backup snapshots; added 64 MiB central directory and 2 GiB decompressed byte caps against Zip Bomb/OOM attacks; added atomic temp-file archive writes; capped chunked upload size (16 GiB) and total chunks (4096) with `readdir`-based resume inspection.
- **Private Media Caching & Safe QR Rendering**: Switched authenticated thumbnail, preview, and face thumbnail responses from `Cache-Control: public` to `private`; replaced `dangerouslySetInnerHTML` QR SVG injection with `<img>` `data:image/svg+xml` URLs.

### Added
- **Volume Identity & Storage Resilience**: Added macOS (`VolumeUUID`/devfs) and Linux (`mnt_id`/`diskseq`/`f_fsid`) removable-volume identity tracking (`libraryRoots.ts`), cross-volume `EXDEV` rollback-safe file transfers, offline mount protection, and atomic staging builds (`scripts/build.mjs`).
- **Family Member Inline Editor**: Added in-place editing of family member display names, roles, passwords, and allowed library scopes inside `AdminAuthModal`.
- **Lightbox Resilience & Transcode Seek**: Added image/video/Live Photo load-failure fallbacks with retry controls and a seek progress slider (`startSec`) for fMP4 transcoded video streams.
- **Frontend Architecture & Resilience**: Added React `ErrorBoundary` wrapping the app shell, main workspace views, Lightbox, and Public Share view; extracted `useLibraryRealtime`, `useNavHistory`, `buildContextMenu`, `FolderAlbumHeader`, and `permissions` out of `App.tsx`.
- **Testing, CI & Repo Hygiene**: Added backend regression suites (`repair.test.ts`, `audit_v3.test.ts`), frontend unit tests (`web/tests/frontend.test.ts`), root `typecheck`/`test:server`/`test:web` scripts, GitHub Actions CI (`.github/workflows/ci.yml`), `.editorconfig`, and `.prettierrc.json`.

### Fixed
- **Passcode Change Self-Lockout**: Fixed `POST /api/auth/passcode` returning stale `authenticated: false` when updating the admin passcode or enabling `requireOnLoopback`.
- **AI Pipeline Compatibility**: Fixed missing shard subdirectory in `lgThumb` lookup; routed HEIC/RAW photos through unified `decodeToSharpSource`; forced `.toColourspace('srgb')` for grayscale images in face/CLIP engines; deferred offline-volume photos instead of permanently marking them complete.
- **Image, Video, Export & Geocoder Fixes**: Prevented single corrupt HEIC files from poisoning global Sharp HEIC support; made `generateFaceThumb` single-pass, bounds-safe, concurrency-deduped, and atomic; fixed odd-width video hover preview encoding (`libx264`/`yuv420p`) with LRU cache pruning; eliminated transcode concurrency slot TOCTOU race and added explicit stream mapping + even-dimension padding; canonicalized symlinked library roots; added disconnect cancellation and `_export_warnings.txt` reporting to streaming ZIP exports; fixed high-latitude bounding-box pre-filter in offline reverse geocoding.
- **Frontend & PWA Fixes**: Unified `isGlobalAdmin` / `canShareAlbum` permission gating across all components; fixed `DuplicatesView` React key collisions; added async error handling across modals; upgraded Service Worker (`lumina-shell-v2`) to cache only HTTP 200 navigations, return safe offline responses, and bound `/assets/` cache size.

### Performance
- **100k-Scale Optimizations**: Added short TTL caching for Linux non-block mounts (`SMB`/`NFS`/`FUSE`/`tmpfs`) to avoid synchronous `stat` event-loop stalls; throttled AI SSE status broadcasts to 600ms; introduced incremental in-memory `FaceCentroidCache` clustering; paginated pending thumbnail generation and cursor-based `phash` / offline-geocode backfills; restricted `VirtualTimeline` `Shift+Click` to fetch only the closed range of months between anchor and target and smoothed intermediate page seam rows and year scrubber markers.

## [1.1.0] - Initial Tagged Release
- Local privacy photo/video album for 100k+ media with SQLite FTS5, offline AI (OCR, Human WASM face clustering, SigLIP2 semantic search), folder-backed and virtual albums, family roles, resumable chunked uploads, LAN/Tailscale sharing, and metadata backup/restore.
