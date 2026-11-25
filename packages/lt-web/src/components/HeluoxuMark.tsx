import React from 'react';

/**
 * Heluoxu V2 Symbol A Glyph ("始 / Origin"):
 * Hollow ink circle poised above a vertical accent axis with an intentional 2.35px gap.
 */
export function HeluoxuMark({ size = 22 }: { size?: number }) {
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
      <line x1="11" y1="12.6" x2="11" y2="21" stroke="var(--lt-accent)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Heluoxu "旦" (Dawn / Horizon Closure) motif for clean completion / checkpointed rest states.
 */
export function HeluoxuHorizonMark() {
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 4 }} aria-hidden="true">
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '1.5px solid var(--lt-accent)',
          display: 'block',
        }}
      />
      <span style={{ width: 44, height: 1, background: 'var(--lt-accent)', display: 'block' }} />
    </div>
  );
}
