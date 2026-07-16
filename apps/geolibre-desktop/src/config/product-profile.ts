export const PRODUCT_PROFILE = {
  language: "ko",
  theme: "light",
  mapGrid: { rows: 1, cols: 1 },
  defaultMapTab: "cesium",
  hiddenMenuItems: [
    "project.collaborate",
    "processing.pythonConsole",
    "processing.notebook",
    "controls.fieldCollection",
  ],
} as const;

export function isGeoIm3dProductMapWorkspaceEnabled(): boolean {
  if (import.meta.env?.VITE_E2E_EXPOSE_ALL_LOCALES !== "true") return true;
  if (typeof window === "undefined") return true;
  return (
    new URLSearchParams(window.location.search).get("geoim3dProfile") === "1"
  );
}
