export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type Task = {
  id: string
  content: string
  status: TaskStatus
  group?: string
}

/** タスクの出どころ（ツール）ごとのリスト。 */
export type TaskList = {
  source: string
  title: string
  tasks: Task[]
  updatedAt: number
  /** この計画が始まった時刻（経過時間の起点） */
  startedAt?: number
  /** 計画を立てたときの直近の依頼文（見出しに使う） */
  name?: string
}

export type EntryKind =
  | 'session'
  | 'prompt'
  | 'plan'
  | 'start'
  | 'done'
  | 'edit'
  | 'commit'
  | 'push'

export type Entry = {
  at: number
  kind: EntryKind
  text: string
  /** edit を束ねるときのファイル一覧 */
  files?: string[]
}

export type Project = {
  lists: TaskList[]
  timeline: Entry[]
  /** 結果待ちの TaskCreate（tool_use_id -> subject） */
  pendingCreates: Record<string, string>
}

export type ViewFlags = {
  tab: 'tree' | 'report'
  /** 表示中のリスト。-1 は「最後に更新されたリスト」に追従 */
  page: number
  /** 折りたたんだツリーノードのキー */
  collapsed: string[]
  recentOpen: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'progress-timeline': {
      project: Shaped<Project>
      view: Shaped<ViewFlags>
      projectKey: string
      sessionMarked: boolean
    }
  }
}
