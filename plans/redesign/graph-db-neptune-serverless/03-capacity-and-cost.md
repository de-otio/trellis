# 03 — Capacity model and cost

## Neptune Capacity Units (NCUs)

Neptune Serverless measures compute in **Neptune Capacity Units**:

- 1 NCU = 2 GiB RAM + proportional vCPU + networking.
- You set a **minimum** (lowest the instance can shrink to, floor: 1.0 NCU)
  and a **maximum** (ceiling: 128.0 NCU; floor of the maximum: 2.5 NCU).
- Capacity is measured as a floating-point number; Neptune scales in
  increments as fine as **0.5 NCU**.
- Each instance scales independently, except tier-0/1 readers which scale
  in sync with the writer.

### Why minimum NCU matters for scale-up speed

Neptune's scaling increment is proportional to *current* capacity. A low
minimum means the instance starts with small increments — fine for gradual
ramp-up, potentially slow for sudden spikes. For a pre-launch product where
graph usage is low and bursty (not sustained high load), 1.0 NCU minimum
is appropriate. If query latency on sudden traffic bursts is a concern,
consider 2.0–4.0 NCU minimum.

### Memory sizing reference

| NCU | ~RAM | Equivalent provisioned instance |
|---|---|---|
| 1.0 | 2 GiB | — (smaller than t3.medium) |
| 2.0 | 4 GiB | ≈ t3.medium (4 GiB) |
| 4.0 | 8 GiB | ≈ t4g.large (8 GiB) |
| 8.0 | 16 GiB | ≈ r6g.large (16 GiB) |
| 16.0 | 32 GiB | ≈ r6g.xlarge (32 GiB) |

For a ~1 GB graph (pre-launch), 2–4 NCU is typically sufficient to hold the
working set in the buffer cache.

## Pricing (`eu-central-1`, standard storage)

| Component | Price |
|---|---|
| Compute | $0.0128 / NCU-hour |
| Storage | $0.10 / GB-month |
| I/O (standard storage) | $0.20 / 1M requests |
| Backup beyond 1× cluster size | $0.021 / GB-month |
| Snapshots (manual) | $0.021 / GB-month |

Storage is billed on a **high-water mark**: once Neptune allocates a 10 GB
segment, you are billed for it even if you delete data. The cluster starts
at 10 GB allocated (= $1.00/month). For a 1 GB graph, this is the floor.

I/O-Optimized storage swaps I/O charges for a higher storage rate
($0.25/GB-month vs $0.10/GB-month). Worth considering once I/O costs
materially exceed the storage premium — not relevant at pre-launch.

## Cost scenarios

### HA setup: writer + one reader, `eu-central-1`

This is the minimum configuration that eliminates the compute SPOF
([`02`](02-storage-and-availability.md)).

| NCU range | Compute/month (both instances) | Storage | Total |
|---|---|---|---|
| 1.0–5.0 NCU (idle) | 2 × 1.0 × $0.0128 × 720 h = **$18.43** | 10 GB × $0.10 = $1.00 | **~$20** |
| 1.0–5.0 NCU (moderate load, avg ~2 NCU) | 2 × 2.0 × $0.0128 × 720 h = **$36.86** | $1.00 | **~$38** |

### Dev/test: single writer, scale to zero when idle

Neptune does not support true scale-to-zero (minimum NCU is 1.0). A single
writer at 1.0 NCU minimum costs:

| | Cost |
|---|---|
| Compute (idle, 1 NCU, 720 h) | $9.22/month |
| Storage (10 GB min) | $1.00/month |
| Total | **~$10/month** |

### Comparison with the other options at ~1 GB, pre-launch

| Option | Hosting / mo | Dev-time / mo | SPOF | AWS-native |
|---|---|---|---|---|
| **Neptune Serverless (writer + reader, 1–5 NCU)** | **~$20–38** | ~0.5 h = $50 (one-time build) | **No** | **Yes** |
| Self-hosted Neo4j Community | ~$55 | ~$25 | Yes | Yes |
| AuraDB Professional (1 GB) | ~$65 | ~$50 | No | **No** |

Neptune Serverless at idle costs less than the current self-hosted design
and substantially less than AuraDB, *while being the only option that
combines HA and AWS-nativity.*

The dev-time cost for Neptune is higher one-time (building
`NeptuneServerlessConnection` + reworking `IGraphConnection`) but amortises
the same way the self-hosted shared construct would — once across the monorepo.

### Cost as graph grows (5 GB, growth phase)

| Option | Hosting / mo |
|---|---|
| Neptune Serverless (writer + reader, ~4 NCU avg) | ~$74 |
| Self-hosted Neo4j (t4g.large) | ~$55 |
| AuraDB Professional (5 GB) | ~$325 |

Neptune scales worse than self-hosted once compute demand grows, because
a multi-instance cluster (writer + reader) pays 2× the compute. However,
it is still dramatically cheaper than AuraDB at scale. The crossover with
self-hosted is around 3–6 NCU average load — well above pre-launch levels.

## Scaling behaviour edge cases

### Sudden spike from very low minimum

If the cluster is sitting at 1.0 NCU and receives a sudden traffic spike,
the first few scaling increments are small (0.5 NCU steps). There is a
brief period of elevated latency until capacity catches up — typically
seconds to low tens of seconds. For interactive user-facing queries this
is noticeable. Mitigation: set minimum to 2.0 NCU, accept ~$9/month higher
floor cost.

### The lookup cache is not available

Neptune's lookup cache (an in-memory index optimisation) is incompatible
with Serverless instances. For most OLTP graph workloads this is not
significant — the lookup cache helps with specific high-frequency ID lookups.
Worth monitoring via `MainRequestQueuePendingRequests` CloudWatch metric
if query latency is higher than expected.

## Open questions

- **Reserved capacity / Savings Plans.** Neptune does not currently offer
  Reserved Instances for Serverless — you always pay on-demand NCU pricing.
  Provisioned Neptune instances have RIs (~30% discount). If load patterns
  stabilise and a provisioned instance becomes right-sized, migration to
  provisioned with RI is an option at that point.
- **I/O cost monitoring.** Standard storage I/O charges are unpredictable
  at low load. Add a `VolumeReadIOPs` + `VolumeWriteIOPs` CloudWatch alarm
  from the start to catch surprise I/O bills before they compound.
