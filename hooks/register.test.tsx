import type { On } from 'claude-code'
import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { Project } from '../types'
import { applyPlan, applyToolResult, applyToolUse, emptyProject, countOf } from './model'

const AT = 1_700_000_000_000
const PLAN = 'mcp__ccd_turn__update_plan'
const TODOS = 'mcp__todo-tree__set_todos'

const use = (name: string, input: Record<string, unknown>, id = 'u1') => ({ id, name, input })

test('update_plan: items で置き換え、advance で次へ進む', async () => {
  let p = applyToolUse(
    emptyProject(),
    use(PLAN, {
      items: [
        { content: 'A', status: 'in_progress' },
        { content: 'B', status: 'pending' },
        { content: 'C', status: 'pending' },
      ],
    }),
    AT,
  )
  p = applyToolUse(p, use(PLAN, { advance: true }), AT + 1)
  const tasks = p.lists[0]?.tasks ?? []
  expect(tasks.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(p.timeline.map(e => e.kind)).toEqual(['plan', 'start', 'done', 'start'])
})

test('update_plan: done と start は 1 始まり', async () => {
  const base = [
    { id: '1', content: 'A', status: 'pending' as const },
    { id: '2', content: 'B', status: 'pending' as const },
    { id: '3', content: 'C', status: 'pending' as const },
  ]
  const after = applyPlan(base, { done: [2], start: 3 })
  expect(after.map(t => t.status)).toEqual(['pending', 'completed', 'in_progress'])
})

test('set_todos: group を保ち、全量で置き換える', async () => {
  const p = applyToolUse(
    emptyProject(),
    use(TODOS, {
      todos: [
        { content: 'x', status: 'completed', group: '準備' },
        { content: 'y', status: 'in_progress', group: '実装' },
      ],
    }),
    AT,
  )
  const list = p.lists[0]
  expect(list?.title).toBe('TODO ツリー')
  expect(list?.tasks.map(t => t.group)).toEqual(['準備', '実装'])
  expect(countOf(list?.tasks ?? [])).toEqual({ done: 1, active: 1, total: 2 })
})

test('TaskCreate は結果文の番号を id にし、TaskUpdate で更新する', async () => {
  let p = applyToolUse(emptyProject(), use('TaskCreate', { subject: 'S', description: 'd' }, 't1'), AT)
  expect(p.lists).toEqual([])
  p = applyToolResult(p, 't1', 'Task #7 created successfully: S', false, AT)
  expect(p.lists[0]?.tasks[0]?.id).toBe('7')
  p = applyToolUse(p, use('TaskUpdate', { taskId: '7', status: 'completed' }, 't2'), AT)
  expect(p.lists[0]?.tasks[0]?.status).toBe('completed')
  p = applyToolUse(p, use('TaskUpdate', { taskId: '7', status: 'deleted' }, 't3'), AT)
  expect(p.lists[0]?.tasks).toEqual([])
})

test('編集は続けて行うと 1 行に束ね、git commit を拾う', async () => {
  let p = applyToolUse(emptyProject(), use('Edit', { file_path: '/a/x.ts' }), AT)
  p = applyToolUse(p, use('Write', { file_path: '/a/y.ts' }), AT + 1000)
  p = applyToolUse(p, use('Bash', { command: 'git commit -m "feat: 追加"' }), AT + 2000)
  expect(p.timeline.map(e => e.text)).toEqual(['編集: x.ts, y.ts', 'コミット: feat: 追加'])
})

test('heredoc で渡したコミットメッセージの 1 行目を拾い、同じコマンドの push も記録する', async () => {
  const viaSubst = `git add a.ts && git commit -m "$(cat <<'EOF'
feat: 置換で渡す

本文
EOF
)" && git push`
  const viaFile = `git commit -q -F - <<'EOF'
fix: 標準入力で渡す
EOF
sed -i '' 's/a/b/' x && git commit -F - <<"MSG"

chore: 2 つ目
MSG`
  let p = applyToolUse(emptyProject(), use('Bash', { command: viaSubst }), AT)
  p = applyToolUse(p, use('Bash', { command: viaFile }), AT + 1000)
  expect(p.timeline.map(e => e.text)).toEqual([
    'コミット: feat: 置換で渡す',
    'push',
    'コミット: fix: 標準入力で渡す',
    'コミット: chore: 2 つ目',
  ])
})

const SEEDED: Project = applyToolUse(
  emptyProject(),
  use(TODOS, {
    todos: [
      { content: '設計', status: 'completed', group: '準備' },
      { content: '実装する', status: 'in_progress', group: '実装' },
    ],
  }),
  AT,
)

const PANE = {
  plugin: 'progress-timeline',
  component: 'Pane',
  requestId: 'timeline',
  props: {
    title: '進捗',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('タスクツリー: 進捗カードとグループ・タスクの行を描く（全 surface）', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^実装する$/ }))?.text).toBe('実装する')
    if (surface === 'terminal') expect((await ui.find({ type: 'Text', text: /^1\/2$/ }))?.text).toBe('1/2')
    else expect((await ui.find({ type: 'Text', text: /^◐ 進行中$/ }))?.text).toBe('◐ 進行中')
    expect((await ui.find({ type: 'Text', text: /^50%$/ }))?.text).toBe('50%')
    await ui.unmount()
  }
})

test('完了したタスクは緑を使わず灰色の打ち消し線で描く', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const done = await ui.find({ type: 'Text', text: /^設計$/ })
    expect(done?.props.strikethrough).toBe(true)
    expect(done?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: /^●$/ }))?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: /^実装する$/ }))?.props.strikethrough).not.toBe(true)
    await ui.unmount()
  }
})

test('グループの見出しに完了数のバーを付ける', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const desktop = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desktop.find({ type: 'Text', text: /^✓ 1\/1$/ }))?.text).toBe('✓ 1/1')
  expect((await desktop.find({ type: 'Text', text: /^0\/1$/ }))?.text).toBe('0/1')
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ type: 'Text', text: /^✓ 1\/1$/ }))?.text).toBe('✓ 1/1')
  expect((await terminal.find({ type: 'Text', text: /^0\/1$/ }))?.text).toBe('0/1')
  await terminal.unmount()
})

test('デスクトップのバーは割合の幅で切った下線で細く描く', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.find(b => b.props.width === '50%')?.props.overflow).toBe('hidden')
  // 改行しない空白に下線。wrap を付けると切れ目に「…」が出るので付けない。
  const lines = await ui.findAll({ type: 'Text', text: /^\u00a0+$/ })
  expect(lines[0]?.props.underline).toBe(true)
  expect(lines[0]?.props.color).toBe('suggestion')
  expect(lines.every(l => l.props.wrap === undefined)).toBe(true)
  // 罫線の文字は使わない（デスクトップでは折り返して何段にも重なる）。
  expect(await ui.find({ type: 'Text', text: /[━─]/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^完了したタスク 1 \/ 2$/ }))?.text).toBe('完了したタスク 1 / 2')
  await ui.unmount()
})

test('割り切れない割合（3/7）でもデスクトップで描ける', async ($, on) => {
  const seventh = applyToolUse(
    emptyProject(),
    use(PLAN, {
      items: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((content, i) => ({
        content,
        status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending',
      })),
    }),
    AT,
  )
  mock.store(on, { 'project:/proj': seventh })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const placement of ['dock', 'widget'] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement }, surface: 'desktop' })
    expect((await ui.find({ type: 'Text', text: /^D$/ }))?.text).toBe('D')
    expect((await ui.findAll({ type: 'Box' })).some(b => b.props.width === '43%')).toBe(true)
    await ui.unmount()
  }
})

test('端末のプロンプト上（inline・狭い幅）では詰めた表示にする', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({
    ...PANE,
    props: { ...PANE.props, placement: 'inline', bodyColumns: 28, scroll: { offset: 0, bodyRows: 10 } },
    surface: 'terminal',
  })
  expect((await ui.find({ type: 'Text', text: /^ツリー$/ }))?.text).toBe('ツリー')
  // バーは細い罫線。完了した分（先頭の色付きの線）は 10 セル。
  const filled = await ui.find({ type: 'Text', text: /^─+$/ })
  expect(filled?.text.length).toBe(10)
  expect(filled?.props.color).toBe('suggestion')
  expect((await ui.find({ type: 'Text', text: /^▷ 続行$/ }))?.text).toBe('▷ 続行')
  await ui.unmount()
})

test('レポートタブにタイムラインを描く', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-report' })
    expect((await ui.find({ type: 'Text', text: /計画を更新/ }))?.text).toBe('計画を更新 (2 件)')
    expect((await ui.find({ type: 'Text', text: /セッション開始/ }))?.text).toBe('セッション開始')
    await ui.press({ key: 'tab-tree' })
    await ui.unmount()
  }
})

test('ツリーのノードを押すと折りたたむ', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'group:mcp__todo-tree__set_todos:準備' })
    expect(await ui.find({ type: 'Text', text: /^設計$/ })).toBeUndefined()
    await ui.press({ key: 'group:mcp__todo-tree__set_todos:準備' })
    expect((await ui.find({ type: 'Text', text: /^設計$/ }))?.text).toBe('設計')
    await ui.unmount()
  }
})

test('widget では進捗だけを描く', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, placement: 'widget' }, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /◐ 進行中/ })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /実装する/ }))?.text).toBe('実装する')
  await ui.unmount()
})

const start = async ($: Engine, on: On) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
}

const response = (blocks: unknown[], agentId?: string) => ({
  message: { type: 'assistant' as const, role: 'assistant' as const, content: blocks as never },
  door: 'response' as const,
  origin: { kind: 'model' as const, model: 'm' } as never,
  uuid: `r-${Math.random()}`,
  ...(agentId ? { agentId } : {}),
})

test('session.append: response の tool_use からリストを作り、サブエージェントの行は無視する', async ($, on) => {
  mock.store(on)
  mock.session(on)
  await start($, on)

  await $.session.append(
    response([{ type: 'tool_use', id: 'a', name: TODOS, input: { todos: [{ content: 'X', status: 'in_progress', group: 'G' }] } }]) as never,
  )
  await $.session.append(response([{ type: 'tool_use', id: 'b', name: TODOS, input: { todos: [{ content: 'Y', status: 'pending' }] } }], 'sub1') as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /^X$/ }))?.text).toBe('X')
  expect(await ui.find({ type: 'Text', text: /^Y$/ })).toBeUndefined()
  await ui.unmount()
})

test('session.append: 依頼文は system-reminder を除いて記録する', async ($, on) => {
  mock.store(on)
  mock.session(on)
  await start($, on)

  await $.session.append({
    message: {
      type: 'user',
      role: 'user',
      content: [
        { type: 'text', text: '<system-reminder>x</system-reminder>' },
        { type: 'text', text: 'ペインを作って' },
      ],
    },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: 'p1',
  } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-report' })
  expect((await ui.find({ type: 'Text', text: /ペインを作って/ }))?.text).toBe('ペインを作って')
  expect(await ui.find({ type: 'Text', text: /system-reminder/ })).toBeUndefined()
  await ui.unmount()
})

const runProgress = ($: Engine) =>
  $.command.run({
    command: 'progress',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 80 },
  })

test('/progress: ペインを開き、割合・件数・進行中のタスクを返す', async ($, on) => {
  mock.store(on, { 'project:/proj': SEEDED })
  await start($, on)
  const result = await runProgress($)
  const lines = (result.text ?? '').split('\n')
  // 幅 80 列ではバーは 30 セル。
  expect(lines).toContain(`${'━'.repeat(15)}${'─'.repeat(15)} 50%  1/2 件完了`)
  expect(lines.some(l => /^◐ 進行中 · 経過 /.test(l))).toBe(true)
  expect(lines).toContain('▾ 準備  1/1 ✓')
  expect(lines).toContain('  ● 設計')
  expect(lines).toContain('▾ 実装  0/1')
  expect(lines).toContain('  ◐ 実装する')
})

test('/progress: リストが無いときはその旨を返す', async ($, on) => {
  mock.store(on)
  await start($, on)
  const result = await runProgress($)
  expect(result.text).toContain('タスクリストはまだありません')
})
