import { describe, expect, it } from "vitest";
import { resolveLocale, systemLocale } from ".";

describe("systemLocale", () => {
  it("maps every Chinese tag to Chinese", () => {
    expect(systemLocale("zh")).toBe("zh");
    expect(systemLocale("zh-CN")).toBe("zh");
    expect(systemLocale("zh-Hant-TW")).toBe("zh");
  });

  it("maps everything else, including nothing, to English", () => {
    expect(systemLocale("en-US")).toBe("en");
    expect(systemLocale("de")).toBe("en");
    expect(systemLocale("")).toBe("en");
  });
});

describe("resolveLocale", () => {
  it("follows the machine only in system mode", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("zh")).toBe("zh");
    expect(resolveLocale("system")).toBe(systemLocale());
  });
});
