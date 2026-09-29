import { create } from "zustand";
import type { ClipExportTask } from "../api";

/**
 * The render this session is watching, and whether its dialog is up.
 *
 * Closing the dialog does not cancel anything: the render belongs to the
 * server, and all this holds is the handle it is polled with. Keeping the
 * handle here — rather than in the dialog — is what lets the dialog be
 * reopened and find the render it left running, and what stops a second
 * dialog from starting a second render of the same cut.
 *
 * Nothing is written down: an export has no life outside the process that
 * runs it, so a reload starts from nothing, which is the truth.
 */
interface ExportState {
  open: boolean;
  /** The last render this session started or picked up, live or ended. */
  task: ClipExportTask | null;
  /** Where the render was asked to write, kept so a retry goes to the same
   * place rather than asking again. */
  destination: string | null;
  /** What a refusal said, when the ask never became a render. */
  error: string | null;
  setOpen: (open: boolean) => void;
  setTask: (task: ClipExportTask | null) => void;
  setDestination: (destination: string | null) => void;
  setError: (error: string | null) => void;
}

export const useExportStore = create<ExportState>()((set) => ({
  open: false,
  task: null,
  destination: null,
  error: null,
  setOpen(open) {
    set({ open });
  },
  setTask(task) {
    set({ task });
  },
  setDestination(destination) {
    set({ destination });
  },
  setError(error) {
    set({ error });
  },
}));
