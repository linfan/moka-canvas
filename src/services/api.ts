export interface RuntimeDetails {
  delivery: string;
  mode: string;
  renderer: string;
}

export async function getRuntime(
  signal?: AbortSignal,
): Promise<RuntimeDetails> {
  const response = await fetch("/api/runtime", { signal });
  if (!response.ok)
    throw new Error(`Runtime request failed (${response.status})`);
  return response.json() as Promise<RuntimeDetails>;
}

export async function getHealth(signal?: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/health", { signal });
  return response.ok;
}
