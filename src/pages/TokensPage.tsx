import { useMemo, useState } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { PageHeader } from "../components/PageHeader";
import { LeaferStage } from "../features/leafer/LeaferStage";
import { createTokenScene } from "../features/leafer/sceneCatalog";
import { leaferTheme } from "../design/leaferTheme";

const tokens = [
  ["Canvas", leaferTheme.canvas],
  ["Surface", leaferTheme.surface],
  ["Primary", leaferTheme.primary],
  ["Cyan", leaferTheme.cyan],
  ["Coral", leaferTheme.coral],
  ["Yellow", leaferTheme.yellow],
];

export function TokensPage() {
  const [selected, setSelected] = useState("Primary");
  const scene = useMemo(() => createTokenScene(selected), [selected]);
  return (
    <>
      <PageHeader
        eyebrow="Token parity"
        title="The DOM palette and Leafer palette share one visual language."
        description="Select a CSS token to highlight its equivalent canvas chip. This makes visual drift obvious before it turns into an environment-specific issue."
      />
      <section className="token-layout">
        <div className="token-panel">
          <p className="eyebrow">CSS custom-property reference</p>
          <div className="swatch-grid">
            {tokens.map(([name, value]) => (
              <button
                className={`swatch${selected === name ? " is-selected" : ""}`}
                key={name}
                onClick={() => setSelected(name)}
                type="button"
              >
                <span style={{ background: value }} />
                <b>{name}</b>
                <code>{value}</code>
              </button>
            ))}
          </div>
        </div>
        <div className="canvas-card token-canvas">
          <ErrorBoundary>
            <LeaferStage
              build={scene}
              label="LeaferJS design token parity preview"
            />
          </ErrorBoundary>
        </div>
      </section>
    </>
  );
}
