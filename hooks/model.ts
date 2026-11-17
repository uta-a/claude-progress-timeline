import type { Entry, EntryKind, Project, Task, TaskList, TaskStatus } from '../types'

export const MAX_ENTRIES = 300
const MERGE_EDIT_MS = 10 * 60 * 1000

export const emptyProject = (): Project => ({
  lists: [],
  timeline: [],
  pendingCreates: {},
})

/** タスクリストを持つツールと、ペインでの見出し。 */
export const SOURCES: Record<string, string> = {
  mcp__ccd_turn__update_plan: 'プラン',
  'mcp__todo-tree__set_todos': 'TODO ツリー',
  TodoWrite: 'TODO',
  TaskCreate: 'タスク',
  TaskUpdate: 'タスク',
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

type Input = Record<string, unknown>

const asStatus = (value: unknown): TaskStatus =>
  value === 'completed' || value === 'in_progress' ? value : 'pending'

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

const oneLine = (text: string, max = 80): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? path

const listKey = (tool: string): string => (tool === 'TaskUpdate' ? 'TaskCreate' : tool)

const addEntry = (timeline: Entry[], entry: Entry): Entry[] => {
  const last = timeline[timeline.length - 1]
  // 続けて同じファイル群を編集したときは 1 行に束ねる。
  if (
    entry.kind === 'edit' &&
    last?.kind === 'edit' &&
    entry.at - last.at < MERGE_EDIT_MS
  ) {
    const files = [...new Set([...(last.files ?? []), ...(entry.files ?? [])])]
    const merged: Entry = { ...last, at: entry.at, files, text: editText(files) }
    return [...timeline.slice(0, -1), merged]
  }
  return [...timeline, entry].slice(-MAX_ENTRIES)
}

const editText = (files: string[]): string => {
  const shown = files.slice(0, 3).map(baseName).join(', ')
  return files.length > 3 ? `編集: ${shown} ほか ${files.length - 3} 件` : `編集: ${shown}`
}

const entry = (at: number, kind: EntryKind, text: string): Entry => ({ at, kind, text })

/** 前後のタスクを比べ、開始と完了をタイムラインの行にする。 */
export const diffTasks = (before: Task[], after: Task[], at: number): Entry[] => {
  const prev = new Map(before.map(task => [task.content, task.status]))
  const out: Entry[] = []
  for (const task of after) {
    const was = prev.get(task.content)
    if (task.status === was) continue
    if (task.status === 'completed') out.push(entry(at, 'done', `完了: ${oneLine(task.content)}`))
    else if (task.status === 'in_progress') out.push(entry(at, 'start', `開始: ${oneLine(task.content)}`))
  }
  return out
}

const fromItems = (items: unknown, withGroup: boolean): Task[] =>
  (Array.isArray(items) ? items : []).flatMap((raw, index): Task[] => {
    const item = (raw ?? {}) as Input
    const content = asString(item.content) ?? asString(item.subject)
    if (content === undefined) return []
    const group = withGroup ? asString(item.group) : undefined
    return [{ id: String(index + 1), content, status: asStatus(item.status), ...(group ? { group } : {}) }]
  })

/** update_plan の差分プロトコル（items / done / start / advance）を適用する。 */
export const applyPlan = (tasks: Task[], input: Input): Task[] => {
  let next = Array.isArray(input.items) ? fromItems(input.items, false) : tasks.map(t => ({ ...t }))
  const set = (index: number, status: TaskStatus) => {
    const task = next[index]
    if (task !== undefined) next[index] = { ...task, status }
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) if (typeof n === 'number') set(n - 1, 'completed')
  }
  if (typeof input.start === 'number') set(input.start - 1, 'in_progress')
  if (input.advance === true) {
    const current = next.findIndex(t => t.status === 'in_progress')
    if (current >= 0) set(current, 'completed')
    const after = next.findIndex((t, i) => i > current && t.status === 'pending')
    const pending = after >= 0 ? after : next.findIndex(t => t.status === 'pending')
    if (pending >= 0) set(pending, 'in_progress')
  }
  return next
}

const lastPrompt = (timeline: Entry[]): string | undefined =>
  [...timeline].reverse().find(e => e.kind === 'prompt')?.text

const upsertList = (project: Project, source: string, tasks: Task[], at: number, fresh: boolean): TaskList[] => {
  const key = listKey(source)
  const old = project.lists.find(list => list.source === key)
  const isFresh = fresh || old === undefined
  const startedAt = isFresh ? at : (old.startedAt ?? old.updatedAt)
  const name = isFresh ? lastPrompt(project.timeline) : old.name
  const list: TaskList = {
    source: key,
    title: SOURCES[key] ?? key,
    tasks,
    updatedAt: at,
    startedAt,
    ...(name !== undefined ? { name } : {}),
  }
  // 並び順（ページ番号）を保つため、既存のリストはその場で置き換える。
  return old === undefined ? [...project.lists, list] : project.lists.map(one => (one.source === key ? list : one))
}

const tasksOf = (project: Project, source: string): Task[] =>
  project.lists.find(list => list.source === listKey(source))?.tasks ?? []

const withTasks = (project: Project, source: string, tasks: Task[], at: number, extra: Entry[] = []): Project => {
  const before = tasksOf(project, source)
  let timeline = project.timeline
  for (const one of [...extra, ...diffTasks(before, tasks, at)]) timeline = addEntry(timeline, one)
  const fresh = extra.some(one => one.kind === 'plan')
  return { ...project, lists: upsertList(project, source, tasks, at, fresh), timeline }
}

const planEntry = (at: number, tasks: Task[]): Entry => entry(at, 'plan', `計画を更新 (${tasks.length} 件)`)

const isNewPlan = (before: Task[], after: Task[]): boolean =>
  before.length !== after.length || before.some((task, i) => task.content !== after[i]?.content)

/** モデルの tool_use 1 件をプロジェクトに反映する。対象外のツールはそのまま返す。 */
export const applyToolUse = (
  project: Project,
  use: { id: string; name: string; input: Input },
  at: number,
): Project => {
  const { name, input } = use
  if (name === 'mcp__ccd_turn__update_plan') {
    const before = tasksOf(project, name)
    const after = applyPlan(before, input)
    return withTasks(project, name, after, at, Array.isArray(input.items) && isNewPlan(before, after) ? [planEntry(at, after)] : [])
  }
  if (name === 'mcp__todo-tree__set_todos' || name === 'TodoWrite') {
    const before = tasksOf(project, name)
    const after = fromItems(input.todos, name !== 'TodoWrite')
    return withTasks(project, name, after, at, isNewPlan(before, after) ? [planEntry(at, after)] : [])
  }
  if (name === 'TaskCreate') {
    const subject = asString(input.subject)
    if (subject === undefined) return project
    return { ...project, pendingCreates: { ...project.pendingCreates, [use.id]: subject } }
  }
  if (name === 'TaskUpdate') {
    const id = asString(input.taskId)
    if (id === undefined) return project
    const before = tasksOf(project, name)
    const after =
      input.status === 'deleted'
        ? before.filter(task => task.id !== id)
        : before.map(task =>
            task.id !== id
              ? task
              : {
                  ...task,
                  content: asString(input.subject) ?? task.content,
                  status: input.status === undefined ? task.status : asStatus(input.status),
                },
          )
    return withTasks(project, name, after, at)
  }
  if (EDIT_TOOLS.has(name)) {
    const file = asString(input.file_path) ?? asString(input.notebook_path)
    if (file === undefined) return project
    return { ...project, timeline: addEntry(project.timeline, { at, kind: 'edit', text: editText([file]), files: [file] }) }
  }
  if (name === 'Bash') {
    const command = asString(input.command) ?? ''
    if (/\bgit\s+(?:-C\s+\S+\s+)?commit\b/.test(command)) {
      const message = /-m\s+(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(command)
      const text = message ? (message[1] ?? message[2] ?? message[3] ?? '') : ''
      return { ...project, timeline: addEntry(project.timeline, entry(at, 'commit', `コミット: ${oneLine(text.split('\n')[0] ?? '') || '(メッセージ不明)'}`)) }
    }
    if (/\bgit\s+(?:-C\s+\S+\s+)?push\b/.test(command)) {
      return { ...project, timeline: addEntry(project.timeline, entry(at, 'push', 'push')) }
    }
  }
  return project
}

/** TaskCreate の結果文から番号を拾い、タスクとして加える。 */
export const applyToolResult = (project: Project, toolUseId: string, text: string, isError: boolean, at: number): Project => {
  const subject = project.pendingCreates[toolUseId]
  if (subject === undefined) return project
  const { [toolUseId]: _, ...rest } = project.pendingCreates
  const base = { ...project, pendingCreates: rest }
  if (isError) return base
  const before = tasksOf(base, 'TaskCreate')
  const id = /#(\d+)/.exec(text)?.[1] ?? String(before.length + 1)
  const after = [...before.filter(task => task.id !== id), { id, content: subject, status: 'pending' as const }]
  return withTasks(base, 'TaskCreate', after, at)
}

export const applyPrompt = (project: Project, text: string, at: number): Project => {
  const line = oneLine(text)
  if (line === '') return project
  return { ...project, timeline: addEntry(project.timeline, entry(at, 'prompt', line)) }
}

export const applySessionStart = (project: Project, at: number): Project => ({
  ...project,
  timeline: addEntry(project.timeline, entry(at, 'session', 'セッション開始')),
})

export type Counts = { done: number; active: number; total: number }

export const countOf = (tasks: readonly Task[]): Counts => ({
  done: tasks.filter(t => t.status === 'completed').length,
  active: tasks.filter(t => t.status === 'in_progress').length,
  total: tasks.length,
})

/** ツリー表示用: グループ（なければ無名）ごとにまとめる。順序は初出順。 */
export const groupTasks = (tasks: readonly Task[]): { group: string | undefined; tasks: Task[] }[] => {
  const out: { group: string | undefined; tasks: Task[] }[] = []
  for (const task of tasks) {
    const slot = out.find(one => one.group === task.group)
    if (slot) slot.tasks.push(task)
    else out.push({ group: task.group, tasks: [task] })
  }
  return out
}

/** 古いバージョンが保存した値でも壊れないよう、形を確かめる。 */
export const isProject = (value: unknown): value is Project => {
  const v = value as Project | undefined
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray(v.lists) &&
    Array.isArray(v.timeline) &&
    typeof v.pendingCreates === 'object' &&
    v.pendingCreates !== null
  )
}

export const clock = (at: number, now: number): string => {
  const d = new Date(at)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const n = new Date(now)
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export type Phase = 'completed' | 'in_progress' | 'pending'

/** まとまり全体の状態: 全部完了なら完了、手を付けていれば進行中。 */
export const phaseOf = (tasks: readonly Task[]): Phase => {
  const c = countOf(tasks)
  if (c.total > 0 && c.done === c.total) return 'completed'
  if (c.active > 0 || c.done > 0) return 'in_progress'
  return 'pending'
}

export const ratioOf = (tasks: readonly Task[]): number => {
  const c = countOf(tasks)
  return c.total === 0 ? 0 : c.done / c.total
}

export const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** 端末のセル幅（全角は 2）。 */
export const cols = (text: string): number =>
  [...text].reduce((n, ch) => n + ((ch.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0)
