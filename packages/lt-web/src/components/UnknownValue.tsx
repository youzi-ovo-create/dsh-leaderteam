import React from 'react';

export function UnknownValue({ reason = '未知：未计量或未定价，不以 0 计' }: { reason?: string }) {
  return (
    <em className="unknown" title={reason}>
      —
    </em>
  );
}
