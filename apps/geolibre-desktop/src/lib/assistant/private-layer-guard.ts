import type { GeoLibreLayer } from "@geolibre/core";
import { assertNoEarthworkPrivateContent } from "../project-private-content";

/** Fail closed before layer identity/schema can be materialized into an LLM prompt. */
export function assertAssistantLayerContextSafe(layers: GeoLibreLayer[]): void {
  assertNoEarthworkPrivateContent(layers);
}
