# Validation

This document describes validation rules and required fields for user data exports.

---

## JSON Schema

The export format follows a loose JSON structure. For strict validation, consider:

- **JSON Schema validation**: define a JSON Schema to validate export structure
- **TypeScript type checking**: use TypeScript types to validate at compile time
- **Custom validators**: implement application-specific validation logic

---

## Required Fields

### Root Level

The following fields are required at the root level of the export:

- `exportedAt` (string, required): ISO 8601 timestamp of when the export was generated
- `format` (string, required): export format identifier (`"json"` or `"activitypub"`)
- `version` (string, required): format version (e.g., `"1.0"`)
- `user` (object, required): user information object

### User Object

The following fields are required in the user object:

- `id` (string, required): user ID (CUID)
- `email` (string, required): user's email address
- `createdAt` (string, required): ISO 8601 account creation timestamp

**Optional fields:**

- `did` (string, optional): ActivityPub actor ID
- `handle` (string, optional): ActivityPub handle

### Post Object

The following fields are required in each post object:

- `id` (string, required): post ID
- `text` (string, required): post content
- `visibility` (string, required): visibility setting (`PUBLIC`, `PRIVATE`, or `FRIENDS`)
- `createdAt` (string, required): ISO 8601 post creation timestamp
- `updatedAt` (string, required): ISO 8601 last update timestamp

**Optional fields:**

- `entityRef` (string, optional): reference to a domain-extension entity
- `geoData` (object, optional): geo-location data
- `uri` (string, optional): ActivityPub activity ID
- `contentWarnings` (array, optional): content warning labels
- `media` (array, optional): media attachments
- `sentiments` (array, optional): reactions on this post
- `comments` (array, optional): comments on this post

### Comment Object

The following fields are required in each comment object:

- `id` (string, required): comment ID
- `postId` (string, required): ID of post being commented on
- `text` (string, required): comment content
- `createdAt` (string, required): ISO 8601 comment creation timestamp

**Optional fields:**

- `postUri` (string, optional): ActivityPub activity ID of post
- `rootUri` (string, optional): root post URI
- `replyToUri` (string, optional): parent comment URI
- `media` (array, optional): media attachments
- `sentiments` (array, optional): reactions on this comment

### Sentiment/Reaction Object

The following fields are required in each sentiment object:

- `id` (string, required): sentiment ID
- `sentiment` (string, required): reaction type
- `createdAt` (string, required): ISO 8601 reaction timestamp

---

## Validation Best Practices

### Client-Side Validation

When consuming exported data:

1. **Check required fields**: ensure all required fields are present
2. **Validate data types**: verify field types match specifications
3. **Validate timestamps**: ensure ISO 8601 format compliance
4. **Check array structures**: verify arrays contain expected object structures

### Server-Side Validation

When generating exports:

1. **Validate before export**: ensure all data meets requirements
2. **Handle missing data**: gracefully handle optional fields that may be missing
3. **Validate timestamps**: ensure all timestamps are valid ISO 8601 format
4. **Sanitize data**: remove or sanitize any sensitive internal data

---

## Common Validation Issues

### Missing Required Fields

If a required field is missing:

- The export should fail validation
- An error should be returned to the user
- The export should not be generated

### Invalid Timestamps

If a timestamp is invalid:

- Convert to ISO 8601 format
- Use UTC timezone
- Include milliseconds if available

### Empty Arrays

Empty arrays are valid:

- `posts: []` - user has no posts
- `comments: []` - user has no comments
- Arrays should be present even if empty

---

## Related Documentation

- [Standard JSON Format](./standard-json-format.md)
- [Data Completeness](./data-completeness.md)
- [Back to Format Specification](./README.md)
