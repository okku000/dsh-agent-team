// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { runtimeWithTeam } from './harness.tsx'
import { STORAGE_KEY } from '../src/client/navigation.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)
beforeEach(() => { localStorage.clear() })

type Bench = Awaited<ReturnType<typeof runtimeWithTeam>>

/**
 * One routine as the Host's routine API reports it. A saved routine carries the
 * attribution that tells it from an operator's own declaration in the profile,
 * which is also what earns it the edit and delete the store can honour.
 */
function routineRow(name: string, declaration: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    origin: 'store',
    declaration: { name, member: 'member:builder', prompt: `run ${name}`, once: false, cron: '*/15 * * * *', ...declaration },
    createdBy: { kind: 'human', memberId: 'member:human', handle: 'human' },
    createdAt: '2026-09-25T02:00:00.000Z',
    ...overrides,
  }
}

/** Open the routine page the way a reader does: through its own sidebar entry. */
async function openRoutines(b: Bench): Promise<HTMLElement> {
  fireEvent.click(await b.view.findByRole('button', { name: '定时任务' }))
  return waitFor(() => {
    const page = b.view.container.querySelector<HTMLElement>('[data-team-routines]')
    expect(page).toBeTruthy()
    return page!
  })
}

/** The card a routine's name sits on; the row is the article around its head. */
function cardOf(page: HTMLElement, name: string): HTMLElement {
  return within(page).getByText(name).closest('article')!
}

describe('Team routine surfaces', () => {
  it('shows the Host’s whole schedule once, naming each woken Member by handle', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedRoutines([
      routineRow('morning-check'),
      routineRow('weekly-sweep', { member: 'member:worker', prompt: '把待办整理一遍', cron: '0 9 * * 1' }),
      routineRow('operator-pinned', {}, {
        origin: 'config',
        declaration: { name: 'operator-pinned', member: 'member:builder', prompt: 'operator declared', cron: '0 * * * *' },
        createdBy: undefined,
        createdAt: undefined,
      }),
    ])
    const page = await openRoutines(b)
    expect(await within(page).findByText('morning-check')).toBeTruthy()
    expect(within(page).getByText('3 条定时任务')).toBeTruthy()
    // The Workspace on the request is a fence rather than a scope: the Host
    // answers its whole schedule to a caller bound to a Workspace that exists,
    // so the page reads once through the first visible one instead of merging a
    // per-Workspace slice that would repeat every row.
    expect(b.routines).toHaveBeenCalledWith({ workspaceId: 'w1' })
    expect(b.routines.mock.calls.every(call => call[0].workspaceId === 'w1')).toBe(true)
    expect(within(page).getAllByText('morning-check')).toHaveLength(1)
    // The store holds a branded Member id; the roster is what turns it back into
    // the handle a reader recognizes.
    expect(within(page).getByText('唤醒 @worker')).toBeTruthy()
    // The expression leads the schedule line exactly as it was saved, and the
    // next fire rides behind it in the Host's zone rather than the reader's.
    expect(within(page).getByText(/^cron 0 9 \* \* 1 · 每次到点都触发 · 下次 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)).toBeTruthy()
    // Only a stored routine is editable: an operator's own declaration belongs
    // to their profile file, and a button the Host would refuse is worse than
    // saying where the row comes from.
    const declared = cardOf(page, 'operator-pinned')
    expect(declared.getAttribute('data-origin')).toBe('config')
    expect(within(declared).getByText('profile 声明')).toBeTruthy()
    expect(within(declared).queryByRole('button', { name: '编辑' })).toBeNull()
    expect(within(declared).queryByRole('button', { name: '删除' })).toBeNull()
    const stored = cardOf(page, 'morning-check')
    expect(stored.getAttribute('data-origin')).toBe('store')
    expect(within(stored).getByRole('button', { name: '编辑' })).toBeTruthy()
    expect(within(stored).getByRole('button', { name: '删除' })).toBeTruthy()
    await b.runtime.dispose()
  })

  it('creates a routine through the form, answering the reader’s own mistakes before the round trip', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const page = await openRoutines(b)
    fireEvent.click(within(page).getByRole('button', { name: '新建定时任务' }))
    const dialog = await b.view.findByRole('dialog', { name: '新建定时任务' })
    // A name the Host cannot run is refused here, with nothing sent: the editor
    // mirrors the Host's rules so a fixable refusal never becomes a remote error.
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('名称只能以字母或数字开头')
    expect(b.saveRoutine).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'nightly' } })
    fireEvent.change(within(dialog).getByLabelText('指令'), { target: { value: '检查模型目录有没有变化' } })
    // An empty trigger is its own refusal: a routine has no other way to say when.
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('请填写 cron 表达式')
    expect(b.saveRoutine).not.toHaveBeenCalled()
    fireEvent.change(within(dialog).getByLabelText('cron 表达式'), { target: { value: '0 9 * * 1' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(b.view.queryByRole('dialog')).toBeNull())
    // The picker's default target is a branded Member id, and the expression the
    // reader wrote is the one that is saved.
    expect(b.saveRoutine).toHaveBeenCalledWith({
      workspaceId: 'w1',
      routine: { name: 'nightly', member: 'member:builder', prompt: '检查模型目录有没有变化', once: false, cron: '0 9 * * 1' },
    })
    // A routine save emits no Team `changes` event — it is configuration, not a
    // ledger fact — so the page re-reads itself and the row appears unwoken.
    expect(await within(page).findByText('nightly')).toBeTruthy()
    expect(b.routines.mock.calls.length).toBeGreaterThan(1)
    await b.runtime.dispose()
  })

  it('answers an expression while it is written, with the Host’s own parser and zone', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const page = await openRoutines(b)
    fireEvent.click(within(page).getByRole('button', { name: '新建定时任务' }))
    const dialog = await b.view.findByRole('dialog', { name: '新建定时任务' })
    expect(within(dialog).getByText('按 Host 所在时区（Asia/Tokyo）计算')).toBeTruthy()
    // Nothing is claimed about an expression that has not been written yet.
    expect(within(dialog).queryByText('接下来 3 次')).toBeNull()
    const field = within(dialog).getByLabelText('cron 表达式')
    fireEvent.change(field, { target: { value: '*/15 * * * *' } })
    expect(within(dialog).getByText('接下来 3 次')).toBeTruthy()
    // Three instants, and each one is a wall-clock reading, not an offset.
    expect(within(dialog).getAllByRole('listitem').map(item => item.textContent))
      .toHaveLength(3)
    expect(within(dialog).getAllByRole('listitem').every(item => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(item.textContent ?? ''))).toBe(true)
    // The parser's own message travels into the reader's language, and the
    // refusal the reader can fix never reaches the Host.
    fireEvent.change(field, { target: { value: '0 9 * *' } })
    expect(within(dialog).getByText(/这个 cron 表达式读不出来：.*must have five fields/)).toBeTruthy()
    fireEvent.change(field, { target: { value: '0 0 30 2 *' } })
    expect(within(dialog).getByText('这个表达式在五年内不会触发，请检查日、月、周字段')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'never' } })
    fireEvent.change(within(dialog).getByLabelText('指令'), { target: { value: 'nope' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain('这个表达式在五年内不会触发')
    expect(b.saveRoutine).not.toHaveBeenCalled()
    await b.runtime.dispose()
  })

  it('keeps the editor open with the Host’s own reason when a save is refused', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    const page = await openRoutines(b)
    fireEvent.click(within(page).getByRole('button', { name: '新建定时任务' }))
    const dialog = await b.view.findByRole('dialog', { name: '新建定时任务' })
    b.failRoutineSave('member:builder is archived')
    fireEvent.change(within(dialog).getByLabelText('名称'), { target: { value: 'nightly' } })
    fireEvent.change(within(dialog).getByLabelText('指令'), { target: { value: '检查模型目录' } })
    fireEvent.change(within(dialog).getByLabelText('cron 表达式'), { target: { value: '0 9 * * *' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }))
    // A declaration the Host cannot run is refused whole: the dialog keeps the
    // reader's work and says why, and the running schedule is untouched.
    expect((await within(dialog).findByRole('alert')).textContent).toContain('member:builder is archived')
    expect(b.view.getByRole('dialog', { name: '新建定时任务' })).toBeTruthy()
    expect(within(page).getByText('还没有定时任务')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('confirms a delete, then re-reads the Host’s list instead of dropping the row locally', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedRoutines([routineRow('nightly')])
    const page = await openRoutines(b)
    fireEvent.click(within(await waitFor(() => Promise.resolve(cardOf(page, 'nightly')))).getByRole('button', { name: '删除' }))
    const dialog = await b.view.findByRole('dialog', { name: '删除「nightly」？' })
    expect(dialog.textContent).toContain('删除后这条定时任务不会再触发')
    // Nothing leaves the surface until the reader confirms.
    expect(b.deleteRoutine).not.toHaveBeenCalled()
    expect(within(page).getByText('nightly')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }))
    await waitFor(() => expect(b.deleteRoutine).toHaveBeenCalledWith({ workspaceId: 'w1', name: 'nightly' }))
    await waitFor(() => expect(b.view.queryByRole('dialog')).toBeNull())
    expect(await within(page).findByText('还没有定时任务')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('answers a refused read with the Host’s reason and re-reads on retry', async () => {
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'w1' })
    b.seedRoutines([routineRow('nightly')])
    b.failRoutineRead('schedule unreadable')
    const page = await openRoutines(b)
    // A failed read is its own state: it never masquerades as an empty schedule.
    expect((await within(page).findByRole('alert')).textContent).toContain('schedule unreadable')
    expect(within(page).queryByText('还没有定时任务')).toBeNull()
    b.failRoutineRead()
    fireEvent.click(within(page).getByRole('button', { name: '重试' }))
    expect(await within(page).findByText('nightly')).toBeTruthy()
    await b.runtime.dispose()
  })

  it('stands on a remembered stale Workspace rather than being pulled back to an overview', async () => {
    // A reload reopens the routine page on the Workspace the snapshot remembers,
    // which the registry no longer holds. Like the Inbox the routine page
    // crosses Workspaces, so the seat's auto-select must not reconcile that
    // stale selection by leaving the global face the reader asked for.
    const b = await runtimeWithTeam({ mode: 'team', workspaceId: 'stale', routines: true })
    const page = await waitFor(() => {
      const found = b.view.container.querySelector<HTMLElement>('[data-team-routines]')
      expect(found).toBeTruthy()
      return found!
    })
    // The page really stands and really read: this is the schedule, not a seat
    // the auto-select is about to replace with a Workspace overview. The fence
    // is the first visible Workspace rather than the remembered selection, so
    // nothing here depends on that stale id — which is exactly why reconciling
    // it must not cost the reader the face they are on.
    expect(await within(page).findByText('还没有定时任务')).toBeTruthy()
    expect(b.routines).toHaveBeenCalledWith({ workspaceId: 'w1' })
    await waitFor(() => expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')).toMatchObject({ routines: true, workspaceId: 'stale' }))
    await b.runtime.dispose()
  })
})
