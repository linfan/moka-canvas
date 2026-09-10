import type { ChannelModel } from "../../api";
import type { Capability } from "../../shared/domain";

/** A model row plus the identity that keeps it mounted while rows come and go. */
export interface ModelRow extends ChannelModel {
  key: number;
}

let nextRowKey = 1;

export function toRow(model: ChannelModel): ModelRow {
  return { ...model, key: nextRowKey++ };
}

/**
 * An empty row, starting on the capability given.
 *
 * Callers pass the first kind the channel has nothing for rather than always
 * "text": a row that begins as text is how a channel ends up with six text
 * models and no way to make a picture.
 */
export function newRow(capability: Capability = "text"): ModelRow {
  return { id: "", capability, alias: "", enabled: true, key: nextRowKey++ };
}
