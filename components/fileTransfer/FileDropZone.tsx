'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';

/**
 * components/fileTransfer/FileDropZone.tsx — FT-3b (a). Drag-and-drop onto the
 * panel.
 *
 * ── THE DRAG COUNTER ────────────────────────────────────────────────────────
 * `dragenter`/`dragleave` fire for every element the pointer crosses, so the
 * naive "enter shows, leave hides" flickers the overlay on every child
 * boundary. The fix is a depth counter incremented on enter and decremented on
 * leave, with the overlay shown only at depth > 0. This is the standard fix and
 * it is the reason this component exists at all rather than two inline handlers.
 *
 * ── WHY IT LISTENS ON THE PANEL, NOT window ─────────────────────────────────
 * Scoped to the element it wraps so dragging a file over the rest of the page
 * (or, in the extension, over the host page behind the panel) does not arm a
 * drop target the user is not aiming at. `dragover` must call preventDefault or
 * the browser navigates to the file instead of dropping it — that is the single
 * most common drag-drop bug and it is silent until someone drags a PDF.
 *
 * ── LOCKED AND BUSY STATES ──────────────────────────────────────────────────
 * When the user cannot send — unsubscribed, or a transfer already running — the
 * zone still shows an overlay on drag but refuses the drop with the reason.
 * Silently swallowing a dropped file looks like the app broke.
 *
 * ── ACCESSIBILITY ───────────────────────────────────────────────────────────
 * Drag and drop is a pointer-only interaction and can never be the only path to
 * a feature. It is not: SendFileControl is a real focusable button doing the
 * same job, and this zone is a pure enhancement. The overlay is `aria-hidden`
 * because it narrates a pointer gesture a screen-reader user is not performing.
 */

export interface FileDropZoneProps {
  /** False when the user cannot start a transfer; the drop is refused with a reason. */
  enabled: boolean;
  /** Why it is refused, when `enabled` is false. Rendered in the overlay. */
  disabledReason?: string;
  /** FILE-QUEUE-WEB: every dropped file, in drop order; each is queued. */
  onFiles: (files: File[]) => void;
  children: React.ReactNode;
  className?: string;
}

export function FileDropZone({
  enabled, disabledReason, onFiles, children, className,
}: FileDropZoneProps) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  // A drag that ends outside the window never fires `drop` or a balancing
  // `dragleave`, which would strand the overlay on screen forever. Reset on
  // the window's own dragend/drop as a backstop.
  useEffect(() => {
    const reset = () => { depth.current = 0; setDragging(false); };
    window.addEventListener('dragend', reset);
    window.addEventListener('drop', reset);
    return () => {
      window.removeEventListener('dragend', reset);
      window.removeEventListener('drop', reset);
    };
  }, []);

  const hasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes('Files');

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  // Without preventDefault here the browser opens the file instead of dropping.
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
  }, [enabled]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (!enabled) return;
    // FILE-QUEUE-WEB: the relay still moves one file at a time, but the queue
    // takes all of them and walks them in order.
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) onFiles(files);
  }, [enabled, onFiles]);

  return (
    <div
      className={['cc-ft-dropzone relative', className].filter(Boolean).join(' ')}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
      data-cc-ft-dragging={dragging ? 'true' : 'false'}
    >
      {children}
      {dragging && (
        <div
          aria-hidden="true"
          data-cc-ft-drop-overlay="true"
          className={[
            'cc-ft-drop-overlay pointer-events-none absolute inset-2 z-30 flex flex-col items-center',
            'justify-center gap-2 rounded-2xl border-2 border-dashed backdrop-blur-[1px]',
            enabled
              ? 'border-blue-400 bg-blue-50/85 text-blue-700'
              : 'border-slate-300 bg-slate-50/90 text-slate-500',
          ].join(' ')}
        >
          <Upload className="h-6 w-6" aria-hidden="true" />
          <p className="px-4 text-center text-[13px] font-medium">
            {enabled ? 'Drop files to send them to your phone' : disabledReason ?? 'Cannot send right now'}
          </p>
        </div>
      )}
    </div>
  );
}
