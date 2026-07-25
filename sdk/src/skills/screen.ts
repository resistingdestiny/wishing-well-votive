/**
 * Reading a wish before working on it.
 *
 * The chain can bar an operator after the fact, but nothing on-chain can read a
 * wish and tell that it asks for somebody to be hurt — the text lives off-chain and
 * the judgement is not arithmetic. So this is where an agent stops before it starts:
 * a screen that runs against the wish text at claim time, refuses outright on the
 * categories that carry a permanent bar, and produces the report a reviewer would
 * file.
 *
 * Two properties matter more than the word list.
 *
 * **It fails closed.** An unreadable or empty wish is refused, not waved through.
 * A screen whose failure mode is "carry on" is not a control.
 *
 * **It never decides the penalty.** The screen names a category; the contract
 * decides what that category costs, and the categories describing harm to people
 * carry a floor no reviewer can file below. Keeping the judgement here and the
 * consequence there is what stops a bug in a word list from being able to bar
 * somebody permanently on its own — filing a report is still a human's call.
 */

/** Mirrors `StandingLedger.Category`. The numbers are the enum's, and are what
 *  goes on-chain, so they must not be reordered. */
export enum ConductCategory {
  Unspecified = 0,
  ViolenceAgainstPeople = 1,
  Exploitation = 2,
  WeaponsOrMassHarm = 3,
  TargetedHarassment = 4,
  Fraud = 5,
  Spam = 6,
}

/** Mirrors `StandingLedger.Severity`. */
export enum ConductSeverity {
  None = 0,
  Minor = 1,
  Serious = 2,
  Critical = 3,
}

export type ScreenVerdict = 'clear' | 'refuse' | 'review';

export interface ScreenResult {
  verdict: ScreenVerdict;
  /** Set when the verdict is not `clear`. */
  category?: ConductCategory;
  /** What the screen believes it saw, in words an operator can argue with. */
  reason: string;
  /** The phrases that triggered it, so a false positive is diagnosable rather
   *  than mysterious. */
  matched: string[];
}

interface Rule {
  category: ConductCategory;
  reason: string;
  patterns: RegExp[];
}

/**
 * Deliberately narrow. This is the floor, not the whole safety story — a serious
 * deployment puts a model behind `screenWish` through the `classifier` option and
 * uses these patterns as the backstop for when that call fails.
 *
 * Written to catch the request, not the topic. A wish to *study* violence, or to
 * translate a war memoir, is not a wish to commit any, and a screen that cannot
 * tell those apart would make the protocol useless for most of what is worth
 * wishing for.
 */
const RULES: Rule[] = [
  {
    category: ConductCategory.ViolenceAgainstPeople,
    reason: 'asks for a person to be killed or physically harmed',
    patterns: [
      // Active: a verb of harm taking a person as its object.
      /\b(kill|murder|assassinat\w*|execut\w*)\s+(this|that|the|my|his|her|their|a|an)?\s*\b(person|man|woman|child|guy|girl|boy|neighbou?r|colleague|boss|ex|family|people|him|her|them)\b/i,
      // Causative: the object comes first and the verb is a past participle —
      // "have this person killed". Grammatically the opposite way round from the
      // pattern above, and the more natural way to ask, so missing it missed the
      // single most obvious phrasing of the thing this exists to catch.
      /\b(have|get|want)\s+(this|that|the|my|his|her|their|our)\s+([a-z]+\s+){0,2}(killed|murdered|assassinated|maimed|tortured|beaten up)\b/i,
      /\b(have|get|pay|hire|arrange for)\s+(someone|somebody|a hitman|an? (hitman|assassin))\b/i,
      /\bhit\s?man\b/i,
      /\b(beat|hurt|maim|torture|poison|stab|shoot)\s+(this|that|the|my|him|her|them)\b/i,
      /\bmake\s+(him|her|them|someone|somebody)\s+(disappear|suffer)\b/i,
    ],
  },
  {
    category: ConductCategory.Exploitation,
    reason: 'involves sexual exploitation or someone unable to consent',
    patterns: [
      /\b(child|minor|underage)\b[^.?!]{0,40}\b(sexual|explicit|nude|porn\w*)\b/i,
      /\b(sexual|explicit|nude|porn\w*)\b[^.?!]{0,40}\b(child|minor|underage)\b/i,
      /\b(traffick\w*)\b[^.?!]{0,30}\b(people|person|women|children|girls|boys)\b/i,
    ],
  },
  {
    category: ConductCategory.WeaponsOrMassHarm,
    reason: 'asks for a weapon or something whose purpose is mass harm',
    patterns: [
      // A request verb is required. The bare terms on their own used to be enough,
      // which refused a toxicology literature review and a policy paper — exactly
      // the topic-not-request mistake this module claims not to make. Naming a
      // nerve agent is what a pharmacologist does all day; asking for one is not.
      /\b(build|make|synthesi[sz]e|manufactur\w*|acquire|obtain|source|buy|get me|need|produce)\b[^.?!]{0,50}\b(bioweapon|nerve agent|sarin|anthrax|dirty bomb|nuclear (device|weapon|bomb)|explosive device|pipe bomb)\b/i,
    ],
  },
  {
    category: ConductCategory.TargetedHarassment,
    reason: 'targets a named private individual',
    patterns: [
      /\b(dox|doxx\w*)\b/i,
      /\b(find|get|obtain)\b[^.?!]{0,30}\b(home address|home addy|private address|real name)\b[^.?!]{0,30}\b(of|for)\b/i,
      /\b(stalk|follow)\s+(this|that|the|my|him|her|them)\b/i,
    ],
  },
];

export interface ScreenOptions {
  /** An optional model-backed classifier, consulted first. Its refusal wins; its
   *  failure falls through to the patterns rather than to "clear". */
  classifier?: (text: string) => Promise<{category: ConductCategory; reason: string} | null>;
}

/**
 * Screen a wish. Returns `refuse` for anything an agent must not work on, `review`
 * for something a person should look at, `clear` otherwise.
 */
export async function screenWish(text: string, options: ScreenOptions = {}): Promise<ScreenResult> {
  const wish = typeof text === 'string' ? text.trim() : '';
  if (wish === '') {
    // Fail closed. A screen that waves through what it could not read is not one.
    return {
      verdict: 'refuse',
      category: ConductCategory.Unspecified,
      reason: 'the wish text was empty or unreadable, so nothing was screened',
      matched: [],
    };
  }

  if (options.classifier) {
    try {
      const judged = await options.classifier(wish);
      if (judged) {
        return {
          verdict: 'refuse',
          category: judged.category,
          reason: judged.reason,
          matched: [],
        };
      }
    } catch {
      // Fall through to the patterns. A classifier that is down must not become an
      // implicit approval.
    }
  }

  for (const rule of RULES) {
    const matched = rule.patterns
      .map((pattern) => wish.match(pattern)?.[0])
      .filter((m): m is string => typeof m === 'string');

    if (matched.length > 0) {
      return {verdict: 'refuse', category: rule.category, reason: rule.reason, matched};
    }
  }

  return {verdict: 'clear', reason: 'nothing in the wish matched a refusal category', matched: []};
}

/** Whether the category carries a permanent bar — mirrors the contract's floor. */
export function isPermanentlyBarring(category: ConductCategory): boolean {
  return (
    category === ConductCategory.ViolenceAgainstPeople
    || category === ConductCategory.Exploitation
    || category === ConductCategory.WeaponsOrMassHarm
  );
}

/**
 * The report a reviewer would file for this result.
 *
 * Returns the arguments, not a transaction. Filing bars a human across every
 * wallet they will ever hold, and this package does not get to do that on a regex
 * match — a person with the reviewer key decides, and this hands them the case.
 */
export function toConductReport(
  result: ScreenResult,
  evidenceHash: string
): {category: ConductCategory; severity: ConductSeverity; evidenceHash: string} | null {
  if (result.verdict === 'clear' || result.category === undefined) return null;
  return {
    category: result.category,
    severity: isPermanentlyBarring(result.category)
      ? ConductSeverity.Critical
      : ConductSeverity.Serious,
    evidenceHash,
  };
}
