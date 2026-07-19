import {
  SIDECAR_AUTH_HEADER,
  type ConversionJob,
} from "@geolibre/processing";
import type { SidecarServerInfo } from "./sidecar";
import { isTauri } from "./tauri-io";

export async function runCadReadDxf(
  info: SidecarServerInfo,
  inputPath: string,
): Promise<ConversionJob> {
  if (!isTauri()) {
    throw new Error("CAD conversion requires geoIM3D Desktop.");
  }
  const baseUrl = new URL(info.baseUrl);
  if (
    baseUrl.protocol !== "http:" ||
    baseUrl.hostname !== "127.0.0.1" ||
    Number(baseUrl.port) !== info.port
  ) {
    throw new Error("The CAD sidecar returned an invalid loopback endpoint.");
  }
  const response = await fetch(
    new URL("/conversion/cad/read-dxf", baseUrl).toString(),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIDECAR_AUTH_HEADER]: info.token,
      },
      body: JSON.stringify({ input_path: inputPath }),
    },
  );
  if (!response.ok) {
    throw new Error(`CAD conversion failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ConversionJob;
}
