import { describe, expect, it } from "vitest";
import { showsErrorBanner } from "../format.js";

describe("showsErrorBanner", () => {
  it("hides the banner for client tool failures and recovering errors", () => {
    expect(showsErrorBanner({ code: "tool_failed" })).toBe(false);
    expect(showsErrorBanner({ code: "tool_timeout" })).toBe(false);
    expect(showsErrorBanner({ code: "provider_error", recovered: true })).toBe(false);
  });

  it("shows it for errors that break the call", () => {
    expect(showsErrorBanner({ code: "provider_error", recovered: false })).toBe(true);
    expect(showsErrorBanner({ code: "connection_failed" })).toBe(true);
    expect(showsErrorBanner({ code: "internal_error" })).toBe(true);
  });
});
