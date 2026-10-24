/**
 * Cheap prompt-injection screen run on the customer's message before System 2.
 * It normalises the text the way a model would read it (hidden Unicode tags,
 * zero-width characters, homoglyphs, NFKC, base64) and scores instruction-like content.
 */

export interface ScreenResult {
  flagged: boolean;
  score: number;
  reasons: string[];
  /** What a model would effectively read, with hidden characters decoded. */
  normalized: string;
}

const CONFUSABLES: Record<string, string> = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'һ': 'h',
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'І': 'I',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'ι': 'i', 'ν': 'v', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T',
};

const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const TAG_CHARS = /[\u{E0000}-\u{E007F}]/gu;

const STRONG: [RegExp, string][] = [
  [/\b(ignore|disregard|forget|override|bypass|skip)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|the|your|system)\b[^.\n]{0,25}\b(rules?|instructions?|prompts?|polic(y|ies)|guidelines|checks?)\b/i, 'instruction override'],
  [/\b(ignora|ignorar|ignorez|ignoriere|ignorare)\b[^.\n]{0,40}\b(instrucciones|reglas|instructions|règles|anweisungen|regeln|istruzioni|regole)\b/i, 'instruction override (non-English)'],
  [/(^|\n|\s)(system|assistant|developer|analyst)\s*:/i, 'role-turn injection'],
  [/<<<|>>>|<\s*\/?\s*(untrusted|customer_message|system|instructions?|evidence)\b/i, 'delimiter spoofing'],
  [/"\s*(decision|confidence|credit_cents|verdict|cited_evidence)\s*"\s*:/i, 'pre-filled model output'],
  [/<!--[\s\S]*?-->/, 'hidden HTML comment'],
  [/\b(you are now|act as|pretend (to be|you are)|new instructions|jailbreak|developer mode|policy has changed)\b/i, 'role or policy reassignment'],
  [/\b(decode and follow|follow the (encoded|hidden|following) (instructions?|text))\b/i, 'encoded-instruction lure'],
];

const WEAK: [RegExp, string][] = [
  [/\bapprove\b[^.\n]{0,30}\b(full|entire|100%|unconditionally|immediately|without review)\b/i, 'demands an unconditional approval'],
  [/\bconfidence\b[^.\n]{0,15}\b(0?\.9\d*|9\d\s*%|1\.0)\b/i, 'dictates a confidence score'],
];

function decodeTags(text: string): { decoded: string; count: number } {
  let count = 0;
  const decoded = text.replace(TAG_CHARS, ch => {
    count++;
    const cp = ch.codePointAt(0)! - 0xe0000;
    return cp >= 0x20 && cp <= 0x7e ? String.fromCharCode(cp) : '';
  });
  return { decoded, count };
}

function base64Payloads(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)) {
    try {
      const s = Buffer.from(m[0], 'base64').toString('utf8');
      if (/^[\x20-\x7e\s]+$/.test(s) && /[a-z]{3,}\s+[a-z]{3,}/i.test(s)) out.push(s);
    } catch {
      /* not base64 */
    }
  }
  return out;
}

export function screenMessage(raw: string): ScreenResult {
  const reasons: string[] = [];
  let score = 0;
  const add = (reason: string, weight: number) => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
      score += weight;
    }
  };

  const { decoded, count: tagCount } = decodeTags(raw);
  if (tagCount > 0) add(`hidden Unicode tag characters (${tagCount})`, 1);
  const invisible = decoded.match(INVISIBLE)?.length ?? 0;
  if (invisible > 0) add(`invisible formatting characters (${invisible})`, invisible >= 2 ? 1 : 0.5);

  let text = decoded.replace(INVISIBLE, '').normalize('NFKC');
  let homoglyphs = 0;
  text = text.replace(/[\u0370-\u03FF\u0400-\u04FF\u0500-\u052F]/g, ch => {
    const latin = CONFUSABLES[ch];
    if (latin) homoglyphs++;
    return latin ?? ch;
  });
  if (homoglyphs > 0 && /[A-Za-z]/.test(raw)) add(`mixed-script homoglyphs (${homoglyphs})`, 0.5);

  const payloads = base64Payloads(text);
  if (payloads.length) add('base64-encoded text', 0.5);
  const views = [text, ...payloads];

  for (const view of views) {
    for (const [re, reason] of STRONG) if (re.test(view)) add(reason, 1);
    for (const [re, reason] of WEAK) if (re.test(view)) add(reason, 0.5);
  }
  if (text.length > 4000) add('unusually long message', 0.5);

  return { flagged: score >= 1, score: Math.round(score * 100) / 100, reasons, normalized: views.join('\n[decoded] ') };
}
