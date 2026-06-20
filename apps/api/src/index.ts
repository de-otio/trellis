/**
 * @de-otio/trellis — Public API
 *
 * Verticals import from this module to register extensions and start the server.
 */

export { startServer } from "./server.js";
export { registerExtension, getExtension, getExtensions } from "./extensions.js";
// Realtime transport seam: a consuming app (e.g. Skybber) injects a concrete
// transport (AppSync Events) before serving; core ships the poll/noop default.
export { setRealtimeProvider } from "./lib/realtime/index.js";
