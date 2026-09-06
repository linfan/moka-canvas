/** Canvas palette, aligned with src/styles/tokens.css. */
export const canvasTheme = {
  background: "#0d0d10",
  grid: "#26272d",
  nodeFill: "#17181d",
  nodeStroke: "#2c2e35",
  nodeTitle: "#f4f4f6",
  nodeMuted: "#9a9aa4",
  selection: "#f5f5f7",
  edge: "#bfc0c8",
  edgeSelected: "#ffffff",
  edgeRelated: "#e8e8ec",
  port: "#9a9aa4",
  portCompatible: "#7ee2a8",
  portRejected: "#ff8a80",
  marquee: "#f5f5f7",
  marqueeFill: "#ffffff14",
  snapGuide: "#f2ce7a",
  kindAccent: {
    text: "#9fc1e8",
    image: "#a5b4f0",
    audio: "#e8c97a",
    video: "#e8a79c",
    operation: "#b7a3e8",
    group: "#9a9aa4",
    export: "#8fd0a8",
  } as Record<string, string>,
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

export const NODE_HEADER_HEIGHT = 30;
export const PORT_RADIUS = 5;
export const PORT_SPACING = 22;
