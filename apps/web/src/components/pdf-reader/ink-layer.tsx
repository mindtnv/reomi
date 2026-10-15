'use client';

// M4 — per-page ink overlay canvas. A controlled component: the parent owns the
// committed `strokes` (normalized vector data) + history; this layer replays
// them at the current scale (devicePixelRatio-aware) and turns Pointer Events
// into new strokes / eraser removals, emitting `onChange(nextStrokes)` once per
// committed gesture.
//
// PALM REJECTION + native scroll/zoom: the canvas has `touch-action` matching
// the parent (pan + pinch stay native); only pointerType 'pen' draws by default,
// plus 'mouse', plus 'touch' when fingerDraw is on. setPointerCapture +
// preventDefault while inking stops the page from scrolling under an active
// stroke. When tool==='hand' the canvas is pointer-events:none so the PDF
// scrolls untouched.

import React, { useCallback, useEffect, useRef } from 'react';
import type { InkStroke } from '@reomi/shared';
import {
  canvasToNorm,
  eraserHitsStroke,
  normToCanvas,
} from '@/lib/pdf-ink';
import type { InkTool } from './types';
import { INK_WIDTHS } from './types';

interface InkLayerProps {
  strokes: InkStroke[];
  /** CSS pixel dimensions of the page (the viewport at the current scale). */
  cssW: number;
  cssH: number;
  tool: InkTool;
  color: string;
  widthIdx: number;
  fingerDraw: boolean;
  /** Committed a gesture (stroke added or strokes erased). */
  onChange: (next: InkStroke[]) => void;
}

/** Replay one stroke onto a 2D context already scaled to CSS px. */
function paintStroke(ctx: CanvasRenderingContext2D, stroke: InkStroke, cssW: number, cssH: number) {
  const pts = stroke.points;
  if (pts.length < 3) return;
  const baseW = stroke.width * cssW;
  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (stroke.tool === 'highlighter') {
    ctx.globalAlpha = 0.35;
    ctx.globalCompositeOperation = 'multiply';
  } else {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  if (stroke.tool === 'highlighter') {
    // Constant wide nib — one path.
    ctx.lineWidth = Math.max(baseW * 3, 4);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 3) {
      const { x, y } = normToCanvas(pts[i]!, pts[i + 1]!, cssW, cssH);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  } else {
    // Pen: pressure-modulated width → segment-by-segment so width can vary.
    for (let i = 0; i + 5 < pts.length; i += 3) {
      const a = normToCanvas(pts[i]!, pts[i + 1]!, cssW, cssH);
      const b = normToCanvas(pts[i + 3]!, pts[i + 4]!, cssW, cssH);
      const pAvg = ((pts[i + 2]! || 0.5) + (pts[i + 5]! || 0.5)) / 2;
      ctx.lineWidth = Math.max(baseW * (0.5 + pAvg), 0.6);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    if (pts.length === 3) {
      // Single dot.
      const a = normToCanvas(pts[0]!, pts[1]!, cssW, cssH);
      ctx.beginPath();
      ctx.arc(a.x, a.y, Math.max(baseW / 2, 0.6), 0, Math.PI * 2);
      ctx.fillStyle = stroke.color;
      ctx.fill();
    }
  }
  ctx.restore();
}

export const InkLayer = ({
  strokes,
  cssW,
  cssH,
  tool,
  color,
  widthIdx,
  fingerDraw,
  onChange,
}: InkLayerProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The in-flight stroke (drawing) or pending erased set; kept in a ref so the
  // pointer handlers don't re-render per move.
  const liveRef = useRef<{ points: number[]; pointerId: number } | null>(null);
  // Snapshot of the committed strokes the handlers read without a stale closure.
  const strokesRef = useRef<InkStroke[]>(strokes);
  strokesRef.current = strokes;
  const erasedRef = useRef<Set<number>>(new Set());

  const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, 3) : 1;

  // ── Redraw committed strokes (+ any erase preview) whenever inputs change ────
  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const erased = erasedRef.current;
    strokesRef.current.forEach((s, i) => {
      if (erased.has(i)) {
        ctx.save();
        ctx.globalAlpha = 0.25;
        paintStroke(ctx, s, cssW, cssH);
        ctx.restore();
      } else {
        paintStroke(ctx, s, cssW, cssH);
      }
    });
  }, [cssW, cssH, dpr]);

  useEffect(() => {
    redraw();
  }, [redraw, strokes]);

  useEffect(() => {
    liveRef.current = null;
    erasedRef.current = new Set();
    redraw();
  }, [tool, redraw]);

  // ── Pointer handlers ─────────────────────────────────────────────────────────
  const canDraw = useCallback(
    (e: React.PointerEvent) => {
      if (tool === 'hand' || tool === 'smart-card') return false;
      if (e.pointerType === 'pen' || e.pointerType === 'mouse') return true;
      if (e.pointerType === 'touch') return fingerDraw;
      return false;
    },
    [tool, fingerDraw],
  );

  const localPoint = useCallback((e: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canDraw(e)) return;
      // A second concurrent pointer (finger-draw + pinch attempt) must not
      // hijack the in-flight stroke — overwriting liveRef would abandon the
      // first stroke's points as a stray partial mark. Let the container's
      // pinch tracking own the extra pointer instead.
      if (liveRef.current && liveRef.current.pointerId !== e.pointerId) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      e.preventDefault();
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const { x, y } = localPoint(e);
      if (tool === 'eraser') {
        liveRef.current = { points: [], pointerId: e.pointerId };
        erasedRef.current = new Set();
        eraseAt(x, y);
        return;
      }
      const n = canvasToNorm(x, y, cssW, cssH);
      liveRef.current = { points: [n.x, n.y, e.pressure || 0.5], pointerId: e.pointerId };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canDraw, localPoint, tool, cssW, cssH],
  );

  const eraseAt = useCallback(
    (px: number, py: number) => {
      const n = canvasToNorm(px, py, cssW, cssH);
      const radius = INK_WIDTHS[1]! * 1.2;
      let changed = false;
      strokesRef.current.forEach((s, i) => {
        if (erasedRef.current.has(i)) return;
        if (eraserHitsStroke(n.x, n.y, s, radius)) {
          erasedRef.current.add(i);
          changed = true;
        }
      });
      if (changed) redraw();
    },
    [cssW, cssH, redraw],
  );

  const drawLivePen = useCallback(() => {
    const canvas = canvasRef.current;
    const live = liveRef.current;
    if (!canvas || !live) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Repaint everything + the live stroke for crisp pen feedback.
    redraw();
    paintStroke(
      ctx,
      { tool: tool === 'highlighter' ? 'highlighter' : 'pen', color, width: INK_WIDTHS[widthIdx]!, points: live.points },
      cssW,
      cssH,
    );
  }, [redraw, tool, color, widthIdx, cssW, cssH]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const live = liveRef.current;
      if (!live || e.pointerId !== live.pointerId) return;
      e.preventDefault();
      if (tool === 'eraser') {
        const events = typeof e.nativeEvent.getCoalescedEvents === 'function'
          ? e.nativeEvent.getCoalescedEvents()
          : [e.nativeEvent];
        for (const ev of events) {
          const { x, y } = localPoint(ev);
          eraseAt(x, y);
        }
        return;
      }
      const events = typeof e.nativeEvent.getCoalescedEvents === 'function'
        ? e.nativeEvent.getCoalescedEvents()
        : [e.nativeEvent];
      for (const ev of events) {
        const { x, y } = localPoint(ev);
        const n = canvasToNorm(x, y, cssW, cssH);
        live.points.push(n.x, n.y, ev.pressure || 0.5);
      }
      drawLivePen();
    },
    [tool, localPoint, eraseAt, cssW, cssH, drawLivePen],
  );

  const endGesture = useCallback(
    (e: React.PointerEvent) => {
      const live = liveRef.current;
      if (!live || e.pointerId !== live.pointerId) return;
      const canvas = canvasRef.current;
      try {
        canvas?.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      liveRef.current = null;

      if (tool === 'eraser') {
        const erased = erasedRef.current;
        erasedRef.current = new Set();
        if (erased.size > 0) {
          const next = strokesRef.current.filter((_, i) => !erased.has(i));
          onChange(next);
        } else {
          redraw();
        }
        return;
      }

      // Commit the pen/highlighter stroke (need ≥ 1 point).
      if (live.points.length >= 3) {
        const newStroke: InkStroke = {
          tool: tool === 'highlighter' ? 'highlighter' : 'pen',
          color,
          width: INK_WIDTHS[widthIdx]!,
          points: live.points,
        };
        onChange([...strokesRef.current, newStroke]);
      } else {
        redraw();
      }
    },
    [tool, color, widthIdx, onChange, redraw],
  );

  const interactive = tool !== 'hand' && tool !== 'smart-card';

  return (
    <canvas
      ref={canvasRef}
      // M5 — marker for text-layer insertion-before and z-index ordering (z3).
      data-ink-layer="1"
      width={Math.round(cssW * dpr)}
      height={Math.round(cssH * dpr)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      style={{
        position: 'absolute',
        inset: 0,
        width: cssW,
        height: cssH,
        zIndex: 3,
        // Hand tool → let the PDF scroll/zoom through; drawing tools → keep
        // scroll/pinch native but receive pointerdown for inking.
        pointerEvents: interactive ? 'auto' : 'none',
        touchAction: interactive ? 'pan-x pan-y pinch-zoom' : 'auto',
        cursor: tool === 'eraser' ? 'cell' : interactive ? 'crosshair' : 'default',
      }}
    />
  );
};
