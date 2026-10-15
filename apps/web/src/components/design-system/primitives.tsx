'use client';

import {
  cloneElement, useId, useRef,
  type ComponentProps, type CSSProperties, type HTMLAttributes,
  type ReactElement, type ReactNode,
} from 'react';

export type ButtonVariant = 'primary' | 'violet' | 'amber' | 'ghost' | 'soft' | 'outline' | 'danger' | 'bare';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';
export type ButtonProps = ComponentProps<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leading?: ReactNode;
  trailing?: ReactNode;
  loading?: boolean;
  loadingLabel?: string;
  active?: boolean;
  block?: boolean;
};

/** Shared production button. NNBtn is a backwards-compatible icon adapter. */
export function Button({
  children, variant = 'ghost', size = 'md', leading, trailing,
  loading = false, loadingLabel, active, block, disabled, type = 'button',
  className, title, 'aria-label': label, ...props
}: ButtonProps) {
  if (variant === 'bare') {
    return (
      <button
        {...props}
        type={type}
        title={title}
        className={className}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        aria-label={loading ? (loadingLabel ?? label) : label}
      >
        {leading}{children}{trailing}
      </button>
    );
  }
  return (
    <button
      {...props}
      type={type}
      data-tooltip={title ?? label ?? (typeof children === 'string' ? children : undefined)}
      className={['reomi-button', className].filter(Boolean).join(' ')}
      data-variant={variant} data-size={size}
      data-active={active || undefined} data-block={block || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-pressed={props['aria-pressed'] ?? active}
      aria-label={loading ? (loadingLabel ?? label) : label}
    >
      <span className="reomi-button-stack">
        <span className="reomi-button-content" style={{ opacity: loading ? 0 : undefined }}>
          {leading}{children}{trailing}
        </span>
        {loading && <span className="reomi-button-spinner" aria-hidden="true" />}
      </span>
    </button>
  );
}

export type SurfaceProps = HTMLAttributes<HTMLDivElement> & {
  level?: 'content' | 'subtle' | 'floating';
  padding?: number;
  hoverable?: boolean;
};

export function Surface({
  level = 'content', padding = 20, hoverable, className, style,
  onClick, onKeyDown, role, tabIndex, ...props
}: SurfaceProps) {
  return <div {...props}
    className={['reomi-surface', className].filter(Boolean).join(' ')}
    data-level={level} data-interactive={Boolean(onClick || hoverable) || undefined}
    role={role ?? (onClick ? 'button' : undefined)}
    tabIndex={tabIndex ?? (onClick ? 0 : undefined)}
    onClick={onClick}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && onClick && event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        event.currentTarget.click();
      }
    }}
    style={{ padding, ...style }}
  />;
}

const UNCHROMED_INPUT = new Set(['file', 'hidden', 'range']);

export function TextInput({ className, type, ...props }: ComponentProps<'input'>) {
  const chrome = typeof type !== 'string' || !UNCHROMED_INPUT.has(type);
  const classes = [chrome ? 'reomi-input' : null, className].filter(Boolean).join(' ');
  return <input {...props} type={type} className={classes || undefined} />;
}

export function Switch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="reomi-switch"
      aria-label={label}
      aria-checked={checked}
      onClick={() => onChange(!checked)}
    />
  );
}

export function TextArea({ className, ...props }: ComponentProps<'textarea'>) {
  return <textarea {...props} className={['reomi-input', 'reomi-textarea', className].filter(Boolean).join(' ')} />;
}

type FieldControl = { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' };
export function Field({
  id, label, description, error, children,
}: {
  id?: string; label: ReactNode; description?: ReactNode; error?: ReactNode;
  children: ReactElement<FieldControl>;
}) {
  const generatedId = useId();
  const controlId = children.props.id ?? id ?? generatedId;
  const describedBy = [children.props['aria-describedby'], description && `${controlId}-help`, error && `${controlId}-error`].filter(Boolean).join(' ') || undefined;
  return <div className="reomi-field">
    <label htmlFor={controlId}>{label}</label>
    {cloneElement(children, { id: controlId, 'aria-describedby': describedBy, 'aria-invalid': error ? true : children.props['aria-invalid'] })}
    {description && <div id={`${controlId}-help`} className="reomi-field-help">{description}</div>}
    {error && <div id={`${controlId}-error`} className="reomi-field-error" role="alert">{error}</div>}
  </div>;
}

export type SegmentOption<T extends string> = { value: T; label: ReactNode; tooltip?: string; disabled?: boolean };
/** Selection control (radio semantics); arrow keys select and move focus. */
export function SegmentedControl<T extends string>({
  value, onChange, options, label, className, style,
}: {
  value: T; onChange: (value: T) => void; options: readonly SegmentOption<T>[];
  label: string; className?: string; style?: CSSProperties;
}) {
  const root = useRef<HTMLDivElement>(null);
  const enabled = options.filter(o => !o.disabled);
  const selected = enabled.find(o => o.value === value)?.value ?? enabled[0]?.value;
  return <div ref={root} className={['reomi-segments', className].filter(Boolean).join(' ')} role="radiogroup" aria-label={label} style={style}>
    {options.map(option => <button key={option.value} type="button" role="radio"
      disabled={option.disabled} aria-checked={value === option.value}
      data-tooltip={option.tooltip ?? (typeof option.label === 'string' ? option.label : undefined)}
      tabIndex={selected === option.value ? 0 : -1}
      onClick={() => onChange(option.value)}
      onKeyDown={event => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key) || !enabled.length) return;
        event.preventDefault();
        const index = enabled.findIndex(o => o.value === option.value);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
        onChange(enabled[next].value);
        root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')[next]?.focus();
      }}
    >{option.label}</button>)}
  </div>;
}

type CheckboxProps = Omit<ComponentProps<'input'>, 'type' | 'onChange' | 'checked' | 'className'> & {
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
};
export function Checkbox({ checked, onChange, disabled, children, className, title, ...props }: CheckboxProps) {
  return <label className={['reomi-check', className].filter(Boolean).join(' ')} data-disabled={disabled ? 'true' : undefined} title={title}>
    <input {...props} type="checkbox" className="reomi-check-input" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
    <span className="reomi-check-box" data-checked={checked ? 'true' : undefined} aria-hidden="true" />
    {children}
  </label>;
}

export function ReadingText({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={['reomi-reading', className].filter(Boolean).join(' ')} />;
}

/** Scrollable page body with the same edges and material as the app chrome. */
export function PageSurface({ className, ...props }: ComponentProps<'div'>) {
  return <div {...props} className={['reomi-page-surface', 'nn-scroll', className].filter(Boolean).join(' ')} />;
}
