'use client';

import { TextInput, Button } from '@/components/design-system/primitives';


// NeuroNexus — Graph screen
// Interactive knowledge graph: d3-force layout + d3-zoom pan/zoom + d3-drag nodes.
// Real data wired from the useNN store; derived via buildGraph.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from 'd3-force';
import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { drag } from 'd3-drag';
import { select } from 'd3-selection';

import { NNIcon, NNBtn, NNBadge, NNSkeleton } from '@/components/ui';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';
import { useEmptyRedirect } from '@/lib/use-empty-redirect';
import { useNN } from '@/lib/store';
import { api, ok } from '@/lib/api';
import {
  buildGraph,
  countLinks,
  cardMastery,
  semanticToGraphEdges,
  type GraphEdge,
  type GraphNode,
} from '@/lib/graph';
import { humanInterval } from '@/lib/fsrs';
import { useBreakpoint } from '@/lib/use-breakpoint';
import type { DeckColor } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { useSessionResource } from '@/lib/session-resource';

// Fallback initial viewport (used before ResizeObserver fires).
const graphTone = (color: string, shade = 500) => color === 'neutral' || color === 'ink' ? 'var(--text-muted)' : `var(--${color}-${shade})`;
const INITIAL_W = 1200;
const INITIAL_H = 700;

interface SimNode extends Omit<GraphNode, 'x' | 'y'>, SimulationNodeDatum {
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}
interface SimLink {
  source: SimNode | string;
  target: SimNode | string;
  weight: number;
}

export const NNGraph = () => <NNGraphForce/>;

// ─────────────────────────────────────────────
// Variant A: Force-directed (default) — real data + interactive
// ─────────────────────────────────────────────
export const NNGraphForce = () => {
  useEmptyRedirect('graph');
  const t = useT();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const [legendExpanded, setLegendExpanded] = useState<boolean | null>(null);
  const legendOpen = legendExpanded ?? !isMobile;
  useEffect(() => { setLegendExpanded(null); }, [isMobile]);
  const cards = useNN((s) => s.cards);
  const decks = useNN((s) => s.decks);

  // Canvas container + its live dimensions; SVG viewBox and force centers track these.
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: INITIAL_W, h: INITIAL_H });
  const { w: W, h: H } = dims;

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let frame = 0;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width < 10 || height < 10) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setDims((prev) =>
          Math.abs(prev.w - width) < 40 && Math.abs(prev.h - height) < 40
            ? prev
            : { w: Math.round(width), h: Math.round(height) },
        );
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);

  // ── Edge source: semantic (pgvector neighbours) vs tags ──────────────────
  // Semantic edges load once per mount; when present they are the DEFAULT.
  // The user's explicit choice persists in localStorage and is re-validated
  // against data availability (no embeddings ⇒ silently fall back to tags).
  const [edgePreferenceResolved, setEdgePreferenceResolved] = useState(false);
  const [edgePref, setEdgePref] = useState<'semantic' | 'tags' | null>(null);

  useEffect(() => {
    try {
      const stored = readBrowserValue(window.localStorage, 'nn:graph:edges');
      if (stored === 'tags' || stored === 'semantic') setEdgePref(stored);
    } catch {
      // localStorage unavailable — keep the default.
    } finally {
      setEdgePreferenceResolved(true);
    }
  }, []);

  const fetchSemanticEdges = useCallback(async () => {
    const body = (await ok(
      await (api as any).graph['semantic-edges'].get({ query: {} }),
    )) as { edges: { a: string; b: string; score: number }[]; reason?: string };
    return semanticToGraphEdges(body.edges);
  }, []);
  const semanticResource = useSessionResource({
    key: 'graph:semantic-edges',
    fetcher: fetchSemanticEdges,
    keepPreviousData: true,
  });
  const semEdges = semanticResource.data ?? [];
  const edgeAvailabilityResolved =
    edgePreferenceResolved &&
    (semanticResource.data !== null || semanticResource.status === 'error');

  const semanticAvailable = semEdges.length > 0;
  const edgeSource: 'semantic' | 'tags' =
    semanticAvailable && edgePref !== 'tags' ? 'semantic' : 'tags';
  const pickEdgeSource = useCallback((src: 'semantic' | 'tags') => {
    setEdgePref(src);
    try {
      writeBrowserValue(window.localStorage, 'nn:graph:edges', src);
    } catch {
      // best-effort persistence only
    }
  }, []);

  const built = useMemo(
    () => edgeAvailabilityResolved
      ? buildGraph(cards, decks, W, H, edgeSource === 'semantic' ? semEdges : undefined)
      : { nodes: [], edges: [] },
    [cards, decks, W, H, edgeSource, semEdges, edgeAvailabilityResolved],
  );

  // deckId → count for legend / toggle.
  const deckCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of built.nodes) m.set(n.deckId, (m.get(n.deckId) ?? 0) + 1);
    return m;
  }, [built.nodes]);

  const legendDecks = useMemo(
    () => decks.filter((d) => (deckCounts.get(d.id) ?? 0) > 0),
    [decks, deckCounts],
  );

  // Per-deck visibility toggles.
  const [hiddenDecks, setHiddenDecks] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Deck centers for forceX/forceY stretch.
  const deckCentersByDeckId = useMemo(() => {
    const cx = W / 2;
    const cy = H / 2;
    const ring = Math.min(W, H) * 0.34;
    const activeDecks = legendDecks;
    const map = new Map<string, { x: number; y: number }>();
    activeDecks.forEach((d, i) => {
      const angle = (i / Math.max(1, activeDecks.length)) * Math.PI * 2 - Math.PI / 2;
      map.set(d.id, { x: cx + Math.cos(angle) * ring, y: cy + Math.sin(angle) * ring });
    });
    return map;
  }, [legendDecks, W, H]);

  // Fresh mutable copies for d3-force (d3 mutates x/y/vx/vy and rewrites link.source/target to node refs).
  const { simNodes, simLinks } = useMemo(() => {
    const nodes = built.nodes.map((n) => ({ ...n })) as SimNode[];
    const links = built.edges.map((e) => ({
      source: e.a,
      target: e.b,
      weight: e.weight,
    })) as SimLink[];
    return { simNodes: nodes, simLinks: links };
  }, [built]);

  // Edge count (before any visibility filter) — for the empty-state sidebar.
  const totalEdges = built.edges.length;

  // DOM refs for imperative updates on every tick (bypass React for 60fps).
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef<SVGGElement | null>(null);
  const nodeRefs = useRef<Map<string, SVGGElement>>(new Map());
  const lineRefs = useRef<Map<number, SVGLineElement>>(new Map());
  const labelRefs = useRef<Map<string, SVGGElement>>(new Map());
  const draggedDistRef = useRef(0);

  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);

  const [zoomPct, setZoomPct] = useState(100);

  // ─── Simulation & zoom setup (runs when graph data changes) ───
  useEffect(() => {
    // Do not start a throwaway tag simulation while semantic availability is
    // unresolved; the first visible simulation uses the final edge source.
    if (!edgeAvailabilityResolved) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;

    const minSide = Math.min(W, H);
    const linkDistance = Math.max(28, Math.min(55, minSide * 0.08));
    const chargeStrength = -Math.max(60, Math.min(160, minSide * 0.22));
    const clusterStrength = minSide < 600 ? 0.28 : 0.18;

    const sim = forceSimulation<SimNode, SimLink>(simNodes)
      .force('charge', forceManyBody<SimNode>().strength(chargeStrength))
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(linkDistance)
          .strength(0.35),
      )
      .force('collide', forceCollide<SimNode>((d) => d.r + 4))
      .force(
        'x',
        forceX<SimNode>((d) => deckCentersByDeckId.get(d.deckId)?.x ?? W / 2).strength(clusterStrength),
      )
      .force(
        'y',
        forceY<SimNode>((d) => deckCentersByDeckId.get(d.deckId)?.y ?? H / 2).strength(clusterStrength),
      )
      .force('center', forceCenter(W / 2, H / 2).strength(0.04))
      .alpha(0.9);

    simRef.current = sim;

    const tick = () => {
      // Clamp nodes inside the viewBox so they never drift out of sight.
      for (const n of simNodes) {
        const pad = n.r + 6;
        if (typeof n.x === 'number') n.x = Math.max(pad, Math.min(W - pad, n.x));
        if (typeof n.y === 'number') n.y = Math.max(pad, Math.min(H - pad, n.y));
      }
      // Update node positions.
      for (const n of simNodes) {
        const el = nodeRefs.current.get(n.id);
        if (el) el.setAttribute('transform', `translate(${n.x ?? 0},${n.y ?? 0})`);
      }
      // Update edge positions.
      for (let k = 0; k < simLinks.length; k++) {
        const el = lineRefs.current.get(k);
        if (!el) continue;
        const l = simLinks[k];
        const s = l.source as SimNode;
        const target = l.target as SimNode;
        el.setAttribute('x1', String(s.x ?? 0));
        el.setAttribute('y1', String(s.y ?? 0));
        el.setAttribute('x2', String(target.x ?? 0));
        el.setAttribute('y2', String(target.y ?? 0));
      }
      // Update cluster labels (float above each cluster's top node).
      const byDeck = new Map<string, SimNode[]>();
      for (const n of simNodes) {
        const arr = byDeck.get(n.deckId);
        if (arr) arr.push(n);
        else byDeck.set(n.deckId, [n]);
      }
      byDeck.forEach((nodes, deckId) => {
        const el = labelRefs.current.get(deckId);
        if (!el) return;
        let sx = 0;
        let minY = Infinity;
        for (const n of nodes) {
          sx += n.x ?? 0;
          if ((n.y ?? Infinity) < minY) minY = n.y ?? 0;
        }
        const avgX = sx / nodes.length;
        // Keep label away from viewBox edges (half of rough label width).
        const halfLabel = Math.max(50, Math.min(90, W * 0.22));
        const clampedX = Math.max(halfLabel, Math.min(W - halfLabel, avgX));
        const clampedY = Math.max(22, minY - 18);
        el.setAttribute('transform', `translate(${clampedX},${clampedY})`);
      });
    };

    sim.on('tick', tick);
    // Run one tick right away so first paint isn't at origin.
    tick();

    // Zoom behavior — applied to inner <g>.
    const svgSel = select<SVGSVGElement, unknown>(svgEl);
    const z = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 5])
      .filter((ev) => {
        // Prevent zoom from eating pointer-down events over nodes (so drag on nodes wins).
        const target = ev.target as Element | null;
        if (target?.closest('[data-node="1"]')) return false;
        // Allow wheel, single-button mouse drag, and touch.
        if (ev.type === 'wheel') return !ev.ctrlKey;
        if (ev.type === 'mousedown') return ev.button === 0;
        return true;
      })
      .on('zoom', (ev) => {
        transformRef.current = ev.transform;
        if (viewRef.current) {
          viewRef.current.setAttribute('transform', ev.transform.toString());
        }
        setZoomPct(Math.round(ev.transform.k * 100));
      });

    zoomRef.current = z;
    svgSel.call(z);
    // Ensure starting transform matches identity.
    svgSel.call(z.transform, zoomIdentity);

    return () => {
      sim.stop();
      svgSel.on('.zoom', null);
    };
    // deckCentersByDeckId depends on the same cards/decks → no extra dep needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [simNodes, simLinks, edgeAvailabilityResolved]);

  // ─── Node drag (wired once per render since refs may repopulate) ───
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const disposers: (() => void)[] = [];
    for (const n of simNodes) {
      const el = nodeRefs.current.get(n.id);
      if (!el) continue;
      const behaviour = drag<SVGGElement, unknown>()
        .on('start', (ev) => {
          draggedDistRef.current = 0;
          if (!ev.active) sim.alphaTarget(0.3).restart();
          n.fx = n.x ?? 0;
          n.fy = n.y ?? 0;
        })
        .on('drag', (ev) => {
          draggedDistRef.current += Math.abs(ev.dx) + Math.abs(ev.dy);
          n.fx = ev.x;
          n.fy = ev.y;
        })
        .on('end', (ev) => {
          if (!ev.active) sim.alphaTarget(0);
          n.fx = null;
          n.fy = null;
        });
      const sel = select(el);
      sel.call(behaviour);
      disposers.push(() => sel.on('.drag', null));
    }
    return () => disposers.forEach((fn) => fn());
  }, [simNodes]);

  // ─── Zoom controls ───
  const zoomBy = useCallback((factor: number) => {
    const svgEl = svgRef.current;
    const z = zoomRef.current;
    if (!svgEl || !z) return;
    select(svgEl).call(z.scaleBy, factor);
  }, []);

  const resetZoom = useCallback(() => {
    const svgEl = svgRef.current;
    const z = zoomRef.current;
    if (!svgEl || !z) return;
    select(svgEl).call(z.transform, zoomIdentity);
  }, []);

  const fitToView = useCallback(() => {
    const svgEl = svgRef.current;
    const z = zoomRef.current;
    if (!svgEl || !z || simNodes.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of simNodes) {
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const padding = 60;
    const graphW = Math.max(1, maxX - minX + padding * 2);
    const graphH = Math.max(1, maxY - minY + padding * 2);
    const scale = Math.min(5, Math.max(0.2, Math.min(W / graphW, H / graphH)));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const tx = W / 2 - scale * cx;
    const ty = H / 2 - scale * cy;
    const nextTransform = zoomIdentity.translate(tx, ty).scale(scale);
    select(svgEl).call(z.transform, nextTransform);
  }, [simNodes, W, H]);

  const reheat = useCallback(() => {
    const sim = simRef.current;
    if (!sim) return;
    sim.alpha(0.9).restart();
  }, []);

  const toggleDeck = useCallback((deckId: string) => {
    setHiddenDecks((prev) => {
      const next = new Set(prev);
      if (next.has(deckId)) next.delete(deckId);
      else next.add(deckId);
      return next;
    });
  }, []);

  const allHidden = hiddenDecks.size > 0 && hiddenDecks.size === legendDecks.length;
  const toggleAll = useCallback(() => {
    setHiddenDecks(allHidden ? new Set() : new Set(legendDecks.map((d) => d.id)));
  }, [allHidden, legendDecks]);

  // ─── Selection & query ───
  const selectedNode = selectedId ? simNodes.find((n) => n.id === selectedId) ?? null : null;

  const matchesQuery = useCallback(
    (n: SimNode) => {
      if (!query.trim()) return true;
      const q = query.trim().toLowerCase();
      return (
        n.card.renderFrontText.toLowerCase().includes(q) ||
        n.card.renderBackText.toLowerCase().includes(q) ||
        n.card.tags.some((t) => t.toLowerCase().includes(q))
      );
    },
    [query],
  );

  const isNodeVisible = useCallback(
    (n: SimNode) => !hiddenDecks.has(n.deckId) && matchesQuery(n),
    [hiddenDecks, matchesQuery],
  );

  // selected neighbours list (unchanged logic).
  const nodesById = useMemo(() => {
    const m = new Map<string, SimNode>();
    for (const n of simNodes) m.set(n.id, n);
    return m;
  }, [simNodes]);

  const selectedLinks = useMemo(() => {
    if (!selectedNode)
      return [] as { id: string; front: string; shared: number; color: string; score?: number }[];
    const out: { id: string; front: string; shared: number; color: string; score?: number }[] = [];
    for (const e of built.edges) {
      const otherId = e.a === selectedNode.id ? e.b : e.b === selectedNode.id ? e.a : null;
      if (!otherId) continue;
      const other = nodesById.get(otherId);
      if (!other) continue;
      out.push({
        id: other.id,
        front: other.card.renderFrontText,
        shared: e.weight,
        color: other.color,
        score: e.score,
      });
    }
    return out
      .sort((x, y) => (y.score ?? y.shared) - (x.score ?? x.shared))
      .slice(0, 8);
  }, [selectedNode, built.edges, nodesById]);

  // ─── Drive DOM opacity based on visibility / highlight ───
  // Runs on every relevant state change.
  useEffect(() => {
    const selId = selectedId;
    const connected = new Set<string>();
    if (selId) {
      for (const e of built.edges) {
        if (e.a === selId) connected.add(e.b);
        if (e.b === selId) connected.add(e.a);
      }
    }
    for (const n of simNodes) {
      const el = nodeRefs.current.get(n.id);
      if (!el) continue;
      const visible = isNodeVisible(n);
      const qActive = !!query.trim();
      const isMatch = qActive && matchesQuery(n);
      const dim = selId ? !(n.id === selId || connected.has(n.id)) : qActive && !isMatch;
      el.setAttribute(
        'opacity',
        !visible ? '0.08' : dim ? '0.28' : '1',
      );
      el.style.pointerEvents = visible ? 'auto' : 'none';
    }
    for (let k = 0; k < built.edges.length; k++) {
      const el = lineRefs.current.get(k);
      if (!el) continue;
      const e = built.edges[k];
      const a = nodesById.get(e.a);
      const b = nodesById.get(e.b);
      if (!a || !b) continue;
      const eitherHidden = !isNodeVisible(a) || !isNodeVisible(b);
      const selTouches = selId && (e.a === selId || e.b === selId);
      const baseOpacity = Math.min(0.55, 0.18 + e.weight * 0.12);
      const finalOpacity = eitherHidden ? 0 : selId ? (selTouches ? 0.85 : 0.05) : baseOpacity;
      el.setAttribute('opacity', String(finalOpacity));
      el.setAttribute('stroke-width', selTouches ? '1.4' : '0.5');
    }
  }, [selectedId, hiddenDecks, query, simNodes, built.edges, nodesById, isNodeVisible, matchesQuery]);

  return (
    <div
      style={{
        flex: 1,
        display: isMobile ? 'block' : 'grid',
        gridTemplateColumns: isMobile ? undefined : 'minmax(0, 1fr) 280px',
        gridTemplateRows: isMobile ? undefined : '1fr',
        overflow: 'hidden',
        position: 'relative',
        minHeight: 0,
      }}
    >
      {/* Canvas — fills entire available height on all breakpoints. */}
      <div
        ref={canvasRef}
        style={{
          position: isMobile ? 'absolute' : 'relative',
          inset: isMobile ? 0 : undefined,
          background: 'var(--surface)',
          overflow: 'hidden',
          width: isMobile ? undefined : '100%',
          height: isMobile ? undefined : '100%',
          minHeight: 0,
        }}
      >
        {!edgeAvailabilityResolved && (
          <div
            aria-busy="true"
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 8,
              display: 'grid',
              placeItems: 'center',
              padding: 24,
              background: 'var(--surface)',
            }}
          >
            <div style={{ width: 'min(520px, 80%)', display: 'grid', gap: 14 }}>
              <NNSkeleton style={{ height: 12, width: '42%' }} />
              <NNSkeleton style={{ height: 260, borderRadius: '50%' }} />
            </div>
          </div>
        )}
        {/* Top-left search field */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            right: 12,
            zIndex: 5,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              minWidth: 180,
              flex: '1 1 180px',
              maxWidth: 320,
            }}
          >
            <NNIcon name="search" size={14} color="var(--text-muted)" />
            <TextInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('graph.toolbar.findPlaceholder')}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--text)',
                fontSize: 12,
                fontFamily: 'var(--font-sans)',
              }}
            />
            {query && (
              <Button variant="bare"
                onClick={() => setQuery('')}
                aria-label={t('graph.toolbar.clearFind')}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                }}
              >
                <NNIcon name="x" size={12} />
              </Button>
            )}
          </div>
          <div style={{ flex: 1 }} />
          {/* Edge-source segment control — hidden until semantic data exists. */}
          {semanticAvailable && (
            <div
              role="group"
              aria-label={t('graph.toolbar.edgesLabel')}
              style={{
                display: 'flex',
                gap: 2,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: 2,
              }}
            >
              {(['semantic', 'tags'] as const).map((src) => {
                const active = edgeSource === src;
                return (
                  <Button variant="bare"
                    key={src}
                    onClick={() => pickEdgeSource(src)}
                    aria-pressed={active}
                    style={{
                      border: 'none',
                      borderRadius: 8,
                      padding: '5px 10px',
                      fontSize: 11,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      background: active ? 'var(--surface-3)' : 'transparent',
                      color: active ? 'var(--text)' : 'var(--text-muted)',
                    }}
                  >
                    {t(src === 'semantic' ? 'graph.toolbar.edgesSemantic' : 'graph.toolbar.edgesTags')}
                  </Button>
                );
              })}
            </div>
          )}
          {!isMobile && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--text-dim)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: '6px 10px',
                letterSpacing: 0.2,
              }}
            >
              {t('graph.controls.dragHint')}
            </div>
          )}
        </div>

        {/* Collapsing this panel never changes the visible clusters. */}
        <div
          style={{
            position: 'absolute',
            bottom: isMobile && selectedNode ? 'calc(70% + 12px)' : 14,
            left: 14,
            zIndex: 5,
            padding: legendOpen ? '10px 12px' : '6px',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            minWidth: legendOpen && !isMobile ? 200 : 0,
            maxWidth: isMobile ? '70vw' : 220,
            transition: 'bottom 220ms ease',
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 2,
            }}
          >
            <Button variant="bare" type="button" className="reomi-graph-legend-toggle"
              aria-expanded={legendOpen} aria-controls="graph-cluster-list"
              aria-label={t(legendOpen ? 'graph.legend.collapse' : 'graph.legend.expand')}
              onClick={() => setLegendExpanded(!legendOpen)}>
              <NNIcon name="stack" size={15} />{t('graph.legend.title')}
              {hiddenDecks.size > 0 && <span className="mono">{legendDecks.length - hiddenDecks.size}/{legendDecks.length}</span>}
              <span style={{ display: 'flex', transform: legendOpen ? 'rotate(180deg)' : undefined }}><NNIcon name="chevd" size={14} /></span>
            </Button>
            {legendOpen && legendDecks.length > 1 && (
              <Button variant="bare"
                onClick={toggleAll}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  fontSize: 10.5,
                  cursor: 'pointer',
                  padding: 0,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                }}
              >
                {allHidden ? t('graph.toolbar.showAll') : t('graph.toolbar.hideAll')}
              </Button>
            )}
          </div>
          <div id="graph-cluster-list" className="reomi-graph-legend-list nn-scroll" hidden={!legendOpen}
            style={{ maxHeight: isMobile && selectedNode ? Math.max(44, H * .3 - 100) : undefined }}>
          {legendDecks.length === 0 && (
            <div className="nn-empty-state" style={{ paddingTop: 16, paddingBottom: 16 }}>
              <span className="nn-empty-state-icon"><NNIcon name="stack" size={20} color="var(--text-dim)" /></span>
              <p className="nn-empty-state-hint">{t('graph.legend.empty')}</p>
            </div>
          )}
          {legendDecks.map((d) => {
            const hidden = hiddenDecks.has(d.id);
            return (
              <Button variant="bare"
                key={d.id}
                onClick={() => toggleDeck(d.id)}
                aria-pressed={!hidden}
                title={hidden ? t('graph.legend.show') : t('graph.legend.hide')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12,
                  background: 'transparent',
                  border: 'none',
                  padding: '2px 0',
                  cursor: 'pointer',
                  color: hidden ? 'var(--text-dim)' : 'var(--text)',
                  opacity: hidden ? 0.5 : 1,
                  textAlign: 'left',
                }}
              >
                <span
                  style={{
                    width: 9,
                    height: 9,
                    borderRadius: '50%',
                    background: graphTone(d.color, 500),
                    flexShrink: 0,
                    boxShadow: hidden ? 'none' : `0 0 0 2px var(--${d.color}-500)33`,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    textDecoration: hidden ? 'line-through' : 'none',
                  }}
                >
                  {d.name}
                </span>
                <span
                  className="mono"
                  style={{ color: 'var(--text-dim)', fontSize: 11 }}
                >
                  {deckCounts.get(d.id) ?? 0}
                </span>
              </Button>
            );
          })}
          </div>
        </div>

        {/* Zoom / view controls */}
        <div
          style={{
            position: 'absolute',
            bottom: isMobile && selectedNode ? 'calc(70% + 12px)' : 14,
            right: 14,
            zIndex: 5,
            display: 'flex',
            flexDirection: 'column',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
            transition: 'bottom 220ms ease',
          }}
        >
          <NNBtn
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => zoomBy(1.4)}
            title={t('graph.controls.zoomIn')}
            style={{ borderRadius: 0, borderBottom: '1px solid var(--border)' }}
          />
          <Button variant="bare"
            onClick={resetZoom}
            data-tooltip={t('graph.controls.reset')}
            style={{
              padding: '6px 10px',
              textAlign: 'center',
              fontSize: 11,
              color: 'var(--text-muted)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {zoomPct}%
          </Button>
          <NNBtn
            size="sm"
            variant="ghost"
            onClick={() => zoomBy(1 / 1.4)}
            title={t('graph.controls.zoomOut')}
            style={{ borderRadius: 0, borderTop: '1px solid var(--border)' }}
          >
            −
          </NNBtn>
          <NNBtn
            size="sm"
            variant="ghost"
            icon="target"
            onClick={fitToView}
            title={t('graph.controls.fit')}
            style={{ borderRadius: 0, borderTop: '1px solid var(--border)' }}
          />
          <NNBtn
            size="sm"
            variant="ghost"
            icon="sparkle"
            onClick={reheat}
            title={t('graph.controls.reheat')}
            style={{ borderRadius: 0, borderTop: '1px solid var(--border)' }}
          />
        </div>

        {/* Graph SVG */}
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          style={{
            width: '100%',
            height: '100%',
            display: 'block',
            cursor: 'grab',
            touchAction: 'none',
            userSelect: 'none',
          }}
          onClick={(e) => {
            // Clicking empty canvas deselects; d3-zoom's drag sets defaultPrevented → we still skip in that case.
            if (e.defaultPrevented) return;
            const tgt = e.target as Element;
            if (tgt.closest('[data-node="1"]')) return;
            setSelectedId(null);
          }}
        >
          <defs>
            <radialGradient id="nn-graph-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="var(--chart-area-stop)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--chart-area-stop)" stopOpacity="0" />
            </radialGradient>
          </defs>

          <g ref={viewRef}>
            {/* Edges first so they render behind nodes */}
            {simLinks.map((e, k) => {
              const originalEdge = built.edges[k];
              if (!originalEdge) return null;
              const a = nodesById.get(originalEdge.a);
              const b = nodesById.get(originalEdge.b);
              if (!a || !b) return null;
              const sameDeck = a.deckId === b.deckId;
              return (
                <line
                  key={k}
                  ref={(el) => {
                    if (el) lineRefs.current.set(k, el);
                    else lineRefs.current.delete(k);
                  }}
                  stroke={sameDeck ? graphTone(a.color, 500) : 'var(--border-2)'}
                  strokeWidth={0.5}
                  opacity={0.3}
                  pointerEvents="none"
                />
              );
            })}

            {/* Nodes */}
            {simNodes.map((n) => {
              const isSel = selectedId === n.id;
              const fill = n.mastered
                ? graphTone(n.color, 500)
                : n.isNew
                  ? 'var(--surface-3)'
                  : graphTone(n.color, 600);
              const stroke = isSel
                ? 'var(--text)'
                : n.mastered
                  ? 'var(--lime-400)'
                  : n.isNew
                    ? 'var(--border-2)'
                    : graphTone(n.color, 500);
              return (
                <g
                  key={n.id}
                  data-node="1"
                  ref={(el) => {
                    if (el) nodeRefs.current.set(n.id, el);
                    else nodeRefs.current.delete(n.id);
                  }}
                  style={{ cursor: 'pointer' }}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (draggedDistRef.current > 4) return;
                    setSelectedId(n.id === selectedId ? null : n.id);
                  }}
                >
                  {n.mastered && <circle r={n.r + 12} fill="url(#nn-graph-glow)" />}
                  <circle r={n.r + 3} fill={graphTone(n.color, 500)} opacity={0.15} />
                  <circle
                    r={n.r}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSel ? 2 : n.isNew ? 0.8 : 0.6}
                    opacity={n.isNew ? 0.75 : 1}
                  />
                </g>
              );
            })}

            {/* Cluster labels */}
            {legendDecks.map((d) => (
              <g
                key={d.id}
                ref={(el) => {
                  if (el) labelRefs.current.set(d.id, el);
                  else labelRefs.current.delete(d.id);
                }}
                pointerEvents="none"
                opacity={hiddenDecks.has(d.id) ? 0.15 : 1}
              >
                <text
                  textAnchor="middle"
                  fontSize={isMobile ? 10 : 14}
                  fontFamily="var(--font-sans)"
                  fill={graphTone(d.color, 400)}
                  fontWeight={500}
                  letterSpacing={0}
                >
                  {d.name}
                </text>
              </g>
            ))}
          </g>
        </svg>
      </div>

      {/* Details panel — desktop: side column; mobile: bottom sheet above the canvas. */}
      {isMobile ? (
        <aside
          aria-hidden={!selectedNode}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            maxHeight: '70%',
            background: 'var(--surface)',
            borderTop: '1px solid var(--border)',
            borderTopLeftRadius: 16,
            borderTopRightRadius: 16,
            boxShadow: '0 -10px 40px var(--scrim)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            transform: selectedNode ? 'translateY(0)' : 'translateY(100%)',
            transition: 'transform 220ms ease',
            pointerEvents: selectedNode ? 'auto' : 'none',
            zIndex: 20,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '10px 0 4px',
              position: 'relative',
            }}
          >
            <div
              style={{
                width: 42,
                height: 4,
                borderRadius: 999,
                background: 'var(--border-2)',
              }}
            />
            <Button variant="bare"
              onClick={() => setSelectedId(null)}
              aria-label="Close"
              style={{
                position: 'absolute',
                top: 6,
                right: 10,
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                width: 28,
                height: 28,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                cursor: 'pointer',
                padding: 0,
              }}
            >
              <NNIcon name="x" size={14} />
            </Button>
          </div>
          <div style={{ overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
            {selectedNode && (
              <NodeDetail
                node={selectedNode}
                deckName={decks.find((d) => d.id === selectedNode.deckId)?.name ?? 'Deck'}
                linksCount={countLinks(built.edges, selectedNode.id)}
                linkedCards={selectedLinks}
                onOpenLink={(id) => setSelectedId(id)}
              />
            )}
          </div>
        </aside>
      ) : (
        <aside
          style={{
            borderLeft: '1px solid var(--border)',
            background: 'var(--surface)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'auto',
            maxWidth: '100%',
          }}
        >
          {selectedNode ? (
            <NodeDetail
              node={selectedNode}
              deckName={decks.find((d) => d.id === selectedNode.deckId)?.name ?? 'Deck'}
              linksCount={countLinks(built.edges, selectedNode.id)}
              linkedCards={selectedLinks}
              onOpenLink={(id) => setSelectedId(id)}
            />
          ) : (
            <EmptyDetail totalCards={cards.length} totalEdges={totalEdges} />
          )}
        </aside>
      )}
    </div>
  );
};

const EmptyDetail = ({ totalCards, totalEdges }: { totalCards: number; totalEdges: number }) => {
  const t = useT();
  return (
  <>
    <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>
        {t('graph.detail.selected')}
      </div>
      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 22, color: 'var(--text-muted)', letterSpacing: -0.5 }}>
        {t('graph.detail.nothing')}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 4 }}>
        {t('graph.detail.clickHint')}
      </div>
    </div>
    <div style={{ padding: 18 }}>
      <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>
        {t('graph.detail.graph')}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('graph.detail.nodes')}</div>
          <div style={{ fontSize: 16, color: 'var(--text)', fontWeight: 500 }} className="mono">{totalCards}</div>
        </div>
        <div style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
          <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('graph.detail.edges')}</div>
          <div style={{ fontSize: 16, color: 'var(--text)', fontWeight: 500 }} className="mono">{totalEdges}</div>
        </div>
      </div>
    </div>
  </>
  );
};

const NodeDetail = ({
  node,
  deckName,
  linksCount,
  linkedCards,
  onOpenLink,
}: {
  node: Pick<GraphNode, 'color' | 'mastered' | 'isNew' | 'card'>;
  deckName: string;
  linksCount: number;
  linkedCards: { id: string; front: string; shared: number; color: string; score?: number }[];
  onOpenLink?: (id: string) => void;
}) => {
  const t = useT();
  const card = node.card;
  const fsrs = card.fsrs;
  const reps = fsrs?.reps ?? 0;
  const lapses = fsrs?.lapses ?? 0;
  const stability = fsrs?.stability ?? 0;
  const mastery = cardMastery(card);
  const due = fsrs?.due ? humanInterval(fsrs) : '—';
  const tone = node.color as DeckColor;

  return (
    <>
      <div style={{ padding: '18px 20px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 4 }}>
          {t('graph.detail.selected')}
        </div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 26, color: 'var(--text)', letterSpacing: -0.5, lineHeight: 1.2 }}>
          {card.renderFrontText}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 6 }}>
          {card.renderBackText}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
          <NNBadge tone={tone} size="sm">{deckName}</NNBadge>
          {node.mastered && <NNBadge tone="lime" size="sm">{t('graph.detail.mastered', { pct: Math.round(mastery * 100) })}</NNBadge>}
          {node.isNew && <NNBadge tone="neutral" size="sm">{t('graph.detail.new')}</NNBadge>}
        </div>
        {card.tags.length > 0 && (
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {card.tags.slice(0, 6).map((t) => (
              <span
                key={t}
                className="mono"
                style={{
                  fontSize: 11,
                  color: 'var(--text-muted)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  padding: '2px 6px',
                  borderRadius: 6,
                }}
              >
                #{t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ padding: 18 }}>
        <div style={{ fontSize: 11, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>
          {t('graph.detail.stats')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[
            { l: t('graph.detail.reviews'), v: String(reps) },
            { l: t('graph.detail.lapses'), v: String(lapses) },
            { l: t('graph.detail.stability'), v: stability ? `${stability.toFixed(1)}d` : '—' },
            { l: t('graph.detail.due'), v: due },
          ].map((s) => (
            <div key={s.l} style={{ padding: '10px 12px', background: 'var(--surface-2)', borderRadius: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>{s.l}</div>
              <div style={{ fontSize: 16, color: 'var(--text)', fontWeight: 500 }} className="mono">{s.v}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: 18, borderTop: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <span className="nn-section-label" style={{ margin: 0 }}>
            {t('graph.detail.linkedCards', { n: linksCount })}
          </span>
          <NNBtn size="sm" variant="ghost" icon="plus"/>
        </div>
        {linkedCards.length === 0 && (
          <div className="nn-empty-state" style={{ paddingTop: 12, paddingBottom: 12 }}>
            <span className="nn-empty-state-icon"><NNIcon name="link" size={20} color="var(--text-dim)" /></span>
            <p className="nn-empty-state-hint">{t('graph.detail.noLinks')}</p>
          </div>
        )}
        {linkedCards.map((l, i) => (
          <Button variant="bare"
            key={l.id}
            onClick={() => onOpenLink?.(l.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
              borderTop: i ? '1px solid var(--border)' : 'none',
              background: 'transparent', border: 'none', width: '100%',
              cursor: 'pointer', textAlign: 'left',
            }}
          >
            <div style={{
              fontSize: 12.5, color: 'var(--text)', flex: 1,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {l.front}
            </div>
            <NNBadge size="xs" tone={l.color as DeckColor}>
              {l.score != null
                ? t('graph.detail.similarity', { pct: Math.round(l.score * 100) })
                : `${l.shared} ${l.shared === 1 ? t('graph.detail.tagSingular') : t('graph.detail.tagPlural')}`}
            </NNBadge>
          </Button>
        ))}
      </div>

      <div style={{ padding: 18, borderTop: '1px solid var(--border)', marginTop: 'auto' }}>
        <NNBtn block variant="soft" icon="sparkle">{t('graph.detail.askAi')}</NNBtn>
      </div>
    </>
  );
};
