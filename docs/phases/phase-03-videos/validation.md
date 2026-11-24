---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 17
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-24T20:48:23-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-24T20:32:48-03:00"
issues:
  - id: AMB-1
    status: open
    summary: "Who may stream/download a video, and in which status, before Phase 04 publish?"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Message Queue Technology"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Video Worker Runtime & Container Topology"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Metadata & Thumbnail Extraction Tooling (FFmpeg/ffprobe)"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — How the Worker Reads the Source Video"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Upload Protocol for up to 10GB"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Upload Size Limits & Part Sizing"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Object Storage Layout (buckets, keys, presigning)"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Local S3-Compatible Storage Provisioning"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Unique Video URL Identifier"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Playback (Range/206) and Download Delivery Path"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Playback Format (original vs derived rendition)"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Video Status Lifecycle & Failure Handling"
  - id: OQ-13
    status: open
    summary: "TD-13 pending — Rate-Limit Policy for Video Endpoints"
  - id: OQ-14
    status: open
    summary: "TD-14 pending — Test Infrastructure for Storage, Queue and Worker"
  - id: OQ-15
    status: open
    summary: "TD-15 pending — Video Ownership Anchor (channel vs user)"
  - id: OQ-16
    status: open
    summary: "TD-16 pending — Presigned URL Host Reachability"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

- **AMB-1** — The bullets "Reprodução via streaming (sem necessidade de download completo)" and "Download do vídeo pelo usuário" do not say **who** may stream/download (anonymous visitor, any authenticated user, or only the owner) nor **in which video status** (a `draft`/processing video created by "Pré-cadastro automático do vídeo como rascunho" vs a ready one). Phase 03 creates drafts, while the neighbor Phase 04 ("Gerenciamento de Vídeos e Canal") plausibly owns publishing/visibility, so the access rule could fall on either side of the boundary. An implementer of the playback/download endpoints (TD-10) and of the status machine (TD-12) would have to ask. Explicit choice: state the Phase 03 access rule for playback/download, i.e. which actor (anonymous / authenticated / owner-only) and which statuses are servable, and whether publish/visibility gating is deferred to Phase 04. Record it in TD-10 and/or TD-12 (Note or Revision) when resolving.

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — TD-01 pending — Message Queue Technology. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-2** — TD-02 pending — Video Worker Runtime & Container Topology. Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-3** — TD-03 pending — Metadata & Thumbnail Extraction Tooling (FFmpeg/ffprobe). Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-4** — TD-04 pending — How the Worker Reads the Source Video. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-5** — TD-05 pending — Upload Protocol for up to 10GB Without Passing Through the API. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-6** — TD-06 pending — Upload Size Limits & Part Sizing (configurable, testable). Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-7** — TD-07 pending — Object Storage Layout — Buckets, Keys and Presigning. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-8** — TD-08 pending — Local S3-Compatible Storage Provisioning (MinIO). Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-9** — TD-09 pending — Unique Video URL Identifier. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-10** — TD-10 pending — Playback (Range/206) and Download Delivery Path. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-11** — TD-11 pending — Playback Format (original file vs derived rendition). Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-12** — TD-12 pending — Video Status Lifecycle & Failure Handling. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-13** — TD-13 pending — Rate-Limit Policy for Video Endpoints. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-14** — TD-14 pending — Test Infrastructure for Storage, Queue and Worker. Resolution: fill the **Decision:** field of TD-14 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-15** — TD-15 pending — Video Ownership Anchor (channel vs user). Resolution: fill the **Decision:** field of TD-15 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.
- **OQ-16** — TD-16 pending — Presigned URL Host Reachability (browser/host ↔ Compose network). Resolution: fill the **Decision:** field of TD-16 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run /plan-validate phase-03-videos.

### UI Coverage Gaps

_None._ _(UI Inventory is deferred, so Check 7 is skipped.)_

## Resolved Issues

_No issues resolved yet._
