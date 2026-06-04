# Strategic Compromises

| Dimension | Choice | Rationale |
|---|---|---|
| **Sunset mechanism** | Access control (visibility flags + query filters), not encryption | Delivers the full feature against the identified threat model. Encryption deferred as future enhancement. |
| **Owner-retained access** | Author keeps access to sunset content via private Archive | Matches user mental model (Instagram Archive). Lowers the stakes of sunset decisions. |
| **Sunset granularity** | Per-post and per-comment | Users can sunset individual items, date ranges, or everything. |
| **Media handling** | Short-lived signed URLs for access control | No encryption overhead. CDN caching within signed URL validity window. |
| **Screenshot protection** | None | Snapchat proved users accept this trade-off; perception of ephemerality is sufficient. |
| **Grace period** | 30-day reversible window before media deletion | Prevents regret / accidental data loss. |
| **Legal compliance** | Sunset suspended during legal holds | Standard industry practice. |
| **Data at rest** | Plaintext, protected by database and object-store access controls | Acceptable given threat model targets casual discovery, not infrastructure compromise. |
