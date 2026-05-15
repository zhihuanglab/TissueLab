import { useEffect, useRef, useState } from 'react'
import { MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useWorkflowHistory } from '@/store/zustand/store'

interface Props {
  entryId: string
  entryName: string
}

export function WorkflowHistoryActionsMenu({ entryId, entryName }: Props) {
  const removeEntry = useWorkflowHistory((s) => s.removeEntry)
  const renameEntry = useWorkflowHistory((s) => s.renameEntry)

  const [menuOpen, setMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameName, setRenameName] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handleRename = () => {
    const trimmed = renameName.trim()
    if (!trimmed) return
    renameEntry(entryId, trimmed)
    toast.success('Workflow renamed')
    setRenameOpen(false)
  }

  return (
    <>
      <div className="relative" ref={menuRef}>
        <Button
          variant="outline"
          size="icon"
          className="h-7 w-7 rounded-[4px] border border-border bg-transparent text-muted-foreground hover:text-foreground"
          onClick={() => setMenuOpen((prev) => !prev)}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
          <span className="sr-only">More actions</span>
        </Button>
        {menuOpen && (
          <div className="absolute right-0 mt-1 z-20 rounded-sm border border-border bg-card shadow-md flex flex-col">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-xs justify-start"
              onClick={() => {
                setRenameName(entryName)
                setRenameOpen(true)
                setMenuOpen(false)
              }}
            >
              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-3 text-xs text-destructive hover:text-destructive hover:bg-destructive/5 justify-start"
              onClick={() => {
                removeEntry(entryId)
                setMenuOpen(false)
              }}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
            </Button>
          </div>
        )}
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Workflow</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Input
              placeholder="Workflow name"
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleRename() }}
              autoFocus
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button disabled={!renameName.trim()} onClick={handleRename}>Rename</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
