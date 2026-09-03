export interface StageHandle {
  add(node: unknown): unknown;
  destroy(): void;
}

export interface SceneContext {
  stage: StageHandle;
  width: number;
  height: number;
}

export type SceneBuilder = (context: SceneContext) => void;
