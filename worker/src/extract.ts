/**
 * Structured fields pulled from the customer's message. They stay untrusted: only
 * System 2 and the human reviewer see them, never System 1 or a learned rule.
 */

export interface ExtractedFields {
  requested_amount_cents: number | null;
  asserts_total_outage: boolean;
  asserts_degradation: boolean;
  asserts_late_delivery: boolean;
  mentions_weather: boolean;
  cited_references: string[];
  word_count: number;
}

export function extractFields(text: string): ExtractedFields {
  const t = text.normalize('NFKC');
  const money = t.match(/\$\s?([\d,]+(?:\.\d{1,2})?)/);
  return {
    requested_amount_cents: money ? Math.round(parseFloat(money[1].replace(/,/g, '')) * 100) : null,
    asserts_total_outage: /\b(completely lost|no data|did not receive|never received|total outage|unusable|nothing (was )?received|failed)\b/i.test(t),
    asserts_degradation: /\b(degraded|quality dropped|partial|missing|lost (part|some|half)|about half)\b/i.test(t),
    asserts_late_delivery: /\b(late|delayed|delay)\b/i.test(t),
    mentions_weather: /\b(storm|solar|flare|geomagnetic|space weather|aurora|kp)\b/i.test(t),
    cited_references: [...t.matchAll(/\b([a-z_]+):(\d+)\b/g)].map(m => `${m[1]}:${m[2]}`),
    word_count: t.split(/\s+/).filter(Boolean).length,
  };
}
