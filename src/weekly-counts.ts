// Weekly counts of what people did with suggestions — numbers only, for a person to hand to whoever
// studies whether suggestions improve with use. Counted in the sidecar (`WeeklyCounts.cs`); these are the
// types the app reads them by. Nothing that says what a document is about is in them: forms and fields are
// numbered, and no value, name or path is written (constitution §3).

export const WEEKLY_COUNTS_FORMAT = 'lowline-weekly-counts/1'

/** One week of one judgment field. */
export interface WeekCounts {
  /** The Monday the week starts on, in this device's time, as `YYYY-MM-DD`. */
  week: string
  /** The form's number in this vault (see {@link WeeklyCounts.forms}); a new version is a new number. */
  form: number
  /** The judgment field's number within its form, in the order the form names them. */
  field: number
  /**
   * Suggestions shown on this device, saved or not. Decisions come from every device that shares the
   * vault, so on a shared vault they can outnumber what this device showed.
   */
  presented: number
  accepted: number
  corrected: number
  rejected: number
  /**
   * Values entered while the field's suggestion was held back to check it, and how many of them were the value held
   * back — no decision about a suggestion, so in none of the counts above. Added within format 1; absent in a week
   * with none.
   */
  checked?: { entered: number; held: number }
  /** Decisions by the similarity the suggestion was made at, in steps of 0.1 (`"0.6"` = 0.6 to under 0.7). */
  bySimilarity: Record<string, { decided: number; accepted: number }>
  /**
   * Decisions by where the suggestion came from: `key` (a value settled alongside one the document has), `memory`
   * (a similar record) or `proposed` (a value another program wrote into the document as a suggestion, offered as it
   * was — no promise of the app's). Each is read apart. Added within format 1 — a reader that does not know it can
   * pass it by.
   */
  bySource: Record<string, { decided: number; accepted: number }>
  /**
   * Presentations and decisions by how many characters had been typed in the field when the suggestion was first
   * shown: `"0"` (before typing), `"1"`, `"2"`, `"3+"`. A typed suggestion answers to a promise of its own length, so
   * each is read apart. Those recorded before the count was kept are in none, so the slots can add up to less than
   * `presented` and the decisions. Added within format 1 — a reader that does not know it can pass it by.
   */
  byTyped: Record<string, TypedCounts>
}

/** One `byTyped` slot. */
export interface TypedCounts {
  presented: number
  decided: number
  accepted: number
  /**
   * How long the decisions in this slot took from the suggestion first showing to being taken or rejected, as counts
   * per span of {@link WeeklyCounts.dwellEdgesSec} — a span's count is at `i` when the time reached the edge before it
   * and not its own. Only decisions that say both times are in it; absent when none of the slot's did. Added within
   * format 1 — a reader that does not know it can pass it by.
   */
  dwell?: Dwell
}

export interface Dwell {
  /** Taken. */
  accepted: number[]
  /** Of those taken, the ones that say what was in the field then: taken with as many characters in the field as when it was shown… */
  acceptedNoTyping: number[]
  /** …or taken after the field changed. These two can add up to less than `accepted`. */
  acceptedAfterTyping: number[]
  /** Corrected or rejected. */
  other: number[]
}

export interface FormCounts {
  form: number
  /**
   * Saved documents with a value in at least one judgment field that a person settled — leaving out those not settled
   * (`conflicted`), and values another program only proposed (`DocumentSnapshot.proposed`).
   */
  confirmed: number
  /**
   * Of those, the ones the app has never saved (`DocumentSnapshot.outside`): their judgment values were written by
   * another program, and no one may have confirmed them. Added within format 1 — a reader that does not know it
   * can pass it by.
   */
  outside: number
  /**
   * Weeks from the first such document's day to the last, both included. A document's day is the one its file is
   * named by — the day it was made, or for a record brought in, its own day — or, for a file renamed without it, its
   * last save. Records brought in all at once are counted in the weeks they were made, not the week they came in.
   */
  weeks: number
  perWeek: number
}

export interface WeeklyCounts {
  format: typeof WEEKLY_COUNTS_FORMAT
  counts: WeekCounts[]
  forms: FormCounts[]
  /** The edges, in seconds, between the spans `dwell` is counted in: under 0.5 s, 0.5 to under 1 s, … 32 s and over. */
  dwellEdgesSec: number[]
  /**
   * The week of the oldest suggestion this device's record still holds as shown: `presented` counts from that week on,
   * and a week before it says nothing of what was shown. Absent when the record holds none. Added within format 1 — a
   * reader that does not know it can pass it by.
   */
  presentedSince?: string
}

/**
 * What the sidecar answers for the weekly counts: the counts to hand over, and which template each form number is (the
 * first is form 1) — shown to the person exporting, never exported.
 */
export interface WeeklyCountsReport {
  formRefs: string[]
  export: WeeklyCounts
}
