'use client';

import React, { CSSProperties, ReactNode } from 'react';
import { Button, Surface, type ButtonProps } from './design-system/primitives';

// ─────────────────────────────────────────────
// Icon — minimal line-style, Lucide-ish
// ─────────────────────────────────────────────
export type IconName =
  | 'home' | 'brain' | 'graph' | 'garden' | 'stack' | 'plus' | 'search'
  | 'flame' | 'bolt' | 'settings' | 'check' | 'x' | 'chevr' | 'chevl'
  | 'chevd' | 'tag' | 'clock' | 'sparkle' | 'play' | 'pause' | 'eye'
  | 'edit' | 'link' | 'sync' | 'arrow' | 'trophy' | 'target' | 'mic'
  | 'image' | 'dots' | 'filter' | 'grid' | 'stars' | 'bulb' | 'pin'
  | 'clip' | 'doc' | 'book' | 'send' | 'note' | 'copy' | 'warning'
  | 'archive' | 'card-type' | 'info' | 'code' | 'globe' | 'star'
  | 'chat' | 'review' | 'decks' | 'cards' | 'library' | 'notebook' | 'chart'
  | 'panel' | 'menu' | 'logout' | 'stop' | 'expand' | 'folder' | 'folder-move' | 'trash';

export const NNIcon = ({
  name,
  size = 16,
  color = 'currentColor',
  strokeWidth = 1.6,
}: {
  name: IconName | (string & {});
  size?: number;
  color?: string;
  strokeWidth?: number;
}) => {
  const p = {
    stroke: color,
    strokeWidth,
    fill: 'none',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  const paths: Partial<Record<string, ReactNode>> = {
    'folder-move': <><path d="M20 11V8a2 2 0 0 0-2-2h-6l-2-3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h6M13 16h8m-3-3 3 3-3 3" {...p}/></>,
    trash: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" {...p}/>,
    folder: <path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" {...p}/>,
    math: <path d="M5 6h14M5 12h14M5 18h14M8 3v6M16 15v6" {...p}/>,
    flask: <path d="M9 3h6M10 3v6L4 19a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2L14 9V3M7 15h10" {...p}/>,
    atom: <path d="M3 12a9 4 0 1 0 18 0 9 4 0 1 0-18 0M7 4c-5 3 5 20 10 16S12 1 7 4M17 4c5 3-5 20-10 16S12 1 17 4M12 12h.01" {...p}/>,
    dna: <path d="M6 3c0 9 12 9 12 18M18 3C18 12 6 12 6 21M7 5h10M9 9h6M9 15h6M7 19h10" {...p}/>,
    laptop: <path d="M5 4h14v12H5zM2 20h20l-3-4H5z" {...p}/>,
    cpu: <path d="M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4" {...p}/>,
    database: <path d="M4 6c0-4 16-4 16 0s-16 4-16 0v12c0 4 16 4 16 0V6M4 12c0 4 16 4 16 0" {...p}/>,
    terminal: <path d="M3 4h18v16H3zM6 8l4 4-4 4M13 16h5" {...p}/>,
    cloud: <path d="M7 18a5 5 0 1 1 0-10 6 6 0 0 1 12 1 4.5 4.5 0 0 1-1 9z" {...p}/>,
    shield: <path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6" {...p}/>,
    key: <path d="M10 14a6 6 0 1 1 4-4l7 7v4h-4v-3h-3zM7 7h.01" {...p}/>,
    briefcase: <path d="M3 7h18v14H3zM8 7V3h8v4M3 12l9 3 9-3M12 12v5" {...p}/>,
    scales: <path d="M12 3v18M6 21h12M4 7h16M6 7l-4 8h8zM18 7l-4 8h8z" {...p}/>,
    heart: <path d="M12 21 3 12C-2 5 7-1 12 6c5-7 14-1 9 6z" {...p}/>,
    music: <path d="M9 18V5l12-2v13M9 5v4l12-2M9 18c0 4-7 4-7 0s7-4 7 0M21 16c0 4-7 4-7 0s7-4 7 0" {...p}/>,
    camera: <path d="M3 7h4l2-3h6l2 3h4v14H3zM8 14a4 4 0 1 0 8 0 4 4 0 1 0-8 0" {...p}/>,
    compass: <path d="M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0M16 8l-3 5-5 3 3-5z" {...p}/>,
    map: <path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3zM9 3v15M15 6v15" {...p}/>,
    rocket: <path d="M8 16c-2-8 5-13 13-13 0 8-5 15-13 13zM8 8H4l-2 7 6 1M16 16v4l-7 2-1-6M5 19l-2 2M13 8a2 2 0 1 0 4 0 2 2 0 1 0-4 0" {...p}/>,
    puzzle: <path d="M3 3h6a3 3 0 1 1 6 0h6v6a3 3 0 1 0 0 6v6h-6a3 3 0 1 0-6 0H3v-6a3 3 0 1 1 0-6z" {...p}/>,
    coffee: <path d="M4 7h12v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM16 8h3a3 3 0 0 1 0 6h-3M7 2v2M12 2v2M2 23h18" {...p}/>,
    dumbbell: <path d="M3 8h4v8H3zM17 8h4v8h-4zM7 11h10v2H7M1 10v4M23 10v4" {...p}/>,
    code: <path d="m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18" {...p}/>,
    globe: <><circle cx="12" cy="12" r="9" {...p}/><ellipse cx="12" cy="12" rx="4" ry="9" {...p}/><path d="M3 12h18" {...p}/></>,
    star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z" {...p}/>,
    chat: <path d="M7 4h10a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-6l-5 3v-3a3 3 0 0 1-3-3V8a4 4 0 0 1 4-4ZM8 9h8M8 13h5" {...p} />,
    review: <path d="M4 10a8 8 0 1 1 1.4 6.7M4 4v6h6M12 7v5l3 2" {...p} />,
    decks: <><rect x="4" y="9" width="16" height="12" rx="2.5" {...p} /><path d="M6 6h12M8 3h8" {...p} /></>,
    cards: <><path d="m8 4 9-1a2 2 0 0 1 2.2 1.8L21 16" {...p} /><rect x="3" y="7" width="14" height="14" rx="2.5" {...p} /><path d="M7 12h6M7 16h4" {...p} /></>,
    library: <><rect x="3" y="4" width="4" height="16" rx="1" {...p} /><path d="M10 4v16M3 8h4M3 16h4M14 5l4-1 4 15-4 1z" {...p} /></>,
    notebook: <><rect x="5" y="3" width="15" height="18" rx="2.5" {...p} /><path d="M9 3v18M3 7h4M3 12h4M3 17h4M12 8h5M12 12h3" {...p} /></>,
    chart: <path d="M4 3v15a2 2 0 0 0 2 2h15M9 15v-4M14 15V7M19 15V4" {...p} />,
    panel: <><rect x="3" y="4" width="18" height="16" rx="3" {...p} /><path d="M9 4v16M6 8v3" {...p} /></>,
    menu: <path d="M4 6h16M4 12h16M4 18h10" {...p} />,
    logout: <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M10 12h11M17 8l4 4-4 4" {...p} />,
    home: <path d="M3 10l9-7 9 7v10a1 1 0 01-1 1h-4v-7H8v7H4a1 1 0 01-1-1V10z" {...p} />,
    brain: (
      <path
        d="M9.5 3a2.5 2.5 0 00-2.5 2.5A2.5 2.5 0 004 8v2a2 2 0 001 1.7A2.5 2.5 0 005 15a2.5 2.5 0 002 2.5V19a2 2 0 002 2h1V3H9.5zM14.5 3a2.5 2.5 0 012.5 2.5A2.5 2.5 0 0120 8v2a2 2 0 01-1 1.7A2.5 2.5 0 0119 15a2.5 2.5 0 01-2 2.5V19a2 2 0 01-2 2h-1V3h.5z"
        {...p}
      />
    ),
    graph: (
      <>
        <circle cx="6" cy="6" r="2.2" {...p} />
        <circle cx="18" cy="6" r="2.2" {...p} />
        <circle cx="12" cy="18" r="2.2" {...p} />
        <circle cx="6" cy="14" r="1.8" {...p} />
        <path d="M8 7l8 3M8 14l2 3M16 8l-3 9" {...p} />
      </>
    ),
    garden: (
      <path
        d="M12 21v-6M12 15c0-3-3-5-6-5 0 3 2 5 6 5zM12 15c0-3 3-5 6-5 0 3-2 5-6 5zM12 10c0-3 1-5 3-5-0 3-1 5-3 5zM12 10c0-3-1-5-3-5 0 3 1 5 3 5zM6 21h12"
        {...p}
      />
    ),
    archive: <><path d="M4 8h16v12H4zM3 4h18v4H3zM10 12h4" {...p} /></>,
    'card-type': <><rect x="3" y="6" width="14" height="15" rx="2" {...p} /><path d="M7 3h12a2 2 0 0 1 2 2v12M6 10h8M6 14h5M6 18h3" {...p} /></>,
    info: <><circle cx="12" cy="12" r="9" {...p} /><path d="M12 11v6M12 7h.01" {...p} /></>,
    stack: <path d="M4 7l8-4 8 4-8 4-8-4zM4 12l8 4 8-4M4 17l8 4 8-4" {...p} />,
    plus: <path d="M12 5v14M5 12h14" {...p} />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6" {...p} />
        <path d="M20 20l-5-5" {...p} />
      </>
    ),
    flame: <path d="M12 22c4 0 7-3 7-7 0-3-2-5-3-7-1 2-3 2-3-1 0-2 1-4 1-4-6 2-8 7-8 11 0 5 3 8 6 8z" {...p} />,
    bolt: <path d="M13 2L4 14h6l-2 8 9-12h-6l2-8z" {...p} />,
    settings: (
      <>
        <circle cx="12" cy="12" r="3" {...p} />
        <path
          d="m9.5 3-.6 2.4-1.4.8-2.4-.7-2.5 4.3 1.8 1.7v1l-1.8 1.7 2.5 4.3 2.4-.7 1.4.8.6 2.4h5l.6-2.4 1.4-.8 2.4.7 2.5-4.3-1.8-1.7v-1l1.8-1.7-2.5-4.3-2.4.7-1.4-.8-.6-2.4z"
          {...p}
        />
      </>
    ),
    check: <path d="M4 12l5 5L20 6" {...p} />,
    x: <path d="M6 6l12 12M18 6L6 18" {...p} />,
    chevr: <path d="M9 6l6 6-6 6" {...p} />,
    chevl: <path d="M15 6l-6 6 6 6" {...p} />,
    chevd: <path d="M6 9l6 6 6-6" {...p} />,
    tag: (
      <>
        <path d="M3 12V4h8l10 10-8 8L3 12z" {...p} />
        <circle cx="7.5" cy="7.5" r="1.2" fill={color} />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="9" {...p} />
        <path d="M12 7v5l3 2" {...p} />
      </>
    ),
    sparkle: <path d="M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6zM19 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" {...p} />,
    play: <path d="M7 4v16l13-8L7 4z" stroke={color} strokeWidth={strokeWidth} fill={color} />,
    pause: <path d="M7 4h3v16H7zM14 4h3v16h-3z" stroke={color} strokeWidth={strokeWidth} fill={color} />,
    eye: (
      <>
        <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" {...p} />
        <circle cx="12" cy="12" r="3" {...p} />
      </>
    ),
    edit: <path d="M4 20h4l10-10-4-4L4 16v4zM14 6l4 4" {...p} />,
    link: <path d="M9 15l6-6M8 8l-3 3a4 4 0 005 6l3-3M16 16l3-3a4 4 0 00-5-6l-3 3" {...p} />,
    sync: <path d="M21 12a9 9 0 11-3-6.7M21 4v5h-5" {...p} />,
    arrow: <path d="M5 12h14M13 6l6 6-6 6" {...p} />,
    trophy: <path d="M7 4h10v4a5 5 0 01-10 0V4zM7 6H4v2a3 3 0 003 3M17 6h3v2a3 3 0 01-3 3M9 20h6M12 14v6" {...p} />,
    target: (
      <>
        <circle cx="12" cy="12" r="9" {...p} />
        <circle cx="12" cy="12" r="5" {...p} />
        <circle cx="12" cy="12" r="1.5" fill={color} stroke="none" />
      </>
    ),
    mic: (
      <>
        <rect x="9" y="3" width="6" height="12" rx="3" {...p} />
        <path d="M5 11a7 7 0 0014 0M12 18v3" {...p} />
      </>
    ),
    image: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" {...p} />
        <circle cx="8.5" cy="9" r="1.5" {...p} />
        <path d="M3 17l5-5 5 5 3-3 5 5" {...p} />
      </>
    ),
    dots: (
      <>
        <circle cx="5" cy="12" r="1.5" fill={color} stroke="none" />
        <circle cx="12" cy="12" r="1.5" fill={color} stroke="none" />
        <circle cx="19" cy="12" r="1.5" fill={color} stroke="none" />
      </>
    ),
    filter: <path d="M3 5h18l-7 9v5l-4 2v-7L3 5z" {...p} />,
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" {...p} />
        <rect x="14" y="3" width="7" height="7" rx="1" {...p} />
        <rect x="3" y="14" width="7" height="7" rx="1" {...p} />
        <rect x="14" y="14" width="7" height="7" rx="1" {...p} />
      </>
    ),
    stars: <path d="M12 3l1.5 5 5 1.5-5 1.5L12 16l-1.5-5L5.5 9.5l5-1.5L12 3z" {...p} />,
    bulb: <path d="M9 18h6M10 21h4M12 3a6 6 0 00-3.5 11c.5.5 1 1 1 2h5c0-1 .5-1.5 1-2A6 6 0 0012 3z" {...p} />,
    pin: <path d="M12 21v-6M8 4h8l-1 6 2.5 3h-11L9 10 8 4z" {...p} />,
    clip: <path d="M20 11.5l-7.8 7.8a5 5 0 01-7-7l8.5-8.5a3.3 3.3 0 014.7 4.7l-8.5 8.5a1.7 1.7 0 01-2.4-2.4l7.8-7.8" {...p} />,
    doc: <path d="M14 3H7a1.5 1.5 0 00-1.5 1.5v15A1.5 1.5 0 007 21h10a1.5 1.5 0 001.5-1.5V7.5L14 3zM14 3v4.5h4.5M9.5 12.5h5M9.5 16h5" {...p} />,
    book: <path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2V5zM19 17H6a2 2 0 00-2 2M9 3v14" {...p} />,
    // Send — upward arrow (composer submit, NBIcon parity).
    send: <path d="M12 19V5M6 11l6-6 6 6" {...p} />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />,
    expand: <><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5" {...p}/><path d="M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6" {...p}/></>,
    // Note — page with a folded corner (save-to-notes action).
    note: (
      <>
        <path d="M5 4h14v12l-4 4H5V4z" {...p} />
        <path d="M15 20v-4h4" {...p} />
      </>
    ),
    // Copy — overlapping sheets.
    copy: (
      <>
        <rect x="9" y="9" width="11" height="11" rx="2" {...p} />
        <path d="M5 15V6a2 2 0 012-2h9" {...p} />
      </>
    ),
    warning: (
      <>
        <path d="M12 3L2.8 20h18.4L12 3z" {...p} />
        <path d="M12 9v5M12 17.5h.01" {...p} />
      </>
    ),
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', flexShrink: 0 }}>
      {paths[name] ?? null}
    </svg>
  );
};

// ─────────────────────────────────────────────
// Button
// ─────────────────────────────────────────────
export type BtnVariant = 'primary' | 'violet' | 'amber' | 'ghost' | 'soft' | 'outline' | 'danger';
export type BtnSize = 'sm' | 'md' | 'lg' | 'xl';

export const NNBtn = ({
  icon, iconRight, ariaLabel, ...props
}: ButtonProps & {
  icon?: IconName | (string & {});
  iconRight?: IconName | (string & {});
  ariaLabel?: string;
}) => (
  <Button
    {...props}
    aria-label={ariaLabel ?? props['aria-label'] ?? props.title}
    leading={icon ? <NNIcon name={icon} size={16} /> : props.leading}
    trailing={iconRight ? <NNIcon name={iconRight} size={16} /> : props.trailing}
  />
);

// ─────────────────────────────────────────────
// Badge / Chip
// ─────────────────────────────────────────────
export type BadgeTone = 'neutral' | 'lime' | 'amber' | 'violet' | 'sky' | 'rose' | 'solid';
export type BadgeSize = 'xs' | 'sm' | 'md' | 'lg';

export const NNBadge = ({
  children,
  tone = 'neutral',
  icon,
  size = 'md',
  style,
}: {
  children?: ReactNode;
  tone?: BadgeTone | (string & {});
  icon?: IconName | (string & {});
  size?: BadgeSize;
  style?: CSSProperties;
}) => {
  const tones: Record<string, { bg: string; color: string; border: string }> = {
    neutral: { bg: 'var(--surface-3)', color: 'var(--text-muted)', border: 'var(--border)' },
    lime: { bg: 'var(--tone-lime-bg)', color: 'var(--lime-400)', border: 'var(--tone-lime-border)' },
    amber: { bg: 'var(--tone-amber-bg)', color: 'var(--amber-400)', border: 'var(--tone-amber-border)' },
    violet: { bg: 'var(--tone-violet-bg)', color: 'var(--violet-400)', border: 'var(--tone-violet-border)' },
    sky: { bg: 'var(--tone-sky-bg)', color: 'var(--sky-400)', border: 'var(--tone-sky-border)' },
    rose: { bg: 'var(--tone-rose-bg)', color: 'var(--rose-400)', border: 'var(--tone-rose-border)' },
    solid: { bg: 'var(--accent-500)', color: 'var(--text-on-accent)', border: 'var(--accent-500)' },
  };
  const sizes: Record<BadgeSize, { h: number; px: number; fs: number; gap: number }> = {
    xs: { h: 18, px: 6, fs: 10.5, gap: 3 },
    sm: { h: 22, px: 8, fs: 11, gap: 4 },
    md: { h: 26, px: 10, fs: 12, gap: 5 },
    lg: { h: 30, px: 12, fs: 13, gap: 6 },
  };
  const t = tones[tone] ?? tones.neutral;
  const s = sizes[size];
  return (
    <span
      style={{
        height: s.h,
        padding: `0 ${s.px}px`,
        fontSize: s.fs,
        gap: s.gap,
        background: t.bg,
        color: t.color,
        border: `1px solid ${t.border}`,
        borderRadius: 'var(--r-pill)',
        display: 'inline-flex',
        alignItems: 'center',
        fontWeight: 500,
        letterSpacing: -0.1,
        whiteSpace: 'nowrap',
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      {icon && <NNIcon name={icon} size={s.fs + 2} />}
      {children}
    </span>
  );
};

// ─────────────────────────────────────────────
// Tag — used for deck/topic tags with # prefix
// ─────────────────────────────────────────────
export type TagColor = 'sky' | 'lime' | 'violet' | 'amber' | 'rose' | 'neutral';

export const NNTag = ({ children, color = 'sky' }: { children: ReactNode; color?: TagColor | (string & {}) }) => {
  const colors: Record<string, string> = {
    sky: 'var(--sky-400)',
    lime: 'var(--lime-400)',
    violet: 'var(--violet-400)',
    amber: 'var(--amber-400)',
    rose: 'var(--rose-400)',
    neutral: 'var(--text-muted)',
  };
  return (
    <span className="mono" style={{ color: colors[color], fontSize: 11.5, fontWeight: 500, letterSpacing: 0.1 }}>
      #{children}
    </span>
  );
};

// ─────────────────────────────────────────────
// Card
// ─────────────────────────────────────────────
export const NNCard = Surface;

// ─────────────────────────────────────────────
// Kbd — keyboard shortcut display
// ─────────────────────────────────────────────
export const NNKbd = ({ children }: { children: ReactNode }) => (
  <span
    className="mono"
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: 20,
      minWidth: 20,
      padding: '0 5px',
      border: '1px solid var(--border-2)',
      borderBottomWidth: 2,
      borderRadius: 4,
      background: 'var(--surface-2)',
      color: 'var(--text-muted)',
      fontSize: 10.5,
      fontWeight: 500,
    }}
  >
    {children}
  </span>
);

// ─────────────────────────────────────────────
// Logo
// ─────────────────────────────────────────────
// Keep the existing component API so every screen shares the Reomi identity.
export const NNLogo = ({ size = 25, showText = true }: { size?: number; showText?: boolean }) => (
  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
    <span
      className="reomi-brand-mark"
      role={showText ? undefined : 'img'}
      aria-label={showText ? undefined : 'Reomi'}
      aria-hidden={showText || undefined}
      style={{ width: size, height: size }}
    />
    {showText && (
      <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 18, letterSpacing: -0.45, color: 'var(--text)' }}>
        reomi
      </span>
    )}
  </div>
);

// ─────────────────────────────────────────────
// Plant — stylized plant SVG for garden/streak
// Supports 6 species, each with distinct shape + colour.
// ─────────────────────────────────────────────
type PlantSpeciesLocal = 'fern' | 'cactus' | 'succulent' | 'bonsai' | 'sakura' | 'mushroom';

export const NNPlant = ({
  stage = 3,
  size = 80,
  species = 'fern',
}: {
  stage?: number;
  size?: number;
  species?: PlantSpeciesLocal;
}) => {
  const grow = stage / 5;
  const top = 72 - 44 * grow; // y-coordinate of the plant top at full grow
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      {/* shadow */}
      <ellipse cx="50" cy="85" rx="22" ry="4" fill="var(--plant-shadow)" />
      {/* pot */}
      <path d="M32 72 L35 85 L65 85 L68 72 Z" fill="var(--plant-pot)" stroke="var(--plant-pot-dark)" strokeWidth="0.8" />
      <ellipse cx="50" cy="72" rx="18" ry="3" fill="var(--plant-pot-dark)" />
      <ellipse cx="50" cy="72" rx="16" ry="2.5" fill="color-mix(in srgb, var(--plant-pot-dark) 70%, var(--bg))" />

      {stage > 0 && (
        <g opacity={Math.min(1, grow * 1.5)}>

          {/* ── FERN — arching fronds, bright green ── */}
          {species === 'fern' && (
            <>
              <path d={`M50 72 Q48 ${72 - 25 * grow} 44 ${72 - 40 * grow}`} stroke="var(--plant-green-2)" strokeWidth={2} fill="none" strokeLinecap="round" />
              <path d={`M50 72 Q52 ${72 - 22 * grow} 56 ${72 - 38 * grow}`} stroke="var(--plant-green-3)" strokeWidth={2} fill="none" strokeLinecap="round" />
              <path d={`M50 72 Q50 ${72 - 30 * grow} 50 ${72 - 45 * grow}`} stroke="var(--plant-green-1)" strokeWidth={2.2} fill="none" strokeLinecap="round" />
              {stage > 2 && (
                <>
                  <ellipse cx="44" cy={72 - 38 * grow} rx="4" ry="2.5" fill="var(--plant-green-3)" transform={`rotate(-40 44 ${72 - 38 * grow})`} />
                  <ellipse cx="56" cy={72 - 36 * grow} rx="4" ry="2.5" fill="var(--plant-green-4)" transform={`rotate(40 56 ${72 - 36 * grow})`} />
                  <ellipse cx="50" cy={72 - 45 * grow} rx="3" ry="2" fill="var(--plant-green-2)" />
                </>
              )}
              {stage >= 4 && <circle cx="50" cy={72 - 48 * grow} r="3" fill="var(--amber-500)" />}
              {stage >= 5 && (
                <>
                  <circle cx="44" cy={72 - 40 * grow} r="2" fill="var(--amber-400)" />
                  <circle cx="56" cy={72 - 38 * grow} r="2" fill="var(--amber-400)" />
                </>
              )}
            </>
          )}

          {/* ── CACTUS — vertical segments, spines, muted green ── */}
          {species === 'cactus' && (() => {
            const h = 42 * grow;
            const segH = h / 3;
            const x = 50;
            const base = 72;
            return (
              <>
                {/* main trunk segments */}
                <rect x={x - 5} y={base - h} width={10} height={h} rx={3} fill="var(--plant-green-1)" />
                {stage > 1 && <rect x={x - 4} y={base - h * 0.9} width={8} height={segH * 0.9} rx={2} fill="var(--plant-green-2)" />}
                {/* arm left */}
                {stage > 2 && (
                  <>
                    <rect x={x - 14} y={base - h * 0.6} width={8} height={segH} rx={3} fill="var(--plant-green-1)" />
                    <rect x={x - 12} y={base - h * 0.6 - segH * 0.4} width={6} height={segH * 0.6} rx={2} fill="var(--plant-green-2)" />
                  </>
                )}
                {/* arm right */}
                {stage > 3 && (
                  <>
                    <rect x={x + 6} y={base - h * 0.55} width={8} height={segH * 0.9} rx={3} fill="var(--plant-green-1)" />
                    <rect x={x + 8} y={base - h * 0.55 - segH * 0.35} width={6} height={segH * 0.55} rx={2} fill="var(--plant-green-2)" />
                  </>
                )}
                {/* spines */}
                {stage > 1 && [42, 50, 58].map((lx) => (
                  <React.Fragment key={lx}>
                    <line x1={lx} y1={base - h * 0.5} x2={lx - 3} y2={base - h * 0.5 - 3} stroke="var(--plant-green-4)" strokeWidth={0.8} />
                    <line x1={lx} y1={base - h * 0.5} x2={lx + 3} y2={base - h * 0.5 - 3} stroke="var(--plant-green-4)" strokeWidth={0.8} />
                  </React.Fragment>
                ))}
                {/* bloom on top */}
                {stage >= 5 && <circle cx={x} cy={base - h - 4} r={4} fill="var(--plant-flower)" />}
              </>
            );
          })()}

          {/* ── SUCCULENT — rosette of fleshy leaves, blue-green ── */}
          {species === 'succulent' && (() => {
            const cx = 50, cy = top + 10;
            const r = 14 * grow;
            const leafAngles = [0, 60, 120, 180, 240, 300];
            return (
              <>
                {/* stem */}
                <line x1={cx} y1={72} x2={cx} y2={cy + r * 0.3} stroke="var(--plant-water-1)" strokeWidth={2.5} strokeLinecap="round" />
                {/* outer leaves */}
                {leafAngles.map((angle) => {
                  const rad = (angle * Math.PI) / 180;
                  const lx = cx + Math.cos(rad) * r;
                  const ly = cy + Math.sin(rad) * r * 0.7;
                  return (
                    <ellipse
                      key={angle}
                      cx={lx}
                      cy={ly}
                      rx={r * 0.35}
                      ry={r * 0.55}
                      fill="var(--plant-water-2)"
                      transform={`rotate(${angle} ${lx} ${ly})`}
                      opacity={0.85}
                    />
                  );
                })}
                {/* inner leaves */}
                {stage > 2 && leafAngles.filter((_, i) => i % 2 === 0).map((angle) => {
                  const rad = (angle * Math.PI) / 180;
                  const ir = r * 0.55;
                  const lx = cx + Math.cos(rad) * ir;
                  const ly = cy + Math.sin(rad) * ir * 0.7;
                  return (
                    <ellipse key={`i${angle}`} cx={lx} cy={ly} rx={r * 0.25} ry={r * 0.38} fill="var(--plant-water-3)" transform={`rotate(${angle} ${lx} ${ly})`} />
                  );
                })}
                {/* center */}
                <circle cx={cx} cy={cy} r={r * 0.22} fill="color-mix(in srgb, var(--plant-water-3) 70%, var(--surface))" />
                {stage >= 5 && <circle cx={cx} cy={cy} r={r * 0.1} fill="var(--text-on-violet)" />}
              </>
            );
          })()}

          {/* ── BONSAI — wide spreading crown, dark trunk, earthy tones ── */}
          {species === 'bonsai' && (() => {
            const trunkH = 30 * grow;
            const crownCy = 72 - trunkH;
            const crownR = 20 * grow;
            return (
              <>
                {/* trunk */}
                <path
                  d={`M48 72 Q46 ${72 - trunkH * 0.5} 50 ${crownCy + 4}`}
                  stroke="var(--plant-pot)"
                  strokeWidth={4}
                  fill="none"
                  strokeLinecap="round"
                />
                {/* branch left */}
                {stage > 1 && (
                  <path d={`M50 ${crownCy + 4} Q42 ${crownCy - 4} 38 ${crownCy - 8}`} stroke="var(--plant-pot)" strokeWidth={2.5} fill="none" strokeLinecap="round" />
                )}
                {/* branch right */}
                {stage > 2 && (
                  <path d={`M50 ${crownCy + 4} Q58 ${crownCy - 3} 62 ${crownCy - 6}`} stroke="var(--plant-pot)" strokeWidth={2} fill="none" strokeLinecap="round" />
                )}
                {/* crown foliage blobs */}
                <ellipse cx={50} cy={crownCy - 2} rx={crownR} ry={crownR * 0.65} fill="var(--plant-green-1)" opacity={0.9} />
                {stage > 1 && <ellipse cx={38} cy={crownCy - 7} rx={crownR * 0.55} ry={crownR * 0.42} fill="var(--plant-green-1)" opacity={0.85} />}
                {stage > 2 && <ellipse cx={62} cy={crownCy - 5} rx={crownR * 0.48} ry={crownR * 0.38} fill="var(--plant-green-2)" opacity={0.8} />}
                {stage > 3 && <ellipse cx={50} cy={crownCy - 10} rx={crownR * 0.4} ry={crownR * 0.3} fill="var(--plant-green-2)" opacity={0.85} />}
                {/* highlight */}
                <ellipse cx={46} cy={crownCy - 4} rx={crownR * 0.3} ry={crownR * 0.2} fill="var(--plant-green-3)" opacity={0.35} />
                {/* berries at stage 5 */}
                {stage >= 5 && [42, 52, 60].map((bx) => (
                  <circle key={bx} cx={bx} cy={crownCy - 8} r={2} fill="var(--rose-500)" />
                ))}
              </>
            );
          })()}

          {/* ── SAKURA — pink cherry blossom, slim trunk ── */}
          {species === 'sakura' && (() => {
            const trunkH = 32 * grow;
            const crownCy = 72 - trunkH;
            const crownR = 18 * grow;
            const petalPositions = [
              { dx: -8, dy: -6 }, { dx: 8, dy: -6 }, { dx: -14, dy: 2 }, { dx: 14, dy: 2 },
              { dx: -6, dy: 8 }, { dx: 6, dy: 8 }, { dx: 0, dy: -12 }, { dx: -11, dy: -10 }, { dx: 11, dy: -10 },
            ];
            return (
              <>
                {/* trunk */}
                <path
                  d={`M50 72 Q49 ${72 - trunkH * 0.6} 50 ${crownCy + 4}`}
                  stroke="var(--plant-pot)"
                  strokeWidth={3}
                  fill="none"
                  strokeLinecap="round"
                />
                {/* crown base */}
                <ellipse cx={50} cy={crownCy} rx={crownR} ry={crownR * 0.7} fill="var(--plant-flower-soft)" opacity={0.4} />
                {/* petals / blossoms */}
                {petalPositions.slice(0, Math.ceil(petalPositions.length * grow)).map(({ dx, dy }, i) => {
                  const px = 50 + dx * grow;
                  const py = crownCy + dy * grow;
                  return (
                    <g key={i}>
                      <circle cx={px} cy={py} r={3.5 * grow} fill="var(--plant-flower-soft)" opacity={0.9} />
                      {stage >= 4 && <circle cx={px} cy={py} r={1} fill="var(--plant-flower)" />}
                    </g>
                  );
                })}
                {/* scattered petals at full bloom */}
                {stage >= 5 && [
                  { x: 34, y: crownCy + 10 }, { x: 65, y: crownCy + 8 }, { x: 40, y: crownCy + 14 },
                ].map(({ x, y }, i) => (
                  <circle key={`fp${i}`} cx={x} cy={y} r={2} fill="var(--plant-flower-soft)" opacity={0.6} />
                ))}
              </>
            );
          })()}

          {/* ── MUSHROOM — domed cap, spotted, earthy brown + cream ── */}
          {species === 'mushroom' && (() => {
            const stemH = 22 * grow;
            const capR = 18 * grow;
            const stemBase = 72;
            const stemTop = stemBase - stemH;
            return (
              <>
                {/* stem */}
                <path
                  d={`M44 ${stemBase} Q43 ${stemTop + stemH * 0.5} 44 ${stemTop}`}
                  stroke="var(--plant-stem)"
                  strokeWidth={10}
                  fill="none"
                  strokeLinecap="round"
                />
                <path
                  d={`M56 ${stemBase} Q57 ${stemTop + stemH * 0.5} 56 ${stemTop}`}
                  stroke="var(--plant-stem)"
                  strokeWidth={10}
                  fill="none"
                  strokeLinecap="round"
                />
                <rect x={43} y={stemTop} width={14} height={stemH} rx={5} fill="var(--plant-stem)" />
                {/* gills underside */}
                <ellipse cx={50} cy={stemTop} rx={capR * 0.85} ry={3 * grow} fill="color-mix(in srgb, var(--plant-stem) 70%, var(--surface))" />
                {/* cap */}
                <ellipse cx={50} cy={stemTop - capR * 0.35} rx={capR} ry={capR * 0.72} fill="var(--rose-500)" />
                {/* cap highlight */}
                <ellipse cx={45} cy={stemTop - capR * 0.5} rx={capR * 0.35} ry={capR * 0.22} fill="var(--rose-400)" opacity={0.5} />
                {/* spots */}
                {stage > 1 && [
                  { cx: 50, cy: stemTop - capR * 0.55, r: 3 },
                  { cx: 40, cy: stemTop - capR * 0.3, r: 2 },
                  { cx: 60, cy: stemTop - capR * 0.28, r: 2.5 },
                ].map((s, i) => (
                  <circle key={i} cx={s.cx * grow + 50 * (1 - grow)} cy={s.cy} r={s.r * grow} fill="color-mix(in srgb, var(--selection-text) 80%, transparent)" />
                ))}
                {stage >= 4 && <circle cx={44} cy={stemTop - capR * 0.45} r={1.5 * grow} fill="color-mix(in srgb, var(--selection-text) 80%, transparent)" />}
              </>
            );
          })()}

        </g>
      )}
    </svg>
  );
};

// ─────────────────────────────────────────────
// NNSkeleton — content placeholder with shimmer animation.
//
// Use for loading states where we don't yet know what the content looks like
// (initial bootstrap). Accepts width / height / borderRadius or `style` for
// arbitrary shapes.
//
//   <NNSkeleton height={40} />
//   <NNSkeleton width="60%" height={14} style={{ marginBottom: 8 }} />
// ─────────────────────────────────────────────
export const NNSkeleton = ({
  width = '100%',
  height = 14,
  radius = 8,
  style,
  className,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number;
  style?: React.CSSProperties;
  className?: string;
}) => (
  <span
    aria-hidden
    className={className}
    style={{
      display: 'inline-block',
      width,
      height,
      borderRadius: radius,
      background: 'var(--skeleton-bg)',
      backgroundSize: '200% 100%',
      animation: 'nn-shimmer 1400ms ease-in-out infinite',
      ...style,
    }}
  />
);

/** A stable, chrome-neutral page fallback for route/query suspension. */
export const NNPageSkeleton = ({ compact = false }: { compact?: boolean }) => (
  <div
    aria-busy="true"
    aria-label="Loading"
    className="reomi-page-surface"
    style={{
      flex: 1,
      overflow: 'hidden',
      padding: compact ? 16 : 'var(--page-padding)',
      display: 'flex',
      flexDirection: 'column',
      gap: 14,
    }}
  >
    <NNSkeleton width="38%" height={18} />
    <NNSkeleton width="64%" height={11} />
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 12,
        marginTop: 6,
      }}
    >
      <NNSkeleton height={compact ? 92 : 138} />
      <NNSkeleton height={compact ? 92 : 138} />
      <NNSkeleton height={compact ? 92 : 138} />
    </div>
  </div>
);

/** Non-blocking refresh affordance: existing content remains mounted beneath it. */
export const NNInlineRefresh = ({ label }: { label: string }) => (
  <span
    role="status"
    aria-live="polite"
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      color: 'var(--text-dim)',
      fontSize: 11.5,
      fontVariantNumeric: 'tabular-nums',
    }}
  >
    <span className="nn-spin" aria-hidden><NNIcon name="sync" size={13} /></span>
    {label}
  </span>
);

/** Retryable resource error that retains the API correlation reference. */
export const NNLoadError = ({
  title,
  description,
  retryLabel,
  onRetry,
  requestId,
}: {
  title: string;
  description?: string;
  retryLabel: string;
  onRetry: () => void;
  requestId?: string;
}) => (
  <div
    role="alert"
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-start',
      gap: 8,
      padding: 16,
      borderRadius: 'var(--r-lg)',
      border: '1px solid var(--tone-rose-border)',
      background: 'var(--tone-rose-bg)',
      color: 'var(--text)',
    }}
  >
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
      <NNIcon name="warning" size={17} color="var(--rose-400)" />
      {title}
    </span>
    {description ? <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{description}</span> : null}
    {requestId ? (
      <span className="mono" style={{ color: 'var(--text-dim)', fontSize: 10.5 }}>
        request: {requestId}
      </span>
    ) : null}
    <NNBtn size="sm" variant="outline" icon="sync" onClick={onRetry}>{retryLabel}</NNBtn>
  </div>
);
