import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createVWorldDesktopClient,
  type VWorldResponse,
} from "../apps/geolibre-desktop/src/lib/vworld-desktop-client";

describe("VWorld desktop client boundary", () => {
  it("performs zero IPC on Web/PWA", async () => {
    let calls = 0;
    const client = createVWorldDesktopClient({
      desktop: false,
      invoke: async () => {
        calls += 1;
        throw new Error("must not invoke");
      },
    });

    await assert.rejects(
      client.search({ query: "안양", type: "PLACE" }),
      /vworld_desktop_only/
    );
    assert.equal(calls, 0);
  });

  it("uses only fixed commands and keyless typed payloads", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const response: VWorldResponse = { status: "OK" };
    const client = createVWorldDesktopClient({
      desktop: true,
      invoke: async <T>(command: string, args?: Record<string, unknown>) => {
        calls.push({ command, args });
        return response as T;
      },
    });

    await client.search({ query: "판교", type: "PLACE", size: 10 });
    await client.geocode({ address: "판교로 242", type: "ROAD" });
    await client.reverseGeocode({ point: [127.1, 37.4], type: "BOTH" });
    await client.getFeatures({
      service: "LP_PA_CBND_BUBUN",
      pnu: "1111010100100020001",
    });
    await client.tile({ layer: "Base", z: 10, x: 873, y: 401 });

    assert.deepEqual(
      calls.map((call) => call.command),
      [
        "vworld_search",
        "vworld_geocode",
        "vworld_reverse_geocode",
        "vworld_get_features",
        "vworld_tile",
      ]
    );
    for (const call of calls) {
      const serialized = JSON.stringify(call.args);
      assert.equal(/apiKey|credentialId|rawQuery|filePath|https?:\/\//i.test(serialized), false);
      assert.match(serialized, /"requestId":"vw-/);
    }
  });

  it("cancels the matching Rust request and redacts unknown errors", async () => {
    const calls: string[] = [];
    let rejectRequest: ((error: Error) => void) | undefined;
    const client = createVWorldDesktopClient({
      desktop: true,
      invoke: async <T>(command: string) => {
        calls.push(command);
        if (command === "vworld_cancel") return undefined as T;
        return await new Promise<T>((_resolve, reject) => {
          rejectRequest = reject;
        });
      },
    });
    const controller = new AbortController();
    const pending = client.search(
      { query: "판교", type: "PLACE" },
      controller.signal
    );
    controller.abort();
    rejectRequest?.(
      new Error(
        "https://api.vworld.kr/req/search?key=SECRET_SENTINEL&query=판교"
      )
    );

    await assert.rejects(pending, (error: Error) => {
      assert.equal(error.message, "vworld_request_failed");
      assert.equal(error.message.includes("SECRET_SENTINEL"), false);
      return true;
    });
    assert.deepEqual(calls, ["vworld_search", "vworld_cancel"]);
  });

  it("preserves every stable Rust error code end-to-end", async () => {
    const codes = [
      "vworld_cancelled",
      "vworld_credential_unavailable",
      "vworld_duplicate_request_id",
      "vworld_http_error",
      "vworld_invalid_request",
      "vworld_invalid_request_id",
      "vworld_invalid_response",
      "vworld_invalid_tile",
      "vworld_missing_api_key",
      "vworld_network_error",
      "vworld_rate_limit",
      "vworld_timeout",
    ];
    for (const code of codes) {
      const client = createVWorldDesktopClient({
        desktop: true,
        invoke: async () => {
          throw new Error(code);
        },
      });
      await assert.rejects(
        client.search({ query: "판교", type: "PLACE" }),
        (error: Error) => error.message === code
      );
    }
  });

  it("does not invoke when already aborted", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const client = createVWorldDesktopClient({
      desktop: true,
      invoke: async <T>() => {
        calls += 1;
        return { status: "OK" } as T;
      },
    });
    await assert.rejects(
      client.search({ query: "판교", type: "PLACE" }, controller.signal),
      /vworld_cancelled/
    );
    assert.equal(calls, 0);
  });
});
