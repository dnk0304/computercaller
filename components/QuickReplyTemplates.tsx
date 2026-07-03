'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Edit2, Trash2, X, Check, MessageSquareReply, Sparkles, ArrowRight } from 'lucide-react';
import { clsx } from 'clsx';
import { useQuickReplyTemplates } from '@/hooks/useQuickReplyTemplates';
import type { QuickReplyTemplateDTO } from '@/lib/quickReplyTemplates';

// Dispatch CC-quickreply-templates-mgmt-v2 (2026-06-03, Pixel) — management
// sub-section for the SEPARATE quick-reply store. Rendered inside
// `components/Templates.tsx` below the SMS-templates list, visually divided.
//
// CRUD parity with the SMS-templates manager (style match, NOT state share):
//   - card-row list with edit / delete affordances + inline delete confirm
//   - modal form for create / edit with autofocus + Escape-to-close
//   - X / 5 count line; New button disabled at cap with a calm slate notice
//   - server-side 409 from a race is caught and shown with the same message
//
// Differences vs SMS templates:
//   - "Name" -> "Label (optional)" — the body is the SMS that gets sent on a
//     ringing-state chip tap; the label is just the chip text shown when set.
//     If label is null, the chip falls back to the body. Mirrors the chip
//     fallback in CallSessionView so they stay visually consistent.
//   - distinct DTO + endpoint; no carryover-import legacy path.
//   - distinct broadcast event (`cc:quickreplies-changed`) so the SMS-template
//     store doesn't refetch when this one mutates and vice versa.

const PREVIEW_MAX = 60;
function previewBody(body: string): string {
  const oneLine = body.replace(/\s*\n\s*/g, ' ').trim();
  return oneLine.length > PREVIEW_MAX ? oneLine.slice(0, PREVIEW_MAX) + '…' : oneLine;
}

const PLACEHOLDER_BODY = "Can't talk right now — I'll call you back.";

export function QuickReplyTemplates() {
  const { quickReplies, loading, count, atCap, limit, create, update, remove } =
    useQuickReplyTemplates();

  const [editingItem, setEditingItem] = useState<QuickReplyTemplateDTO | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const [formLabel, setFormLabel] = useState('');
  const [formBody, setFormBody] = useState('');

  const capMessage = `You've reached the maximum of ${limit} quick replies. Delete one to add another.`;
  const [showCapNotice, setShowCapNotice] = useState(false);

  // Same split as the SMS-templates manager: trial cap (limit <= 3, here 1) gets
  // the blue "subscribe for unlimited" nudge; the paying 5-cap gets the calm
  // slate "delete one" message with no CTA. See Templates.tsx for the rationale.
  const capReached = atCap || showCapNotice;
  const showUpgradeNudge = capReached && limit <= 3;
  const nudgeNoun = count === 1 ? 'quick reply' : 'quick replies';

  // Inline delete confirmation: hold the id of the item in "click to confirm" state.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingDeleteTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pendingDeleteTimerRef.current !== null) window.clearTimeout(pendingDeleteTimerRef.current);
    };
  }, []);

  const openNewForm = () => {
    if (atCap) {
      setShowCapNotice(true);
      return;
    }
    setShowCapNotice(false);
    setEditingItem(null);
    setFormLabel('');
    setFormBody('');
    setShowForm(true);
  };

  const openEditForm = (q: QuickReplyTemplateDTO) => {
    setEditingItem(q);
    setFormLabel(q.label ?? '');
    setFormBody(q.body);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingItem(null);
    setFormLabel('');
    setFormBody('');
  };

  const handleSave = async () => {
    const body = formBody.trim();
    if (!body || saving) return;
    // label: trim; clear-to-null when emptied. Forge's PUT accepts null.
    const labelInput = formLabel.trim();
    const label: string | null = labelInput.length > 0 ? labelInput : null;

    setSaving(true);
    try {
      if (editingItem) {
        // Only send fields that changed — keeps the PUT minimal and avoids
        // accidentally clobbering a sortOrder we haven't surfaced.
        const fields: { body?: string; label?: string | null } = {};
        if (body !== editingItem.body) fields.body = body;
        if (label !== editingItem.label) fields.label = label;
        if (Object.keys(fields).length === 0) {
          closeForm();
          return;
        }
        const updated = await update(editingItem.id, fields);
        if (updated) closeForm();
        // On failure (null) keep the modal open so the user can retry.
      } else {
        const result = await create(body, label);
        if (result === 'limit') {
          // 409 race: another tab created the 5th.
          closeForm();
          setShowCapNotice(true);
        } else if (result) {
          closeForm();
        }
        // null (other failure) → keep the modal open for retry.
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (id: string) => {
    if (pendingDeleteId === id) {
      void remove(id);
      setShowCapNotice(false);
      setPendingDeleteId(null);
      if (pendingDeleteTimerRef.current !== null) {
        window.clearTimeout(pendingDeleteTimerRef.current);
        pendingDeleteTimerRef.current = null;
      }
      return;
    }
    setPendingDeleteId(id);
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
    }
    pendingDeleteTimerRef.current = window.setTimeout(() => {
      setPendingDeleteId(null);
      pendingDeleteTimerRef.current = null;
    }, 3000);
  };

  return (
    <section
      // Visually divided from the SMS-templates list above: top border on the
      // whole section, headline + helper, then the list. Same content-rhythm
      // as the SMS list but a distinct top rule so the eye reads "new section".
      aria-labelledby="quick-reply-templates-heading"
      className="mt-12 pt-8 border-t border-slate-200"
    >
      <div className="flex justify-between items-start mb-6 gap-4">
        <div>
          <h2
            id="quick-reply-templates-heading"
            className="text-2xl font-bold text-slate-800"
          >
            Quick message reply templates
          </h2>
          <p className="text-slate-500 mt-1 max-w-xl">
            Up to {limit} short messages you can send to reject an incoming call.
            Used only on incoming calls — not in your regular messages.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
          <button
            onClick={openNewForm}
            disabled={atCap || loading}
            aria-describedby={atCap ? 'quick-reply-cap-notice' : undefined}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0 disabled:hover:bg-blue-600 disabled:shadow-none"
          >
            <Plus className="w-5 h-5" aria-hidden="true" />
            <span>New quick reply</span>
          </button>
          {!loading && (
            <p
              className="text-xs font-medium text-slate-400 tabular-nums"
              aria-live="polite"
            >
              {count} / {limit} quick replies
            </p>
          )}
        </div>
      </div>

      {capReached && (
        showUpgradeNudge ? (
          <div
            id="quick-reply-cap-notice"
            role="status"
            className="mb-6 flex flex-col gap-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-2.5">
              <Sparkles className="mt-0.5 h-4 w-4 flex-shrink-0 text-blue-600" aria-hidden="true" />
              <p className="text-sm text-blue-900">
                <span className="font-semibold tabular-nums">
                  {count}/{limit} {nudgeNoun} used
                </span>
                {' — subscribe for unlimited.'}
              </p>
            </div>
            <a
              href="/subscribe"
              className="inline-flex flex-shrink-0 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
            >
              Subscribe
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        ) : (
          <div
            id="quick-reply-cap-notice"
            role="status"
            className="mb-6 flex items-start gap-2.5 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600"
          >
            <MessageSquareReply
              className="mt-0.5 h-4 w-4 flex-shrink-0 text-slate-400"
              aria-hidden="true"
            />
            <span>{capMessage}</span>
          </div>
        )
      )}

      {loading ? (
        <div
          className="flex flex-col items-center justify-center py-12 text-center"
          role="status"
          aria-live="polite"
        >
          <div
            className="h-8 w-8 rounded-full border-2 border-slate-200 border-t-blue-500 motion-safe:animate-spin"
            aria-hidden="true"
          />
          <p className="mt-4 text-sm text-slate-400">Loading your quick replies…</p>
        </div>
      ) : quickReplies.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-400">
            <MessageSquareReply className="w-8 h-8" aria-hidden="true" />
          </div>
          <h3 className="text-lg font-semibold text-slate-700">No quick replies yet</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-sm">
            Add up to {limit} short messages. When a call comes in, tap one to
            send it and decline in a single step.
          </p>
          <button
            onClick={openNewForm}
            disabled={atCap}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-blue-600"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            Create your first quick reply
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {quickReplies.map((qr) => {
            const isPendingDelete = pendingDeleteId === qr.id;
            const labelText = qr.label ?? previewBody(qr.body);
            return (
              <li
                key={qr.id}
                className="group bg-white rounded-2xl border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all p-4 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-slate-800 text-sm truncate">
                    {labelText}
                  </h3>
                  {qr.label && (
                    <p className="text-xs text-slate-500 truncate mt-0.5">
                      {previewBody(qr.body)}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => openEditForm(qr)}
                    className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    title={`Edit ${labelText}`}
                    aria-label={`Edit ${labelText}`}
                  >
                    <Edit2 className="w-4 h-4" aria-hidden="true" />
                  </button>

                  <button
                    onClick={() => handleDeleteClick(qr.id)}
                    className={clsx(
                      'flex items-center gap-1 px-2 py-2 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40',
                      isPendingDelete
                        ? 'bg-rose-600 text-white hover:bg-rose-700'
                        : 'text-slate-400 hover:text-rose-600 hover:bg-rose-50',
                    )}
                    title={
                      isPendingDelete
                        ? 'Click again to confirm delete'
                        : `Delete ${labelText}`
                    }
                    aria-label={
                      isPendingDelete
                        ? `Confirm delete ${labelText}`
                        : `Delete ${labelText}`
                    }
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                    {isPendingDelete && (
                      <span className="text-xs font-medium">Confirm</span>
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {showForm && (
        <QuickReplyFormModal
          isEditing={editingItem !== null}
          label={formLabel}
          body={formBody}
          saving={saving}
          onChangeLabel={setFormLabel}
          onChangeBody={setFormBody}
          onSave={handleSave}
          onCancel={closeForm}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Modal — separate component keeps autofocus + escape handling self-contained.
// Mirrors TemplateFormModal but uses "Label (optional)" and a shorter body
// textarea since these are single-line-ish SMS replies, not multi-paragraph
// templates.
// ---------------------------------------------------------------------------

interface QuickReplyFormModalProps {
  isEditing: boolean;
  label: string;
  body: string;
  saving: boolean;
  onChangeLabel: (v: string) => void;
  onChangeBody: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function QuickReplyFormModal({
  isEditing,
  label,
  body,
  saving,
  onChangeLabel,
  onChangeBody,
  onSave,
  onCancel,
}: QuickReplyFormModalProps) {
  // Body is the required field — autofocus there. Label is optional and the
  // most-common case is "label-less = body shown on chip", so leading the
  // user straight to the body is the lower-friction default.
  const bodyInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onCancel]);

  useEffect(() => {
    bodyInputRef.current?.focus();
  }, []);

  const canSave = body.trim().length > 0 && !saving;

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-reply-modal-title"
    >
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 id="quick-reply-modal-title" className="font-semibold text-slate-800">
            {isEditing ? 'Edit quick reply' : 'New quick reply'}
          </h3>
          <button
            onClick={onCancel}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            aria-label="Close"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <div>
            <label
              htmlFor="quick-reply-body"
              className="block text-xs font-semibold text-slate-700 mb-1.5"
            >
              Message
            </label>
            <textarea
              ref={bodyInputRef}
              id="quick-reply-body"
              value={body}
              onChange={(e) => onChangeBody(e.target.value)}
              placeholder={PLACEHOLDER_BODY}
              rows={3}
              style={{ whiteSpace: 'pre-wrap', resize: 'vertical' }}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors leading-relaxed min-h-[88px]"
            />
            <p className="text-[11px] text-slate-400 mt-1.5">
              The text that gets sent to the caller when you tap this chip on an incoming call.
            </p>
          </div>

          <div>
            <label
              htmlFor="quick-reply-label"
              className="block text-xs font-semibold text-slate-700 mb-1.5"
            >
              Label <span className="font-normal text-slate-400">(optional)</span>
            </label>
            <input
              id="quick-reply-label"
              type="text"
              value={label}
              onChange={(e) => onChangeLabel(e.target.value)}
              placeholder="e.g. In a meeting"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors"
            />
            <p className="text-[11px] text-slate-400 mt-1.5">
              Short text shown on the chip. If empty, the chip shows the message itself.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-slate-100 bg-slate-50/50">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/40"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!canSave}
            aria-busy={saving}
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          >
            {saving ? (
              <span
                className="h-4 w-4 rounded-full border-2 border-white/40 border-t-white motion-safe:animate-spin"
                aria-hidden="true"
              />
            ) : (
              <Check className="w-4 h-4" aria-hidden="true" />
            )}
            {saving ? 'Saving…' : isEditing ? 'Save changes' : 'Create quick reply'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
