// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { ErrorBoundary } from "./ErrorBoundary";

function Explodes(): never {
  throw new Error("cannot read properties of undefined (reading 'canvas')");
}

describe("the screen that could not be drawn", () => {
  it("says what happened, and what broke under it", () => {
    // React logs the caught error itself; the suite does not need to hear it
    // twice.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Explodes />
        </ErrorBoundary>,
      );

      expect(screen.getByText(/could not be initialized/)).toBeTruthy();
      // The sentence says what the reader sees; the message is the half they
      // can repeat to somebody who can act on it.
      expect(screen.getByText(/reading 'canvas'/)).toBeTruthy();
    } finally {
      quiet.mockRestore();
    }
  });
});
