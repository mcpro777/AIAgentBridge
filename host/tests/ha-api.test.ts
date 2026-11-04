import { describe, expect, it, vi } from "vitest";
import { HomeAssistantApi } from "../src/ha-api.js";

describe("Home Assistant API client", () => {
  it("uses the configured API origin and bearer token for read requests", async () => {
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      const requestUrl = new URL(String(input));
      expect(requestUrl.href).toBe("http://ha.local:8123/api/states/sensor.room");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      return new Response(JSON.stringify({ entity_id: "sensor.room", state: "21" }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const api = new HomeAssistantApi("http://ha.local:8123", "test-token", 1_000, fetcher);

    await expect(api.getState("sensor.room")).resolves.toEqual({ entity_id: "sensor.room", state: "21" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("calls the requested Home Assistant service with JSON service data", async () => {
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      expect(new URL(String(input)).href).toBe("http://ha.local:8123/api/services/light/turn_on");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({ entity_id: "light.office" });
      return new Response(JSON.stringify([{ entity_id: "light.office", state: "on" }]), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });
    const api = new HomeAssistantApi("http://ha.local:8123", "test-token", 1_000, fetcher);

    await expect(api.callService("light", "turn_on", { entity_id: "light.office" }))
      .resolves.toEqual([{ entity_id: "light.office", state: "on" }]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid service paths before making a request", async () => {
    const fetcher: typeof fetch = vi.fn();
    const api = new HomeAssistantApi("http://ha.local:8123", "test-token", 1_000, fetcher);

    await expect(api.callService("light/services", "turn_on", {})).rejects.toThrow("domain is invalid");
    await expect(api.callService("light", "turn_on/services", {})).rejects.toThrow("service name is invalid");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not include response bodies in HTTP errors", async () => {
    const fetcher: typeof fetch = vi.fn(async () => new Response("sensitive HA response", {
      status: 401,
      statusText: "Unauthorized"
    }));
    const api = new HomeAssistantApi("http://ha.local:8123", "test-token", 1_000, fetcher);

    await expect(api.getApiStatus()).rejects.toThrow("HTTP 401 Unauthorized");
    await expect(api.getApiStatus()).rejects.not.toThrow("sensitive HA response");
  });

  it("rejects credentials and non-HTTP schemes in the base URL", () => {
    expect(() => new HomeAssistantApi("ftp://ha.local", "test-token")).toThrow("HTTP or HTTPS");
    expect(() => new HomeAssistantApi("http://user:password@ha.local", "test-token")).toThrow("must not contain credentials");
  });
});
