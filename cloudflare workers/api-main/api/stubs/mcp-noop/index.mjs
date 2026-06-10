// Noop stub for @modelcontextprotocol/sdk. Never executed at runtime — the
// only code paths that import MCP live in agents-core's optional shim layer
// and are not reachable from this worker's entry points. Named exports below
// exist only to satisfy esbuild's static import resolution.
export default {};
export const DEFAULT_REQUEST_TIMEOUT_MSEC = 60000;
