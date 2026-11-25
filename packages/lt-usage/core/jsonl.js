export function parseJsonl(text) {
  const lines = String(text).split('\n');
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) lastNonEmpty = i;
  }
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      if (i === lastNonEmpty) break;
      const snippet = line.length > 120 ? `${line.slice(0, 120)}…` : line;
      throw new Error(`parseJsonl: invalid JSON at line ${i + 1}: ${snippet}`);
    }
  }
  return out;
}