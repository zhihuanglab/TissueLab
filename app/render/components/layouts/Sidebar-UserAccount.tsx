"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useUserInfo } from "@/contexts/UserInfoProvider";
import { useAuthorProfile } from "@/hooks/community/useAuthorProfile";
import { RootState } from "@/store";
import { useSignupModal } from "@/store/zustand/store";
import { cn } from "@/utils/common/twMerge";
import { EllipsisVertical, Settings, User } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { useSelector } from "react-redux";
import AccountSettingsModal from "./AccountSettingsModal";
import PreferencesModal from "./PreferencesModal";
import ProfileDropdown from "./ProfileDropdown";

type Variant = "header" | "sidebar" | "sidebar-collapsed";

interface UserAccountSectionProps {
    variant?: Variant;
    isWindows?: boolean;
    isElectron?: boolean;
    className?: string;
}

const UserAccountSection: React.FC<UserAccountSectionProps> = ({
    variant = "header",
    isWindows = false,
    isElectron = false,
    className,
}) => {
    const { userInfo, userIdentity, logout } = useUserInfo();
    const setSignupModalOpen = useSignupModal((s) => s.setSignupModalOpen);
    const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
    const [isAccountSettingsOpen, setIsAccountSettingsOpen] = useState(false);
    const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    // Two avatar/name sources, merged at render time:
    //   1. Redux (state.user.*) — updated synchronously when the user edits
    //      their profile in AccountSettingsModal and by the Firestore
    //      onSnapshot subscription inside UserInfoProvider. Wins when set
    //      because it reflects the user's just-saved edits.
    //   2. useAuthorProfile(uid) — backend `/v1/users/{uid}/public-profile`
    //      which signs the GCS avatar URL server-side. Used as the source
    //      of truth when Redux is empty (cold start, or the user's
    //      Firestore profile is missing the avatar_url field). Same source
    //      community cards use, so the sidebar can never disagree with
    //      what's shown on a public profile.
    // The previous version juggled three useState slots, four localStorage
    // reads + writes, and three useEffects that all updated the same
    // `avatarPreview` — drop all of that.
    const reduxAvatarUrl = useSelector((s: RootState) => s.user.avatarUrl);
    const reduxPreferredName = useSelector((s: RootState) => s.user.preferredName);
    const reduxCustomTitle = useSelector((s: RootState) => s.user.customTitle);
    const reduxOrganization = useSelector((s: RootState) => s.user.organization);
    const authorProfile = useAuthorProfile(userInfo?.user_id ?? null);

    const isSidebar = variant === "sidebar" || variant === "sidebar-collapsed";
    const isCollapsed = variant === "sidebar-collapsed";

    // `<img onError>` can null this out to force the gradient placeholder if
    // the URL stops working mid-session. Defaults to whichever source has a
    // value; recomputed every render so a fresh Redux/backend value reopens
    // the image after an error.
    const [avatarBroken, setAvatarBroken] = useState(false);
    const effectiveAvatar = avatarBroken
        ? ""
        : reduxAvatarUrl || authorProfile?.avatarUrl || "";
    useEffect(() => {
        // New URL arrived — give it another chance even if the previous one 404ed.
        if (reduxAvatarUrl || authorProfile?.avatarUrl) setAvatarBroken(false);
    }, [reduxAvatarUrl, authorProfile?.avatarUrl]);

    const preferredName =
        reduxPreferredName || authorProfile?.displayName || "";
    const customTitle = reduxCustomTitle || "";
    const organization = reduxOrganization || "";

    useEffect(() => {
        return () => {
            if (timeoutRef.current) {
                clearTimeout(timeoutRef.current);
            }
        };
    }, []);

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

    const displayName =
        preferredName ||
        (userInfo?.email ? userInfo.email.split("@")[0] : userInfo?.email || "User");
    const fallbackInitial =
        preferredName?.charAt(0).toUpperCase() ||
        (userInfo?.email ? userInfo.email.charAt(0).toUpperCase() : "U");

    const sidebarTextBlock = (
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden text-left">
            <span 
                className="truncate text-sm font-medium text-foreground"
                title={displayName || 'null'}
            >
                {displayName || 'null'}
            </span>
        </div>
    );

    const wrapperClasses = (() => {
        if (variant === "sidebar") {
            return "electron-no-drag flex items-center gap-3 min-w-0 rounded-xl p-0 pt-2 pl-2 pb-2";
        }
        if (variant === "sidebar-collapsed") {
            return "electron-no-drag flex flex-col items-center gap-2 rounded-xl p-2";
        }
        return "electron-no-drag flex items-center gap-4 min-w-0";
    })();

    return (
        <>
            {userIdentity === 3 && userInfo ? (
                <div
                    className={cn(wrapperClasses, className)}
                >
                    <div
                        className={cn(
                            "relative flex items-center min-w-0 flex-1",
                            isSidebar && !isCollapsed && "gap-3",
                            isCollapsed && "flex-col"
                        )}
                        onMouseLeave={handleMouseLeave}
                        onMouseEnter={handleMouseEnter}
                    >
                        <Avatar
                            onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
                            key={effectiveAvatar || "fallback"}
                            className={cn(
                                "cursor-pointer transition-all hover:ring-2 hover:ring-primary/40 border border-border shrink-0",
                                isCollapsed ? "h-10 w-10" : "h-9 w-9"
                            )}
                        >
                            {effectiveAvatar ? (
                                <AvatarImage
                                    src={effectiveAvatar}
                                    alt={preferredName || userInfo.email || "User"}
                                    onError={() => setAvatarBroken(true)}
                                />
                            ) : null}
                            <AvatarFallback delayMs={0} className="bg-muted text-sm text-foreground">
                                {fallbackInitial}
                            </AvatarFallback>
                        </Avatar>
                        {!isCollapsed && isSidebar && sidebarTextBlock}
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
                            avatarPreview={effectiveAvatar}
                        />
                    </div>
                    {!isCollapsed && isSidebar && (
                        <Button
                            onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
                            variant="ghost"
                            size="icon"
                            className="ml-auto shrink-0 h-8 w-6 text-muted-foreground hover:text-foreground"
                        >
                            <EllipsisVertical className="h-4 w-4" />
                        </Button>
                    )}
                    {!isSidebar && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                            onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)}
                        >
                            <EllipsisVertical className="h-5 w-5" />
                        </Button>
                    )}
                </div>
            ) : (
                <div
                    className={cn(
                        wrapperClasses,
                        className,
                        "justify-between"
                    )}
                >
                    <Button
                        variant="ghost"
                        className={cn(
                            "flex items-center gap-2",
                            isSidebar && !isCollapsed
                                ? "min-w-0 flex-1 justify-start text-muted-foreground hover:bg-muted hover:text-foreground"
                                : "rounded-full text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setSignupModalOpen(true)}
                    >
                        <User className="h-5 w-5 text-muted-foreground" />
                        {!isCollapsed && <span className="text-sm text-muted-foreground">Login</span>}
                    </Button>
                    {/* Preferences (AI models, theme, ...) without signing in:
                        the local edition runs on an anonymous session. */}
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Preferences"
                        title="Preferences"
                        className="shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setIsPreferencesOpen(true)}
                    >
                        <Settings className="h-4 w-4" />
                    </Button>
                </div>
            )}

            {/* AccountSettingsModal now dispatches every profile field to
                Redux itself, so consumers (this component, Chatbox, etc.)
                pick up edits via the redux selectors without needing prop
                callback plumbing. */}
            <AccountSettingsModal
                isOpen={isAccountSettingsOpen}
                onClose={() => setIsAccountSettingsOpen(false)}
            />

            <PreferencesModal
                isOpen={isPreferencesOpen}
                onClose={() => setIsPreferencesOpen(false)}
            />
        </>
    );
};

export default UserAccountSection;


