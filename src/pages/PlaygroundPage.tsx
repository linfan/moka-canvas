import { useMemo, useState } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { PageHeader } from "../components/PageHeader";
import { LeaferStage } from "../features/leafer/LeaferStage";
import { createPlaygroundScene } from "../features/leafer/sceneCatalog";

const options = ["React", "Leafer", "Tauri"];

export function PlaygroundPage() {
  const [selected, setSelected] = useState(1);
  const scene = useMemo(() => createPlaygroundScene(selected), [selected]);
  return (
    <>
      <PageHeader
        eyebrow="Interaction lab"
        title="A compact flow diagram for focus and resize checks."
        description="Change the selected node with keyboard-accessible controls, then resize the page or desktop window to exercise canvas lifecycle handling."
      />
      <section className="playground-layout">
        <div className="canvas-card playground-canvas">
          <ErrorBoundary>
            <LeaferStage
              build={scene}
              label="React Leafer and Tauri flow diagram"
            />
          </ErrorBoundary>
        </div>
        <aside className="control-card">
          <p className="eyebrow">Select a layer</p>
          <div
            className="segmented-control"
            role="group"
            aria-label="Diagram layer"
          >
            {options.map((option, index) => (
              <button
                className={selected === index ? "is-selected" : ""}
                key={option}
                onClick={() => setSelected(index)}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
          <dl className="interaction-details">
            <div>
              <dt>Selected node</dt>
              <dd>{options[selected]}</dd>
            </div>
            <div>
              <dt>Canvas behavior</dt>
              <dd>Rebuild on resize</dd>
            </div>
            <div>
              <dt>Input path</dt>
              <dd>DOM control → scene props</dd>
            </div>
          </dl>
          <p className="control-note">
            The selected style changes the Leafer scene while the surrounding
            controls retain normal browser and native accessibility behavior.
          </p>
        </aside>
      </section>
    </>
  );
}
