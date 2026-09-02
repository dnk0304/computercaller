'use client';

// ---------------------------------------------------------------------------
// LayoutSettings — the desktop dashboard "Layout" section of Settings.
//
// UX model (dispatch pixel/layout-editor-fix, 2026-09-02):
//   Settings shows a compact summary of the active layout + an "Edit layout"
//   button. Clicking it opens a MODAL EDITOR with two halves:
//     • a LIVE PREVIEW mockup of the dashboard (DashboardLayoutPreview), and
//     • the controls (preset cards + per-module display options).
//   All edits mutate a local DRAFT only — the preview updates in real time as
//   the user changes preset / variant / visibility / density. "Save changes"
//   persists the draft (useLayoutPrefs.savePrefs → optimistic local + PUT) and
//   applies it to the real dashboard; "Cancel" (button / Esc / backdrop)
//   discards the draft. Nothing is written until Save.
//
// WHY this replaced the old always-inline, instant-persist section: from
// /app/settings you can't see the /app dashboard, so instant saves produced no
// visible feedback and read as "not working". The preview is the feedback.
//
// Dennis decisions honored: D1 (Phone Link is inspired-by, single-focus — not a
// clone), D2 (richer per-module options), D4 (presets first, no drag yet),
// D5 (desktop dashboard only). Existing power-user default is untouched until a
// user opens this editor and saves a change.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Layout, Smartphone, SlidersHorizontal, Check, X, Eye } from 'lucide-react';
import { useLayoutPrefs } from '@/hooks';
import {
  presetDefault,
  type LayoutPreset,
  type LayoutPrefs,
  type ModuleConfig,
  type ModuleId,
} from '@/lib/layoutPrefs';
import { DashboardLayoutPreview } from '@/components/DashboardLayoutPreview';

type Resolved = Required<LayoutPrefs>;

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

const PRESET_LABEL: Record<LayoutPreset, string> = {
  power: 'Power user',
  phonelink: 'Phone Link',
  custom: 'Custom',
};

// Human labels for the four modules.
const MODULE_LABELS: Record<ModuleId, string> = {
  notifications: 'Notifications',
  quickdial: 'Quick Dial',
  recentcalls: 'Recent Calls',
  threads: 'Conversations',
};

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

// ---- Controls panel (operates on the DRAFT) --------------------------------
// Pure controlled component: reads the draft, emits new drafts. No persistence.

function LayoutControls({
  draft,
  onDraftChange,
}: {
  draft: Resolved;
  onDraftChange: (next: Resolved) => void;
}) {
  const get = (id: ModuleId) => draft.modules.find((m) => m.id === id)!;

  function choosePreset(preset: LayoutPreset) {
    if (preset === 'custom') {
      // "Custom" without edits = the current arrangement, re-labelled.
      onDraftChange({ version: 1, preset: 'custom', modules: draft.modules });
      return;
    }
    onDraftChange(presetDefault(preset));
  }

  // Apply a partial edit to one module, flip to 'custom'. The discriminated
  // union makes a generic merge awkward, so we cast the patch — callers only
  // ever pass fields valid for that module id.
  function editModule(id: ModuleId, patch: Partial<ModuleConfig>) {
    const modules = draft.modules.map((m) =>
      m.id === id ? ({ ...m, ...patch } as ModuleConfig) : m
    );
    onDraftChange({ version: 1, preset: 'custom', modules });
  }

  return (
    <div>
      {/* Preset cards — radiogroup so arrow keys move between options. */}
      <div
        role="radiogroup"
        aria-label="Dashboard layout preset"
        className="grid gap-2"
      >
        {PRESETS.map((p) => {
          const active = p.id === draft.preset;
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => choosePreset(p.id)}
              className={
                'group relative flex items-start gap-2.5 rounded-xl border p-2.5 text-left transition-all ' +
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ' +
                (active
                  ? 'border-blue-500 ring-1 ring-blue-500/30 bg-blue-50/40'
                  : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50')
              }
            >
              <span
                className={
                  'mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg ' +
                  (active ? 'bg-blue-100 text-blue-600' : 'bg-slate-100 text-slate-500')
                }
                aria-hidden="true"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-slate-800">{p.name}</span>
                  {active && (
                    <span
                      className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-500 text-white"
                      aria-hidden="true"
                    >
                      <Check className="h-2.5 w-2.5" />
                    </span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-slate-500">
                  {p.desc}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ---- Per-module display options (D2) ------------------------------ */}
      <div className="mt-4 border-t border-slate-100 pt-4">
        <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Display options
        </h3>
        <div className="grid gap-3">
          {/* Notifications */}
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="mb-1.5 text-xs font-semibold text-slate-700">
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
            <p className="mb-1.5 text-xs font-semibold text-slate-700">{MODULE_LABELS.quickdial}</p>
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
                editModule('quickdial', { options: { showFavorites: v } } as Partial<ModuleConfig>)
              }
            />
          </div>

          {/* Recent Calls */}
          <div className="rounded-xl border border-slate-200 p-3">
            <p className="mb-1.5 text-xs font-semibold text-slate-700">
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
                (get('recentcalls') as Extract<ModuleConfig, { id: 'recentcalls' }>).options.showDuration
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
                (get('recentcalls') as Extract<ModuleConfig, { id: 'recentcalls' }>).options.showTimestamps
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
            <p className="mb-1.5 text-xs font-semibold text-slate-700">{MODULE_LABELS.threads}</p>
            <Toggle
              label="Show module"
              checked={get('threads').visible}
              onChange={(v) => editModule('threads', { visible: v })}
            />
            <Segmented
              label="Preview lines"
              value={String((get('threads') as Extract<ModuleConfig, { id: 'threads' }>).previewLines)}
              options={[
                { value: '0', label: 'None' },
                { value: '1', label: '1' },
                { value: '2', label: '2' },
              ]}
              onChange={(v) =>
                editModule('threads', { previewLines: Number(v) as 0 | 1 | 2 } as Partial<ModuleConfig>)
              }
            />
            <Toggle
              label="Show avatars"
              checked={(get('threads') as Extract<ModuleConfig, { id: 'threads' }>).options.showAvatars}
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
        <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
          Reordering modules by dragging is coming next. For now, presets set the arrangement and
          these options fine-tune each module.
        </p>
      </div>
    </div>
  );
}

// ---- The modal editor ------------------------------------------------------

function LayoutEditorModal({
  initial,
  onSave,
  onClose,
}: {
  initial: Resolved;
  onSave: (draft: Resolved) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Resolved>(initial);
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Focus management + body scroll lock + Esc to cancel.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  async function handleSave() {
    setStatus('saving');
    const ok = await onSave(draft);
    if (ok) {
      onClose();
    } else {
      setStatus('error');
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-3 sm:p-6"
      role="presentation"
    >
      {/* backdrop */}
      <button
        type="button"
        aria-label="Cancel and close layout editor"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
      />

      {/* dialog */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="layout-editor-title"
        tabIndex={-1}
        className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl focus:outline-none"
      >
        {/* header */}
        <div className="flex flex-shrink-0 items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 id="layout-editor-title" className="text-base font-bold text-slate-800">
              Edit layout
            </h2>
            <p className="mt-0.5 text-xs text-slate-500">
              Preview how your dashboard will look, then save when it&apos;s right.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancel and close layout editor"
            className="flex-shrink-0 rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* body: preview (left) + controls (right); stacks on mobile */}
        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[1.15fr_1fr]">
          {/* Live preview */}
          <div className="flex min-h-0 flex-col gap-2 border-b border-slate-100 bg-slate-50/60 p-4 md:border-b-0 md:border-r">
            <div className="flex flex-shrink-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              Live preview — before you save
            </div>
            <div className="min-h-[220px] flex-1 md:min-h-0">
              <div className="mx-auto h-full w-full" style={{ aspectRatio: '16 / 10' }}>
                <DashboardLayoutPreview prefs={draft} />
              </div>
            </div>
            <p className="flex-shrink-0 text-[11px] leading-relaxed text-slate-400">
              A structural preview with placeholder content — your real calls and messages appear on
              the actual dashboard. Now showing:{' '}
              <span className="font-medium text-slate-500">{PRESET_LABEL[draft.preset]}</span>.
            </p>
          </div>

          {/* Controls */}
          <div className="min-h-0 overflow-y-auto p-4">
            <LayoutControls draft={draft} onDraftChange={setDraft} />
          </div>
        </div>

        {/* footer */}
        <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <p className="mr-auto text-[11px]" role="status" aria-live="polite">
            {status === 'error' && (
              <span className="text-red-600">
                Couldn&apos;t save — check your connection and try again.
              </span>
            )}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={status === 'saving'}
            className="inline-flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-60 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
          >
            {status === 'saving' ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------

export function LayoutSettings() {
  const { resolved, savePrefs } = useLayoutPrefs();
  const [editing, setEditing] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  const handleSave = useCallback(
    async (draft: Resolved) => {
      const ok = await savePrefs(draft);
      if (ok) {
        setSavedFlash(true);
        window.setTimeout(() => setSavedFlash(false), 3000);
      }
      return ok;
    },
    [savePrefs]
  );

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5"
      aria-labelledby="layout-settings-heading"
    >
      <h2
        id="layout-settings-heading"
        className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700"
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-violet-50 text-violet-600">
          <Layout className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
        Layout
      </h2>
      <p className="text-xs leading-relaxed text-slate-500">
        Choose how your desktop dashboard is arranged. Open the editor to preview changes before
        they go live.
      </p>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-slate-500">Current layout</p>
          <p className="text-sm font-semibold text-slate-800">{PRESET_LABEL[resolved.preset]}</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-xl bg-slate-800 px-3.5 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/40"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Edit layout
        </button>
      </div>

      <p className="mt-2 h-4 text-[11px]" role="status" aria-live="polite">
        {savedFlash && <span className="text-emerald-600">Layout saved and applied</span>}
      </p>

      {editing && (
        <LayoutEditorModal
          initial={resolved}
          onSave={handleSave}
          onClose={() => setEditing(false)}
        />
      )}
    </section>
  );
}
