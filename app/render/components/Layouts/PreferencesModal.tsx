'use client'

import React, { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { useUserInfo } from '@/provider/UserInfoProvider'

interface PreferencesModalProps {
  isOpen: boolean
  onClose: () => void
}

const PreferencesModal: React.FC<PreferencesModalProps> = ({
  isOpen,
  onClose,
}) => {
  const { userInfo } = useUserInfo()
  const [preferences, setPreferences] = useState({
    theme: 'dark',
    notifications: true,
    autoSave: true,
    showAdvancedOptions: false,
  })
  const [isLoading, setIsLoading] = useState(false)

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

  const updatePreference = (key: string, value: any) => {
    setPreferences(prev => ({ ...prev, [key]: value }))
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl w-[90vw] max-h-[90vh] overflow-y-auto bg-gray-50 border-gray-300 text-gray-900">
        <DialogHeader>
          <DialogTitle className="text-xl font-semibold text-gray-800">
            Preferences
          </DialogTitle>
          <DialogDescription className="text-gray-600">
            Customize your application settings and preferences
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-6">
          {/* Appearance */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-700">Appearance</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-gray-600">Theme</Label>
                  <p className="text-xs text-gray-500">Choose your interface theme (Coming soon)</p>
                </div>
                <Select
                  value={preferences.theme}
                  disabled={true}
                >
                  <SelectTrigger className="w-32 bg-gray-100 border-gray-300 cursor-not-allowed opacity-60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-white border-gray-300">
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="auto">Auto</SelectItem>
                  </SelectContent>
                </Select>
              </div>

            </div>
          </div>

          <Separator className="bg-gray-300" />

          {/* Application Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-700">Application</h3>
            
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <Label className="text-sm font-medium text-gray-400">Notifications</Label>
                  <p className="text-xs text-gray-400">Receive app notifications</p>
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
                  <Label className="text-sm font-medium text-gray-400">Auto Save</Label>
                  <p className="text-xs text-gray-400">Automatically save your work</p>
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
                  <Label className="text-sm font-medium text-gray-400">Show Advanced Options</Label>
                  <p className="text-xs text-gray-400">Display advanced features in the interface</p>
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

        <div className="flex justify-between items-center space-x-2 mt-6 pt-4 border-t border-gray-300">
          <Button
            onClick={() => setPreferences({
              theme: 'dark',
              notifications: true,
              autoSave: true,
              showAdvancedOptions: false,
            })}
            variant="outline"
            className="border-gray-300 text-gray-700 hover:bg-white"
          >
            Reset to Defaults
          </Button>
          
          <div className="flex space-x-2">
            <Button
              onClick={onClose}
              variant="outline"
              className="border-gray-300 text-gray-700 hover:bg-white"
            >
              Cancel
            </Button>
            <Button
              onClick={savePreferences}
              disabled={isLoading}
              className="bg-blue-600 hover:bg-blue-700"
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