import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, Check, Trash2 } from '@/components/icons/reicon'
import { Button } from '@/components/ui/button'
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
import { MARK_LIST_LEVEL, useMarkDefinitions } from '@/lib/marks'
import { useServerMarksLevel } from '@/lib/marks-level'
import { useSettingsTargetServerId } from '@/lib/settings-target'
import { setMarkDefinitions } from '@/services/marks'
import type { MarkDefinition } from '@/types/preferences'
import { SettingsSection } from '../SettingsSection'

/** Settings → Marks: the mark list of the server that Settings targets. */
export function MarksPane() {
  const serverId = useSettingsTargetServerId()
  const marksLevel = useServerMarksLevel(serverId)
  const definitions = useMarkDefinitions(serverId)

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

  const update = (index: number, patch: Partial<MarkDefinition>) =>
    save(
      definitions.map((definition, i) =>
        i === index ? { ...definition, ...patch } : definition
      )
    )

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
      <p className="text-xs text-muted-foreground">
        Renaming does not update marked items yet. Removing a mark from the list
        keeps it on marked items, under &ldquo;Not in list&rdquo;.
      </p>
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
              void save(definitions.filter((_, i) => i !== index))
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
    </SettingsSection>
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
