# Data Completeness

This document describes what data is included and excluded from user data exports.

---

## Included Data

The following data is included in user data exports:

- **User profile information**
  - User ID, email, federation identity fields (actor ID / handle) when present
  - Account creation timestamp

- **All posts created by the user**
  - Post content, visibility settings
  - Geo-location data
  - Content warnings
  - Media metadata (references, not files)
  - Timestamps

- **All comments made by the user**
  - Comment text
  - Post and thread references
  - Media metadata
  - Timestamps

- **All reactions made by the user**
  - Reactions on own posts
  - Reactions on others' posts
  - Reactions on comments
  - Reaction types and timestamps

- **Geo-location data for posts**
  - Latitude/longitude coordinates
  - Geohash values
  - Place names
  - Location labels

- **Media metadata**
  - Media file references
  - Alt text descriptions
  - Order/sequence information
  - Note: actual media files are not included

- **Post visibility settings**
  - Public, private, or friends-only visibility

- **Content warnings**
  - All content warning labels applied to posts

---

## Excluded Data

The following data is **not** included in user data exports:

- **Actual media files**
  - Only metadata and references are included
  - Media files must be downloaded separately if needed

- **Social-graph relationships (follows, friendships)**
  - The social graph is stored in the graph backend, separate from the
    primary record store
  - May be included in a future version (see [Version History](./version-history.md))

- **Deleted posts**
  - Only active, non-deleted content is exported

- **System/internal data**
  - Internal system fields
  - Administrative metadata
  - System-generated IDs not relevant to users

- **Other users' private content**
  - Only the requesting user's own data is exported
  - Comments and reactions on others' content are included, but not the full content of others' private posts

---

## Data Scope Notes

### User's Own Content

- All posts created by the user are included
- All comments made by the user are included
- All reactions made by the user are included

### Interactions with Others

- Comments on others' posts: included (user's own comments)
- Reactions on others' posts: included (user's own reactions)
- Reactions on others' comments: included (user's own reactions)
- The content of others' posts/comments: not included (unless public and referenced)

### Geo-Indexed Posts

- Only posts with geo-location data are included in the `geoIndexedPosts` array
- These are also included in the main `posts` array

---

## Future Enhancements

Planned additions for future versions:

- **Version 1.1**: media file downloads
- **Version 1.2**: social-graph relationships export (follows, friendships)
- **Version 2.0**: incremental exports (only changed data since last export)

See [Version History](./version-history.md) for details.

---

## Related Documentation

- [Standard JSON Format](./standard-json-format.md)
- [File Naming Convention](./file-naming.md)
- [Back to Format Specification](./README.md)
