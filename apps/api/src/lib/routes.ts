/**
 * Route Registry
 *
 * @deprecated Routes have been migrated to domain-based files in ./routes/
 * This file re-exports from the new structure for backward compatibility.
 *
 * New code should import from './routes/index.js' instead.
 */

// Re-export everything from the new routes structure
export { routes, type Route } from "./routes/index.js";
