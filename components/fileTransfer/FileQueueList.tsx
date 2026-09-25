'use client';

import React, { useCallback, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';

import type { QueueItem } from '@/lib/fileTransfer/queue.ts';
import { canRetry, isActive } from '@/lib/fileTransfer/queue.ts';
import {
  ftFailureCopy, FT_QUEUE_CANCEL, FT_QUEUE_CLEAR, FT_QUEUE_NEEDS_FILE, FT_QUEUE_OPEN,
  FT_QUEUE_QUEUED, FT_QUEUE_REMOVE, FT_QUEUE_REPICK, FT_RETRY_ACTION,
} from './ftCopy';
import { formatBytes, percentOf, phaseLabel } from './ftFormat';

/**
 * components/fileTransfer/FileQueueList.tsx — FILE-QUEUE-WEB. The transfer
 * rows, as a standalone list: the Transfers strip renders it expanded today,
 * and the held WEB-NAV-FILES view can render the same component later.
 *
 * Pure presentation over `QueueItem[]` + callbacks. Row actions follow the
 * ADDENDUM 2 table exactly:
 *   queued -> Remove · offering/sending/receiving -> Cancel ·
 *   done -> Open (incoming, while the handle is live) + Clear ·
 *   failed -> Try again (when a retry can change anything) + Remove ·
 *   needs-file -> Pick again + Remove.
 *
 * Every action button names its row in its accessible name ("Remove
 * holiday.jpg"), because a list of eight identical "Remove" buttons is
 * unusable by ear. Failure text is ftFailureCopy's — the banner's own sentence.
 *
 * The active row's bar is decorative (aria-hidden): the strip above carries the
 * one real progressbar, so a screen reader hears the percentage once.
 */

export type QueueRetryResult = 'sent' | 'changed' | 'repick' | 'unavailable';

export interface FileQueueListProps {
  items: readonly QueueItem[];
  onRemove: (id: string) => void;
  onRetry: (id: string) => Promise<QueueRetryResult>;
  onRepick: (id: string, file: File) => void;
  onClear: (id: string) => void;
  /** The incoming row whose file can still be opened, and its opener. */
  openableId?: string | null;
  onOpen?: () => void;
  compact?: boolean;
  id?: string;
}

function stateLine(it: QueueItem): { text: string; tone: 'sec' | 'fail' } {
  const pct = percentOf(it.bytes, it.size);
  switch (it.state) {
    case 'queued': return { text: `${FT_QUEUE_QUEUED} · ${formatBytes(it.size)}`, tone: 'sec' };
    case 'offering': return { text: phaseLabel('offered', it.direction), tone: 'sec' };
    case 'sending':
    case 'receiving':
      return { text: `${phaseLabel('transferring', it.direction)} ${pct}% of ${formatBytes(it.size)}`, tone: 'sec' };
    case 'done': return { text: `${phaseLabel('done', it.direction)} · ${formatBytes(it.size)}`, tone: 'sec' };
    case 'needs-file': return { text: FT_QUEUE_NEEDS_FILE, tone: 'fail' };
    case 'failed':
    default:
      return { text: ftFailureCopy(it.reason ?? '').message, tone: 'fail' };
  }
}

function RowButton({
  action, label, name, onClick,
}: { action: string; label: string; name: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-cc-ft-queue-action={action}
      aria-label={`${label} ${name}`}
      className="cc-ftq-btn"
    >
      {label}
    </button>
  );
}

export function FileQueueList({
  items, onRemove, onRetry, onRepick, onClear, openableId = null, onOpen, compact = false, id,
}: FileQueueListProps) {
  const pickRef = useRef<HTMLInputElement>(null);
  const [pickFor, setPickFor] = useState<string | null>(null);

  const openPicker = useCallback((rowId: string) => {
    setPickFor(rowId);
    pickRef.current?.click();
  }, []);

  const onPicked = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file && pickFor) onRepick(pickFor, file);
    setPickFor(null);
  }, [pickFor, onRepick]);

  const retry = useCallback((rowId: string) => {
    // The probe is a one-byte read, well inside the click's activation window,
    // so the picker can still open from this same gesture on 'repick'.
    void onRetry(rowId).then((out) => { if (out === 'repick') openPicker(rowId); });
  }, [onRetry, openPicker]);

  return (
    <>
      <input
        ref={pickRef}
        type="file"
        className="sr-only"
        onChange={onPicked}
        tabIndex={-1}
        aria-hidden="true"
        data-cc-ft-queue-input="true"
      />
      <ul id={id} className={`cc-ftq-list${compact ? ' cc-ftq-compact' : ''}`} data-cc-ft-queue-list="true">
        {items.map((it) => {
          const line = stateLine(it);
          const Icon = it.direction === 'send' ? ArrowUpFromLine : ArrowDownToLine;
          const moving = it.state === 'sending' || it.state === 'receiving';
          return (
            <li
              key={it.id}
              className="cc-ftq-row"
              data-cc-ft-queue-row={it.id}
              data-cc-ft-queue-state={it.state}
              data-cc-ft-direction={it.direction}
            >
              <Icon className="cc-ftq-icon" aria-hidden="true" />
              <div className="cc-ftq-main">
                <p className="cc-ftq-name" title={it.name}>
                  <span className="sr-only">{it.direction === 'send' ? 'Outgoing: ' : 'Incoming: '}</span>
                  {it.name}
                </p>
                <p className={line.tone === 'fail' ? 'cc-ftq-line cc-ftq-fail' : 'cc-ftq-line'}>
                  {line.text}
                </p>
                {moving && (
                  <div className="cc-ftq-track" aria-hidden="true">
                    <div className="cc-ft-bar cc-ftq-fill" style={{ width: `${percentOf(it.bytes, it.size)}%` }} />
                  </div>
                )}
              </div>
              <div className="cc-ftq-actions">
                {it.state === 'queued' && (
                  <RowButton action="remove" label={FT_QUEUE_REMOVE} name={it.name} onClick={() => onRemove(it.id)} />
                )}
                {isActive(it) && (
                  <RowButton action="cancel" label={FT_QUEUE_CANCEL} name={it.name} onClick={() => onRemove(it.id)} />
                )}
                {it.state === 'done' && it.direction === 'receive' && openableId === it.transferId && onOpen && (
                  <RowButton action="open" label={FT_QUEUE_OPEN} name={it.name} onClick={onOpen} />
                )}
                {it.state === 'done' && (
                  <RowButton action="clear" label={FT_QUEUE_CLEAR} name={it.name} onClick={() => onClear(it.id)} />
                )}
                {it.state === 'failed' && canRetry(it) && (
                  <RowButton action="retry" label={FT_RETRY_ACTION} name={it.name} onClick={() => retry(it.id)} />
                )}
                {it.state === 'needs-file' && (
                  <RowButton action="repick" label={FT_QUEUE_REPICK} name={it.name} onClick={() => openPicker(it.id)} />
                )}
                {(it.state === 'failed' || it.state === 'needs-file') && (
                  <RowButton action="remove" label={FT_QUEUE_REMOVE} name={it.name} onClick={() => onRemove(it.id)} />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
