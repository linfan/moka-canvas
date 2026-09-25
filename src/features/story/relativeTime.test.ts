import { describe, expect, it } from "vitest";
import { relativeTime } from "./relativeTime";

const NOW = new Date("2026-09-25T12:00:00.000Z");

describe("how long ago something was", () => {
  it("says seconds, minutes, hours, days, and years in English", () => {
    expect(relativeTime("2026-09-25T11:59:30.000Z", NOW, "en")).toBe(
      "30 seconds ago",
    );
    expect(relativeTime("2026-09-25T11:55:00.000Z", NOW, "en")).toBe(
      "5 minutes ago",
    );
    expect(relativeTime("2026-09-25T09:00:00.000Z", NOW, "en")).toBe(
      "3 hours ago",
    );
    expect(relativeTime("2026-09-22T12:00:00.000Z", NOW, "en")).toBe(
      "3 days ago",
    );
    expect(relativeTime("2024-09-25T12:00:00.000Z", NOW, "en")).toBe(
      "2 years ago",
    );
  });

  it("says the same in Chinese, because the interface's own words do the talking", () => {
    expect(relativeTime("2026-09-25T11:55:00.000Z", NOW, "zh")).toBe("5分钟前");
    expect(relativeTime("2026-09-25T09:00:00.000Z", NOW, "zh")).toBe("3小时前");
    expect(relativeTime("2026-09-22T12:00:00.000Z", NOW, "zh")).toBe("3天前");
  });

  it("reads a moment that has not arrived yet as it will be", () => {
    expect(relativeTime("2026-09-25T12:00:30.000Z", NOW, "en")).toBe(
      "in 30 seconds",
    );
  });

  it("says nothing at all for a time nobody wrote", () => {
    expect(relativeTime("not a time", NOW, "en")).toBe("");
  });
});
