"use client";
import React, { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export interface ScriptPromptFieldProps {
  value: string;
  onChange: (value: string) => void;
}

export const ScriptPromptField: React.FC<ScriptPromptFieldProps> = ({ value, onChange }) => {
  const [inputValue, setInputValue] = useState(value ?? "");
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    setInputValue(value ?? "");
  }, [value]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTyping && event.key === " ") {
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [isTyping]);

  return (
    <div className="space-y-2">
      <div className="flex items-center space-x-2">
        <MessageSquareText className="h-4 w-4 text-muted-foreground" />
        <Label htmlFor="script-prompt" className="text-muted-foreground font-normal">Script</Label>
      </div>
      <Textarea
        id="script-prompt"
        value={inputValue}
        onFocus={() => setIsTyping(true)}
        onBlur={() => setIsTyping(false)}
        onChange={(e) => {
          setInputValue(e.target.value);
          onChange(e.target.value);
        }}
        placeholder="Paste or write your code here"
        className="font-mono text-xs min-h-[120px] resize-y"
      />
    </div>
  );
};


