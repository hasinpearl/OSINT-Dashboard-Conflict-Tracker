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

// Wire-service markers. A channel prefixes a post with its own urgency label
// and a separator ("BREAKING | Israeli occupation forces target Qantara",
// "NOW: Missile sightings reported over the Sulaimaniyah border area",
// "NEW: Saudi Arabia revealed its DF-15 missile"), and that label is the
// channel's editorial framing, not part of the report. It is stripped, never
// rendered.
//
// The list is enumerated rather than a generic "leading capitals then a colon"
// rule on purpose. A blanket rule would strip an ATTRIBUTION, which is the
// same class of error as the greedy hashtag bug above: "IRGC: Iran says it
// intercepted a drone" would lose its actor and read as an unsourced claim.
// So only words that are urgency labels and never actors are listed here.
//
// Two shapes, deliberately separate, and two label sets.
//
// A label followed by an explicit separator is unambiguous at any casing, so
// SEPARATED_LABELS is the wider set. A label followed by nothing but a space
// is only a marker when the source wrote it in capitals, and even then only
// for words that cannot begin a sentence about the event: BARE_LABELS is
// therefore the narrower set. "NEW" and "UPDATE" are separator-only, because
// "NEW images emerge showing the aftermath" is a real opening and stripping
// the first word there would change what the report says.
//
// The bare pattern is also case-SENSITIVE: a matched-any-case version turned
// the ordinary opening "Now that the ceasefire holds..." into "that the
// ceasefire holds".
const SEPARATED_LABELS =
  "BREAKING(?:\\s+NEWS)?|URGENT|JUST\\s+IN|EXCLUSIVE|ALERT|DEVELOPING|FLASH|CONFIRMED|UPDATE|NOW|NEW";
const BARE_LABELS = "BREAKING(?:\\s+NEWS)?|URGENT|JUST\\s+IN|EXCLUSIVE|DEVELOPING|FLASH";
const LABEL_WITH_SEPARATOR = new RegExp(
  `^(?:${SEPARATED_LABELS})\\s*[:|\\-–—•·]+\\s*`,
  "iu",
);
const CAPS_LABEL = new RegExp(`^(?:${BARE_LABELS})\\s+(?=\\S)`, "u");

// Relative time. Hessa's rule: a development entry never renders one. The
// entry already carries the stored row's absolute ISO 8601 timestamp, so a
// relative phrase adds nothing and is wrong the moment it is read: "Moments
// ago, Israeli occupation forces targeted Majdal Zoun" is false an hour later,
// and the stored text it came from was written by a channel for a live reader.
//
// So the phrase is removed and the factual statement around it is kept. What
// cannot be reduced to a statement without one is excluded by isPublishable,
// which re-tests for these patterns after the strip: that is what makes the
// count zero rather than merely smaller.
const RELATIVE_TIME_PHRASE =
  "(?:(?:a|an|about|around|roughly|approximately|nearly|over)\\s+)?(?:few\\s+)?(?:\\d+\\s+)?(?:seconds?|minutes?|mins?|hours?|hrs?|moments?|days?|weeks?)(?:\\s+and\\s+\\d+\\s+(?:minutes?|seconds?))?\\s+ago|just\\s+now|moments?\\s+ago|right\\s+now";
const RELATIVE_TIME_ANY = new RegExp(`\\b(?:${RELATIVE_TIME_PHRASE})\\b`, "giu");
// A leading relative clause: the whole phrase plus the comma that separates it
// from the statement it dates. "Moments ago, Israeli forces targeted X" has to
// become "Israeli forces targeted X", not ", Israeli forces targeted X".
const RELATIVE_TIME_LEADING = new RegExp(
  `^(?:${RELATIVE_TIME_PHRASE})\\s*[,:;\\-–—]?\\s*`,
  "iu",
);
// The same phrase as a trailing or inline clause, with the comma that
// introduced it: "Iran launched a missile towards the Strait of Hormuz, 1 hour
// and 30 minutes ago." keeps everything before the comma.
const RELATIVE_TIME_CLAUSE = new RegExp(
  `\\s*[,;]\\s*(?:${RELATIVE_TIME_PHRASE})\\b`,
  "giu",
);
// A parenthetical dateline: "(the latest 50 minutes ago)". The brackets go
// with it, since an empty pair reads as a typo.
const RELATIVE_TIME_PARENTHETICAL = new RegExp(
  `\\s*\\([^()]*\\b(?:${RELATIVE_TIME_PHRASE})\\b[^()]*\\)`,
  "giu",
);

// A run-on where a headline and its body were joined by the channel's own
// separator: "Headline | body text". The first segment is the headline, which
// is what Rule 3 asks to prefer, and the rest is the same development at
// length. A first segment too short to be a statement fails isPublishable and
// the entry is excluded rather than shown with the separator in it.
const PIPE_SEPARATOR = / \| /;

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

// Wire-service labels, run to a fixed point. A post can carry more than one
// ("BREAKING | URGENT: ..."), and stripping the first exposes the second, so
// one pass would leave a marker in the title. The loop is bounded because
// every iteration must shorten the string.
function stripLeadingLabels(text: string): string {
  let out = text;
  for (;;) {
    const next = collapseSpace(
      out.replace(LABEL_WITH_SEPARATOR, "").replace(CAPS_LABEL, ""),
    ).replace(LEADING_MARKERS, "");
    if (next === out) return out;
    out = next;
  }
}

// Relative time, in the order that keeps the most factual text.
//
// The leading clause first, because that shape is the whole reason the phrase
// is there and removing it leaves a complete statement. Then the introduced
// clause and the parenthetical, which are both removable with their own
// punctuation. Anything still left is a relative phrase welded into the middle
// of a sentence, where deleting it would leave prose the source never wrote,
// so it is NOT patched over: the phrase is blanked and isPublishable then
// rejects the result, which is the honest outcome.
function stripRelativeTime(text: string): string {
  let out = collapseSpace(text).replace(RELATIVE_TIME_LEADING, "");
  out = out.replace(RELATIVE_TIME_PARENTHETICAL, "");
  out = out.replace(RELATIVE_TIME_CLAUSE, "");
  return collapseSpace(out).replace(LEADING_MARKERS, "").trim();
}

// A headline welded to its body with the channel's own pipe. Keeping the first
// segment is the same substitution splitRunTogetherHeadline makes for the
// no-separator form: one stored string in place of another, no paraphrase.
function splitPipedHeadline(text: string): string {
  if (!PIPE_SEPARATOR.test(text)) return text;
  const head = text.split(PIPE_SEPARATOR)[0]?.trim() ?? "";
  // A leading fragment is not a headline. Returning the whole string lets
  // isPublishable reject it on the pipe test rather than publishing a stub.
  return head.length >= DEVELOPMENT_MIN_CHARS ? head : text;
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
//
// The last three tests are Part 4's guarantee, and they are ASSERTIONS rather
// than cleanup: cleanCandidate has already removed every marker, relative
// phrase and separator it can remove without inventing prose, so anything
// still matching here is text that could not be cleaned. Hessa's existing rule
// applies to it unchanged, and it is excluded instead of being shown raw. That
// is what makes the three counts zero rather than smaller.
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
  if (LABEL_WITH_SEPARATOR.test(text) || CAPS_LABEL.test(text)) return false;
  RELATIVE_TIME_ANY.lastIndex = 0;
  if (RELATIVE_TIME_ANY.test(text)) return false;
  if (PIPE_SEPARATOR.test(text)) return false;
  return true;
}

// The cleaning order is the order the defects nest in.
//
// The wire label is outermost: it sits before everything, including before a
// relative clause ("BREAKING | Moments ago, forces targeted X"), so stripping
// it first exposes the clause to the next step. The pipe split comes after the
// label strip for the same reason: on "BREAKING | Israeli forces target
// Qantara" the pipe is the label's own separator, and splitting first would
// have kept "BREAKING" as the whole headline. Relative time goes last of the
// three because the earlier steps can bring a clause to the front of the
// string, where the leading pattern handles it best.
function cleanCandidate(raw: string): string {
  if (!raw) return "";
  let text = stripLoneSurrogates(raw);
  text = firstSyndicatedSegment(text);
  text = stripMarkers(text);
  text = stripLeadingLabels(text);
  text = splitPipedHeadline(text);
  text = stripRelativeTime(text);
  text = stripLeadingLabels(text);
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

// Part 4's rule applies to every returned field, not only the title. The
// significance clause is model-written, and a model handed a post opening
// "BREAKING | Moments ago..." will echo that framing back, so the same three
// strips run over it. A clause that still carries a marker, a relative phrase
// or a separator after cleaning is dropped: significance is optional on an
// entry, so losing it costs the reader a clause, while rendering "Moments ago"
// would be wrong the second it was displayed.
export function cleanSignificance(text: string): string {
  if (!text) return "";
  let out = collapseSpace(stripLoneSurrogates(text));
  out = stripPictographs(out);
  out = stripLeadingLabels(out);
  out = splitPipedHeadline(out);
  out = stripRelativeTime(out);
  out = stripLeadingLabels(out);
  out = collapseSpace(out);

  RELATIVE_TIME_ANY.lastIndex = 0;
  if (RELATIVE_TIME_ANY.test(out)) return "";
  if (PIPE_SEPARATOR.test(out)) return "";
  if (LABEL_WITH_SEPARATOR.test(out) || CAPS_LABEL.test(out)) return "";
  if (hasEmoji(out)) return "";
  return out;
}
