"use client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import React, { useEffect, useState } from "react";
import { CustomPromptFieldProps } from "./types";

export const CustomPromptField: React.FC<CustomPromptFieldProps> = ({ value, onChange }) => {
  const [inputValue, setInputValue] = useState(value);
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
    <div className="space-y-1.5">
      <div className="flex items-center space-x-2">
        <Label htmlFor="prompt" className="text-xs text-muted-foreground font-normal">Prompt</Label>
      </div>
      <Input
        id="prompt"
        value={inputValue}
        onFocus={() => setIsTyping(true)}
        onBlur={() => setIsTyping(false)}
        onChange={(e) => {
          setInputValue(e.target.value);
          onChange(e.target.value);
        }}
        placeholder="Enter your prompt"
        className="font-light focus:ring-1 focus:ring-ring focus:ring-offset-1 rounded-[6px] placeholder:text-muted-foreground/40 h-8 text-sm"
      />
    </div>
  );
}; 