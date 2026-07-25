// Loads the spike's OpenTofu outputs so every check-*.ts script has one
// consistent source of config. Two ways in, in priority order:
//
//   1. G1_OUTPUTS_JSON env var pointing at a file produced by
//      `tofu output -json > path/to/file.json` (this is what
//      `make outputs` writes — see ../Makefile).
//   2. Fallback: shell out to `tofu output -json` directly from ../infra,
//      so `tsx check-postgres.ts` still works standalone without the
//      Makefile, as long as you're running from a machine with `tofu` and
//      applied state.
//
// Deliberately NOT using the `tofu` Terraform/OpenTofu SDK — shelling out
// to the CLI keeps this harness dependency-free w.r.t. HCL tooling and
// matches how a human would inspect state.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INFRA_DIR = path.resolve(__dirname, "..", "infra");

interface TofuOutputValue<T> {
  value: T;
  sensitive: boolean;
  type: unknown;
}

export interface SpikeOutputs {
  postgres_host: string;
  postgres_ip: string;
  postgres_port: number;
  postgres_database: string;
  postgres_user: string;
  postgres_password: string;
  bucket_name: string;
  bucket_region: string;
  bucket_endpoint: string;
  sqs_endpoint: string;
  sqs_standard_queue_url: string;
  sqs_fifo_queue_url: string;
  sqs_access_key: string;
  sqs_secret_key: string;
  container_public_endpoint: string;
}

function rawOutputsJson(): string {
  const filePath = process.env.G1_OUTPUTS_JSON;
  if (filePath) {
    return readFileSync(filePath, "utf8");
  }

  return execFileSync("tofu", ["output", "-json"], {
    cwd: INFRA_DIR,
    encoding: "utf8",
    // outputs include sensitive values (DB password, SQS secret key) —
    // never let this leak into a parent process's stdio/logging by
    // accident; execFileSync returns it directly to us as a string.
  });
}

export function loadOutputs(): SpikeOutputs {
  let parsed: Record<string, TofuOutputValue<unknown>>;
  try {
    parsed = JSON.parse(rawOutputsJson());
  } catch (err) {
    throw new Error(
      `Could not read/parse OpenTofu outputs. Run "make apply && make outputs" first, ` +
        `or set G1_OUTPUTS_JSON to a file from "tofu output -json". Underlying error: ${String(err)}`,
    );
  }

  const required = [
    "postgres_host",
    "postgres_ip",
    "postgres_port",
    "postgres_database",
    "postgres_user",
    "postgres_password",
    "bucket_name",
    "bucket_region",
    "bucket_endpoint",
    "sqs_endpoint",
    "sqs_standard_queue_url",
    "sqs_fifo_queue_url",
    "sqs_access_key",
    "sqs_secret_key",
    "container_public_endpoint",
  ] as const;

  const missing = required.filter((key) => !(key in parsed));
  if (missing.length > 0) {
    throw new Error(
      `OpenTofu outputs are missing expected keys: ${missing.join(", ")}. ` +
        `Did "tofu apply" finish successfully?`,
    );
  }

  const out: Record<string, unknown> = {};
  for (const key of required) {
    out[key] = parsed[key]!.value;
  }

  return out as unknown as SpikeOutputs;
}
