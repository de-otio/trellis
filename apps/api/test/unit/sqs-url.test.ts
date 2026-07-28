import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSqsUrl } from "../../src/lib/sqs-url.js";

describe("buildSqsUrl — shared queue-URL convention (request path + worker)", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.SQS_QUEUE_URL_PREFIX;
    delete process.env.SQS_ENDPOINT;
    delete process.env.AWS_ACCOUNT_ID;
    delete process.env.AWS_REGION;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("uses SQS_QUEUE_URL_PREFIX verbatim + queue name (Scaleway MNQ, name-prefixed queues)", () => {
    // The real MNQ prefix includes the account (project id) AND the queue-name
    // prefix, e.g. `{endpoint}/{project-id}/sky-dev-`.
    process.env.SQS_QUEUE_URL_PREFIX =
      "https://sqs.mnq.fr-par.scw.cloud/project-abc/sky-dev-";
    expect(buildSqsUrl("delete-account", "dev")).toBe(
      "https://sqs.mnq.fr-par.scw.cloud/project-abc/sky-dev-delete-account",
    );
  });

  it("falls back to endpoint/account/{stage}-{queue} when no prefix is set (AWS/LocalStack)", () => {
    process.env.SQS_ENDPOINT = "http://localstack:4566";
    process.env.AWS_ACCOUNT_ID = "000000000000";
    expect(buildSqsUrl("media-processing", "dev")).toBe(
      "http://localstack:4566/000000000000/dev-media-processing",
    );
  });

  it("defaults the AWS endpoint + account when only a region is set", () => {
    process.env.AWS_REGION = "eu-central-1";
    expect(buildSqsUrl("user-export", "prod")).toBe(
      "https://sqs.eu-central-1.amazonaws.com/000000000000/prod-user-export",
    );
  });

  it("SQS_QUEUE_URL_PREFIX takes precedence over the endpoint/account fallback", () => {
    process.env.SQS_QUEUE_URL_PREFIX = "https://q.example/acct/x-";
    process.env.SQS_ENDPOINT = "http://ignored";
    process.env.AWS_ACCOUNT_ID = "999";
    expect(buildSqsUrl("link-check", "dev")).toBe("https://q.example/acct/x-link-check");
  });
});
