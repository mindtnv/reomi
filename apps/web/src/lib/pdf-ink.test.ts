// Unit tests for the PURE pdf-ink math (no DOM / no pdf.js). Locks the coord
// transforms, bbox + y-flip, eraser hit-test, and marked-text extraction
// ordering/caps with synthetic pdf.js text items.

import { describe, expect, test } from 'bun:test';
import {
  bboxesIntersect,
  canvasToNorm,
  clamp01,
  clientRectsToMarkRects,
  clientRectToMarkRect,
  eraserHitsStroke,
  extractMarkedText,
  inflateBBox,
  mergeSameLineRects,
  normToCanvas,
  pointToStrokeDistance,
  strokeBBox,
  textItemBBox,
  type ClientRectLike,
  type PdfTextItem,
} from './pdf-ink';
import { MARK_RECTS_MAX, MARKED_TEXT_MAX, type InkStroke, type MarkRect } from '@reomi/shared';

describe('coord transforms', () => {
  test('normToCanvas / canvasToNorm roundtrip', () => {
    const { x, y } = normToCanvas(0.25, 0.5, 800, 1000);
    expect(x).toBe(200);
    expect(y).toBe(500);
    const back = canvasToNorm(200, 500, 800, 1000);
    expect(back.x).toBeCloseTo(0.25, 6);
    expect(back.y).toBeCloseTo(0.5, 6);
  });

  test('canvasToNorm clamps out-of-page points to [0,1]', () => {
    expect(canvasToNorm(-50, 2000, 800, 1000)).toEqual({ x: 0, y: 1 });
  });

  test('canvasToNorm handles zero dims without NaN', () => {
    expect(canvasToNorm(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  test('clamp01', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.4)).toBe(0.4);
  });
});

describe('stroke geometry', () => {
  test('strokeBBox over [x,y,p] triples', () => {
    const bb = strokeBBox([0.1, 0.2, 0.5, 0.4, 0.8, 0.9, 0.3, 0.1, 0.7]);
    expect(bb).toEqual({ minX: 0.1, minY: 0.1, maxX: 0.4, maxY: 0.8 });
  });

  test('strokeBBox empty', () => {
    expect(strokeBBox([])).toBeNull();
    expect(strokeBBox([0.1, 0.2])).toBeNull();
  });

  test('inflateBBox + bboxesIntersect', () => {
    const a = { minX: 0, minY: 0, maxX: 0.1, maxY: 0.1 };
    const b = { minX: 0.15, minY: 0.15, maxX: 0.2, maxY: 0.2 };
    expect(bboxesIntersect(a, b)).toBe(false);
    expect(bboxesIntersect(inflateBBox(a, 0.06), b)).toBe(true);
  });

  test('pointToStrokeDistance — on the segment is ~0', () => {
    const pts = [0, 0, 1, 1, 0, 1]; // horizontal segment y=0
    expect(pointToStrokeDistance(0.5, 0, pts)).toBeCloseTo(0, 6);
  });

  test('pointToStrokeDistance — perpendicular offset', () => {
    const pts = [0, 0, 1, 1, 0, 1];
    expect(pointToStrokeDistance(0.5, 0.2, pts)).toBeCloseTo(0.2, 6);
  });

  test('pointToStrokeDistance — single point degrades to point distance', () => {
    expect(pointToStrokeDistance(0.3, 0.4, [0, 0, 1])).toBeCloseTo(0.5, 6);
  });

  test('eraserHitsStroke respects radius + stroke half-width', () => {
    const stroke: InkStroke = { tool: 'pen', color: '#9ad155', width: 0.004, points: [0, 0, 1, 1, 0, 1] };
    // threshold = radius(0.005) + width/2(0.002) = 0.007.
    expect(eraserHitsStroke(0.5, 0.006, stroke, 0.005)).toBe(true); // within threshold
    expect(eraserHitsStroke(0.5, 0.01, stroke, 0.005)).toBe(false); // just outside
    expect(eraserHitsStroke(0.5, 0.2, stroke, 0.005)).toBe(false); // far
  });
});

describe('textItemBBox — pdf.js transform + y-flip', () => {
  // pageH = 1000 (y-up). An item at baseline y=900, height 20 occupies y 900..920
  // (PDF, y-up) → normalized top = 1 - 920/1000 = 0.08, bottom = 1 - 900/1000 = 0.10.
  test('flips PDF y-up to normalized y-down', () => {
    const item: PdfTextItem = { str: 'Hi', transform: [1, 0, 0, 1, 100, 900], width: 50, height: 20 };
    const bb = textItemBBox(item, 1000, 1000)!;
    expect(bb.minX).toBeCloseTo(0.1, 6);
    expect(bb.maxX).toBeCloseTo(0.15, 6);
    expect(bb.minY).toBeCloseTo(0.08, 6);
    expect(bb.maxY).toBeCloseTo(0.1, 6);
  });

  test('returns null for a degenerate transform/page', () => {
    expect(textItemBBox({ str: 'x', transform: [1, 0, 0, 1], width: 1, height: 1 }, 100, 100)).toBeNull();
    expect(textItemBBox({ str: 'x', transform: [1, 0, 0, 1, 0, 0], width: 1, height: 1 }, 0, 100)).toBeNull();
  });
});

describe('extractMarkedText', () => {
  // Three items on two lines (PDF y-up, pageH=1000):
  //  line 1 (y≈900): "Hello" at x100, "World" at x300
  //  line 2 (y≈850): "Bye" at x100
  const items: PdfTextItem[] = [
    { str: 'World', transform: [1, 0, 0, 1, 300, 900], width: 60, height: 16 },
    { str: 'Hello', transform: [1, 0, 0, 1, 100, 900], width: 60, height: 16 },
    { str: 'Bye', transform: [1, 0, 0, 1, 100, 850], width: 40, height: 16 },
  ];

  test('returns text under a stroke in reading order (y then x)', () => {
    // A stroke covering all of line 1 (normalized y≈0.084..0.10, x 0.1..0.36).
    const stroke: InkStroke = {
      tool: 'highlighter',
      color: '#f3b655',
      width: 0.01,
      points: [0.1, 0.09, 1, 0.36, 0.09, 1],
    };
    const out = extractMarkedText(items, 1000, 1000, [stroke]);
    expect(out).toBe('Hello World');
  });

  test('multi-line stroke joins lines with newline, top-to-bottom', () => {
    // A tall stroke covering both lines at x≈0.1.
    const stroke: InkStroke = {
      tool: 'pen',
      color: '#9ad155',
      width: 0.01,
      points: [0.11, 0.085, 1, 0.11, 0.155, 1],
    };
    const out = extractMarkedText(items, 1000, 1000, [stroke]);
    // Line 1 (y≈0.09) before line 2 (y≈0.16). Only the x≈0.1 column items hit.
    expect(out).toBe('Hello\nBye');
  });

  test('no strokes / no hits → empty string', () => {
    expect(extractMarkedText(items, 1000, 1000, [])).toBe('');
    const far: InkStroke = { tool: 'pen', color: '#9ad155', width: 0.001, points: [0.9, 0.9, 1, 0.95, 0.95, 1] };
    expect(extractMarkedText(items, 1000, 1000, [far])).toBe('');
  });

  test('caps output at MARKED_TEXT_MAX', () => {
    const many: PdfTextItem[] = [];
    for (let i = 0; i < 4000; i++) {
      many.push({ str: 'word ', transform: [1, 0, 0, 1, 10, 900], width: 900, height: 16 });
    }
    const stroke: InkStroke = { tool: 'highlighter', color: '#f3b655', width: 0.02, points: [0.0, 0.09, 1, 1.0, 0.09, 1] };
    const out = extractMarkedText(many, 1000, 1000, [stroke]);
    expect(out.length).toBeLessThanOrEqual(MARKED_TEXT_MAX);
  });
});

describe('selection rect geometry (M5 marks)', () => {
  const page = { left: 100, top: 50, width: 800, height: 1000 };

  test('clientRectToMarkRect normalizes against the page box (0..1, y down)', () => {
    const m = clientRectToMarkRect({ left: 300, top: 150, width: 400, height: 20 }, page)!;
    expect(m.x).toBeCloseTo(0.25, 6); // (300-100)/800
    expect(m.y).toBeCloseTo(0.1, 6); // (150-50)/1000
    expect(m.w).toBeCloseTo(0.5, 6); // 400/800
    expect(m.h).toBeCloseTo(0.02, 6); // 20/1000
  });

  test('clientRectToMarkRect drops zero-area + degenerate page', () => {
    expect(clientRectToMarkRect({ left: 0, top: 0, width: 0, height: 10 }, page)).toBeNull();
    expect(clientRectToMarkRect({ left: 0, top: 0, width: 10, height: 0 }, page)).toBeNull();
    expect(
      clientRectToMarkRect({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 0 }),
    ).toBeNull();
  });

  test('clientRectToMarkRect clamps out-of-page coords to [0,1]', () => {
    const m = clientRectToMarkRect({ left: 50, top: 20, width: 2000, height: 20 }, page)!;
    expect(m.x).toBe(0); // left of the page → clamped
    expect(m.y).toBe(0);
    expect(m.w).toBe(1); // wider than the page → clamped
  });

  test('mergeSameLineRects merges adjacent same-line fragments', () => {
    const rects: MarkRect[] = [
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.2, y: 0.2, w: 0.1, h: 0.02 }, // adjacent → merges into the first
      { x: 0.1, y: 0.3, w: 0.1, h: 0.02 }, // different line → kept separate
    ];
    const out = mergeSameLineRects(rects);
    expect(out).toHaveLength(2);
    expect(out[0]!.x).toBeCloseTo(0.1, 6);
    expect(out[0]!.w).toBeCloseTo(0.2, 6); // 0.1..0.3
    expect(out[1]!.y).toBeCloseTo(0.3, 6);
  });

  test('mergeSameLineRects does not merge a wide horizontal gap on the same line', () => {
    const rects: MarkRect[] = [
      { x: 0.1, y: 0.2, w: 0.1, h: 0.02 },
      { x: 0.6, y: 0.2, w: 0.1, h: 0.02 }, // far away horizontally → separate
    ];
    expect(mergeSameLineRects(rects)).toHaveLength(2);
  });

  test('mergeSameLineRects unifies OVERLAPPING different-height rects on one line (bold vs regular)', () => {
    // A bold span's box is taller and x-overlaps the regular span's box on the
    // SAME line — the old equal-y/equal-h matching kept both, which painted a
    // double-tinted dark sliver. The line-grouping merge must emit ONE band at
    // the unified height — never self-intersecting output.
    const rects: MarkRect[] = [
      { x: 0.10, y: 0.200, w: 0.15, h: 0.024 }, // bold: taller box
      { x: 0.22, y: 0.204, w: 0.30, h: 0.018 }, // regular: x-overlaps [0.22..0.25]
    ];
    const out = mergeSameLineRects(rects);
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBeCloseTo(0.10, 5);
    expect(out[0]!.w).toBeCloseTo(0.42, 5); // 0.52 - 0.10
    expect(out[0]!.y).toBeCloseTo(0.2, 5);
    expect(out[0]!.h).toBeCloseTo(0.024, 5); // unified line height
  });

  test('mergeSameLineRects keeps adjacent text LINES separate (no vertical merge)', () => {
    const rects: MarkRect[] = [
      { x: 0.1, y: 0.2, w: 0.4, h: 0.018 },
      { x: 0.1, y: 0.222, w: 0.4, h: 0.018 }, // next line: no vertical overlap
    ];
    expect(mergeSameLineRects(rects)).toHaveLength(2);
  });

  test('clientRectsToMarkRects normalizes + merges + caps', () => {
    const out = clientRectsToMarkRects(
      [
        { left: 100, top: 250, width: 80, height: 20 }, // line 1, x 0..0.1
        { left: 180, top: 250, width: 80, height: 20 }, // line 1, adjacent → merge
        { left: 100, top: 0, width: 0, height: 20 }, // zero-width → dropped
      ],
      page,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.x).toBeCloseTo(0, 6);
    expect(out[0]!.w).toBeCloseTo(0.2, 6);
  });

  test('clientRectsToMarkRects caps at MARK_RECTS_MAX', () => {
    const rects: ClientRectLike[] = [];
    // Distinct lines (no merge) so each survives → exceed the cap.
    for (let i = 0; i < MARK_RECTS_MAX + 20; i++) {
      rects.push({ left: 100, top: 60 + i * 30, width: 80, height: 20 });
    }
    expect(clientRectsToMarkRects(rects, page).length).toBeLessThanOrEqual(MARK_RECTS_MAX);
  });
});
