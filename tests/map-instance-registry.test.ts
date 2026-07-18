import assert from "node:assert/strict";
import { it } from "node:test";

import {
  getMapInstances,
  registerMapInstance,
  subscribeMapInstances,
} from "../packages/map/src/map-instance-registry.ts";

it("reference-counts mounted map instances and notifies only membership changes", () => {
  assert.deepEqual(getMapInstances(), []);
  const map = {} as Parameters<typeof registerMapInstance>[0];
  let notifications = 0;
  const unsubscribe = subscribeMapInstances(() => {
    notifications += 1;
  });

  const releaseFirst = registerMapInstance(map);
  const releaseDuplicate = registerMapInstance(map);
  assert.deepEqual(getMapInstances(), [map]);
  assert.equal(notifications, 1);

  releaseFirst();
  assert.deepEqual(getMapInstances(), [map]);
  assert.equal(notifications, 1);

  releaseDuplicate();
  assert.deepEqual(getMapInstances(), []);
  assert.equal(notifications, 2);

  releaseDuplicate();
  assert.equal(notifications, 2);
  unsubscribe();
});
