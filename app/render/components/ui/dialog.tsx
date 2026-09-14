'use client'

import * as React from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Cross2Icon } from "@radix-ui/react-icons"
import { useTheme } from "next-themes"

import { cn } from "@/utils/common/twMerge"
import {
  subscribeElectronModalOverlay,
  syncElectronModalOverlayTheme,
} from "@/utils/common/modalTitlebarSync"

type DialogProps = React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> & {
  electronOverlay?: boolean
}

const Dialog = ({
  electronOverlay = true,
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: DialogProps) => {
  const { theme, systemTheme } = useTheme()
  const [mounted, setMounted] = React.useState(false)
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen ?? false)
  const isControlled = open !== undefined
  const resolvedOpen = isControlled ? !!open : internalOpen
  const resolvedTheme =
    theme === "system" ? systemTheme ?? undefined : theme ?? undefined

  React.useEffect(() => {
    setMounted(true)
  }, [])

  React.useEffect(() => {
    if (isControlled) {
      setInternalOpen(!!open)
    }
  }, [isControlled, open])

  const themeRef = React.useRef(resolvedTheme)
  themeRef.current = resolvedTheme
  const themeReady = !!resolvedTheme

  // Ref-count modals at module level so nested dialogs and route churn stay correct.
  React.useEffect(() => {
    if (!electronOverlay || !mounted || !resolvedOpen || !themeReady) {
      return
    }
    return subscribeElectronModalOverlay(() => themeRef.current)
  }, [electronOverlay, mounted, resolvedOpen, themeReady])

  React.useEffect(() => {
    if (!electronOverlay || !mounted || !resolvedOpen || !resolvedTheme) {
      return
    }
    syncElectronModalOverlayTheme(resolvedTheme)
  }, [electronOverlay, mounted, resolvedOpen, resolvedTheme])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setInternalOpen(nextOpen)
      }
      if (onOpenChange) {
        onOpenChange(nextOpen)
      }
    },
    [isControlled, onOpenChange]
  )

  return (
    <DialogPrimitive.Root
      open={open}
      defaultOpen={defaultOpen}
      onOpenChange={handleOpenChange}
      {...props}
    />
  )
}

const DialogTrigger = DialogPrimitive.Trigger

const DialogPortal = DialogPrimitive.Portal

const DialogClose = DialogPrimitive.Close

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "modal-backdrop",
      className
    )}
    {...props}
  />
))
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <DialogPortal>
    <DialogOverlay />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "modal-surface",
        className
      )}
      aria-describedby={undefined}
      {...props}
    >
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
        <Cross2Icon className="h-4 w-4" />
        <span className="sr-only">Close</span>
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPortal>
))
DialogContent.displayName = DialogPrimitive.Content.displayName

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    )}
    {...props}
  />
)
DialogHeader.displayName = "DialogHeader"

const DialogFooter = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    )}
    {...props}
  />
)
DialogFooter.displayName = "DialogFooter"

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    )}
    {...props}
  />
))
DialogTitle.displayName = DialogPrimitive.Title.displayName

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm text-muted-foreground", className)}
    {...props}
  />
))
DialogDescription.displayName = DialogPrimitive.Description.displayName

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
}

