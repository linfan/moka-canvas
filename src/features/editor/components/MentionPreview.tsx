import { useTranslation } from "react-i18next";
import { assetUrl } from "../../../api";
import type {
  AssetId,
  GenerationSpec,
  WorkflowNode,
} from "../../../shared/domain";
import type { MediaCardInfo } from "../canvas/mediaCards";

/**
 * What a mention says when it is hovered: the card it points at, told in the
 * form that card holds.
 *
 * A picture shows the picture — a video's poster where one has been made, and
 * otherwise its own first frame, which a `<video>` draws once it has read the
 * header. An audio has nothing to look at, so it plays: the hover is the one
 * moment a reader is asking what this file is. Words show the words, whole,
 * in a box that scrolls rather than a summary that stops mid-sentence.
 */
export function MentionPreview({
  node,
  media,
}: {
  node: WorkflowNode;
  media: MediaCardInfo | null;
}) {
  const { t } = useTranslation();
  const data = node.data as {
    assetId?: AssetId;
    content?: string;
    generation?: GenerationSpec;
  };
  const picture =
    node.kind === "image" || node.kind === "video" ? media?.url : undefined;
  const words =
    node.kind === "text"
      ? (data.content ?? "")
      : node.kind === "audio"
        ? (data.generation?.prompt ?? "")
        : "";
  const shown = words.replace(/[^\S\n]+/g, " ").trim();
  return (
    <>
      {picture && <img alt="" className="mention-look-picture" src={picture} />}
      {!picture && node.kind === "video" && media?.playable && (
        <video
          className="mention-look-picture"
          muted
          playsInline
          preload="metadata"
          src={media.playable}
        />
      )}
      {node.kind === "audio" && data.assetId && (
        <audio
          aria-label={t("editor:mention.playAudio", { name: node.title })}
          autoPlay
          className="mention-look-audio"
          controls
          preload="metadata"
          src={assetUrl(data.assetId)}
        />
      )}
      {shown !== "" && <p className="mention-look-words">{shown}</p>}
      <p className="mention-look-name">{node.title}</p>
      {media?.label && <p className="mention-look-label">{media.label}</p>}
    </>
  );
}
