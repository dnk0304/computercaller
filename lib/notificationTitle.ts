/**
 * lib/notificationTitle.ts — ALERT-TITLE: never show the sender twice.
 *
 * The phone (NotificationListenerService.extractTitle) builds a MessagingStyle
 * title as `<EXTRA_TITLE> · <last sender>`, and EXTRA_TITLE is itself already
 * `<conversation>: <sender>`. Teams sets conversation = the person in a 1:1,
 * so the wire carries `Frank: Frank · Frank`. Only one string crosses the
 * wire, so the web repairs it at RENDER time (stored data and search keep the
 * raw text).
 *
 * Conservative by design: the raw string is returned untouched unless the
 * parse actually finds a repeated name. Titles that legitimately contain
 * `: ` or ` · ` (email subjects, "Meeting: 10:00", "Anna · Bob") pass through.
 */

const APPENDED_SEP = ' · ';
const CONVERSATION_SEP = ': ';

/** Display form of one field: NFC, trimmed, inner whitespace collapsed. */
function tidy(s: string): string {
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Comparison key only — never rendered. */
function key(s: string): string {
  return tidy(s).toLocaleLowerCase();
}

export function cleanNotificationTitle(raw: string): string {
  if (typeof raw !== 'string' || raw === '') return raw ?? '';

  let head = raw;
  let appended: string | null = null;
  const dot = raw.lastIndexOf(APPENDED_SEP);
  if (dot !== -1) {
    head = raw.slice(0, dot);
    appended = raw.slice(dot + APPENDED_SEP.length);
  }

  let conversation = head;
  let sender: string | null = null;
  const colon = head.indexOf(CONVERSATION_SEP);
  if (colon !== -1) {
    conversation = head.slice(0, colon);
    sender = head.slice(colon + CONVERSATION_SEP.length);
  }

  const kept: string[] = [];
  const seen = new Set<string>();
  let droppedDuplicate = false;
  for (const field of [conversation, sender, appended]) {
    if (field === null) continue;
    const shown = tidy(field);
    if (shown === '') continue;
    const k = key(shown);
    if (seen.has(k)) {
      droppedDuplicate = true;
      continue;
    }
    seen.add(k);
    kept.push(shown);
  }

  if (!droppedDuplicate) return raw;
  return kept.join(APPENDED_SEP);
}
