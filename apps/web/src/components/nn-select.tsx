'use client';

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { createPortal } from 'react-dom';
import { NNIcon } from '@/components/ui';
import { useT } from '@/lib/i18n';

// ─────────────────────────────────────────────
// NNSelect — reusable searchable single-select dropdown
//
// A design-system replacement for the native <select>. The trigger mimics the
// standard input look; the popover is portaled into the nearest open dialog,
// otherwise document.body, and anchored under the trigger via
// getBoundingClientRect (flips above when there's no room below).
//
// Supports nested option indentation (decks) when NOT searching, and shows the
// full `searchText` (e.g. a deck path) while filtering so hierarchy context is
// preserved. Dismiss mirrors the card-form image-popover robustness: outside
// mousedown + scroll(capture) + resize + Esc.
// ─────────────────────────────────────────────

export interface NNSelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Nested indentation level — applied only when NOT searching (e.g. decks). */
  depth?: number;
  /** Text used for filtering + shown when searching (e.g. full deck path); falls back to label. */
  searchText?: string;
  disabled?: boolean;
  /** CSS color string — renders a chip swatch on the left. */
  swatch?: string;
}

interface NNSelectProps<T extends string> {
  value: T | '';
  onChange: (v: T) => void;
  options: NNSelectOption<T>[];
  /** Shown when no value is selected. */
  placeholder?: string;
  /** Default true; auto-irrelevant when fewer than 2 options. */
  searchable?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  /** Shown in the popover when options is empty (e.g. "no decks yet"). */
  emptyText?: string;
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling';
  ref?: React.Ref<HTMLButtonElement>;
}

// Show the sticky search box only once the list is long enough to warrant it.
const SEARCH_MIN_OPTIONS = 6;

export function NNSelect<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  searchable = true,
  disabled = false,
  ariaLabel,
  emptyText,
  id,
  className,
  style,
  'aria-describedby': describedBy,
  'aria-invalid': invalid,
  ref,
}: NNSelectProps<T>): React.JSX.Element {
  const t = useT();
  const reactId = useId();
  const listboxId = `nn-select-list-${reactId}`;
  const optionIdBase = `nn-select-opt-${reactId}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const [searchFocused, setSearchFocused] = useState(false);
  const [query, setQuery] = useState('');
  // Invariant: `highlight` indexes `filtered`; openMenu resets query so
  // filtered === options at open time.
  const [highlight, setHighlight] = useState(0);
  const [rect, setRect] = useState<{ left: number; top: number; width: number; flipUp: boolean } | null>(null);
  const [mounted, setMounted] = useState(false);
  const typeahead = useRef('');
  const typeaheadAt = useRef(0);

  useEffect(() => setMounted(true), []);

  const selected = useMemo(
    () => options.find((o) => o.value === value),
    [options, value],
  );

  const isSearching = query.trim().length > 0;
  const showSearch = searchable && options.length >= SEARCH_MIN_OPTIONS;

  const filtered = useMemo(() => {
    if (!isSearching) return options;
    const q = query.trim().toLowerCase();
    return options.filter((o) => (o.searchText ?? o.label).toLowerCase().includes(q));
  }, [options, query, isSearching]);

  // First non-disabled index in the filtered list (used for keyboard clamp/init).
  const firstEnabled = useCallback(
    (list: NNSelectOption<T>[]) => {
      const i = list.findIndex((o) => !o.disabled);
      return i === -1 ? 0 : i;
    },
    [],
  );
  const lastEnabled = useCallback((list: NNSelectOption<T>[]) => {
    for (let i = list.length - 1; i >= 0; i--) if (!list[i]?.disabled) return i;
    return 0;
  }, []);

  // Anchor the popover under the trigger; flip above when out of room.
  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const POPOVER_MAX = 320;
    const spaceBelow = window.innerHeight - r.bottom;
    const flipUp = spaceBelow < POPOVER_MAX + 8 && r.top > spaceBelow;
    const width = Math.max(r.width, 220);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    setRect({
      left,
      top: flipUp ? r.top : r.bottom + 4,
      width,
      flipUp,
    });
  }, []);

  const openMenu = useCallback((bias: 'selected' | 'first' | 'last' | 'previous' = 'selected') => {
    if (disabled) return;
    reposition();
    setQuery('');
    const selIdx = options.findIndex((o) => o.value === value);
    if (bias === 'first') setHighlight(firstEnabled(options));
    else if (bias === 'last') setHighlight(lastEnabled(options));
    else if (bias === 'previous') {
      const start = selIdx >= 0 ? selIdx : options.length;
      let next = lastEnabled(options);
      for (let i = start - 1; i >= 0; i--) if (!options[i]?.disabled) { next = i; break; }
      setHighlight(next);
    } else setHighlight(selIdx >= 0 ? selIdx : firstEnabled(options));
    setOpen(true);
  }, [disabled, reposition, options, value, firstEnabled, lastEnabled]);

  const closeMenu = useCallback(
    (returnFocus = true) => {
      setOpen(false);
      setQuery('');
      if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
    },
    [],
  );

  useTransientLayer({ root: popoverRef, enabled: open, portals: () => [triggerRef.current], onClose: reason => closeMenu(reason !== 'outside' && reason !== 'navigation'), restoreFocus: false });

  useLayoutEffect(() => {
    if (!open) return;
    let outsidePointer = false;
    const consume = (event: Event) => {
      if (event instanceof MouseEvent && event.button !== 0) return;
      const target = event.target;
      if (target instanceof Node && (popoverRef.current?.contains(target) || triggerRef.current?.contains(target))) return;
      if (event.type === 'pointerdown') outsidePointer = true;
      if (event.type === 'click') outsidePointer = false;
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('pointerdown', consume, true);
    document.addEventListener('click', consume, true);
    return () => {
      document.removeEventListener('pointerdown', consume, true);
      document.removeEventListener('click', consume, true);
      if (!outsidePointer) return;
      const once = (event: Event) => {
        if (event instanceof MouseEvent && event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        document.removeEventListener('click', once, true);
      };
      document.addEventListener('click', once, true);
    };
  }, [open]);

  const commit = useCallback(
    (opt: NNSelectOption<T> | undefined) => {
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      closeMenu();
    },
    [onChange, closeMenu],
  );

  // Re-anchor on open + on ancestor scroll/resize. We RE-ANCHOR (not close) so
  // the popover follows the trigger; scrolls that originate INSIDE the popover's
  // own option list are ignored (that's the list scrolling, not the page).
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const popover = popoverRef.current;
    if (!popover) return;
    if (typeof popover.showPopover !== 'function') {
      popover.removeAttribute('popover');
      return;
    }
    let opened = false;
    try { opened = popover.matches(':popover-open'); } catch { opened = false; }
    if (opened) return;
    try { popover.showPopover(); }
    catch { popover.removeAttribute('popover'); }
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      // Ignore the popover's own list scroll; only react to page/ancestor scroll.
      if (e.target instanceof Node && popoverRef.current?.contains(e.target)) return;
      reposition();
    };
    const onResize = () => reposition();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, closeMenu, reposition]);

  // Focus the search box (or the popover) on open.
  useEffect(() => {
    if (!open) return;
    if (showSearch) searchRef.current?.focus();
    else popoverRef.current?.focus();
  }, [open, showSearch]);

  // When the filter changes, clamp the highlight to a visible enabled row.
  useEffect(() => {
    if (!open) return;
    if (filtered.length === 0) {
      setHighlight(0);
      return;
    }
    setHighlight((h) => {
      const cur = filtered[h];
      if (cur && (!cur.disabled || cur.value === value)) return h;
      return firstEnabled(filtered);
    });
  }, [filtered, open, firstEnabled, value]);

  // Scroll the highlighted row into view.
  useEffect(() => {
    if (!open) return;
    const node = document.getElementById(`${optionIdBase}-${highlight}`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open, optionIdBase]);

  const moveHighlight = useCallback(
    (dir: 1 | -1) => {
      if (filtered.length === 0) return;
      setHighlight((h) => {
        let next = h;
        for (let i = 0; i < filtered.length; i++) {
          next += dir;
          if (next < 0) {
            next = 0;
            break;
          }
          if (next > filtered.length - 1) {
            next = filtered.length - 1;
            break;
          }
          if (!filtered[next]?.disabled) break;
        }
        // If we landed on a disabled row (clamp at an end), keep the old one.
        return filtered[next] && !filtered[next].disabled ? next : h;
      });
    },
    [filtered],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveHighlight(1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveHighlight(-1);
          break;
        case 'Home':
          e.preventDefault();
          setHighlight(firstEnabled(filtered));
          break;
        case 'End': {
          e.preventDefault();
          const last = [...filtered].reverse().findIndex((o) => !o.disabled);
          if (last !== -1) setHighlight(filtered.length - 1 - last);
          break;
        }
        case 'Enter':
        case ' ':
          if (e.key === ' ' && (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) break;
          e.preventDefault();
          commit(filtered[highlight]);
          break;
        case 'Escape':
          e.preventDefault();
          closeMenu();
          break;
        case 'Tab': {
          const dialog = triggerRef.current?.closest('dialog, [role="dialog"]');
          if (!dialog) {
            closeMenu(false);
            break;
          }
          e.preventDefault();
          const trigger = triggerRef.current;
          const popover = popoverRef.current;
          const tabbables = [...dialog.querySelectorAll<HTMLElement>('a[href],button,input,select,textarea,[tabindex]')]
            .filter((node) => !node.matches(':disabled') && node.tabIndex >= 0 && !popover?.contains(node));
          const index = trigger ? tabbables.indexOf(trigger) : -1;
          const next = e.shiftKey ? tabbables[index - 1] ?? tabbables.at(-1) : tabbables[index + 1] ?? tabbables[0];
          closeMenu(false);
          next?.focus({ preventScroll: true });
          break;
        }
        default: {
          if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) break;
          if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) break;
          e.preventDefault();
          const now = Date.now();
          const buffer = now - typeaheadAt.current < 500 ? `${typeahead.current}${e.key}` : e.key;
          typeahead.current = buffer;
          typeaheadAt.current = now;
          const queryText = buffer.toLowerCase();
          const start = buffer.length > 1 ? highlight : highlight + 1;
          for (let step = 0; step < filtered.length; step++) {
            const index = (start + step) % filtered.length;
            const opt = filtered[index];
            if (!opt || opt.disabled) continue;
            if ((opt.searchText ?? opt.label).toLowerCase().startsWith(queryText)) {
              setHighlight(index);
              break;
            }
          }
          break;
        }
      }
    },
    [moveHighlight, firstEnabled, filtered, commit, highlight, closeMenu],
  );

  // Trigger label: show the LEAF label (not the full searchText path) so deep
  // deck paths don't truncate badly; placeholder (muted) when nothing selected.
  const triggerLabel = selected ? selected.label : '';
  const visibleLabel = triggerLabel || placeholder || '';
  const accessibleName = ariaLabel && visibleLabel ? `${ariaLabel}, ${visibleLabel}` : ariaLabel;
  const menuParent = triggerRef.current?.closest('dialog, [role="dialog"]') ?? document.body;
  const activeId = filtered[highlight] ? `${optionIdBase}-${highlight}` : undefined;

  const popover =
    open && rect && mounted
      ? createPortal(
          <div
            ref={popoverRef}
            className="nn-scroll reomi-select-popover"
            popover="manual"
            tabIndex={-1}
            role={showSearch ? undefined : 'listbox'}
            id={showSearch ? undefined : listboxId}
            aria-label={showSearch ? undefined : ariaLabel}
            aria-activedescendant={showSearch ? undefined : activeId}
            onKeyDown={onKeyDown}
            style={{
              position: 'fixed',
              margin: 0,
              padding: 0,
              height: 'auto',
              left: rect.left,
              right: 'auto',
              top: rect.flipUp ? 'auto' : rect.top,
              bottom: rect.flipUp ? window.innerHeight - rect.top + 4 : 'auto',
              width: rect.width,
              maxHeight: 320,
              overflowY: 'auto',
              background: 'var(--surface)',
              border: '1px solid var(--panel-edge)',
              borderRadius: 14,
              boxShadow: 'var(--shadow-lg)',
              zIndex: 90,
              outline: 'none',
              fontFamily: 'var(--font-sans)',
              animation: 'nn-select-in 120ms ease',
              transformOrigin: rect.flipUp ? 'bottom' : 'top',
            }}
          >
            {showSearch && (
              <div
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  padding: 6,
                  background: 'var(--surface)',
                  borderBottom: '1px solid var(--panel-edge)',
                }}
              >
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <span style={{ position: 'absolute', left: 8, display: 'flex', pointerEvents: 'none' }}>
                    <NNIcon name="search" size={14} color="var(--text-dim)" />
                  </span>
                  <input
                    ref={searchRef}
                    className="reomi-select-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                    placeholder={t('selectSearch')}
                    aria-label={t('selectSearch')}
                    aria-controls={listboxId}
                    aria-activedescendant={activeId}
                    style={{
                      width: '100%',
                      padding: '8px 10px 8px 28px',
                      borderRadius: 'var(--r-sm)',
                      background: 'var(--surface-2)',
                      border: searchFocused ? '1px solid var(--accent-500)' : '1px solid var(--border)',
                      boxShadow: searchFocused ? '0 0 0 2px color-mix(in srgb, var(--accent-500) 10%, transparent)' : undefined,
                      color: 'var(--text)',
                      fontFamily: 'var(--font-sans)',
                      outline: 'none',
                      boxSizing: 'border-box',
                      caretColor: 'var(--accent-400)',
                    }}
                  />
                </div>
              </div>
            )}

            <div
              id={showSearch ? listboxId : undefined}
              role={showSearch ? 'listbox' : undefined}
              aria-label={showSearch ? ariaLabel : undefined}
              style={{ padding: 4, display: 'flex', flexDirection: 'column', gap: 2 }}
            >
              {options.length === 0 ? (
                <div style={{ padding: '12px 12px', fontSize: 13, color: 'var(--text-dim)', textAlign: 'center' }}>
                  {emptyText ?? t('noResults')}
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ padding: '12px 12px', fontSize: 13, color: 'var(--text-dim)', textAlign: 'center' }}>
                  {t('noResults')}
                </div>
              ) : (
                filtered.map((opt, i) => {
                  const isSel = opt.value === value;
                  const isHi = i === highlight;
                  const depthPad = !isSearching && opt.depth ? opt.depth * 20 : 0;
                  return (
                    <div
                      key={opt.value}
                      id={`${optionIdBase}-${i}`}
                      role="option"
                      aria-selected={isSel}
                      aria-disabled={opt.disabled || undefined}
                      onMouseEnter={() => !opt.disabled && setHighlight(i)}
                      onMouseDown={(e) => {
                        // Prevent the search input from losing focus before commit.
                        e.preventDefault();
                      }}
                      onClick={() => commit(opt)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        minHeight: 38,
                        padding: '8px 10px',
                        paddingLeft: 12 + depthPad,
                        borderRadius: 'var(--r-sm)',
                        background: isSel ? 'color-mix(in srgb, var(--accent-500) 10%, transparent)' : isHi ? 'var(--surface-2)' : 'transparent',
                        color: opt.disabled ? 'var(--text-dim)' : isSel ? 'var(--accent-500)' : 'var(--text)',
                        fontSize: 13.5,
                        fontWeight: isSel ? 600 : 400,
                        cursor: opt.disabled ? 'not-allowed' : 'pointer',
                        opacity: opt.disabled ? 0.55 : 1,
                        boxSizing: 'border-box',
                      }}
                    >
                      {opt.swatch !== undefined && (
                        <span
                          aria-hidden
                          style={{
                            width: 18,
                            height: 18,
                            borderRadius: '50%',
                            background: opt.swatch,
                            border: '1px solid var(--border-2)',
                            flexShrink: 0,
                          }}
                        />
                      )}
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {isSearching ? (opt.searchText ?? opt.label) : opt.label}
                      </span>
                      {isSel && (
                        <span style={{ display: 'flex', flexShrink: 0 }}>
                          <NNIcon name="check" size={15} color="var(--accent-400)" />
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>,
          menuParent,
        )
      : null;

  return (
    <>
      <button
        ref={(node) => {
          triggerRef.current = node;
          if (typeof ref === 'function') ref(node);
          else if (ref) ref.current = node;
        }}
        type="button"
        id={id}
        className={['reomi-select', className].filter(Boolean).join(' ')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={accessibleName}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        aria-controls={open ? listboxId : undefined}
        onClick={() => (open ? closeMenu() : openMenu())}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          // On open, focus moves to the search box / popover which handles keys,
          // so the trigger only needs the openers here.
          if (open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openMenu(e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : e.key === 'ArrowUp' ? 'previous' : 'selected');
          }
        }}
        style={{
          ...style,
          ...(open ? { border: '1px solid var(--accent-500)', boxShadow: 'var(--glow-accent)' } : {}),
          ...(!open && focused ? { boxShadow: 'var(--glow-violet)' } : {}),
          ...(disabled ? { opacity: 0.6, cursor: 'not-allowed' } : {}),
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: selected ? 'var(--text)' : 'var(--text-dim)',
          }}
        >
          {triggerLabel || placeholder || ''}
        </span>
        <span
          style={{
            display: 'inline-flex',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 140ms ease',
          }}
        >
          <NNIcon name="chevd" size={16} color="var(--text-dim)" />
        </span>
      </button>
      {popover}
    </>
  );
}
