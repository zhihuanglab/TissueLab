'use client'

import React, { useState, useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useDispatch, useSelector } from 'react-redux'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import { useUserInfo } from '@/provider/UserInfoProvider'
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

  // Handle theme toggle
  const handleThemeToggle = (checked: boolean) => {
    const nextTheme = checked ? 'dark' : 'light'
    setTheme(nextTheme)
    
    // Notify Electron to update title bar overlay colors
    if (typeof window !== 'undefined' && window.electron) {
      try {
        window.electron.send('update-titlebar-theme', nextTheme)
      } catch (error) {
        console.error('Failed to update title bar theme:', error)
      }
    }
    
    // Update local preferences state
    updatePreference('theme', nextTheme)
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

  // Save preferences to localStorage
  const savePreferences = async () => {
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      setIsLoading(true)
      try {
        localStorage.setItem(`preferences_${userInfo.user_id}`, JSON.stringify(preferences))
        console.log('Preferences saved:', preferences)
        // Here you could also call an API to sync preferences to the server
      } catch (error) {
        console.error('Error saving preferences:', error)
      } finally {
        setIsLoading(false)
      }
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
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
            onClick={() => setPreferences({
              theme: 'dark',
              notifications: true,
              autoSave: true,
              showAdvancedOptions: false,
            })}
            variant="outline"
            className="border-border text-foreground hover:bg-accent"
          >
            Reset to Defaults
          </Button>
          
          <div className="flex space-x-2">
            <Button
              onClick={onClose}
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