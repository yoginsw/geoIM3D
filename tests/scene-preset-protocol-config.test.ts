import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = JSON.parse(
  readFileSync("apps/geolibre-desktop/src-tauri/tauri.conf.json", "utf8"),
) as { app: { security: { csp: string } } };
const native = readFileSync(
  "apps/geolibre-desktop/src-tauri/src/lib.rs",
  "utf8",
);

test("relative scene resource protocol has one exact CSP origin and native registration", () => {
  const origin = "http://geoim3d-preset-resource.localhost";
  const connectDirective = config.app.security.csp
    .split(";")
    .find((directive) => directive.trimStart().startsWith("connect-src "));
  const connect = connectDirective ?? "";
  assert.notEqual(connect, "", "connect-src directive missing");
  assert.equal(connect.split(/\s+/).filter((item) => item === origin).length, 1);
  assert.equal(connect.includes("*geoim3d-preset-resource"), false);
  assert.match(
    native,
    /register_uri_scheme_protocol\("geoim3d-preset-resource"/,
  );
});

test("runtime CDP seam is fixed and compiled only for Windows debug builds", () => {
  assert.match(native, /#\[cfg\(all\(windows, debug_assertions\)\)\]/);
  assert.match(
    native,
    /env::var\("GEOIM3D_ENABLE_CDP"\)\.as_deref\(\) == Ok\("1"\)/,
  );
  assert.match(native, /additional_browser_args\("--remote-debugging-port=9227"\)/);
  assert.match(native, /geoim3d-cdp-webview2-/);
  assert.doesNotMatch(native, /additional_browser_args\([^"\n]*env::var/);
});
