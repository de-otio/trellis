# 07 — Data migration: Neo4j → Neptune

This doc covers the path from the self-hosted Neo4j Community instance to
Neptune Serverless. If Neptune is chosen from the start (greenfield), skip to
the last section on data model decisions.

## Two directions this migration can happen

### A. Switching after running on self-hosted Neo4j

If the project has been running on the self-hosted design and wants
to move to Neptune Serverless, the migration is a data format conversion —
Neo4j's `neo4j-admin database dump` format is not directly consumable by
Neptune.

### B. Greenfield: Neptune from day one

The cleanest path. No migration needed; just design the data model against
Neptune's openCypher constraints ([`04`](04-opencypher-compatibility.md))
from the start.

## Migration path A: Neo4j → Neptune

### Step 1: Export from Neo4j

Use `neo4j-admin database dump` (already the weekly backup artifact in the
self-hosted design) to produce a consistent `.dump` file.

```bash
neo4j-admin database dump neo4j --to-path=/backups
```

### Step 2: Convert to Neptune bulk loader format

Neptune's bulk loader ingests data from S3 in CSV format:

- **Node CSV**: columns `~id`, `~label`, and one column per property.
- **Edge CSV**: columns `~id`, `~from`, `~to`, `~label`, and property columns.

The **`neo4j-to-neptune`** open-source tool (from `awslabs/amazon-neptune-tools`)
automates the conversion:

```bash
# Install
pip install neo4j-to-neptune

# Convert (requires a running Neo4j instance to export from)
neo4j-to-neptune \
  --host bolt://localhost:7687 \
  --output-dir /tmp/neptune-export/
```

This produces vertex CSV and edge CSV files ready for Neptune's bulk loader.

**Known conversion issues to verify:**
- **Multi-valued properties** → the tool converts them to delimited strings
  (e.g. `['a','b']` → `a;b`). If your model uses list properties, plan for
  the application to split/join these strings.
- **Node IDs** → Neo4j internal integer IDs become string IDs in Neptune.
  Application code that stores or compares `id(n)` must handle string IDs.
- **APOC virtual graph constructs** → not representable; must be rebuilt
  in the Neptune model.

### Step 3: Upload to S3 and bulk load

```bash
aws s3 cp /tmp/neptune-export/ s3://your-bucket/neptune-import/ --recursive
```

Trigger the Neptune bulk loader via the REST endpoint (or via a Lambda /
SSM Automation document):

```bash
curl -X POST \
  https://your-cluster.neptune.amazonaws.com:8182/loader \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "s3://your-bucket/neptune-import/",
    "format": "csv",
    "iamRoleArn": "arn:aws:iam::ACCOUNT:role/NeptuneBulkLoaderRole",
    "region": "eu-central-1",
    "failOnError": false
  }'
```

The bulk loader runs asynchronously. Poll status:

```bash
curl https://your-cluster.neptune.amazonaws.com:8182/loader/JOB_ID
```

### Step 4: Verify counts

After the load, verify node and relationship counts match the source:

```cypher
-- In Neptune:
MATCH (n) RETURN count(n) AS nodes
MATCH ()-[r]->() RETURN count(r) AS rels
```

Compare with Neo4j counts from the export step.

### Step 5: CDK swap

Once data is verified in Neptune, perform the `IGraphConnection` construct
swap in the CDK stateful stack:

```typescript
// Before:
const graph = new Neo4jGraphInstance(this, 'Graph', { … });

// After:
const graph = new NeptuneServerlessConnection(this, 'Graph', { … });
graph.grantConnect(apiTask.taskDefinition.taskRole);
```

Roll the ECS tasks. Soak with the old Neo4j instance still running (same
rollback posture as the self-hosted design's AuraDB migration runbook). Decommission
the `Neo4jGraphInstance` once the soak is clean.

### Alternative: AWS DMS

AWS Database Migration Service (DMS) supports Neptune as a migration target.
Useful if you want continuous replication from Neo4j to Neptune during a
cutover window. Adds operational complexity; only warranted if zero-downtime
cutover is required (i.e. a live production migration, not a pre-launch
transition).

## Greenfield data model guidance

If starting fresh on Neptune, the three design constraints from
[`04`](04-opencypher-compatibility.md) that have data-model implications:

### 1. No multi-valued list properties

Design: use a relationship to a separate label node instead of a list
property.

```
-- Avoid (won't work in Neptune):
(Person {tags: ['engineer', 'manager']})

-- Instead:
(Person)-[:HAS_TAG]->(Tag {name: 'engineer'})
(Person)-[:HAS_TAG]->(Tag {name: 'manager'})
```

This is idiomatic graph modelling anyway.

### 2. Node IDs are strings — use meaningful custom IDs

Neptune lets you set `~id` explicitly. Use a stable, business-meaningful ID
(e.g. `user-{uuid}`, `org-{slug}`) rather than relying on auto-generated IDs.
This makes cross-system references stable and avoids the integer-vs-string
ambiguity.

```cypher
CREATE (n:Person {~id: 'person-' + $userId, name: $name})
```

### 3. No schema constraints — enforce at the application layer

Write application-level uniqueness checks for properties that must be unique
(e.g. email). Use Neptune's ID uniqueness (natural with meaningful custom IDs)
for primary-key semantics.

## Open questions

- **`neo4j-to-neptune` maintenance status.** The tool is from awslabs but
  not heavily maintained. Verify it handles the current Neo4j 5 dump format
  before depending on it. If it doesn't, the fallback is exporting via
  `neo4j-admin export --format=csv` and hand-mapping column headers to
  Neptune's CSV schema.
- **Relationship IDs.** Neptune bulk loader requires a `~id` column for
  relationships. Neo4j's relationship IDs are internal integers. The
  converter generates string IDs; verify they're stable across re-exports.
