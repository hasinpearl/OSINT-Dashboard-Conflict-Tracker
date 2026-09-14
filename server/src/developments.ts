import { stripLoneSurrogates, type ServingRow } from "./serving";

// Rule 3. A Major Developments entry has to read as a clean factual statement,
// and the raw corpus does not: a Telegram post opens with a severity dot and a
// flag pair, closes with a subscribe line and a channel handle, and carries the
// classifier's own annotations in the middle.
//
// Everything here is subtractive or a substitution of one stored string for
// another stored string. Nothing generates prose. A development that cannot be
// reduced to a factual sentence by removing marker text is excluded, because a
// paraphrase would be this file inventing a claim the store never made.

//TUNE: Control the (development length). Characters a cleaned development entry may run to before it is cut at a sentence end.
const DEVELOPMENT_MAX_CHARS = 240;

//TUNE: Control the (development minimum). Characters below which a cleaned entry is too telegraphic to publish.
const DEVELOPMENT_MIN_CHARS = 30;

//TUNE: Control the (development minimum words). Words below which a cleaned entry is a fragment, not a statement.
const DEVELOPMENT_MIN_WORDS = 6;

// Emoji, flags, dingbats, variation selectors and zero-width joiners.
//
// Written as an ALTERNATION rather than a character class: a class containing a
// joiner or a variation selector is a lint error (no-misleading-character-class)
// and a real correctness trap, because a class matches one code point at a time
// and would split a flag pair or an emoji-plus-selector sequence in half. The
// alternation puts the multi-code-point sequences FIRST, so a flag cluster,
// a keycap and a joined sequence are each consumed whole before the
// single-code-point branches are tried.
const PICTOGRAPH_SOURCE = [
  // A regional-indicator pair: one flag. Must precede the single-indicator branch.
  "[\\u{1F1E6}-\\u{1F1FF}]{2}",
  // A base pictograph with any run of joiners, selectors and further bases.
  "\\p{Extended_Pictographic}(?:\\u{FE0F}?\\u{20E3})?(?:\\u{200D}\\p{Extended_Pictographic}\\u{FE0F}?)*\\u{FE0F}?",
  // Anything left over: a lone indicator, an arrow, a dingbat, a stray
  // selector or joiner. The selectors and the joiner are separate alternatives
  // rather than one class, because a class holding a combining or joining
  // character is flagged by no-misleading-character-class: in a class they
  // could only ever match alone, which is precisely the half-a-sequence match
  // the branches above exist to prevent.
  "[\\u{1F1E6}-\\u{1F1FF}]",
  "[\\u{2190}-\\u{21FF}\\u{2300}-\\u{27BF}\\u{2B00}-\\u{2BFF}]",
  "[\\u{FE00}-\\u{FE0F}]",
  "\\u{200D}",
  "\\u{20E3}",
].join("|");

const PICTOGRAPH_ANY = new RegExp(PICTOGRAPH_SOURCE, "gu");

// Leading run of anything that is not a letter, a digit or an opening quote:
// severity dots, flag clusters, bullets, dashes, arrows, the lightning bolt,
// stray punctuation. Quotes are spared because a headline that opens on a
// quoted phrase is a whole statement and stripping one half of the pair is
// what made it read as broken.
const LEADING_MARKERS = new RegExp(
  `^(?:${PICTOGRAPH_SOURCE}|[\\s\\-–—•·*=>»<|:;,.~^\\[\\]()])+`,
  "u",
);

// Channel-specific trailers. These are the subscribe and attribution lines the
// collectors store verbatim as part of content, measured on the real corpus:
// every pattern below was taken from a stored row, not guessed.
const TRAILER_PATTERNS: RegExp[] = [
  /Subscribe to\s*@?[\w_]+\s*(\|\s*.*)?$/giu,
  /View on\s*@?[\w_]+.*$/giu,
  /\bt\.me\/[\w_]+.*$/giu,
  /RocketAlert\.live\s*$/giu,
  /💢[^💢]*💢/gu,
  /@[A-Za-z][\w_]{2,}\s*$/gu,
  /\bChat room\b.*$/giu,
];

// The classifier's own annotations, written into the post body by the upstream
// channel: a location line, a category and an S-tier, a relay handle. They are
// metadata about the development, not the development, and they sit at the END
// of a post. So this is a CUT at the first annotation glyph, not a delete of
// the glyph's run: deleting the run took everything to the end of the string
// with it, and on a post whose opening flag cluster contained one of these
// glyphs ("🇾🇪⚔️🇸🇦 A large fire broke out at a pumping station...") that meant
// deleting the entire development. The leading marker run is therefore stripped
// before this cut is looked for, so a glyph inside a dateline cannot trigger it.
const ANNOTATION_GLYPHS = /[\u{1F4CD}\u{2694}\u{1F3DB}\u{1F4E1}]/u;

const ANNOTATION_TAIL_PATTERNS: RegExp[] = [
  /\bS[0-9]\s*-\s*[A-Z]{3,}\b[\s\S]*$/u,
  /\b(?:Conflict|Political|Military|Economic)\s*·\s*S[0-9][\s\S]*$/iu,
];

// An Admin Note is the channel operator's own commentary, not a report of an
// event. Hessa named it specifically: it must never appear as a development.
const ADMIN_NOTE = /\badmin\s*note\b/iu;

// A hashtag country prefix is how one channel datelines a post: "#Poland
// Shield AI is targeting..." and, with no separator at all, "#USAOman
// postponed the meeting...". Both forms are markers, so both go, but the match
// is deliberately narrow: it ends either at whitespace or immediately before
// the next capitalised word, so it can only ever remove the tag itself. A
// greedy version consumed the first word of the sentence, which turned "Oman
// postponed the meeting" into "postponed the meeting" and lost the actor.
const LEADING_HASHTAG = /^#[A-Za-z][\w]*?(?=[A-Z][a-z])|^#[A-Za-z][\w]*(?=\s|$)/u;

// Google News concatenates the headline, a non-breaking-space pair, and the
// outlet, then repeats the whole thing for every syndicating outlet. The first
// segment is the outlet's own headline, which is exactly what Rule 3 asks to
// prefer, and the rest is the same development restated.
function firstSyndicatedSegment(text: string): string {
  const parts = text.split(/\u00a0\u00a0|&nbsp;&nbsp;/);
  return parts[0] ?? text;
}

// An RSS title arrives as "Headline - Outlet" from the aggregator feeds. The
// outlet suffix is a prefix of the same kind as a channel handle, so it is
// removed, but only when what precedes it is still a whole statement.
function stripOutletSuffix(text: string): string {
  const m = text.match(/^(.{25,})\s+[-–—|]\s+([^-–—|]{2,40})$/u);
  if (!m) return text;
  return m[1].trim();
}

function collapseSpace(text: string): string {
  return text.replace(/[\u00a0\s]+/g, " ").trim();
}

// monitor_the_situation stores a headline and its body run together with no
// separator: "IRGC Says It Intercepts Drone Over Strait of HormuzIran's
// Islamic Revolutionary Guard Corps reports...". The boundary is a lowercase
// letter immediately followed by an uppercase one, and taking the headline is
// both the cleaner sentence and the channel's own wording.
//
// The body's first word may be a single capital ("...in ViennaA senior Iranian
// official was blocked...") or an all-caps acronym ("...Over War StrategyNYT
// reports internal..."), so the lookahead after the boundary accepts a capital
// followed by a lowercase letter, a space, or a further run of capitals.
// Requiring two lowercase letters missed both shapes and published the headline
// and the body as one run-on line.
function splitRunTogetherHeadline(text: string): string {
  const m = text.match(/^(.{25,140}?[a-z])([A-Z](?:[a-z]|\s|[A-Z]+\s).{20,})$/u);
  if (!m) return text;
  return m[1].trim();
}

// Order matters and each step exists for a measured failure.
//
// The leading dateline goes FIRST, because it is the one place an annotation
// glyph or a flag cluster appears without meaning "the report ends here". Only
// then is the tail cut at the first surviving annotation or trailer. Whatever
// pictographs remain after that are decoration inside the sentence and are
// removed in place.
function stripMarkers(text: string): string {
  let out = collapseSpace(text);
  out = out.replace(LEADING_MARKERS, "");
  out = out.replace(LEADING_HASHTAG, "");
  out = collapseSpace(out).replace(LEADING_MARKERS, "");

  const glyph = out.match(ANNOTATION_GLYPHS);
  if (glyph && glyph.index !== undefined) out = out.slice(0, glyph.index);

  for (const re of ANNOTATION_TAIL_PATTERNS) out = out.replace(re, " ");
  for (const re of TRAILER_PATTERNS) out = out.replace(re, " ");

  out = out.replace(PICTOGRAPH_ANY, " ").replace(/\p{Extended_Pictographic}/gu, " ");
  return collapseSpace(out).replace(LEADING_MARKERS, "").trim();
}

// One sentence. A cut only ever lands on a sentence terminator that the stored
// text already had, so the result is a prefix of a real sentence sequence and
// never a clause the source did not end there.
function firstSentence(text: string): string {
  const terminated = text.match(/^[\s\S]*?[.!?؟](?=\s|$)/u);
  const candidate = terminated ? terminated[0] : text;
  if (Array.from(candidate).length <= DEVELOPMENT_MAX_CHARS) return candidate.trim();
  return "";
}

function hasEmoji(text: string): boolean {
  PICTOGRAPH_ANY.lastIndex = 0;
  return PICTOGRAPH_ANY.test(text) || /\p{Extended_Pictographic}/u.test(text);
}

// Rule 3's exclusion test, applied to the CLEANED text. A fragment, a residual
// marker, an Admin Note or anything still carrying an emoji is dropped rather
// than shown raw.
function isPublishable(text: string): boolean {
  if (!text) return false;
  if (Array.from(text).length < DEVELOPMENT_MIN_CHARS) return false;
  if (text.split(/\s+/).filter(Boolean).length < DEVELOPMENT_MIN_WORDS) return false;
  if (ADMIN_NOTE.test(text)) return false;
  if (hasEmoji(text)) return false;
  if (/@[\w_]{3,}/u.test(text)) return false;
  // A letter, a digit or an opening quote may start a statement. Anything else
  // still leading means a marker survived the strip.
  if (/^[^\p{L}\p{N}"'“”«]/u.test(text)) return false;
  if (!/\p{L}/u.test(text)) return false;
  return true;
}

function cleanCandidate(raw: string): string {
  if (!raw) return "";
  let text = stripLoneSurrogates(raw);
  text = firstSyndicatedSegment(text);
  text = stripMarkers(text);
  text = splitRunTogetherHeadline(text);
  text = stripOutletSuffix(text);
  text = collapseSpace(text);
  return firstSentence(text);
}

/**
 * The cleaned development statement for a stored row, or null when the row
 * cannot be reduced to one without paraphrasing it.
 *
 * `headlineFrom` is the news-outlet row covering the same development, when the
 * timeline found one. Rule 3 prefers the outlet's own headline, and preferring
 * it is still a substitution of one stored string for another.
 */
export function developmentStatement(
  row: ServingRow,
  headlineFrom?: ServingRow | null,
): string | null {
  const candidates: string[] = [];
  if (headlineFrom) {
    candidates.push(headlineFrom.title ?? "", headlineFrom.content ?? "");
  }
  candidates.push(row.title ?? "", row.content ?? "");

  for (const candidate of candidates) {
    const cleaned = cleanCandidate(candidate);
    if (isPublishable(cleaned)) return cleaned;
  }
  return null;
}

// Exported for the acceptance checks, which assert over the same predicate the
// route uses rather than a second copy of it, and for editorial.ts, which
// strips the same class from model-written text.
export const developmentChecks = { cleanCandidate, isPublishable, hasEmoji };

export function stripPictographs(text: string): string {
  return collapseSpace(text.replace(PICTOGRAPH_ANY, " "));
}
