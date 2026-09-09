import type { MockProvider } from "./mock-provider";

/** Stops the stand-in provider the setup brought up. */
export default async function globalTeardown() {
  await (globalThis as { mockProvider?: MockProvider }).mockProvider?.stop();
}
