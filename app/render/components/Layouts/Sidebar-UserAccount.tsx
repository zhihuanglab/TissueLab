"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useUserInfo } from "@/provider/UserInfoProvider";
import { RootState } from "@/store";
import { useSignupModal } from "@/store/zustand/store";
import { cn } from "@/utils/twMerge";
import { EllipsisVertical, User } from "lucide-react";
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
    const [customTitle, setCustomTitle] = useState("");
    const [preferredName, setPreferredName] = useState("");
    const [organization, setOrganization] = useState("");
    const [avatarPreview, setAvatarPreview] = useState("");
    const globalAvatarUrl = useSelector((state: RootState) => state.user.avatarUrl);
    const globalPreferredName = useSelector((state: RootState) => state.user.preferredName);
    const globalCustomTitle = useSelector((state: RootState) => state.user.customTitle);
    const globalOrganization = useSelector((state: RootState) => state.user.organization);
    const timeoutRef = useRef<NodeJS.Timeout | null>(null);

    const isSidebar = variant === "sidebar" || variant === "sidebar-collapsed";
    const isCollapsed = variant === "sidebar-collapsed";

    useEffect(() => {
        if (typeof window !== "undefined" && userInfo?.user_id) {
            try {
                const rawTitle =
                    globalCustomTitle || localStorage.getItem(`custom_title_${userInfo.user_id}`);
                const rawName =
                    globalPreferredName || localStorage.getItem(`preferred_name_${userInfo.user_id}`);
                const rawOrg =
                    globalOrganization || localStorage.getItem(`organization_${userInfo.user_id}`);
                const rawAvatar =
                    globalAvatarUrl || localStorage.getItem(`user_avatar_${userInfo.user_id}`);

                const savedTitle = rawTitle && rawTitle !== "null" ? rawTitle : "";
                const savedName = rawName && rawName !== "null" ? rawName : "";
                const savedOrganization = rawOrg && rawOrg !== "null" ? rawOrg : "";
                const savedAvatar = rawAvatar && rawAvatar !== "null" ? rawAvatar : "";

                setCustomTitle(savedTitle);
                setPreferredName(savedName);
                setOrganization(savedOrganization);
                setAvatarPreview(savedAvatar);
            } catch (error) {
                console.error("Error loading user preferences:", error);
            }
        }
    }, [
        userInfo?.user_id,
        globalCustomTitle,
        globalPreferredName,
        globalOrganization,
        globalAvatarUrl,
    ]);

    useEffect(() => {
        if (globalAvatarUrl && globalAvatarUrl !== "null") {
            setAvatarPreview(globalAvatarUrl);
            return;
        }
        if (typeof window !== "undefined" && userInfo?.user_id) {
            const savedAvatarRaw = localStorage.getItem(`user_avatar_${userInfo.user_id}`);
            const savedAvatar = savedAvatarRaw && savedAvatarRaw !== "null" ? savedAvatarRaw : "";
            setAvatarPreview(savedAvatar);
        }
    }, [globalAvatarUrl, userInfo?.user_id]);

    useEffect(() => {
        if (typeof window === "undefined" || !userInfo?.user_id) return;

        const handleStorageChange = () => {
            try {
                const rawAvatar =
                    globalAvatarUrl || localStorage.getItem(`user_avatar_${userInfo.user_id}`);
                const rawTitle =
                    globalCustomTitle || localStorage.getItem(`custom_title_${userInfo.user_id}`);
                const rawName =
                    globalPreferredName || localStorage.getItem(`preferred_name_${userInfo.user_id}`);
                const rawOrg =
                    globalOrganization || localStorage.getItem(`organization_${userInfo.user_id}`);

                const savedAvatar = rawAvatar && rawAvatar !== "null" ? rawAvatar : "";
                const savedTitle = rawTitle && rawTitle !== "null" ? rawTitle : "";
                const savedName = rawName && rawName !== "null" ? rawName : "";
                const savedOrganization = rawOrg && rawOrg !== "null" ? rawOrg : "";

                setAvatarPreview(savedAvatar || "");
                setCustomTitle(savedTitle);
                setPreferredName(savedName);
                setOrganization(savedOrganization);
            } catch { }
        };

        window.addEventListener("storage", handleStorageChange);
        window.addEventListener("localStorageChanged", handleStorageChange as EventListener);
        return () => {
            window.removeEventListener("storage", handleStorageChange);
            window.removeEventListener("localStorageChanged", handleStorageChange as EventListener);
        };
    }, [
        userInfo?.user_id,
        globalAvatarUrl,
        globalCustomTitle,
        globalPreferredName,
        globalOrganization,
    ]);

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
                            key={avatarPreview || "fallback"}
                            className={cn(
                                "cursor-pointer transition-all hover:ring-2 hover:ring-primary/40 border border-border shrink-0",
                                isCollapsed ? "h-10 w-10" : "h-9 w-9"
                            )}
                        >
                            {avatarPreview ? (
                                <AvatarImage
                                    src={avatarPreview}
                                    alt={preferredName || userInfo.email || "User"}
                                    onError={() => setAvatarPreview("")}
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
                            avatarPreview={avatarPreview}
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
                                ? "w-full justify-start text-muted-foreground hover:bg-muted hover:text-foreground"
                                : "rounded-full text-muted-foreground hover:text-foreground"
                        )}
                        onClick={() => setSignupModalOpen(true)}
                    >
                        <User className="h-5 w-5 text-muted-foreground" />
                        {!isCollapsed && <span className="text-sm text-muted-foreground">Login</span>}
                    </Button>
                </div>
            )}

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

            <PreferencesModal
                isOpen={isPreferencesOpen}
                onClose={() => setIsPreferencesOpen(false)}
            />
        </>
    );
};

export default UserAccountSection;


