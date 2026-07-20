import proj4 from "proj4";

export const LOCAL_CRS = ["EPSG:4326", "EPSG:3857", "EPSG:5179", "EPSG:5186"] as const;
export type LocalCrs = (typeof LOCAL_CRS)[number];
export type KoreanProjectedCrs = "EPSG:5179" | "EPSG:5186";
export type Coordinate2D = readonly [number, number];

let registered = false;

export function registerLocalCrsDefinitions(): void {
  if (registered) return;
  proj4.defs("EPSG:4326", "+proj=longlat +datum=WGS84 +no_defs +type=crs");
  proj4.defs(
    "EPSG:3857",
    "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +wktext +no_defs +type=crs",
  );
  proj4.defs(
    "EPSG:5179",
    "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs +type=crs",
  );
  proj4.defs(
    "EPSG:5186",
    "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=600000 +ellps=GRS80 +units=m +no_defs +type=crs",
  );
  registered = true;
}

export function transformLocalCrsPoint(
  point: Coordinate2D,
  source: LocalCrs,
  target: LocalCrs,
): [number, number] {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
    throw new Error("LOCAL_CRS_COORDINATE_INVALID");
  }
  if (source === "EPSG:4326" && (point[0] < -180 || point[0] > 180 || point[1] < -90 || point[1] > 90)) {
    throw new Error("LOCAL_CRS_COORDINATE_INVALID");
  }
  registerLocalCrsDefinitions();
  const transformed = proj4(source, target, [point[0], point[1]]);
  if (!Number.isFinite(transformed[0]) || !Number.isFinite(transformed[1])) {
    throw new Error("LOCAL_CRS_COORDINATE_INVALID");
  }
  if (target === "EPSG:4326" && (transformed[0] < -180 || transformed[0] > 180 || transformed[1] < -90 || transformed[1] > 90)) {
    throw new Error("LOCAL_CRS_COORDINATE_INVALID");
  }
  return [transformed[0], transformed[1]];
}

registerLocalCrsDefinitions();
