/**
 * Scaling Health Monitor
 *
 * Evaluates infrastructure metrics against the scaling plan thresholds
 * (doc/02-technical/development/misc/003-scaling-to-millions.md) and returns
 * clear indicators showing when each scaling phase should be triggered.
 */

import { CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

// Scaling phase definitions aligned with Plan 003
const SCALING_PHASES = [
  {
    id: 0,
    name: "Fix Connection Pool",
    description: "Singleton pool per process, properly sized",
    status: "critical",
  },
  {
    id: 1,
    name: "Vertical Scaling",
    description: "Upsize ECS tasks and/or RDS instance",
    status: "planned",
  },
  {
    id: 2,
    name: "Horizontal Scaling",
    description: "More ECS tasks, request-based auto-scaling",
    status: "planned",
  },
  {
    id: 3,
    name: "Redis Cache",
    description: "ElastiCache for feeds, friend lists, rate limits",
    status: "planned",
  },
  {
    id: 4,
    name: "RDS Proxy",
    description: "Managed connection pooler for >8 tasks",
    status: "planned",
  },
  {
    id: 5,
    name: "Read Replicas",
    description: "Read/write splitting for read-heavy workloads",
    status: "planned",
  },
  {
    id: 6,
    name: "CDN API Caching",
    description: "CloudFront caching for public API responses",
    status: "planned",
  },
  {
    id: 7,
    name: "Multi-Region",
    description: "Geographic distribution and data residency",
    status: "planned",
  },
] as const;

// RDS instance specs for pool sizing calculations
const RDS_INSTANCES: Record<
  string,
  { memory: string; maxConnections: number; usable: number }
> = {
  "db.t4g.micro": { memory: "1 GiB", maxConnections: 112, usable: 99 },
  "db.t4g.small": { memory: "2 GiB", maxConnections: 225, usable: 212 },
  "db.t4g.medium": { memory: "4 GiB", maxConnections: 450, usable: 437 },
  "db.r6g.large": { memory: "16 GiB", maxConnections: 1710, usable: 1697 },
};

export interface ScalingIndicator {
  name: string;
  value: number;
  unit: string;
  threshold: number;
  status: "green" | "yellow" | "red";
  message: string;
}

export interface ScalingPhaseStatus {
  id: number;
  name: string;
  description: string;
  status: "done" | "active" | "next" | "planned";
}

export interface ScalingHealthResult {
  currentPhase: number;
  phaseName: string;
  /**
   * `"unknown"` when a data source failed. "healthy" is derived from the
   * ABSENCE of red/yellow indicators, so a fetch failure — which removes the
   * indicators entirely rather than making them red — used to read as health.
   */
  overallStatus: "unknown" | "healthy" | "attention" | "action-needed";
  /**
   * Which sources answered. When `degraded`, the indicator list is missing
   * entries rather than reporting them as fine.
   */
  dataQuality: {
    degraded: boolean;
    unavailable: string[];
  };
  indicators: ScalingIndicator[];
  phases: ScalingPhaseStatus[];
  recommendations: string[];
  infrastructure: {
    rdsInstance: string;
    rdsMaxConnections: number;
    ecsTaskCount: number;
    ecsMaxTasks: number;
    poolMaxPerTask: number;
    poolConnectionModel: "per-request" | "singleton";
    totalUsers: number;
    estimatedDAU: number;
    estimatedMaxReqPerSec: number;
  };
  timestamp: string;
}

interface CloudWatchMetrics {
  rdsCpuPercent: number | null;
  rdsConnectionCount: number | null;
  rdsFreeMemoryBytes: number | null;
  /**
   * False when the fetch threw. Distinguishes "CloudWatch returned no
   * datapoint for this metric" from "we never got to ask" — both leave the
   * fields null, and only the second means the board is blind.
   */
  available: boolean;
}

async function getCloudWatchMetrics(
  stage: string,
  region: string,
  logger: Logger,
): Promise<CloudWatchMetrics> {
  const result: CloudWatchMetrics = {
    rdsCpuPercent: null,
    rdsConnectionCount: null,
    rdsFreeMemoryBytes: null,
    available: true,
  };

  try {
    const client = new CloudWatchClient({ region });
    const now = new Date();
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    // RDS instance identifier follows CDK naming: lowercase stage + alphanumeric
    const dbInstanceId = `trellis-${stage}`;

    const response = await client.send(
      new GetMetricDataCommand({
        StartTime: fiveMinutesAgo,
        EndTime: now,
        MetricDataQueries: [
          {
            Id: "cpu",
            MetricStat: {
              Metric: {
                Namespace: "AWS/RDS",
                MetricName: "CPUUtilization",
                Dimensions: [
                  { Name: "DBInstanceIdentifier", Value: dbInstanceId },
                ],
              },
              Period: 300,
              Stat: "Average",
            },
          },
          {
            Id: "connections",
            MetricStat: {
              Metric: {
                Namespace: "AWS/RDS",
                MetricName: "DatabaseConnections",
                Dimensions: [
                  { Name: "DBInstanceIdentifier", Value: dbInstanceId },
                ],
              },
              Period: 300,
              Stat: "Average",
            },
          },
          {
            Id: "freemem",
            MetricStat: {
              Metric: {
                Namespace: "AWS/RDS",
                MetricName: "FreeableMemory",
                Dimensions: [
                  { Name: "DBInstanceIdentifier", Value: dbInstanceId },
                ],
              },
              Period: 300,
              Stat: "Average",
            },
          },
        ],
      }),
    );

    for (const metricResult of response.MetricDataResults || []) {
      const value = metricResult.Values?.[0];
      if (value === undefined) continue;

      switch (metricResult.Id) {
        case "cpu":
          result.rdsCpuPercent = Math.round(value * 10) / 10;
          break;
        case "connections":
          result.rdsConnectionCount = Math.round(value);
          break;
        case "freemem":
          result.rdsFreeMemoryBytes = Math.round(value);
          break;
      }
    }
  } catch (error: any) {
    logger.warn("[ScalingHealth] Failed to fetch CloudWatch metrics", {
      error: error?.message,
    });
    result.available = false;
  }

  return result;
}

export async function evaluateScalingHealth(
  env: {
    STAGE?: string;
    AWS_REGION?: string;
    DATABASE_POOL_MAX?: string;
    LOG_LEVEL?: string;
  },
  userCount: number,
  recentActiveUsers: number,
): Promise<ScalingHealthResult> {
  const logger = getLogger();
  const stage = env.STAGE || "dev";
  const region = env.AWS_REGION || "eu-central-1";

  // Determine current infrastructure from stage
  const isDev = stage === "dev";
  // Both dev and prod start on db.t4g.micro; prod upsizes to db.t4g.small at Phase 1
  const rdsInstance = "db.t4g.micro";
  const rdsSpec = RDS_INSTANCES[rdsInstance]!;
  const maxTasks = isDev ? 2 : 4;
  const currentDesiredTasks = isDev ? 1 : 2;

  // Pool configuration
  const poolMax = parseInt(env.DATABASE_POOL_MAX || "1", 10);
  const isSingletonPool = poolMax > 1;
  const poolConnectionModel = isSingletonPool ? "singleton" : "per-request";

  // Fetch CloudWatch metrics
  const cwMetrics = await getCloudWatchMetrics(stage, region, logger);

  // Calculate capacity
  const recommendedPoolMax = Math.floor(
    rdsSpec.usable / (maxTasks * 2),
  );
  const totalPoolConnections = poolMax * currentDesiredTasks;
  const estimatedMaxReqPerSec = isSingletonPool
    ? Math.round((poolMax * currentDesiredTasks) / 0.01) // 10ms per query
    : Math.round(currentDesiredTasks * 20); // ~20 req/s per task with per-request pools

  // Build indicators
  const indicators: ScalingIndicator[] = [];
  const recommendations: string[] = [];

  // 1. Connection pool model
  if (!isSingletonPool) {
    indicators.push({
      name: "Connection Pool",
      value: poolMax,
      unit: "max per pool",
      threshold: 10,
      status: "red",
      message: "Per-request pooling — cannot scale beyond ~20 concurrent requests",
    });
    recommendations.push(
      "CRITICAL: Implement Phase 0 — fix connection pool to singleton pattern (Plan 002)",
    );
  } else {
    indicators.push({
      name: "Connection Pool",
      value: poolMax,
      unit: "max per task",
      threshold: recommendedPoolMax,
      status: poolMax <= recommendedPoolMax ? "green" : "yellow",
      message: isSingletonPool
        ? `Singleton pool (${poolMax}/${recommendedPoolMax} recommended max)`
        : "Per-request pool",
    });
  }

  // 2. RDS CPU
  if (cwMetrics.rdsCpuPercent !== null) {
    const cpuStatus =
      cwMetrics.rdsCpuPercent > 80
        ? "red"
        : cwMetrics.rdsCpuPercent > 60
          ? "yellow"
          : "green";
    indicators.push({
      name: "RDS CPU",
      value: cwMetrics.rdsCpuPercent,
      unit: "%",
      threshold: 70,
      status: cpuStatus,
      message:
        cpuStatus === "red"
          ? "CPU critical — upsize RDS instance (Phase 1)"
          : cpuStatus === "yellow"
            ? "CPU elevated — monitor for sustained usage"
            : "CPU healthy",
    });
    if (cpuStatus === "red") {
      recommendations.push(
        `Upsize RDS from ${rdsInstance} to next tier (Phase 1)`,
      );
    }
  }

  // 3. RDS Connections
  if (cwMetrics.rdsConnectionCount !== null) {
    const connPercent = Math.round(
      (cwMetrics.rdsConnectionCount / rdsSpec.maxConnections) * 100,
    );
    const connStatus =
      connPercent > 80 ? "red" : connPercent > 60 ? "yellow" : "green";
    indicators.push({
      name: "RDS Connections",
      value: cwMetrics.rdsConnectionCount,
      unit: `/ ${rdsSpec.maxConnections}`,
      threshold: Math.round(rdsSpec.maxConnections * 0.8),
      status: connStatus,
      message:
        connStatus === "red"
          ? "Connections critical — consider RDS Proxy (Phase 4)"
          : connStatus === "yellow"
            ? "Connections elevated — check pool sizing"
            : `${connPercent}% of max connections used`,
    });
    if (connStatus === "red") {
      recommendations.push(
        "Connection count approaching RDS limit — evaluate RDS Proxy (Phase 4)",
      );
    }
  }

  // 4. RDS Free Memory
  if (cwMetrics.rdsFreeMemoryBytes !== null) {
    const freeMemMB = Math.round(cwMetrics.rdsFreeMemoryBytes / 1024 / 1024);
    const memStatus =
      freeMemMB < 100 ? "red" : freeMemMB < 256 ? "yellow" : "green";
    indicators.push({
      name: "RDS Free Memory",
      value: freeMemMB,
      unit: "MB",
      threshold: 100,
      status: memStatus,
      message:
        memStatus === "red"
          ? "Memory critical — upsize RDS instance"
          : memStatus === "yellow"
            ? "Memory low — monitor closely"
            : "Memory healthy",
    });
    if (memStatus === "red") {
      recommendations.push(
        `RDS free memory below 100 MB — upsize from ${rdsInstance}`,
      );
    }
  }

  // 5. User growth
  const dauPercentOfCapacity = Math.round(
    (recentActiveUsers / (estimatedMaxReqPerSec * 10)) * 100, // rough: 0.1 req/s per DAU, *10 = DAU capacity
  );
  indicators.push({
    name: "User Capacity",
    value: recentActiveUsers,
    unit: "active users (7d)",
    threshold: Math.round(estimatedMaxReqPerSec * 10),
    status:
      dauPercentOfCapacity > 80
        ? "red"
        : dauPercentOfCapacity > 50
          ? "yellow"
          : "green",
    message: `${dauPercentOfCapacity}% of estimated capacity (${userCount} registered)`,
  });

  // 6. Connection headroom during deploy
  const deployConnections = totalPoolConnections * 2; // Rolling deploy doubles
  const deployHeadroom = Math.round(
    ((rdsSpec.usable - deployConnections) / rdsSpec.usable) * 100,
  );
  const deployStatus =
    deployHeadroom < 20 ? "red" : deployHeadroom < 40 ? "yellow" : "green";
  indicators.push({
    name: "Deploy Headroom",
    value: deployHeadroom,
    unit: "% free during deploy",
    threshold: 20,
    status: deployStatus,
    message:
      deployStatus === "red"
        ? "Rolling deploys risk connection exhaustion"
        : `${deployConnections} connections during deploy / ${rdsSpec.usable} usable`,
  });
  if (deployStatus === "red") {
    recommendations.push(
      "Pool size too high for deploy safety — reduce pool max or upsize RDS",
    );
  }

  // Determine current phase
  let currentPhase = 0;
  if (!isSingletonPool) {
    currentPhase = 0; // Phase 0 not done yet
  } else if (
    (cwMetrics.rdsCpuPercent !== null && cwMetrics.rdsCpuPercent > 70) ||
    deployHeadroom < 20
  ) {
    currentPhase = 1; // Need vertical scaling
  } else if (maxTasks <= 4 && dauPercentOfCapacity > 50) {
    currentPhase = 2; // Need horizontal scaling
  } else {
    currentPhase = isSingletonPool ? 1 : 0; // Phase 0 done, approaching Phase 1
  }

  // Build phase statuses
  const phases: ScalingPhaseStatus[] = SCALING_PHASES.map((phase) => ({
    id: phase.id,
    name: phase.name,
    description: phase.description,
    status:
      phase.id < currentPhase
        ? "done"
        : phase.id === currentPhase
          ? "active"
          : phase.id === currentPhase + 1
            ? "next"
            : "planned",
  }));

  // Override Phase 0 status based on pool config
  if (isSingletonPool) {
    phases[0].status = "done";
  }

  // Overall status. "healthy" is the ABSENCE of red/yellow, and a failed fetch
  // produces that absence by removing the RDS indicators altogether — so
  // without this check a blind board is indistinguishable from a healthy one.
  // A surviving indicator that IS red or yellow still wins: degraded is a
  // floor, not a ceiling.
  const degraded = !cwMetrics.available;
  const unavailable = degraded ? ["cloudwatch-rds"] : [];
  const hasRed = indicators.some((i) => i.status === "red");
  const hasYellow = indicators.some((i) => i.status === "yellow");
  const overallStatus: ScalingHealthResult["overallStatus"] = hasRed
    ? "action-needed"
    : hasYellow
      ? "attention"
      : degraded
        ? "unknown"
        : "healthy";

  if (degraded) {
    // Precedes and suppresses the all-clear: with RDS metrics missing there is
    // no basis for "all indicators are healthy" — three of them are absent.
    recommendations.push(
      "Scaling health is INCOMPLETE — RDS CPU, connection-count and free-memory " +
        "metrics are unavailable, so those indicators are missing rather than green. " +
        "Treat the phase assessment below as provisional.",
    );
  } else if (recommendations.length === 0) {
    recommendations.push("All scaling indicators are healthy. No action needed.");
  }

  return {
    currentPhase,
    phaseName: SCALING_PHASES[currentPhase]?.name || "Unknown",
    overallStatus,
    dataQuality: { degraded, unavailable },
    indicators,
    phases,
    recommendations,
    infrastructure: {
      rdsInstance,
      rdsMaxConnections: rdsSpec.maxConnections,
      ecsTaskCount: currentDesiredTasks,
      ecsMaxTasks: maxTasks,
      poolMaxPerTask: poolMax,
      poolConnectionModel,
      totalUsers: userCount,
      estimatedDAU: recentActiveUsers,
      estimatedMaxReqPerSec,
    },
    timestamp: new Date().toISOString(),
  };
}
