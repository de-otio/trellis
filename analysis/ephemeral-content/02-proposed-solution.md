# Proposed Solution

## Concept

Users can "sunset" their content -- individual posts, everything older than N months, or their entire history. Sunset content is hidden from public view but remains accessible to the author in a private Archive. No encryption is involved; sunset is enforced via access control (visibility flags and query filters).

## How It Works

1. Every post and comment has a `sunset_at` timestamp (null = live)
2. Users can set sunset policies: manual, or automatic after 30/90/365 days
3. When content sunsets, it disappears from all public views (feeds, profiles, search)
4. The author can still browse their sunset content in a private **Archive** view
5. A 30-day grace period allows un-sunsetting before media is permanently deleted
6. Media (photos, videos) is served via short-lived signed URLs; sunset media stops getting new URLs

## Why Not Encryption?

The threat model targets casual discovery (recruiters, exes, journalists, search engines). Access control defeats all identified threats. Encryption adds significant complexity (KMS integration, key lifecycle, cache-busting, inability to index content) for protection against database compromise -- a threat explicitly out of scope.

Media (the majority of content) cannot practically be encrypted at rest without major infrastructure changes. Encrypting text while leaving media unencrypted creates an inconsistent security model with no practical benefit.

Encryption remains a viable future enhancement if the threat model expands. See [Encryption vs Access Control](13-encryption-vs-access-control.md) for the full analysis.
