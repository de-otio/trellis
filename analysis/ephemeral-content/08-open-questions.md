# Open Questions

## Resolved

1. ~~**Key granularity**~~: No longer applicable -- encryption deferred. Sunset operates per-post/per-comment via `sunset_at` timestamp.
2. ~~**Selective sunset**~~: Trivially supported -- set `sunset_at` on any individual post or comment.
3. ~~**Dead ciphertext cleanup**~~: No longer applicable -- no ciphertext. Media cleanup handled by deferred object-store deletion after grace period.
4. ~~**Owner-retained access**~~: Adopted. Owner queries bypass the `sunset_at` filter. See [Owner-Retained Access](10-owner-retained-access.md).
5. ~~**Media handling**~~: Resolved -- live posts use long-lived CDN URLs (unchanged), owner archive uses short-lived signed URLs. See [Media Strategy](media-strategy/).

## Open

6. **Social graph implications**: If User A comments on User B's post and B sunsets it, what happens to A's comment? Current recommendation: hide comments at serving layer when parent post is sunset; reappear if un-sunset. See [Ephemeral Comments](09-ephemeral-comments.md).
7. **API consumers**: Third-party apps accessing content via API -- how do they handle sunset content? Should the API return a `410 Gone` or simply omit sunset content?
8. **Regulatory**: Does GDPR "right to erasure" require actual data deletion, or is access-control-based sunset sufficient? Likely requires eventual deletion -- the deferred object-store cleanup and database purge (post-grace-period) should satisfy this, but needs legal review.
9. **Archive UX**: How should the user browse sunset content? Separate "Archive" view? Should it support search, or just chronological browsing?
10. **Sunset export**: Should sunset content be exportable for data portability, or view-only?
11. **Account deletion**: When a user deletes their account, sunset content and media should be permanently deleted. Confirm this aligns with existing account deletion flow.
12. **Shared sunset content**: If User A retains access to a sunset post that had comments from User B, can A still see B's comments in their archive? Current recommendation: yes, if B hasn't independently sunset their comments.
13. **Reactions/likes**: Should these also be ephemeral? Simpler than content (no media), but the same user-control principle applies.
14. **Reply chains**: If a comment is a reply to another comment, and the parent comment sunsets, should the reply be hidden too?
15. **Notification cleanup**: When a comment sunsets, should the notification it generated also be removed?
