import { describe, expect, it } from "vitest";
import {
  HALO_ARC,
  HALO_BREATH_MS,
  HALO_CORNER_RADIUS,
  HALO_GLOW,
  HALO_MAX_ARCS,
  HALO_MIN_ARCS,
  HALO_OFFSET,
  HALO_SELECTED_OFFSET,
  HALO_QUEUED_TURN_MS,
  HALO_TURN_MS,
  haloArcs,
  haloFrame,
  haloOffset,
  haloRing,
  ringPerimeter,
} from "./halo";

const CARD = { width: 260, height: 140 };

describe("the ring round a card that is being worked on", () => {
  it("stands off the card on every side and rounds its corners to match", () => {
    const ring = haloRing(CARD);
    expect(ring.x).toBe(-HALO_OFFSET);
    expect(ring.y).toBe(-HALO_OFFSET);
    expect(ring.width).toBe(CARD.width + HALO_OFFSET * 2);
    expect(ring.height).toBe(CARD.height + HALO_OFFSET * 2);
    expect(ring.cornerRadius).toBe(HALO_CORNER_RADIUS + HALO_OFFSET);
  });

  it("stands further off a card that is wearing its selection outline", () => {
    // The outline is drawn five pixels out from the card and painted over it, so
    // a ring at the usual distance would be hidden behind the very outline that
    // says "this is the card being run".
    expect(haloOffset(false)).toBe(HALO_OFFSET);
    expect(haloOffset(true)).toBe(HALO_SELECTED_OFFSET);
    expect(haloOffset(true)).toBeGreaterThan(6);
    const plain = haloRing(CARD, haloOffset(false));
    const selected = haloRing(CARD, haloOffset(true));
    expect(selected.x).toBeLessThan(plain.x);
    expect(selected.width).toBeGreaterThan(plain.width);
  });

  it("cuts the arcs for the standoff the ring is actually standing at", () => {
    const plain = haloArcs(CARD, haloOffset(false));
    const selected = haloArcs(CARD, haloOffset(true));
    expect(selected.lap).toBeGreaterThan(plain.lap);
    expect((selected.dash + selected.gap) * selected.arcs).toBeCloseTo(
      selected.lap,
      6,
    );
  });

  it("never rounds a corner more than the ring can carry", () => {
    const ring = haloRing({ width: 4, height: 40 });
    expect(ring.cornerRadius).toBeLessThanOrEqual(ring.width / 2);
  });

  it("measures the ring as its straights plus its four quarter-corners", () => {
    expect(ringPerimeter(100, 50, 0)).toBeCloseTo(300);
    expect(ringPerimeter(100, 50, 10)).toBeCloseTo(
      2 * 80 + 2 * 30 + 2 * Math.PI * 10,
    );
    // A corner bigger than the side is drawn as big as the side allows, which
    // leaves this one with no horizontal straight at all.
    expect(ringPerimeter(20, 100, 40)).toBeCloseTo(2 * 80 + 2 * Math.PI * 10);
  });
});

describe("the arcs cut out of that ring", () => {
  it("fits a whole number of them round the ring, so no seam shows", () => {
    const { dash, gap, lap, arcs } = haloArcs(CARD);
    expect(arcs).toBeGreaterThanOrEqual(HALO_MIN_ARCS);
    expect(arcs).toBeLessThanOrEqual(HALO_MAX_ARCS);
    expect((dash + gap) * arcs).toBeCloseTo(lap, 6);
  });

  it("measures the lap as the distance round the ring it is cut for", () => {
    const ring = haloRing(CARD);
    expect(haloArcs(CARD).lap).toBeCloseTo(
      ringPerimeter(ring.width, ring.height, ring.cornerRadius),
      6,
    );
  });

  it("gives a small card fewer arcs and a wide one more, within reason", () => {
    expect(haloArcs({ width: 40, height: 40 }).arcs).toBe(HALO_MIN_ARCS);
    expect(haloArcs(CARD).arcs).toBeGreaterThan(HALO_MIN_ARCS);
    const wide = haloArcs({ width: 4000, height: 2000 }).arcs;
    expect(wide).toBeGreaterThan(HALO_MIN_ARCS);
    expect(wide).toBe(HALO_MAX_ARCS);
  });

  it("grows the lap with the card, since a bigger ring is further round", () => {
    expect(haloArcs({ width: 600, height: 400 }).lap).toBeGreaterThan(
      haloArcs(CARD).lap,
    );
  });
});

describe("the movement of the ring over time", () => {
  const { lap } = haloArcs(CARD);

  it("travels forward, and never further than one lap from where it began", () => {
    const first = haloFrame(0, lap, false);
    const later = haloFrame(HALO_TURN_MS / 4, lap, false);
    expect(first.dashOffset).toBeCloseTo(0);
    expect(later.dashOffset).toBeLessThan(first.dashOffset);
    expect(later.dashOffset).toBeGreaterThan(-lap);
  });

  it("comes back to where it started after exactly one lap", () => {
    expect(haloFrame(HALO_TURN_MS, lap, false).dashOffset).toBeCloseTo(0);
    expect(haloFrame(HALO_TURN_MS * 3, lap, false).dashOffset).toBeCloseTo(0);
  });

  it("keeps the same reading for two cards asked at the same moment", () => {
    // Both rings are read off the one clock, so a canvas full of running nodes
    // looks like one effect rather than a hundred that began at different times.
    expect(haloFrame(1234, lap, false)).toEqual(haloFrame(1234, lap, false));
  });

  it("turns a waiting card more slowly than a working one", () => {
    const at = HALO_TURN_MS / 4;
    const working = haloFrame(at, lap, false).dashOffset;
    const waiting = haloFrame(at, lap, true).dashOffset;
    expect(Math.abs(waiting)).toBeLessThan(Math.abs(working));
    expect(waiting).toBeCloseTo(working * (HALO_TURN_MS / HALO_QUEUED_TURN_MS));
  });

  it("breathes: dim at the start of a breath, bright halfway through it", () => {
    const bottom = haloFrame(0, lap, false);
    const top = haloFrame(HALO_BREATH_MS / 2, lap, false);
    expect(bottom.glow).toBeCloseTo(HALO_GLOW.working.dim);
    expect(top.glow).toBeCloseTo(HALO_GLOW.working.bright);
    expect(bottom.arc).toBeCloseTo(HALO_ARC.working.dim);
    expect(top.arc).toBeCloseTo(HALO_ARC.working.bright);
    expect(haloFrame(HALO_BREATH_MS, lap, false).glow).toBeCloseTo(
      HALO_GLOW.working.dim,
    );
  });

  it("keeps every brightness it reports inside the range it was given", () => {
    for (const waiting of [false, true]) {
      for (let at = 0; at < HALO_QUEUED_TURN_MS; at += 97) {
        const frame = haloFrame(at, lap, waiting);
        const glow = waiting ? HALO_GLOW.waiting : HALO_GLOW.working;
        const arc = waiting ? HALO_ARC.waiting : HALO_ARC.working;
        expect(frame.glow).toBeGreaterThanOrEqual(glow.dim);
        expect(frame.glow).toBeLessThanOrEqual(glow.bright);
        expect(frame.arc).toBeGreaterThanOrEqual(arc.dim);
        expect(frame.arc).toBeLessThanOrEqual(arc.bright);
      }
    }
  });

  it("glows less for a card that is only waiting its turn", () => {
    const at = HALO_BREATH_MS / 2;
    expect(haloFrame(at, lap, true).glow).toBeLessThan(
      haloFrame(at, lap, false).glow,
    );
    expect(haloFrame(at, lap, true).arc).toBeLessThan(
      haloFrame(at, lap, false).arc,
    );
  });
});
