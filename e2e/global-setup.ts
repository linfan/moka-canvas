import { PROVIDER_ADDRESS, startMockProvider } from "./mock-provider";

/**
 * Brings up the stand-in provider before anything can be configured against it.
 *
 * A channel is pointed at an address, and the address has to be listening by
 * the time a test types it in — so it is up before the first page is opened.
 */
export default async function globalSetup() {
  const provider = await startMockProvider();
  // Held on the global for the teardown: the two are loaded as separate
  // modules, so nothing else carries it from one to the other.
  (globalThis as { mockProvider?: typeof provider }).mockProvider = provider;
  console.log(`[global-setup] stand-in provider on ${PROVIDER_ADDRESS}`);
}
