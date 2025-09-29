import React from 'react';
import { X } from 'lucide-react';
import { cn } from '@/utils/twMerge';

interface CloseButtonProps {
  onClose: () => void;
  className?: string;
}

const CloseButton: React.FC<CloseButtonProps> = ({ onClose, className }) => (
  <button
    onClick={onClose}
    className={cn(
      'absolute right-2 top-2 rounded-md bg-white p-1 text-gray-800 duration-200 hover:bg-gray-100',
      className
    )}
  >
    <X size={20} />
  </button>
);

export default CloseButton;