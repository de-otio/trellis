---
title: Migration Guide
description: How to import and migrate Trellis user data exports to another system or an AT Protocol-style service.
sidebar: Migration Guide
order: 60
---

# Migration Guide

This document provides guidance on importing and migrating exported user data to other systems.

---

## Importing to Another System

### General Steps

1. **Parse the JSON export file**
   - Load and parse the JSON export file
   - Validate the structure using the [Validation](./validation.md) rules

2. **Extract user data**
   - Extract user profile information
   - Extract posts, comments, and reactions
   - Extract geo-location data if needed

3. **Transform to the target system format**
   - Map fields to the target system's data model
   - Convert timestamps if needed
   - Handle media references appropriately

4. **Import data into the target system**
   - Create a user account if needed
   - Import posts and comments
   - Import reactions/sentiments
   - Handle media files separately if required

### Example: Generic Social Media Platform

```javascript
// Pseudocode example
const exportData = JSON.parse(exportFile);

// Create user
const user = await createUser({
  email: exportData.user.email,
  createdAt: exportData.user.createdAt,
});

// Import posts
for (const post of exportData.posts) {
  await createPost({
    userId: user.id,
    content: post.text,
    visibility: post.visibility,
    createdAt: post.createdAt,
    location: post.geoData,
  });
}
```

---

## Migrating with the AT Protocol Format

The `atproto` export is a transform of the standard data into AT Protocol
lexicon records. Each post becomes a record with a `$type` (such as
`com.trellis.dog.post`), comments become nested `com.trellis.dog.comment`
records under a `thread` key, and media attachments become `$type: "blob"`
references. It is **not** an ActivityPub activity stream — do not expect
`type: "Note"` objects.

### Prerequisites

- AT Protocol-format export file (`"format": "atproto"`)
- A client/library for the target service
- Access to the target service
- Media files (if needed)

### Step-by-Step Process

#### 1. Download the AT Protocol-Format Export

Download the export file in AT Protocol format:

- File name: `trellis-export-atproto-YYYY-MM-DD.json`
- Format: `"atproto"` in the root object

#### 2. Parse the JSON File

```javascript
const exportData = JSON.parse(exportFile);
// Validate format === "atproto"
```

#### 3. Validate the Records

- Ensure each record has the expected `$type` and fields (see [Validation](./validation.md))
- Validate that any URIs are well-formed
- Confirm timestamps are ISO 8601

#### 4. Map the Lexicon Records to the Target Service

Each post record has the shape below; map its fields onto the target
service's record model:

```javascript
for (const post of exportData.posts) {
  // post.$type === "com.trellis.dog.post"
  await targetClient.createRecord({
    text: post.text,
    createdAt: post.createdAt,
    // post.thread holds nested comment records
    // post.media holds { $type: "blob", ref, alt } entries
  });
}
```

#### 5. Upload Media Blobs

Media files must be uploaded separately:

```javascript
for (const post of exportData.posts) {
  for (const media of post.media || []) {
    const blob = await uploadBlob(media.ref);
    // Associate the blob with the migrated record
  }
}
```

### Important Considerations

- **URIs**: existing URIs may need to be updated for the new service
- **Actor identity**: the user's handle may change on a new service
- **Media**: media files are not included in the export — they must be downloaded separately
- **Threads**: comment threads are preserved as nested records under `thread`
- **Timestamps**: original timestamps are preserved

---

## Common Migration Scenarios

### Scenario 1: Backup and Restore

**Goal**: create a backup of user data

1. Export data in standard JSON format
2. Store the export file securely
3. To restore: import using the standard JSON format

### Scenario 2: Platform Migration

**Goal**: move user data to a different platform

1. Export data in standard JSON format
2. Transform data to the target platform format
3. Import into the target platform
4. Verify data integrity

### Scenario 3: AT Protocol Migration

**Goal**: migrate to an AT Protocol-style service

1. Export data in AT Protocol format
2. Set up the target service
3. Map the lexicon records onto the target service's record model
4. Upload media blobs
5. Update the user's handle as needed

---

## Troubleshooting

### Missing Media Files

**Problem**: media files are not included in the export

**Solution**:

- Media files must be downloaded separately
- Use media references from the export to locate files
- Upload to the new system separately

### Invalid Timestamps

**Problem**: timestamps don't match the expected format

**Solution**:

- Ensure timestamps are ISO 8601 format
- Convert timezones if needed
- Validate before import

### Missing Required Fields

**Problem**: required fields are missing in the export

**Solution**:

- Check export version compatibility
- Validate the export using the [Validation](./validation.md) rules
- Contact support if the export is invalid

---

## Related Documentation

- [Standard JSON Format](./standard-json-format.md)
- [Data Completeness](./data-completeness.md)
- [Validation](./validation.md)
- [Back to Format Specification](./README.md)
