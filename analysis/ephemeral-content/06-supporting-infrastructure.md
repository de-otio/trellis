# Critical Supporting Infrastructure

## Cache Control (High Priority)

Sunset is only effective if content isn't cached in places outside our control. This is where the real implementation work lives:

- `Cache-Control: no-store` headers on all user content API responses
- `X-Robots-Tag: noindex` to prevent search engine indexing
- Short-lived signed URLs for media rather than permanent content links
- CDN configuration to respect cache-control directives
- `meta robots noarchive` to discourage web archives

## UX Design (High Priority)

The content lifecycle UX matters more than the technical details:

- **Sunset policies**: Automatic expiry after 30/90/365 days, configurable per-post or globally
- **First-class feature**: Prominent in the UI, not buried in settings
- **Bulk operations**: "Sunset everything before [date]"
- **Visibility**: Clear indication of which content is live vs. approaching sunset
- **Grace period UI**: 30-day "undo" window with clear countdown
- **Archive view**: Private view of sunset content, accessible only to the author -- framed as a personal history feature, not a recovery tool
