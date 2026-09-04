-- Consent: the third-party data-sharing purpose (partner-integration-readiness
-- lane A). A USER consenting that a named external client may read one of their
-- resources. Additive: a single new ConsentPurpose value, nothing else.
--
-- CROSS_TENANT_DATA_PROCESSING is reserved, not added — it is an ORG ADMIN
-- acknowledging a controller relationship on a tenant→tenant grant, a different
-- principal pair and a different lawful basis.

-- AlterEnum
-- This is the ONLY statement in this migration, and this is the only migration
-- that may contain ADD VALUE. Postgres forbids using a newly added enum value
-- in the same transaction that adds it, and the next migration's CHECK
-- constraint and index predicate both spell 'THIRD_PARTY_DATA_SHARING' — so the
-- two cannot be merged "to save a migration".
ALTER TYPE "ConsentPurpose" ADD VALUE 'THIRD_PARTY_DATA_SHARING';
