'use client';

// ---------------------------------------------------------------------------
// LayoutSettings — the "Layout" section of the desktop Settings page.
//
// Flow (dispatch pixel/layout-live-preview, 2026-09-02):
//   Collapsed  → a summary of the current layout + an "Edit layout" button.
//   Editing    → a LIVE PREVIEW mockup of the dashboard at the top, then the
//                preset picker + per-module options. Every change updates a
//                local DRAFT and re-renders the preview instantly — nothing is
//                persisted yet. "Save changes" applies the draft to the account
//                (and the real dashboard); "Cancel" discards it.
//
// The preview is driven by resolveLayoutPrefs(draft) — the SAME resolution the
// real Dashboard renders from — so what you see is what you'll get.
//
// Dennis decisions honored: D1 (Phone Link = inspired-by), D2 (per-module
// options), D4 (presets first, no drag-and-drop yet), D5 (desktop only).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { Layout, Smartphone, SlidersHorizontal, Check, Pencil } from 'lucide-react';
import { useLayoutPrefs } from '@/hooks';
import {
  presetDefault,
  resolveLayoutPrefs,
  type LayoutPreset,
  type LayoutPrefs,
  type ModuleConfig,
  type ModuleId,
} from '@/lib/layoutPrefs';
import { DashboardLayoutPreview, describeLayout } from '@/components/DashboardLayoutPreview';

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

// ---------------------------------------------------------------------------

export function LayoutSettings() {
  const { resolved, savePrefs } = useLayoutPrefs();
  const [editing, setEditing] = useState(false);
  // The staged, unsaved layout. Only meaningful while `editing`. Initialised
  // from the live account value each time the editor opens.
  const [draft, setDraft] = useState<LayoutPrefs>(resolved);
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const editorRef = useRef<HTMLDivElement>(null);

  // Resolve the draft the same way the dashboard resolves saved prefs, so the
  // preview and per-module controls always read a complete 4-module list.
  const draftResolved = resolveLayoutPrefs(draft);
  const activePreset = draftResolved.preset;

  function openEditor() {
    setDraft(resolved);
    setStatus('idle');
    setEditing(true);
  }

  function cancelEditor() {
    setEditing(false);
    setStatus('idle');
  }

  const saveEditor = useCallback(async () => {
    setStatus('saving');
    const ok = await savePrefs(draft);
    if (ok) {
      setEditing(false);
      setStatus('idle');
    } else {
      setStatus('error');
    }
  }, [draft, savePrefs]);

  // Move focus into the editor when it opens, and let Escape cancel.
  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  function onEditorKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape' && status !== 'saving') {
      e.stopPropagation();
      cancelEditor();
    }
  }

  function choosePreset(preset: LayoutPreset) {
    if (preset === 'custom') {
      setDraft({ version: 1, preset: 'custom', modules: draftResolved.modules });
      return;
    }
    setDraft(presetDefault(preset));
  }

  // Apply a partial edit to one module in the DRAFT and flip to 'custom'. The
  // discriminated union makes a generic merge awkward, so we cast the patch —
  // callers only ever pass fields valid for that module id.
  function editModule(id: ModuleId, patch: Partial<ModuleConfig>) {
    const modules = draftResolved.modules.map((m) =>
      m.id === id ? ({ ...m, ...patch } as ModuleConfig) : m
    );
    setDraft({ version: 1, preset: 'custom', modules });
  }

  const get = (id: ModuleId) => draftResolved.modules.find((m) => m.id === id)!;
  const saving = status === 'saving';

  return (
    <section
      className="bg-white rounded-2xl border border-slate-200 p-5"
      aria-labelledby="layout-settings-heading"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
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
            Choose how your desktop dashboard is arranged.
          </p>
        </div>

        {!editing && (
          <button
            type="button"
            onClick={openEditor}
            className={
              'flex-shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 ' +
              'text-xs font-semibold text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors ' +
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40'
            }
          >
            <Pencil className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
            Edit layout
          </button>
        )}
      </div>

      {/* -------------------------------------------------------------------
          Collapsed summary — current, saved arrangement at a glance. */}
      {!editing && (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50/50 p-3">
          <DashboardLayoutPreview resolved={resolved} />
          <p className="mt-2 text-[11px] text-slate-500">{describeLayout(resolved)}</p>
        </div>
      )}

      {/* -------------------------------------------------------------------
          Editor — live preview of the DRAFT + controls + Save / Cancel. */}
      {editing && (
        <div
          ref={editorRef}
          tabIndex={-1}
          role="group"
          aria-label="Edit dashboard layout"
          onKeyDown={onEditorKeyDown}
          className="mt-4 outline-none"
        >
          {/* Live preview — the star. Reflects unsaved changes in real time. */}
          <div className="rounded-xl border border-blue-200 bg-blue-50/40 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-600">
                Live preview
              </span>
              <span className="text-[10px] text-blue-500/80">Before you save</span>
            </div>
            <DashboardLayoutPreview resolved={draftResolved} />
            {/* SR-only running description so the change is announced. */}
            <p className="sr-only" role="status" aria-live="polite">
              {describeLayout(draftResolved)}
            </p>
          </div>

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
                  <div className="flex items-center gap-1.5">
                    <Icon className="w-3.5 h-3.5 text-slate-500" aria-hidden="true" />
                    <span className="text-xs font-semibold text-slate-800">{p.name}</span>
                  </div>
                  <span className="mt-1 text-[11px] leading-snug text-slate-500">{p.desc}</span>
                </button>
              );
            })}
          </div>

          {/* ---- Per-module display options (D2) ---------------------------
              Editing any control flips the draft preset to Custom and updates
              the live preview above immediately. */}
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

          {/* Sticky action bar — nothing is saved until "Save changes". */}
          <div className="mt-4 flex items-center justify-end gap-2 border-t border-slate-100 pt-3">
            <p className="mr-auto text-[11px]" role="status" aria-live="polite">
              {status === 'error' && (
                <span className="text-red-600">
                  Couldn&apos;t save — check your connection and try again.
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={cancelEditor}
              disabled={saving}
              className={
                'rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 ' +
                'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 ' +
                'disabled:opacity-40'
              }
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={saveEditor}
              disabled={saving}
              className={
                'rounded-lg bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 ' +
                'transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ' +
                'focus-visible:ring-offset-2 focus-visible:ring-offset-white disabled:opacity-60'
              }
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
