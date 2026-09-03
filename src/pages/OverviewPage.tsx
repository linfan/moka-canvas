import { useMemo } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { PageHeader } from "../components/PageHeader";
import { ServiceStatus } from "../components/ServiceStatus";
import { LeaferStage } from "../features/leafer/LeaferStage";
import { createOverviewScene } from "../features/leafer/sceneCatalog";

export function OverviewPage() {
  const scene = useMemo(() => createOverviewScene, []);
  return (
    <>
      <PageHeader
        eyebrow="Compatibility baseline"
        title="A visual benchmark that takes the same route everywhere."
        description="React provides the responsive shell; LeaferJS renders the canvas scenes; Rust delivers both through one localhost origin."
      />
      <section className="overview-grid">
        <div className="canvas-card hero-canvas">
          <ErrorBoundary>
            <LeaferStage build={scene} label="Moka Canvas compatibility hero" />
          </ErrorBoundary>
        </div>
        <div className="overview-side">
          <ServiceStatus />
          <section className="principle-card">
            <p className="eyebrow">Verification principle</p>
            <h2>Identical assets, intentional differences.</h2>
            <p>
              Use this base to compare browser and Tauri rendering without a
              second frontend, different URL scheme, or remote dependency hiding
              a platform issue.
            </p>
          </section>
        </div>
      </section>
      <section className="metric-grid" aria-label="Compatibility coverage">
        <article>
          <strong>01</strong>
          <span>Local Rust HTTP delivery</span>
        </article>
        <article>
          <strong>02</strong>
          <span>Responsive React shell</span>
        </article>
        <article>
          <strong>03</strong>
          <span>LeaferJS shape and style gallery</span>
        </article>
        <article>
          <strong>04</strong>
          <span>macOS, Windows, and web targets</span>
        </article>
      </section>
    </>
  );
}
