/** Canvas palette, aligned with src/styles/tokens.css. */
export const canvasTheme = {
  background: "#0b1020",
  grid: "#314367",
  nodeFill: "#151d35",
  nodeStroke: "#314367",
  nodeTitle: "#eef4ff",
  nodeMuted: "#9fb1d4",
  selection: "#6d8cff",
  edge: "#7d90bd",
  edgeSelected: "#6d8cff",
  edgeRelated: "#61e4dc",
  port: "#9fb1d4",
  portCompatible: "#7ee2a8",
  portRejected: "#ff8c82",
  marquee: "#6d8cff",
  marqueeFill: "#6d8cff14",
  snapGuide: "#ffcd6a",
  kindAccent: {
    text: "#61e4dc",
    image: "#6d8cff",
    audio: "#ffcd6a",
    video: "#ff8c82",
    operation: "#b78bff",
    group: "#9fb1d4",
    export: "#7ee2a8",
  } as Record<string, string>,
  fontFamily:
    'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
};

export const NODE_HEADER_HEIGHT = 30;
export const PORT_RADIUS = 5;
export const PORT_SPACING = 22;
