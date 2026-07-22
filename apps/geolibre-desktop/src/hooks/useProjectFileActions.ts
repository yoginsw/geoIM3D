import {
  DEFAULT_PROJECT_NAME,
  projectFromStore,
  serializeProject,
  useAppStore,
  type GeoLibreProject,
  type GeoLibreLayer,
} from "@geolibre/core";
import { materializeEmbeddableVectorLayers } from "@geolibre/plugins";
import type { FeatureCollection } from "geojson";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getPluginManager } from "./usePlugins";
import { useDesktopSettingsStore } from "./useDesktopSettings";
import {
  browserSaveFallsBackToDownload,
  isAbsoluteLocalPath,
  isHttpUrl,
  isTauri,
  openProjectFile,
  openRecentProjectFile,
  RecentProjectGoneError,
  saveProjectFile,
  saveProjectFileToPath,
  saveTextFileWithFallback,
  takeStartupProjectPath,
} from "../lib/tauri-io";
import {
  MAX_LOCAL_PROJECT_BYTES,
  parseBoundedLocalProjectBytes,
} from "../lib/project-file-bytes";
import { buildProjectHtml } from "../lib/html-export";
import { ensureHtmlFileName, ensureProjectFileName } from "../lib/file-names";
import {
  prepareProjectForFileSave,
  sanitizeIncomingProjectCredentials,
} from "../lib/project-file-contract";
import { sanitizeDesktopProjectForLocalSave } from "../lib/desktop-project-egress";
import { mergeStringLists } from "../lib/string-lists";
import { fetchProjectFromUrl } from "../lib/project-url";
import { getShareFetch } from "../lib/share-fetch";
import { resolveShareBaseUrl } from "../lib/share-geolibre";
import { shareAuthorizedFetch } from "../lib/share-gallery";
import { normalizeProjectUrl } from "../lib/urls";
import { resolveProjectXyzLayers } from "../lib/xyz-url";
import type { MapControllerRef } from "../components/layout/toolbar/constants";
import {
  sanitizeLocalDropProject,
  sanitizeLocalOpenProject,
  sanitizeLocalRecentProject,
  sanitizeLocalStartupProject,
  sanitizeRemoteHttpRecentProject,
  sanitizeRemoteShareProject,
  sanitizeRemoteUrlProject,
} from "../lib/desktop-project-ingress";
import {
  assertProjectSafeForExternalTransfer,
  containsPersistedViewshedAnalysis,
  selectLayersWithoutPrivateEarthwork,
} from "../lib/project-private-content";
import { serializeViewshedProjectUtf8 } from "../lib/viewshed-project-serializer";
import {
  buildScenePresetFromProject,
  createProjectFromScenePreset,
  serializeScenePreset,
} from "../lib/scene-preset-contract";
import {
  createScenePresetParserClient,
  type ScenePresetParserClient,
} from "../lib/scene-preset-parser";
import { assertScenePresetExportPolicy } from "../lib/scene-preset-export-policy";
import { createScenePresetApplyCoordinator } from "../lib/scene-preset-apply-coordinator";
import { scenePresetNative } from "../lib/scene-preset-native";
import { materializeRelativeSceneResources } from "../lib/scene-preset-resource-materializer";
import {
  BLANK_3D_SCENE_PRESET_ID,
  getBuiltInScenePreset,
} from "../lib/scene-preset-builtins";

async function sanitizeIncomingDesktopProject(
  project: GeoLibreProject,
  route:
    | "open"
    | "recent"
    | "startup"
    | "drop"
    | "url"
    | "share"
    | "http-recent"
): Promise<GeoLibreProject> {
  if (route === "open") return sanitizeLocalOpenProject(project);
  if (route === "recent") return sanitizeLocalRecentProject(project);
  if (route === "startup") return sanitizeLocalStartupProject(project);
  if (route === "drop") return sanitizeLocalDropProject(project);
  if (route === "share") return sanitizeRemoteShareProject(project);
  if (route === "http-recent") return sanitizeRemoteHttpRecentProject(project);
  return sanitizeRemoteUrlProject(project);
}

/**
 * A pending "embed local vector data?" prompt, shown on the web when saving a
 * project that has local-file Add Vector Layer layers whose data would
 * otherwise be lost on reopen (the browser exposes no path to re-read them).
 */
export interface EmbedVectorDataPrompt {
  /** Number of local-file vector layers that can be embedded. */
  count: number;
  /** Total embedded size in bytes, for the size warning. */
  bytes: number;
  /**
   * Desktop hosts can save the layers as file references (reloaded from disk on
   * reopen) instead of embedding, so the "don't embed" choice is labelled and
   * described differently than on the web (where it discards the data).
   */
  desktop: boolean;
  resolve: (choice: "embed" | "noembed" | "cancel") => void;
}

/**
 * A pending "name this file" prompt, shown when a save runs in a browser that
 * can only download under a fixed name. Used by Save As (or a first Save) and by
 * Export as Interactive HTML; the dialog copy is carried on the prompt so the
 * same component serves both.
 */
export interface SaveNamePrompt {
  resolve: (name: string | null) => void;
  /** Dialog title. */
  title: string;
  /** Dialog description, explaining the browser-download behaviour. */
  description: string;
  /** Label for the file-name input. */
  label: string;
  /** Placeholder for the file-name input. */
  placeholder: string;
}

/**
 * Detects a plain GeoJSON layer that a desktop drag-drop or Add Data import
 * embedded from a local file whose absolute path was captured, so its data can
 * be re-read from disk on reopen rather than embedded in the project. Excludes
 * Add Vector Layer control layers (restored by their own path) and other
 * external-native/plugin layers, and any layer whose `sourcePath` is a URL.
 *
 * @param layer - A store layer.
 * @returns True when the layer's features should be saved as a path, not embedded.
 */
function isReloadableLocalFileLayer(layer: GeoLibreLayer): boolean {
  return (
    layer.type === "geojson" &&
    Boolean(layer.geojson) &&
    typeof layer.sourcePath === "string" &&
    isAbsoluteLocalPath(layer.sourcePath) &&
    layer.metadata.externalNativeLayer !== true &&
    layer.metadata.sourceKind == null
  );
}

interface ScenePresetApplyInput {
  bytes: Uint8Array;
  importCapability?: string;
}

/**
 * Bundles every project file action (open from file/URL/recent, save, save as)
 * along with the related dialog state (Open-from-URL, save prompts, and the
 * shared action-error dialog).
 *
 * @param mapControllerRef - Ref to the live MapController, read when serializing.
 * @returns Handlers and state consumed by the toolbar menus and dialogs.
 */
export function useProjectFileActions(mapControllerRef: MapControllerRef) {
  const { t } = useTranslation();
  const loadProject = useAppStore((s) => s.loadProject);
  const setProjectPath = useAppStore((s) => s.setProjectPath);
  const rememberRecentProject = useAppStore((s) => s.rememberRecentProject);
  const forgetRecentProject = useAppStore((s) => s.forgetRecentProject);
  const markSaved = useAppStore((s) => s.markSaved);

  const [actionError, setActionError] = useState<string | null>(null);
  const [projectUrlDialogOpen, setProjectUrlDialogOpen] = useState(false);
  const [projectUrl, setProjectUrl] = useState("");
  const [projectUrlError, setProjectUrlError] = useState<string | null>(null);
  const [projectUrlLoading, setProjectUrlLoading] = useState(false);

  const [embedVectorDataPrompt, setEmbedVectorDataPrompt] =
    useState<EmbedVectorDataPrompt | null>(null);
  const [saveNamePrompt, setSaveNamePrompt] = useState<SaveNamePrompt | null>(
    null
  );
  const [saveNameInput, setSaveNameInput] = useState("");
  const projectUrlAbortRef = useRef<AbortController | null>(null);
  const recentAbortRef = useRef<AbortController | null>(null);
  // Separate from projectUrlAbortRef so a gallery open and an Open-from-URL
  // submit can't abort each other's in-flight fetch.
  const shareUrlAbortRef = useRef<AbortController | null>(null);
  const startupProjectOpenStartedRef = useRef(false);
  // Guards against overlapping saves: a second save started while a prompt
  // dialog is open would overwrite the pending prompt and strand the first
  // call's unresolved promise.
  const isSavingRef = useRef(false);
  const isPresetSavingRef = useRef(false);
  const scenePresetSessionsRef = useRef(new Map<number, string>());
  const scenePresetParserRef = useRef<ScenePresetParserClient | null>(null);
  if (scenePresetParserRef.current === null) {
    scenePresetParserRef.current = createScenePresetParserClient();
  }
  const scenePresetCoordinatorRef = useRef<
    ReturnType<typeof createScenePresetApplyCoordinator<ScenePresetApplyInput>> | null
  >(null);
  if (scenePresetCoordinatorRef.current === null) {
    scenePresetCoordinatorRef.current =
      createScenePresetApplyCoordinator<ScenePresetApplyInput>({
        prepare: async (input, context) => {
          let project: GeoLibreProject;
          let sessionCapability = input.importCapability;
          try {
            const preset = await scenePresetParserRef.current!.parse(
              input.bytes,
              {
                requestId: context.requestId,
                generation: context.generation,
                signal: context.signal,
              },
            );
            project = createProjectFromScenePreset(preset);
            const needsNativeSession = await materializeRelativeSceneResources(
              preset,
              project,
              {
                importCapability: sessionCapability,
                generation: context.generation + 1,
                signal: context.signal,
                native: scenePresetNative,
              },
            );
            if (sessionCapability && !needsNativeSession) {
              await scenePresetNative.close(sessionCapability);
              sessionCapability = undefined;
            }
          } catch (error) {
            if (sessionCapability) {
              await scenePresetNative.close(sessionCapability).catch(() => {});
            }
            throw error;
          }
          let retained = false;
          return {
            project,
            disposePending: async () => {
              if (sessionCapability && !retained) {
                await scenePresetNative.close(sessionCapability);
              }
            },
            retainForGeneration: (generation) => {
              if (!sessionCapability) return;
              retained = true;
              scenePresetSessionsRef.current.set(
                generation,
                sessionCapability,
              );
            },
          };
        },
        publish: (project) => {
          loadProject(project, null, {
            rememberRecent: false,
            presenting: false,
            markDirty: true,
            workspaceTab: "cesium",
          });
          return useAppStore.getState().projectGeneration;
        },
        getGeneration: () => useAppStore.getState().projectGeneration,
        retireGeneration: async (oldGeneration) => {
          const capability = scenePresetSessionsRef.current.get(oldGeneration);
          if (!capability) return;
          scenePresetSessionsRef.current.delete(oldGeneration);
          await scenePresetNative.close(capability);
        },
      });
  }

  useEffect(() => {
    if (startupProjectOpenStartedRef.current || !isTauri()) return;
    startupProjectOpenStartedRef.current = true;

    void (async () => {
      try {
        const path = await takeStartupProjectPath();
        if (!path) return;
        const result = await openRecentProjectFile(path);
        loadProject(
          await sanitizeIncomingDesktopProject(
            sanitizeIncomingProjectCredentials(
              await resolveProjectXyzLayers(result.project)
            ),
            "startup"
          ),
          result.path,
          { rememberRecent: true }
        );
      } catch (error) {
        console.error("Failed to open startup project", error);
        setActionError(
          error instanceof Error
            ? error.message
            : t("toolbar.error.couldNotOpenProject")
        );
      }
    })();
  }, [loadProject, t]);

  useEffect(() => {
    const sessions = scenePresetSessionsRef.current;
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.projectGeneration === previous.projectGeneration) return;
      for (const [generation, capability] of sessions) {
        if (generation === state.projectGeneration) continue;
        sessions.delete(generation);
        void scenePresetNative.close(capability).catch(() => {});
      }
    });
    return () => {
      unsubscribe();
      scenePresetCoordinatorRef.current?.cancel();
      scenePresetParserRef.current?.cancel();
      for (const capability of sessions.values()) {
        void scenePresetNative.close(capability).catch(() => {});
      }
      sessions.clear();
    };
  }, []);

  const handleOpenFromFile = async () => {
    const result = await openProjectFile();
    if (result) {
      try {
        loadProject(
          await sanitizeIncomingDesktopProject(
            sanitizeIncomingProjectCredentials(
              await resolveProjectXyzLayers(result.project)
            ),
            "open"
          ),
          result.path,
          { rememberRecent: isTauri() }
        );
      } catch (error) {
        console.error("Failed to open project", error);
        setActionError(
          error instanceof Error
            ? error.message
            : t("toolbar.error.couldNotOpenProject")
        );
      }
    }
  };

  /** Open one browser drag-dropped canonical project without inventing a path. */
  const handleOpenDroppedProjectFile = async (
    file: File
  ): Promise<string | null> => {
    try {
      if (file.size > MAX_LOCAL_PROJECT_BYTES)
        throw new Error("PROJECT_FILE_TOO_LARGE");
      const project = await parseBoundedLocalProjectBytes(
        await file.arrayBuffer()
      );
      loadProject(
        await sanitizeIncomingDesktopProject(
          sanitizeIncomingProjectCredentials(
            await resolveProjectXyzLayers(project)
          ),
          "drop"
        ),
        null,
        {
          rememberRecent: false,
        }
      );
      return null;
    } catch (error) {
      console.error("Failed to open dropped project", error);
      return error instanceof Error
        ? error.message
        : t("toolbar.error.couldNotOpenProject");
    }
  };

  const handleOpenFromUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedUrl = normalizeProjectUrl(projectUrl);
    if (!normalizedUrl) {
      setProjectUrlError(t("toolbar.error.invalidProjectUrl"));
      return;
    }

    projectUrlAbortRef.current?.abort();
    const controller = new AbortController();
    projectUrlAbortRef.current = controller;

    setProjectUrlLoading(true);
    setProjectUrlError(null);

    try {
      const result = await openRecentProjectFile(
        normalizedUrl,
        controller.signal,
        getShareFetch()
      );
      const project = await resolveProjectXyzLayers(
        result.project,
        controller.signal
      );
      if (controller.signal.aborted) return;
      loadProject(
        await sanitizeIncomingDesktopProject(
          sanitizeIncomingProjectCredentials(project),
          "url"
        ),
        result.path
      );
      setProjectUrl("");
      setProjectUrlDialogOpen(false);
    } catch (error) {
      if (controller.signal.aborted) return;
      console.error("Failed to open project URL", error);
      setProjectUrlError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotOpenProjectUrl")
      );
    } finally {
      if (projectUrlAbortRef.current === controller) {
        projectUrlAbortRef.current = null;
      }
      setProjectUrlLoading(false);
    }
  };

  // Load a project directly from a known URL (e.g. a Project Gallery card's raw
  // JSON URL), bypassing the URL-input dialog. Mirrors handleOpenFromUrl's
  // fetch → resolve → loadProject flow but takes the URL as an argument and
  // rethrows on failure so the caller (the gallery dialog) can show the error
  // inline next to the card it came from.
  //
  // When `authToken` is set (the user has a administrator-configured Share service API token), the
  // request to the share host carries it as a Bearer token so the owner's
  // unlisted and private projects load too. The token is attached only for the
  // share host (see shareAuthorizedFetch), never to third-party hosts a project
  // might reference. Token-authenticated opens are not remembered as recent
  // (path = null), since reopening a private URL on restart would 403 without
  // the header.
  const openProjectFromShareUrl = async (
    url: string,
    options: { authToken?: string } = {}
  ): Promise<void> => {
    const normalizedUrl = normalizeProjectUrl(url);
    if (!normalizedUrl) {
      throw new Error(t("toolbar.error.invalidProjectUrl"));
    }

    shareUrlAbortRef.current?.abort();
    const controller = new AbortController();
    shareUrlAbortRef.current = controller;

    try {
      const baseFetch = getShareFetch();
      const fetched = await fetchProjectFromUrl(normalizedUrl, {
        signal: controller.signal,
        fetchImpl: options.authToken
          ? shareAuthorizedFetch(
              options.authToken,
              resolveShareBaseUrl(),
              // On desktop this routes the share host through Tauri's native
              // HTTP client, which is exempt from the WebView's CORS checks.
              baseFetch
            )
          : baseFetch,
      });
      const project = await resolveProjectXyzLayers(fetched, controller.signal);
      if (controller.signal.aborted) return;
      // Share service endpoints are compatibility APIs, not canonical local
      // file references, so never persist them as writable/recent paths.
      loadProject(
        await sanitizeIncomingDesktopProject(
          sanitizeIncomingProjectCredentials(project),
          "share"
        ),
        null
      );
    } finally {
      if (shareUrlAbortRef.current === controller) {
        shareUrlAbortRef.current = null;
      }
    }
  };

  // Returns an error message to surface, or null on success/abort. It does not
  // set the shared `actionError` itself, so each caller can route the failure to
  // its own surface (the toolbar's modal vs. the Browser panel's inline banner)
  // now that a single instance is shared across both.
  const handleOpenRecent = async (path: string): Promise<string | null> => {
    // Cancel any previous in-flight open so rapid clicks cannot race and let a
    // stale fetch win by resolving last.
    recentAbortRef.current?.abort();
    const controller = new AbortController();
    recentAbortRef.current = controller;

    let result: Awaited<ReturnType<typeof openRecentProjectFile>>;

    try {
      result = await openRecentProjectFile(
        path,
        controller.signal,
        getShareFetch()
      );
    } catch (error) {
      if (controller.signal.aborted) return null;
      // Only drop the entry when the project is permanently gone; preserve it
      // for transient failures (network timeout, 5xx, momentary IO error).
      if (error instanceof RecentProjectGoneError) {
        forgetRecentProject(path);
      }
      console.error("Failed to open recent project", error);
      return error instanceof Error
        ? error.message
        : t("toolbar.error.couldNotOpenRecentProject");
    }

    try {
      const project = await resolveProjectXyzLayers(
        result.project,
        controller.signal
      );
      if (controller.signal.aborted) return null;
      loadProject(
        await sanitizeIncomingDesktopProject(
          sanitizeIncomingProjectCredentials(project),
          isHttpUrl(path) ? "http-recent" : "recent"
        ),
        result.path
      );
      return null;
    } catch (error) {
      if (controller.signal.aborted) return null;
      console.error("Failed to load recent project", error);
      return error instanceof Error
        ? error.message
        : t("toolbar.error.couldNotLoadRecentProject");
    } finally {
      if (recentAbortRef.current === controller) {
        recentAbortRef.current = null;
      }
    }
  };

  // Build the current project from live store + map state and serialize it.
  // Shared by Save/Save As and the Share action so they all capture identical
  // project content (including the current map view and plugin state).
  const buildCurrentProject = async (
    nameOverride?: string,
    layersOverride?: GeoLibreLayer[],
    assertSource?: (project: GeoLibreProject) => void,
  ) => {
    const state = useAppStore.getState();
    const defaultProjectName =
      nameOverride?.trim() || state.projectName.trim() || DEFAULT_PROJECT_NAME;
    const pluginManifestUrls = mergeStringLists(
      state.projectPlugins?.manifestUrls ?? [],
      useDesktopSettingsStore.getState().desktopSettings.pluginManifestUrls
    );
    const project = projectFromStore({
      projectName: defaultProjectName,
      mapView: mapControllerRef.current?.readView() ?? state.mapView,
      basemapStyleUrl: state.basemapStyleUrl,
      basemapVisible: state.basemapVisible,
      basemapOpacity: state.basemapOpacity,
      layers: layersOverride ?? state.layers,
      layerGroups: state.layerGroups,
      preferences: state.preferences,
      plugins: {
        ...getPluginManager().getProjectState(),
        manifestUrls: pluginManifestUrls,
      },
      legend: state.legend,
      storymap: state.storymap,
      models: state.models,
      widgets: state.widgets,
      dashboardColumns: state.dashboardColumns,
      mapLayout: state.mapLayout,
      secondaryMapViews: state.secondaryMapViews,
      primaryMapLabel: state.primaryMapLabel,
      metadata: state.metadata,
    });
    // Preset export requires rejection on the untouched snapshot. Generic
    // Project save intentionally omits this callback and keeps its sanitizer.
    assertSource?.(project);
    const portableProject = prepareProjectForFileSave(project);
    const sanitizedProject = await sanitizeDesktopProjectForLocalSave(
      portableProject
    );
    const hasViewshed = containsPersistedViewshedAnalysis(sanitizedProject);
    const localContent = hasViewshed
      ? serializeViewshedProjectUtf8(sanitizedProject)
      : serializeProject(sanitizedProject);
    return {
      project: sanitizedProject,
      sourceProject: project,
      defaultProjectName,
      content: hasViewshed ? "" : (localContent as string),
      localContent,
      // Expose the path read from this same snapshot so callers don't take a
      // second `getState()` read that could be misread as a separate instant.
      projectPath: state.projectPath,
    };
  };

  // Ask whether to embed local vector layers' data in the saved file. Resolves
  // when the user picks an option in the dialog.
  const askEmbedVectorData = (count: number, bytes: number, desktop: boolean) =>
    new Promise<"embed" | "noembed" | "cancel">((resolve) => {
      setEmbedVectorDataPrompt({ count, bytes, desktop, resolve });
    });

  const resolveEmbedVectorDataPrompt = (
    choice: "embed" | "noembed" | "cancel"
  ) => {
    embedVectorDataPrompt?.resolve(choice);
    setEmbedVectorDataPrompt(null);
  };

  // Builds the embed-mode layers: every local vector layer carries its own
  // features so the project is self-contained (portable to another machine or
  // administrator-configured Share service). Add Vector Layer control layers get their features
  // materialized into `metadata.embeddedGeoJSON`; plain GeoJSON layers already
  // hold their `geojson`. The `localFileReloadable` flag is cleared so the
  // embedded data — not a file path that may not exist elsewhere — is what
  // restores. Used by the save dialog's Embed choice and by Share (always).
  const buildEmbeddedLayers = async (
    layers: GeoLibreLayer[],
    prebuilt?: Map<string, FeatureCollection>
  ): Promise<GeoLibreLayer[]> => {
    // Reuse a map the caller already materialized (the Embed save path) so each
    // layer's features aren't read from the control twice, but materialize any
    // layer it doesn't cover — e.g. one added while the save dialog was open —
    // so a late addition still gets its data instead of being dropped.
    const embeddable = new Map(prebuilt);
    const uncovered = prebuilt
      ? layers.filter((layer) => !prebuilt.has(layer.id))
      : layers;
    if (uncovered.length > 0) {
      for (const [id, collection] of await materializeEmbeddableVectorLayers(
        selectLayersWithoutPrivateEarthwork(uncovered)
      )) {
        embeddable.set(id, collection);
      }
    }
    return layers.map((layer) => {
      let metadata = layer.metadata;
      const collection = embeddable.get(layer.id);
      if (collection) metadata = { ...metadata, embeddedGeoJSON: collection };
      if (metadata.localFileReloadable === true) {
        const { localFileReloadable: _drop, ...rest } = metadata;
        metadata = rest;
      }
      return metadata === layer.metadata ? layer : { ...layer, metadata };
    });
  };

  // Sums the UTF-8 byte size of every local layer's features, for the embed
  // prompt's size warning. Vector control layers are materialized; plain
  // GeoJSON layers use their `geojson`.
  const estimateEmbedBytes = (
    layers: GeoLibreLayer[],
    embeddable: Map<string, FeatureCollection>
  ): number => {
    const encoder = new TextEncoder();
    let bytes = 0;
    for (const collection of embeddable.values()) {
      bytes += encoder.encode(JSON.stringify(collection)).length;
    }
    for (const layer of layers) {
      if (isReloadableLocalFileLayer(layer) && layer.geojson) {
        bytes += encoder.encode(JSON.stringify(layer.geojson)).length;
      }
    }
    return bytes;
  };

  // Decides how a save serializes local vector layers. On the web they can only
  // be embedded (no filesystem path), so the prompt offers Embed or Save
  // without data. On desktop they can also be saved as file references that
  // reload from disk on reopen, so the prompt offers Embed or Save file
  // references. Returns the layers override to serialize, an empty result to use
  // the live layers as-is, or "cancel" to abort the save.
  const resolveLayersForSave = async (): Promise<
    { layers?: GeoLibreLayer[] } | "cancel"
  > => {
    const state = useAppStore.getState();
    const embeddable = await materializeEmbeddableVectorLayers(
      selectLayersWithoutPrivateEarthwork(state.layers)
    );
    const localFileLayers = isTauri()
      ? state.layers.filter(isReloadableLocalFileLayer)
      : [];
    if (embeddable.size === 0 && localFileLayers.length === 0) return {};

    const count = embeddable.size + localFileLayers.length;
    const bytes = estimateEmbedBytes(state.layers, embeddable);
    const choice = await askEmbedVectorData(count, bytes, isTauri());
    if (choice === "cancel") return "cancel";

    if (choice === "embed") {
      // Reuse the map already materialized for the size estimate.
      return {
        layers: await buildEmbeddedLayers(
          useAppStore.getState().layers,
          embeddable
        ),
      };
    }

    // "noembed": on the web this saves without the local data (those layers are
    // lost on reopen). On desktop it saves file references — but only for layers
    // that actually have a re-readable path; the rest (e.g. an Add Vector Layer
    // file restored from an embedded copy on a machine without the original) are
    // embedded as a fallback, since referencing them would save no data at all.
    if (!isTauri()) return {};
    let changed = false;
    const layers = useAppStore.getState().layers.map((layer) => {
      // Plain GeoJSON with an absolute path → reference (drop the embedded copy).
      if (isReloadableLocalFileLayer(layer)) {
        changed = true;
        return {
          ...layer,
          metadata: { ...layer.metadata, localFileReloadable: true },
        };
      }
      // An Add Vector Layer control layer already carrying a path references it
      // as-is; one without a path can't be referenced, so embed its features.
      const collection = embeddable.get(layer.id);
      if (collection && layer.metadata.localFileReloadable !== true) {
        changed = true;
        return {
          ...layer,
          metadata: { ...layer.metadata, embeddedGeoJSON: collection },
        };
      }
      return layer;
    });
    return changed ? { layers } : {};
  };

  // Builds the current project with all local vector data embedded, for sharing.
  // A shared project is opened on another machine (or in the browser) where the
  // original files do not exist, so it must be self-contained — never file
  // references. Used by the Share dialog.
  const buildEmbeddedProject = async (nameOverride?: string) => {
    assertProjectSafeForExternalTransfer(
      (await buildCurrentProject(nameOverride)).project
    );
    const layers = await buildEmbeddedLayers(useAppStore.getState().layers);
    const result = await buildCurrentProject(nameOverride, layers);
    assertProjectSafeForExternalTransfer(result.project);
    return result;
  };

  // Ask the user to name the file. Used only when saving falls back to a browser
  // download (no File System Access picker), where the name is the only thing
  // the user can control. The caller supplies the dialog copy so the same prompt
  // serves both project saves and HTML exports. Resolves with the name, or null
  // if cancelled.
  const askSaveName = (
    defaultName: string,
    labels: Omit<SaveNamePrompt, "resolve">
  ) =>
    new Promise<string | null>((resolve) => {
      setSaveNameInput(defaultName);
      setSaveNamePrompt({ resolve, ...labels });
    });

  const submitSaveNamePrompt = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    saveNamePrompt?.resolve(saveNameInput);
    setSaveNamePrompt(null);
    setSaveNameInput("");
  };

  const cancelSaveNamePrompt = () => {
    saveNamePrompt?.resolve(null);
    setSaveNamePrompt(null);
    setSaveNameInput("");
  };

  const runSaveProject = async (options?: {
    saveAs?: boolean;
  }): Promise<boolean> => {
    // Offer to embed local vector data (or, on desktop, save file references)
    // first, so the serialized content below reflects the user's choice.
    const layersForSave = await resolveLayersForSave();
    if (layersForSave === "cancel") return false;
    const { project, defaultProjectName, localContent, projectPath } =
      await buildCurrentProject(undefined, layersForSave.layers);
    // buildCurrentProject always removes runtime environment values from the
    // portable content while preserving them in the live store.
    const contentToSave = localContent;
    // Projects opened from a URL have no writable path, so both Save and
    // Save As fall back to the save dialog for them.
    const existingLocalPath =
      projectPath && !isHttpUrl(projectPath) ? projectPath : null;
    // Browsers without the File System Access picker (Firefox, Safari) can only
    // download under a fixed name, so Save As (and a first Save) would otherwise
    // reuse a default name — exactly the bug users hit. Prompt for the name so
    // they can choose it; later in-place Saves reuse the chosen name silently.
    let saveName = ensureProjectFileName(defaultProjectName);
    const promptForName =
      browserSaveFallsBackToDownload() &&
      (options?.saveAs === true || !existingLocalPath);
    if (promptForName) {
      const chosen = await askSaveName(saveName, {
        title: t("toolbar.item.saveProjectAsTitle"),
        description: t("toolbar.item.saveProjectAsDesc"),
        label: t("toolbar.item.saveProjectFileName"),
        placeholder: t("toolbar.item.saveProjectFileNamePlaceholder"),
      });
      if (chosen === null) return false;
      saveName = ensureProjectFileName(chosen);
    }
    let path: string | null;
    try {
      path =
        !options?.saveAs && existingLocalPath
          ? await saveProjectFileToPath(contentToSave, existingLocalPath)
          : await saveProjectFile(
              contentToSave,
              promptForName ? saveName : existingLocalPath ?? saveName
            );
    } catch (error) {
      console.error("Failed to save project", error);
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotSaveProject")
      );
      return false;
    }
    if (!path) return false;
    setProjectPath(path);
    rememberRecentProject({
      path,
      name: project.name,
      openedAt: new Date().toISOString(),
    });
    markSaved();
    return true;
  };

  // Serialize saves so overlapping invocations cannot clobber a pending prompt.
  const saveProject = async (options?: {
    saveAs?: boolean;
  }): Promise<boolean> => {
    if (isSavingRef.current) return false;
    isSavingRef.current = true;
    try {
      return await runSaveProject(options);
    } finally {
      isSavingRef.current = false;
    }
  };

  const handleSave = () => saveProject();
  const handleSaveAs = () => saveProject({ saveAs: true });

  // Export the current project as a standalone interactive HTML page (#821).
  // Shares saveProject's guard so a double-click can't open two save dialogs.
  const handleExportHtml = async (): Promise<boolean> => {
    if (isSavingRef.current) return false;
    isSavingRef.current = true;
    try {
      // Derive the default file name from the project name in the store first,
      // without materializing embedded data, so the prompt can appear right away
      // and a cancel discards no work. This snapshot is passed to
      // buildEmbeddedProject as the name override below, so the file-name slug
      // and the HTML title stay consistent even if the project is renamed while
      // the name prompt is open.
      const projectName =
        useAppStore.getState().projectName.trim() || DEFAULT_PROJECT_NAME;
      const slug =
        projectName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "") || "geolibre-map";
      // Browsers without the File System Access save picker (Firefox, Safari)
      // would otherwise download immediately under the generated name, with no
      // chance to rename the file (issue #991). Prompt for the name first;
      // desktop and Chromium hosts get a native save dialog from
      // saveTextFileWithFallback below instead.
      let defaultName = `${slug}.html`;
      if (browserSaveFallsBackToDownload()) {
        const chosen = await askSaveName(defaultName, {
          title: t("toolbar.item.exportHtmlAsTitle"),
          description: t("toolbar.item.exportHtmlAsDesc"),
          label: t("toolbar.item.exportHtmlFileName"),
          placeholder: t("toolbar.item.exportHtmlFileNamePlaceholder"),
        });
        if (chosen === null) return false;
        defaultName = ensureHtmlFileName(chosen, slug);
      }
      // Only now embed local vector data (self-contained, like Share) and strip
      // env vars (secrets serve no purpose in a static viewer): this can be
      // costly on a project with many local layers, so it runs after the user
      // has committed to the export rather than before the prompt. Reuse the
      // name snapshot so the title matches the slug computed above.
      const { project, defaultProjectName } = await buildEmbeddedProject(
        projectName
      );
      const safeProject = {
        ...project,
        preferences: { ...project.preferences, environmentVariables: [] },
      };
      const html = buildProjectHtml({
        project: safeProject,
        title: defaultProjectName,
      });
      // Returns null when the user cancels the save dialog; report that as a
      // no-op rather than a successful export.
      const savedPath = await saveTextFileWithFallback(html, {
        defaultName,
        filters: [{ name: t("toolbar.item.htmlFile"), extensions: ["html"] }],
        browserTypes: [
          {
            description: t("toolbar.item.htmlFile"),
            accept: { "text/html": [".html"] },
          },
        ],
        mimeType: "text/html",
      });
      return savedPath !== null;
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : t("toolbar.error.couldNotExportHtml")
      );
      return false;
    } finally {
      isSavingRef.current = false;
    }
  };

  const handleNewBlank3dScene = async (): Promise<boolean> => {
    try {
      const preset = getBuiltInScenePreset(
        BLANK_3D_SCENE_PRESET_ID,
        t("toolbar.item.blank3dSceneName", { defaultValue: "빈 3D 장면" }),
      );
      const bytes = serializeScenePreset(preset);
      const result = await scenePresetCoordinatorRef.current!.apply({ bytes });
      return result.status === "applied";
    } catch (error) {
      setActionError(scenePresetNative.toPublicError(error));
      return false;
    }
  };

  const handleImportScenePreset = async (): Promise<boolean> => {
    if (!isTauri()) {
      setActionError("SCENE_PRESET_REMOTE_DENIED");
      return false;
    }
    try {
      const selected = await scenePresetNative.pickAndRead();
      const result = await scenePresetCoordinatorRef.current!.apply({
        bytes: selected.bytes,
        importCapability: selected.importCapability,
      });
      return result.status === "applied";
    } catch (error) {
      const code = scenePresetNative.toPublicError(error);
      if (code !== "SCENE_PRESET_CANCELLED") setActionError(code);
      return false;
    }
  };

  const handleExportScenePreset = async (): Promise<boolean> => {
    if (isPresetSavingRef.current) return false;
    if (!isTauri()) {
      setActionError("SCENE_PRESET_REMOTE_DENIED");
      return false;
    }
    isPresetSavingRef.current = true;
    try {
      // Validate and fully serialize before opening a save target. A contract
      // failure therefore cannot create or mutate any filesystem entry.
      const { sourceProject } = await buildCurrentProject(
        undefined,
        undefined,
        assertScenePresetExportPolicy,
      );
      const bytes = serializeScenePreset(
        buildScenePresetFromProject(sourceProject),
      );
      const target = await scenePresetNative.pickSaveTarget();
      await scenePresetNative.write(target.saveCapability, bytes);
      return true;
    } catch (error) {
      const code = scenePresetNative.toPublicError(error);
      if (code !== "SCENE_PRESET_CANCELLED") setActionError(code);
      return false;
    } finally {
      isPresetSavingRef.current = false;
    }
  };

  // Open-change handler for the Open-from-URL dialog; aborts an in-flight fetch
  // and resets the form when the dialog closes.
  const handleProjectUrlDialogOpenChange = (open: boolean) => {
    setProjectUrlDialogOpen(open);
    if (!open) {
      projectUrlAbortRef.current?.abort();
      projectUrlAbortRef.current = null;
      setProjectUrl("");
      setProjectUrlError(null);
      setProjectUrlLoading(false);
    }
  };

  return {
    actionError,
    setActionError,
    projectUrlDialogOpen,
    setProjectUrlDialogOpen,
    handleProjectUrlDialogOpenChange,
    projectUrl,
    setProjectUrl,
    projectUrlError,
    setProjectUrlError,
    projectUrlLoading,

    embedVectorDataPrompt,
    resolveEmbedVectorDataPrompt,
    saveNamePrompt,
    saveNameInput,
    setSaveNameInput,
    submitSaveNamePrompt,
    cancelSaveNamePrompt,
    handleOpenFromFile,
    handleOpenDroppedProjectFile,
    handleOpenFromUrl,
    openProjectFromShareUrl,
    handleOpenRecent,
    buildCurrentProject,
    buildEmbeddedProject,
    handleSave,
    handleSaveAs,
    handleExportHtml,
    handleNewBlank3dScene,
    handleImportScenePreset,
    handleExportScenePreset,
  };
}

/**
 * The handlers and state returned by {@link useProjectFileActions}. Exported so
 * a single hoisted instance can be shared as a prop across the toolbar and the
 * Browser panel (two instances don't coordinate their in-flight open aborts).
 */
export type ProjectFileActions = ReturnType<typeof useProjectFileActions>;
