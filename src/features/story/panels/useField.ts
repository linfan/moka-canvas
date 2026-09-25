import { useEffect, useRef, useState } from "react";

/**
 * A field's words, which become the document's when the reader looks away.
 *
 * The same bargain the premise is written under: a paragraph typed into a
 * chapter or an element is one step to undo, not one per letter, and words
 * that were typed and never written down are written when the card goes away
 * rather than silently lost.
 *
 * The document is what the field follows: a write that came home from
 * somewhere else — the answer to a batch, a reader's undo — is what the field
 * shows next, while the letters in it that nobody has written down yet are
 * kept.
 */
export function useField(
  committed: string,
  commit: (value: string) => void,
): { value: string; set: (value: string) => void; commit: () => void } {
  const [value, setValue] = useState(committed);
  const held = useRef({ value, committed, commit });
  held.current = { value, committed, commit };

  useEffect(() => {
    setValue(committed);
  }, [committed]);

  const write = () => {
    const now = held.current;
    if (now.value !== now.committed) now.commit(now.value);
  };

  useEffect(() => {
    return () => {
      const now = held.current;
      if (now.value !== now.committed) now.commit(now.value);
    };
  }, []);

  return { value, set: setValue, commit: write };
}
