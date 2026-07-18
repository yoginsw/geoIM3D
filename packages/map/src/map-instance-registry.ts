import type { Map as MapLibreMap } from "maplibre-gl";

const instances = new Map<MapLibreMap, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

export function registerMapInstance(map: MapLibreMap): () => void {
  const count = instances.get(map) ?? 0;
  instances.set(map, count + 1);
  if (count === 0) notify();

  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const current = instances.get(map);
    if (current === undefined) return;
    if (current > 1) {
      instances.set(map, current - 1);
      return;
    }
    instances.delete(map);
    notify();
  };
}

export function getMapInstances(): readonly MapLibreMap[] {
  return [...instances.keys()];
}

export function subscribeMapInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
