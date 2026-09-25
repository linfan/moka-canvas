import { useState } from "react";
import { useTranslation } from "react-i18next";

import {
  STORY_NAME_MAX,
  currentTake,
  slotWithCurrent,
} from "../../../shared/domain";
import type {
  StoryChapter,
  StoryDocument,
  StoryElement,
  StoryElementPatch,
  StorySlot,
} from "../../../shared/domain/types";
import { i18n } from "../../../shared/i18n";
import { execute } from "../../editor/commands/execute";
import { planElementArt } from "../jobs/plan";
import { useStoryRun } from "../stores/storyJobStore";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { StorySlotView } from "./StorySlotView";
import { useField } from "./useField";

/** An element's drawing sizes, as the frame the story is told in. */
const RATIOS: Record<string, string> = {
  "9:16": "9 / 16",
  "1:1": "1 / 1",
  "4:3": "4 / 3",
  "21:9": "21 / 9",
};

/** A place with nothing in it, for a slot a character has not been given yet. */
const EMPTY_SLOT: StorySlot = { takes: [], confirmed: false };

/**
 * One character, a place or a thing, as the room holds it.
 *
 * The card is a container: everything about the pictures belongs to the slot
 * views above the words, and what is written here is the element's own — its
 * name, the chapters it stands in, and the description every drawing of it is
 * made from. A description that has been agreed to is read-only until it is
 * unlocked, since it is the words everything else about this element is
 * judged against.
 */
export function ElementCard({
  story,
  element,
  busy,
  running,
}: {
  story: StoryDocument;
  element: StoryElement;
  /** Whether this element is being drawn just now. */
  busy: boolean;
  /** Whether a batch is out for the story at all, which is when none starts. */
  running: boolean;
}) {
  const { t } = useTranslation();
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [chaptersOpen, setChaptersOpen] = useState(false);
  const run = useStoryRun();
  const main = currentTake(element.main);
  const character = element.kind === "character";
  // Agreed to, and not being rewritten just now: the words are the document's.
  const locked = element.descriptionConfirmed && !editing;
  const description = useField(element.description, (value) => {
    if (value !== element.description)
      write(story, element, { description: value });
  });
  const named = useField(element.name, (value) => {
    const name = value.trim();
    // A name nobody could read is not a name: the element keeps the one it had.
    if (name !== "" && name !== element.name) write(story, element, { name });
  });
  const ratio = RATIOS[story.brief.aspect] ?? "16 / 9";

  const generate = (view: "main" | "turnaround") => {
    const [item] = planElementArt(story, [{ elementId: element.id, view }]);
    if (item === undefined) return;
    void run(story.id, "elementArt", [item]);
  };

  return (
    <li
      className={`story-element${element.descriptionConfirmed ? " is-confirmed" : ""}`}
      data-testid={`story-element-${element.kind}-${element.name}`}
    >
      <div className="story-element-pictures">
        <StorySlotView
          busy={busy}
          canGenerate={!running}
          disabledReason={t("story:elements.oneAtATime")}
          label={t("story:elements.main")}
          onChoose={(assetId) => choose(story, element, "main", assetId)}
          onConfirm={() =>
            writeSlot(story, element, "main", {
              ...element.main,
              confirmed: !element.main.confirmed,
            })
          }
          onGenerate={() => generate("main")}
          ratio={ratio}
          slot={element.main}
          testId="story-slot-main"
        />
        {character && (
          <StorySlotView
            busy={busy}
            canGenerate={main !== undefined && !running}
            disabledReason={
              main === undefined ? t("story:elements.needMainFirst") : undefined
            }
            label={t("story:elements.turnaround")}
            note={t("story:elements.turnaroundFour")}
            onChoose={(assetId) =>
              choose(story, element, "turnaround", assetId)
            }
            onConfirm={() => {
              if (element.turnaround === undefined) return;
              writeSlot(story, element, "turnaround", {
                ...element.turnaround,
                confirmed: !element.turnaround.confirmed,
              });
            }}
            onGenerate={() => generate("turnaround")}
            ratio="1 / 1"
            slot={element.turnaround ?? EMPTY_SLOT}
            testId="story-slot-turnaround"
          />
        )}
      </div>

      <div className="story-element-head">
        <span className="story-element-kind">
          {t(`story:element.${element.kind}`)}
        </span>
        <input
          aria-label={t("story:elements.name")}
          className="story-element-name"
          data-testid={`story-element-name-${element.name}`}
          maxLength={STORY_NAME_MAX}
          onBlur={named.commit}
          onChange={(event) => named.set(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            named.commit();
          }}
          value={named.value}
        />
        <button
          aria-label={t("story:elements.remove", { name: element.name })}
          className="story-element-remove"
          data-testid={`story-element-remove-${element.name}`}
          onClick={() => setRemoving(true)}
          type="button"
        >
          ✕
        </button>
      </div>

      <ChapterLine
        chapters={story.chapters}
        chosen={element.chapterIds}
        name={element.name}
        onPick={(chapterIds) => write(story, element, { chapterIds })}
        open={chaptersOpen}
        setOpen={setChaptersOpen}
      />

      <textarea
        aria-label={t("story:elements.description")}
        className={`story-element-description${locked ? " is-locked" : ""}`}
        data-testid={`story-element-description-${element.name}`}
        maxLength={2000}
        onBlur={description.commit}
        onChange={(event) => description.set(event.target.value)}
        readOnly={locked}
        rows={4}
        value={description.value}
      />

      <div className="story-element-actions">
        {element.descriptionConfirmed ? (
          <>
            <span
              className="story-element-state"
              data-testid={`story-element-state-${element.name}`}
            >
              {t("story:elements.descriptionConfirmed")}
            </span>
            <button
              className="link"
              data-testid={`story-element-unlock-${element.name}`}
              onClick={() => setEditing(true)}
              type="button"
            >
              {t("story:elements.change")}
            </button>
            <button
              className="link"
              data-testid={`story-element-unconfirm-${element.name}`}
              onClick={() => {
                setEditing(false);
                description.commit();
                write(story, element, { descriptionConfirmed: false });
              }}
              type="button"
            >
              {t("story:elements.unconfirm")}
            </button>
          </>
        ) : (
          <button
            className="link"
            data-testid={`story-element-confirm-${element.name}`}
            disabled={description.value.trim() === ""}
            onClick={() => {
              description.commit();
              write(story, element, {
                description: description.value,
                descriptionConfirmed: true,
              });
            }}
            type="button"
          >
            {t("story:elements.confirmDescription")}
          </button>
        )}
        <span className="story-hint">{t("story:elements.rewriteText")}</span>
      </div>

      {removing && (
        <ConfirmDialog
          body={t("story:elements.removeBody", { name: element.name })}
          confirm={t("story:elements.removeConfirm")}
          note={t("story:elements.removeNote")}
          onCancel={() => setRemoving(false)}
          onConfirm={() => {
            setRemoving(false);
            removeElement(story, element.id);
          }}
          testId="remove-element"
          title={t("story:elements.removeTitle", { name: element.name })}
        />
      )}
    </li>
  );
}

/** The chapters an element stands in: what it is, and the list to change it. */
function ChapterLine({
  chapters,
  chosen,
  name,
  open,
  setOpen,
  onPick,
}: {
  chapters: StoryChapter[];
  chosen: string[];
  name: string;
  open: boolean;
  setOpen: (open: boolean) => void;
  onPick: (chapterIds: string[]) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="story-element-chapters">
      {chosen.length === 0 ? (
        <span className="story-hint">{t("story:elements.anyChapter")}</span>
      ) : (
        chapters.map((chapter, index) =>
          chosen.includes(chapter.id) ? (
            <span className="story-chip" key={chapter.id}>
              {t("story:elements.chapter", { number: index + 1 })}
            </span>
          ) : null,
        )
      )}
      <button
        className="link"
        data-testid={`story-element-chapters-${name}`}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {t("story:elements.whichChapters")}
      </button>
      {open && (
        <div
          aria-label={t("story:elements.chaptersMenu")}
          className="story-chapter-menu"
          data-testid="story-element-chapters-menu"
          role="menu"
        >
          {chapters.map((chapter, index) => (
            <button
              aria-checked={chosen.includes(chapter.id)}
              className={`story-chapter-choice${chosen.includes(chapter.id) ? " is-on" : ""}`}
              key={chapter.id}
              onClick={() =>
                onPick(
                  chosen.includes(chapter.id)
                    ? chosen.filter((held) => held !== chapter.id)
                    : [...chosen, chapter.id],
                )
              }
              role="menuitemcheckbox"
              type="button"
            >
              {index + 1}. {chapter.title}
            </button>
          ))}
          <button className="link" onClick={() => setOpen(false)} type="button">
            {t("story:panels.close")}
          </button>
        </div>
      )}
    </div>
  );
}

/** One element's field, written as one step of the history. */
function write(
  story: StoryDocument,
  element: StoryElement,
  patch: StoryElementPatch,
): void {
  execute(i18n.t("story:history.elements"), [
    {
      type: "updateStoryElement",
      storyId: story.id,
      elementId: element.id,
      patch,
    },
  ]);
}

/** One of an element's two pictures, whole, as the reader leaves it. */
function writeSlot(
  story: StoryDocument,
  element: StoryElement,
  view: "main" | "turnaround",
  slot: StorySlot,
): void {
  execute(i18n.t("story:history.elements"), [
    {
      type: "setStorySlot",
      storyId: story.id,
      target: { kind: "element", elementId: element.id, view },
      slot,
    },
  ]);
}

/** Keeps the take a reader picked, and lets the older ones go on being there. */
function choose(
  story: StoryDocument,
  element: StoryElement,
  view: "main" | "turnaround",
  assetId: string,
): void {
  const slot = view === "main" ? element.main : element.turnaround;
  if (slot === undefined) return;
  writeSlot(story, element, view, slotWithCurrent(slot, assetId));
}

/** Takes an element out of the story, leaving the pictures it was drawn in. */
function removeElement(story: StoryDocument, elementId: string): void {
  execute(i18n.t("story:history.elements"), [
    {
      type: "setStoryElements",
      storyId: story.id,
      elements: story.elements.filter((held) => held.id !== elementId),
    },
  ]);
}
