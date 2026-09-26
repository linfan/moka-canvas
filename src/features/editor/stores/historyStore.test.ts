import { beforeEach, describe, expect, it } from "vitest";
import { HISTORY_LIMIT, type DocumentCommand } from "../../../shared/domain";
import { isBoundary, useHistoryStore, type HistoryEntry } from "./historyStore";

function entry(label: string): HistoryEntry {
  const commands: DocumentCommand[] = [
    { type: "renameCanvas", canvasId: "canvas-1", name: label },
  ];
  return {
    id: label,
    label,
    forwardCommands: commands,
    inverseCommands: commands,
  };
}

function labels() {
  return useHistoryStore.getState().undoStack.map((item) => item.label);
}

/** One landing of a batch: an answer of the same work arriving on its own. */
function piece(name: string, group: string): HistoryEntry {
  const commands: DocumentCommand[] = [
    { type: "renameCanvas", canvasId: "canvas-1", name },
  ];
  return {
    id: name,
    label: "Drawings",
    group,
    forwardCommands: commands,
    inverseCommands: commands,
  };
}

describe("historyStore", () => {
  beforeEach(() => {
    useHistoryStore.getState().clear();
  });

  it("undoes newest first and clears redo on a new record", () => {
    const history = useHistoryStore.getState();
    history.record(entry("first"));
    history.record(entry("second"));

    const taken = history.takeUndo();
    expect(taken?.label).toBe("second");
    expect(labels()).toEqual(["first"]);

    history.pushRedo(taken!);
    expect(useHistoryStore.getState().redoStack).toHaveLength(1);
    expect(useHistoryStore.getState().takeRedo()?.label).toBe("second");

    history.pushRedo(taken!);
    useHistoryStore.getState().record(entry("third"));
    expect(useHistoryStore.getState().redoStack).toHaveLength(0);
  });

  it("restores an entry whose undo failed to apply", () => {
    const history = useHistoryStore.getState();
    history.record(entry("only"));
    const taken = history.takeUndo();
    expect(useHistoryStore.getState().undoStack).toHaveLength(0);

    history.restoreUndo(taken!);
    expect(labels()).toEqual(["only"]);
    expect(useHistoryStore.getState().redoStack).toHaveLength(0);
  });

  it("caps the stack at the history limit", () => {
    const history = useHistoryStore.getState();
    for (let index = 0; index < HISTORY_LIMIT + 3; index++) {
      history.record(entry(`entry-${index}`));
    }
    const stack = useHistoryStore.getState().undoStack;
    expect(stack).toHaveLength(HISTORY_LIMIT);
    expect(labels()).not.toContain("entry-0");
    expect(labels()).toContain(`entry-${HISTORY_LIMIT + 2}`);
  });

  it("evicts entries rather than boundaries", () => {
    const history = useHistoryStore.getState();
    history.pushBoundary("Open project");
    for (let index = 0; index < HISTORY_LIMIT + 2; index++) {
      history.record(entry(`entry-${index}`));
    }
    const stack = useHistoryStore.getState().undoStack;
    expect(stack).toHaveLength(HISTORY_LIMIT);
    expect(isBoundary(stack[0])).toBe(true);
  });

  it("stops undo at a boundary", () => {
    const history = useHistoryStore.getState();
    history.record(entry("before switch"));
    history.pushBoundary("Switch canvas");
    expect(history.takeUndo()).toBeNull();

    history.record(entry("after switch"));
    expect(useHistoryStore.getState().takeUndo()?.label).toBe("after switch");
    expect(useHistoryStore.getState().takeUndo()).toBeNull();
  });

  it("joins the landings of one batch into one step", () => {
    const history = useHistoryStore.getState();
    const first = piece("first", "job-1");
    const second = piece("second", "job-1");

    history.record(first);
    history.record(second);

    // One step, and undoing it undoes what came last first.
    expect(labels()).toEqual(["Drawings"]);
    const merged = useHistoryStore.getState().undoStack[0] as HistoryEntry;
    expect(merged.forwardCommands.map((each) => JSON.stringify(each))).toEqual([
      JSON.stringify(first.forwardCommands[0]),
      JSON.stringify(second.forwardCommands[0]),
    ]);
    expect(merged.inverseCommands.map((each) => JSON.stringify(each))).toEqual([
      JSON.stringify(second.inverseCommands[0]),
      JSON.stringify(first.inverseCommands[0]),
    ]);

    // An edit of the reader's between two landings keeps them apart: a step
    // joins the batch's own pieces and never reaches back over the edit.
    history.record(entry("An edit"));
    history.record(piece("third", "job-1"));
    expect(labels()).toEqual(["Drawings", "An edit", "Drawings"]);

    // Another batch is another step, even one right after this one.
    history.record(piece("fourth", "job-2"));
    expect(labels()).toEqual(["Drawings", "An edit", "Drawings", "Drawings"]);
  });
});
