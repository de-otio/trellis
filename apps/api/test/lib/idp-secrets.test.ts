import { describe, it, expect, beforeEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  IdpSecretsClient,
  idpSecretName,
  createIdpSecretsClient,
} from "../../src/lib/secrets/idp-secrets.js";

const sm = mockClient(SecretsManagerClient);

beforeEach(() => {
  sm.reset();
});

describe("idpSecretName", () => {
  it("uses the documented tenant/{id}/idp-client-secret pattern", () => {
    expect(idpSecretName("ctest123abc")).toBe("tenant/ctest123abc/idp-client-secret");
  });
});

describe("IdpSecretsClient.create", () => {
  it("creates a tagged secret and returns the ARN", async () => {
    sm.on(CreateSecretCommand).resolves({
      ARN: "arn:aws:secretsmanager:eu-central-1:111:secret:tenant/t1/idp-client-secret-abc",
      VersionId: "v1",
    });
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    const result = await client.create("t1", "shh");
    expect(result.arn).toContain("tenant/t1/idp-client-secret");
    expect(result.versionId).toBe("v1");
    const call = sm.commandCalls(CreateSecretCommand)[0]!;
    expect(call.args[0].input.Name).toBe("tenant/t1/idp-client-secret");
    expect(call.args[0].input.SecretString).toBe("shh");
    expect(call.args[0].input.Tags).toEqual([
      { Key: "tenantId", Value: "t1" },
      { Key: "purpose", Value: "idp-client-secret" },
    ]);
  });

  it("throws when Secrets Manager returns no ARN", async () => {
    sm.on(CreateSecretCommand).resolves({});
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    await expect(client.create("t1", "shh")).rejects.toThrow(/no ARN/);
  });

  it("propagates ResourceExistsException so the route handler can map to 409", async () => {
    sm.on(CreateSecretCommand).rejects(
      Object.assign(new Error("already exists"), { name: "ResourceExistsException" }),
    );
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    await expect(client.create("t1", "shh")).rejects.toThrow(/already exists/);
  });
});

describe("IdpSecretsClient.rotate", () => {
  it("PutSecretValue with the new plaintext returns the new version id", async () => {
    sm.on(PutSecretValueCommand).resolves({
      ARN: "arn:aws:secretsmanager:eu-central-1:111:secret:tenant/t1/idp-client-secret-abc",
      VersionId: "v2",
    });
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    const result = await client.rotate("t1", "new");
    expect(result.versionId).toBe("v2");
    const call = sm.commandCalls(PutSecretValueCommand)[0]!;
    expect(call.args[0].input.SecretId).toBe("tenant/t1/idp-client-secret");
    expect(call.args[0].input.SecretString).toBe("new");
  });

  it("throws when no ARN is returned", async () => {
    sm.on(PutSecretValueCommand).resolves({});
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    await expect(client.rotate("t1", "shh")).rejects.toThrow(/no ARN/);
  });
});

describe("IdpSecretsClient.delete", () => {
  it("uses ForceDeleteWithoutRecovery so secrets are gone after IdP disconnect", async () => {
    sm.on(DeleteSecretCommand).resolves({});
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    await client.delete("t1");
    const call = sm.commandCalls(DeleteSecretCommand)[0]!;
    expect(call.args[0].input.SecretId).toBe("tenant/t1/idp-client-secret");
    expect(call.args[0].input.ForceDeleteWithoutRecovery).toBe(true);
  });

  it("treats ResourceNotFoundException as success (idempotent rollback)", async () => {
    sm.on(DeleteSecretCommand).rejects(
      Object.assign(new Error("not found"), { name: "ResourceNotFoundException" }),
    );
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    await expect(client.delete("t1")).resolves.toBeUndefined();
  });

  it("rethrows other errors", async () => {
    sm.on(DeleteSecretCommand).rejects(
      Object.assign(new Error("internal"), { name: "InternalServiceError" }),
    );
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    await expect(client.delete("t1")).rejects.toThrow(/internal/);
  });
});

describe("IdpSecretsClient.describe", () => {
  it("returns ARN when the secret exists", async () => {
    sm.on(DescribeSecretCommand).resolves({
      ARN: "arn:aws:secretsmanager:eu-central-1:111:secret:tenant/t1/idp-client-secret-abc",
    });
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    const r = await client.describe("t1");
    expect(r?.arn).toContain("tenant/t1/idp-client-secret");
  });

  it("returns null when the secret has no ARN field", async () => {
    sm.on(DescribeSecretCommand).resolves({});
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    expect(await client.describe("t1")).toBeNull();
  });

  it("returns null on ResourceNotFoundException", async () => {
    sm.on(DescribeSecretCommand).rejects(
      Object.assign(new Error("nope"), { name: "ResourceNotFoundException" }),
    );
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    expect(await client.describe("t1")).toBeNull();
  });

  it("rethrows other errors", async () => {
    sm.on(DescribeSecretCommand).rejects(
      Object.assign(new Error("denied"), { name: "AccessDeniedException" }),
    );
    const client = new IdpSecretsClient(new SecretsManagerClient({}));
    await expect(client.describe("t1")).rejects.toThrow(/denied/);
  });
});

describe("createIdpSecretsClient", () => {
  it("constructs a wrapper around a real SDK client", () => {
    const client = createIdpSecretsClient("eu-central-1");
    expect(client).toBeInstanceOf(IdpSecretsClient);
  });

  it("falls back to AWS_REGION env var when region is omitted", () => {
    const prev = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-west-1";
    try {
      const client = createIdpSecretsClient();
      expect(client).toBeInstanceOf(IdpSecretsClient);
    } finally {
      if (prev === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev;
    }
  });
});
