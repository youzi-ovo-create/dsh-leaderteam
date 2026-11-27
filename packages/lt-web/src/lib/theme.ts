import type { CustomThemeSeeds, ThemePresetId } from '../types/lt-public-v1';

export type DensityMode = 'comfortable' | 'compact';
export type DisplayFontMode = 'serif' | 'sans';
export type RadiusStyle = 'sharp' | 'standard' | 'round';

export interface AppearancePrefs {
  theme: ThemePresetId;
  density: DensityMode;
  display: DisplayFontMode;
  customTheme: CustomThemeSeeds;
}

export interface ContrastReportRow {
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  grade: 'AAA' | 'AA' | 'AA 大字' | 'UI 3:1' | '不足';
}

export const APPEARANCE_STORAGE_KEY = 'lt.appearance';
export const LEGACY_PREFS_STORAGE_KEY = 'lt-ui-preferences-v1';

export const DEFAULT_CUSTOM_SEEDS: CustomThemeSeeds = {
  canvasColor: '#F1F2EF',
  surfaceColor: '#FFFFFF',
  inkColor: '#17191C',
  accentColor: '#3D6B5A',
  dangerColor: '#B2372C',
  headingFontMode: 'serif',
  cornerStyle: 'balanced',
  density: 'comfortable',
};

export const SEED_PRESETS: Array<{
  name: string;
  canvasColor: string;
  surfaceColor: string;
  inkColor: string;
  accentColor: string;
  dangerColor: string;
}> = [
  {
    name: '松烟',
    canvasColor: '#F1F2EF',
    surfaceColor: '#FFFFFF',
    inkColor: '#17191C',
    accentColor: '#3D6B5A',
    dangerColor: '#B2372C',
  },
  {
    name: '夜航',
    canvasColor: '#0B0E14',
    surfaceColor: '#121722',
    inkColor: '#E6EAF2',
    accentColor: '#7AA2F7',
    dangerColor: '#EE8577',
  },
  {
    name: '朱墨',
    canvasColor: '#F4F1EC',
    surfaceColor: '#FFFDFA',
    inkColor: '#211C18',
    accentColor: '#A0412D',
    dangerColor: '#A3263F',
  },
];

export const PRESET_THEME_TOKENS: Record<
  Exclude<ThemePresetId, 'custom'>,
  {
    canvas: string;
    subtle: string;
    surface: string;
    primary: string;
    secondary: string;
    muted: string;
    accent: string;
    onAccent: string;
    danger: string;
    dangerBg: string;
  }
> = {
  white: {
    canvas: '#F2F3F5',
    subtle: '#F8F9FA',
    surface: '#FFFFFF',
    primary: '#15191E',
    secondary: '#47505A',
    muted: '#67707B',
    accent: '#2A657C',
    onAccent: '#FFFFFF',
    danger: '#B2372C',
    dangerBg: '#FBECEA',
  },
  dark: {
    canvas: '#0D0F12',
    subtle: '#121519',
    surface: '#16191E',
    primary: '#E5E8EC',
    secondary: '#AAB2BC',
    muted: '#8A939E',
    accent: '#6FB1C9',
    onAccent: '#081317',
    danger: '#EE8577',
    dangerBg: '#322629',
  },
  heluoxu: {
    canvas: '#ECE8DF',
    subtle: '#F2EFE8',
    surface: '#F8F6F1',
    primary: '#1A1916',
    secondary: '#504D46',
    muted: '#6A665E',
    accent: '#9C5B2E',
    onAccent: '#FFFDF9',
    danger: '#A3263F',
    dangerBg: '#F6E6E8',
  },
};

const RADIUS_TABLE: Record<RadiusStyle, { xs: string; sm: string; md: string; lg: string; btn: string }> = {
  sharp: { xs: '1px', sm: '2px', md: '3px', lg: '6px', btn: '2px' },
  standard: { xs: '3px', sm: '4px', md: '6px', lg: '10px', btn: '6px' },
  round: { xs: '4px', sm: '6px', md: '10px', lg: '14px', btn: '999px' },
};

export function cornerStyleToRadius(cornerStyle?: string): RadiusStyle {
  if (cornerStyle === 'sharp') return 'sharp';
  if (cornerStyle === 'pill-cta' || cornerStyle === 'round') return 'round';
  return 'standard';
}

export function radiusToCornerStyle(radius: RadiusStyle): CustomThemeSeeds['cornerStyle'] {
  if (radius === 'sharp') return 'sharp';
  if (radius === 'round') return 'pill-cta';
  return 'balanced';
}

export function normalizeHex(hex: string | undefined, fallback: string): string {
  const s = String(hex || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    return `#${s[0]}${s[0]}${s[1]}${s[1]}${s[2]}${s[2]}`.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return `#${s}`.toUpperCase();
  }
  return fallback;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex, '#000000').slice(1);
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: [number, number, number]): string {
  return (
    '#' +
    rgb
      .map(v => {
        const clamped = Math.max(0, Math.min(255, Math.round(v)));
        return (clamped < 16 ? '0' : '') + clamped.toString(16);
      })
      .join('')
      .toUpperCase()
  );
}

export function mixHex(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([
    x[0] * (1 - t) + y[0] * t,
    x[1] * (1 - t) + y[1] * t,
    x[2] * (1 - t) + y[2] * t,
  ]);
}

export function relativeLuminance(hex: string): number {
  const rgb = hexToRgb(hex);
  return rgb
    .map(v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    })
    .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
}

export function computeContrastRatio(hexA: string, hexB: string): number {
  const la = relativeLuminance(hexA);
  const lb = relativeLuminance(hexB);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Number(((hi + 0.05) / (lo + 0.05)).toFixed(2));
}

export function gradeContrast(ratio: number, large = false): ContrastReportRow['grade'] {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return large ? 'AA 大字' : 'UI 3:1';
  return '不足';
}

export function ensureContrast(fg: string, bg: string, target: number, toward: string): string {
  let c = normalizeHex(fg, '#000000');
  const bgNorm = normalizeHex(bg, '#FFFFFF');
  let i = 0;
  while (computeContrastRatio(c, bgNorm) < target && i < 40) {
    c = mixHex(c, toward, 0.08);
    i += 1;
  }
  return c;
}

export function deriveCustomTheme(seeds: Partial<CustomThemeSeeds>): {
  tokens: Record<string, string>;
  dark: boolean;
} {
  const C = normalizeHex(seeds.canvasColor, DEFAULT_CUSTOM_SEEDS.canvasColor);
  const S = normalizeHex(seeds.surfaceColor, DEFAULT_CUSTOM_SEEDS.surfaceColor);
  const I = normalizeHex(seeds.inkColor, DEFAULT_CUSTOM_SEEDS.inkColor);
  const rawAccent = normalizeHex(seeds.accentColor, DEFAULT_CUSTOM_SEEDS.accentColor);
  const rawDanger = normalizeHex(seeds.dangerColor, DEFAULT_CUSTOM_SEEDS.dangerColor);
  const dark = relativeLuminance(S) < 0.22;

  const t: Record<string, string> = {};
  t['--lt-bg-canvas'] = C;
  t['--lt-bg-surface'] = S;
  t['--lt-bg-subtle'] = mixHex(S, C, 0.45);
  t['--lt-bg-elevated'] = dark ? mixHex(S, I, 0.06) : S;
  t['--lt-bg-input'] = dark ? mixHex(S, '#000000', 0.15) : S;
  t['--lt-bg-inset'] = mixHex(C, I, dark ? 0.03 : 0.035);

  const primary = ensureContrast(I, S, 12, dark ? '#FFFFFF' : '#000000');
  t['--lt-fg-primary'] = primary;
  t['--lt-fg-secondary'] = ensureContrast(mixHex(primary, S, 0.28), S, 7, primary);
  t['--lt-fg-muted'] = ensureContrast(mixHex(primary, S, 0.42), C, 4.5, primary);
  t['--lt-fg-disabled'] = mixHex(primary, S, 0.62);
  t['--lt-fg-on-ink'] = S;

  const inkRgb = hexToRgb(primary).join(',');
  t['--lt-bg-hover'] = `rgba(${inkRgb},${dark ? 0.06 : 0.045})`;
  t['--lt-bg-pressed'] = `rgba(${inkRgb},${dark ? 0.1 : 0.08})`;
  t['--lt-border-subtle'] = `rgba(${inkRgb},${dark ? 0.09 : 0.085})`;
  t['--lt-border-strong'] = `rgba(${inkRgb},${dark ? 0.17 : 0.16})`;
  t['--lt-border-control'] = mixHex(S, primary, dark ? 0.26 : 0.3);
  t['--lt-border-control-hover'] = mixHex(S, primary, 0.48);

  const A = ensureContrast(rawAccent, S, 4.5, dark ? '#FFFFFF' : '#000000');
  const accRgb = hexToRgb(A).join(',');
  t['--lt-accent'] = A;
  t['--lt-accent-strong'] = mixHex(A, dark ? '#FFFFFF' : '#000000', 0.2);
  t['--lt-accent-subtle'] = `rgba(${accRgb},0.12)`;
  t['--lt-bg-selected'] = `rgba(${accRgb},0.11)`;
  t['--lt-focus'] = `rgba(${accRgb},0.45)`;
  t['--lt-on-accent'] =
    computeContrastRatio('#FFFFFF', A) >= computeContrastRatio('#111111', A) ? '#FFFFFF' : '#111111';
  t['--lt-info'] = A;
  t['--lt-info-bg'] = mixHex(S, A, dark ? 0.14 : 0.09);

  const sem = dark
    ? { success: '#62B892', warning: '#DDAB55' }
    : { success: '#2B6F57', warning: '#8F620E' };
  for (const k of ['success', 'warning'] as const) {
    const bg = mixHex(S, sem[k], dark ? 0.14 : 0.1);
    t[`--lt-${k}-bg`] = bg;
    t[`--lt-${k}`] = ensureContrast(sem[k], bg, 4.5, dark ? '#FFFFFF' : '#000000');
  }

  const dBg = mixHex(S, rawDanger, dark ? 0.14 : 0.1);
  t['--lt-danger-bg'] = dBg;
  t['--lt-danger'] = ensureContrast(rawDanger, dBg, 4.5, dark ? '#FFFFFF' : '#000000');
  t['--lt-seal'] = t['--lt-danger'];
  t['--lt-brand'] = A;

  t['--lt-code-fg'] = primary;
  t['--lt-code-key'] = A;
  t['--lt-code-str'] = t['--lt-success'];
  t['--lt-code-num'] = t['--lt-warning'];
  t['--lt-code-com'] = t['--lt-fg-muted'];
  t['--lt-diff-add-bg'] = t['--lt-success-bg'];
  t['--lt-diff-del-bg'] = t['--lt-danger-bg'];
  t['--lt-chart-1'] = A;
  t['--lt-chart-grid'] = `rgba(${inkRgb},0.07)`;
  t['--lt-scrim'] = dark ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.28)';

  const r = RADIUS_TABLE[cornerStyleToRadius(seeds.cornerStyle)];
  t['--lt-radius-xs'] = r.xs;
  t['--lt-radius-sm'] = r.sm;
  t['--lt-radius-md'] = r.md;
  t['--lt-radius-lg'] = r.lg;
  t['--lt-radius-btn'] = r.btn;

  return { tokens: t, dark };
}

const ALL_DERIVED_CUSTOM_PROPS = [
  '--lt-bg-canvas',
  '--lt-bg-surface',
  '--lt-bg-subtle',
  '--lt-bg-elevated',
  '--lt-bg-input',
  '--lt-bg-inset',
  '--lt-fg-primary',
  '--lt-fg-secondary',
  '--lt-fg-muted',
  '--lt-fg-disabled',
  '--lt-fg-on-ink',
  '--lt-bg-hover',
  '--lt-bg-pressed',
  '--lt-border-subtle',
  '--lt-border-strong',
  '--lt-border-control',
  '--lt-border-control-hover',
  '--lt-accent',
  '--lt-accent-strong',
  '--lt-accent-subtle',
  '--lt-bg-selected',
  '--lt-focus',
  '--lt-on-accent',
  '--lt-info',
  '--lt-info-bg',
  '--lt-success',
  '--lt-success-bg',
  '--lt-warning',
  '--lt-warning-bg',
  '--lt-danger',
  '--lt-danger-bg',
  '--lt-seal',
  '--lt-brand',
  '--lt-code-fg',
  '--lt-code-key',
  '--lt-code-str',
  '--lt-code-num',
  '--lt-code-com',
  '--lt-diff-add-bg',
  '--lt-diff-del-bg',
  '--lt-chart-1',
  '--lt-chart-grid',
  '--lt-scrim',
  '--lt-radius-xs',
  '--lt-radius-sm',
  '--lt-radius-md',
  '--lt-radius-lg',
  '--lt-radius-btn',
  '--seed-canvas',
  '--seed-surface',
  '--seed-ink',
  '--seed-accent',
  '--seed-danger',
  '--user-bg-canvas',
  '--user-bg-surface',
  '--user-fg-primary',
  '--user-accent',
  '--user-danger',
  '--user-fg-on-ink',
];

export function readStoredAppearance(): { density: DensityMode; display: DisplayFontMode } {
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        density: parsed?.density === 'compact' ? 'compact' : 'comfortable',
        display: parsed?.display === 'sans' ? 'sans' : 'serif',
      };
    }
  } catch {}
  return { density: 'comfortable', display: 'serif' };
}

export function applyAppearanceToDom(
  theme: ThemePresetId,
  customTheme: CustomThemeSeeds,
  globalOverride?: { density?: DensityMode; display?: DisplayFontMode },
): void {
  if (typeof document === 'undefined') return;
  const html = document.documentElement;
  const st = html.style;
  const mergedCustom: CustomThemeSeeds = { ...DEFAULT_CUSTOM_SEEDS, ...(customTheme || {}) };

  html.setAttribute('data-lt-theme', theme);

  for (const prop of ALL_DERIVED_CUSTOM_PROPS) {
    st.removeProperty(prop);
  }

  if (theme === 'custom') {
    const { tokens, dark } = deriveCustomTheme(mergedCustom);
    const effDensity =
      globalOverride?.density ?? (mergedCustom.density === 'compact' ? 'compact' : 'comfortable');
    const effDisplay =
      globalOverride?.display ?? (mergedCustom.headingFontMode === 'sans' ? 'sans' : 'serif');

    html.setAttribute('data-lt-heading', effDisplay);
    html.setAttribute('data-lt-display', effDisplay);
    html.setAttribute('data-lt-corners', mergedCustom.cornerStyle || 'balanced');
    html.setAttribute('data-lt-density', mergedCustom.density || effDensity);

    st.setProperty('--seed-canvas', mergedCustom.canvasColor);
    st.setProperty('--seed-surface', mergedCustom.surfaceColor);
    st.setProperty('--seed-ink', mergedCustom.inkColor);
    st.setProperty('--seed-accent', mergedCustom.accentColor);
    st.setProperty('--seed-danger', mergedCustom.dangerColor);

    st.setProperty('--user-bg-canvas', mergedCustom.canvasColor);
    st.setProperty('--user-bg-surface', mergedCustom.surfaceColor);
    st.setProperty('--user-fg-primary', mergedCustom.inkColor);
    st.setProperty('--user-accent', mergedCustom.accentColor);
    st.setProperty('--user-danger', mergedCustom.dangerColor);
    const inkLum = relativeLuminance(mergedCustom.inkColor);
    st.setProperty('--user-fg-on-ink', inkLum > 0.45 ? '#141619' : '#FFFFFF');

    for (const [k, v] of Object.entries(tokens)) {
      st.setProperty(k, v);
    }
    st.colorScheme = dark ? 'dark' : 'light';
  } else {
    html.removeAttribute('data-lt-heading');
    html.removeAttribute('data-lt-corners');
    if (globalOverride?.density === 'compact') {
      html.setAttribute('data-lt-density', 'compact');
    } else {
      html.removeAttribute('data-lt-density');
    }
    if (globalOverride?.display === 'sans') {
      html.setAttribute('data-lt-display', 'sans');
    } else {
      html.removeAttribute('data-lt-display');
    }
    st.removeProperty('color-scheme');
  }

  try {
    localStorage.setItem(
      LEGACY_PREFS_STORAGE_KEY,
      JSON.stringify({ theme, customTheme: mergedCustom }),
    );
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        theme,
        density:
          globalOverride?.density ??
          (theme === 'custom' && mergedCustom.density === 'compact' ? 'compact' : 'comfortable'),
        display:
          globalOverride?.display ??
          (theme === 'custom' && mergedCustom.headingFontMode === 'sans' ? 'sans' : 'serif'),
        customTheme: mergedCustom,
      }),
    );
  } catch {}
}

export function getContrastReport(
  theme: ThemePresetId,
  customTheme?: CustomThemeSeeds,
): ContrastReportRow[] {
  let primary: string;
  let secondary: string;
  let muted: string;
  let surface: string;
  let canvas: string;
  let accent: string;
  let onAccent: string;
  let danger: string;
  let dangerBg: string;

  if (theme === 'custom') {
    const { tokens } = deriveCustomTheme(customTheme || DEFAULT_CUSTOM_SEEDS);
    primary = tokens['--lt-fg-primary'];
    secondary = tokens['--lt-fg-secondary'];
    muted = tokens['--lt-fg-muted'];
    surface = tokens['--lt-bg-surface'];
    canvas = tokens['--lt-bg-canvas'];
    accent = tokens['--lt-accent'];
    onAccent = tokens['--lt-on-accent'];
    danger = tokens['--lt-danger'];
    dangerBg = tokens['--lt-danger-bg'];
  } else {
    const p = PRESET_THEME_TOKENS[theme] || PRESET_THEME_TOKENS.white;
    primary = p.primary;
    secondary = p.secondary;
    muted = p.muted;
    surface = p.surface;
    canvas = p.canvas;
    accent = p.accent;
    onAccent = p.onAccent;
    danger = p.danger;
    dangerBg = p.dangerBg;
  }

  const rows: Array<[string, string, string]> = [
    ['正文 / 表面', primary, surface],
    ['次要文字 / 表面', secondary, surface],
    ['弱化文字 / 画布', muted, canvas],
    ['强调色文字 / 表面', accent, surface],
    ['按钮文字 / 强调色', onAccent, accent],
    ['危险文字 / 危险底', danger, dangerBg],
  ];

  return rows.map(([label, fg, bg]) => {
    const ratio = computeContrastRatio(fg, bg);
    return { label, fg, bg, ratio, grade: gradeContrast(ratio) };
  });
}
