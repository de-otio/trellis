/**
 * Post-deployment smoke tests to verify public endpoints are live.
 *
 * Configuration via env vars (with sensible dev defaults):
 * - CUSTOM_DOMAIN (site root)
 * - WWW_DOMAIN (www site)
 * - API_DOMAIN (workers api)
 */

import { beforeAll, describe, expect, it } from "vitest";
import { requireDevEnvironment } from "../utils/test-environment-guard.js";
import { getApiUrl, getFrontendUrl } from "../utils/test-config.js";

// Derive domains from the configured URLs (environment variables or config.yaml fallback)
const apiUrlStr = getApiUrl();
const frontendUrlStr = getFrontendUrl();

function domainFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

const API_DOMAIN = domainFromUrl(apiUrlStr);
// For CUSTOM_DOMAIN and WWW_DOMAIN, derive from the frontend URL
const WWW_DOMAIN = domainFromUrl(frontendUrlStr);
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || WWW_DOMAIN;

function isOkOrRedirect(status: number): boolean {
  return (status >= 200 && status < 300) || (status >= 300 && status < 400);
}

// Strict tests: do not skip on DNS; failure means not deployed correctly

async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  attempts = 3,
  delayMs = 500,
): Promise<Response> {
  let lastError: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, init);
      return response;
    } catch (err: any) {
      lastError = err;
      // Log DNS and network errors for debugging
      if (err?.code === "ENOTFOUND" || err?.message?.includes("getaddrinfo")) {
        console.error(
          `DNS lookup failed for ${url} (attempt ${i + 1}/${attempts})`,
        );
      } else {
        console.error(
          `Network error for ${url} (attempt ${i + 1}/${attempts}):`,
          err?.message || err,
        );
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}

describe("Post-deployment smoke", () => {
  beforeAll(() => {
    requireDevEnvironment();
  });

  const timeoutMs = Number(process.env.TEST_TIMEOUT_MS || 20000);

  // Skip until Flutter web build is deployed to S3 web bucket
  // TRIAGE(AR14): needs-infra-run-nightly — un-skip once the Flutter web build
  // is deployed to the S3 web bucket; not a dead skip, blocked on real infra.
  it.skip(
    `serves the public site at ${CUSTOM_DOMAIN}`,
    async () => {
      const url = `https://${CUSTOM_DOMAIN}/`;
      const res = await fetchWithRetry(url, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PostDeploymentTest/1.0)",
        },
      });
      if (!isOkOrRedirect(res.status)) {
        const text = await res
          .text()
          .catch(() => "Unable to read response body");
        throw new Error(
          `Expected status 200-399, got ${res.status}. ` +
            `URL: ${url}\n` +
            `Status: ${res.status} ${res.statusText}\n` +
            `Headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2)}\n` +
            `Body preview: ${text.substring(0, 200)}`,
        );
      }
      expect(isOkOrRedirect(res.status)).toBe(true);
      // If HTML was returned, scan a small portion of the body
      if (res.headers.get("content-type")?.includes("text/html")) {
        const text = await res.text();
        expect(text).toMatch(/<div id="root">|<title>/);
      }
    },
    timeoutMs,
  );

  it.skipIf(WWW_DOMAIN === CUSTOM_DOMAIN)(
    `serves the public site at ${WWW_DOMAIN}`,
    async () => {
      const url = `https://${WWW_DOMAIN}/`;
      const res = await fetchWithRetry(url, {
        redirect: "manual",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PostDeploymentTest/1.0)",
        },
      });
      if (!isOkOrRedirect(res.status)) {
        const text = await res
          .text()
          .catch(() => "Unable to read response body");
        throw new Error(
          `Expected status 200-399, got ${res.status}. ` +
            `URL: ${url}\n` +
            `Status: ${res.status} ${res.statusText}\n` +
            `Headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2)}\n` +
            `Body preview: ${text.substring(0, 200)}`,
        );
      }
      expect(isOkOrRedirect(res.status)).toBe(true);
    },
    timeoutMs,
  );

  it(
    `exposes API health endpoint at ${API_DOMAIN}`,
    async () => {
      const url = `https://${API_DOMAIN}/health`;
      let res: Response;
      try {
        res = await fetchWithRetry(url, {
          redirect: "manual",
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; PostDeploymentTest/1.0)",
          },
        });
      } catch (err: any) {
        if (
          err?.code === "ENOTFOUND" ||
          err?.message?.includes("getaddrinfo")
        ) {
          throw new Error(
            `DNS lookup failed for ${API_DOMAIN}. ` +
              `The domain may not be configured or deployed yet.\n` +
              `Original error: ${err.message || err}`,
          );
        }
        throw err;
      }

      if (res.status < 200 || res.status >= 400) {
        const text = await res
          .text()
          .catch(() => "Unable to read response body");
        throw new Error(
          `Expected status 200-399, got ${res.status}. ` +
            `URL: ${url}\n` +
            `Status: ${res.status} ${res.statusText}\n` +
            `Headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2)}\n` +
            `Body: ${text.substring(0, 500)}`,
        );
      }

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(400);

      const body = await res
        .json()
        .catch(async () => ({ raw: await res.text() }));

      // Health endpoint returns { status: "ok", timestamp: "..." } or { ok: true, region: "..." }
      // Accept either format
      if (!body.ok && body.status !== "ok") {
        throw new Error(
          `Health endpoint response does not contain ok: true or status: "ok". ` +
            `URL: ${url}\n` +
            `Response body: ${JSON.stringify(body, null, 2)}`,
        );
      }

      // Accept either format - check for ok: true OR status: "ok"
      if (body.ok) {
        expect(body).toMatchObject({ ok: true });
      } else if (body.status === "ok") {
        expect(body).toMatchObject({ status: "ok" });
      } else {
        throw new Error(
          `Health endpoint response format unexpected. ` +
            `URL: ${url}\n` +
            `Response body: ${JSON.stringify(body, null, 2)}`,
        );
      }
    },
    timeoutMs,
  );
});
