import { useState, useCallback, useMemo } from 'react'
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
import { Tag, Check, Pencil, Pin, Trash2 } from '@/components/icons/reicon'
import { useChatStore } from '@/store/chat-store'
import type { LabelData } from '@/types/chat'
import { getLabelTextColor } from '@/lib/label-colors'
import { getResourceServerId, useServerMarksLevel } from '@/lib/marks-level'

const PRESET_LABELS = ['Needs testing']

const LABEL_COLORS = [
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Purple', value: '#a855f7' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Gray', value: '#6b7280' },
  { name: 'Cyan', value: '#06b6d4' },
  { name: 'Lime', value: '#84cc16' },
]

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
  /** Custom apply handler. Default (sessions): `setSessionLabels` in the chat store. */
  onApplyLabels?: (labels: LabelData[]) => void
  /** Additional labels to include in the custom labels list (e.g. worktree labels) */
  extraLabels?: LabelData[]
  /** Callback when a label's color is edited (e.g. to propagate to worktree labels) */
  onColorChange?: (labelName: string, newColor: string) => void
  /** Callback when a label is pinned/unpinned as a project filter tab. */
  onPinnedChange?: (label: LabelData, pinned: boolean) => void
  /** Callback when a custom label should be deleted from the project. */
  onDeleteLabel?: (label: LabelData) => void
}

export function LabelModal({
  isOpen,
  onClose,
  sessionId,
  currentLabels,
  target = 'session',
  onApplyLabels,
  extraLabels,
  onColorChange,
  onPinnedChange,
  onDeleteLabel,
}: LabelModalProps) {
  const [inputValue, setInputValue] = useState('')
  const [selectedColor, setSelectedColor] = useState(
    LABEL_COLORS[2]?.value ?? '#eab308'
  )
  const [isCreatingCustom, setIsCreatingCustom] = useState(false)
  const [editingLabelName, setEditingLabelName] = useState<string | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [colorOverrides, setColorOverrides] = useState<Record<string, string>>(
    {}
  )

  const sessionLabels = useChatStore(state => state.sessionLabels)
  const sessionWorktreeId = useChatStore(state =>
    target === 'session' && sessionId
      ? state.sessionWorktreeMap[sessionId]
      : undefined
  )
  const sessionMarksLevel = useServerMarksLevel(
    sessionWorktreeId ? getResourceServerId(sessionWorktreeId) : undefined
  )
  const mode: 'single' | 'multi' =
    target === 'worktree' || sessionMarksLevel >= 1 ? 'multi' : 'single'

  // Every mark in use on any session (flattened from the per-session lists)
  const labelsInUse = useMemo(
    () => Object.values(sessionLabels).flat(),
    [sessionLabels]
  )

  // Extract unique label names (from LabelData + extraLabels) for the dropdown list
  const customLabels = useMemo(() => {
    const presetSet = new Set(PRESET_LABELS)
    const unique = new Set<string>()
    for (const label of labelsInUse) {
      if (!presetSet.has(label.name)) unique.add(label.name)
    }
    if (extraLabels) {
      for (const label of extraLabels) {
        if (!presetSet.has(label.name)) unique.add(label.name)
      }
    }
    return [...unique].sort()
  }, [labelsInUse, extraLabels])

  const allLabelNames = useMemo(
    () => [...PRESET_LABELS, ...customLabels],
    [customLabels]
  )

  // Get the label data for current label (for preset labels, use default yellow)
  const getLabelData = useCallback(
    (name: string): LabelData => {
      const selected = currentLabels.find(l => l.name === name)
      // Check local color overrides first (instant feedback before async refetch)
      if (colorOverrides[name]) {
        return { ...(selected ?? { name }), color: colorOverrides[name] }
      }
      const extra = extraLabels?.find(l => l.name === name)
      if (selected) {
        return extra?.pinned ? { ...selected, pinned: true } : selected
      }
      // Check if this label name exists in sessionLabels or extraLabels (has a color)
      const existing = labelsInUse.find(l => l.name === name)
      if (existing) {
        return extra?.pinned ? { ...existing, pinned: true } : existing
      }
      if (extra) return extra
      // Preset labels get yellow by default
      return { name, color: '#eab308' }
    },
    [labelsInUse, colorOverrides, extraLabels, currentLabels]
  )

  // Update all sessions that use a given label name to use a new color
  const updateAllSessionsWithLabel = useCallback(
    (labelName: string, newColor: string) => {
      const { sessionLabels: allLabels, setSessionLabels } =
        useChatStore.getState()
      for (const [sid, labels] of Object.entries(allLabels)) {
        if (labels.some(label => label.name === labelName)) {
          setSessionLabels(
            sid,
            labels.map(label =>
              label.name === labelName ? { ...label, color: newColor } : label
            )
          )
        }
      }
    },
    []
  )

  // Single select (old servers) keeps only the first mark
  const selectedLabels = useMemo(
    () => (mode === 'multi' ? currentLabels : currentLabels.slice(0, 1)),
    [mode, currentLabels]
  )

  const isLabelSelected = useCallback(
    (name: string) => selectedLabels.some(label => label.name === name),
    [selectedLabels]
  )

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
              ? selectedLabels.filter(label => label.name !== labelData.name)
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

  // Start editing an existing label's color
  const startEditColor = useCallback(
    (labelData: LabelData, e: React.MouseEvent) => {
      e.stopPropagation()
      setEditingLabelName(labelData.name)
      setSelectedColor(labelData.color)
    },
    []
  )

  // Save the edited color for a label
  const saveEditedColor = useCallback(() => {
    if (!editingLabelName) return
    updateAllSessionsWithLabel(editingLabelName, selectedColor)
    onColorChange?.(editingLabelName, selectedColor)
    setColorOverrides(prev => ({ ...prev, [editingLabelName]: selectedColor }))
    setEditingLabelName(null)
  }, [
    editingLabelName,
    selectedColor,
    updateAllSessionsWithLabel,
    onColorChange,
  ])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isCreatingCustom || editingLabelName) {
        // In custom creation or color edit mode, Enter saves the color
        if (e.key === 'Enter') {
          e.preventDefault()
          if (editingLabelName) {
            saveEditedColor()
          } else {
            const trimmed = inputValue.trim()
            if (trimmed) {
              applyLabel({ name: trimmed, color: selectedColor })
            }
          }
        } else if (e.key === 'Escape') {
          e.preventDefault()
          setIsCreatingCustom(false)
          setEditingLabelName(null)
          setInputValue('')
        }
        return
      }

      // Normal navigation mode
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusedIndex(i => (i + 1) % allLabelNames.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusedIndex(
          i => (i - 1 + allLabelNames.length) % allLabelNames.length
        )
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const labelName = allLabelNames[focusedIndex]
        if (labelName) {
          const isAlreadySelected = isLabelSelected(labelName)
          applyLabel(
            isAlreadySelected
              ? getLabelData(labelName)
              : getLabelData(labelName)
          )
        }
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
      editingLabelName,
      inputValue,
      selectedColor,
      allLabelNames,
      focusedIndex,
      isLabelSelected,
      getLabelData,
      applyLabel,
      saveEditedColor,
    ]
  )

  const handleCreateCustom = useCallback(() => {
    const trimmed = inputValue.trim()
    if (trimmed) {
      applyLabel({ name: trimmed, color: selectedColor })
    }
  }, [inputValue, selectedColor, applyLabel])

  const togglePinned = useCallback(
    (labelData: LabelData, e: React.MouseEvent) => {
      e.stopPropagation()
      if (target !== 'worktree') return

      if (onPinnedChange) {
        onPinnedChange(labelData, !labelData.pinned)
        return
      }

      const next = selectedLabels.map(label =>
        label.name === labelData.name
          ? { ...label, pinned: !label.pinned }
          : label
      )
      commitLabels(next)
    },
    [target, commitLabels, onPinnedChange, selectedLabels]
  )

  const deleteLabel = useCallback(
    (labelData: LabelData, e: React.MouseEvent) => {
      e.stopPropagation()
      onDeleteLabel?.(labelData)
    },
    [onDeleteLabel]
  )

  // Are we in edit mode?
  const isEditing = isCreatingCustom || editingLabelName

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
            <Tag className="h-4 w-4" />
            {target === 'worktree'
              ? 'Worktree Labels'
              : mode === 'multi'
                ? 'Session Labels'
                : 'Session Label'}
          </DialogTitle>
          <DialogDescription>
            {editingLabelName
              ? `Choose a color for "${editingLabelName}".`
              : isCreatingCustom
                ? 'Choose a color for your label.'
                : 'Pick labels or create a custom one.'}
          </DialogDescription>
        </DialogHeader>

        {isEditing ? (
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
                {editingLabelName || inputValue.trim() || 'Label name'}
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
                onClick={() => {
                  setIsCreatingCustom(false)
                  setEditingLabelName(null)
                  setInputValue('')
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="flex-1 h-8 text-sm rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={
                  editingLabelName ? saveEditedColor : handleCreateCustom
                }
                disabled={!editingLabelName && !inputValue.trim()}
              >
                {editingLabelName ? 'Save' : 'Create'}
              </button>
            </div>
          </div>
        ) : (
          /* Label list view */
          <>
            <div className="flex flex-col gap-0.5">
              {allLabelNames.map((labelName, i) => {
                const labelData = getLabelData(labelName)
                const isSelected = isLabelSelected(labelName)
                const isCustom = !PRESET_LABELS.includes(labelName)
                return (
                  <button
                    type="button"
                    key={labelName}
                    className={`flex items-center h-8 px-3 text-sm rounded-md text-left transition-colors group ${
                      focusedIndex === i
                        ? 'bg-accent text-accent-foreground'
                        : isSelected
                          ? 'bg-primary/10 text-primary'
                          : 'hover:bg-accent/50'
                    }`}
                    onClick={() =>
                      applyLabel(
                        isSelected && mode === 'single' ? null : labelData
                      )
                    }
                    onMouseEnter={() => setFocusedIndex(i)}
                    tabIndex={-1}
                  >
                    <span
                      className="w-3 h-3 rounded-full mr-2 flex-shrink-0"
                      style={{ backgroundColor: labelData.color }}
                    />
                    <span className="flex-1 truncate">{labelName}</span>
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
                    {isCustom && (
                      <>
                        {onDeleteLabel && (
                          <Trash2
                            className="h-3 w-3 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity mr-1 text-destructive"
                            onClick={e => deleteLabel(labelData, e)}
                          />
                        )}
                        <Pencil
                          className="h-3 w-3 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity mr-1"
                          onClick={e => startEditColor(labelData, e)}
                        />
                      </>
                    )}
                  </button>
                )
              })}
            </div>

            <div className="border-t pt-2">
              <Input
                placeholder="Custom label..."
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
          {isEditing ? (
            <>
              <span>
                <kbd className="px-1 rounded border bg-muted">↵</kbd>{' '}
                {editingLabelName
                  ? 'save'
                  : mode === 'multi'
                    ? 'add'
                    : 'create'}
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
