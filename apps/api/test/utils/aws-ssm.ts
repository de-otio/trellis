/**
 * AWS SSM Parameter Store Utilities for Tests
 *
 * Uses AWS Powertools Parameters utility for efficient caching and KMS usage reduction.
 * Falls back to environment variables for local development.
 */

import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";

/**
 * Get AWS region from environment or config
 */
function getAwsRegion(): string {
  // Try environment variable first
  if (process.env.AWS_REGION) {
    return process.env.AWS_REGION;
  }

  // Try to read from config.yaml (for dev/prod environments)
  try {
    const environment =
      process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";
    const configPath = path.join(
      process.cwd(),
      "environments",
      environment,
      "config.yaml",
    );

    if (fs.existsSync(configPath)) {
      const config = yaml.load(fs.readFileSync(configPath, "utf8"));
      if (config?.AWS_REGION) {
        return config.AWS_REGION;
      }
    }
  } catch (error) {
    // Ignore errors reading config file
  }

  // Default to eu-central-1 (matches scripts/load-aws-secrets.sh)
  return "eu-central-1";
}

/**
 * Get environment name (dev or prod)
 */
function getEnvironment(): string {
  return process.env.ENVIRONMENT || process.env.DEPLOY_ENV || "dev";
}

/**
 * Get or create SSMProvider instance with caching
 * Powertools automatically caches parameters to minimize KMS calls
 */
let ssmProviderInstance: SSMProvider | null = null;

function getSsmProvider(region: string): SSMProvider {
  if (!ssmProviderInstance) {
    ssmProviderInstance = new SSMProvider({
      clientConfig: {
        region,
      },
    });
  }
  return ssmProviderInstance;
}

/**
 * Get parameter path for a secret
 */
function getParameterPath(secretName: string, environment?: string): string {
  const env = environment || getEnvironment();

  const pathMap: Record<string, string> = {
    DATABASE_URL: `/trellis/${env}/database/hyperdrive/url`,
    DIRECT_DATABASE_URL: `/trellis/${env}/supabase/database/url`,
    SESSION_SECRET: `/trellis/${env}/session/secret`,
    SESSION_SALT: `/trellis/${env}/session/salt`,
    OPENAI_API_KEY: `/trellis/${env}/backend/openai/api/key`,
  };

  return (
    pathMap[secretName] ||
    `/trellis/${env}/${secretName.toLowerCase().replace(/_/g, "/")}`
  );
}

/**
 * Clear the parameter cache (useful for testing or when secrets are rotated)
 * Powertools uses an internal cache that can be cleared by resetting the provider
 */
export function clearParameterCache(): void {
  // Reset the provider instance to clear cache
  ssmProviderInstance = null;
  console.log("[clearParameterCache] Powertools SSMProvider cache cleared");
}

/**
 * Fetch a single parameter from AWS SSM using Powertools
 * Powertools automatically caches parameters to minimize KMS calls
 */
export async function getSsmParameter(
  secretName: string,
  options: {
    environment?: string;
    region?: string;
    required?: boolean;
  } = {},
): Promise<string | null> {
  const { environment, region, required = false } = options;
  const env = environment || getEnvironment();
  const awsRegion = region || getAwsRegion();
  const parameterPath = getParameterPath(secretName, env);

  // First, try environment variable (for local development)
  // BUT: Skip if it's the test secret (for postdeployment tests, we want to use SSM)
  const envVarName = secretName;
  const testSecret = "test-secret-key-32-characters-long!!";
  if (process.env[envVarName] && process.env[envVarName] !== testSecret) {
    console.log(
      `[getSsmParameter] Found ${secretName} in environment variable, length: ${process.env[envVarName]?.length}, first 4: ${process.env[envVarName]?.substring(0, 4)}`,
    );
    return process.env[envVarName];
  }
  if (process.env[envVarName] === testSecret) {
    console.log(
      `[getSsmParameter] ${secretName} is set to test secret, skipping env var and checking SSM...`,
    );
  } else {
    console.log(
      `[getSsmParameter] ${secretName} not in environment, checking SSM...`,
    );
  }

  // If AWS credentials are not configured, return null or throw
  const hasCredentials =
    process.env.AWS_PROFILE ||
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  if (!hasCredentials) {
    if (required) {
      throw new Error(
        `AWS credentials not configured and ${envVarName} not found in environment. ` +
          `Either set ${envVarName} or configure AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optionally AWS_SESSION_TOKEN for temporary credentials).`,
      );
    }
    return null;
  }

  try {
    // Use Powertools SSMProvider with caching
    // maxAge: 3600 seconds (1 hour) - reduces KMS calls significantly
    // decrypt: true - required for SecureString parameters
    const provider = getSsmProvider(awsRegion);
    const value = await provider.get(parameterPath, {
      maxAge: 3600, // Cache for 1 hour (3600 seconds)
      decrypt: true,
    });

    if (value) {
      console.log(
        `[getSsmParameter] Retrieved ${secretName} from SSM path ${parameterPath} (cached by Powertools)`,
      );
      return value as string;
    } else {
      console.log(
        `[getSsmParameter] SSM parameter ${parameterPath} not found or has no value`,
      );
      return null;
    }
  } catch (error: any) {
    // If parameter doesn't exist and not required, return null
    if (error.name === "ParameterNotFound" && !required) {
      return null;
    }

    // If access denied, fall back to environment variable or throw
    if (
      error.name === "AccessDeniedException" ||
      error.name === "UnauthorizedOperation"
    ) {
      if (required) {
        throw new Error(
          `Access denied to SSM parameter ${parameterPath}. ` +
            `Either set ${envVarName} environment variable or configure AWS credentials with proper permissions.`,
        );
      }
      return null;
    }

    // For other errors, throw if required, otherwise return null
    if (required) {
      throw new Error(
        `Failed to fetch SSM parameter ${parameterPath}: ${error.message}`,
      );
    }

    return null;
  }
}

/**
 * Fetch multiple parameters from AWS SSM using Powertools
 * Powertools automatically caches parameters to minimize KMS calls
 */
export async function getSsmParameters(
  secretNames: string[],
  options: {
    environment?: string;
    region?: string;
    required?: boolean;
  } = {},
): Promise<Record<string, string | null>> {
  const { environment, region, required = false } = options;
  const env = environment || getEnvironment();
  const awsRegion = region || getAwsRegion();

  // First, check environment variables
  const result: Record<string, string | null> = {};
  const missingFromEnv: string[] = [];

  for (const secretName of secretNames) {
    const envVarName = secretName;
    if (process.env[envVarName]) {
      result[secretName] = process.env[envVarName];
    } else {
      missingFromEnv.push(secretName);
    }
  }

  // If all found in environment, return early
  if (missingFromEnv.length === 0) {
    return result;
  }

  // If AWS credentials are not configured, return what we have
  const hasCredentials =
    process.env.AWS_PROFILE ||
    (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

  if (!hasCredentials) {
    if (required && missingFromEnv.length > 0) {
      throw new Error(
        `AWS credentials not configured and missing environment variables: ${missingFromEnv.join(", ")}. ` +
          `Either set these environment variables or configure AWS credentials (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and optionally AWS_SESSION_TOKEN for temporary credentials).`,
      );
    }
    return result;
  }

  // Fetch missing parameters from SSM using Powertools
  const parameterPaths = missingFromEnv.map((name) =>
    getParameterPath(name, env),
  );

  try {
    // Use Powertools SSMProvider with caching
    // maxAge: 3600 seconds (1 hour) - reduces KMS calls significantly
    // decrypt: true - required for SecureString parameters
    const provider = getSsmProvider(awsRegion);
    const values = await provider.getMultiple(parameterPaths, {
      maxAge: 3600, // Cache for 1 hour
      decrypt: true,
    });

    // Map results back to secret names
    const allParams: Record<string, string | null> = { ...result };

    for (let i = 0; i < parameterPaths.length; i++) {
      const paramPath = parameterPaths[i];
      const secretName = missingFromEnv[i];
      const value = values[paramPath] || null;
      allParams[secretName] = value as string | null;
    }

    return allParams;
  } catch (error: any) {
    if (required) {
      throw new Error(`Failed to fetch SSM parameters: ${error.message}`);
    }
    return result;
  }
}

/**
 * Get database URL from SSM or environment variable
 */
export async function getDatabaseUrl(): Promise<string | null> {
  return getSsmParameter("DIRECT_DATABASE_URL", { required: false });
}

/**
 * Get session secret from SSM or environment variable
 */
export async function getSessionSecret(): Promise<string | null> {
  return getSsmParameter("SESSION_SECRET", { required: false });
}
