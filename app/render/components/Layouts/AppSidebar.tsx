"use client";
import * as React from "react";
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Search,
  MessageSquareText,
  Workflow,
  BookOpen,
  FileCode,
  Microscope,
  Menu,
  Store,
  ChevronLeft,
  LibraryBig,
  FileChartPie,
  X,
  Users,
} from "lucide-react";
import { cn } from "@/utils/twMerge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDispatch, useSelector } from "react-redux";
import {
  setSidebarUnfoldable,
  toggleSidebarShow,
  toggleSidebarUnfoldable,
} from "@/store/slices/sidebarSlice";
import { RootState } from "@/store";
import Link from "next/link";
import Image from "next/image";

const navItems = [
  { name: "Dashboard", icon: LayoutDashboard, href: "/dashboard", badge: { color: "info", text: "NEW" } },
  { name: "Image Viewer", icon: Microscope, href: "/imageViewer" },
  { name: "Community", icon: Users, href: "/community" },
  // { name: "Code Editor", icon: FileCode, href: "/codeEditor" },
  // TODO: Resources & Tutorials section - commented out for future use
  // { name: "Resources & Tutorials", icon: LibraryBig, href: "/resources" },
  //{ name: "Connect", icon: Workflow, href: "/arena" },
  // { name: "Tutorial", icon: BookOpen, href: "/tutorial" },
  // { name: "Behavior Analyze", icon: FileChartPie, href: "/behaviorAnalyze" },
];

export default function Component() {
  const dispatch = useDispatch();
  const sidebarShow = useSelector((state: RootState) => state.sidebar.sidebarShow);
  const unfoldable = useSelector((state: RootState) => state.sidebar.unfoldable);
  const [isElectron, setIsElectron] = React.useState(false);

  React.useEffect(() => {
    // Detect Electron environment
    if (typeof window !== 'undefined' && window.electron) {
      setIsElectron(true);
    }

    const handleResize = () => {
      if (window.innerWidth < 768) {
        dispatch(setSidebarUnfoldable(true));
      } else {
        dispatch(setSidebarUnfoldable(false));
      }
    };

    handleResize();

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, [dispatch]);

  return (
    <TooltipProvider delayDuration={0}>
      <div className="flex h-screen overflow-hidden bg-gray-100 dark:bg-gray-900">
        {/* Sidebar */}
        {sidebarShow && (
          <aside
            className={cn(
              "relative flex flex-col border-gray-700 bg-gray-900 transition-all duration-300 ease-in-out",
              unfoldable ? "w-16" : "w-60"
            )}
          >
            <div className="flex h-full flex-col">
              
              {/* Logo and collapse button */}
              <div className="electron-drag relative px-4 pt-4">
                {!unfoldable && (
                  <div className="flex w-full justify-center mb-2">
                    <Link
                      href="https://tissuelab.org"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="no-underline electron-no-drag"
                    >
                      <Image
                        src="/brand/TissueLab_logo.png"
                        alt="TissueLab Logo"
                        width={80}
                        height={60}
                        style={{ height: 'auto' }}
                        className="object-contain"
                      />
                    </Link>
                  </div>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "electron-no-drag h-10 w-10 text-gray-50 hover:text-white absolute top-2 right-0",
                    unfoldable && "left-1/2 -translate-x-1/2 relative"
                  )}
                  onClick={() => dispatch(toggleSidebarUnfoldable())}
                >
                  {unfoldable ? <Menu className="h-4 w-4"/> : <ChevronLeft className="h-4 w-4"/>}
                </Button>
              </div>

              {!unfoldable && (
                <div className="border-b border-gray-700 px-3 py-2 mt-0">
                  <div className="flex flex-col items-center text-[#E6E7E8] text-[10px]">
                    A research platform developed by
                  </div>
                  <Link
                    href="https://www.zhihuang.ai"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="no-underline electron-no-drag"
                  >
                    <div className="flex flex-col items-center">
                      <span className="text-[#E6E7E8] text-[10px] font-bold no-underline">
                        Zhi Huang Lab
                      </span>
                      <span className="text-[#E6E7E8] text-[10px] no-underline">v. 2025-06</span>
                    </div>
                  </Link>
                </div>
              )}

              {/* Navigation */}
              <ScrollArea className={cn("electron-no-drag flex-1 py-2", unfoldable && "mt-2")}>
                <nav className="space-y-1 px-2">
                  {navItems.map((item) => (
                    <NavItem
                      key={item.name}
                      icon={item.icon}
                      label={item.name}
                      href={item.href}
                      badge={item.badge}
                      isCollapsed={unfoldable}
                    />
                  ))}
                </nav>
              </ScrollArea>

              {/* Hide sidebar button */}
              <div className="electron-no-drag border-t border-gray-700 p-1">
                <div className="h-10 flex items-center justify-center">
                <Button
                  variant="ghost"
                  className={cn(
                    "w-full text-gray-300 hover:bg-gray-800 hover:text-white transition-colors duration-200",
                    unfoldable ? "justify-center" : "justify-start"
                  )}
                  onClick={() => dispatch(toggleSidebarShow())}
                >
                  <X className={cn("h-4 w-4", unfoldable ? "" : "mr-2")}/>
                  {!unfoldable && <span>Hide Sidebar</span>}
                </Button>
                </div>
              </div>
            </div>
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
  const pathname = usePathname(); //get current

  const NavItemContent = (
    <Link href={href} className="no-underline">
      <Button
        variant="ghost"
        className={cn(
          "electron-no-drag w-full justify-start",
          isCollapsed ? "h-10 px-2" : "px-3 py-2",
          "text-gray-300 hover:bg-gray-800 hover:text-white transition-colors duration-200",
          //high light current
          pathname === href && "bg-indigo-800 text-white"
        )}
      >
        {/*@ts-ignore*/}
        <Icon className={cn("h-4 w-4", isCollapsed ? "mx-auto" : "mr-3")} />
        {!isCollapsed && (
          <>
            <span className="flex-1 text-left">{label}</span>
            {badge && (
              <span className="ml-auto rounded-full bg-blue-500 px-2 py-0.5 text-xs font-medium text-white">
                {badge.text}
              </span>
            )}
          </>
        )}
      </Button>
    </Link>
  );

  if (isCollapsed) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{NavItemContent}</TooltipTrigger>
        <TooltipContent side="right" className="flex items-center gap-2">
          {label}
          {badge && (
            <span className="rounded-full bg-blue-500 px-2 py-0.5 text-xs font-medium text-white">
              {badge.text}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
    );
  }

  return NavItemContent;
}


