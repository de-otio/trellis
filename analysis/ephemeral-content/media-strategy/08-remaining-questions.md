# Remaining Questions

1. **Video streaming**: Signed URLs work for progressive download, but what about adaptive bitrate streaming (HLS/DASH)? Manifest files and segments would each need signed URLs.
2. **Thumbnail handling**: Should thumbnails follow the same signed-URL pattern, or can they remain publicly cached longer since they're low-resolution and less sensitive?
3. **Processing derivatives**: When a post is sunset and later un-sunset (within grace period), do the object-store objects still exist? Deferred deletion timing must respect the grace period.
4. **Cost modelling**: How much does switching from 1-year CDN cache to 15-minute signed URLs increase CDN and origin costs? Need traffic estimates.
