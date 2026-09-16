import { beforeEach, describe, expect, it } from "vitest";

import { ApiError } from "../../api/client";
import { i18n } from ".";
import { problemKey, problemMessage } from "./problems";

// The suite is pinned to English by the shared setup; each case says which
// language it reads in, and this puts the catalogue back afterwards.
beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("problemKey", () => {
  it("names a code the way the catalogues file it", () => {
    expect(problemKey("PROVIDER_AUTH")).toBe("providerAuth");
    expect(problemKey("MOKA_TOO_LARGE")).toBe("mokaTooLarge");
    expect(problemKey("CONFIG_METADATA_DIR_INVALID")).toBe(
      "configMetadataDirInvalid",
    );
  });
});

describe("problemMessage in English", () => {
  it("hands back the server's own words, whatever the code", () => {
    expect(
      problemMessage(
        "PROVIDER_AUTH",
        "the provider rejected the stored credential: bad key",
      ),
    ).toBe("the provider rejected the stored credential: bad key");
    expect(problemMessage("MOKA_TOO_LARGE", "canvas.moka is too big")).toBe(
      "canvas.moka is too big",
    );
  });

  it("hands back the words a code has no entry for", () => {
    expect(problemMessage("VALIDATION_FAILED", "Duplicate node id n-1")).toBe(
      "Duplicate node id n-1",
    );
  });
});

describe("problemMessage in Chinese", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh");
  });

  it("shows a known code in Chinese rather than the server's English", () => {
    expect(
      problemMessage(
        "PROVIDER_AUTH",
        "the provider rejected the stored credential",
      ),
    ).toBe("服务商拒绝了凭据（401/403）");
    expect(
      problemMessage("REVISION_CONFLICT", "canvas.moka changed on disk"),
    ).toBe("文档已被其他窗口修改，请刷新后重试");
    expect(problemMessage("MOKA_TOO_LARGE", "canvas.moka is too big")).toBe(
      "文件超过大小限制",
    );
  });

  it("interpolates the status a request failed with", () => {
    expect(
      problemMessage("INTERNAL", "Request failed with status 500", {
        status: 500,
      }),
    ).toBe("请求失败，状态码 500");
    expect(
      problemMessage(
        "PARSE",
        "The server returned an unreadable response (502)",
        {
          status: 502,
        },
      ),
    ).toBe("服务端返回了无法解析的响应（502）");
  });

  it("interpolates the cause under a transport failure", () => {
    expect(
      problemMessage(
        "TRANSPORT",
        "Cannot reach the local process: Failed to fetch",
        { message: "Failed to fetch" },
      ),
    ).toBe("无法连接本地服务：Failed to fetch");
  });

  it("interpolates the model a capability mismatch names", () => {
    expect(
      problemMessage(
        "MODEL_CAPABILITY_MISMATCH",
        "a::b generates image, not text",
        { reference: "a::b", requested: "text", actual: "image" },
      ),
    ).toBe("a::b 生成的是 image，不是 text");
  });

  it("falls back to the server's English for a code nobody translated", () => {
    expect(problemMessage("VALIDATION_FAILED", "Duplicate node id n-1")).toBe(
      "Duplicate node id n-1",
    );
    expect(problemMessage("NOT_A_CODE_YET", "Words of its own")).toBe(
      "Words of its own",
    );
  });

  it("falls back rather than leaving a placeholder standing", () => {
    // A server's own INTERNAL carries no status for the message to read, and a
    // sentence reading "请求失败，状态码 {{status}}" would be worse than the
    // English it replaced.
    expect(problemMessage("INTERNAL", "io error: disk full")).toBe(
      "io error: disk full",
    );
    expect(
      problemMessage("MODEL_CAPABILITY_MISMATCH", "a::b generates image"),
    ).toBe("a::b generates image");
  });
});

describe("ApiError", () => {
  it("shows a Chinese problem body in Chinese and keeps its parts", async () => {
    await i18n.changeLanguage("zh");
    const error = new ApiError({
      code: "PROVIDER_RATE_LIMIT",
      message: "the provider is rate limiting requests: come back in 42s",
      status: 429,
      details: { retryable: true },
    });

    expect(error.message).toBe("服务商正在限流，请稍后重试");
    expect(error.code).toBe("PROVIDER_RATE_LIMIT");
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ retryable: true });
  });

  it("shows the client's own transport words in Chinese", async () => {
    await i18n.changeLanguage("zh");
    const error = ApiError.transport(
      "Cannot reach the local process: Failed to fetch",
      "Failed to fetch",
    );

    expect(error.message).toBe("无法连接本地服务：Failed to fetch");
    expect(error.code).toBe("TRANSPORT");
    expect(error.status).toBe(0);
    expect(error.details).toBeUndefined();
  });

  it("shows the server's words when the interface is English", () => {
    const error = new ApiError({
      code: "PROVIDER_RATE_LIMIT",
      message: "the provider is rate limiting requests: come back in 42s",
      status: 429,
      details: { retryable: true },
    });

    expect(error.message).toBe(
      "the provider is rate limiting requests: come back in 42s",
    );
    expect(error.code).toBe("PROVIDER_RATE_LIMIT");
    expect(error.status).toBe(429);
    expect(error.details).toEqual({ retryable: true });
  });

  it("keeps a transport failure verbatim in English, cause and all", () => {
    const error = ApiError.transport(
      "Cannot reach the local process: Failed to fetch",
      "Failed to fetch",
    );

    expect(error.message).toBe(
      "Cannot reach the local process: Failed to fetch",
    );
    expect(error.code).toBe("TRANSPORT");
    expect(error.details).toBeUndefined();
  });
});
