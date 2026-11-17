import { Fragment, useState, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Bookmark, Check, Pencil, Pin } from '@/components/icons/reicon'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { LabelData } from '@/types/chat'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import {
  DEFAULT_MARK_COLOR,
  LABEL_COLORS,
  getLabelTextColor,
} from '@/lib/label-colors'
import { getResourceServerId, useServerMarksLevel } from '@/lib/marks-level'
import {
  MARK_LIST_LEVEL,
  findDefinition,
  useMarkDefinitions,
} from '@/lib/marks'
import { mergeMarkDefinitions } from '@/services/marks'

/** Built-in mark of servers without a mark list (marks level < 2). */
const LEGACY_PRESET_LABEL = 'Needs testing'

interface PickerRow {
  label: LabelData
  icon: string | null
  /** Applied, but the server mark list has no definition with this name. */
  orphan: boolean
}

interface LabelModalProps {
  isOpen: boolean
  onClose: () => void
  sessionId: string | null
  /** Current marks of the target, in display order. */
  currentLabels: LabelData[]
  /**
   * What the picker marks. Worktrees always multi-select and show the pin toggle.
   * Sessions multi-select when their server supports `marks >= 1`, else single select.
   */
  target?: 'session' | 'worktree'
  /**
   * Server that owns the target. Sessions use the server of their worktree when
   * this is not set. The picker shows the mark list of this server.
   */
  serverId?: string
  /** Custom apply handler. Default (sessions): `setSessionLabels` in the chat store. */
  onApplyLabels?: (labels: LabelData[]) => void
  /**
   * More labels for the list. Servers with a mark list use them only for the
   * pinned state; older servers also list them.
   */
  extraLabels?: LabelData[]
  /** Callback when a label is pinned/unpinned as a project filter tab. */
  onPinnedChange?: (label: LabelData, pinned: boolean) => void
}

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function LabelModal({
  isOpen,
  onClose,
  sessionId,
  currentLabels,
  target = 'session',
  serverId,
  onApplyLabels,
  extraLabels,
  onPinnedChange,
}: LabelModalProps) {
  const [inputValue, setInputValue] = useState('')
  const [selectedColor, setSelectedColor] = useState<string>(DEFAULT_MARK_COLOR)
  const [isCreatingCustom, setIsCreatingCustom] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)

  const sessionLabels = useChatStore(state => state.sessionLabels)
  const sessionWorktreeId = useChatStore(state =>
    target === 'session' && sessionId
      ? state.sessionWorktreeMap[sessionId]
      : undefined
  )
  const ownerServerId =
    serverId ??
    (sessionWorktreeId ? getResourceServerId(sessionWorktreeId) : undefined)
  const marksLevel = useServerMarksLevel(ownerServerId)
  const definitions = useMarkDefinitions(ownerServerId)
  const hasMarkList = marksLevel >= MARK_LIST_LEVEL
  const mode: 'single' | 'multi' =
    target === 'worktree' || marksLevel >= 1 ? 'multi' : 'single'

  // Single select (old servers) keeps only the first mark
  const selectedLabels = useMemo(
    () => (mode === 'multi' ? currentLabels : currentLabels.slice(0, 1)),
    [mode, currentLabels]
  )

  const isLabelSelected = useCallback(
    (name: string) => selectedLabels.some(label => sameName(label.name, name)),
    [selectedLabels]
  )

  const isPinned = useCallback(
    (name: string) =>
      !!(
        selectedLabels.find(label => sameName(label.name, name))?.pinned ||
        extraLabels?.find(label => sameName(label.name, name))?.pinned
      ),
    [selectedLabels, extraLabels]
  )

  // Older servers: labels in use plus the built-in preset (no managed list)
  const legacyRows = useMemo((): PickerRow[] => {
    if (hasMarkList) return []
    const labelsInUse = Object.values(sessionLabels).flat()
    const names = new Set<string>()
    for (const label of [...labelsInUse, ...(extraLabels ?? [])]) {
      if (label.name !== LEGACY_PRESET_LABEL) names.add(label.name)
    }
    return [LEGACY_PRESET_LABEL, ...[...names].sort()].map(name => {
      const label = selectedLabels.find(l => l.name === name) ??
        labelsInUse.find(l => l.name === name) ??
        extraLabels?.find(l => l.name === name) ?? {
          name,
          color: DEFAULT_MARK_COLOR,
        }
      return {
        label: isPinned(name) ? { ...label, pinned: true } : label,
        icon: null,
        orphan: false,
      }
    })
  }, [hasMarkList, sessionLabels, extraLabels, selectedLabels, isPinned])

  const rows = useMemo((): PickerRow[] => {
    if (!hasMarkList) return legacyRows
    const listRows = definitions.map(definition => ({
      label: {
        name: definition.name,
        color: definition.color,
        ...(isPinned(definition.name) ? { pinned: true } : {}),
      },
      icon: definition.icon,
      orphan: false,
    }))
    const orphanRows = selectedLabels
      .filter(label => !findDefinition(label.name, definitions))
      .map(label => ({ label, icon: null, orphan: true }))
    return [...listRows, ...orphanRows]
  }, [hasMarkList, legacyRows, definitions, selectedLabels, isPinned])

  const commitLabels = useCallback(
    (labels: LabelData[]) => {
      if (onApplyLabels) {
        onApplyLabels(labels)
      } else if (sessionId) {
        useChatStore.getState().setSessionLabels(sessionId, labels)
      }
    },
    [onApplyLabels, sessionId]
  )

  /** Toggle one mark (multi), set it (single), or clear all marks (`null`). */
  const applyLabel = useCallback(
    (labelData: LabelData | null) => {
      if (mode === 'multi') {
        commitLabels(
          labelData
            ? isLabelSelected(labelData.name)
              ? selectedLabels.filter(
                  label => !sameName(label.name, labelData.name)
                )
              : [...selectedLabels, labelData]
            : []
        )
        return
      }
      commitLabels(labelData ? [labelData] : [])
      onClose()
    },
    [mode, selectedLabels, isLabelSelected, commitLabels, onClose]
  )

  const leaveCreate = useCallback(() => {
    setIsCreatingCustom(false)
    setInputValue('')
  }, [])

  /** "New mark…": add it to the server list (when the server has one), then apply it. */
  const handleCreateCustom = useCallback(async () => {
    const trimmed = inputValue.trim()
    if (!trimmed) return
    let label: LabelData = { name: trimmed, color: selectedColor }
    if (hasMarkList) {
      const existing = findDefinition(trimmed, definitions)
      if (existing) {
        label = { name: existing.name, color: existing.color }
      } else {
        try {
          await mergeMarkDefinitions(ownerServerId, [
            { name: trimmed, color: selectedColor, icon: null, tracked: false },
          ])
        } catch (error) {
          toast.error(`Failed to add mark: ${error}`)
          return
        }
      }
    }
    leaveCreate()
    if (isLabelSelected(label.name)) return
    applyLabel(label)
  }, [
    inputValue,
    selectedColor,
    hasMarkList,
    definitions,
    ownerServerId,
    leaveCreate,
    isLabelSelected,
    applyLabel,
  ])

  const addOrphanToList = useCallback(
    async (label: LabelData, e: React.MouseEvent) => {
      e.stopPropagation()
      try {
        await mergeMarkDefinitions(ownerServerId, [
          { name: label.name, color: label.color, icon: null, tracked: false },
        ])
      } catch (error) {
        toast.error(`Failed to add mark to the list: ${error}`)
      }
    },
    [ownerServerId]
  )

  /** The list is managed in Settings → Marks of the item's own server. */
  const openMarkSettings = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      onClose()
      useUIStore
        .getState()
        .openPreferencesPane('marks', ownerServerId ?? LOCAL_SERVER_ID)
    },
    [onClose, ownerServerId]
  )

  const togglePinned = useCallback(
    (labelData: LabelData, e: React.MouseEvent) => {
      e.stopPropagation()
      if (target !== 'worktree') return

      if (onPinnedChange) {
        onPinnedChange(labelData, !labelData.pinned)
        return
      }

      const next = selectedLabels.map(label =>
        sameName(label.name, labelData.name)
          ? { ...label, pinned: !label.pinned }
          : label
      )
      commitLabels(next)
    },
    [target, commitLabels, onPinnedChange, selectedLabels]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isCreatingCustom) {
        if (e.key === 'Enter') {
          e.preventDefault()
          void handleCreateCustom()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          leaveCreate()
        }
        return
      }

      if (rows.length > 0 && e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex(i => (i + 1) % rows.length)
      } else if (rows.length > 0 && e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex(i => (i - 1 + rows.length) % rows.length)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const row = rows[focusedIndex]
        if (row) applyLabel(row.label)
      } else if (e.key === 'Backspace') {
        const isInputFocused = (e.target as HTMLElement)?.tagName === 'INPUT'
        if (!isInputFocused) {
          e.preventDefault()
          applyLabel(null)
        }
      }
    },
    [
      isCreatingCustom,
      rows,
      focusedIndex,
      applyLabel,
      handleCreateCustom,
      leaveCreate,
    ]
  )

  const renderRow = (row: PickerRow, i: number) => {
    const { label: labelData } = row
    const isSelected = isLabelSelected(labelData.name)
    return (
      <button
        type="button"
        className={`flex items-center h-8 px-3 text-sm rounded-md text-left transition-colors group ${
          focusedIndex === i
            ? 'bg-accent text-accent-foreground'
            : isSelected
              ? 'bg-primary/10 text-primary'
              : 'hover:bg-accent/50'
        }`}
        onClick={() =>
          applyLabel(isSelected && mode === 'single' ? null : labelData)
        }
        onMouseEnter={() => setFocusedIndex(i)}
        tabIndex={-1}
      >
        {row.icon ? (
          <span className="w-4 mr-1.5 flex-shrink-0 text-center leading-none">
            {row.icon}
          </span>
        ) : (
          <span
            className="w-3 h-3 rounded-full mr-2 flex-shrink-0"
            style={{ backgroundColor: labelData.color }}
          />
        )}
        <span className="flex-1 truncate">{labelData.name}</span>
        {row.orphan && (
          <span
            role="button"
            aria-label={`Add ${labelData.name} to list`}
            className="mr-1 text-2xs text-muted-foreground hover:text-foreground"
            onClick={e => void addOrphanToList(labelData, e)}
          >
            Add to list
          </span>
        )}
        {target === 'worktree' && (
          <Pin
            className={`h-3 w-3 transition-opacity mr-1 ${
              labelData.pinned
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-50 hover:!opacity-100'
            }`}
            onClick={e => togglePinned(labelData, e)}
          />
        )}
        {isSelected && <Check className="h-3 w-3 mr-1" />}
        {hasMarkList && !row.orphan && (
          <Pencil
            role="button"
            aria-label={`Edit ${labelData.name} in Settings`}
            className="h-3 w-3 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity mr-1"
            onClick={openMarkSettings}
          />
        )}
      </button>
    )
  }

  const firstOrphanIndex = rows.findIndex(row => row.orphan)

  return (
    <Dialog open={isOpen} onOpenChange={open => !open && onClose()}>
      <DialogContent
        className="sm:max-w-[360px]"
        onKeyDown={e => {
          e.stopPropagation()
          handleKeyDown(e)
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bookmark className="h-4 w-4" />
            {target === 'worktree' ? 'Worktree marks' : 'Session marks'}
          </DialogTitle>
          <DialogDescription>
            {isCreatingCustom
              ? 'Choose a color for your mark.'
              : 'Pick marks or create a new one.'}
          </DialogDescription>
        </DialogHeader>

        {isCreatingCustom ? (
          /* Color picker view */
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3">
              <span
                className="flex items-center justify-center w-16 h-10 rounded-md font-medium text-sm"
                style={{
                  backgroundColor: selectedColor,
                  color: getLabelTextColor(selectedColor),
                }}
              >
                Preview
              </span>
              <span className="text-sm text-muted-foreground">
                {inputValue.trim() || 'Mark name'}
              </span>
            </div>

            <div className="grid grid-cols-5 gap-2">
              {LABEL_COLORS.map(color => (
                <Tooltip key={color.value}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={`w-full h-8 rounded-md transition-transform hover:scale-105 ${
                        selectedColor === color.value
                          ? 'ring-2 ring-offset-2 ring-primary'
                          : ''
                      }`}
                      style={{ backgroundColor: color.value }}
                      onClick={() => setSelectedColor(color.value)}
                      aria-label={color.name}
                    >
                      {selectedColor === color.value && (
                        <Check
                          className={`h-4 w-4 mx-auto ${getLabelTextColor(color.value)}`}
                        />
                      )}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{color.name}</TooltipContent>
                </Tooltip>
              ))}
            </div>

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                className="flex-1 h-8 text-sm rounded-md border hover:bg-accent"
                onClick={leaveCreate}
              >
                Back
              </button>
              <button
                type="button"
                className="flex-1 h-8 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => void handleCreateCustom()}
                disabled={!inputValue.trim()}
              >
                Create
              </button>
            </div>
          </div>
        ) : (
          /* Mark list view */
          <>
            <div className="flex flex-col gap-0.5">
              {rows.map((row, i) => (
                <Fragment
                  key={`${row.orphan ? 'orphan' : 'mark'}:${row.label.name}`}
                >
                  {i === firstOrphanIndex && (
                    <div className="px-3 pt-2 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                      Not in list
                    </div>
                  )}
                  {renderRow(row, i)}
                </Fragment>
              ))}
            </div>

            <div className="border-t pt-2">
              <Input
                placeholder="New mark…"
                value={inputValue}
                onChange={e => setInputValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    const trimmed = inputValue.trim()
                    if (trimmed) {
                      setIsCreatingCustom(true)
                    }
                  }
                }}
                tabIndex={-1}
              />
            </div>
          </>
        )}

        <div className="flex gap-3 text-2xs text-muted-foreground px-1">
          {isCreatingCustom ? (
            <>
              <span>
                <kbd className="px-1 rounded border bg-muted">↵</kbd>{' '}
                {mode === 'multi' ? 'add' : 'create'}
              </span>
              <span>
                <kbd className="px-1 rounded border bg-muted">esc</kbd> back
              </span>
            </>
          ) : (
            <>
              <span>
                <kbd className="px-1 rounded border bg-muted">↵</kbd> apply
              </span>
              <span>
                <kbd className="px-1 rounded border bg-muted">⌫</kbd> clear
              </span>
              <span>
                <kbd className="px-1 rounded border bg-muted">↑↓</kbd> navigate
              </span>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
