// check-s3-presigned.ts
//
// THE key G1 open question: does Scaleway Object Storage support presigned
// POST-policy uploads (S3 `createPresignedPost`)? Trellis's upload path
// (see the AWS estate) issues browser-direct-to-bucket POST-policy uploads;
// the documented Scaleway fallback, if POST isn't supported, is presigned
// PUT. A POST failure here is a FINDING to feed back into the migration
// plan — NOT a harness bug. We catch it, report it clearly, and continue to
// the PUT/GET checks regardless of what POST does.
//
// Auth note: Object Storage's S3-compatible API is authenticated with the
// project's Scaleway IAM API key pair (SCW_ACCESS_KEY / SCW_SECRET_KEY) —
// the same credentials used for the OpenTofu provider, not a
// bucket-specific credential (Scaleway doesn't mint per-bucket S3 keys).
// So this check reads SCW_ACCESS_KEY/SCW_SECRET_KEY straight from the
// environment rather than from tofu outputs.

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { loadOutputs } from "./load-outputs.js";
import { printResult, type CheckResult } from "./report.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env var ${name} (needed for direct S3-API auth, separate from tofu outputs)`);
  }
  return v;
}

async function main(): Promise<Omit<CheckResult, "name">> {
  const outputs = loadOutputs();
  const accessKeyId = requireEnv("SCW_ACCESS_KEY");
  const secretAccessKey = requireEnv("SCW_SECRET_KEY");

  const s3 = new S3Client({
    region: outputs.bucket_region,
    endpoint: `https://s3.${outputs.bucket_region}.scw.cloud`,
    forcePathStyle: false, // Scaleway Object Storage uses virtual-hosted-style addressing, same as AWS S3
    credentials: { accessKeyId, secretAccessKey },
  });

  const bucket = outputs.bucket_name;
  const evidenceLines: string[] = [];
  const findings: string[] = [];
  let anyHardFailure = false;

  // --- 1. Presigned POST-policy upload (the open question) ---
  const postKey = "g1-spike/presigned-post-test.txt";
  const postBody = `g1-spike presigned-POST test — ${new Date().toISOString()}`;
  let postSupported: boolean;
  try {
    const { url, fields } = await createPresignedPost(s3, {
      Bucket: bucket,
      Key: postKey,
      Expires: 60,
      Conditions: [["content-length-range", 0, 1024]],
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      form.append(k, v);
    }
    form.append("file", new Blob([postBody], { type: "text/plain" }), "test.txt");

    const res = await fetch(url, { method: "POST", body: form });
    const bodyText = await res.text();

    if (res.ok) {
      postSupported = true;
      evidenceLines.push(
        `POST-policy upload: HTTP ${res.status} — SUPPORTED. url=${url}`,
      );
    } else {
      postSupported = false;
      evidenceLines.push(
        `POST-policy upload: HTTP ${res.status} — NOT SUPPORTED (or misconfigured). Response body: ${bodyText.slice(0, 500)}`,
      );
    }
  } catch (err) {
    postSupported = false;
    evidenceLines.push(
      `POST-policy upload: threw before HTTP response — NOT SUPPORTED / SDK-incompatible. ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  findings.push(
    `presigned-POST support: ${postSupported ? "YES" : "NO — fallback to presigned PUT required (see PUT result below)"}`,
  );

  // --- 2. Presigned PUT upload (documented fallback) ---
  const putKey = "g1-spike/presigned-put-test.txt";
  const putBody = `g1-spike presigned-PUT test — ${new Date().toISOString()}`;
  let putSupported = false;
  try {
    const putCmd = new PutObjectCommand({ Bucket: bucket, Key: putKey, ContentType: "text/plain" });
    const putUrl = await getSignedUrl(s3, putCmd, { expiresIn: 60 });
    const res = await fetch(putUrl, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: putBody,
    });
    putSupported = res.ok;
    evidenceLines.push(`Presigned PUT upload: HTTP ${res.status} — ${putSupported ? "SUPPORTED" : "FAILED"}`);
    if (!putSupported) anyHardFailure = true;
  } catch (err) {
    anyHardFailure = true;
    evidenceLines.push(`Presigned PUT upload: threw — ${err instanceof Error ? err.message : String(err)}`);
  }
  findings.push(`presigned-PUT support: ${putSupported ? "YES" : "NO"}`);

  // --- 3. Presigned GET download, verifying round-trip content ---
  let getSupported = false;
  try {
    const getCmd = new GetObjectCommand({ Bucket: bucket, Key: putKey });
    const getUrl = await getSignedUrl(s3, getCmd, { expiresIn: 60 });
    const res = await fetch(getUrl);
    const text = await res.text();
    getSupported = res.ok && text === putBody;
    evidenceLines.push(
      `Presigned GET download: HTTP ${res.status}, body matches upload = ${text === putBody} — ${getSupported ? "SUPPORTED" : "FAILED"}`,
    );
    if (!getSupported) anyHardFailure = true;
  } catch (err) {
    anyHardFailure = true;
    evidenceLines.push(`Presigned GET download: threw — ${err instanceof Error ? err.message : String(err)}`);
  }
  findings.push(`presigned-GET support: ${getSupported ? "YES" : "NO"}`);

  const evidence = [...evidenceLines, "", "Findings:", ...findings.map((f) => `  - ${f}`)].join("\n");

  // The overall check is a hard FAIL only if PUT or GET (the required
  // fallback path) don't work — a missing POST is reported as a FINDING,
  // per the prompt: "a POST failure is a FINDING, not a harness bug."
  if (anyHardFailure) {
    return { status: "FAIL", evidence };
  }
  if (!postSupported) {
    return { status: "FINDING", evidence };
  }
  return { status: "PASS", evidence };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((result) => {
      printResult({ name: "check-s3-presigned", ...result });
      process.exit(result.status === "FAIL" ? 1 : 0);
    })
    .catch((err) => {
      printResult({
        name: "check-s3-presigned",
        status: "FAIL",
        evidence: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
      process.exit(1);
    });
}

export { main as checkS3Presigned };
