import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  Circle,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
  Undo2,
  Upload,
  X,
} from '@/components/icons/reicon'
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { openSessionInWorktree } from '@/components/chat/open-session'
import { cn } from '@/lib/utils'
import {
  useAddPlan,
  usePlanQueue,
  usePlanQueueAction,
  useReorderPlans,
} from '@/services/plan-queue'
import { useUIStore, type PlanQueueTarget } from '@/store/ui-store'
import type { PlanQueueAction, QueuePlan } from '@/types/plan-queue'
import { formatElapsed, isMarkdownFile, movePlan } from './plan-queue-utils'

type Confirm = { kind: 'remove'; name: string } | { kind: 'clear' } | null

/** Mounted once in MainWindow. Opens when `planQueueTarget` is set. */
export function PlanQueueDialog() {
  const target = useUIStore(state => state.planQueueTarget)
  const close = useCallback((open: boolean) => {
    if (!open) useUIStore.getState().setPlanQueueTarget(null)
  }, [])

  return (
    <Dialog open={target !== null} onOpenChange={close}>
      <DialogContent className="!fixed !inset-0 !h-[100dvh] !max-h-none !w-screen !max-w-none !rounded-none flex flex-col gap-3 overflow-hidden p-4 sm:!h-fit sm:!max-h-[85dvh] sm:!w-full sm:!max-w-2xl sm:!rounded-lg sm:p-6">
        {target && <PlanQueueBody target={target} />}
      </DialogContent>
    </Dialog>
  )
}

function PlanQueueBody({ target }: { target: PlanQueueTarget }) {
  const { data: queue, isLoading, error } = usePlanQueue(target.id)
  const action = usePlanQueueAction()
  const reorder = useReorderPlans()
  const [confirm, setConfirm] = useState<Confirm>(null)

  const busy = action.isPending || reorder.isPending
  const run = useCallback(
    (kind: PlanQueueAction, name?: string) =>
      action.mutate({ worktreeId: target.id, action: kind, name }),
    [action, target.id]
  )
  const openSession = useCallback(
    (sessionId: string) => {
      useUIStore.getState().setPlanQueueTarget(null)
      openSessionInWorktree(target, sessionId)
    },
    [target]
  )
  const move = useCallback(
    (index: number, delta: number) => {
      if (!queue) return
      const names = movePlan(
        queue.pending.map(plan => plan.name),
        index,
        delta
      )
      if (names) reorder.mutate({ worktreeId: target.id, names })
    },
    [queue, reorder, target.id]
  )

  const now = useNow(30_000)
  const status = !queue
    ? ''
    : queue.paused
      ? 'Paused'
      : queue.blocked.length > 0
        ? 'Blocked'
        : queue.running.length > 0
          ? 'Running'
          : queue.waitReason
            ? 'Waiting'
            : 'Idle'

  return (
    <>
      <DialogHeader className="flex-row items-center gap-2 space-y-0 pr-8">
        <div className="min-w-0 flex-1">
          <DialogTitle className="truncate">
            Plan queue — {target.name}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Plans in the .jean/plans folder of this worktree, in run order.
          </DialogDescription>
        </div>
        {queue && (
          <>
            <span className="text-xs text-muted-foreground">{status}</span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => run(queue.paused ? 'resume' : 'pause')}
            >
              {queue.paused ? (
                <Play className="h-4 w-4" />
              ) : (
                <Pause className="h-4 w-4" />
              )}
              {queue.paused ? 'Resume' : 'Pause'}
            </Button>
          </>
        )}
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {error && (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {queue && queue.blocked.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" />
            <span className="min-w-0 flex-1 break-words">
              Blocked:{' '}
              {queue.blocked.map(file => `.jean/blocked/${file}`).join(', ')}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirm({ kind: 'clear' })}
            >
              Clear blocker
            </Button>
          </div>
        )}

        {queue?.waitReason && queue.blocked.length === 0 && (
          <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
            Waiting: {queue.waitReason}
          </p>
        )}

        {queue && (
          <div className="space-y-0.5">
            {queue.running.map(plan => (
              <PlanRow
                key={plan.name}
                icon={<Loader2 className="h-4 w-4 animate-spin text-primary" />}
                plan={plan}
                detail={[
                  'running',
                  formatElapsed(plan.startedAt, now),
                  plan.modelPin,
                ]}
              >
                <SessionButton onClick={() => openSession(plan.sessionId)} />
              </PlanRow>
            ))}

            {queue.orphans.map(plan => (
              <PlanRow
                key={plan.name}
                icon={<Loader2 className="h-4 w-4 text-muted-foreground" />}
                plan={plan}
                detail={['running, not started by this runner']}
              />
            ))}

            {queue.pending.map((plan, index) => (
              <PlanRow
                key={plan.name}
                icon={<Circle className="h-2 w-2 text-muted-foreground" />}
                plan={plan}
                detail={[
                  plan.gate ? `waits: ${plan.gate}` : undefined,
                  plan.modelPin,
                ]}
              >
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${plan.name} up`}
                  disabled={busy || index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Move ${plan.name} down`}
                  disabled={busy || index === queue.pending.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`More actions for ${plan.name}`}
                      disabled={busy}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => run('skip', plan.name)}>
                      <X className="mr-2 h-4 w-4" />
                      Skip
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() =>
                        setConfirm({ kind: 'remove', name: plan.name })
                      }
                    >
                      <Trash2 className="mr-2 h-4 w-4 text-destructive" />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </PlanRow>
            ))}

            {queue.failed.map(plan => (
              <PlanRow
                key={plan.name}
                icon={<X className="h-4 w-4 text-destructive" />}
                plan={plan}
                detail={[plan.reason || 'failed']}
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run('retry', plan.name)}
                >
                  <RotateCcw className="h-4 w-4" />
                  Retry
                </Button>
                {plan.sessionId && (
                  <SessionButton
                    onClick={() => openSession(plan.sessionId as string)}
                  />
                )}
              </PlanRow>
            ))}

            {queue.skipped.map(plan => (
              <PlanRow
                key={plan.name}
                icon={<X className="h-4 w-4 text-muted-foreground" />}
                plan={plan}
                detail={['skipped']}
                muted
              >
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => run('unskip', plan.name)}
                >
                  <Undo2 className="h-4 w-4" />
                  Unskip
                </Button>
              </PlanRow>
            ))}

            {queue.done.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger className="group flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted/50">
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
                  Done ({queue.done.length})
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-0.5">
                  {queue.done.map(plan => (
                    <PlanRow
                      key={plan.name}
                      icon={<Check className="h-4 w-4 text-success" />}
                      plan={plan}
                      detail={['done']}
                      muted
                    >
                      {plan.sessionId && (
                        <SessionButton
                          onClick={() => openSession(plan.sessionId as string)}
                        />
                      )}
                    </PlanRow>
                  ))}
                </CollapsibleContent>
              </Collapsible>
            )}

            {queue.running.length +
              queue.orphans.length +
              queue.pending.length +
              queue.failed.length +
              queue.skipped.length +
              queue.done.length ===
              0 && (
              <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                No plans yet.
              </p>
            )}
          </div>
        )}
      </div>

      <AddPlanForm worktreeId={target.id} />

      <AlertDialog
        open={confirm !== null}
        onOpenChange={open => {
          if (!open) setConfirm(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === 'remove' ? 'Remove plan?' : 'Clear blocker?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === 'remove'
                ? 'This deletes the plan file:'
                : 'This deletes these blocker files, and the queue can run again:'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="list-disc space-y-0.5 pl-5 font-mono text-xs break-all">
            {confirm?.kind === 'remove' && <li>{confirm.name}</li>}
            {confirm?.kind === 'clear' &&
              queue?.blocked.map(file => (
                <li key={file}>.jean/blocked/{file}</li>
              ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (confirm?.kind === 'remove') run('remove', confirm.name)
                if (confirm?.kind === 'clear') run('clear_blocked')
              }}
            >
              {confirm?.kind === 'remove' ? 'Remove' : 'Clear'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The current time, updated every `intervalMs` (for "running · 4m"). */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

function PlanRow({
  icon,
  plan,
  detail,
  muted,
  children,
}: {
  icon: ReactNode
  plan: QueuePlan
  detail: (string | undefined)[]
  muted?: boolean
  children?: ReactNode
}) {
  const text = detail.filter(Boolean).join(' · ')
  return (
    <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={cn('truncate text-sm', muted && 'text-muted-foreground')}
          title={plan.title}
        >
          {plan.name.replace(/\.md$/i, '')}
        </div>
        {text && (
          <div className="truncate text-xs text-muted-foreground" title={text}>
            {text}
          </div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-1">{children}</div>
      )}
    </div>
  )
}

function SessionButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="outline" onClick={onClick}>
      Session
    </Button>
  )
}

function AddPlanForm({ worktreeId }: { worktreeId: string }) {
  const addPlan = useAddPlan()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback(
    async (files: File[]) => {
      // One after another, so the plans keep the drop order.
      for (const file of files.filter(isMarkdownFile)) {
        try {
          const text = await file.text()
          await addPlan.mutateAsync({
            worktreeId,
            name: file.name,
            content: text,
          })
        } catch {
          // The mutation shows the error toast.
          return
        }
      }
    },
    [addPlan, worktreeId]
  )

  const submit = useCallback(() => {
    if (!name.trim() || !content.trim()) return
    addPlan.mutate(
      { worktreeId, name: name.trim(), content },
      {
        onSuccess: () => {
          setName('')
          setContent('')
          setOpen(false)
        },
      }
    )
  }, [addPlan, content, name, worktreeId])

  return (
    <div
      className={cn(
        'shrink-0 space-y-2 rounded-md border border-dashed p-2',
        dragging && 'border-primary bg-primary/5'
      )}
      onDragOver={event => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault()
        setDragging(false)
        void addFiles(Array.from(event.dataTransfer.files))
      }}
    >
      {open && (
        <div className="space-y-2">
          <Input
            placeholder="Plan name, e.g. fix-login"
            value={name}
            onChange={event => setName(event.target.value)}
            className="text-base md:text-sm"
          />
          <Textarea
            placeholder="Paste the plan (Markdown)"
            value={content}
            onChange={event => setContent(event.target.value)}
            rows={6}
            className="max-h-[40dvh] resize-y font-mono text-base md:text-xs"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!name.trim() || !content.trim() || addPlan.isPending}
              onClick={submit}
            >
              {addPlan.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Add to queue
            </Button>
          </div>
        </div>
      )}
      {!open && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" />
            Add plan
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={addPlan.isPending}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="h-4 w-4" />
            Choose .md files
          </Button>
          <span className="text-xs text-muted-foreground">
            or drop .md files here
          </span>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".md,text/markdown"
        multiple
        hidden
        onChange={event => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void addFiles(files)
        }}
      />
    </div>
  )
}
