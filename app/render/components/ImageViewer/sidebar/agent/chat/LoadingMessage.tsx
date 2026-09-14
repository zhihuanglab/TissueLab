import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar"
import type React from "react";

export function LoadingMessage() {
    return (
        <div className="flex items-start gap-3 text-foreground">
            <div className="w-8 h-8 shrink-0">
                <Avatar className="w-8 h-8 bg-muted">
                    <AvatarImage
                        src="/brand/TissueLab_logo.png"
                        alt="TissueLab Bot"
                        className="object-contain p-1"
                    />
                    <AvatarFallback className="bg-foreground text-background">TL</AvatarFallback>
                </Avatar>
            </div>
            <div className="bg-card border border-border py-3 px-3 max-w-[80%] shadow-sm rounded-xl">
                <div className="flex space-x-[6px]">
                    <div className="w-[6px] h-[6px] bg-muted-foreground rounded-full animate-bounce" />
                    <div className="w-[6px] h-[6px] bg-muted-foreground rounded-full animate-bounce [animation-delay:0.2s]" />
                    <div className="w-[6px] h-[6px] bg-muted-foreground rounded-full animate-bounce [animation-delay:0.4s]" />
                </div>
            </div>
        </div>
    )
}

