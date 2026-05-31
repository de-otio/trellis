/**
 * Performance Instrumentation for Flutter Web Tests
 *
 * Comprehensive utilities to diagnose performance issues and timeout causes.
 * Tracks resource loading, network activity, Flutter initialization, and more.
 */

import { Page, Response } from "@playwright/test";

/**
 * Performance metrics collected during test execution
 */
export interface PerformanceMetrics {
  // Timing metrics
  totalLoadTime: number;
  navigationStart: number;
  domContentLoaded: number;
  loadComplete: number;
  flutterReady?: number;
  routerReady?: number;
  interactiveReady?: number;

  // Resource loading
  resources: ResourceMetric[];
  totalResourceSize: number;
  failedResources: ResourceMetric[];

  // Network activity
  networkRequests: NetworkRequest[];
  activeConnections: number;
  websocketConnections: number;
  longRunningRequests: NetworkRequest[];

  // Flutter-specific
  flutterEngineStatus: FlutterEngineStatus;
  wasmLoaded: boolean;
  canvasKitLoaded: boolean;

  // Performance warnings
  warnings: PerformanceWarning[];
}

export interface ResourceMetric {
  url: string;
  type: string;
  size: number;
  loadTime: number;
  status: number;
  failed: boolean;
  blocking: boolean;
}

export interface NetworkRequest {
  url: string;
  method: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status?: number;
  size?: number;
  type?: string;
  failed?: boolean;
}

export interface FlutterEngineStatus {
  initialized: boolean;
  readyTime?: number;
  error?: string;
}

export interface PerformanceWarning {
  type: string;
  message: string;
  timestamp: number;
  severity: "low" | "medium" | "high";
}

/**
 * Performance instrumentation tracker
 */
export class PerformanceInstrumentation {
  private page: Page;
  private metrics: PerformanceMetrics;
  private startTime: number;
  private resourceMap: Map<string, ResourceMetric> = new Map();
  private requestMap: Map<string, NetworkRequest> = new Map();
  private networkActivity: NetworkRequest[] = [];
  private warnings: PerformanceWarning[] = [];

  constructor(page: Page) {
    this.page = page;
    this.startTime = Date.now();
    this.metrics = this.initializeMetrics();
  }

  /**
   * Initialize performance metrics
   */
  private initializeMetrics(): PerformanceMetrics {
    return {
      totalLoadTime: 0,
      navigationStart: Date.now(),
      domContentLoaded: 0,
      loadComplete: 0,
      resources: [],
      totalResourceSize: 0,
      failedResources: [],
      networkRequests: [],
      activeConnections: 0,
      websocketConnections: 0,
      longRunningRequests: [],
      flutterEngineStatus: { initialized: false },
      wasmLoaded: false,
      canvasKitLoaded: false,
      warnings: [],
    };
  }

  /**
   * Start performance monitoring
   */
  async start(): Promise<void> {
    console.log("[Performance] Starting performance instrumentation...");

    // Track navigation timing
    this.trackNavigationTiming();

    // Track resource loading
    this.trackResourceLoading();

    // Track network activity
    this.trackNetworkActivity();

    // Track Flutter engine
    this.trackFlutterEngine();

    // Monitor for performance issues
    this.monitorPerformanceIssues();
  }

  /**
   * Track navigation timing events
   */
  private async trackNavigationTiming(): Promise<void> {
    this.page.on("load", async () => {
      const timing = await this.page.evaluate(() => {
        const perf = performance.getEntriesByType(
          "navigation",
        )[0] as PerformanceNavigationTiming;
        return {
          domContentLoaded: perf.domContentLoadedEventEnd - perf.fetchStart,
          loadComplete: perf.loadEventEnd - perf.fetchStart,
        };
      });

      this.metrics.domContentLoaded = timing.domContentLoaded;
      this.metrics.loadComplete = timing.loadComplete;
      console.log(
        `[Performance] DOMContentLoaded: ${timing.domContentLoaded}ms`,
      );
      console.log(`[Performance] Load complete: ${timing.loadComplete}ms`);
    });
  }

  /**
   * Track resource loading (WASM, JS, fonts, images, etc.)
   */
  private trackResourceLoading(): void {
    this.page.on("response", async (response) => {
      const url = response.url();
      const request = response.request();
      const method = request.method();

      // Only track GET requests (resources)
      if (method !== "GET") return;

      const startTime = request.timing().requestStart;
      const endTime = Date.now();
      const duration = endTime - startTime;

      try {
        const headers = response.headers();
        const contentType = headers["content-type"] || "";
        const contentLength = parseInt(headers["content-length"] || "0", 10);
        const status = response.status();

        // Determine resource type
        let resourceType = "unknown";
        if (url.includes(".wasm") || url.includes("canvaskit")) {
          resourceType = "wasm";
          this.metrics.wasmLoaded = status === 200;
        } else if (url.includes(".js") || url.includes("main.dart.js")) {
          resourceType = "javascript";
        } else if (
          contentType.includes("font") ||
          url.includes(".woff") ||
          url.includes(".ttf")
        ) {
          resourceType = "font";
        } else if (contentType.includes("image")) {
          resourceType = "image";
        } else if (contentType.includes("css")) {
          resourceType = "css";
        } else if (url.includes("canvaskit")) {
          resourceType = "canvaskit";
          this.metrics.canvasKitLoaded = status === 200;
        }

        const resource: ResourceMetric = {
          url,
          type: resourceType,
          size: contentLength,
          loadTime: duration,
          status,
          failed: status >= 400,
          blocking: this.isBlockingResource(resourceType, url),
        };

        this.resourceMap.set(url, resource);
        this.metrics.resources.push(resource);
        this.metrics.totalResourceSize += contentLength;

        if (resource.failed) {
          this.metrics.failedResources.push(resource);
          this.addWarning(
            "high",
            `Failed to load resource: ${url} (${status})`,
          );
        }

        // Warn about slow resources
        if (duration > 5000 && resource.blocking) {
          this.addWarning(
            "medium",
            `Slow blocking resource: ${resourceType} ${url} (${duration}ms)`,
          );
        }

        // Log large resources
        if (contentLength > 2 * 1024 * 1024) {
          console.log(
            `[Performance] Large resource: ${resourceType} ${(contentLength / 1024 / 1024).toFixed(2)}MB - ${url}`,
          );
        }
      } catch (error) {
        console.warn(`[Performance] Error tracking resource ${url}:`, error);
      }
    });
  }

  /**
   * Track network activity to identify what prevents network idle
   */
  private trackNetworkActivity(): void {
    this.page.on("request", (request) => {
      const url = request.url();
      const method = request.method();
      const startTime = Date.now();

      const networkRequest: NetworkRequest = {
        url,
        method,
        startTime,
        type: this.getRequestType(url),
      };

      this.requestMap.set(url, networkRequest);
      this.networkActivity.push(networkRequest);
      this.metrics.activeConnections++;

      // Track WebSocket connections
      if (url.startsWith("ws://") || url.startsWith("wss://")) {
        this.metrics.websocketConnections++;
      }
    });

    this.page.on("response", (response) => {
      const url = response.url();
      const request = this.requestMap.get(url);
      if (request) {
        const endTime = Date.now();
        request.endTime = endTime;
        request.duration = endTime - request.startTime;
        request.status = response.status();
        request.failed = response.status() >= 400;

        // Track response size
        const contentLength = response.headers()["content-length"];
        if (contentLength) {
          request.size = parseInt(contentLength, 10);
        }

        this.metrics.activeConnections--;

        // Track long-running requests
        if (request.duration > 10000) {
          this.metrics.longRunningRequests.push(request);
          this.addWarning(
            "medium",
            `Long-running request: ${request.method} ${url} (${request.duration}ms)`,
          );
        }
      }
    });

    this.page.on("requestfailed", (request) => {
      const url = request.url();
      const networkRequest = this.requestMap.get(url);
      if (networkRequest) {
        networkRequest.failed = true;
        networkRequest.endTime = Date.now();
        networkRequest.duration =
          networkRequest.endTime - networkRequest.startTime;
        this.metrics.activeConnections--;
        this.addWarning("high", `Request failed: ${request.method()} ${url}`);
      }
    });
  }

  /**
   * Track Flutter engine initialization
   */
  private async trackFlutterEngine(): Promise<void> {
    // Poll for Flutter engine status
    const checkInterval = setInterval(async () => {
      try {
        const status = await this.page.evaluate(() => {
          return {
            flutterReady: (window as any).flutterReady === true,
            flutterObject: typeof (window as any).flutter !== "undefined",
            sceneHost: document.querySelector("flt-scene-host") !== null,
            canvas: document.querySelector("canvas") !== null,
          };
        });

        if (
          status.flutterReady &&
          !this.metrics.flutterEngineStatus.initialized
        ) {
          this.metrics.flutterEngineStatus.initialized = true;
          this.metrics.flutterEngineStatus.readyTime =
            Date.now() - this.startTime;
          this.metrics.flutterReady =
            this.metrics.flutterEngineStatus.readyTime;
          console.log(
            `[Performance] Flutter engine ready: ${this.metrics.flutterEngineStatus.readyTime}ms`,
          );
          clearInterval(checkInterval);
        }
      } catch (error) {
        // Page may not be ready yet
      }
    }, 100);

    // Stop checking after 2 minutes
    setTimeout(() => {
      clearInterval(checkInterval);
      if (!this.metrics.flutterEngineStatus.initialized) {
        this.addWarning(
          "high",
          "Flutter engine did not initialize within 2 minutes",
        );
      }
    }, 120000);
  }

  /**
   * Monitor for performance issues and generate warnings
   */
  private monitorPerformanceIssues(): void {
    // Check for excessive network activity
    setInterval(() => {
      if (this.metrics.activeConnections > 20) {
        this.addWarning(
          "medium",
          `High number of active connections: ${this.metrics.activeConnections}`,
        );
      }
    }, 5000);

    // Check for too many failed resources
    if (this.metrics.failedResources.length > 5) {
      this.addWarning(
        "high",
        `Many failed resources: ${this.metrics.failedResources.length}`,
      );
    }
  }

  /**
   * Get final performance metrics
   */
  async getMetrics(): Promise<PerformanceMetrics> {
    this.metrics.totalLoadTime = Date.now() - this.startTime;
    this.metrics.networkRequests = Array.from(this.requestMap.values());
    this.metrics.warnings = this.warnings;

    // Calculate router ready time
    try {
      const routerReady = await this.page.evaluate(() => {
        return window.location.hash !== "" || window.location.pathname !== "/";
      });
      if (routerReady) {
        this.metrics.routerReady = Date.now() - this.startTime;
      }
    } catch (error) {
      // Router check may fail
    }

    // Calculate interactive ready time
    try {
      const hasInteractiveElements = await this.page.evaluate(() => {
        return (
          document.querySelector("input") !== null ||
          document.querySelector("button") !== null ||
          document.querySelector("a") !== null
        );
      });
      if (hasInteractiveElements) {
        this.metrics.interactiveReady = Date.now() - this.startTime;
      }
    } catch (error) {
      // Interactive check may fail
    }

    return this.metrics;
  }

  /**
   * Generate performance report
   */
  async generateReport(): Promise<string> {
    const metrics = await this.getMetrics();
    const report: string[] = [];

    report.push(
      "\n═══════════════════════════════════════════════════════════",
    );
    report.push("PERFORMANCE DIAGNOSTIC REPORT");
    report.push(
      "═══════════════════════════════════════════════════════════\n",
    );

    // Timing summary
    report.push("⏱️  TIMING METRICS:");
    report.push(`   Total load time: ${metrics.totalLoadTime}ms`);
    if (metrics.domContentLoaded > 0) {
      report.push(`   DOMContentLoaded: ${metrics.domContentLoaded}ms`);
    }
    if (metrics.loadComplete > 0) {
      report.push(`   Load complete: ${metrics.loadComplete}ms`);
    }
    if (metrics.flutterReady) {
      report.push(`   Flutter engine ready: ${metrics.flutterReady}ms`);
    }
    if (metrics.routerReady) {
      report.push(`   Router ready: ${metrics.routerReady}ms`);
    }
    if (metrics.interactiveReady) {
      report.push(`   Interactive ready: ${metrics.interactiveReady}ms`);
    }
    report.push("");

    // Resource loading summary
    report.push("📦 RESOURCE LOADING:");
    report.push(`   Total resources: ${metrics.resources.length}`);
    report.push(
      `   Total size: ${(metrics.totalResourceSize / 1024 / 1024).toFixed(2)}MB`,
    );
    report.push(`   Failed resources: ${metrics.failedResources.length}`);

    // Resource breakdown by type
    const resourcesByType = new Map<string, number>();
    metrics.resources.forEach((r) => {
      resourcesByType.set(r.type, (resourcesByType.get(r.type) || 0) + 1);
    });
    report.push("   By type:");
    resourcesByType.forEach((count, type) => {
      report.push(`     ${type}: ${count}`);
    });
    report.push("");

    // Network activity
    report.push("🌐 NETWORK ACTIVITY:");
    report.push(`   Total requests: ${metrics.networkRequests.length}`);
    report.push(`   Active connections: ${metrics.activeConnections}`);
    report.push(`   WebSocket connections: ${metrics.websocketConnections}`);
    report.push(
      `   Long-running requests (>10s): ${metrics.longRunningRequests.length}`,
    );

    // Top slowest resources
    const slowestResources = metrics.resources
      .sort((a, b) => b.loadTime - a.loadTime)
      .slice(0, 5);
    if (slowestResources.length > 0) {
      report.push("   Slowest resources:");
      slowestResources.forEach((r) => {
        report.push(
          `     ${r.type}: ${r.loadTime}ms (${(r.size / 1024).toFixed(2)}KB) - ${r.url.substring(0, 80)}`,
        );
      });
    }
    report.push("");

    // Flutter engine status
    report.push("🎨 FLUTTER ENGINE:");
    report.push(`   Initialized: ${metrics.flutterEngineStatus.initialized}`);
    report.push(`   WASM loaded: ${metrics.wasmLoaded}`);
    report.push(`   CanvasKit loaded: ${metrics.canvasKitLoaded}`);
    if (metrics.flutterEngineStatus.error) {
      report.push(`   Error: ${metrics.flutterEngineStatus.error}`);
    }
    report.push("");

    // Warnings
    if (metrics.warnings.length > 0) {
      report.push("⚠️  PERFORMANCE WARNINGS:");
      const bySeverity = {
        high: metrics.warnings.filter((w) => w.severity === "high"),
        medium: metrics.warnings.filter((w) => w.severity === "medium"),
        low: metrics.warnings.filter((w) => w.severity === "low"),
      };

      if (bySeverity.high.length > 0) {
        report.push(`   HIGH (${bySeverity.high.length}):`);
        bySeverity.high.forEach((w) => {
          report.push(`     - ${w.message}`);
        });
      }
      if (bySeverity.medium.length > 0) {
        report.push(`   MEDIUM (${bySeverity.medium.length}):`);
        bySeverity.medium.forEach((w) => {
          report.push(`     - ${w.message}`);
        });
      }
      if (bySeverity.low.length > 0) {
        report.push(`   LOW (${bySeverity.low.length}):`);
        bySeverity.low.forEach((w) => {
          report.push(`     - ${w.message}`);
        });
      }
      report.push("");
    }

    // Recommendations
    report.push("💡 RECOMMENDATIONS:");
    if (metrics.totalLoadTime > 30000) {
      report.push(
        "   ⚠️  Load time exceeds 30s - investigate performance bottlenecks",
      );
    }
    if (metrics.failedResources.length > 0) {
      report.push(
        `   ⚠️  ${metrics.failedResources.length} failed resources - check network connectivity`,
      );
    }
    if (metrics.longRunningRequests.length > 0) {
      report.push(
        `   ⚠️  ${metrics.longRunningRequests.length} long-running requests - may prevent network idle`,
      );
    }
    if (metrics.websocketConnections > 0) {
      report.push(
        `   ⚠️  ${metrics.websocketConnections} WebSocket connections - network will never be idle`,
      );
    }
    if (!metrics.flutterEngineStatus.initialized) {
      report.push(
        "   ⚠️  Flutter engine did not initialize - check for JavaScript errors",
      );
    }
    if (metrics.warnings.filter((w) => w.severity === "high").length > 0) {
      report.push(
        "   ⚠️  High severity warnings detected - investigate immediately",
      );
    }
    report.push("");

    report.push(
      "═══════════════════════════════════════════════════════════\n",
    );

    return report.join("\n");
  }

  /**
   * Check if a resource is blocking (prevents page from being interactive)
   */
  private isBlockingResource(type: string, url: string): boolean {
    // WASM and main JS are blocking
    if (type === "wasm" || type === "javascript") {
      return true;
    }
    // CanvasKit is blocking
    if (url.includes("canvaskit")) {
      return true;
    }
    // Critical fonts may be blocking
    if (
      (type === "font" && url.includes("Roboto")) ||
      url.includes("Material")
    ) {
      return true;
    }
    return false;
  }

  /**
   * Get request type from URL
   */
  private getRequestType(url: string): string {
    if (url.includes("/api/")) return "api";
    if (url.startsWith("ws://") || url.startsWith("wss://")) return "websocket";
    if (url.includes(".wasm")) return "wasm";
    if (url.includes(".js")) return "javascript";
    if (url.includes(".css")) return "css";
    if (url.includes(".woff") || url.includes(".ttf")) return "font";
    if (url.includes(".png") || url.includes(".jpg") || url.includes(".webp"))
      return "image";
    return "other";
  }

  /**
   * Add performance warning
   */
  private addWarning(
    severity: "low" | "medium" | "high",
    message: string,
  ): void {
    this.warnings.push({
      type: "performance",
      message,
      timestamp: Date.now() - this.startTime,
      severity,
    });
  }
}

/**
 * Instrument a page for performance monitoring
 * Returns a PerformanceInstrumentation instance that can be used to get metrics
 */
export function instrumentPerformance(page: Page): PerformanceInstrumentation {
  const instrumentation = new PerformanceInstrumentation(page);
  instrumentation.start();
  return instrumentation;
}

/**
 * Wait for network to be idle with detailed diagnostics
 * Provides information about what's preventing network idle
 */
export async function waitForNetworkIdleWithDiagnostics(
  page: Page,
  timeout = 60000,
  idleTime = 500,
): Promise<{
  success: boolean;
  reason?: string;
  activeRequests?: number;
  websocketConnections?: number;
}> {
  const startTime = Date.now();
  let lastActivityTime = Date.now();
  let activeRequests = 0;
  let websocketConnections = 0;

  const requestSet = new Set<string>();

  page.on("request", (request) => {
    requestSet.add(request.url());
    activeRequests = requestSet.size;
    lastActivityTime = Date.now();

    if (
      request.url().startsWith("ws://") ||
      request.url().startsWith("wss://")
    ) {
      websocketConnections++;
    }
  });

  page.on("response", () => {
    lastActivityTime = Date.now();
  });

  // Poll for network idle
  while (Date.now() - startTime < timeout) {
    const timeSinceLastActivity = Date.now() - lastActivityTime;
    const currentActiveRequests = requestSet.size;

    // Check if network is idle
    if (timeSinceLastActivity >= idleTime && currentActiveRequests === 0) {
      return {
        success: true,
        activeRequests: 0,
        websocketConnections,
      };
    }

    // Check timeout
    if (Date.now() - startTime >= timeout) {
      return {
        success: false,
        reason: `Timeout after ${timeout}ms`,
        activeRequests: currentActiveRequests,
        websocketConnections,
      };
    }

    // Wait a bit before checking again
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return {
    success: false,
    reason: "Timeout",
    activeRequests,
    websocketConnections,
  };
}
