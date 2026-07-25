# Object Storage feasibility — this is where the key open question lives:
# does Scaleway support presigned POST-policy uploads (S3 `createPresignedPost`),
# or only presigned PUT? See harness/check-s3-presigned.ts.
#
# Grounding (get-resource-docs scaleway/scaleway object_bucket /
# object_bucket_acl, 2026-07-18): `scaleway_object_bucket` + companion
# `scaleway_object_bucket_acl` is the documented pattern — the bucket
# resource's own `acl` argument is explicitly deprecated in favor of the
# separate ACL resource ("The acl attribute is deprecated. See
# scaleway_object_bucket_acl resource documentation"), which is why this
# spike uses the split form the prompt asked for rather than the
# deprecated inline `acl` field.
#
# Bucket names are unique per-region across all Scaleway projects (S3-style
# virtual-hosted addressing), so a random suffix keeps repeated
# apply/destroy cycles of this spike from colliding with a leftover or
# someone else's bucket.

resource "random_id" "bucket_suffix" {
  byte_length = 4
}

resource "scaleway_object_bucket" "spike" {
  name = "spike-g1-uploads-${random_id.bucket_suffix.hex}"
  tags = {
    spike = "g1"
  }

  # G1 FINDING (live 2026-07-19): the harness uploads test objects (the
  # presigned POST/PUT files), so `tofu destroy` failed with S3
  # BucketNotEmpty (409) — Scaleway's DeleteBucket, like AWS, refuses a
  # non-empty bucket. `force_destroy` empties it first. Any real bucket that
  # receives objects outside OpenTofu needs this (or a lifecycle purge)
  # before it can be torn down.
  force_destroy = true
}

resource "scaleway_object_bucket_acl" "spike" {
  bucket = scaleway_object_bucket.spike.id
  acl    = "private"
}
