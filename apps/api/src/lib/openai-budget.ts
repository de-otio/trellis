/**
 * OpenAI Request Budget
 *
 * Tracks OpenAI API calls per hour/day using atomic DynamoDB counters.
 * When the budget is exceeded, returns false so callers can skip the API call.
 * Fail-open: if DynamoDB is unavailable, allows the call through.
 */

import { DynamoDBClient,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { getLogger, Logger } from "./logger.js";

export interface OpenAiBudgetConfig {
  enabled: boolean;
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
}

export interface OpenAiBudgetStatus {
  hourlyUsed: number;
  hourlyLimit: number;
  dailyUsed: number;
  dailyLimit: number;
  exceeded: boolean;
}

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "us-east-1",
  ...(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
});

const TABLE_NAME = process.env.DYNAMODB_TABLE || `${process.env.STAGE || "dev"}-trellis`;

export class OpenAiBudget {
  private config: OpenAiBudgetConfig;
  private logger = getLogger();

  constructor(config: OpenAiBudgetConfig) {
    this.config = config;
  }

  /**
   * Try to consume one OpenAI request from the budget.
   * Returns true if the call is allowed, false if budget is exceeded.
   * Fail-open: returns true on any DynamoDB error.
   */
  async tryConsume(): Promise<boolean> {
    if (!this.config.enabled) return true;

    try {
      const now = new Date();
      const hourlyKey = `openai:hourly:${now.toISOString().slice(0, 13)}`;
      const dailyKey = `openai:daily:${now.toISOString().slice(0, 10)}`;

      // Atomically increment hourly counter
      const hourlyCount = await this.atomicIncrement(hourlyKey, 7200);
      if (hourlyCount > this.config.maxRequestsPerHour) {
        this.logger.warn("[OpenAiBudget] Hourly budget exceeded", {
          hourlyCount,
          limit: this.config.maxRequestsPerHour,
        });
        return false;
      }

      // Atomically increment daily counter
      const dailyCount = await this.atomicIncrement(dailyKey, 172800);
      if (dailyCount > this.config.maxRequestsPerDay) {
        this.logger.warn("[OpenAiBudget] Daily budget exceeded", {
          dailyCount,
          limit: this.config.maxRequestsPerDay,
        });
        return false;
      }

      return true;
    } catch (error) {
      // Fail-open: if DynamoDB is down, allow the call
      this.logger.warn("[OpenAiBudget] Counter error, failing open", { error });
      return true;
    }
  }

  /**
   * Read-only status check for the health/admin endpoint.
   * Does not increment counters.
   */
  async getStatus(): Promise<OpenAiBudgetStatus> {
    if (!this.config.enabled) {
      return {
        hourlyUsed: 0,
        hourlyLimit: this.config.maxRequestsPerHour,
        dailyUsed: 0,
        dailyLimit: this.config.maxRequestsPerDay,
        exceeded: false,
      };
    }

    try {
      const now = new Date();
      const hourlyKey = `openai:hourly:${now.toISOString().slice(0, 13)}`;
      const dailyKey = `openai:daily:${now.toISOString().slice(0, 10)}`;

      const [hourlyUsed, dailyUsed] = await Promise.all([
        this.readCounter(hourlyKey),
        this.readCounter(dailyKey),
      ]);

      return {
        hourlyUsed,
        hourlyLimit: this.config.maxRequestsPerHour,
        dailyUsed,
        dailyLimit: this.config.maxRequestsPerDay,
        exceeded:
          hourlyUsed >= this.config.maxRequestsPerHour ||
          dailyUsed >= this.config.maxRequestsPerDay,
      };
    } catch {
      return {
        hourlyUsed: 0,
        hourlyLimit: this.config.maxRequestsPerHour,
        dailyUsed: 0,
        dailyLimit: this.config.maxRequestsPerDay,
        exceeded: false,
      };
    }
  }

  /**
   * Atomically increment a counter in DynamoDB using ADD expression.
   * Returns the post-increment value.
   */
  private async atomicIncrement(key: string, ttlSeconds: number): Promise<number> {
    const result = await dynamoClient.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `costbudget:${key}` },
          sk: { S: "v" },
        },
        UpdateExpression: "ADD #count :inc SET #ttl = if_not_exists(#ttl, :ttl)",
        ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
        ExpressionAttributeValues: {
          ":inc": { N: "1" },
          ":ttl": { N: String(Math.floor(Date.now() / 1000) + ttlSeconds) },
        },
        ReturnValues: "ALL_NEW",
      }),
    );
    return parseInt(result.Attributes?.count?.N || "0", 10);
  }

  /**
   * Read a counter value without incrementing.
   */
  private async readCounter(key: string): Promise<number> {
    const { GetItemCommand } = await import("@aws-sdk/client-dynamodb");
    const result = await dynamoClient.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: {
          pk: { S: `costbudget:${key}` },
          sk: { S: "v" },
        },
        ProjectionExpression: "#count",
        ExpressionAttributeNames: { "#count": "count" },
      }),
    );
    return parseInt(result.Item?.count?.N || "0", 10);
  }
}
