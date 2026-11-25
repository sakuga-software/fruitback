import { type ReactNode, useEffect, useState } from 'react';
import {
  ACCENTS,
  ACCENT_IDS,
  type AccentId,
  type Appearance,
  DEFAULT_APPEARANCE,
  type Density,
  FONT_SIZES,
  type FontSize,
  type Mode,
  PRESETS,
  PRESET_IDS,
  type PresetId,
  RADII,
  ROW_HEIGHTS,
  STORAGE_KEY,
  type Radius,
  TINTS,
  type Tint,
  applyAppearance,
  choosePreset,
  keptAppearance,
  presetOf,
  sidebarPalette,
  systemIsDark,
} from '../appearance';
import { msg, t } from '../i18n';
import { SettingsIcon } from '../settings-icons';
import { Button, ColourPick, PicturePick, Segments } from '../ui';
import { useLocale } from '../use-locale';
import { SettingsCard } from '../parts/account-rows';
import { SettingsHead } from './settings-shell';

/** The names of the themes, as the mockup writes them. */
const PRESET_NAMES: Readonly<Record<PresetId, string>> = {
  slate: msg('Slate (default)'),
  snow: msg('Snow'),
  zinc: msg('Zinc'),
  midnight: msg('Midnight'),
  graphite: msg('Graphite'),
};

const TINT_NAMES: Readonly<Record<Tint, string>> = {
  page: msg('Page'),
  faint: msg('Faint'),
  theme: msg('The theme’s'),
  deep: msg('Deep'),
  ink: msg('Ink'),
};

const ACCENT_NAMES: Readonly<Record<AccentId, string>> = {
  red: msg('Fruitback red'),
  orange: msg('Orange'),
  teal: msg('Teal'),
  blue: msg('Blue'),
  indigo: msg('Indigo'),
  ink: msg('Ink'),
};

const DENSITY_NAMES: Readonly<Record<Density, string>> = {
  compact: msg('Compact'),
  default: msg('Default'),
  comfortable: msg('Comfortable'),
};

/**
 * Settings › Appearance (FRU-694, the mockup « Apparence »): the look of the console for the person
 * alone. « Theme », five themes drawn in small; « Customize », one row per setting: the mode, the tint
 * of the sidebar, the accent, the density of the rows, the radius and the size of the text, and
 * « Reset ». Each choice shows at once: `appearance.ts` writes the tokens on `<html>`, and keeps the
 * choice in this browser until the account keeps it (FRU-716).
 */
export default function AccountAppearance() {
  useLocale();
  // What this browser keeps, read before the first render: a choice pressed at once builds on it, and
  // never on the default (raised in review). The console renders in a browser only (`ssr: false`).
  const [appearance, setAppearance] = useState<Appearance>(() => keptAppearance(storage()));
  const [systemDark, setSystemDark] = useState(systemIsDark);
  // Under « System », the theme drawn as chosen follows the system while the page is open.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const media = matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setSystemDark(media.matches);
    media.addEventListener('change', changed);

    return () => media.removeEventListener('change', changed);
  }, []);
  // A choice made in another tab is the one this page builds on next (raised in review).
  useEffect(() => {
    const other = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setAppearance(keptAppearance(storage()));
    };
    window.addEventListener('storage', other);

    return () => window.removeEventListener('storage', other);
  }, []);

  const choose = (next: Appearance) => {
    setAppearance(next);
    applyAppearance(next, document.documentElement, storage(), systemIsDark());
  };
  const set = <Key extends keyof Appearance>(key: Key, value: Appearance[Key]) =>
    choose({ ...appearance, [key]: value });
  const shown = presetOf(appearance, systemDark);
  const scheme = PRESETS[shown].scheme;

  return (
    <>
      <SettingsHead title={t('Appearance')} lead={t('Only for you, on this account. Every member picks their own.')} />
      <div className="flex flex-col gap-[16px]">
        <SettingsCard id="theme-title" icon="appearance" title={t('Theme')}>
          <div className="px-[16px] pt-[2px] pb-[18px]">
            <PicturePick
              label={t('Theme')}
              value={shown}
              onChange={(preset) => choose(choosePreset(appearance, preset, systemIsDark()))}
              options={PRESET_IDS.map((preset) => ({
                value: preset,
                label: t(PRESET_NAMES[preset]),
                picture: <Thumbnail preset={preset} />,
              }))}
            />
          </div>
        </SettingsCard>
        <SettingsCard
          id="customize-title"
          icon="general"
          title={t('Customize')}
          actions={
            <Button tone="quiet" label={t('Reset the appearance')} onClick={() => choose(DEFAULT_APPEARANCE)}>
              <span className="inline-flex items-center gap-[6px]">
                <SettingsIcon name="reset" size={14} />
                {t('Reset')}
              </span>
            </Button>
          }
        >
          <ul className="flex flex-col">
            <Setting title={t('Mode')} detail={t('Follow the system, or pick one')}>
              <Segments<Mode>
                label={t('Mode')}
                value={appearance.mode}
                onChange={(mode) => set('mode', mode)}
                options={[
                  { value: 'light', label: t('Light'), icon: <SettingsIcon name="sun" size={14} /> },
                  { value: 'dark', label: t('Dark'), icon: <SettingsIcon name="moon" size={14} /> },
                  { value: 'system', label: t('System'), icon: <SettingsIcon name="screen" size={14} /> },
                ]}
              />
            </Setting>
            <Setting title={t('Sidebar')} detail={t('Tint of the sidebar against the page')}>
              <ColourPick<Tint>
                label={t('Sidebar')}
                value={appearance.sidebar}
                onChange={(tint) => set('sidebar', tint)}
                options={TINTS.map((tint) => ({
                  value: tint,
                  label: t(TINT_NAMES[tint]),
                  colour: sidebarPalette(shown, tint).sidebar,
                }))}
              />
            </Setting>
            <Setting title={t('Accent')} detail={t('Buttons, focus ring and the unread dot')}>
              <ColourPick<AccentId>
                label={t('Accent')}
                value={appearance.accent}
                onChange={(accent) => set('accent', accent)}
                options={ACCENT_IDS.map((accent) => ({
                  value: accent,
                  label: t(ACCENT_NAMES[accent]),
                  colour: ACCENTS[accent][scheme].accent,
                }))}
              />
            </Setting>
            <Setting title={t('Density')} detail={t('Row height in lists and tables')}>
              <span className="inline-flex flex-wrap items-center gap-[10px]">
                <Segments<Density>
                  label={t('Density')}
                  value={appearance.density}
                  onChange={(density) => set('density', density)}
                  options={(['compact', 'default', 'comfortable'] as const).map((density) => ({
                    value: density,
                    label: t(DENSITY_NAMES[density]),
                  }))}
                />
                <span className="text-hint text-muted">
                  {t('{height} px rows', { height: String(ROW_HEIGHTS[appearance.density]) })}
                </span>
              </span>
            </Setting>
            <Setting title={t('Corner radius')} detail={t('Same on every button, field and menu')}>
              <Segments
                label={t('Corner radius')}
                value={String(appearance.radius)}
                onChange={(radius) => set('radius', Number(radius) as Radius)}
                options={RADII.map((radius) => ({ value: String(radius), label: String(radius) }))}
              />
            </Setting>
            <Setting title={t('Font size')} detail={t('Base size of the console')}>
              <Segments
                label={t('Font size')}
                value={String(appearance.fontSize)}
                onChange={(size) => set('fontSize', Number(size) as FontSize)}
                options={FONT_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
              />
            </Setting>
          </ul>
        </SettingsCard>
      </div>
    </>
  );
}

/** The storage of this browser, or none where it cannot be read (a private window that refuses it). */
function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** A row of « Customize »: its name and its line on the left, 260 px, its control at the end. */
function Setting({ title, detail, children }: { title: string; detail: string; children: ReactNode }) {
  return (
    <li className="kit-settings-row flex min-h-[56px] flex-wrap items-center gap-x-[16px] gap-y-[8px] border-t border-line px-[16px] py-[10px]">
      <span aria-hidden="true" className="flex min-w-0 flex-[1_1_220px] flex-col gap-[4px]">
        <span className="text-small leading-auto font-semibold">{title}</span>
        <span className="text-hint text-muted">{detail}</span>
      </span>
      <span className="ms-auto flex min-w-0 flex-wrap items-center">{children}</span>
    </li>
  );
}

/**
 * A theme drawn in small, as the mockup draws it: its sidebar with a title, an entry chosen and two
 * lines, beside its page with four lines. The colours are the theme's, given in a style: a picture of
 * another theme than the one on screen. Decorative: its name is under it.
 */
function Thumbnail({ preset }: { preset: PresetId }) {
  const palette = PRESETS[preset];
  const bar = (width: string, colour: string, height = 5) => (
    <span className="block rounded-inner" style={{ width, height, background: colour }} />
  );

  return (
    <span aria-hidden="true" className="flex h-[96px]">
      <span
        className="flex w-[34%] flex-col gap-[5px] px-[6px] py-[8px]"
        style={{ background: palette.sidebar, borderInlineEnd: `1px solid ${palette.line}` }}
      >
        {bar('70%', palette.ink, 6)}
        {bar('100%', palette.selected, 10)}
        {bar('60%', palette.line)}
        {bar('70%', palette.line)}
      </span>
      <span className="flex flex-1 flex-col gap-[6px] px-[8px] py-[6px]" style={{ background: palette.page }}>
        {bar('80%', palette.line)}
        {bar('60%', palette.line)}
        {bar('70%', palette.line)}
        {bar('50%', palette.line)}
      </span>
    </span>
  );
}
