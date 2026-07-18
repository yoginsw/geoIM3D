// Optional geoIM3D viewer deployment placeholder.
//
// No public viewer hostname or origin is approved. Keep this worker fail-closed
// until JBT approves an exact deployment hostname, origin, CSP, and release
// process. The desktop/web clients also reject public viewer overrides today.

export default {
  async fetch(): Promise<Response> {
    return new Response("geoIM3D viewer deployment is not configured", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  },
};
