import { beforeEach, describe, expect, it } from "vitest";

import {
  ApiError,
  errorText,
  isApiError,
  isConfigurationTrouble,
  readProblem,
} from "./client";
import { i18n } from "../shared/i18n";

const problem = (body: unknown, status = 422): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const thrown = (code: string): ApiError =>
  new ApiError({ code, message: "it broke", status: 422 });

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("readProblem", () => {
  it("reads a problem body into the error every route reports", async () => {
    const error = await readProblem(
      problem({
        code: "PROVIDER_KEY_MISSING",
        message: "model gpt-4o-mini has no stored API key",
        details: { model: "gpt-4o-mini" },
        status: 422,
      }),
    );

    expect(error?.code).toBe("PROVIDER_KEY_MISSING");
    expect(error?.rawMessage).toBe("model gpt-4o-mini has no stored API key");
    expect(error?.details).toEqual({ model: "gpt-4o-mini" });
  });

  it("says nothing for a response that names no problem", async () => {
    expect(
      await readProblem(new Response("not json", { status: 500 })),
    ).toBeNull();
    expect(await readProblem(problem({ oops: true }))).toBeNull();
  });
});

describe("errorText", () => {
  it("keeps the server's sentence when the catalogue said something else", async () => {
    await i18n.changeLanguage("zh");
    const error = new ApiError({
      code: "PROVIDER_KEY_MISSING",
      message: "model gpt-4o-mini has no stored API key",
      status: 422,
      details: { model: "gpt-4o-mini" },
    });

    expect(errorText(error)).toEqual({
      message: "模型 gpt-4o-mini 还没有保存 API 密钥，请到设置里填写",
      detail: "model gpt-4o-mini has no stored API key",
    });
  });

  it("leaves an English interface with the one sentence", () => {
    const error = new ApiError({
      code: "PROVIDER_KEY_MISSING",
      message: "model gpt-4o-mini has no stored API key",
      status: 422,
      details: { model: "gpt-4o-mini" },
    });

    expect(errorText(error)).toEqual({
      message: "model gpt-4o-mini has no stored API key",
    });
  });

  it("takes whatever was thrown", () => {
    expect(errorText(new Error("no executor took it"))).toEqual({
      message: "no executor took it",
    });
    expect(errorText("just a string")).toEqual({ message: "just a string" });
  });
});

describe("what a reader repairs in settings", () => {
  it("knows the troubles another ask repeats", () => {
    expect(isConfigurationTrouble(thrown("PROVIDER_KEY_MISSING"))).toBe(true);
    expect(isConfigurationTrouble(thrown("PROVIDER_NOT_CONFIGURED"))).toBe(
      true,
    );
    expect(isConfigurationTrouble(thrown("PROVIDER_AUTH"))).toBe(true);
    expect(isConfigurationTrouble(thrown("MODEL_CAPABILITY_MISMATCH"))).toBe(
      true,
    );
  });

  it("leaves a trouble that time or a second ask might fix alone", () => {
    expect(isConfigurationTrouble(thrown("PROVIDER_RATE_LIMIT"))).toBe(false);
    expect(isConfigurationTrouble(thrown("PROVIDER_TIMEOUT"))).toBe(false);
    expect(isConfigurationTrouble(new Error("nope"))).toBe(false);
    expect(isConfigurationTrouble(undefined)).toBe(false);
  });
});

describe("isApiError", () => {
  it("still tells a problem apart from anything else thrown", () => {
    expect(isApiError(thrown("CONFLICT"), "CONFLICT")).toBe(true);
    expect(isApiError(thrown("CONFLICT"), "NOT_FOUND")).toBe(false);
    expect(isApiError(new Error("conflict"))).toBe(false);
  });
});
