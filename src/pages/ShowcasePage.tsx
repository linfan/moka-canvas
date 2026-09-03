import { useMemo } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { PageHeader } from "../components/PageHeader";
import { LeaferStage } from "../features/leafer/LeaferStage";
import { createShowcaseScene } from "../features/leafer/sceneCatalog";

const coverage = [
  "Groups, rectangles, rounded cards, ellipses, polygons",
  "Text, typography, and SVG path data",
  "Layering, opacity, rotation, blur, and shadows",
  "Solid fills, strokes, dash patterns, and arrow endings",
];

export function ShowcasePage() {
  const scene = useMemo(() => createShowcaseScene, []);
  return (
    <>
      <PageHeader
        eyebrow="Component lab"
        title="Canvas primitives with deliberately varied style pressure."
        description="Use this gallery as the first visual comparison target for browser rendering, Tauri’s native WebView, device scale changes, and CSS/canvas parity."
      />
      <section className="canvas-card showcase-canvas">
        <ErrorBoundary>
          <LeaferStage
            build={scene}
            label="LeaferJS component and style showcase"
          />
        </ErrorBoundary>
      </section>
      <section className="coverage-card">
        <p className="eyebrow">Included in this scene</p>
        <ul className="coverage-list">
          {coverage.map((item, index) => (
            <li key={item}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              {item}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
