/**
 * `buildDbSslOptions` — the one place Postgres TLS posture is decided (DP-7).
 *
 * The defect this guards against: every non-local pool ran
 * `ssl: { rejectUnauthorized: false }`, so the connection was encrypted but
 * the server was never authenticated. These tests pin the three branches and
 * the fail-closed behaviour when an operator asks for verification but the
 * CA cannot be loaded.
 */

import type { PeerCertificate } from "node:tls";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetDbSslWarningForTests,
  buildDbSslOptions,
  isLocalDbConnectionString,
  type DbSslCheckServerIdentity,
} from "../../src/lib/db-ssl.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUTEST\n-----END CERTIFICATE-----\n";
const REMOTE = "postgresql://app:pw@db.example.net:5432/app";

describe("isLocalDbConnectionString", () => {
  it("recognises the local forms the dev/CI lanes use", () => {
    expect(isLocalDbConnectionString("postgresql://u:p@localhost:5432/db")).toBe(true);
    expect(isLocalDbConnectionString("postgresql://u:p@127.0.0.1/db")).toBe(true);
    expect(isLocalDbConnectionString("postgresql://u:p@[::1]:5432/db")).toBe(true);
  });

  it("does not treat a lookalike host as local", () => {
    expect(isLocalDbConnectionString("postgresql://u:p@localhost.example.net:5432/db")).toBe(false);
    expect(isLocalDbConnectionString(REMOTE)).toBe(false);
    expect(isLocalDbConnectionString(undefined)).toBe(false);
  });
});

describe("buildDbSslOptions", () => {
  beforeEach(() => _resetDbSslWarningForTests());

  it("local host → no TLS at all, no warning", () => {
    const warn = vi.fn();
    expect(buildDbSslOptions("postgresql://u:p@localhost:5432/db", {}, warn)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("DB_SSL_CA as PEM → verification ON, pinned to the CA, servername = URL host", () => {
    const warn = vi.fn();
    const ssl = buildDbSslOptions(REMOTE, { DB_SSL_CA: PEM }, warn);
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: PEM, servername: "db.example.net" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("DB_SSL_CA as base64 of the PEM (single-line delivery) → same result", () => {
    const ssl = buildDbSslOptions(REMOTE, {
      DB_SSL_CA: Buffer.from(PEM, "utf8").toString("base64"),
    });
    expect(ssl).toEqual({ rejectUnauthorized: true, ca: PEM, servername: "db.example.net" });
  });

  it("DB_SSL_CA_PATH → reads the file through the injected reader", () => {
    const readFile = vi.fn().mockReturnValue(PEM);
    const ssl = buildDbSslOptions(
      REMOTE,
      { DB_SSL_CA_PATH: "/etc/db/ca.pem" },
      undefined,
      readFile,
    );
    expect(readFile).toHaveBeenCalledWith("/etc/db/ca.pem");
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: PEM });
  });

  describe("IP-literal host (Scaleway's private endpoint) → no SNI, SAN check pinned to the IP", () => {
    // RFC 6066 forbids an IP as the SNI server name; Node deprecates it
    // (DEP0123) and a future release refuses it. `tls.connect` only emits the
    // deprecation when `servername` is an IP, so "no servername key" is the
    // property that keeps the pool clean on every Node.
    const cert = (san: string) =>
      ({ subjectaltname: san, subject: {} }) as unknown as PeerCertificate;
    const checkOf = (ssl: ReturnType<typeof buildDbSslOptions>): DbSslCheckServerIdentity =>
      (ssl as { checkServerIdentity: DbSslCheckServerIdentity }).checkServerIdentity;

    it("IPv4: verified against the SAN of the dialled IP, whatever hostname Node falls back to", () => {
      const ssl = buildDbSslOptions("postgresql://u:p@10.0.0.5:5432/db", { DB_SSL_CA: PEM });
      expect(ssl).toEqual({
        rejectUnauthorized: true,
        ca: PEM,
        checkServerIdentity: expect.any(Function),
      });
      expect(ssl).not.toHaveProperty("servername");
      const check = checkOf(ssl);
      // pg passes a socket and no host, so Node's fallback hostname is "localhost".
      expect(check("localhost", cert("IP Address:10.0.0.5"))).toBeUndefined();
      expect(check("localhost", cert("DNS:db.internal, IP Address:10.0.0.5"))).toBeUndefined();
      const wrong = check("localhost", cert("IP Address:10.0.0.6"));
      expect(wrong?.message).toMatch(/10\.0\.0\.5/);
      expect(wrong).toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID", host: "10.0.0.5" });
      expect(check("localhost", cert("DNS:db.example.net"))).toBeInstanceOf(Error);
      expect(check("localhost", cert(""))).toBeInstanceOf(Error);
    });

    it("IPv6 literal: brackets stripped, compared in canonical form", () => {
      const ssl = buildDbSslOptions("postgresql://u:p@[2001:db8::10]:5432/db", { DB_SSL_CA: PEM });
      expect(ssl).not.toHaveProperty("servername");
      const check = checkOf(ssl);
      expect(check("localhost", cert("IP Address:2001:DB8:0:0:0:0:0:10"))).toBeUndefined();
      expect(check("localhost", cert("DNS:db.internal, IP Address:2001:db8::10"))).toBeUndefined();
      expect(check("localhost", cert("IP Address:2001:db8::11"))).toBeInstanceOf(Error);
      expect(check("localhost", cert("DNS:2001:db8::10"))).toBeInstanceOf(Error);
    });

    it("a DNS host keeps servername and gets no custom identity check", () => {
      const ssl = buildDbSslOptions(REMOTE, { DB_SSL_CA: PEM });
      expect(ssl).toHaveProperty("servername", "db.example.net");
      expect(ssl).not.toHaveProperty("checkServerIdentity");
    });
  });

  it("neither set on a remote host → legacy unverified mode, warned exactly once per process", () => {
    const warn = vi.fn();
    expect(buildDbSslOptions(REMOTE, {}, warn)).toEqual({ rejectUnauthorized: false });
    expect(buildDbSslOptions(REMOTE, {}, warn)).toEqual({ rejectUnauthorized: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DB_SSL_CA/);
    expect(warn.mock.calls[0][0]).toMatch(/NOT verified/);
  });

  it("an operator who asked for verification never silently gets the unverified mode", () => {
    // Unreadable path
    expect(() =>
      buildDbSslOptions(REMOTE, { DB_SSL_CA_PATH: "/nope.pem" }, undefined, () => {
        throw new Error("ENOENT");
      }),
    ).toThrow(/DB_SSL_CA_PATH.*cannot be read/);
    // File without a certificate
    expect(() =>
      buildDbSslOptions(REMOTE, { DB_SSL_CA_PATH: "/empty.pem" }, undefined, () => ""),
    ).toThrow(/does not contain a PEM/);
    // Inline junk
    expect(() => buildDbSslOptions(REMOTE, { DB_SSL_CA: "not a cert" })).toThrow(
      /neither a PEM certificate nor base64/,
    );
  });

  it("inline CA wins over the path when both are set", () => {
    const readFile = vi.fn();
    const ssl = buildDbSslOptions(
      REMOTE,
      { DB_SSL_CA: PEM, DB_SSL_CA_PATH: "/ignored.pem" },
      undefined,
      readFile,
    );
    expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: PEM });
    expect(readFile).not.toHaveBeenCalled();
  });
});
