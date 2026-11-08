'use client'

import React, { useState, useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useDispatch, useSelector } from 'react-redux'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { useUserInfo } from '@/contexts/UserInfoProvider'
import ModelSettingsSection, { type ModelSettingsHandle } from './ModelSettingsSection'
import { RootState } from '@/store'
import { setHighlightGtAnnotations } from '@/store/slices/viewer/viewerSettingsSlice'

interface PreferencesModalProps {
  isOpen: boolean
  onClose: () => void
}

const PreferencesModal: React.FC<PreferencesModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { userInfo } = useUserInfo()
  const { theme, setTheme, systemTheme } = useTheme()
  const dispatch = useDispatch()
  const highlightGtAnnotations = useSelector((state: RootState) => state.viewerSettings.highlightGtAnnotations)
  const [mounted, setMounted] = useState(false)
  const [preferences, setPreferences] = useState({
    theme: 'dark',
    notifications: true,
    autoSave: true,
    showAdvancedOptions: false,
  })
  const [isLoading, setIsLoading] = useState(false)
  const modelSettingsRef = React.useRef<ModelSettingsHandle>(null)

  // Get current theme (resolve system theme if needed)
  const currentTheme = React.useMemo(() => {
    if (theme === 'system') {
      return systemTheme
    }
    return theme
  }, [theme, systemTheme])

  const updatePreference = (key: string, value: any) => {
    setPreferences(prev => ({ ...prev, [key]: value }))
  }

  // Apply a theme to the page and the Electron title bar overlay
  const applyTheme = (nextTheme: string) => {
    setTheme(nextTheme)

    const resolved = nextTheme === 'system' ? systemTheme : nextTheme
    if (typeof window !== 'undefined' && window.electron && resolved) {
      try {
        window.electron.send('update-titlebar-theme', resolved)
      } catch (error) {
        console.error('Failed to update title bar theme:', error)
      }
    }
  }

  // Handle theme toggle
  const handleThemeToggle = (checked: boolean) => {
    const nextTheme = checked ? 'dark' : 'light'
    applyTheme(nextTheme)
    // Update local preferences state
    updatePreference('theme', nextTheme)
  }

  // Theme and GT highlight apply live; remember what they were when the
  // dialog opened so Cancel / Escape / clicking outside can put them back.
  const openedWith = React.useRef<{ theme?: string; highlightGt: boolean } | null>(null)
  const wasOpen = React.useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      openedWith.current = { theme, highlightGt: highlightGtAnnotations }
    }
    wasOpen.current = isOpen
    // Only the open transition matters; later theme changes are the user's edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Close without saving: revert the live-applied settings, then close.
  const dismiss = () => {
    const initial = openedWith.current
    if (initial) {
      if (initial.theme && initial.theme !== theme) applyTheme(initial.theme)
      if (initial.highlightGt !== highlightGtAnnotations) {
        dispatch(setHighlightGtAnnotations(initial.highlightGt))
      }
    }
    onClose()
  }

  // Reset to Defaults: application preferences and the theme (default dark).
  const resetToDefaults = () => {
    setPreferences({
      theme: 'dark',
      notifications: true,
      autoSave: true,
      showAdvancedOptions: false,
    })
    if (theme !== 'dark') applyTheme('dark')
  }

  // Mount check for theme
  useEffect(() => {
    setMounted(true)
  }, [])

  // Load preferences from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      const savedPrefs = localStorage.getItem(`preferences_${userInfo.user_id}`)
      if (savedPrefs) {
        try {
          const parsed = JSON.parse(savedPrefs)
          setPreferences(prev => ({ ...prev, ...parsed }))
        } catch (error) {
          console.error('Error loading preferences:', error)
        }
      }
    }
  }, [userInfo?.user_id])

  // Save preferences to localStorage. Theme and viewer switches apply (and
  // persist) as soon as they are flipped; only the per-user application
  // preferences below need a signed-in user to be stored under.
  const savePreferences = async () => {
    if (typeof window === 'undefined') return
    // Unsaved AI model edits are saved too; if that fails the dialog stays
    // open with the error shown in that section.
    setIsLoading(true)
    const modelsOk = (await modelSettingsRef.current?.saveIfChanged()) ?? true
    setIsLoading(false)
    if (!modelsOk) {
      toast.error('Could not save AI model settings', {
        description: 'See the AI Models section for details.',
      })
      return
    }
    if (!userInfo?.user_id) {
      toast.info('Theme and viewer settings are applied', {
        description: 'Sign in to save your other preferences.',
      })
      onClose()
      return
    }
    setIsLoading(true)
    try {
      localStorage.setItem(`preferences_${userInfo.user_id}`, JSON.stringify(preferences))
      console.log('Preferences saved:', preferences)
      // Here you could also call an API to sync preferences to the server
      toast.success('Preferences saved')
      onClose()
    } catch (error) {
      console.error('Error saving preferences:', error)
      toast.error('Could not save preferences', {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && dismiss()}>
      <DialogContent className="max-w-5xl w-[90vw] max-h-[90vh] overflow-y-auto bg-card border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-foreground">
            Preferences
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Customize your application settings and preferences
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-6">
          {/* Appearance */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-foreground">Appearance</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-muted-foreground">Theme</Label>
                  <p className="text-xs text-muted-foreground">Choose your interface theme</p>
                </div>
                <Switch
                  checked={mounted && currentTheme === 'dark'}
                  onCheckedChange={handleThemeToggle}
                />
              </div>

            </div>
          </div>

          <Separator className="bg-border" />

          {/* Viewer / Annotations */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-foreground">Viewer</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-muted-foreground">Highlight user annotations (GT)</Label>
                  <p className="text-xs text-muted-foreground">Always highlight nuclei and tissue marked as ground truth</p>
                </div>
                <Switch
                  checked={highlightGtAnnotations}
                  onCheckedChange={(checked) => dispatch(setHighlightGtAnnotations(checked))}
                />
              </div>
            </div>
          </div>

          <Separator className="bg-border" />

          {/* LLM endpoints / keys: saved by the service, separately from the rest */}
          <ModelSettingsSection ref={modelSettingsRef} isOpen={isOpen} />

          <Separator className="bg-border" />

          {/* Application Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-foreground">Application</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-muted-foreground">Notifications</Label>
                  <p className="text-xs text-muted-foreground">Receive app notifications</p>
                </div>
                <Switch
                  checked={preferences.notifications}
                  onCheckedChange={(checked) => updatePreference('notifications', checked)}
                  disabled={true}
                  className="opacity-50"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-muted-foreground">Auto Save</Label>
                  <p className="text-xs text-muted-foreground">Automatically save your work</p>
                </div>
                <Switch
                  checked={preferences.autoSave}
                  onCheckedChange={(checked) => updatePreference('autoSave', checked)}
                  disabled={true}
                  className="opacity-50"
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-muted-foreground">Show Advanced Options</Label>
                  <p className="text-xs text-muted-foreground">Display advanced features in the interface</p>
                </div>
                <Switch
                  checked={preferences.showAdvancedOptions}
                  onCheckedChange={(checked) => updatePreference('showAdvancedOptions', checked)}
                  disabled={true}
                  className="opacity-50"
                />
              </div>
            </div>
          </div>

        </div>

        <div className="flex justify-between items-center space-x-2 mt-6 pt-4 border-t border-border">
          <Button
            onClick={resetToDefaults}
            variant="outline"
            className="border-border text-foreground hover:bg-accent"
          >
            Reset to Defaults
          </Button>
          
          <div className="flex space-x-2">
            <Button
              onClick={dismiss}
              variant="outline"
              className="border-border text-foreground hover:bg-accent"
            >
              Cancel
            </Button>
            <Button
              onClick={savePreferences}
              disabled={isLoading}
            >
              {isLoading ? 'Saving...' : 'Save Changes'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default PreferencesModal