---
title: Migration Guide
description: How to import and migrate Trellis user data exports to another system or ActivityPub server.
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

## Migrating to an ActivityPub Server

### Prerequisites

- ActivityPub-format export file (`"format": "activitypub"`)
- An ActivityPub client/library
- Access to the target ActivityPub server
- Media files (if needed)

### Step-by-Step Process

#### 1. Download the ActivityPub-Format Export

Download the export file in ActivityPub format:

- File name: `export-activitypub-YYYY-MM-DD.json`
- Format: `"activitypub"` in the root object

#### 2. Parse the JSON File

```javascript
const exportData = JSON.parse(exportFile);
// Validate format === "activitypub"
```

#### 3. Validate the Records

- Ensure each object has the expected fields (see [Validation](./validation.md))
- Validate that activity URIs are well-formed
- Confirm timestamps are ISO 8601

#### 4. Create Activities on the Target Server

Use an ActivityPub client to create activities:

```javascript
for (const post of exportData.posts) {
  await activitypubClient.postActivity({
    actor: userActorId,
    object: {
      type: "Note",
      content: post.text,
      published: post.createdAt,
      // ... other fields
    },
  });
}
```

#### 5. Upload Media Blobs

Media files must be uploaded separately:

```javascript
for (const post of exportData.posts) {
  for (const media of post.media) {
    const blob = await uploadBlob(media.ref);
    // Associate the blob with the post/activity
  }
}
```

### Important Considerations

- **URIs**: existing URIs may need to be updated for the new server
- **Actor identity**: the user's actor ID and handle may change on a new server
- **Media**: media files are not included in the export — they must be downloaded separately
- **Threads**: comment threads are preserved via the `rootUri` / `replyToUri` references
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

### Scenario 3: ActivityPub Server Migration

**Goal**: migrate to a new ActivityPub server

1. Export data in ActivityPub format
2. Set up the new ActivityPub server
3. Create activities on the new server
4. Upload media blobs
5. Update the user's actor ID and handle

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
