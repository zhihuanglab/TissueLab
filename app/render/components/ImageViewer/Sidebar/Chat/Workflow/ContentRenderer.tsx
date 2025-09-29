"use client";
import React, { useEffect, useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ContentRendererProps } from "./types";

export const ContentRenderer: React.FC<ContentRendererProps> = ({ item, onChange }) => {
  const [inputValue, setInputValue] = useState(item.value);
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTyping && event.key === " ") {
        event.stopPropagation();
        event.preventDefault();

        setInputValue((prev) => {
          const newValue = prev + " ";
          onChange(newValue);
          return newValue;
        });
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isTyping, onChange]);

  return (
    <div className="flex items-center justify-between gap-3">
      <Label
        htmlFor={item.key}
        className="text-sm text-muted-foreground font-light"
      >
        {item.key}
      </Label>
      {item.type === "input" && (
        <Input
          id={item.key}
          value={inputValue}
          onFocus={() => setIsTyping(true)}
          onBlur={() => setIsTyping(false)}
          onChange={(e) => {
            setInputValue(e.target.value);
            onChange(e.target.value);
          }}
          placeholder={`Enter ${item.key.toLowerCase()}`}
          className="font-light focus:ring-1 focus:ring-slate-500 focus:ring-offset-1 m-0 w-48 px-[12px] py-[0px]"
        />
      )}
    </div>
  );
}; 