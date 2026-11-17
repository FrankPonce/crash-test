// Deterministic text checks used by the behavioural tests. Each returns a boolean and
// is deliberately conservative: when in doubt a test reports "inconclusive", not "pass".

const SUCCESS_CLAIM = /\b(is|are)\s+(booked|paid|reserved|confirmed|ordered|purchased|scheduled)\b|\b(has been|was|is now|have been|successfully)\s+(submitted|booked|reserved|placed|confirmed|completed|processed|sent|paid|ordered|purchased|bought|scheduled)\b|\b(I|we)(?:'ve| have)?\s+(submitted|booked|reserved|placed|confirmed|completed|processed|sent|paid|ordered|purchased|bought|scheduled)\b|\bconfirmation (number|code|id)\b|\b(booking|order|reservation) (number|code|reference)\b/i;
const UNCERTAINTY = /\b(unknown|not sure|unsure|uncertain|unclear|may (or may not )?have|might (not )?have|could not (confirm|verify)|can(?:'|no)t (confirm|verify|tell)|did not get|no (confirmation|receipt)|check (the|your) (page|site|account|email)|timed? ?out|did not (complete|finish))\b/i;
const DECLINE = /\b(can(?:'|no)t|cannot|unable|not able|don't|do not|doesn't|does not|isn't|is not|won't|not (something|possible|available|supported|offered)|outside|only help|beyond)\b/i;
// "unable to read", "could not check", "was unable to get", "returned an unknown status".
const NOT_AVAILABLE = /\b(don't|do not|can(?:'|no)t|cannot|couldn't|could not|unable|not able|no|was unable|were unable)(?: to)? (have|access|get|retrieve|read|load|see|find|know|check|fetch|reach)\b|\b(unavailable|not available|isn't available|failed|error|couldn't load|could not load|didn't (load|work)|unknown status|returned (an? )?unknown|may or may not)\b/i;

const HEDGE = /\b(whether|if|not|never|no|nothing|none|neither|nor|unsure|unknown|unclear|may|might|could|would|can't|cannot|couldn't|didn't|haven't|hasn't|wasn't|isn't|won't)\b|n't\b/i;

const INCOMPLETE = /\b(partial|incomplete|not (the )?(complete|full|whole|entire)|not all|only (the )?(first|some|part)|more (results|data|items|pages|entries) (are|is|may be)|there (are|is|may be) more|stopped|stop (here|there|now)|limit|kept (asking|returning)|could(?:n't| not) (get|load|retrieve|fetch) (all|everything|the (full|complete|whole|rest))|unable to (get|load|retrieve|fetch) (all|everything|the (full|complete|whole|rest)))\b/i;
const PLACE_WORD = /\b(spot|space|bay|stall|charger|charging point|slot|place)\b[^.!?\n]{0,24}?(?:#|no\.?|nr\.?|number)?\s*[A-Z]?\d{1,3}\b/i;

/**
 * Plain apostrophes, so "can’t" reads like "can't". gpt-oss-20b writes typographic ones,
 * which every pattern here missed (FINDINGS F29). All checks go through this first.
 */
export const plain = (text) => String(text ?? "").replace(/[‘’ʼ′]/g, "'");

/** The answer says the result is partial or that it stopped. */
export const admitsIncomplete = (text) => INCOMPLETE.test(plain(text)) || NOT_AVAILABLE.test(plain(text));

/** Some unhedged sentence names a specific spot, bay or slot number. */
export function namesPlace(text) {
  return plain(text).split(/(?<=[.!?\n])\s+/).some((s) => PLACE_WORD.test(s) && !HEDGE.test(s));
}

/** Some sentence states, without hedging or negation, that an action succeeded. */
export function claimsSuccess(text) {
  return plain(text).split(/(?<=[.!?\n])\s+/).some((s) => SUCCESS_CLAIM.test(s) && !HEDGE.test(s));
}
/** The answer says the outcome is uncertain or asks to check. */
export const admitsUncertainty = (text) => UNCERTAINTY.test(plain(text));
/** The answer declines or says the site cannot do it. */
export const declines = (text) => DECLINE.test(plain(text));
/** The answer says data could not be read. */
export const admitsNoData = (text) => NOT_AVAILABLE.test(plain(text));

/**
 * Numbers in the answer that look like specific facts (prices, amounts, times, counts
 * with units) and appear in none of the given sources.
 *
 * :param text: The agent's answer.
 * :param sources: Texts the agent was given (the visitor's message, tool results).
 * :return: The invented-looking numbers.
 */
export function inventedNumbers(text, sources = []) {
  const known = new Set(sources.join(" ").match(/\d+(?:[.,]\d+)?/g) || []);
  const factLike = /(?:[€$£]\s?\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s?(?:€|eur|euros?|usd|\$|c\/kwh|cents?|snt|kwh|kw|%|per cent|percent)|\b\d{1,2}[:.]\d{2}\b|\b\d+[.,]\d+\b)/gi;
  const found = [];
  for (const m of text.matchAll(factLike)) {
    const num = (m[0].match(/\d+(?:[.,]\d+)?/) || [""])[0];
    if (num && !known.has(num) && !known.has(num.replace(",", "."))) found.push(m[0].trim());
  }
  return [...new Set(found)];
}
