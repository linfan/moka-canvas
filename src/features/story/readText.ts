import { assetUrl } from "../../api";
import type { AssetId } from "../../shared/domain";

/**
 * The words of a text asset, read whole.
 *
 * A manuscript lives on the shelf as a file and never in the document: what a
 * story holds is where the words are, not the words themselves, so that a novel
 * uploaded once does not swell every save. Reading it back is this one call,
 * made when the story is about to be written from it.
 *
 * Nothing is kept between calls. A novel is a few hundred kilobytes read once
 * per step that needs it, and a cache would only be a second copy of something
 * the project already has.
 */
export async function readTextAsset(assetId: AssetId): Promise<string> {
  const response = await fetch(assetUrl(assetId));
  if (!response.ok) {
    throw new Error(
      `The manuscript could not be read back (${response.status})`,
    );
  }
  return response.text();
}
