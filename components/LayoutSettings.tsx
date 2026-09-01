'use client';

// ---------------------------------------------------------------------------
// LayoutSettings — Phase A (dispatch pixel/layout-settings-phaseA, 2026-09-01).
//
// The "Layout" section of the desktop Settings page. Lets a signed-in user pick
// a dashboard preset (Power user / Phone Link / Custom) and, per D2, tune RICHER
// per-module display options. Selecting a preset or editing any option persists
// through useLayoutPrefs.savePrefs() (optimistic local + DB via PUT) and applies
// live on the dashboard.
//
// Dennis decisions honored here: D1 (Phone Link is inspired-by, described as a
// single-focus layout — not "clone"), D2 (per-module options below the cards),
// D4 (presets first — NO drag-and-drop; reorder is Phase B), D5 (desktop only).
//
// Editing ANY per-module option flips the active preset to 'custom' — the cards
// reflect that immediately. Re-selecting Power or Phone Link restores that
// preset's full defaults.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { Layout, Smartphone, SlidersHorizontal, Check } from 'lucide-react';
import { useLayoutPrefs } from '@/hooks';
import {
  presetDefault,
  type LayoutPreset,
  type LayoutPrefs,
  type ModuleConfig,
  type ModuleId,
} from '@/lib/layoutPrefs';

// ---- Preset catalogue ------------------------------------------------------

interface PresetMeta {
  id: LayoutPreset;
  name: string;
  desc: string;
  icon: typeof Layout;
}

const PRESETS: PresetMeta[] = [
  {
    id: 'power',
    name: 'Power user',
    desc: 'Everything at once — dial, call log, conversations and the open chat side by side.',
    icon: Layout,
  },
  {
    id: 'phonelink',
    name: 'Phone Link',
    desc: 'One focus at a time — switch between calls and messages, with notifications as a side feed.',
    icon: Smartphone,
  },
  {
    id: 'custom',
    name: 'Custom',
    desc: 'Your own mix of modules and display options. Set automatically when you tune anything below.',
    icon: SlidersHorizontal,
  },
];

// Human labels for the four modules, in a stable display order.
const MODULE_LABELS: Record<ModuleId, string> = {
  notifications: 'Notifications',
  quickdial: 'Quick Dial',
  recentcalls: 'Recent Calls',
  threads: 'Conversations',
};

// ---- Mini layout previews --------------------------------------------------
// Tiny, purely-decorative wireframes so a preset reads at a glance. Kept as
// plain divs (no text) with aria-hidden — the accessible name comes from the
// card's radio label, not the picture.

function PowerPreview() {
  return (
    <div aria-hidden className="flex h-full w-full gap-1">
      <div className="w-1.5 rounded-sm bg-slate-300" />
      <div className="flex-[1.1] rounded-sm bg-slate-200" />
      <div className="flex-1 rounded-sm bg-slate-200" />
      <div className="flex-[1.6] rounded-sm bg-blue-200" />
    </div>
  );
}

function PhoneLinkPreview() {
  return (
    <div aria-hidden className="flex h-full w-full gap-1">
      <div className="flex-[2] flex flex-col gap-1">
        <div className="h-2 rounded-sm bg-slate-300" />
        <div className="flex-1 rounded-sm bg-blue-200" />
      </div>
      <div className="w-3 rounded-sm bg-slate-200" />
    </div>
  );
}

function CustomPreview() {
  return (
    <div aria-hidden className="grid h-full w-full grid-cols-3 grid-rows-2 gap-1">
      <div className="rounded-sm border border-dashed border-slate-300 bg-slate-100" />
      <div className="col-span-2 rounded-sm border border-dashed border-slate-300 bg-slate-100" />
      <div className="col-span-2 rounded-sm border border-dashed border-slate-300 bg-slate-100" />
      <div className="rounded-sm border border-dashed border-slate-300 bg-slate-100" />
    </div>
  );
}

function PresetPreview({ preset }: { preset: LayoutPreset }) {
  if (preset === 'phonelink') return <PhoneLinkPreview />;
  if (preset === 'custom') return <CustomPreview />;
  return <PowerPreview />;
}

// ---- Small building blocks -------------------------------------------------

/** Accessible on/off switch (role=switch). Label sits to the left. */
function Toggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-slate-600">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={
          'relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition-colors ' +
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:opacity-40 ' +
          (checked ? 'bg-blue-500' : 'bg-slate-300')
        }
      >
        <span
          className={
            'inline-block h-3 w-3 transform rounded-full bg-white shadow transition-transform ' +
            (checked ? 'translate-x-3.5' : 'translate-x-0.5')
          }
        />
      </button>
    </label>
  );
}

/** Segmented single-choice control (radiogroup semantics). */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-slate-600">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5"
      >
        {options.map((opt) => {
          const active = opt.value === value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(opt.value)}
              className={
                'px-2 py-0.5 text-[11px] font-medium rounded-md transition-colors ' +
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ' +
                (active
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700')
              }
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function LayoutSettings() {
  const { resolved, savePrefs } = useLayoutPrefs();
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const activePreset = resolved.preset;

  // Persist a full LayoutPrefs. Any explicit preset choice / option edit already
  // carries a complete, resolved 4-module list, so we always send it whole —
  // the server re-normalizes and echoes the value back.
  async function persist(next: LayoutPrefs) {
    setStatus('saving');
    const ok = await savePrefs(next);
    setStatus(ok ? 'saved' : 'error');
  }

  function choosePreset(preset: LayoutPreset) {
    if (preset === 'custom') {
      // "Custom" without edits is just the current arrangement re-labelled.
      void persist({ version: 1, preset: 'custom', modules: resolved.modules });
      return;
    }
    void persist(presetDefault(preset));
  }

  // Apply a partial edit to one module, flip to 'custom', and persist. The
  // discriminated union makes a generic merge awkward, so we cast the patch —
  // callers only ever pass fields valid for that module id.
  function editModule(id: ModuleId, patch: Partial<ModuleConfig>) {
    const modules = resolved.modules.map((m) =>
      m.id === id ? ({ ...m, ...patch } as ModuleConfig) : m
    );
    void persist({ version: 1, preset: 'custom', modules });
  }

  const get = (id: ModuleId) => resolved.modules.find((m) => m.id === id)!;

  return (
    <section
      className="bg-white rounded-2xl border border-slate-200 p-5"
      aria-labelledby="layout-settings-heading"
    >
      <h2
        id="layout-settings-heading"
        className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2"
      >
        <span className="w-6 h-6 rounded-lg bg-violet-50 flex items-center justify-center text-violet-600">
          <Layout className="w-3.5 h-3.5" aria-hidden="true" />
        </span>
        Layout
      </h2>
      <p className="text-xs text-slate-500 leading-relaxed">
        Choose how your desktop dashboard is arranged. Changes sync to your account and apply
        right away.
      </p>

      {/* Preset cards — radiogroup so arrow keys move between options. */}
      <div
        role="radiogroup"
        aria-label="Dashboard layout preset"
        className="mt-4 grid gap-3 sm:grid-cols-3"
      >
        {PRESETS.map((p) => {
          const active = p.id === activePreset;
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choosePreset(p.id)}
              className={
                'group relative flex flex-col rounded-xl border p-3 text-left transition-all ' +
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ' +
                (active
                  ? 'border-blue-500 ring-1 ring-blue-500/30 bg-blue-50/40'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50')
              }
            >
              {active && (
                <span
                  className="absolute top-2 right-2 w-4 h-4 rounded-full bg-blue-500 text-white flex items-center justify-center"
                  aria-hidden="true"
                >
                  <Check className="w-3 h-3" />
                </span>
              )}
              <div className="h-12 w-full rounded-lg bg-slate-100/70 border border-slate-200/70 p-1.5">
                <PresetPreview preset={p.id} />
              </div>
              <div className="mt-2.5 flex items-center gap-1.5">
                <Icon className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                <span className="text-xs font-semibold text-slate-800">{p.name}</span>
              </div>
              <span className="mt-1 text-[11px] leading-snug text-slate-500">{p.desc}</span>
            </button>
          );
        })}
      </div>

      {/* Live status — polite so screen readers announce save results. */}
      <p className="mt-2 text-[11px] h-4" role="status" aria-live="polite">
        {status === 'saving' && <span className="text-slate-400">Saving…</span>}
        {status === 'saved' && <span className="text-emerald-600">Layout saved</span>}
        {status === 'error' && (
          <span className="text-red-600">Couldn&apos;t save — check your connection and try again</span>
        )}
      </p>

      {/* ---- Per-module display options (D2) --------------------------------
          Editing any control below flips the preset to Custom. Grouped one
          card per module; options are the full Phase-A set, nothing more. */}
      <div className="mt-4 pt-4 border-t border-slate-100">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-3">
          Display options
        </h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Notifications */}
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-700 mb-1.5">
              {MODULE_LABELS.notifications}
            </p>
            <Toggle
              label="Show module"
              checked={get('notifications').visible}
              onChange={(v) => editModule('notifications', { visible: v })}
            />
            <Segmented
              label="Style"
              value={(get('notifications') as Extract<ModuleConfig, { id: 'notifications' }>).variant}
              options={[
                { value: 'strip', label: 'Strip' },
                { value: 'feed', label: 'Feed' },
              ]}
              onChange={(v) => editModule('notifications', { variant: v } as Partial<ModuleConfig>)}
            />
          </div>

          {/* Quick Dial */}
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-700 mb-1.5">
              {MODULE_LABELS.quickdial}
            </p>
            <Toggle
              label="Show module"
              checked={get('quickdial').visible}
              onChange={(v) => editModule('quickdial', { visible: v })}
            />
            <Segmented
              label="Layout"
              value={(get('quickdial') as Extract<ModuleConfig, { id: 'quickdial' }>).variant}
              options={[
                { value: 'grid', label: 'Grid' },
                { value: 'list', label: 'List' },
              ]}
              onChange={(v) => editModule('quickdial', { variant: v } as Partial<ModuleConfig>)}
            />
            <Toggle
              label="Show favorites"
              checked={
                (get('quickdial') as Extract<ModuleConfig, { id: 'quickdial' }>).options.showFavorites
              }
              onChange={(v) =>
                editModule('quickdial', {
                  options: { showFavorites: v },
                } as Partial<ModuleConfig>)
              }
            />
          </div>

          {/* Recent Calls */}
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-700 mb-1.5">
              {MODULE_LABELS.recentcalls}
            </p>
            <Toggle
              label="Show module"
              checked={get('recentcalls').visible}
              onChange={(v) => editModule('recentcalls', { visible: v })}
            />
            <Segmented
              label="Detail"
              value={(get('recentcalls') as Extract<ModuleConfig, { id: 'recentcalls' }>).variant}
              options={[
                { value: 'detailed', label: 'Detailed' },
                { value: 'minimal', label: 'Minimal' },
              ]}
              onChange={(v) => editModule('recentcalls', { variant: v } as Partial<ModuleConfig>)}
            />
            <Toggle
              label="Show call duration"
              checked={
                (get('recentcalls') as Extract<ModuleConfig, { id: 'recentcalls' }>).options
                  .showDuration
              }
              onChange={(v) =>
                editModule('recentcalls', {
                  options: {
                    showDuration: v,
                    showTimestamps: (get('recentcalls') as Extract<
                      ModuleConfig,
                      { id: 'recentcalls' }
                    >).options.showTimestamps,
                  },
                } as Partial<ModuleConfig>)
              }
            />
            <Toggle
              label="Show timestamps"
              checked={
                (get('recentcalls') as Extract<ModuleConfig, { id: 'recentcalls' }>).options
                  .showTimestamps
              }
              onChange={(v) =>
                editModule('recentcalls', {
                  options: {
                    showDuration: (get('recentcalls') as Extract<
                      ModuleConfig,
                      { id: 'recentcalls' }
                    >).options.showDuration,
                    showTimestamps: v,
                  },
                } as Partial<ModuleConfig>)
              }
            />
          </div>

          {/* Conversations / threads */}
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="text-xs font-semibold text-slate-700 mb-1.5">
              {MODULE_LABELS.threads}
            </p>
            <Toggle
              label="Show module"
              checked={get('threads').visible}
              onChange={(v) => editModule('threads', { visible: v })}
            />
            <Segmented
              label="Preview lines"
              value={String(
                (get('threads') as Extract<ModuleConfig, { id: 'threads' }>).previewLines
              )}
              options={[
                { value: '0', label: 'None' },
                { value: '1', label: '1' },
                { value: '2', label: '2' },
              ]}
              onChange={(v) =>
                editModule('threads', {
                  previewLines: Number(v) as 0 | 1 | 2,
                } as Partial<ModuleConfig>)
              }
            />
            <Toggle
              label="Show avatars"
              checked={
                (get('threads') as Extract<ModuleConfig, { id: 'threads' }>).options.showAvatars
              }
              onChange={(v) =>
                editModule('threads', {
                  options: {
                    showAvatars: v,
                    showUnreadBadges: (get('threads') as Extract<
                      ModuleConfig,
                      { id: 'threads' }
                    >).options.showUnreadBadges,
                  },
                } as Partial<ModuleConfig>)
              }
            />
            <Toggle
              label="Show unread badges"
              checked={
                (get('threads') as Extract<ModuleConfig, { id: 'threads' }>).options.showUnreadBadges
              }
              onChange={(v) =>
                editModule('threads', {
                  options: {
                    showAvatars: (get('threads') as Extract<
                      ModuleConfig,
                      { id: 'threads' }
                    >).options.showAvatars,
                    showUnreadBadges: v,
                  },
                } as Partial<ModuleConfig>)
              }
            />
          </div>
        </div>
        <p className="mt-3 text-[11px] text-slate-400 leading-relaxed">
          Reordering modules by dragging is coming next. For now, presets set the arrangement and
          these options fine-tune each module.
        </p>
      </div>
    </section>
  );
}
