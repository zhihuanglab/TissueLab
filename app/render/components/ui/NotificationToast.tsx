"use client";

import React, { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { X, CheckCircle, AlertTriangle, XCircle } from "lucide-react";

type ToastVariant = 'success' | 'warning' | 'error';

interface NotificationToastProps {
  isVisible: boolean;
  title: string;
  message: string;
  onDismiss: () => void;
  autoHideDuration?: number;
  variant?: ToastVariant;
}

export const NotificationToast: React.FC<NotificationToastProps> = ({
  isVisible,
  title,
  message,
  onDismiss,
  autoHideDuration = 5000,
  variant = 'success',
}) => {
  const [timeLeft, setTimeLeft] = useState(autoHideDuration / 1000);
  const [isAnimatingOut, setIsAnimatingOut] = useState(false);

  useEffect(() => {
    if (!isVisible) {
      setTimeLeft(autoHideDuration / 1000);
      setIsAnimatingOut(false);
      return;
    }
    setTimeLeft(autoHideDuration / 1000);
    setIsAnimatingOut(false);
    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          setIsAnimatingOut(true);
          setTimeout(onDismiss, 200);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isVisible, autoHideDuration, onDismiss]);

  const handleDismiss = () => {
    setIsAnimatingOut(true);
    // Clear running timer immediately to prevent auto-hide re-invoking
    try { setTimeLeft(0); } catch {}
    setTimeout(onDismiss, 200);
  };

  if (!isVisible) return null;

  const variantStyles: Record<ToastVariant, { container: string; title: string; text: string; bar: string; Icon: React.ComponentType<any> }> = {
    success: {
      container: 'bg-green-50 border-green-200',
      title: 'text-green-800',
      text: 'text-green-700',
      bar: 'bg-green-500',
      Icon: CheckCircle,
    },
    warning: {
      container: 'bg-yellow-50 border-yellow-200',
      title: 'text-yellow-800',
      text: 'text-yellow-700',
      bar: 'bg-yellow-500',
      Icon: AlertTriangle,
    },
    error: {
      container: 'bg-red-50 border-red-200',
      title: 'text-red-800',
      text: 'text-red-700',
      bar: 'bg-red-500',
      Icon: XCircle,
    },
  };

  const { container, title: titleCls, text, bar, Icon } = variantStyles[variant];

  const toastNode = (
    <>
      {/* Transparent overlay to capture clicks and close toast when clicked */}
      <div
        className="fixed inset-0 z-[9998] bg-transparent"
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onClick={(e) => { 
          e.stopPropagation(); 
          e.preventDefault(); 
          handleDismiss(); 
        }}
      />
      <div
        onMouseDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => { e.stopPropagation(); }}
        className={`
        fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[9999] pointer-events-auto
        border rounded-lg shadow-lg p-4 ${container}
        transition-all duration-300 ease-in-out
        ${isAnimatingOut ? 'opacity-0 scale-95' : 'opacity-100 scale-100'}
        max-w-md min-w-80
      `} role="alertdialog" aria-live="assertive">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <Icon className={`h-5 w-5 ${variant === 'success' ? 'text-green-600' : variant === 'warning' ? 'text-yellow-600' : 'text-red-600'}`} />
        </div>
        <div className="flex-1">
          <div className={`font-semibold mb-1 ${titleCls}`}>{title}</div>
          <div className={`text-sm whitespace-pre-line ${text}`}>{message}</div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 w-6 p-0 text-gray-400 hover:text-gray-600 flex-shrink-0"
          onClick={(e) => { e.stopPropagation(); handleDismiss(); }}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-3 w-full bg-green-100 rounded-full h-1">
        <div
          className={`h-1 rounded-full transition-all duration-1000 ease-linear ${bar}`}
          style={{ width: `${(timeLeft / (autoHideDuration / 1000)) * 100}%` }}
        />
      </div>
    </div>
    </>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(toastNode, document.body);
  }
  return toastNode;
};

export default NotificationToast;


