import React, { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';

export interface ToastItem {
  id: string;
  message: string;
  icon?: IconName;
}

export interface PaletteCommand {
  id: string;
  group: string;
  label: string;
  icon?: IconName;
  hint?: string;
  keywords?: string;
  run: () => void;
}

export function ToastHost({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="toast-host" aria-live="polite" aria-atomic="true">
      {toasts.map(t => (
        <div key={t.id} className="toast">
          {t.icon && <Icon name={t.icon} className="icon-14" />}
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  leading,
  badge,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  leading?: React.ReactNode;
  badge?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="scrim open" onClick={onClose} />
      <aside className="drawer open" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head">
          {leading}
          <div className="col grow" style={{ gap: 0 }}>
            <b>{title}</b>
            {subtitle && <span className="mono t-meta ellipsis">{subtitle}</span>}
          </div>
          {badge}
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-foot">{footer}</div>}
      </aside>
    </>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  footer,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="scrim open" onClick={onClose} />
      <div className="dialog open" role="dialog" aria-modal="true" aria-label={title}>
        <div className="dialog-body">
          <h3 className="t-subhead" style={{ marginBottom: 10 }}>
            {title}
          </h3>
          {children}
        </div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </>
  );
}

export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  if (!open) return null;

  const q = query.trim().toLowerCase();
  const filtered = commands.filter(it => {
    if (!q) return true;
    const hay = `${it.label} ${it.keywords || ''} ${it.group}`.toLowerCase();
    return hay.includes(q);
  });
  const clampedIdx = filtered.length > 0 ? Math.min(activeIdx, filtered.length - 1) : 0;

  let lastGroup = '';

  return (
    <>
      <div className="scrim open" onClick={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="搜索命令、视图、会话或主题…"
          value={query}
          onChange={e => {
            setQuery(e.target.value);
            setActiveIdx(0);
          }}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActiveIdx(i => Math.min(Math.max(0, filtered.length - 1), i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActiveIdx(i => Math.max(0, i - 1));
            } else if (e.key === 'Enter' && filtered[clampedIdx]) {
              e.preventDefault();
              const cmd = filtered[clampedIdx];
              onClose();
              cmd.run();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>
              无匹配命令
            </div>
          ) : (
            filtered.map((cmd, idx) => {
              const showGroup = cmd.group !== lastGroup;
              lastGroup = cmd.group;
              return (
                <React.Fragment key={cmd.id}>
                  {showGroup && <div className="palette-group t-overline">{cmd.group}</div>}
                  <button
                    type="button"
                    className={`menu-item${idx === clampedIdx ? ' active' : ''}`}
                    onMouseEnter={() => setActiveIdx(idx)}
                    onClick={() => {
                      onClose();
                      cmd.run();
                    }}
                  >
                    <Icon name={cmd.icon || 'chevR'} />
                    <span>{cmd.label}</span>
                    {cmd.hint && <span className="muted">{cmd.hint}</span>}
                  </button>
                </React.Fragment>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}

export function AnchoredPopover({
  open,
  anchorRect,
  align = 'left',
  placement = 'bottom',
  onClose,
  children,
}: {
  open: boolean;
  anchorRect: DOMRect | null;
  align?: 'left' | 'right';
  placement?: 'bottom' | 'right-up';
  onClose: () => void;
  children: React.ReactNode;
}) {
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const t = setTimeout(() => {
      document.addEventListener('mousedown', onDocDown);
    }, 0);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open || !anchorRect) return null;

  const vw = typeof window !== 'undefined' ? window.innerWidth : 1440;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 900;
  const estW = 280;
  let left: number;
  let top: number;
  let bottom: number | undefined;

  if (placement === 'right-up') {
    left = Math.min(anchorRect.right + 8, vw - estW - 8);
    top = Math.max(8, Math.min(anchorRect.top - 180, vh - 260));
    bottom = Math.max(8, vh - anchorRect.bottom);
  } else {
    left = align === 'right' ? Math.max(8, anchorRect.right - estW) : Math.max(8, Math.min(anchorRect.left, vw - estW - 8));
    top = Math.min(anchorRect.bottom + 6, vh - 260);
  }

  return (
    <div
      ref={popRef}
      className="pop"
      style={
        placement === 'right-up'
          ? { left, bottom, top: 'auto' }
          : { left, top }
      }
    >
      {children}
    </div>
  );
}
