import { useEffect, useState } from "react";
import { getHealth, getRuntime, type RuntimeDetails } from "../services/api";

export function ServiceStatus() {
  const [runtime, setRuntime] = useState<RuntimeDetails>();
  const [available, setAvailable] = useState<boolean>();

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      getHealth(controller.signal),
      getRuntime(controller.signal),
    ])
      .then(([health, details]) => {
        setAvailable(health);
        setRuntime(details);
      })
      .catch(() => setAvailable(false));
    return () => controller.abort();
  }, []);

  return (
    <section className="status-card" aria-label="Local server status">
      <div className="status-header">
        <span
          className={`status-dot ${available ? "is-ready" : available === false ? "is-error" : ""}`}
        />
        <div>
          <p className="eyebrow">Same origin delivery</p>
          <h2>
            {available
              ? "Local server connected"
              : available === false
                ? "Server unavailable"
                : "Checking local server"}
          </h2>
        </div>
      </div>
      <dl className="runtime-details">
        <div>
          <dt>Mode</dt>
          <dd>{runtime?.mode ?? "—"}</dd>
        </div>
        <div>
          <dt>Transport</dt>
          <dd>{runtime?.delivery ?? "localhost"}</dd>
        </div>
        <div>
          <dt>Renderer</dt>
          <dd>{runtime?.renderer ?? "—"}</dd>
        </div>
      </dl>
    </section>
  );
}
