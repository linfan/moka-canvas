// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../../shared/i18n";
import { slotWithCurrent } from "../../../shared/domain/story";
import type { StorySlot } from "../../../shared/domain/types";
import { StorySlotView } from "./StorySlotView";

function slot(takes: string[], confirmed = false): StorySlot {
  return {
    takes: takes.map((assetId, at) => ({
      assetId,
      createdAt: `2026-01-0${at + 1}T00:00:00Z`,
    })),
    confirmed,
  };
}

function draw(overrides: Partial<Parameters<typeof StorySlotView>[0]> = {}) {
  const onGenerate = vi.fn();
  const onConfirm = vi.fn();
  const onChoose = vi.fn();
  render(
    <StorySlotView
      canGenerate
      label="Main picture"
      onChoose={onChoose}
      onConfirm={onConfirm}
      onGenerate={onGenerate}
      ratio="16 / 9"
      slot={slot([])}
      testId="story-slot-main"
      {...overrides}
    />,
  );
  return { onGenerate, onConfirm, onChoose };
}

afterEach(() => {
  cleanup();
});

describe("a place with nothing in it", () => {
  it("offers to draw it, and says why when it cannot", () => {
    const { onGenerate } = draw({
      canGenerate: false,
      disabledReason: "Draw the main picture first",
    });
    const button = screen.getByTestId(
      "story-slot-main-generate",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Draw the main picture first");

    fireEvent.click(button);
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("draws when the reader asks it to", () => {
    const { onGenerate } = draw();
    fireEvent.click(screen.getByTestId("story-slot-main-generate"));
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});

describe("a place being drawn", () => {
  it("says so rather than offering the button twice", () => {
    draw({ busy: true });
    expect(screen.getByRole("status").textContent).toContain("Drawing…");
    expect(screen.queryByTestId("story-slot-main-generate")).toBeNull();
  });
});

describe("a place with a picture", () => {
  it("shows it, agreement to be given and taken, and a way to ask again", () => {
    const { onConfirm, onGenerate } = draw({ slot: slot(["asset-one"]) });
    expect(
      screen
        .getByTestId("story-slot-main")
        .querySelector("img")
        ?.getAttribute("src"),
    ).toBe("/api/v1/projects/current/assets/asset-one");

    const stamp = screen.getByTestId("story-slot-main-confirm");
    expect(stamp.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(stamp);
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("story-slot-main-again"));
    expect(onGenerate).toHaveBeenCalledTimes(1);
    // One picture is not a choice: picking only appears once there is more
    // than one to pick between.
    expect(screen.queryByTestId("story-slot-main-pick")).toBeNull();
  });

  it("marks the picture the story is keeping", () => {
    draw({ slot: slot(["asset-one"], true) });
    expect(
      screen
        .getByTestId("story-slot-main-confirm")
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("lets a reader look at it closely, and closes on Escape", () => {
    draw({ slot: slot(["asset-one"]) });
    fireEvent.click(
      screen.getByRole("button", { name: "Look at Main picture closely" }),
    );
    expect(screen.getByTestId("story-lightbox")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("story-lightbox")).toBeNull();
  });
});

describe("choosing between what has been drawn", () => {
  it("marks the one being kept and hands the choice on", () => {
    const { onChoose } = draw({ slot: slot(["asset-a", "asset-b"]) });
    fireEvent.click(screen.getByTestId("story-slot-main-pick"));

    expect(screen.getByTestId("story-pick-asset-b").className).toContain(
      "is-current",
    );
    expect(screen.getByTestId("story-pick-asset-a").className).not.toContain(
      "is-current",
    );

    fireEvent.click(screen.getByTestId("story-pick-asset-a"));
    expect(onChoose).toHaveBeenCalledWith("asset-a");
    expect(screen.queryByTestId("story-picks")).toBeNull();
  });
});

describe("slotWithCurrent", () => {
  it("keeps the chosen take as the newest, the rest in the order they were", () => {
    const held = slot(["asset-a", "asset-b", "asset-c"]);
    expect(
      slotWithCurrent(held, "asset-b").takes.map((take) => take.assetId),
    ).toEqual(["asset-a", "asset-c", "asset-b"]);
    // A take that is not there leaves the place alone.
    expect(slotWithCurrent(held, "asset-gone")).toBe(held);
  });
});
