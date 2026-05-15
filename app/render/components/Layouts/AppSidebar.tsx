"use client";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RootState } from "@/store";
import {
  setSidebarShow,
  setSidebarUnfoldable,
  setIsMobile,
} from "@/store/slices/layoutSlice";
import { cn } from "@/utils/twMerge";
import {
  FolderOpen,
  Monitor,
  Users
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import * as React from "react";
import { useDispatch, useSelector } from "react-redux";
import { StorageUsageCard } from "./Sidebar-StorageCard";
import UserAccountSection from "./Sidebar-UserAccount";

const navItems = [
  { name: "Dashboard", icon: FolderOpen, href: "/dashboard" },
  { name: "Image Viewer", icon: Monitor, href: "/imageViewer" },
  { name: "Community", icon: Users, href: "/community" },
];

// Get the current date as "YYYY-MM" for version string below the logo
const now = new Date();
const versionString = `v. ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

export default function Component() {
  const dispatch = useDispatch();
  const sidebarShow = useSelector((state: RootState) => state.layout.sidebarShow);
  const unfoldable = useSelector((state: RootState) => state.layout.unfoldable);
  const isMobile = useSelector((state: RootState) => state.layout.isMobile);
  const [isElectron, setIsElectron] = React.useState(false);

  React.useEffect(() => {
    if (typeof window !== 'undefined' && window.electron) {
      setIsElectron(true);
    }

    const isMobileRef = { current: false };

    const handleResize = () => {
      const w = window.innerWidth;
      const mobile = w < 768;
      const narrow = w <= 1024;

      if (mobile !== isMobileRef.current) {
        isMobileRef.current = mobile;
        if (mobile) {
          dispatch(setIsMobile(true));
          dispatch(setSidebarShow(false));
        } else {
          dispatch(setIsMobile(false));
          dispatch(setSidebarShow(true));
        }
      }

      // Icon rail when viewport is at most 1024px (Tailwind lg); full width above
      if (!mobile) {
        dispatch(setSidebarUnfoldable(narrow));
      }
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [dispatch]);

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen overflow-hidden bg-background pb-0 ">
        {/* Sidebar */}
        {sidebarShow && (
          <aside
            className={cn(
              "flex h-full flex-col bg-background transition-all duration-300 ease-in-out",
              // Mobile: always icon-only (64px), same as desktop unfoldable
              isMobile || unfoldable ? "w-16 px-2 py-3" : "w-[224px] px-4 py-4"
            )}
          >
            {/* Logo + collapse */}
            <div className="electron-drag relative px-4 pt-4 pb-0">
              {!unfoldable && !isMobile && (
                <div className="flex w-full items-center gap-2 px-2 py-1 justify-center">
                  <Link
                    href="https://tissuelab.org"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="no-underline electron-no-drag flex flex-col items-center justify-center"
                  >
                    <svg
                      id="Layer_2"
                      data-name="Layer 2"
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 176.68 176.68"
                      width={80}
                      height={80}
                      style={{ height: 'auto' }}
                      className="object-contain"
                    >
                      <defs>
                        <style>
                          {`
                              .cls-1 { fill: #6352a2; }
                              .cls-2 { fill:rgb(215, 217, 219); }
                              
                              rect {
                                opacity: 1;
                                transition: opacity 0s;
                              }
                              
                              #Layer_2:hover rect {
                                opacity: 0;
                              }
                              
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(1) { animation: appear 0.05s ease forwards; animation-delay: 0.05s; }
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(2) { animation: appear 0.05s ease forwards; animation-delay: 0.09s; }
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(3) { animation: appear 0.05s ease forwards; animation-delay: 0.01s; }
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(4) { animation: appear 0.05s ease forwards; animation-delay: 0.26s; }
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(5) { animation: appear 0.05s ease forwards; animation-delay: 0.19s; }
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(6) { animation: appear 0.05s ease forwards; animation-delay: 0.23s; }
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(7) { animation: appear 0.05s ease forwards; animation-delay: 0.15s; }
                              #Layer_2:hover #Layer_1-2 g rect:nth-of-type(8) { animation: appear 0.05s ease forwards; animation-delay: 0.11s; }
                              
                              @keyframes appear {
                                0% { opacity: 0; }
                                100% { opacity: 1; }
                              }
                            `}
                        </style>
                      </defs>
                      <g id="Layer_1-2" data-name="Layer 1">
                        <g>
                          <rect className="cls-2" x="0" width="52.19" height="52.19" />
                          <rect className="cls-2" x="62.24" width="52.19" height="52.19" />
                          <rect className="cls-2" x="124.49" width="52.19" height="52.19" />
                          <rect className="cls-1" x="0" y="62.24" width="52.19" height="52.19" />
                          <rect className="cls-2" x="62.24" y="62.24" width="52.19" height="52.19" />
                          <rect className="cls-1" x="0" y="124.49" width="52.19" height="52.19" />
                          <rect className="cls-1" x="62.24" y="124.49" width="52.19" height="52.19" />
                          <rect className="cls-1" x="124.49" y="124.49" width="52.19" height="52.19" />
                        </g>
                      </g>
                    </svg>
                    <div className="mt-3 text-center">
                    <span className="text-foreground text-xl font-bold drop-shadow-sm">
                      Tissue
                    </span>
                    <span className="text-primary text-xl font-bold drop-shadow-sm">
                      Lab
                    </span>
                  </div>
                  </Link>
                </div>
              )}
            </div>

            {!unfoldable && !isMobile && (
             <div className="px-3 py-1 flex flex-col items-center text-center gap-1">
             <div className="flex items-center text-xs leading-2 text-muted-foreground/60 whitespace-nowrap">
               A research platform developed by
             </div>
             <Link
               href="https://www.zhihuang.ai"
               target="_blank"
               rel="noopener noreferrer"
               className="no-underline electron-no-drag"
             >
               <div className="flex flex-col items-center">
                 <span className="text-xs leading-3 text-muted-foreground/60 font-semibold no-underline">
                   Zhi Huang Lab
                 </span>
                 <span className="text-xs leading-6 text-muted-foreground/60 no-underline">
                   {versionString}
                 </span>
               </div>
             </Link>
           </div>
            )}

            {/* Navigation */}
            <ScrollArea className={cn("electron-no-drag flex-1 transition-colors duration-300 mt-4")}>
              <nav className={cn('flex flex-col gap-2')}>
                {navItems.map((item) => (
                  <NavItem
                    key={item.name}
                    icon={item.icon}
                    label={item.name}
                    href={item.href}
                    isCollapsed={unfoldable || isMobile}
                  />
                ))}
              </nav>
            </ScrollArea>

            {!unfoldable && !isMobile && !isElectron && (<StorageUsageCard className="mt-6" />)}

            <UserAccountSection
              variant={unfoldable || isMobile ? "sidebar-collapsed" : "sidebar"}
              className={unfoldable || isMobile ? "mt-4" : "mt-6"}
            />

            {/* Hide sidebar */}
            {/* <div className={cn("electron-no-drag", unfoldable ? "mt-3" : "mt-4") }>
              <Button
                variant="ghost"
                className={cn(
                  "w-full items-center justify-center rounded-2xl text-muted-foreground hover:bg-muted hover:text-foreground",
                  unfoldable ? "py-2" : "py-3"
                )}
                onClick={() => dispatch(toggleSidebarShow())}
              >
                <X className={cn("h-4 w-4", unfoldable ? "" : "mr-2") } />
                {!unfoldable && <span>Hide Sidebar</span>}
              </Button>
            </div> */}
          </aside>
        )}
      </div>
    </TooltipProvider>
  );
}

function NavItem({
  icon: Icon,
  label,
  href,
  badge,
  isCollapsed,
}: {
  icon: React.ElementType;
  label: string;
  href: string;
  badge?: { color: string; text: string };
  isCollapsed: boolean;
}) {
  const router = useRouter();
  const pathname = router.pathname;
  const pathWithoutQuery = router.asPath.split("?")[0];
  const isActive = pathname === href || pathWithoutQuery === href;

  const sharedIconClasses = cn(
    "flex h-6 w-9 items-center justify-center rounded-[6px] ",
    isActive ? "text-primary" : "text-muted-foreground"
  );

  const NavItemContent = (
    <Link href={href} className="no-underline">
      {isCollapsed ? (
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "electron-no-drag h-12 w-12 rounded-[6px] text-muted-foreground hover:text-muted-foreground",
            isActive && "bg-primary/10 text-primary"
          )}
        >
          {/*@ts-ignore*/}
          <Icon className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground")} />
        </Button>
      ) : (
        <div
          className={cn(
           "group electron-no-drag flex w-full items-center gap-2 rounded-[6px] px-3 py-2 transition-colors", 
           isActive
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
        >
          <div className={sharedIconClasses}>
            {/*@ts-ignore*/}
            <Icon className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground")} />
          </div>
          <div 
          className={cn(
            "flex-1 text-sm leading-5",
            isActive ? "font-bold text-primary" : "font-medium"
          )}
        >
          {label}
        </div>
          {badge && (
            <span className="rounded-[6px] px-2 py-0.5 text-xs font-medium text-primary">
              {badge.text}
            </span>
          )}
        </div>
      )}
    </Link>
  );

  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{NavItemContent}</TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          {label}
          {badge && (
            <span className="rounded-[6px] bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              {badge.text}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return NavItemContent;
}


