import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, EntryKind, Project, Task, ViewFlags } from '../types'
import {
  applyPrompt,
  applySessionStart,
  applyToolResult,
  applyToolUse,
  clock,
  countOf,
  elapsed,
  emptyProject,
  groupTasks,
  isProject,
  percent,
  phaseOf,
  ratioOf,
  type Phase,
} from './model'

const PANE = 'timeline'
const TITLE = 'タイムライン'

// 色は 1 色 1 義: suggestion = 進行中、success = 完了、claude = 選択中のタブ、inactive = 補助。
const PHASE: Record<Phase, { label: string; mark: string; color: 'success' | 'suggestion' | 'inactive' }> = {
  completed: { label: '完了', mark: '●', color: 'success' },
  in_progress: { label: '進行中', mark: '◐', color: 'suggestion' },
  pending: { label: '未着手', mark: '○', color: 'inactive' },
}
const KIND: Record<EntryKind, { mark: string; color: 'text' | 'success' | 'suggestion' | 'merged' | 'planMode' | 'inactive' }> = {
  session: { mark: '·', color: 'inactive' },
  prompt: { mark: '›', color: 'text' },
  plan: { mark: '◇', color: 'planMode' },
  start: { mark: '◐', color: 'suggestion' },
  done: { mark: '●', color: 'success' },
  edit: { mark: '·', color: 'inactive' },
  commit: { mark: '◆', color: 'merged' },
  push: { mark: '◆', color: 'merged' },
}
const MAX_SHOWN = 80

// 形を変えたら shape のタグを上げる（古い値を読み捨てるため）。
const project = atom({ plugin: 'progress-timeline', key: 'project' } as const, emptyProject(), {
  shape: 'project-1',
})
const view = atom(
  { plugin: 'progress-timeline', key: 'view' } as const,
  { tab: 'tree', page: -1, collapsed: [], recentOpen: false } as ViewFlags,
  { shape: 'view-3' },
)
const projectKey = atom({ plugin: 'progress-timeline', key: 'projectKey' } as const, '')
const sessionMarked = atom({ plugin: 'progress-timeline', key: 'sessionMarked' } as const, false)

type Dollar = EngineInterface

/**
 * store の最新値を土台に fn を適用し、state と store の両方に書く。
 * 同じプロジェクトを別セッションでも開いているとき、相手の記録を消さないため
 * store を正とする。fn が同じ値を返したら（追跡対象外）何も書かない。
 */
const change = async ($: Dollar, fn: (value: Project) => Project): Promise<void> => {
  const key = await read($, projectKey)
  const stored = key !== '' ? await $.store.get(key) : undefined
  const base = isProject(stored) ? stored : await read($, project)
  const value = fn(base)
  if (value === base) return
  await update($, project, () => value)
  if (key !== '') await $.store.set(key, value)
}

type Block = { type?: unknown; [k: string]: unknown }

const blocksOf = (content: unknown): Block[] =>
  Array.isArray(content) ? (content as Block[]) : typeof content === 'string' ? [{ type: 'text', text: content }] : []

const textOf = (content: unknown): string =>
  blocksOf(content)
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n')

/** 依頼文だけを取り出す。system-reminder などタグで始まるブロックは除く。 */
const promptTextOf = (content: unknown): string =>
  blocksOf(content)
    .filter(b => b.type === 'text' && typeof b.text === 'string' && !(b.text as string).trimStart().startsWith('<'))
    .map(b => b.text as string)
    .join('\n')

/**
 * 端末でプロンプトの上に出るときの高さ（既定は画面の 3 分の 1）を、
 * 中身に合わせて求める。横に並ぶとき（dock）は幅だけを求める。
 */
const openPane = async ($: Dollar) => {
  const data = await read($, project)
  const list = data.lists.reduce<Project['lists'][number] | undefined>(
    (best, l) => (best === undefined || l.updatedAt > best.updatedAt ? l : best),
    undefined,
  )
  const groups = new Set(list?.tasks.map(t => t.group).filter(g => g !== undefined)).size
  const rows = Math.min(24, Math.max(8, 6 + (list?.tasks.length ?? 0) + groups))
  return $.ui.open({ id: PANE, title: TITLE, rows, columns: 44 })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const key = `project:${e.cwd}`
    await update($, projectKey, () => key)

    // プロジェクト単位で保存した記録を読み込む（再読み込み時も store が正）。
    const stored = await $.store.get(key)
    if (isProject(stored)) await update($, project, () => stored)

    // 再読み込みでは session.start が再び走るので、1 セッション 1 回だけ記録する。
    if (!(await read($, sessionMarked))) {
      await update($, sessionMarked, () => true)
      await change($, p => applySessionStart(p, Date.now()))
    }

    await $.command.register({
      name: 'timeline',
      description: '進捗ペイン（タイムライン・プログレスバー・タスクツリー）を開く。`clear` で記録を消す',
      argumentHint: '[clear]',
    })
    // 経過時間を 1 分ごとに描き直す（再読み込みでタイマーは作り直される）。
    $.clock.every(60_000, () => $.ui.invalidate('ui.render'))
    void openPane($)
    return result
  })

  on('command.run', { command: 'timeline' }, async ($, e) => {
    if (typeof e.args === 'string' && e.args.trim() === 'clear') {
      await change($, () => emptyProject())
      return { text: 'このプロジェクトの進捗記録を消しました。' }
    }
    const opened = await openPane($)
    return { text: opened.isPlaced ? '進捗ペインを開きました。' : `進捗ペインを開けませんでした: ${opened.reason}` }
  })

  // 会話に積まれる行を観測するだけ。行そのものは変えない。
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const at = Date.now()
    const { message, door } = e

    if (door === 'prompt' && message.role === 'user' && !message.isMeta) {
      const text = promptTextOf(message.content)
      await change($, p => applyPrompt(p, text, at))
      return result
    }

    const blocks = blocksOf(message.content)
    if (door === 'response') {
      const uses = blocks.filter(b => b.type === 'tool_use')
      if (uses.length > 0) {
        await change($, p =>
          uses.reduce(
            (acc, b) =>
              applyToolUse(
                acc,
                {
                  id: String(b.id ?? ''),
                  name: String(b.name ?? ''),
                  input: (b.input ?? {}) as Record<string, unknown>,
                },
                at,
              ),
            p,
          ),
        )
      }
    } else if (door === 'tool-result') {
      const results = blocks.filter(b => b.type === 'tool_result')
      const relevant = results.filter(b => typeof b.tool_use_id === 'string')
      if (relevant.length > 0) {
        await change($, p =>
          relevant.reduce(
            (acc, b) => applyToolResult(acc, b.tool_use_id as string, textOf(b.content), b.is_error === true, at),
            p,
          ),
        )
      }
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Progress } = $.ui.resolve(e)
    // 文字数で長さを決めるバーは等幅の端末だけで使い、他はアプリ標準の Progress にする。
    const isTerminal = e.surface === 'terminal'
    const data = await read($, project)
    const flags = await read($, view)
    const now = Date.now()
    const width = Math.max(20, e.props.bodyColumns)
    const lists = data.lists
    // 端末は 1 行が貴重なので余白を行数で詰める。プロンプトの上（inline）はさらに詰める。
    const inline = e.props.placement === 'inline'
    const narrow = width < 36
    const rowGap = isTerminal ? 0 : 'sm'
    const sectionGap = isTerminal ? (inline ? 0 : 1) : 'lg'

    const latest = lists.reduce((best, list, i) => (list.updatedAt > (lists[best]?.updatedAt ?? -1) ? i : best), 0)
    const page = flags.page >= 0 && flags.page < lists.length ? flags.page : latest
    const list = lists[page]

    const meter = (ratio: number, phase: Phase, size: number, label: string, valueText: string) =>
      isTerminal ? (
        <Box flexDirection="row" flexShrink={0}>
          <Text color={PHASE[phase].color}>{'━'.repeat(Math.round(Math.min(1, ratio) * size))}</Text>
          <Text dimColor>{'─'.repeat(size - Math.round(Math.min(1, ratio) * size))}</Text>
        </Box>
      ) : (
        <Progress label={label} value={ratio} valueText={valueText} color={PHASE[phase].color} />
      )

    const currentLine = (task: Task | undefined) =>
      task && (
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0}>
            <Text color="suggestion">◐</Text>
          </Box>
          <Box flexShrink={1}>
            <Text size="footnote" wrap="truncate-end">
              {task.content}
            </Text>
          </Box>
        </Box>
      )

    // デスクトップの最小化表示: 割合と進行中のタスクだけ。
    if (e.props.placement === 'widget') {
      if (list === undefined) return <Text dimColor>タスクはまだありません</Text>
      const c = countOf(list.tasks)
      return (
        <Box flexDirection="column" gap="sm">
          <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end">
            <Text bold size="heading" tabular>
              {percent(ratioOf(list.tasks))}
            </Text>
            <Text dimColor size="caption" tabular>{`${c.done} / ${c.total}`}</Text>
          </Box>
          {meter(ratioOf(list.tasks), phaseOf(list.tasks), 16, '完了したタスク', `${c.done} / ${c.total}`)}
          {currentLine(list.tasks.find(t => t.status === 'in_progress'))}
        </Box>
      )
    }

    const setView = (fn: (v: ViewFlags) => ViewFlags) => () => update($, view, fn)
    const isOpen = (key: string) => !flags.collapsed.includes(key)
    const toggleNode = (key: string) =>
      setView(v => ({
        ...v,
        collapsed: v.collapsed.includes(key) ? v.collapsed.filter(k => k !== key) : [...v.collapsed, key],
      }))

    // ── タブ（選択中だけ claude 色）
    const tabButton = (tab: ViewFlags['tab'], hotkey: string, label: string, count?: number) => {
      const active = flags.tab === tab
      return (
        <Button key={`tab-${tab}`} plain hotkey={hotkey} onPress={setView(v => ({ ...v, tab }))}>
          <Text bold={active} color={active ? 'claude' : undefined} dimColor={!active} underline={active}>
            {label}
          </Text>
          {count !== undefined && <Text dimColor>{` ${count}`}</Text>}
        </Button>
      )
    }
    const header = (
      <Box flexDirection="row" gap={2}>
        {tabButton('tree', '1', narrow ? 'ツリー' : 'タスクツリー')}
        {tabButton('report', '2', 'レポート', data.timeline.length)}
      </Box>
    )

    // ── タイムライン: 左に固定幅の時刻、種類ごとの印、本文
    const dayOf = (at: number) => {
      const d = new Date(at)
      return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
    }
    const dayLabel = (at: number) => {
      if (dayOf(at) === dayOf(now)) return '今日'
      if (dayOf(at) === dayOf(now - 86_400_000)) return '昨日'
      const d = new Date(at)
      return `${d.getMonth() + 1}月${d.getDate()}日`
    }
    const ONE_LINE = new Set<EntryKind>(['edit', 'push', 'session'])
    const timelineRow = (item: Entry) => {
      const k = KIND[item.kind]
      return (
        <Box flexDirection="row" gap={1}>
          <Box width={6} flexShrink={0}>
            <Text dimColor size="caption" tabular>
              {clock(item.at, now)}
            </Text>
          </Box>
          <Box flexShrink={0}>
            <Text color={k.color}>{k.mark}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text
              size="footnote"
              color={item.kind === 'edit' || item.kind === 'session' ? 'inactive' : undefined}
              wrap={ONE_LINE.has(item.kind) ? (item.kind === 'edit' ? 'truncate-middle' : 'truncate-end') : undefined}
            >
              {item.text}
            </Text>
          </Box>
        </Box>
      )
    }
    const timelineByDay = (items: Entry[]) => {
      const days: { label: string; items: Entry[] }[] = []
      for (const item of items) {
        const label = dayLabel(item.at)
        const last = days[days.length - 1]
        if (last?.label === label) last.items.push(item)
        else days.push({ label, items: [item] })
      }
      return days.map(day => (
        <Box flexDirection="column" gap={rowGap}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold size="footnote">
              {day.label}
            </Text>
            <Text dimColor size="caption">{`${day.items.length} 件`}</Text>
          </Box>
          {day.items.map(timelineRow)}
        </Box>
      ))
    }

    if (flags.tab === 'report') {
      const shown = data.timeline.slice(-MAX_SHOWN).reverse()
      return (
        <Box flexDirection="column" gap={sectionGap}>
          {header}
          {shown.length === 0 && <Text dimColor>まだ記録がありません。</Text>}
          {timelineByDay(shown)}
          {data.timeline.length > MAX_SHOWN && (
            <Text dimColor size="caption">{`ほか ${data.timeline.length - MAX_SHOWN} 件`}</Text>
          )}
        </Box>
      )
    }

    if (list === undefined) {
      return (
        <Box flexDirection="column" gap={sectionGap}>
          {header}
          <Text dimColor>タスクリストはまだありません。Claude がタスクリストを作るとここに表示されます。</Text>
        </Box>
      )
    }

    // ── 見出し（全幅）と、その下にリストの切り替え
    const go = (delta: number) => setView(v => ({ ...v, page: (page + delta + lists.length) % lists.length }))
    const multi = lists.length > 1
    const subline = multi ? `${list.title} · ${page + 1} / ${lists.length}` : list.name !== undefined ? list.title : undefined
    const carousel = (
      <Box flexDirection="column" gap="xs">
        <Text weight="semibold" bold={isTerminal} wrap="truncate-end">
          {list.name ?? list.title}
        </Text>
        {subline !== undefined && (
          <Box flexDirection="row" gap={2} alignItems="center">
            {multi && (
              <Button key="prev" plain onPress={go(-1)}>
                <Text dimColor>‹</Text>
              </Button>
            )}
            <Text dimColor size="caption">
              {subline}
            </Text>
            {multi && (
              <Button key="next" plain onPress={go(1)}>
                <Text dimColor>›</Text>
              </Button>
            )}
          </Box>
        )}
      </Box>
    )

    // ── 進捗カード
    const c = countOf(list.tasks)
    const ratio = ratioOf(list.tasks)
    const phase = phaseOf(list.tasks)
    const current = list.tasks.find(t => t.status === 'in_progress')
    const card = (
      <Box
        flexDirection="column"
        gap="sm"
        borderStyle="round"
        borderColor={phase === 'completed' ? 'success' : 'subtle'}
        paddingX={isTerminal ? 1 : 2}
        paddingY={isTerminal ? 0 : 1}
      >
        <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
          <Box flexDirection="column">
            <Text bold size="title" tabular color={phase === 'completed' ? 'success' : undefined}>
              {percent(ratio)}
            </Text>
            {isTerminal && <Text dimColor>{`${c.done}/${c.total} 件のタスクが完了`}</Text>}
          </Box>
          <Box flexDirection="column" alignItems="flex-end">
            <Text color={PHASE[phase].color} size="footnote">{`${PHASE[phase].mark} ${PHASE[phase].label}`}</Text>
            <Text dimColor size="caption">{`経過 ${elapsed(now - (list.startedAt ?? list.updatedAt))}`}</Text>
          </Box>
        </Box>
        {meter(ratio, phase, Math.max(8, width - 6), '完了したタスク', `${c.done} / ${c.total}`)}
        {currentLine(current)}
        {phase !== 'completed' && (
          <Box flexDirection="row" justifyContent="flex-end">
            <Button key="continue" onPress={() => void $.prompt.submit({ text: '残りのタスクを続けてください。' })}>
              ▷ 続行を依頼
            </Button>
          </Box>
        )}
      </Box>
    )

    // ── タスクの行: 印 / 見出し（状態は印と文字の強さで示す）
    const taskRow = (task: Task, indent: number) => {
      const p = PHASE[task.status]
      return (
        <Box flexDirection="row" gap={1} paddingLeft={indent}>
          <Box flexShrink={0}>
            <Text color={p.color}>{p.mark}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1}>
            <Text
              weight={task.status === 'in_progress' ? 'semibold' : 'regular'}
              bold={isTerminal && task.status === 'in_progress'}
              dimColor={task.status === 'completed'}
            >
              {task.content}
            </Text>
          </Box>
        </Box>
      )
    }

    const groupBlock = (group: string, tasks: Task[]) => {
      const key = `group:${list.source}:${group}`
      const open = isOpen(key)
      const g = countOf(tasks)
      const ph = phaseOf(tasks)
      return (
        <Box flexDirection="column" gap={rowGap}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Box flexGrow={1} flexShrink={1}>
              <Button key={key} plain onPress={toggleNode(key)}>
                <Text dimColor>{open ? '▾ ' : '▸ '}</Text>
                <Text
                  dimColor={ph === 'completed'}
                  weight={ph === 'in_progress' ? 'semibold' : 'regular'}
                  bold={isTerminal && ph === 'in_progress'}
                >
                  {group}
                </Text>
              </Button>
            </Box>
            <Box flexShrink={0} flexDirection="row">
              {ph === 'completed' && <Text color="success">✓ </Text>}
              <Text dimColor size="caption" tabular>{`${g.done}/${g.total}`}</Text>
            </Box>
          </Box>
          {open && <Box flexDirection="column" gap={rowGap}>{tasks.map(t => taskRow(t, 2))}</Box>}
        </Box>
      )
    }

    const tree = (
      <Box flexDirection="column" gap={rowGap}>
        {groupTasks(list.tasks).map(slot =>
          slot.group === undefined ? (
            <Box flexDirection="column" gap={rowGap}>{slot.tasks.map(t => taskRow(t, 0))}</Box>
          ) : (
            groupBlock(slot.group, slot.tasks)
          ),
        )}
      </Box>
    )

    // ── 最近の動き（閉じているときは最新 1 件を同じ行に）
    const recent = data.timeline.slice(-5).reverse()
    const newest = recent[0]
    const recentSection = (
      <Box flexDirection="column" gap={rowGap}>
        <Box flexDirection="row" gap={1}>
          <Box flexShrink={0}>
            <Button key="recent" plain onPress={setView(v => ({ ...v, recentOpen: !v.recentOpen }))}>
              <Text dimColor>{flags.recentOpen ? '▾ ' : '▸ '}</Text>
              <Text bold dimColor size="caption">
                最近の動き
              </Text>
            </Button>
          </Box>
          {!flags.recentOpen && newest !== undefined && (
            <Box flexShrink={1}>
              <Text dimColor size="caption" wrap="truncate-end">{`${clock(newest.at, now)} ${newest.text}`}</Text>
            </Box>
          )}
        </Box>
        {flags.recentOpen && <Box flexDirection="column" gap={rowGap}>{recent.map(timelineRow)}</Box>}
      </Box>
    )

    if (isTerminal) {
      // 端末: 枠を使わず、割合・バー・件数を 1 行、進行中のタスクと経過・続行を 1 行にまとめる。
      const pct = percent(ratio)
      const cnt = `${c.done}/${c.total}`
      const barSize = Math.max(4, width - pct.length - cnt.length - 2)
      const filled = Math.round(Math.min(1, ratio) * barSize)
      return (
        <Box flexDirection="column" gap={sectionGap}>
          {header}
          <Box flexDirection="column">
            <Text bold wrap="truncate-end">
              {list.name ?? list.title}
            </Text>
            {multi && (
              <Box flexDirection="row" gap={1}>
                <Button key="prev" plain onPress={go(-1)}>
                  <Text dimColor>‹</Text>
                </Button>
                <Box flexShrink={1}>
                  <Text dimColor wrap="truncate-end">{`${list.title} ${page + 1}/${lists.length}`}</Text>
                </Box>
                <Button key="next" plain onPress={go(1)}>
                  <Text dimColor>›</Text>
                </Button>
              </Box>
            )}
            <Box flexDirection="row" gap={1}>
              <Box flexShrink={0}>
                <Text bold color={phase === 'completed' ? 'success' : undefined}>
                  {pct}
                </Text>
              </Box>
              <Box flexDirection="row" flexShrink={0}>
                <Text color={PHASE[phase].color}>{'━'.repeat(filled)}</Text>
                <Text dimColor>{'─'.repeat(barSize - filled)}</Text>
              </Box>
              <Box flexShrink={0}>
                <Text dimColor>{cnt}</Text>
              </Box>
            </Box>
            <Box flexDirection="row" gap={1} justifyContent="space-between">
              <Box flexDirection="row" gap={1} flexShrink={1}>
                <Box flexShrink={0}>
                  <Text color={PHASE[phase].color}>{PHASE[phase].mark}</Text>
                </Box>
                <Box flexShrink={1}>
                  <Text wrap="truncate-end">{current?.content ?? PHASE[phase].label}</Text>
                </Box>
              </Box>
              <Box flexDirection="row" gap={1} flexShrink={0}>
                {!narrow && <Text dimColor>{elapsed(now - (list.startedAt ?? list.updatedAt))}</Text>}
                {phase !== 'completed' && (
                  <Button key="continue" plain onPress={() => void $.prompt.submit({ text: '残りのタスクを続けてください。' })}>
                    <Text color="claude">▷ 続行</Text>
                  </Button>
                )}
              </Box>
            </Box>
          </Box>
          {tree}
          {recentSection}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={sectionGap}>
        {header}
        {carousel}
        {card}
        {tree}
        {recentSection}
      </Box>
    )
  })
}
