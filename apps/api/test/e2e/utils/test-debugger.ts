/**
 * Test Debugging Utilities
 *
 * Comprehensive debugging tools for E2E tests including:
 * - Console log capture
 * - Network request/response logging
 * - Flutter state inspection
 * - Performance monitoring
 * - Screenshot capture
 */

import { Page } from "@playwright/test";
import {
  instrumentPerformance,
  type PerformanceInstrumentation,
} from "./performance-instrumentation.js";

export interface DebugOptions {
  verbose?: boolean;
  networkVerbose?: boolean;
  captureScreenshots?: boolean;
  logFlutterState?: boolean;
}

export interface DebugData {
  consoleLogs: Array<{ type: string; text: string; timestamp: number }>;
  networkRequests: Array<{
    method: string;
    url: string;
    status?: number;
    timestamp: number;
  }>;
  errors: Array<{
    type: string;
    message: string;
    stack?: string;
    timestamp: number;
  }>;
  screenshots?: Array<{ label: string; path: string }>;
  flutterState?: Record<string, any>;
}

/**
 * Comprehensive test debugging helper
 * Provides all debugging capabilities in one place
 */
export class TestDebugger {
  private page: Page;
  private consoleLogs: Array<{
    type: string;
    text: string;
    timestamp: number;
  }> = [];
  private networkRequests: Array<{
    method: string;
    url: string;
    status?: number;
    timestamp: number;
  }> = [];
  private errors: Array<{
    type: string;
    message: string;
    stack?: string;
    timestamp: number;
  }> = [];
  private screenshots: Array<{ label: string; path: string }> = [];
  private performanceInstrumentation?: PerformanceInstrumentation;
  private options: DebugOptions;

  constructor(page: Page, options: DebugOptions = {}) {
    this.page = page;
    this.options = {
      verbose: false,
      networkVerbose: false,
      captureScreenshots: false,
      logFlutterState: false,
      ...options,
    };
  }

  /**
   * Enable all debugging features
   */
  static enableAll(page: Page, options?: DebugOptions): TestDebugger {
    const testDebugger = new TestDebugger(page, {
      verbose: true,
      networkVerbose: options?.networkVerbose ?? false,
      captureScreenshots: options?.captureScreenshots ?? true,
      logFlutterState: options?.logFlutterState ?? true,
      ...options,
    });

    testDebugger.enableConsoleLogging();
    testDebugger.enableNetworkLogging();
    testDebugger.enableErrorCapture();
    testDebugger.enablePerformanceMonitoring();

    return testDebugger;
  }

  /**
   * Enable console log capture
   */
  enableConsoleLogging(): void {
    this.page.on("console", (msg) => {
      const logEntry = {
        type: msg.type(),
        text: msg.text(),
        timestamp: Date.now(),
      };
      this.consoleLogs.push(logEntry);

      if (this.options.verbose) {
        console.log(
          `[BROWSER CONSOLE ${logEntry.type.toUpperCase()}] ${logEntry.text}`,
        );
      }

      if (msg.type() === "error") {
        console.error(`[BROWSER ERROR] ${logEntry.text}`);
        this.errors.push({
          type: "console",
          message: logEntry.text,
          timestamp: logEntry.timestamp,
        });
      }
    });
  }

  /**
   * Enable network request/response logging
   */
  enableNetworkLogging(): void {
    this.page.on("request", (request) => {
      const url = request.url();
      const method = request.method();

      // Only log API requests unless networkVerbose is enabled
      if (this.options.networkVerbose || url.includes("/api/")) {
        const logEntry = {
          method,
          url,
          timestamp: Date.now(),
        };
        this.networkRequests.push(logEntry);

        if (this.options.networkVerbose || this.options.verbose) {
          console.log(`[REQUEST] ${method} ${url}`);
          if (this.options.networkVerbose) {
            console.log(
              `[HEADERS]`,
              JSON.stringify(request.headers(), null, 2),
            );
          }
        }
      }
    });

    this.page.on("response", (response) => {
      const url = response.url();
      const status = response.status();

      // Log all API responses and errors
      if (
        this.options.networkVerbose ||
        url.includes("/api/") ||
        status >= 400
      ) {
        const request = this.networkRequests.find(
          (r) => r.url === url && !r.status,
        );
        if (request) {
          request.status = status;
        } else {
          this.networkRequests.push({
            method: "UNKNOWN",
            url,
            status,
            timestamp: Date.now(),
          });
        }

        if (status >= 400) {
          console.error(`[RESPONSE ERROR] ${status} ${url}`);
          response
            .text()
            .then((body) => {
              console.error(`[ERROR BODY]`, body.substring(0, 500)); // Limit body size
              this.errors.push({
                type: "network",
                message: `${status} ${url}: ${body.substring(0, 200)}`,
                timestamp: Date.now(),
              });
            })
            .catch(() => {
              // Ignore errors reading response body
            });
        } else if (this.options.networkVerbose || this.options.verbose) {
          console.log(`[RESPONSE] ${status} ${url}`);
        }
      }
    });

    this.page.on("requestfailed", (request) => {
      const failure = request.failure();
      console.error(`[REQUEST FAILED] ${request.method()} ${request.url()}`);
      if (failure) {
        console.error(`  Error: ${failure.errorText}`);
        this.errors.push({
          type: "network",
          message: `${request.method()} ${request.url()}: ${failure.errorText}`,
          timestamp: Date.now(),
        });
      }
    });
  }

  /**
   * Enable error capture (page errors, unhandled rejections)
   */
  enableErrorCapture(): void {
    this.page.on("pageerror", (error) => {
      console.error(`[PAGE ERROR] ${error.message}`);
      if (error.stack) {
        console.error(error.stack);
      }
      this.errors.push({
        type: "page",
        message: error.message,
        stack: error.stack,
        timestamp: Date.now(),
      });
    });

    // Capture unhandled promise rejections
    this.page.on("crash", () => {
      console.error("[PAGE CRASH] Page crashed");
      this.errors.push({
        type: "crash",
        message: "Page crashed",
        timestamp: Date.now(),
      });
    });
  }

  /**
   * Enable performance monitoring
   */
  enablePerformanceMonitoring(): void {
    this.performanceInstrumentation = instrumentPerformance(this.page);
  }

  /**
   * Capture screenshot with label
   */
  async captureScreenshot(label: string): Promise<string | null> {
    if (!this.options.captureScreenshots) {
      return null;
    }

    try {
      const timestamp = Date.now();
      const filename = `screenshot-${label}-${timestamp}.png`;
      const path = `test-results/${filename}`;
      await this.page.screenshot({ path, fullPage: true });
      this.screenshots.push({ label, path });
      console.log(`[SCREENSHOT] Captured: ${label} -> ${path}`);
      return path;
    } catch (error) {
      console.warn(
        `[SCREENSHOT] Failed to capture ${label}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * Log Flutter state (localStorage, sessionStorage, etc.)
   */
  async logFlutterState(): Promise<void> {
    if (!this.options.logFlutterState) {
      return;
    }

    try {
      const state = await this.page.evaluate(() => {
        return {
          localStorage: Object.fromEntries(
            Object.entries(localStorage).map(([key, value]) => [
              key,
              value.substring(0, 50),
            ]),
          ),
          sessionStorage: Object.fromEntries(
            Object.entries(sessionStorage).map(([key, value]) => [
              key,
              value.substring(0, 50),
            ]),
          ),
          url: window.location.href,
          hash: window.location.hash,
          pathname: window.location.pathname,
          flutterReady: (window as any).flutterReady,
        };
      });

      console.log("[FLUTTER STATE]", JSON.stringify(state, null, 2));
    } catch (error) {
      console.warn(
        `[FLUTTER STATE] Failed to log state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get all debug data
   */
  async getDebugData(): Promise<DebugData> {
    const data: DebugData = {
      consoleLogs: this.consoleLogs,
      networkRequests: this.networkRequests,
      errors: this.errors,
    };

    if (this.options.captureScreenshots) {
      data.screenshots = this.screenshots;
    }

    if (this.options.logFlutterState) {
      data.flutterState = await this.page.evaluate(() => {
        return {
          localStorage: Object.fromEntries(
            Object.entries(localStorage).map(([key, value]) => [
              key,
              value.substring(0, 50),
            ]),
          ),
          url: window.location.href,
        };
      });
    }

    return data;
  }

  /**
   * Generate debug report
   */
  async generateReport(): Promise<string> {
    const data = await this.getDebugData();
    const performanceReport = this.performanceInstrumentation
      ? await this.performanceInstrumentation.generateReport()
      : "Performance monitoring not enabled";

    return `
=== Test Debug Report ===

Console Logs: ${data.consoleLogs.length}
  Errors: ${data.consoleLogs.filter((l) => l.type === "error").length}
  Warnings: ${data.consoleLogs.filter((l) => l.type === "warning").length}

Network Requests: ${data.networkRequests.length}
  Failed: ${data.networkRequests.filter((r) => r.status && r.status >= 400).length}

Errors: ${data.errors.length}
${data.errors.map((e) => `  [${e.type}] ${e.message}`).join("\n")}

Screenshots: ${data.screenshots?.length || 0}

Performance:
${performanceReport}
    `.trim();
  }

  /**
   * Clear all debug data
   */
  clear(): void {
    this.consoleLogs = [];
    this.networkRequests = [];
    this.errors = [];
    this.screenshots = [];
  }
}
