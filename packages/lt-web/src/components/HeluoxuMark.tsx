import React from 'react';

/**
 * Heluo Origin Glyph ("始 / Origin"):
 * Hollow ink circle poised above a vertical brand axis with an intentional gap.
 */
export function HeluoxuMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <circle cx="11" cy="6" r="4.25" stroke="var(--lt-fg-primary)" strokeWidth="1.5" />
      <line x1="11" y1="12.6" x2="11" y2="21" stroke="var(--lt-brand)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Heluo "旦" (Dawn / Horizon Closure) motif for clean completion / empty / paused rest states.
 */
export function HeluoxuHorizonMark() {
  return (
    <span
      style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}
      aria-hidden="true"
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: '1.5px solid var(--lt-brand)',
          display: 'block',
        }}
      />
      <span style={{ width: 52, height: 1, background: 'var(--lt-brand)', display: 'block' }} />
    </span>
  );
}
