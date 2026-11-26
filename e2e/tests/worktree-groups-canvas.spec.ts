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

const CANVAS_LIST = '[data-testid="canvas-worktree-list"]'

const canvasHeader = (page: Page, groupId: string) =>
  page.locator(
    `${CANVAS_LIST} [data-worktree-group-scope="canvas-worktree-list"][data-worktree-group-id="${groupId}"]`
  )
const canvasRow = (page: Page, worktreeId: string) =>
  page.locator(
    `${CANVAS_LIST} [data-pdnd-worktree-scope="canvas-worktree-list"][data-pdnd-worktree-id="${worktreeId}"]`
  )

/** Canvas row / header ids in DOM order. */
async function canvasOrder(page: Page) {
  return page
    .locator(
      `${CANVAS_LIST} [data-pdnd-worktree-scope="canvas-worktree-list"], ${CANVAS_LIST} [data-worktree-group-scope="canvas-worktree-list"]`
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

test.describe('Worktree groups on the project canvas', () => {
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
        { ...worktree2, order: 2, group_id: groupB.id },
        { ...worktree3, order: 3, group_id: null },
      ],
    },
  })

  for (const viewport of [
    { name: 'desktop web', width: 1280, height: 900 },
    { name: 'mobile web', width: 390, height: 844 },
  ]) {
    test(`${viewport.name}: groups replace state headers and collapse`, async ({
      mockPage,
    }) => {
      await mockPage.setViewportSize(viewport)

      await expect(canvasHeader(mockPage, groupA.id)).toBeVisible({
        timeout: 10000,
      })
      await expect(canvasHeader(mockPage, groupB.id)).toBeVisible()
      await expect
        .poll(() => canvasOrder(mockPage))
        .toEqual([
          `group:${groupA.id}`,
          worktree1.id,
          `group:${groupB.id}`,
          worktree2.id,
          'group:ungrouped',
          worktree3.id,
        ])
      // State headers are replaced by the groups.
      await expect(
        mockPage.locator(CANVAS_LIST).getByText('Idle', { exact: true })
      ).toHaveCount(0)

      // Collapse Alpha: its row goes, the others stay.
      await canvasHeader(mockPage, groupA.id).click()
      await expect(canvasHeader(mockPage, groupA.id)).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      await expect(canvasRow(mockPage, worktree1.id)).toHaveCount(0)
      await expect(canvasRow(mockPage, worktree2.id)).toBeVisible()

      // Keyboard toggle on the header expands it again.
      await canvasHeader(mockPage, groupA.id).focus()
      await mockPage.keyboard.press('Enter')
      await expect(canvasRow(mockPage, worktree1.id)).toBeVisible()

      if (viewport.width < 768) {
        await mockPage
          .getByRole('button', { name: 'Show Left Sidebar' })
          .click()
        const sidebar = mockPage.locator('[data-testid="mobile-left-sidebar"]')
        await expect(
          sidebar.locator(
            `[data-worktree-group-scope="worktree-list"][data-worktree-group-id="${groupA.id}"]`
          )
        ).toBeVisible()
        await expect(
          sidebar.locator(
            `[data-worktree-group-scope="worktree-list"][data-worktree-group-id="${groupB.id}"]`
          )
        ).toBeVisible()
      }
    })
  }

  test('desktop web: drags rows between groups and reorders groups', async ({
    mockPage,
  }) => {
    await mockPage.setViewportSize({ width: 1280, height: 900 })
    await expect(canvasHeader(mockPage, groupA.id)).toBeVisible({
      timeout: 10000,
    })

    // 1. Ungrouped row (from its grip) onto the Alpha header -> end of Alpha
    await canvasRow(mockPage, worktree3.id).hover()
    const grip = mockPage
      .locator(CANVAS_LIST)
      .getByRole('button', { name: `Reorder ${worktree3.name}` })
    await expect(grip).toBeVisible()
    await drag(mockPage, grip, canvasHeader(mockPage, groupA.id))
    await expect
      .poll(() => canvasOrder(mockPage))
      .toEqual([
        `group:${groupA.id}`,
        worktree1.id,
        worktree3.id,
        `group:${groupB.id}`,
        worktree2.id,
        'group:ungrouped',
      ])

    // 2. Beta header above the Alpha header
    await drag(
      mockPage,
      canvasHeader(mockPage, groupB.id),
      canvasHeader(mockPage, groupA.id),
      0.2
    )
    await expect
      .poll(() => canvasOrder(mockPage))
      .toEqual([
        `group:${groupB.id}`,
        worktree2.id,
        `group:${groupA.id}`,
        worktree1.id,
        worktree3.id,
        'group:ungrouped',
      ])
  })
})
