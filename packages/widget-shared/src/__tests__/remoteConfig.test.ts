import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteConfig } from "../remoteConfig.js";

describe("fetchRemoteConfig", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(body: unknown, ok = true) {
    const fetchMock = vi.fn(async () => ({ ok, json: async () => body }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends the given origin and returns the config", async () => {
    const fetchMock = stubFetch({ agent_name: "Support" });
    await expect(fetchRemoteConfig("https://api.example.com/", "agent 1", "https://www.example.com")).resolves.toEqual({
      agent_name: "Support",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.com/v1/agent/agents/agent%201/widget",
      expect.objectContaining({ headers: { Accept: "application/json", Origin: "https://www.example.com" } }),
    );
  });

  it("leaves Origin out when none is given", async () => {
    const fetchMock = stubFetch({});
    await fetchRemoteConfig(undefined, "a");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
  });

  it("resolves null on an HTTP error", async () => {
    stubFetch({ status: 403 }, false);
    await expect(fetchRemoteConfig(undefined, "a", "https://evil.example")).resolves.toBeNull();
  });
});
