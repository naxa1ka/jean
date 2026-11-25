import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, Lock, Minus, ShieldCheck } from '@/components/icons/reicon'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  secretAnswerMessage,
  secretRetentionText,
  type SavedSecret,
  type SecretRequest,
  type SecretRetention,
} from './secret-request'

const RETENTION_OPTIONS: { value: SecretRetention; label: string }[] = [
  { value: 'forever', label: 'Until I delete it' },
  { value: 'day', label: '24 hours' },
]

const TOGGLE_ITEM_CLASS =
  'flex-none rounded-sm px-2.5 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm'

export interface SecretRequestItem {
  toolCallId: string
  request: SecretRequest
}

/**
 * Card for the Jean MCP `request_secret` calls of one assistant message. It
 * has one field for each secret, so the user fills all of them and Jean sends
 * ONE chat message (a message per secret would start a new agent turn and
 * close the other fields). A blank field counts as declined. The value goes
 * only to `save_secret_request`, which writes an owner-only file; the chat
 * gets the file paths as the next user message. The value stays in local
 * state only. Each file belongs to its tool call, so the card can show it and
 * delete it.
 */
export function SecretRequestCard({
  sessionId,
  requests,
  answered,
  disabled,
  onSend,
}: {
  sessionId: string
  requests: SecretRequestItem[]
  /** A user message already follows the requests */
  answered: boolean
  disabled: boolean
  onSend: ((text: string) => void) | undefined
}) {
  const baseId = useId()
  const queryClient = useQueryClient()
  const keyOf = (toolCallId: string) => [
    'secret-request',
    sessionId,
    toolCallId,
  ]
  const statuses = useQueries({
    queries: requests.map(({ toolCallId }) => ({
      queryKey: keyOf(toolCallId),
      queryFn: () =>
        invoke<SavedSecret | null>('secret_request_status', {
          sessionId,
          toolCallId,
        }),
    })),
  })
  const [values, setValues] = useState<Record<string, string>>({})
  const [retention, setRetention] = useState<SecretRetention>('forever')
  const [submitting, setSubmitting] = useState(false)
  const [declined, setDeclined] = useState(false)
  // Enter and click can both submit before a render
  const inFlight = useRef(false)

  const savedOf = (index: number) => statuses[index]?.data ?? null
  const pending = requests.filter((_, index) => !savedOf(index))
  const showForm = pending.length > 0 && !answered && !declined
  const blocked = disabled || submitting || !onSend
  const hasValue = pending.some(item => values[item.toolCallId]?.trim())

  const forget = async ({ toolCallId, request }: SecretRequestItem) => {
    const queryKey = keyOf(toolCallId)
    try {
      await invoke('forget_secret_request', { sessionId, toolCallId })
      await queryClient.cancelQueries({ queryKey })
      queryClient.setQueryData(queryKey, null)
      toast.success(`Deleted "${request.label}"`)
    } catch (error) {
      toast.error(`Could not delete the secret: ${String(error)}`)
    }
  }

  /** One message: the saved secrets, then the ones the user left out */
  const send = () => {
    const saved: { label: string; saved: SavedSecret }[] = []
    const left: string[] = []
    for (const { toolCallId, request } of requests) {
      const secret = queryClient.getQueryData<SavedSecret | null>(
        keyOf(toolCallId)
      )
      if (secret) saved.push({ label: request.label, saved: secret })
      else left.push(request.label)
    }
    onSend?.(secretAnswerMessage(saved, left))
    setDeclined(true)
  }

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (blocked || inFlight.current || !hasValue) return
    inFlight.current = true
    setSubmitting(true)
    try {
      for (const { toolCallId, request } of pending) {
        const secret = values[toolCallId] ?? ''
        if (!secret.trim()) continue
        const result = await invoke<SavedSecret>('save_secret_request', {
          sessionId,
          toolCallId,
          label: request.label,
          secret,
          retention,
        })
        setValues(current => ({ ...current, [toolCallId]: '' }))
        // A status fetch started before the save would overwrite the result
        await queryClient.cancelQueries({ queryKey: keyOf(toolCallId) })
        queryClient.setQueryData(keyOf(toolCallId), result)
      }
      send()
    } catch (error) {
      // Secrets saved before the error stay saved; a retry saves the rest
      toast.error(`Could not save the secret: ${String(error)}`)
    } finally {
      inFlight.current = false
      setSubmitting(false)
    }
  }

  const decline = () => {
    if (blocked) return
    setValues({})
    send()
  }

  const rows = requests.flatMap((item, index) => {
    const saved = savedOf(index)
    if (saved) {
      return [
        <div
          key={item.toolCallId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <CheckIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {item.request.label} · saved, {secretRetentionText(saved.retention)}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => void forget(item)}
          >
            Delete
          </Button>
        </div>,
      ]
    }
    if (showForm) return []
    const Icon = declined ? Minus : Lock
    return [
      <div
        key={item.toolCallId}
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          {item.request.label} · {declined ? 'declined' : 'not saved'}
        </span>
      </div>,
    ]
  })

  const fieldProps = (item: SecretRequestItem) => ({
    autoComplete: 'off',
    autoCorrect: 'off',
    autoCapitalize: 'off',
    spellCheck: false,
    'data-1p-ignore': true,
    'data-lpignore': 'true',
    'data-bwignore': true,
    placeholder:
      item.request.placeholder ??
      (item.request.multiline ? 'Paste the contents' : 'Paste the secret'),
    value: values[item.toolCallId] ?? '',
    disabled: blocked,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.currentTarget.value
      setValues(current => ({ ...current, [item.toolCallId]: value }))
    },
  })

  return (
    <>
      {rows}
      {showForm && (
        <form
          className="my-2 flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
          onSubmit={save}
          autoComplete="off"
        >
          {pending.map(item => {
            const { request } = item
            const inputId = `${baseId}-${item.toolCallId}`
            return (
              <div
                key={item.toolCallId}
                className="flex min-w-0 flex-col gap-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={inputId} className="text-sm font-medium">
                    {request.label}
                  </label>
                  {request.reason && (
                    <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
                      {request.reason}
                    </p>
                  )}
                </div>
                {request.example && (
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">
                      Example
                    </span>
                    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
                      {request.example}
                    </pre>
                  </div>
                )}
                {request.multiline ? (
                  <Textarea
                    id={inputId}
                    className="max-h-64 min-h-28 w-full font-mono text-xs [-webkit-text-security:disc]"
                    {...fieldProps(item)}
                  />
                ) : (
                  <Input
                    id={inputId}
                    // A password field makes browsers offer to save a login
                    type="text"
                    className="min-w-0 [-webkit-text-security:disc]"
                    {...fieldProps(item)}
                  />
                )}
              </div>
            )
          })}
          {pending.length > 1 && (
            <p className="text-xs text-muted-foreground">
              A field you leave blank counts as declined.
            </p>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>Keep</span>
            <ToggleGroup
              type="single"
              value={retention}
              onValueChange={value => {
                if (value) setRetention(value as SecretRetention)
              }}
              aria-label="Keep the secret"
              size="sm"
              disabled={blocked}
              className="gap-0.5 rounded-md bg-muted p-0.5"
            >
              {RETENTION_OPTIONS.map(option => (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  className={TOGGLE_ITEM_CLASS}
                >
                  {option.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
              Kept out of chat, in a private file this agent&apos;s commands can
              read. Delete it anytime, just ask in any chat.
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={blocked}
                onClick={decline}
              >
                Decline
              </Button>
              <Button type="submit" disabled={blocked || !hasValue}>
                Save securely
              </Button>
            </div>
          </div>
        </form>
      )}
    </>
  )
}
