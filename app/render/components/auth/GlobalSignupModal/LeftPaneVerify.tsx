'use client';

import { motion } from 'framer-motion';
import { ArrowLeft, Loader2 } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import { Button } from '../../ui/button';

interface LeftPaneVerifyProps {
  email: string;
  verificationCode: string[];
  setVerificationCode: (codes: string[]) => void;
  isEmailPending: boolean;
  onVerifyCode: () => void;
  onResendCode: () => void;
  onBack: () => void;
}

export default function LeftPaneVerify({
  email,
  verificationCode,
  setVerificationCode,
  isEmailPending,
  onVerifyCode,
  onResendCode,
  onBack,
}: LeftPaneVerifyProps) {
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleInputChange = (index: number, value: string) => {
    // Only allow digits
    if (value && !/^\d$/.test(value)) return;

    const newCodes = [...verificationCode];
    newCodes[index] = value;
    setVerificationCode(newCodes);

    // Auto-advance to next input
    if (value && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !verificationCode[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pastedData = e.clipboardData.getData('text').slice(0, 6);
    if (/^\d+$/.test(pastedData)) {
      const newCodes = pastedData.split('').slice(0, 6);
      while (newCodes.length < 6) {
        newCodes.push('');
      }
      setVerificationCode(newCodes);
      // Focus the last filled input or the first empty one
      const nextIndex = Math.min(newCodes.length, 5);
      inputRefs.current[nextIndex]?.focus();
    }
  };

  // Focus first input on mount
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const isCodeComplete = verificationCode.every((code) => code !== '');

  return (
    <motion.div
      key="verify-pane"
      initial={{ opacity: 0, x: 30 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -30 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className="flex w-[21.25rem] flex-col gap-4 overflow-hidden p-6 justify-center items-center"
    >
      {/* Back button at top-left */}
      <Button
        onClick={onBack}
        variant="ghost"
        size="icon"
        className="absolute top-6 left-6 h-8 w-8 rounded-full z-10"
      >
        <ArrowLeft className="h-4 w-4" />
      </Button>

      <div className="flex flex-col gap-6 w-full items-center">
        {/* Title */}
        <div className="text-center space-y-2">
          <h2 className="text-2xl font-semibold text-foreground">
            You are almost there!
          </h2>
          <p className="text-sm text-muted-foreground leading-5">
            We sent a six-digit code to
          </p>
          <p className="text-sm text-muted-foreground leading-5">
            <span className="font-medium text-foreground">{email}</span>
          </p>
        </div>

        {/* 6-box input row */}
        <div className="flex gap-2 justify-center w-full">
          {Array.from({ length: 6 }).map((_, index) => (
            <input
              key={index}
              ref={(el) => {
                inputRefs.current[index] = el;
              }}
              type="text"
              inputMode="numeric"
              maxLength={1}
              value={verificationCode[index] || ''}
              onChange={(e) => handleInputChange(index, e.target.value)}
              onKeyDown={(e) => handleKeyDown(index, e)}
              onPaste={handlePaste}
              className="h-12 w-10 rounded-md border border-2 border-border bg-muted/60 text-center text-base font-semibold focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all"
            />
          ))}
        </div>

        {/* Verify code button */}
        <Button
          onClick={onVerifyCode}
          disabled={isEmailPending || !isCodeComplete}
          className="w-full h-11 rounded-md"
        >
          {isEmailPending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Verifying...
            </>
          ) : (
            'Verify code'
          )}
        </Button>

        {/* Resend link */}
        <div className="text-center">
          <Button
            variant="ghost"
            onClick={onResendCode}
            disabled={isEmailPending}
            className="text-sm text-muted-foreground hover:text-foreground font-medium h-auto p-0"
          >
            {isEmailPending ? 'Sending…' : "Didn't receive the code? Resend"}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

