import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Check, Trash2 } from '@/components/icons/reicon'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import {
  DEFAULT_MARK_COLOR,
  LABEL_COLORS,
  getLabelTextColor,
} from '@/lib/label-colors'
import {
  MARK_EVERYWHERE_LEVEL,
  MARK_LIST_LEVEL,
  useMarkDefinitions,
} from '@/lib/marks'
import { useServerMarksLevel } from '@/lib/marks-level'
import { useSettingsTargetServerId } from '@/lib/settings-target'
import {
  countMarkUsage,
  type MarkUsage,
  removeMarkEverywhere,
  renameMark,
  setMarkDefinitions,
} from '@/services/marks'
import type { MarkDefinition } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

/** Settings → Marks: the mark list of the server that Settings targets. */
export function MarksPane() {
  const serverId = useSettingsTargetServerId()
  const marksLevel = useServerMarksLevel(serverId)
  const definitions = useMarkDefinitions(serverId)
  const everywhere = marksLevel >= MARK_EVERYWHERE_LEVEL
  const [removing, setRemoving] = useState<MarkDefinition | null>(null)

  /** Save the whole list. Returns false when the server rejects it. */
  const save = useCallback(
    async (next: MarkDefinition[]) => {
      try {
        await setMarkDefinitions(serverId, next)
        return true
      } catch (error) {
        toast.error(`Failed to save marks: ${error}`)
        return false
      }
    },
    [serverId]
  )

  if (marksLevel < MARK_LIST_LEVEL) {
    return (
      <SettingsSection title="Marks">
        <p className="text-sm text-muted-foreground">
          This server does not support marks yet.
        </p>
      </SettingsSection>
    )
  }

  const update = async (index: number, patch: Partial<MarkDefinition>) => {
    const current = definitions[index]
    if (everywhere && current && patch.name !== undefined) {
      try {
        const usage = await renameMark(serverId, current.name, patch.name)
        toast.success(`Renamed in ${itemCount(usage)}`)
        return true
      } catch (error) {
        toast.error(`Failed to rename mark: ${error}`)
        return false
      }
    }
    return save(
      definitions.map((definition, i) =>
        i === index ? { ...definition, ...patch } : definition
      )
    )
  }

  const removeFromList = (name: string) =>
    save(definitions.filter(definition => definition.name !== name))

  const move = (index: number, offset: -1 | 1) => {
    const next = [...definitions]
    const [item] = next.splice(index, 1)
    if (!item) return
    next.splice(index + offset, 0, item)
    void save(next)
  }

  return (
    <SettingsSection
      title="Marks"
      description="One mark list for all projects of this server. Sessions and worktrees use these marks. The list order is the display order."
    >
      {!everywhere && (
        <p className="text-xs text-muted-foreground">
          Renaming does not update marked items yet. Removing a mark from the
          list keeps it on marked items, under &ldquo;Not in list&rdquo;.
        </p>
      )}
      <ul className="flex flex-col gap-2" aria-label="Mark list">
        {definitions.map((definition, index) => (
          <MarkRow
            key={definition.name.toLowerCase()}
            definition={definition}
            isFirst={index === 0}
            isLast={index === definitions.length - 1}
            onChange={patch => update(index, patch)}
            onMove={offset => move(index, offset)}
            onRemove={() =>
              everywhere
                ? setRemoving(definition)
                : void removeFromList(definition.name)
            }
          />
        ))}
      </ul>
      <AddMarkRow
        onAdd={name =>
          save([
            ...definitions,
            { name, color: DEFAULT_MARK_COLOR, icon: null, tracked: false },
          ])
        }
      />
      {removing && (
        <RemoveMarkDialog
          serverId={serverId}
          definition={removing}
          onClose={() => setRemoving(null)}
          onRemoveFromList={() => removeFromList(removing.name)}
        />
      )}
    </SettingsSection>
  )
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function itemCount(usage: MarkUsage) {
  return plural(usage.worktrees + usage.sessions, 'item')
}

/** Confirm a remove: show how many items use the mark, and offer to remove it from them. */
function RemoveMarkDialog({
  serverId,
  definition,
  onClose,
  onRemoveFromList,
}: {
  serverId: string | undefined
  definition: MarkDefinition
  onClose: () => void
  onRemoveFromList: () => Promise<boolean>
}) {
  const [usage, setUsage] = useState<MarkUsage | null>(null)
  const [alsoFromItems, setAlsoFromItems] = useState(true)

  useEffect(() => {
    let cancelled = false
    countMarkUsage(serverId, definition.name)
      .then(result => {
        if (!cancelled) setUsage(result)
      })
      .catch(error => {
        if (!cancelled) toast.error(`Failed to count mark usage: ${error}`)
      })
    return () => {
      cancelled = true
    }
  }, [serverId, definition.name])

  const confirm = async () => {
    onClose()
    if (!alsoFromItems) {
      await onRemoveFromList()
      return
    }
    try {
      const removed = await removeMarkEverywhere(serverId, definition.name)
      toast.success(`Removed from ${itemCount(removed)}`)
    } catch (error) {
      toast.error(`Failed to remove mark: ${error}`)
    }
  }

  return (
    <AlertDialog open onOpenChange={open => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Remove &ldquo;{definition.name}&rdquo; from the list?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {usage
              ? `Used by ${plural(usage.worktrees, 'worktree')} and ${plural(usage.sessions, 'session')}.`
              : 'Counting marked items…'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={alsoFromItems}
            onCheckedChange={checked => setAlsoFromItems(checked === true)}
          />
          Also remove from these items
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void confirm()}
          >
            Remove
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function MarkRow({
  definition,
  isFirst,
  isLast,
  onChange,
  onMove,
  onRemove,
}: {
  definition: MarkDefinition
  isFirst: boolean
  isLast: boolean
  onChange: (patch: Partial<MarkDefinition>) => Promise<boolean>
  onMove: (offset: -1 | 1) => void
  onRemove: () => void
}) {
  const [name, setName] = useState(definition.name)
  const [icon, setIcon] = useState(definition.icon ?? '')

  const saveName = async () => {
    const trimmed = name.trim()
    if (!trimmed || trimmed === definition.name) {
      setName(definition.name)
      return
    }
    if (!(await onChange({ name: trimmed }))) setName(definition.name)
  }

  const saveIcon = async () => {
    const trimmed = icon.trim()
    if (trimmed === (definition.icon ?? '')) {
      setIcon(trimmed)
      return
    }
    if (!(await onChange({ icon: trimmed || null }))) {
      setIcon(definition.icon ?? '')
    }
  }

  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded-md border px-2 py-1.5"
      aria-label={definition.name}
    >
      <div className="flex">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Move ${definition.name} up`}
          disabled={isFirst}
          onClick={() => onMove(-1)}
        >
          <ArrowUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Move ${definition.name} down`}
          disabled={isLast}
          onClick={() => onMove(1)}
        >
          <ArrowDown />
        </Button>
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="size-5 shrink-0 rounded-full ring-1 ring-border"
            style={{ backgroundColor: definition.color }}
            aria-label={`Color of ${definition.name}`}
          />
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <div className="grid grid-cols-5 gap-1.5">
            {LABEL_COLORS.map(color => (
              <button
                key={color.value}
                type="button"
                className="flex size-7 items-center justify-center rounded-md"
                style={{ backgroundColor: color.value }}
                aria-label={color.name}
                aria-pressed={definition.color === color.value}
                onClick={() => void onChange({ color: color.value })}
              >
                {definition.color === color.value && (
                  <Check
                    className="size-3.5"
                    style={{ color: getLabelTextColor(color.value) }}
                  />
                )}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Input
        value={icon}
        onChange={e => setIcon(e.target.value)}
        onBlur={() => void saveIcon()}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        placeholder="🙂"
        aria-label={`Icon of ${definition.name}`}
        className="h-8 w-12 text-center"
      />
      <Input
        value={name}
        onChange={e => setName(e.target.value)}
        onBlur={() => void saveName()}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
        aria-label={`Name of ${definition.name}`}
        className="h-8 min-w-32 flex-1"
      />
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <Switch
          checked={definition.tracked}
          onCheckedChange={tracked => void onChange({ tracked })}
          aria-label={`Track ${definition.name} in bell`}
        />
        Track in bell
      </label>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive"
        onClick={onRemove}
      >
        <Trash2 />
        Remove from list
      </Button>
    </li>
  )
}

function AddMarkRow({ onAdd }: { onAdd: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState('')

  const add = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    if (await onAdd(trimmed)) setName('')
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void add()
          }
        }}
        placeholder="New mark name"
        aria-label="New mark name"
        className="h-8 min-w-32 flex-1"
      />
      <Button size="sm" disabled={!name.trim()} onClick={() => void add()}>
        Add mark
      </Button>
    </div>
  )
}
