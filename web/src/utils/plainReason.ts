/**
 * Customer-facing wording for decision reasons. The raw reasons name systems and confidence
 * scores; those stay behind the technical-details setting.
 */
export function plainReason(raw: string): string {
  const s = raw.replace(/^\[[^\]]+\]\s*/, '').replace(/^CLM-\d+:\s*/, '').trim();
  const mismatch = s.match(/failed verification:\s*([^;]+)/i);
  if (mismatch) return `Evidence mismatch: ${mismatch[1].trim()}`;
  if (/failed verification/i.test(s)) return 'Evidence mismatch';
  if (/flag|inject/i.test(s)) return 'Customer message held for review';
  if (/below\b.*\d+%|threshold/i.test(s)) return 'Sent to a reviewer';
  const human = s.match(/^(Approved|Denied) by ([\w.@-]+)/i);
  if (human) return `${human[1]} by ${human[2]}`;
  return s
    .replace(/\s*(at|with)\s+\d+(\.\d+)?%(\s+confidence)?/gi, '')
    .replace(/\s*\([^)]*\)/g, '')
    .replace(/\bSystem [12]\b/g, 'AI')
    .replace(/[:;,]\s*$/, '')
    .trim();
}

/** Short chip label for why a claim is waiting on a reviewer, without scores. */
export function plainEscalation(reason: string): string {
  if (/verif/i.test(reason)) return 'Evidence mismatch';
  if (/flag|inject/i.test(reason)) return 'Message flagged';
  if (/cedar|deny/i.test(reason)) return 'Policy check';
  return 'Needs review';
}
