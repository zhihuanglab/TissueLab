import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Menu, Plus, Settings, User, X } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import { toggleSidebarShow } from "@/store/slices/sidebarSlice";
// Temporarily disabled viewport functionality
// import { addWSIInstance, setActiveInstance, removeWSIInstance, setSyncCoordinates } from '@/store/slices/wsiSlice';
import { RootState } from '@/store';
import { useUserInfo } from '@/provider/UserInfoProvider';
import { useSignupModal } from '@/store/zustand/store';
import ProfileDropdown from '../Layouts/ProfileDropdown';
import AccountSettingsModal from '../Layouts/AccountSettingsModal';
import PreferencesModal from '../Layouts/PreferencesModal';

interface ViewportControlsProps {}

const ViewportControls: React.FC<ViewportControlsProps> = () => {
  const dispatch = useDispatch();
  
  // Get state from wsiSlice - temporarily disabled viewport functionality
  // const { instances, activeInstanceId, syncCoordinates } = useSelector((state: RootState) => state.wsi);
  const sidebarShow = useSelector((state: RootState) => state.sidebar.sidebarShow);
    
  // User login functionality - same as AppHeader
  const setSignupModalOpen = useSignupModal((s) => s.setSignupModalOpen);
  const { userInfo, userIdentity, isLoadingUser, logout } = useUserInfo();
  const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
  const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [preferredName, setPreferredName] = useState('');
  const [organization, setOrganization] = useState('');
  const [avatarPreview, setAvatarPreview] = useState('');
  const globalAvatarUrl = useSelector((state: RootState) => state.user.avatarUrl);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Prefer Redux avatarUrl, fallback to localStorage
  useEffect(() => {
    if (globalAvatarUrl) {
      setAvatarPreview(globalAvatarUrl);
      return;
    }
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      const savedAvatar = localStorage.getItem(`user_avatar_${userInfo.user_id}`);
      if (savedAvatar) setAvatarPreview(savedAvatar);
    }
  }, [globalAvatarUrl, userInfo?.user_id]);

  // Load other user preferences from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined' && userInfo?.user_id) {
      try {
        const savedTitle = localStorage.getItem(`custom_title_${userInfo.user_id}`);
        const savedName = localStorage.getItem(`preferred_name_${userInfo.user_id}`);
        const savedOrganization = localStorage.getItem(`organization_${userInfo.user_id}`);
        
        if (savedTitle) setCustomTitle(savedTitle);
        if (savedName) setPreferredName(savedName);
        if (savedOrganization) setOrganization(savedOrganization);
      } catch (error) {
        console.error('Error loading user preferences:', error);
      }
    }
  }, [userInfo?.user_id]);

  // Profile dropdown handlers
  const handleMouseLeave = () => {
    timeoutRef.current = setTimeout(() => {
      setIsProfileDropdownOpen(false);
    }, 1000);
  };

  const handleMouseEnter = () => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);
  // Temporarily disabled viewport functionality
  /*
  // Get array of all instance IDs
  const instanceIds = Object.keys(instances);

  const handleAddWindow = useCallback(async () => {
    try {
      // Check if there is an active instance
      if (!activeInstanceId) {
        console.error('No active instance ID found');
        return;
      }
      
      // Get information about the active instance
      const activeInstance = instances[activeInstanceId];
      if (!activeInstance) {
        console.error('No active instance found');
        return;
      }


      // New window should keep the same backend instanceId as the source instance, but use a different frontend identifier
      const sourceInstanceId = activeInstanceId;
      // Use timestamp as frontend view identifier to ensure uniqueness
      const frontendViewId = `view_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      console.log('Adding new window with shared backend instance:', {
        sourceInstanceId,
        frontendViewId,
        sourceInstanceData: activeInstance
      });

      // Create new view, but keep the same backend instanceId
      const newInstanceData = {
        instanceId: sourceInstanceId, // Keep the same backend instanceId
        wsiInfo: { ...activeInstance.wsiInfo, frontendViewId }, // Add frontend view identifier
        fileInfo: { ...activeInstance.fileInfo, frontendViewId }, // Add frontend view identifier
        isActive: false, // New view default inactive
        viewportState: { x: 0, y: 0, zoom: 1 } // Independent viewport state
      };
      
      // Use unique key to store multiple views, but share the same backend instanceId
      const viewKey = `${sourceInstanceId}_${frontendViewId}`;
      
      dispatch(addWSIInstance({
        instanceId: viewKey,
        wsiInfo: newInstanceData.wsiInfo,
        fileInfo: newInstanceData.fileInfo
      }));
      
      console.log('New window added successfully with shared backend instance:', {
        viewKey,
        sourceInstanceId,
        frontendViewId,
        wsiInfoKeys: Object.keys(newInstanceData.wsiInfo),
        fileInfoKeys: Object.keys(newInstanceData.fileInfo)
      });
    } catch (error) {
      console.error('Failed to add new window:', error);
    }
  }, [dispatch, instances, activeInstanceId]);

  const handleWindowClick = (instanceId: string) => {
    dispatch(setActiveInstance(instanceId));
  };

  const handleRemoveWindow = (instanceId: string) => {
    if (Object.keys(instances).length > 1) {
      dispatch(removeWSIInstance(instanceId));
    }
  };

  const handleSyncToggle = (checked: boolean) => {
    dispatch(setSyncCoordinates(checked));
  };
  */

  return (
    <div className="flex items-center justify-between bg-gray-900 px-4 py-2 border-b border-gray-700 h-16">
      <div className="flex items-center space-x-4">
        {!sidebarShow && (
          <Button
            variant="ghost"
            size="icon"
            className="text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            onClick={() => dispatch(toggleSidebarShow())}
          >
            <Menu className="h-5 w-5"/>
          </Button>
        )}
        {/* Viewport controls temporarily disabled
        <div className="flex items-center space-x-3">
          <span className="text-white text-sm font-medium">Viewport:</span>
          
          {/* Window buttons */}
          {/*<div className="flex items-center space-x-1">
            {instanceIds.map((instanceId, index) => (
              <div key={instanceId} className="flex items-center">
                <Button
                  variant={activeInstanceId === instanceId ? "default" : "secondary"}
                  size="sm"
                  onClick={() => handleWindowClick(instanceId)}
                  className={`px-3 py-1 text-xs ${
                    activeInstanceId === instanceId 
                      ? 'bg-blue-500 hover:bg-blue-600 text-white' 
                      : 'bg-gray-600 hover:bg-gray-500 text-white'
                  }`}
                >
                  Window {index + 1}
                </Button>
                {Object.keys(instances).length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveWindow(instanceId)}
                    className="w-6 h-6 p-0 ml-1 text-gray-400 hover:text-red-400 hover:bg-red-900/20 rounded-full flex items-center justify-center"
                    title="Remove window"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                )}
              </div>
            ))}
            
            {/* Add window button */}
            {/*<Button
              variant="secondary"
              size="sm"
              onClick={handleAddWindow}
              className="w-8 h-8 p-0 bg-green-500 hover:bg-green-600 text-white rounded-full flex items-center justify-center ml-2"
              title="Add new window"
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
        
        {/* Sync coordinates - moved closer to window controls */}
        {/*<div className="flex items-center space-x-2">
          <Switch
            checked={syncCoordinates}
            onCheckedChange={handleSyncToggle}
            className="data-[state=checked]:bg-blue-500"
          />
          <span className="text-white text-sm">
            Sync viewport coordinates
          </span>
        </div>
        */}
      </div>

      {/* Right side - Login/Profile */}
      <div className="flex items-center space-x-4 ml-auto">
        {userIdentity === 3 && userInfo ? (
          <div
            className="relative"
            onMouseLeave={handleMouseLeave}
            onMouseEnter={handleMouseEnter}
          >
            <Avatar 
              key={avatarPreview || 'fallback'}
              className={`h-9 w-9 cursor-pointer hover:ring-2 hover:ring-blue-500/50 transition-all ${avatarPreview ? '' : 'bg-gray-700 text-gray-200'}`}
              onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
            >
            {avatarPreview ? (
              <AvatarImage 
                src={avatarPreview} 
                alt={preferredName || userInfo.email || "User"}
                onError={() => setAvatarPreview('')}
              />
            ) : null}
            <AvatarFallback delayMs={0} className="text-sm bg-gray-700 text-gray-200">
                {preferredName 
                  ? preferredName.charAt(0).toUpperCase()
                  : userInfo.email 
                    ? userInfo.email.charAt(0).toUpperCase() 
                    : "U"
                }
              </AvatarFallback>
            </Avatar>
            <ProfileDropdown
              isOpen={isProfileDropdownOpen}
              onClose={() => setIsProfileDropdownOpen(false)}
              onLogout={logout}
              onOpenAccountSettings={() => {
                setIsAccountSettingsOpen(true);
                setIsProfileDropdownOpen(false);
              }}
              onOpenPreferences={() => {
                setIsPreferencesOpen(true);
                setIsProfileDropdownOpen(false);
              }}
              customTitle={customTitle}
              preferredName={preferredName}
              organization={organization}
              avatarPreview={avatarPreview}
            />
          </div>
        ) : (
          <Button 
            variant="ghost" 
            className="flex items-center gap-2 rounded-full"
            onClick={() => setSignupModalOpen(true)}
          >
            <User className="h-5 w-5 text-gray-500 dark:text-gray-400" />
            <span className="text-gray-400 hover:text-gray-200">Login</span>
          </Button>
        )}
      </div>
      
      {/* Account Settings Modal */}
      <AccountSettingsModal
        isOpen={isAccountSettingsOpen}
        onClose={() => setIsAccountSettingsOpen(false)}
        onTitleUpdate={(title) => setCustomTitle(title)}
        onPreferencesUpdate={(preferences) => {
          if (preferences.customTitle !== undefined) setCustomTitle(preferences.customTitle);
          if (preferences.preferredName !== undefined) setPreferredName(preferences.preferredName);
          if (preferences.organization !== undefined) setOrganization(preferences.organization);
          if (preferences.avatarPreview !== undefined) setAvatarPreview(preferences.avatarPreview);
        }}
      />
      
      {/* Preferences Modal */}
      <PreferencesModal
        isOpen={isPreferencesOpen}
        onClose={() => setIsPreferencesOpen(false)}
      />
    </div>
  );
};

export default ViewportControls;