# 02 — Storage and availability

## Storage is always 3-AZ, even for a single instance

This is the most important availability property to understand about Neptune,
and it is categorically different from the self-hosted design.

Neptune stores all data in a **cluster volume** — a distributed, shared
storage layer backed by NVMe SSDs. The cluster volume:

- Replicates every write into **six copies**.
- Spreads those six copies across **three availability zones**.
- Does this **automatically, for every Neptune cluster**, regardless of how
  many compute instances are attached.

Concretely: a Neptune Serverless cluster with a single writer instance still
has 3-AZ storage durability. If the AZ containing the compute instance goes
down, the data survives in the other two AZs, intact and immediately available
for a replacement instance to attach to.

Compare with the current self-hosted design:

| | Self-hosted Neo4j | Neptune Serverless (single instance) |
|---|---|---|
| Storage copies | 1 (EBS, single AZ) | 6 (3 AZs, always) |
| AZ loss → data loss? | Possible (last snapshot) | No |
| Instance loss → data loss? | No (volume survives) | No |
| Storage SPOF | Yes | **No** |
| Compute SPOF | Yes | **Yes** (single writer) |

So even the **minimum viable Neptune deployment** — one Serverless writer —
eliminates the storage SPOF that [the self-hosted analysis](../graph-db-self-host-ai-revisit.md)
describes. The worst-case AZ-failure row in the self-hosted failure table
(RPO up to 24h from last snapshot) simply does not exist in Neptune.

The cluster volume grows automatically, starting at 10 GB and expanding in
10 GB segments as needed, up to 128 TiB. You are billed for one copy of the
actual data used, not for all six.

## Compute HA: the writer is still a single point

Storage durability is automatic. Compute high-availability requires a
**read replica** in a second AZ.

Neptune clusters support up to 15 read replicas. For compute HA:

- Add **one reader instance** in a different AZ from the writer.
- Set its **promotion tier to 0 or 1**. Tiers 0–1 scale in sync with the
  writer and are promoted immediately on writer failure. Tiers 2–15 scale
  independently and promote in order after tier-0/1 instances.

With writer + one tier-0/1 reader:

```
  AZ-a          AZ-b          AZ-c
 ─────────     ─────────     ─────────
│ writer  │   │ reader  │   │ storage │
│ (NCU=N) │   │ tier-0  │   │ only    │
│         │   │ (NCU=N) │   │         │
 ─────────     ─────────     ─────────
     └──────────────┴──────────────┘
              6-way storage volume
              (all 3 AZs always)
```

On writer failure, Neptune promotes the tier-0 reader to writer. The RTO for
this failover is typically **30–120 seconds** — Neptune updates the
cluster endpoint DNS to point to the new writer.

### The Bolt driver reconnection requirement

Neptune's Bolt connection docs are explicit: **after a failover, the Bolt
driver must be closed and reopened.** The issue is DNS caching — the driver
resolves the cluster endpoint hostname to an IP, and after failover that IP
is no longer the writer. Applications must catch the failover exception and
reconnect. This is a standard pattern in any Aurora/Neptune application and
well-documented; it is not unique to serverless. See
[`05`](05-connection-protocol.md) for the reconnection implementation detail.

## Serverless scaling does not affect storage

Neptune Serverless scales **compute only** — the storage volume is separate
and unaffected by NCU scaling events. This means:

- Scaling down to minimum NCU does not evict data from the cluster volume.
- Buffer-cache eviction can happen during scale-down (data is re-read on next
  access), but no data is lost.
- The 6×-3AZ replication continues at all NCU levels, including during
  scale-down.

## Comparison with the self-hosted failure modes

From [the self-hosted analysis](../graph-db-self-host-ai-revisit.md), updated
for Neptune Serverless with writer + one reader:

| What fails | Self-hosted recovery | Neptune Serverless recovery |
|---|---|---|
| Container / process crash | restart (seconds–minutes) | AWS replaces writer, failover to reader (~30–120 s) |
| Compute instance fails | re-attach volume, new instance (minutes) | automatic promotion of reader (~30–120 s) |
| AZ outage | restore snapshot to other AZ (~30 min, up to 24h RPO) | automatic promotion to reader in other AZ (~30–120 s, **zero data loss**) |
| EBS/volume corrupted | restore from snapshot (15–30 min, up to 24h RPO) | N/A — cluster volume is shared; corruption is handled by the 6-way replication layer |
| Region loss | restore S3 dump (hours, up to 7 days RPO) | restore from Neptune snapshot in another region (similar RTO, similar RPO unless cross-region snapshots configured) |

The AZ-failure row is the key improvement: self-hosted loses up to 24 hours
of data; Neptune loses none.

## Backup and point-in-time recovery

Neptune provides **continuous backups** to S3 with point-in-time restore
(PITR) within the backup retention window (1–35 days, default 1 day). This
is the "PITR becomes a requirement" trigger from
[the self-hosted analysis](../graph-db-self-host-ai-revisit.md) —
Neptune Serverless **already satisfies it**, without any additional design
work.

Backup storage is billed separately at $0.021/GB-month beyond 1× the cluster
storage size.

## Open questions

- **Single-instance option for dev/staging.** A single-writer Neptune
  Serverless cluster (no reader) has 3-AZ storage HA but compute SPOF.
  For dev/staging this is probably fine and saves ~50% of compute cost.
  Worth standardising in the construct ([`06`](06-cdk-construct.md)).
- **Cross-region backup.** Neptune snapshots can be copied to another region.
  If the project requires a region-loss RTO tighter than "restore from a
  cross-region snapshot copy," that configuration is needed. Not required
  pre-launch; worth noting as a revisit trigger parallel to the self-hosted
  design's S3 dump cross-region posture.
