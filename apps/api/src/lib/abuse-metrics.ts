/**
 * Abuse Metrics Monitor
 *
 * Fetches WAF, rate-limiting, and auth abuse metrics from CloudWatch
 * for the admin abuse dashboard.
 */

import { CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataResult,
} from "@aws-sdk/client-cloudwatch";
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { getLogger, Logger, type LoggerEnv } from "./logger.js";

export interface AbuseMetricPoint {
  timestamp: string;
  value: number;
}

export interface AbuseRuleMetrics {
  name: string;
  allowed: number;
  blocked: number;
  trend: AbuseMetricPoint[];
}

export interface AuthAbuseMetrics {
  rateLimitExceeded: number;
  magicLinkRequests: number;
  failedVerifications: number;
}

export interface AbuseMetricsResult {
  timeRange: string;
  /**
   * `"unknown"` when a data source failed. The other four values all assert a
   * *measurement*, so none of them can honestly describe a board built from
   * missing data — a failed fetch used to read as `"low"`.
   */
  overallStatus: "unknown" | "low" | "moderate" | "high" | "critical";
  /**
   * Which sources actually answered. `degraded` is true when any did not, in
   * which case the counts below are floors, not totals.
   */
  dataQuality: {
    degraded: boolean;
    unavailable: string[];
  };
  summary: {
    totalAllowed: number;
    totalBlocked: number;
    blockRate: number;
  };
  wafRules: AbuseRuleMetrics[];
  authAbuse: AuthAbuseMetrics;
  topBlockedIps: Array<{ ip: string; count: number }>;
  recommendations: string[];
  timestamp: string;
}

interface WafMetrics {
  rateLimit: { allowed: number; blocked: number; trend: AbuseMetricPoint[] };
  commonRules: { allowed: number; blocked: number; trend: AbuseMetricPoint[] };
  botControl: { allowed: number; blocked: number; trend: AbuseMetricPoint[] } | null;
}

function sumValues(result: MetricDataResult | undefined): number {
  if (!result?.Values?.length) return 0;
  return result.Values.reduce((a, b) => a + b, 0);
}

function buildTrend(result: MetricDataResult | undefined): AbuseMetricPoint[] {
  if (!result?.Timestamps?.length || !result?.Values?.length) return [];
  return result.Timestamps.map((ts, i) => ({
    timestamp: ts.toISOString(),
    value: result.Values![i],
  })).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

const TIME_RANGES: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

async function getWafMetrics(
  client: CloudWatchClient,
  stage: string,
  startTime: Date,
  endTime: Date,
  period: number,
): Promise<WafMetrics> {
  const webAclName = `trellis-${stage}-alb-waf`;

  const queries = [
    // Rate limit
    {
      Id: "rl_allowed",
      MetricStat: {
        Metric: {
          Namespace: "AWS/WAFV2",
          MetricName: "AllowedRequests",
          Dimensions: [
            { Name: "WebACL", Value: webAclName },
            { Name: "Region", Value: "us-east-1" },
            { Name: "Rule", Value: "RateLimit" },
          ],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "rl_blocked",
      MetricStat: {
        Metric: {
          Namespace: "AWS/WAFV2",
          MetricName: "BlockedRequests",
          Dimensions: [
            { Name: "WebACL", Value: webAclName },
            { Name: "Region", Value: "us-east-1" },
            { Name: "Rule", Value: "RateLimit" },
          ],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    // Common rules
    {
      Id: "cr_allowed",
      MetricStat: {
        Metric: {
          Namespace: "AWS/WAFV2",
          MetricName: "AllowedRequests",
          Dimensions: [
            { Name: "WebACL", Value: webAclName },
            { Name: "Region", Value: "us-east-1" },
            { Name: "Rule", Value: "AWSManagedRulesCommonRuleSet" },
          ],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "cr_blocked",
      MetricStat: {
        Metric: {
          Namespace: "AWS/WAFV2",
          MetricName: "BlockedRequests",
          Dimensions: [
            { Name: "WebACL", Value: webAclName },
            { Name: "Region", Value: "us-east-1" },
            { Name: "Rule", Value: "AWSManagedRulesCommonRuleSet" },
          ],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    // Bot control (may not exist)
    {
      Id: "bc_allowed",
      MetricStat: {
        Metric: {
          Namespace: "AWS/WAFV2",
          MetricName: "AllowedRequests",
          Dimensions: [
            { Name: "WebACL", Value: webAclName },
            { Name: "Region", Value: "us-east-1" },
            { Name: "Rule", Value: "BotControl" },
          ],
        },
        Period: period,
        Stat: "Sum",
      },
    },
    {
      Id: "bc_blocked",
      MetricStat: {
        Metric: {
          Namespace: "AWS/WAFV2",
          MetricName: "BlockedRequests",
          Dimensions: [
            { Name: "WebACL", Value: webAclName },
            { Name: "Region", Value: "us-east-1" },
            { Name: "Rule", Value: "BotControl" },
          ],
        },
        Period: period,
        Stat: "Sum",
      },
    },
  ];

  const response = await client.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: queries,
    }),
  );

  const byId = new Map<string, MetricDataResult>();
  for (const result of response.MetricDataResults || []) {
    if (result.Id) byId.set(result.Id, result);
  }

  const bcAllowed = sumValues(byId.get("bc_allowed"));
  const bcBlocked = sumValues(byId.get("bc_blocked"));
  const hasBotControl = bcAllowed > 0 || bcBlocked > 0;

  return {
    rateLimit: {
      allowed: sumValues(byId.get("rl_allowed")),
      blocked: sumValues(byId.get("rl_blocked")),
      trend: buildTrend(byId.get("rl_blocked")),
    },
    commonRules: {
      allowed: sumValues(byId.get("cr_allowed")),
      blocked: sumValues(byId.get("cr_blocked")),
      trend: buildTrend(byId.get("cr_blocked")),
    },
    botControl: hasBotControl
      ? {
          allowed: bcAllowed,
          blocked: bcBlocked,
          trend: buildTrend(byId.get("bc_blocked")),
        }
      : null,
  };
}

async function getAuthAbuseFromLogs(
  logsClient: CloudWatchLogsClient,
  stage: string,
  startTime: Date,
  endTime: Date,
  logger: Logger,
): Promise<{ metrics: AuthAbuseMetrics; available: boolean }> {
  const defaults: AuthAbuseMetrics = {
    rateLimitExceeded: 0,
    magicLinkRequests: 0,
    failedVerifications: 0,
  };
  // Zeroes are returned on both "genuinely nothing happened" and "the query
  // failed". Only the caller can tell those apart, and only if we say which
  // one this was — hence `available` rather than a bare metrics object.
  const unavailable = { metrics: defaults, available: false };

  try {
    const logGroupName = `/trellis/${stage}/api`;

    const queryString = `
      fields @timestamp, @message
      | filter @message like /RATE_LIMIT_EXCEEDED/ or @message like /magic-rate:/ or @message like /VERIFY_FAILED/
      | stats
        count_distinct(@message) as total,
        sum(strcontains(@message, "RATE_LIMIT_EXCEEDED")) as rateLimited,
        sum(strcontains(@message, "magic-rate:")) as magicLinks,
        sum(strcontains(@message, "VERIFY_FAILED")) as failedVerify
    `;

    const startQuery = await logsClient.send(
      new StartQueryCommand({
        logGroupName,
        startTime: Math.floor(startTime.getTime() / 1000),
        endTime: Math.floor(endTime.getTime() / 1000),
        queryString,
      }),
    );

    if (!startQuery.queryId) return unavailable;

    // Poll for results with a max of 5 attempts
    for (let attempt = 0; attempt < 5; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const results = await logsClient.send(
        new GetQueryResultsCommand({ queryId: startQuery.queryId }),
      );

      if (results.status === "Complete") {
        if (results.results?.length) {
          const row = results.results[0];
          const getValue = (field: string): number => {
            const f = row.find((r) => r.field === field);
            return f?.value ? parseInt(f.value, 10) || 0 : 0;
          };
          return {
            metrics: {
              rateLimitExceeded: getValue("rateLimited"),
              magicLinkRequests: getValue("magicLinks"),
              failedVerifications: getValue("failedVerify"),
            },
            available: true,
          };
        }
        // Completed with no rows: the query genuinely found nothing. This is
        // the one zero that is a real measurement.
        return { metrics: defaults, available: true };
      }

      if (results.status === "Failed" || results.status === "Cancelled") {
        return unavailable;
      }
    }
  } catch (error: any) {
    logger.warn("[AbuseMetrics] Failed to query auth abuse logs", {
      error: error?.message,
    });
    return unavailable;
  }

  // Fell out of the poll loop without ever reaching Complete — the query timed
  // out. No answer, so not an answer of zero.
  return unavailable;
}

export async function evaluateAbuseMetrics(
  env: {
    STAGE?: string;
    AWS_REGION?: string;
    LOG_LEVEL?: string;
  },
  timeRange: string = "24h",
): Promise<AbuseMetricsResult> {
  const logger = getLogger();
  const stage = env.STAGE || "dev";
  const region = env.AWS_REGION || "us-east-1";

  const rangeMs = TIME_RANGES[timeRange] || TIME_RANGES["24h"];
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - rangeMs);

  // Period: 5 min for 1h/6h, 1 hour for 24h, 6 hours for 7d
  const period =
    rangeMs <= 6 * 60 * 60 * 1000
      ? 300
      : rangeMs <= 24 * 60 * 60 * 1000
        ? 3600
        : 21600;

  const cwClient = new CloudWatchClient({ region });
  const logsClient = new CloudWatchLogsClient({ region });

  const unavailableSources: string[] = [];

  const [wafMetrics, authAbuseResult] = await Promise.all([
    getWafMetrics(cwClient, stage, startTime, endTime, period).catch(
      (error) => {
        logger.warn("[AbuseMetrics] Failed to fetch WAF metrics", {
          error: error?.message,
        });
        unavailableSources.push("waf");
        return {
          rateLimit: { allowed: 0, blocked: 0, trend: [] },
          commonRules: { allowed: 0, blocked: 0, trend: [] },
          botControl: null,
        } as WafMetrics;
      },
    ),
    getAuthAbuseFromLogs(logsClient, stage, startTime, endTime, logger),
  ]);

  const authAbuse = authAbuseResult.metrics;
  if (!authAbuseResult.available) unavailableSources.push("auth-logs");
  const degraded = unavailableSources.length > 0;

  // Build WAF rules array
  const wafRules: AbuseRuleMetrics[] = [
    {
      name: "IP Rate Limit",
      allowed: wafMetrics.rateLimit.allowed,
      blocked: wafMetrics.rateLimit.blocked,
      trend: wafMetrics.rateLimit.trend,
    },
    {
      name: "Common Rule Set",
      allowed: wafMetrics.commonRules.allowed,
      blocked: wafMetrics.commonRules.blocked,
      trend: wafMetrics.commonRules.trend,
    },
  ];

  if (wafMetrics.botControl) {
    wafRules.push({
      name: "Bot Control",
      allowed: wafMetrics.botControl.allowed,
      blocked: wafMetrics.botControl.blocked,
      trend: wafMetrics.botControl.trend,
    });
  }

  // Summary
  const totalBlocked = wafRules.reduce((s, r) => s + r.blocked, 0);
  const totalAllowed = wafRules.reduce((s, r) => s + r.allowed, 0);
  const totalRequests = totalAllowed + totalBlocked;
  const blockRate =
    totalRequests > 0
      ? Math.round((totalBlocked / totalRequests) * 10000) / 100
      : 0;

  // Overall status. A threshold comparison against absent data is not a
  // measurement, so a degraded board reports "unknown" rather than the "low"
  // that zeroed counters would otherwise produce. The escalating branches are
  // still evaluated: partial data can only ever raise the floor, and a real
  // signal from a surviving source must not be masked by the other's failure.
  let overallStatus: AbuseMetricsResult["overallStatus"] = degraded
    ? "unknown"
    : "low";
  if (blockRate > 20 || authAbuse.rateLimitExceeded > 50) {
    overallStatus = "critical";
  } else if (blockRate > 10 || authAbuse.rateLimitExceeded > 20) {
    overallStatus = "high";
  } else if (blockRate > 5 || authAbuse.rateLimitExceeded > 5) {
    overallStatus = "moderate";
  }

  // Recommendations
  const recommendations: string[] = [];

  if (!wafMetrics.botControl) {
    recommendations.push(
      "Bot Control is not enabled. Enable WAF Bot Control (Targeted) in prod for browser fingerprinting-based bot detection.",
    );
  }

  if (wafMetrics.rateLimit.blocked > 0) {
    recommendations.push(
      `${wafMetrics.rateLimit.blocked} requests blocked by IP rate limit. Review if the threshold is appropriate for shared-NAT scenarios.`,
    );
  }

  if (authAbuse.rateLimitExceeded > 10) {
    recommendations.push(
      `${authAbuse.rateLimitExceeded} magic link rate limits hit. Consider enabling reCAPTCHA enforcement in the Cognito challenge Lambda.`,
    );
  }

  if (degraded) {
    // Must come before the all-clear below, and must suppress it. "No abuse
    // concerns detected" is a claim about the data; with a source down there
    // is no data to make it about.
    recommendations.push(
      `Abuse metrics are INCOMPLETE — no data from: ${unavailableSources.join(", ")}. ` +
        `The counts shown are floors, not totals, and the absence of a signal here ` +
        `does not mean the absence of abuse.`,
    );
  } else if (recommendations.length === 0) {
    recommendations.push("No abuse concerns detected in this time period.");
  }

  return {
    timeRange,
    overallStatus,
    dataQuality: { degraded, unavailable: unavailableSources },
    summary: {
      totalAllowed,
      totalBlocked,
      blockRate,
    },
    wafRules,
    authAbuse,
    topBlockedIps: [], // Requires WAF logging to S3/Kinesis — placeholder for future
    recommendations,
    timestamp: new Date().toISOString(),
  };
}
