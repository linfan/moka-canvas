import { useEffect, useRef } from "react";
import { Leafer } from "leafer-ui";
import type { SceneBuilder, StageHandle } from "./sceneTypes";

interface LeaferStageProps {
  build: SceneBuilder;
  className?: string;
  label: string;
}

type LeaferConstructor = new (options: {
  view: HTMLElement;
  width: number;
  height: number;
}) => StageHandle;
const LeaferStageConstructor = Leafer as unknown as LeaferConstructor;

export function LeaferStage({ build, className, label }: LeaferStageProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let stage: StageHandle | undefined;
    const render = () => {
      const { width, height } = host.getBoundingClientRect();
      if (!width || !height) return;
      stage?.destroy();
      host.replaceChildren();
      stage = new LeaferStageConstructor({ view: host, width, height });
      build({ stage, width, height });
    };

    render();
    const observer = new ResizeObserver(render);
    observer.observe(host);
    return () => {
      observer.disconnect();
      stage?.destroy();
      host.replaceChildren();
    };
  }, [build]);

  return (
    <div
      aria-label={label}
      className={`leafer-stage ${className ?? ""}`}
      ref={hostRef}
      role="img"
    />
  );
}
