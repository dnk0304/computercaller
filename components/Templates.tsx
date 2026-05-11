'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Edit2, Copy, Trash2, X, Check, FileText } from 'lucide-react';
import { clsx } from 'clsx';

interface Template {
  id: string;       // Date.now().toString(36)
  name: string;
  body: string;     // multiline; preserved with \n
  createdAt: number;
}

const STORAGE_KEY = 'dnkdialer_templates';

// SSR-safe initial load. We can't read localStorage during SSR, so fall back to [].
function loadTemplates(): Template[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const PREVIEW_MAX = 60;
function previewBody(body: string): string {
  // Collapse newlines so the one-line preview stays a single line, then truncate.
  const oneLine = body.replace(/\s*\n\s*/g, ' ').trim();
  return oneLine.length > PREVIEW_MAX ? oneLine.slice(0, PREVIEW_MAX) + '…' : oneLine;
}

const PLACEHOLDER_BODY = `Hi [name],\n\nThanks for reaching out. I'll get back to you shortly.\n\nBest,\n[your name]`;

export const Templates = () => {
  const [templates, setTemplates] = useState<Template[]>(loadTemplates);
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form fields — separate from `editingTemplate` so we don't mutate the source until Save.
  const [formName, setFormName] = useState('');
  const [formBody, setFormBody] = useState('');

  // Inline delete confirmation: hold the id of the template currently in the "click to confirm" state.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const pendingDeleteTimerRef = useRef<number | null>(null);

  // Toast feedback for Copy.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  // Persist to localStorage on every change.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    } catch {
      // Storage quota or disabled — silently ignore; UI still works in-session.
    }
  }, [templates]);

  // Cleanup any timers on unmount.
  useEffect(() => {
    return () => {
      if (pendingDeleteTimerRef.current !== null) window.clearTimeout(pendingDeleteTimerRef.current);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  const sortedTemplates = useMemo(
    () => [...templates].sort((a, b) => b.createdAt - a.createdAt),
    [templates]
  );

  // ----- Form open / close -----
  const openNewForm = () => {
    setEditingTemplate(null);
    setFormName('');
    setFormBody('');
    setShowForm(true);
  };

  const openEditForm = (t: Template) => {
    setEditingTemplate(t);
    setFormName(t.name);
    setFormBody(t.body);
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingTemplate(null);
    setFormName('');
    setFormBody('');
  };

  // ----- Save handler -----
  const handleSave = () => {
    const name = formName.trim();
    const body = formBody; // preserve leading/trailing whitespace inside body? Trim only the name.
    if (!name || !body.trim()) return;

    if (editingTemplate) {
      setTemplates(prev =>
        prev.map(t => (t.id === editingTemplate.id ? { ...t, name, body } : t))
      );
    } else {
      const newTemplate: Template = {
        id: Date.now().toString(36),
        name,
        body,
        createdAt: Date.now(),
      };
      setTemplates(prev => [newTemplate, ...prev]);
    }
    closeForm();
  };

  // ----- Delete with inline confirmation -----
  const handleDeleteClick = (id: string) => {
    if (pendingDeleteId === id) {
      // Confirm: actually delete.
      setTemplates(prev => prev.filter(t => t.id !== id));
      setPendingDeleteId(null);
      if (pendingDeleteTimerRef.current !== null) {
        window.clearTimeout(pendingDeleteTimerRef.current);
        pendingDeleteTimerRef.current = null;
      }
      return;
    }
    // First click: arm the confirmation, auto-disarm after 3s.
    setPendingDeleteId(id);
    if (pendingDeleteTimerRef.current !== null) {
      window.clearTimeout(pendingDeleteTimerRef.current);
    }
    pendingDeleteTimerRef.current = window.setTimeout(() => {
      setPendingDeleteId(null);
      pendingDeleteTimerRef.current = null;
    }, 3000);
  };

  // ----- Copy with toast -----
  const handleCopy = async (t: Template) => {
    try {
      await navigator.clipboard.writeText(t.body);
      setCopiedId(t.id);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopiedId(null);
        copyTimerRef.current = null;
      }, 1800);
    } catch {
      // Clipboard API can fail in insecure contexts; silently no-op.
    }
  };

  return (
    <div className="h-full p-6 overflow-y-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-slate-800">Message Templates</h2>
          <p className="text-slate-500">Manage your quick responses</p>
        </div>
        <button
          onClick={openNewForm}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-xl hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all hover:-translate-y-0.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
        >
          <Plus className="w-5 h-5" aria-hidden="true" />
          <span>New Template</span>
        </button>
      </div>

      {sortedTemplates.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-16 h-16 bg-slate-100 rounded-full flex items-center justify-center mb-4 text-slate-400">
            <FileText className="w-8 h-8" aria-hidden="true" />
          </div>
          <h3 className="text-lg font-semibold text-slate-700">No templates yet</h3>
          <p className="text-sm text-slate-500 mt-1 max-w-sm">
            Create a template to quickly insert frequently used messages.
          </p>
          <button
            onClick={openNewForm}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
          >
            <Plus className="w-4 h-4" aria-hidden="true" />
            Create your first template
          </button>
        </div>
      ) : (
        <ul className="space-y-2">
          {sortedTemplates.map(template => {
            const isPendingDelete = pendingDeleteId === template.id;
            const justCopied = copiedId === template.id;
            return (
              <li
                key={template.id}
                className="group bg-white rounded-2xl border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all p-4 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold text-slate-800 text-sm truncate">{template.name}</h3>
                  <p className="text-xs text-slate-500 truncate mt-0.5">{previewBody(template.body)}</p>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => openEditForm(template)}
                    className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
                    title={`Edit ${template.name}`}
                    aria-label={`Edit ${template.name}`}
                  >
                    <Edit2 className="w-4 h-4" aria-hidden="true" />
                  </button>

                  <button
                    onClick={() => handleCopy(template)}
                    className={clsx(
                      'p-2 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40',
                      justCopied
                        ? 'text-emerald-600 bg-emerald-50'
                        : 'text-slate-400 hover:text-emerald-600 hover:bg-emerald-50'
                    )}
                    title={justCopied ? 'Copied!' : `Copy ${template.name}`}
                    aria-label={justCopied ? 'Copied' : `Copy ${template.name}`}
                  >
                    {justCopied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                  </button>

                  <button
                    onClick={() => handleDeleteClick(template.id)}
                    className={clsx(
                      'flex items-center gap-1 px-2 py-2 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500/40',
                      isPendingDelete
                        ? 'bg-rose-600 text-white hover:bg-rose-700'
                        : 'text-slate-400 hover:text-rose-600 hover:bg-rose-50'
                    )}
                    title={isPendingDelete ? 'Click again to confirm delete' : `Delete ${template.name}`}
                    aria-label={isPendingDelete ? `Confirm delete ${template.name}` : `Delete ${template.name}`}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                    {isPendingDelete && <span className="text-xs font-medium">Confirm</span>}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Inline "Copied!" toast — anchored bottom-right of viewport */}
      {copiedId !== null && typeof document !== 'undefined' && createPortal(
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 right-6 z-[400] flex items-center gap-2 px-4 py-2 bg-slate-900 text-white text-sm font-medium rounded-lg shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200"
        >
          <Check className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          Copied to clipboard
        </div>,
        document.body
      )}

      {/* Form Modal — portal, z-index 300, Escape to close */}
      {showForm && (
        <TemplateFormModal
          isEditing={editingTemplate !== null}
          name={formName}
          body={formBody}
          onChangeName={setFormName}
          onChangeBody={setFormBody}
          onSave={handleSave}
          onCancel={closeForm}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Modal — separate component keeps autofocus + escape handling self-contained.
// ---------------------------------------------------------------------------

interface TemplateFormModalProps {
  isEditing: boolean;
  name: string;
  body: string;
  onChangeName: (v: string) => void;
  onChangeBody: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

function TemplateFormModal({
  isEditing,
  name,
  body,
  onChangeName,
  onChangeBody,
  onSave,
  onCancel,
}: TemplateFormModalProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Escape closes; lock body scroll while modal is open.
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

  // Autofocus the name field when the modal opens.
  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const canSave = name.trim().length > 0 && body.trim().length > 0;

  // SSR safety — never render the portal during SSR.
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-in fade-in duration-150"
      onClick={(e) => {
        // Click outside the modal panel = cancel.
        if (e.target === e.currentTarget) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-modal-title"
    >
      <div className="bg-white w-full max-w-lg rounded-2xl shadow-2xl border border-slate-200 flex flex-col max-h-[90vh] animate-in fade-in zoom-in-95 slide-in-from-bottom-4 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100">
          <h3 id="template-modal-title" className="font-semibold text-slate-800">
            {isEditing ? 'Edit Template' : 'New Template'}
          </h3>
          <button
            onClick={onCancel}
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
            aria-label="Close"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4 overflow-y-auto">
          <div>
            <label htmlFor="template-name" className="block text-xs font-semibold text-slate-700 mb-1.5">
              Name
            </label>
            <input
              ref={nameInputRef}
              id="template-name"
              type="text"
              value={name}
              onChange={(e) => onChangeName(e.target.value)}
              placeholder="e.g. Meeting reminder"
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors"
            />
          </div>

          <div>
            <label htmlFor="template-body" className="block text-xs font-semibold text-slate-700 mb-1.5">
              Body
            </label>
            <textarea
              id="template-body"
              value={body}
              onChange={(e) => onChangeBody(e.target.value)}
              placeholder={PLACEHOLDER_BODY}
              rows={6}
              style={{ whiteSpace: 'pre-wrap', resize: 'vertical' }}
              className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition-colors font-mono leading-relaxed min-h-[160px]"
            />
            <p className="text-[11px] text-slate-400 mt-1.5">
              Line breaks and blank lines are preserved exactly as you type them.
            </p>
          </div>
        </div>

        {/* Footer */}
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
            className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
          >
            <Check className="w-4 h-4" aria-hidden="true" />
            {isEditing ? 'Save changes' : 'Create template'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
