# Synthetic-content provenance API

How Trellis reports whether content was made with AI, and what a client must do
with that report.

> **Read the rendering rules before you build the badge.** The API half of this is
> small; the part that carries legal weight is entirely on the client side. A
> client that renders the wrong thing for `UNKNOWN` invents a claim the platform
> never made.

## The object

Every post, comment, and media attachment carries a `provenance` object:

```json
{
  "sourceType": "AI_ASSISTED",
  "basis": "AUTHOR_DECLARED",
  "disclosureRequired": true,
  "labelKey": "provenance.ai_assisted",
  "labelDetailKey": "provenance.ai_assisted.detail"
}
```

| Field | Type | Meaning |
|---|---|---|
| `sourceType` | enum, see below | *What* the content is |
| `basis` | enum or `null` | *How the platform came to believe it*. `null` only when `sourceType` is `UNKNOWN` |
| `disclosureRequired` | boolean | Whether this content requires a disclosure to be shown |
| `labelKey` | string | i18n key for the badge text. **Never a sentence** — you own translation |
| `labelDetailKey` | string | i18n key for the accessible text equivalent |

### `sourceType`

| Value | Meaning | Do NOT translate as |
|---|---|---|
| `UNKNOWN` | No signal, or a signal we could not interpret. **The default.** | "Human-made", "Verified real", or anything positive |
| `HUMAN_CREATED` | Affirmatively declared as not AI-generated | "Verified" — it is a declaration, not a verification |
| `AI_EDITED` | AI applied to human-captured content, beyond standard editing | "Made by AI" |
| `AI_ASSISTED` | Human-authored with AI in the loop | "Made by AI" |
| `AI_GENERATED` | Wholly synthetic | — |

**`UNKNOWN` is not a synonym for human.** Absence of a marking is absence of
evidence. Most content will be `UNKNOWN` and that is the expected steady state.

### `basis`

| Value | Meaning |
|---|---|
| `AUTHOR_DECLARED` | The posting author said so |
| `PLATFORM_GENERATED` | The platform's own generation feature produced it. Strongest; never downgradable |
| `EMBEDDED_METADATA` | Read out of the uploaded file's metadata before the ingest strip, or received over federation |
| `CLASSIFIER_INFERRED` | A detector inferred it. **Advisory only — never render as a claim** |

The reason `basis` exists as a separate field: "the author says it's AI", "the
file's metadata says it's AI", and "we generated it ourselves" carry different
evidential weight, and collapsing them into a boolean is the easiest way to
display something false.

## Rendering rules

These are requirements, not suggestions. They come from Art. 50(5), which asks for
disclosure that is clear and distinguishable **at the latest at the first
interaction or exposure**, and conformant with accessibility requirements.

1. **Render when `disclosureRequired` is true.** Do not re-derive this from
   `sourceType` — the platform resolves it, including per-tenant policy, and a
   client that computes its own answer will eventually disagree with the server.
2. **`UNKNOWN` renders as nothing.** No badge, no "unknown" chip, no placeholder.
3. **Visible in the feed, not only on detail.** First exposure is the scroll.
4. **Never behind an interaction.** No hover-only, no tap-to-reveal, no collapsing
   into an overflow menu.
5. **Accessible.** Wire the translation of `labelDetailKey` to the badge's
   accessible name. Do not rely on colour alone. Meet contrast requirements.
6. **Per attachment, not per post.** One post can mix a human photograph with an
   AI-generated one; each attachment carries its own object.
7. **Do not render `basis` as user-facing text**, and in particular do not surface
   `CLASSIFIER_INFERRED` as a statement about the content. It is available so you
   can decide how much prominence to give a label, not so you can publish it.

## Declaring provenance

On create (`POST /api/posts`, `POST /api/posts/:id/comments`):

```json
{
  "text": "…",
  "provenance": { "sourceType": "AI_GENERATED" },
  "media": [{ "id": "<mediaFileId>", "sourceType": "AI_EDITED" }]
}
```

- **Only `sourceType` is accepted.** Sending `basis` is a 400 on the post/comment
  object: the platform mints it server-side, and a client able to set it could
  forge `PLATFORM_GENERATED`.
- **`UNKNOWN` is not accepted.** To express "no declaration", omit the field.
- Omitting `provenance` is always valid unless the tenant's posture requires it
  (see below).

On edit (`PATCH /api/posts/:id`, `PATCH /api/comments/:id`), the same
shape applies, with one rule:

> **A declaration may be raised, never lowered.** An attempt to reduce it returns
> **409 `PROVENANCE_NOT_REDUCIBLE`**. Omitting `provenance` leaves the stored value
> untouched — editing text never clears a declaration.

`PATCH /api/posts/:id` also accepts `media: [{ id, alt?, sourceType? }]` for
existing attachments. It updates those fields in place; it cannot add or remove
attachments. The response echoes `attachmentUpdates` telling you which items
actually changed — a `mediaId` that is not attached to the post matches nothing and
reports `false` rather than erroring.

### Tenant posture

A tenant may require declarations. Two errors, both 400:

| Error | Meaning |
|---|---|
| `DECLARATION_REQUIRED` | The tenant requires a declaration and the request omitted one. Your compose flow needs to ask |
| `DECLARATION_MAY_NOT_BE_UNKNOWN` | The user declined to answer and this tenant does not accept that |

The distinction is deliberate: the first means *you* did not ask, the second means
the *user* declined. Handle them differently.

## C2PA manifests on media

The ingest pipeline re-encodes every uploaded image and drops all metadata,
including any C2PA manifest — that strip is a privacy control and it stays (a
manifest carries camera model and serial number, capture times, edit history,
often an identity claim). But the strip is irreversible: once the original bytes
are gone, nobody can ever check a Content Credentials claim about that image
again.

So the manifest store is **copied out of the original before the strip** and kept
as a sidecar object beside the media. The media-detail response reports it inside
the same `provenance` object:

```json
{
  "sourceType": "UNKNOWN",
  "basis": null,
  "disclosureRequired": false,
  "labelKey": "provenance.unknown",
  "labelDetailKey": "provenance.unknown.detail",
  "c2pa": {
    "present": true,
    "container": "jpeg-app11",
    "sidecarKey": "cas/<tenant>/<hash>.c2pa",
    "byteLength": 41203,
    "sha256": "…",
    "verified": false
  }
}
```

`c2pa` is `null` when the file carried no manifest, and appears only on media —
text has no container to carry one.

| Field | Meaning |
|---|---|
| `present` | Always `true` when the object exists; absence is `c2pa: null` |
| `container` | `jpeg-app11`, `png-cabx`, or `unidentified` |
| `sidecarKey` | Storage key of the kept bytes, or `null` — see "presence only" below |
| `byteLength` | Size of the kept bytes |
| `sha256` | Digest of **our copy**, so a reader can confirm it got what we stored. Not a signature check |
| `verified` | **Always `false`.** See below |

### `verified` is always false, and that is not a placeholder

Trellis extracts the manifest. It does not check the signature, walk the
certificate chain, or read a single assertion out of it. There is no stored
column behind `verified` — the API emits a constant — so no configuration and no
future data state can make it true without someone first implementing
verification.

**Do not render "Content Credentials verified" from this object.** The honest
rendering is either nothing at all, or something like "this file arrived carrying
Content Credentials, which we have kept but not checked". A badge that implies
verification publishes a claim the platform never made — the same failure mode
as rendering `UNKNOWN` as "human-made".

### Full extraction vs presence only

| Container | Behaviour |
|---|---|
| JPEG (APP11 JUMBF) | Bytes extracted and stored. Multi-segment boxes are reassembled and the reassembly is checked (packet sequence, `LBox`); anything irregular degrades to presence only rather than storing a partial manifest |
| PNG (`caBX` chunk) | Bytes extracted and stored |
| Everything else (WebP, GIF, video/audio) | **Presence only** — `present: true`, `container: "unidentified"`, no bytes. The embedding is real but this codebase does not locate it, and guessing a byte range would be worse than saying so |

Detection dispatches on the file's magic bytes, not on the declared MIME type.

### Erasure

The sidecar is a first-class part of the media object for deletion: every
object-deletion path (the nightly soft-deleted-media purge that GDPR Art. 17
erasure routes through, the cleanup handler, the orphan sweep, the stale reap)
deletes it alongside `originalKey` / `thumbnailKey` / `optimizedKey`. Every
sidecar object that exists is named by a live `MediaFile` row, so none can be
stranded where no deletion path would find it.

## Correcting a mistake

A wrong declaration cannot be fixed by the author — that is what monotonicity
means, and a self-service reduction would be indistinguishable from an evasion.
Reduction goes through `POST /api/admin/provenance-correction`
(MODERATOR/SUPER_ADMIN), which requires a written reason and writes an audit
record. Route a user's "I tagged this wrong" report there.

Content the platform's own generator produced is not correctable by anyone.

## What this does not tell you

Stated plainly so nothing here is read as broader than it is:

- **No AI detection.** `UNKNOWN` on a synthetic image means nobody declared it and
  no marking survived, not that the platform checked.
- **C2PA manifests are kept, not validated.** A present manifest yields
  `UNKNOWN` with the container noted; its claims are never honoured. The bytes
  are extracted and stored (see below) so that someone else can check them one
  day — Trellis itself checks nothing.
- **Unsigned claims of human origin are refused.** A file asserting "digital
  capture" does not produce `HUMAN_CREATED`, because that assertion is plain text
  anyone can write.
- **Federated labels are hints.** A remote instance can ignore, drop, or fabricate
  one. Provenance received over federation is recorded as `EMBEDDED_METADATA`, never
  as another server's `AUTHOR_DECLARED`.
- **Trellis is not an Art. 50 addressee.** It is a library; it supplies the
  mechanism. The disclosure duty belongs to whoever operates the deployment and, for
  professional posters, to the posting organisation. Rendering the label is the step
  that discharges anything.
