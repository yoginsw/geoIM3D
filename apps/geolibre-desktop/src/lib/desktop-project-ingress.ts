import type { GeoLibreProject } from "@geolibre/core";
import { assertProjectSafeForExternalTransfer } from "./project-private-content";

type IngressSource = "local" | "remote";
type IngressRoute =
  | "LOCAL_OPEN"
  | "LOCAL_RECENT"
  | "LOCAL_STARTUP_ARGUMENT"
  | "LOCAL_DRAG_DROP"
  | "REMOTE_URL"
  | "REMOTE_HTTP_RECENT"
  | "REMOTE_DEEP_LINK"
  | "REMOTE_SHARE"
  | "REMOTE_EMBED"
  | "REMOTE_COLLABORATION";
type IngressContext = object;
function isTauriTarget(): boolean {
  return typeof __TAURI_BUILD__ !== "undefined" && __TAURI_BUILD__;
}
function isWindowsTauriTarget(): boolean {
  return (
    typeof __WINDOWS_TAURI_BUILD__ !== "undefined" && __WINDOWS_TAURI_BUILD__
  );
}
const PRIVATE_PROJECT_INVALID =
  typeof __WINDOWS_TAURI_BUILD__ !== "undefined" && __WINDOWS_TAURI_BUILD__
    ? "VIEWSHED_PROJECT_INVALID"
    : "PROJECT_PRIVATE_CONTENT_REJECTED";

const routeSource: Readonly<Record<IngressRoute, IngressSource>> = {
  LOCAL_OPEN: "local",
  LOCAL_RECENT: "local",
  LOCAL_STARTUP_ARGUMENT: "local",
  LOCAL_DRAG_DROP: "local",
  REMOTE_URL: "remote",
  REMOTE_HTTP_RECENT: "remote",
  REMOTE_DEEP_LINK: "remote",
  REMOTE_SHARE: "remote",
  REMOTE_EMBED: "remote",
  REMOTE_COLLABORATION: "remote",
};
const contexts = new WeakMap<
  IngressContext,
  { route: IngressRoute; source: IngressSource; used: boolean }
>();

function issue(route: IngressRoute): IngressContext {
  const context = Object.freeze(Object.create(null)) as IngressContext;
  contexts.set(context, { route, source: routeSource[route], used: false });
  return context;
}

async function consume(
  project: GeoLibreProject,
  context: IngressContext,
  expectedRoute: IngressRoute
): Promise<GeoLibreProject> {
  const metadata = contexts.get(context);
  const expectedSource = routeSource[expectedRoute];
  if (
    !metadata ||
    metadata.used ||
    metadata.route !== expectedRoute ||
    metadata.source !== expectedSource
  ) {
    throw new Error(PRIVATE_PROJECT_INVALID);
  }
  metadata.used = true;
  if (expectedSource === "remote" || !isTauriTarget())
    assertProjectSafeForExternalTransfer(project);
  if (!isTauriTarget()) return project;
  const { sanitizeIncomingIfcProject } = await import("./ifc-project");
  const ifcSanitized = sanitizeIncomingIfcProject(project);
  const { sanitizeIncomingEarthworkProject } = await import(
    "./earthwork-project"
  );
  const earthworkSanitized = sanitizeIncomingEarthworkProject(ifcSanitized);
  if (!isWindowsTauriTarget()) {
    assertProjectSafeForExternalTransfer(earthworkSanitized);
    return earthworkSanitized;
  }
  const { sanitizeIncomingTerrainSafetyProject } = await import(
    "./terrain-safety-project"
  );
  const terrainSanitized =
    sanitizeIncomingTerrainSafetyProject(earthworkSanitized);
  const { sanitizeIncomingViewshedProject } = await import(
    "./viewshed-project"
  );
  return sanitizeIncomingViewshedProject(terrainSanitized);
}

function wrapper(route: IngressRoute) {
  return (project: GeoLibreProject): Promise<GeoLibreProject> =>
    consume(project, issue(route), route);
}

/** @internal Test seam: exercises capability misuse without exposing a context or factory. */
export async function verifyIngressCapabilityIsolationForTest(
  project: GeoLibreProject
): Promise<{ forged: boolean; replay: boolean; crossRoute: boolean }> {
  const rejected = async (run: () => Promise<unknown>): Promise<boolean> => {
    try {
      await run();
      return false;
    } catch {
      return true;
    }
  };
  const forged = await rejected(() =>
    consume(
      project,
      Object.freeze(Object.create(null)) as IngressContext,
      "LOCAL_OPEN"
    )
  );
  const replayContext = issue("LOCAL_OPEN");
  await consume(project, replayContext, "LOCAL_OPEN");
  const replay = await rejected(() =>
    consume(project, replayContext, "LOCAL_OPEN")
  );
  const crossRouteContext = issue("LOCAL_OPEN");
  const crossRoute = await rejected(() =>
    consume(project, crossRouteContext, "LOCAL_RECENT")
  );
  return { forged, replay, crossRoute };
}

export const sanitizeLocalOpenProject = wrapper("LOCAL_OPEN");
export const sanitizeLocalRecentProject = wrapper("LOCAL_RECENT");
export const sanitizeLocalStartupProject = wrapper("LOCAL_STARTUP_ARGUMENT");
export const sanitizeLocalDropProject = wrapper("LOCAL_DRAG_DROP");
export const sanitizeRemoteUrlProject = wrapper("REMOTE_URL");
export const sanitizeRemoteHttpRecentProject = wrapper("REMOTE_HTTP_RECENT");
export const sanitizeRemoteDeepLinkProject = wrapper("REMOTE_DEEP_LINK");
export const sanitizeRemoteShareProject = wrapper("REMOTE_SHARE");
export const sanitizeRemoteEmbedProject = wrapper("REMOTE_EMBED");
export const sanitizeRemoteCollaborationProject = wrapper(
  "REMOTE_COLLABORATION"
);
