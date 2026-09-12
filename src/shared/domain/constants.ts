import type {
  BackgroundMode,
  DataType,
  NodeKind,
  PortDefinition,
} from "./types";

export const MOKA_MAGIC = [0x4d, 0x4f, 0x4b, 0x41] as const;
export const MOKA_FILE_VERSION = "v1" as const;
export const CANVAS_SCHEMA_VERSION = 2;
export const PACKAGE_FORMAT_VERSION = 2;

export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 5.0;
/** The three ways a canvas draws what is behind its nodes. */
export const BACKGROUND_MODES: readonly BackgroundMode[] = [
  "dots",
  "lines",
  "blank",
];
export const GRID_BASE_SPACING = 48;
export const GRID_FADE_ZOOM = 0.12;
export const LOW_DETAIL_ZOOM = 0.35;

export const COORDINATE_LIMIT = 1_000_000;
export const MAX_TITLE_LENGTH = 200;
export const MAX_CANVAS_NAME_LENGTH = 80;
export const MAX_PROJECT_NAME_LENGTH = 120;
export const MAX_TEXT_CONTENT_LENGTH = 50_000;
export const MAX_PROMPT_LENGTH = 20_000;
export const MAX_RESULT_SLOTS = 16;
export const MAX_NODES_PER_CANVAS = 5_000;
export const MAX_EDGES_PER_CANVAS = 10_000;
export const MAX_CANVASES_PER_PROJECT = 64;
export const MAX_RESOURCES_PER_CATEGORY = 10_000;

/** How many conversations one canvas carries. */
export const MAX_ASSISTANT_SESSIONS_PER_CANVAS = 16;
/**
 * How many lines one conversation is kept to.
 *
 * A ceiling rather than a refusal: a conversation that ran past it would be one
 * nobody could read through, and the oldest lines are the ones to lose. Losing
 * them is said, and undoing the turn that pushed past it gives them back.
 */
export const MAX_ASSISTANT_MESSAGES_PER_SESSION = 200;
export const MAX_ASSISTANT_TITLE_LENGTH = 120;
/**
 * The most one line of a conversation holds, which is the most a text card
 * holds: an answer is offered the chance to become one, and an answer too long
 * for a card could not be put on the canvas whole.
 */
export const MAX_ASSISTANT_MESSAGE_LENGTH = MAX_TEXT_CONTENT_LENGTH;

/** The most pixels one picture tool will work on, coming or going. */
export const MAX_OPERATED_PIXELS = 40_000_000;
/** The most pieces one division makes. */
export const MAX_DIVISIONS = 64;
/** How far a picture may be turned, in degrees either way. */
export const MAX_TILT_DEGREES = 60;

export const CLICK_DRAG_THRESHOLD_PX = 3;
export const GROUP_DETACH_THRESHOLD_PX = 48;
export const MIN_NODE_WIDTH = 200;
export const MIN_NODE_HEIGHT = 120;
export const DEFAULT_NODE_WIDTH = 280;
export const DEFAULT_NODE_HEIGHT = 200;
export const CASCADE_DROP_OFFSET = 40;
export const FIT_VIEWPORT_USAGE = 0.6;
export const FIT_ANIMATION_MS = 450;

export const PROJECT_ASSET_CATEGORIES = [
  "images",
  "music",
  "voice",
  "texts",
  "videos",
] as const;
export type AssetCategory = (typeof PROJECT_ASSET_CATEGORIES)[number];

/** What each place assets are filed is called where a reader is told of it. */
export const ASSET_CATEGORY_LABELS: Record<AssetCategory, string> = {
  images: "Images",
  music: "Music",
  voice: "Voice",
  texts: "Texts",
  videos: "Videos",
};

/**
 * Whether the project was handed the file or made it itself.
 *
 * What a generation, a tool, or a conversation produced is not said here:
 * `provenance` already names the run, node, or conversation behind an asset,
 * and saying it twice gives the two places a chance to disagree.
 */
export const ASSET_ORIGINS = ["brought", "filed"] as const;
export type AssetOrigin = (typeof ASSET_ORIGINS)[number];

/**
 * What each origin is called where a reader is told of it.
 *
 * An asset this project made is not labelled here: it says so through
 * `provenance`, and the shelf calls that "Made here" where it reads the entry.
 */
export const ASSET_ORIGIN_LABELS: Record<AssetOrigin, string> = {
  brought: "Brought in",
  filed: "Filed from a node",
};

/** How many words a reader may put on one asset to find it again. */
export const MAX_ASSET_TAGS = 24;
/** How long one of those words may be. */
export const MAX_ASSET_TAG_LENGTH = 32;
export const MAX_ASSET_NOTE_LENGTH = 2_000;
/**
 * What an asset is a picture of, in words — the summary a search reads.
 *
 * Kept to the size of a prompt rather than a document: it is meant to be the
 * ask an asset came from, or the opening of the text it holds.
 */
export const MAX_ASSET_KEYWORD_LENGTH = 2_000;

export const MODEL_CAPABILITIES = ["text", "image", "audio", "video"] as const;
export type Capability = (typeof MODEL_CAPABILITIES)[number];

export const CAPABILITY_LABELS: Record<Capability, string> = {
  text: "Text",
  image: "Image",
  audio: "Audio",
  video: "Video",
};

/**
 * The wire protocols a model configuration can speak. One name per endpoint
 * shape rather than per vendor: a category's list is a slice of this, because
 * a text model and a video model never speak the same endpoint even at the
 * same provider.
 */
export const MODEL_PROTOCOLS = [
  "openaiChat",
  "openaiResponses",
  "openaiImages",
  "openaiSpeech",
  "openaiVideos",
  "gemini",
  "geminiVideo",
  "custom",
] as const;
export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number];

/**
 * The protocols on offer per category, mirroring `protocols_for` on the
 * server: the form offers one list and a write is refused against the same
 * one, so what may be chosen and what may be stored cannot disagree.
 */
export const PROTOCOLS_BY_CATEGORY: Record<
  Capability,
  readonly ModelProtocol[]
> = {
  text: ["openaiChat", "openaiResponses", "gemini"],
  image: ["openaiImages", "gemini"],
  audio: ["openaiSpeech", "gemini"],
  video: ["openaiVideos", "geminiVideo"],
};

/** What each protocol is called where a reader picks one. */
export const PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  openaiChat: "OpenAI-compatible · Chat Completions",
  openaiResponses: "OpenAI-compatible · Responses",
  openaiImages: "OpenAI-compatible · Images API",
  openaiSpeech: "OpenAI-compatible · Speech API",
  openaiVideos: "OpenAI-compatible · Videos API",
  gemini: "Google Gemini · generateContent",
  geminiVideo: "Google Gemini · long-running (Veo)",
  custom: "Custom (reserved)",
};

/**
 * The complete endpoint address each protocol speaks at, as the example a URL
 * field starts from. A configuration carries the whole address — there is no
 * base URL to extend.
 */
export const PROTOCOL_URL_EXAMPLES: Record<ModelProtocol, string> = {
  openaiChat: "https://api.openai.com/v1/chat/completions",
  openaiResponses: "https://api.openai.com/v1/responses",
  openaiImages: "https://api.openai.com/v1/images/generations",
  openaiSpeech: "https://api.openai.com/v1/audio/speech",
  openaiVideos: "https://api.openai.com/v1/videos",
  gemini:
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  geminiVideo:
    "https://generativelanguage.googleapis.com/v1beta/models/veo-3:predictLongRunning",
  custom: "",
};

/** The executor a generation node's step is handed to. */
export const PROVIDER_EXECUTOR_KEY = "provider";

export const MAX_MODEL_ID_LENGTH = 96;
export const MAX_MODEL_NAME_LENGTH = 120;
export const MAX_IMAGES_PER_RUN = 10;
export const MAX_VIDEO_SECONDS = 600;
export const MIN_AUDIO_SPEED = 0.25;
export const MAX_AUDIO_SPEED = 4;

export function port(
  id: string,
  direction: "input" | "output",
  dataTypes: DataType[],
  label: string,
  options?: { required?: boolean; cardinality?: "one" | "many" },
): PortDefinition {
  return {
    id,
    direction,
    dataTypes,
    required: options?.required ?? false,
    cardinality: options?.cardinality ?? "one",
    label,
  };
}

/**
 * The one port table both languages share by convention: codecs correct
 * decoded nodes against it, so a stored document never drifts from the
 * ports its kind offers.
 */
export const NODE_PORTS: Record<NodeKind, PortDefinition[]> = {
  text: [
    port("prompt", "input", ["text"], "Prompt", { cardinality: "many" }),
    port("images", "input", ["image"], "Images", { cardinality: "many" }),
    port("audio", "input", ["audio"], "Audio"),
    port("video", "input", ["video"], "Video"),
    port("out", "output", ["text"], "Text"),
  ],
  image: [
    port("prompt", "input", ["text"], "Prompt", { cardinality: "many" }),
    port("images", "input", ["image"], "Images", { cardinality: "many" }),
    port("mask", "input", ["image"], "Mask"),
    port("out", "output", ["image"], "Image"),
  ],
  audio: [
    port("prompt", "input", ["text"], "Prompt", { cardinality: "many" }),
    port("out", "output", ["audio"], "Audio"),
  ],
  video: [
    port("prompt", "input", ["text"], "Prompt", { cardinality: "many" }),
    port("images", "input", ["image"], "Images", { cardinality: "many" }),
    port("firstFrame", "input", ["image"], "First frame"),
    port("lastFrame", "input", ["image"], "Last frame"),
    port("videos", "input", ["video"], "Videos", { cardinality: "many" }),
    port("audios", "input", ["audio"], "Audios", { cardinality: "many" }),
    port("out", "output", ["video"], "Video"),
  ],
  operation: [
    port("text", "input", ["text"], "Text", { cardinality: "many" }),
    port("images", "input", ["image"], "Images", { cardinality: "many" }),
    port("audio", "input", ["audio"], "Audio"),
    port("video", "input", ["video"], "Video"),
    port("out", "output", ["text", "image", "audio", "video"], "Result", {
      cardinality: "many",
    }),
  ],
  group: [],
  export: [
    port("video", "input", ["video"], "Video"),
    port("audio", "input", ["audio"], "Audio"),
    port("out", "output", ["artifact"], "Artifact"),
  ],
};

export const MOKA_FRAGMENT_MIME = "application/x-moka-canvas-fragment+json";
export const FRAGMENT_SCHEMA_VERSION = 1;

/**
 * The node-level parameter keys each capability accepts; same names and
 * meanings as the global provider preferences. Unknown keys are rejected.
 */
export const GENERATION_PARAM_KEYS: Record<Capability, readonly string[]> = {
  text: ["temperature", "maxTokens", "reasoningEffort", "instructions"],
  image: ["size", "quality", "background", "count"],
  audio: ["voice", "format", "speed", "instructions", "music", "sampleRate", "volume", "rate", "pitch"],
  video: [
    "seconds",
    "resolution",
    "ratio",
    "generateAudio",
    "watermark",
    "mode",
  ],
};

/**
 * The shapes a picture or a shot can be asked for, stated as a proportion.
 *
 * A shape is also the shape of the node waiting for it, which is why it is not
 * stated in pixels: the pixels are each provider's own answer to the same ask.
 */
export const GENERATION_SHAPES = [
  "1:1",
  "3:4",
  "4:3",
  "16:9",
  "9:16",
  "21:9",
] as const;

export const IMAGE_QUALITIES = ["auto", "low", "medium", "high"] as const;
export const IMAGE_BACKGROUNDS = ["auto", "transparent", "opaque"] as const;
export const VIDEO_RESOLUTIONS = ["480", "720", "1080"] as const;

/**
 * What a video does with the pictures it is given: `auto` reads them as the
 * frames of the shot, and `reference` as its subject or style.
 */
export const VIDEO_IMAGE_MODES = ["auto", "reference"] as const;

export const AUDIO_VOICES = [
  "alloy",
  "echo",
  "fable",
  "onyx",
  "nova",
  "shimmer",
] as const;
export const AUDIO_FORMATS = [
  "mp3",
  "wav",
  "opus",
  "aac",
  "flac",
  "pcm",
] as const;
export const REASONING_EFFORTS = [
  "auto",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export const HISTORY_LIMIT = 50;

export const PROBLEM_CODES = [
  "GRAPH_CYCLE",
  "PORT_TYPE_MISMATCH",
  "CARDINALITY_VIOLATION",
  "SELF_LOOP",
  "PORT_NOT_FOUND",
  "NODE_NOT_FOUND",
  "EDGE_NOT_FOUND",
  "CANVAS_NOT_FOUND",
  "GROUP_INVALID",
  "SESSION_NOT_FOUND",
  "MESSAGE_NOT_FOUND",
  "BOUNDS_INVALID",
  "ASSET_INVALID",
  "ASSET_MISSING",
  "ASSET_IN_USE",
  "PATH_ESCAPE",
  "MOKA_MAGIC_INVALID",
  "MOKA_BSON_INVALID",
  "MOKA_VERSION_UNSUPPORTED",
  "MOKA_FIELD_MISSING",
  "MOKA_TOO_LARGE",
  "REVISION_CONFLICT",
  "VALIDATION_FAILED",
  "PROJECT_NOT_OPEN",
  "PROJECT_NOT_FOUND",
  "CANVAS_REQUIRED",
  "EXECUTOR_DISABLED",
  "RUN_NOT_FOUND",
  "RUN_NOT_CANCELLABLE",
  "PACKAGE_INVALID",
  "CONFIG_METADATA_DIR_INVALID",
  "CONFIG_METADATA_STORE_UNSUPPORTED",
  "CONFIG_METADATA_KEY_MISSING",
  "METADATA_UNAVAILABLE",
  "METADATA_CONFLICT",
  "METADATA_WRITE_FAILED",
  "METADATA_MIGRATION_FAILED",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_AUTH",
  "PROVIDER_RATE_LIMIT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_BAD_REQUEST",
  "PROVIDER_TIMEOUT",
  "PROVIDER_NO_OUTPUT",
  "MODEL_CAPABILITY_MISMATCH",
  "GENERATION_CAPABILITY_MISMATCH",
  "GENERATION_MODEL_MISSING",
  "GENERATION_PROMPT_EMPTY",
  "MENTION_NODE_NOT_FOUND",
  "MENTION_SELF_REFERENCE",
  "RESULT_SLOT_LIMIT",
  "GENERATION_CANCELLED",
  "GENERATION_OUTPUT_TOO_LARGE",
  "TASK_NOT_FOUND",
  "TASK_EXPIRED",
  "NOT_FOUND",
  "CONFLICT",
  "PAYLOAD_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "INTERNAL",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];
