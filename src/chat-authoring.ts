// What the chat beside a template does with a model's reply: find the template draft in it, tidy what a small model
// gets wrong the same way every time, and say what stands in the way of the draft working — the same checks the
// template's page makes as it is typed. The draft goes into the editor; the person saves it.

import { parseFormdown } from '@formdown/core'
import { templateInfo, templateProblems } from './documents.js'
import { describeError } from './errors.js'
import { strings } from './strings.js'

/**
 * The fenced blocks of a reply, in the order sent: each with its language and body. A fence that opens with a template's
 * language while a block is still open starts the next block — a small model sending two templates often leaves the first
 * one's fence unclosed.
 */
function fencedBlocks(reply: string): { language: string; body: string }[] {
  return parts(reply).filter((p) => p.language !== null) as { language: string; body: string }[]
}

/** A reply as its words and its fenced blocks, in order: `language` is null for words, a block's language (or '') otherwise. */
function parts(reply: string): { language: string | null; body: string }[] {
  const said: { language: string | null; body: string }[] = []
  let words: string[] = []
  let open: { language: string; lines: string[] } | null = null
  const close = () => {
    if (open) said.push({ language: open.language, body: open.lines.join('\n') })
    open = null
  }
  for (const line of reply.split(/\r?\n/)) {
    const fence = /^\s*```[ \t]*([\w-]*)[ \t]*$/.exec(line)
    if (!fence) {
      if (open) open.lines.push(line)
      else words.push(line)
      continue
    }
    const language = fence[1].toLowerCase()
    if (open && (language === '' || !TEMPLATE_LANGUAGES.has(language))) {
      close()
      continue
    }
    close()
    said.push({ language: null, body: words.join('\n') })
    words = []
    open = { language, lines: [] }
  }
  close()
  said.push({ language: null, body: words.join('\n') })
  return said
}

/** The languages a fenced template comes in — or none named. */
const TEMPLATE_LANGUAGES = new Set(['formdown', 'fd', 'markdown', 'md'])

/** The fenced blocks of a reply that hold a template, in the order sent. */
function templateBlocks(reply: string): string[] {
  return fencedBlocks(reply)
    .filter((b) => b.language === '' || TEMPLATE_LANGUAGES.has(b.language))
    .map((b) => b.body)
    .filter((body) => /^---\r?\n/.test(body) || /@[^\s:]+\s*:/.test(body))
    .map((body) => (body.endsWith('\n') ? body : `${body}\n`))
}

/** The `id` a template's front matter gives it, or null. */
export function sourceId(source: string): string | null {
  return /^---\r?\n[\s\S]*?^id:[ \t]*["']?([^\s"']+)/m.exec(source)?.[1] ?? null
}

/** Whether a template has a field naming the documents of the template `id` (`@청구서 -> id: [select]`). */
function refersTo(source: string, id: string): boolean {
  return new RegExp(`^\\s*@[^:\\n]*->\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`, 'm').test(source)
}

/**
 * What a reply drafts for the template whose id is `id`: the template itself — the block with that id, or else the first
 * one that does not point at it — and the templates of its repeated rows, each a block of its own whose documents point
 * at it (`@청구서 -> id`), for the person to make. Null when the reply holds no template.
 */
export function draftsOf(reply: string, id: string | null): { draft: string; rows: string[]; reversed: string[] } | null {
  const blocks = templateBlocks(reply)
  // The last block that is the template — a reply may show the template as it was before the one it changed — and not
  // one of its rows (a block pointing at another block sent with it).
  const rowOfAnother = (b: string) => blocks.some((o) => o !== b && sourceId(o) !== null && refersTo(b, sourceId(o)!))
  const own = (b: string) => id !== null && sourceId(b) === id
  const candidates = blocks.filter((b) => !rowOfAnother(b))
  const last = (list: string[], test: (b: string) => boolean) => [...list].reverse().find(test)
  const draft = last(candidates, own) ?? last(blocks, own) ?? last(candidates, (b) => id === null || !refersTo(b, id)) ?? blocks.at(-1)
  if (draft === undefined) return null
  const target = sourceId(draft) ?? id
  const rows = target === null ? [] : blocks.filter((b) => b !== draft && refersTo(b, target))
  // A row template the template points at instead of one pointing at it: the reference the wrong way round.
  const reversed = blocks.filter((b) => b !== draft && !rows.includes(b) && sourceId(b) !== null && refersTo(draft, sourceId(b)!))
  return { draft, rows, reversed }
}

/** The template a reply drafts — see `draftsOf` — or null. */
export function draftOf(reply: string, id: string | null = null): string | null {
  return draftsOf(reply, id)?.draft ?? null
}

/**
 * The fields of a draft that spread one repeated row over numbered names (`품목_1_품명`, `품목_2_품명`, …) — three or more
 * names alike but for their numbers — as the name with its number set apart (`품목_N_품명`); empty when there are none.
 * A row is a document of its own in Lowline, so the chat asks for it as a template of its own instead.
 */
export function spreadRows(draft: string): string[] {
  let names: string[]
  try {
    names = parseFormdown(draft).forms.map((f) => f.name)
  } catch {
    return []
  }
  const alike = new Map<string, Set<string>>()
  for (const name of names) {
    const numbers = name.match(/\d+/g)
    if (!numbers) continue
    const shape = name.replace(/\d+/g, 'N')
    alike.set(shape, (alike.get(shape) ?? new Set()).add(numbers.join(',')))
  }
  return [...alike].filter(([, numbers]) => numbers.size >= 3).map(([shape]) => shape)
}

/**
 * The fields a draft made from a blank form kept from the template it replaced (`before`) though the form never names
 * them — a new template's `제목`, `상태`, `메모` left beside the form's own fields — by name; empty when there are none.
 * A field is named by the form when its name or its label, spaces aside, is in the form's text.
 */
export function leftoverFields(draft: string, before: string, form: string): string[] {
  const fields = (source: string) => {
    try {
      return parseFormdown(source).forms.map((f) => ({ name: f.name, label: f.label ?? f.name }))
    } catch {
      return []
    }
  }
  const plain = (text: string) => text.replace(/[\s_]+/g, '')
  const said = plain(form)
  const was = new Set(fields(before).map((f) => f.name))
  return fields(draft)
    .filter((f) => was.has(f.name) && !said.includes(plain(f.name)) && !said.includes(plain(f.label)))
    .map((f) => f.name)
}

/**
 * What stands in the way of a row template working beside the template it belongs to (id `parent`): its own problems, an
 * id of its own, and a field naming the parent's documents.
 */
export function rowProblems(row: string, parent: string | null): string[] {
  const said = draftProblems(row)
  const id = sourceId(row)
  if (id !== null && id === parent) said.push(strings.chatRowSameId)
  if (parent !== null && !refersTo(row, parent)) said.push(strings.chatRowNoParent(parent))
  return said
}

/** What a reply says besides its draft: its words, the template block taken out. */
export function wordsOf(reply: string): string {
  return parts(reply)
    .map((p) => (p.language === null ? p.body : p.language === '' || TEMPLATE_LANGUAGES.has(p.language) ? '' : `\`\`\`${p.language}\n${p.body}\n\`\`\``))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A draft with what small models get wrong mechanically put right: a field name with spaces in it (`@처리 기한: [date]`)
 * — a field's name is one word, so the spaces become underscores, as the template's rules say — and each fix the
 * parser offers for a line it could not read, such as a field written without its brackets (`@처리_기한: date`).
 */
export function tidyDraft(draft: string): string {
  const named = draft.replace(/^(\s*)@([^:@\n\[\]]*\S)(\s*):(\s*\[)/gm, (whole, indent: string, written: string, _gap: string, rest: string) => {
    // A field naming another template's documents keeps its arrow and target (`@청구서 -> requisition`).
    const [name, target] = written.split(/\s*->\s*/, 2)
    return /\s/.test(name.trim()) ? `${indent}@${name.trim().replace(/\s+/g, '_')}${target === undefined ? '' : ` -> ${target}`}:${rest}` : whole
  })
  return withFixes(named)
}

/** `source` with each fix the parser offers put in place of what it is for, the last first so the earlier spans hold. */
function withFixes(source: string): string {
  let fixes
  try {
    fixes = (parseFormdown(source).diagnostics ?? []).filter((d) => d.fix !== undefined && d.span !== undefined)
  } catch {
    return source
  }
  return fixes
    .sort((a, b) => b.span!.start - a.span!.start)
    .reduce((text, d) => text.slice(0, d.span!.start) + d.fix + text.slice(d.span!.end), source)
}

/** What stands in the way of the draft working as a template, in the words the template's page uses. */
export function draftProblems(draft: string): string[] {
  const said: string[] = []
  try {
    templateInfo(draft)
  } catch (e) {
    said.push(describeError(e))
  }
  for (const problem of templateProblems(draft)) said.push(strings.templateProblem(problem))
  return said
}

/** What the conversation says to the model when its draft had problems: the problems, and to send the whole template again. */
export function retryMessage(problems: readonly string[]): string {
  return [strings.chatRetry, ...problems.map((p) => `- ${p}`)].join('\n')
}

/** The fields a draft adds and takes away, by name, against the template as it was. */
export function fieldChanges(before: string, after: string): { added: string[]; removed: string[] } {
  const names = (source: string) => {
    try {
      return parseFormdown(source).forms.map((f) => f.name)
    } catch {
      return []
    }
  }
  const was = new Set(names(before))
  const now = names(after)
  return { added: now.filter((n) => !was.has(n)), removed: [...was].filter((n) => !now.includes(n)) }
}
