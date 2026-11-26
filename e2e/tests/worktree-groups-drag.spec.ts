import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../fixtures/tauri-mock'
import { project, worktree1, worktree2 } from '../fixtures/invoke-handlers'
import { createWorktree } from '../fixtures/mock-data'

const groupA = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Alpha',
  order: 0,
}
const groupB = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Beta',
  order: 1,
}

const worktree3 = createWorktree(project.id, {
  name: 'brave-otter',
  branch: 'brave-otter',
  created_at: 500,
  order: 2,
  path: '/tmp/e2e-test-project/.worktrees/brave-otter',
})

const row = (page: Page, id: string) =>
  page.locator(
    `[data-pdnd-worktree-scope="worktree-list"][data-pdnd-worktree-id="${id}"]`
  )
const header = (page: Page, id: string) =>
  page.locator(
    `[data-worktree-group-scope="worktree-list"][data-worktree-group-id="${id}"]`
  )

/** Sidebar row / header ids in DOM order. */
async function sidebarOrder(page: Page) {
  return page
    .locator(
      '[data-pdnd-worktree-scope="worktree-list"], [data-worktree-group-scope="worktree-list"]'
    )
    .evaluateAll(nodes =>
      nodes.map(node => {
        const el = node as HTMLElement
        return el.dataset.worktreeGroupId
          ? `group:${el.dataset.worktreeGroupId}`
          : (el.dataset.pdndWorktreeId ?? '')
      })
    )
}

async function drag(
  page: Page,
  source: Locator,
  target: Locator,
  yRatio = 0.5
) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  expect(sourceBox).not.toBeNull()
  expect(targetBox).not.toBeNull()
  if (!sourceBox || !targetBox) return
  const startX = sourceBox.x + sourceBox.width / 2
  const startY = sourceBox.y + sourceBox.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX, startY + 12, { steps: 4 })
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height * yRatio,
    { steps: 12 }
  )
  await page.mouse.up()
}

test.describe('Worktree groups drag', () => {
  test.use({
    responseOverrides: {
      get_server_capabilities: {
        schemaVersion: 1,
        appVersion: '',
        capabilities: { worktreeGroups: 1 },
        magicPrompts: [],
      },
      list_projects: [{ ...project, worktree_groups: [groupA, groupB] }],
      list_worktrees: [
        { ...worktree1, order: 1, group_id: groupA.id },
        { ...worktree2, order: 2, group_id: groupA.id },
        { ...worktree3, order: 3, group_id: groupB.id },
      ],
    },
  })

  test('moves worktrees onto group headers and reorders groups', async ({
    mockPage,
  }) => {
    await expect(mockPage.getByText('Test Project')).toBeVisible({
      timeout: 5000,
    })
    const workspaceTab = mockPage.getByRole('tab', { name: 'Workspace' })
    if (!(await workspaceTab.isVisible().catch(() => false))) {
      await mockPage.keyboard.press('ControlOrMeta+b')
      await mockPage.waitForTimeout(500)
    }
    await expect(workspaceTab).toBeVisible({ timeout: 3000 })

    await expect(header(mockPage, groupB.id)).toBeVisible()
    await expect
      .poll(() => sidebarOrder(mockPage))
      .toEqual([
        `group:${groupA.id}`,
        worktree1.id,
        worktree2.id,
        `group:${groupB.id}`,
        worktree3.id,
        'group:ungrouped',
      ])

    // 1. worktree onto the other group's header -> end of that group
    await drag(
      mockPage,
      row(mockPage, worktree1.id),
      header(mockPage, groupB.id)
    )
    await expect
      .poll(() => sidebarOrder(mockPage))
      .toEqual([
        `group:${groupA.id}`,
        worktree2.id,
        `group:${groupB.id}`,
        worktree3.id,
        worktree1.id,
        'group:ungrouped',
      ])

    // 2. a second drag in the same page -> Ungrouped
    await drag(
      mockPage,
      row(mockPage, worktree2.id),
      header(mockPage, 'ungrouped')
    )
    await expect
      .poll(() => sidebarOrder(mockPage))
      .toEqual([
        `group:${groupA.id}`,
        `group:${groupB.id}`,
        worktree3.id,
        worktree1.id,
        'group:ungrouped',
        worktree2.id,
      ])

    // 3. drag the Beta header above the Alpha header
    await drag(
      mockPage,
      header(mockPage, groupB.id),
      header(mockPage, groupA.id),
      0.2
    )
    await expect
      .poll(() => sidebarOrder(mockPage))
      .toEqual([
        `group:${groupB.id}`,
        worktree3.id,
        worktree1.id,
        `group:${groupA.id}`,
        'group:ungrouped',
        worktree2.id,
      ])
  })
})
