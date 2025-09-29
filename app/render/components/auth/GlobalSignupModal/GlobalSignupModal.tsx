'use client';

import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '../../ui/form';
import React, { useState, useEffect } from 'react';
import { Button } from '../../ui/button';
import Image from 'next/image';
import { zodResolver } from '@hookform/resolvers/zod';
import { Input } from '../../ui/input';
import useGlobalSignup from '../../../hooks/useGlobalSignup';
import { useForm } from 'react-hook-form';
import * as z from 'zod';
import { ChevronLeft, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useInterval } from 'react-use';
import ImageComparisonSlider from '../../assets/ImageComparisonSlider';
import { motion, AnimatePresence } from 'framer-motion';
import { useSignupModal } from '../../../store/zustand/store';
import Link from 'next/link';
let curEmail: string;

interface GlobalSignLoginModalProps {
  asChild?: boolean;
  children?: React.ReactNode;
  // new prop, control whether to prevent default behavior when clicking outside the dialog, default is true
  preventInteractOutside?: boolean;
  customClassName?: string;
}

export const EmailSchema = z.object({
  email: z
    .string()
    .trim()
    .email({ message: 'Please enter a valid email address' })
    .transform((val) => val.trim()),
});

export const CodeSchema = z.object({
  code: z
    .string()
    .trim()
    .length(6, 'code must be 6 characters')
    .transform((val) => val.trim()),
});

export const ProfileSchema = z.object({
  preferred_name: z
    .string()
    .trim()
    .max(50, 'Preferred name must be 50 characters or less')
    .optional()
    .transform((val) => val?.trim() || null),
  custom_title: z
    .string()
    .trim()
    .max(50, 'Title must be 50 characters or less')
    .optional()
    .transform((val) => val?.trim() || null),
  organization: z
    .string()
    .trim()
    .max(100, 'Organization must be 100 characters or less')
    .optional()
    .transform((val) => val?.trim() || null),
});

const GlobalSignupModal = ({
  asChild,
  children,
  preventInteractOutside = true,
  customClassName,
}: GlobalSignLoginModalProps) => {
  const isSignupModalOpen = useSignupModal((s) => s.isSignupModalOpen);
  const setSignupModalOpen = useSignupModal((s) => s.setSignupModalOpen);
  const signupModalContext = useSignupModal((s) => s.signupModalContext);
  const {
    loginViaGoogle,
  } = useGlobalSignup({
    setModalVisible: setSignupModalOpen,
    signupSuccess: signupModalContext?.signupSuccess,
  });
  const [isGooglePending, setIsGooglePending] = useState(false);
  const handleGoogleClick = async () => {
    if (isGooglePending) return;
    try {
      setIsGooglePending(true);
      await loginViaGoogle();
      // If successful, keep the button disabled until modal closes (onAuthStateChanged handles this)
      // Don't reset the state here on success to prevent multiple login attempts
    } catch (error: any) {
      // Reset immediately on error/cancellation to allow retry
      console.log('Google login error:', error?.code || error);
      setIsGooglePending(false);
      
      // Handle specific error cases
      if (error?.code === 'auth/popup-closed-by-user' || 
          error?.code === 'auth/cancelled-popup-request' ||
          error?.code === 'auth/popup-blocked') {
        console.log('User cancelled or blocked Google login popup');
        // Allow immediate retry for user cancellation
        return;
      }
      
      // For other errors, show error message if needed
      console.warn('Google login failed:', error);
    }
    // Note: We don't use finally block anymore to have precise control over state reset
  };

  const [errorTip, setErrorTip] = useState('');
  const [step, setStep] = useState<'email'>('email');

  // Reset Google pending state when modal closes
  useEffect(() => {
    if (!isSignupModalOpen) {
      setIsGooglePending(false);
      setErrorTip('');
      setStep('email');
    }
  }, [isSignupModalOpen]);

  const getSchemaForStep = () => EmailSchema;

  const getDefaultValuesForStep = () => ({ email: '' });

  const form = useForm<any>({
    resolver: zodResolver(getSchemaForStep() as any),
    defaultValues: getDefaultValuesForStep(),
  });


  // Email flow removed; keep stub for potential future use
  const handleSubmit = async (
    values: z.infer<typeof EmailSchema>
  ) => {
    setErrorTip('');
    // No-op: email flow disabled
  };

  // countdown logic
  // Countdown removed with email flow

  useEffect(() => {
    form.reset({ ...form.getValues() });
    form.clearErrors();
    setErrorTip('');
  }, [step, form]);

  useEffect(() => {
    if (!isSignupModalOpen) {
      form.reset({ email: '' });
      form.clearErrors();
      setStep('email');
      setErrorTip('');
    }
  }, [form, isSignupModalOpen]);

  return (
    <Dialog open={isSignupModalOpen} onOpenChange={setSignupModalOpen}>
      {children && <DialogTrigger asChild={asChild}>{children}</DialogTrigger>}
      {isSignupModalOpen && (
        <DialogContent
          className={`flex w-[21.25rem] max-w-full flex-row gap-x-0 gap-y-4 overflow-hidden rounded-lg border-none p-0 lg:w-[48rem] ${customClassName}`}
          /* TODO: Centered version without side image - for future use */
          /* className={`flex w-[21.25rem] max-w-full flex-col gap-x-0 gap-y-4 overflow-hidden rounded-lg border-none p-0 items-center justify-center ${customClassName}`} */
          onInteractOutside={(e) => {
            if (preventInteractOutside) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <AnimatePresence initial={false} mode='wait'>
            <motion.div
              key={step}
              initial={{
                x: step === 'email' ? -30 : 30,
                opacity: 0,
              }}
              animate={{
                x: 0,
                opacity: 1,
                transition: {
                  duration: 0.25,
                  ease: [0.4, 0, 0.2, 1],
                },
              }}
              exit={{
                x: step === 'email' ? -30 : 30,
                opacity: 0,
                transition: {
                  duration: 0.25,
                  ease: [0.4, 0, 1, 1],
                },
              }}
              transition={{ type: 'tween', duration: 0.2 }}
              className='flex w-[21.25rem] flex-col gap-4 overflow-hidden p-6 justify-center items-center'
              /* TODO: Original positioning - for later adjustment */
              /* className='flex w-[21.25rem] flex-col gap-4 overflow-hidden p-6' */
            >
              {/* Close button in top right */}
              <button
                className='absolute top-2 right-2 h-8 w-8 rounded-full p-0 z-10 bg-white shadow-sm hover:bg-gray-100 hover:shadow-md transition-all flex items-center justify-center border-0 cursor-pointer'
                onClick={() => setSignupModalOpen(false)}
              >
                <X className='h-4 w-4 text-gray-500 hover:text-gray-800' />
              </button>

              <DialogHeader>
                <DialogTitle className='flex flex-row items-center'>
                  {/* Back button removed with email-only step */}
                  <span className='text-2xl font-semibold'>Continue to TissueLab</span>
                </DialogTitle>
              </DialogHeader>
              {step === 'email' ? (
                <DialogDescription className='text-sm leading-5 text-gray-600'>
                  {signupModalContext?.description ||
                    'Sign up or log in to continue.'}
                </DialogDescription>
              ) : null}
              {step === 'email' ? (
                <div className='flex flex-col gap-3'>
                  {errorTip && step === 'email' ? (
                    <div className='rounded-lg bg-[#f8d8d9] px-3 py-1 text-xs'>
                      {errorTip}
                    </div>
                  ) : null}

                  <Button
                    onClick={handleGoogleClick}
                    variant='outline'
                    className={`flex h-11 w-full items-center justify-center gap-3 rounded-xl border-2 text-sm font-bold hover:shadow ${isGooglePending ? 'pointer-events-none opacity-70' : ''}`}
                    disabled={isGooglePending}
                  >
                    <Image
                      src='https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg'
                      width={24}
                      height={24}
                      alt='Google'
                      className='h-6 w-6 pr-2'
                    />
                    {isGooglePending ? (
                      <>
                        <Loader2 className='animate-spin' size={16} />
                        Processing...
                      </>
                    ) : (
                      'Continue with Google'
                    )}
                  </Button>

                  {/* Email login removed */}

                  {/* Terms */}
                  <p className='mt-6 text-xs text-neutral-500'>
                    By continuing up, you agree to our{' '}
                    <a 
                      href='https://tissuelab.org/' 
                      target='_blank' 
                      rel='noopener noreferrer'
                      className='underline hover:text-blue-600'
                    >
                      Terms of Service
                    </a>{' '}
                    and our{' '}
                    <a 
                      href='https://tissuelab.org/' 
                      target='_blank' 
                      rel='noopener noreferrer'
                      className='underline hover:text-blue-600'
                    >
                      Privacy Policy
                    </a>
                    .
                  </p>
                </div>
              ) : null}
            </motion.div>
          </AnimatePresence>
          <div className='hidden flex-1 lg:block'>
            {/* TODO: replace with Cloudflare image to support CDN (https://imagedelivery.net) */}
            <ImageComparisonSlider
              customClassName='rounded-l-none rounded-right-lg'
              afterImage='/images/login-after.png'
              beforeImage='/images/login-before.png'
              beforePlaceholder='blur'
              beforeBlurDataURL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAABCRJREFUWEeVV9lyFEEM6+7J/+YgKQqK8z1Asjl2v3aGsiXZ7smGKoDQ7JCMZUk+up9+HrfeW2u9t25fo7Ux7Oxx2r8b/rTWtrb5sbWtfOkz/hPf6e/rw9+Fc7QRn+2FvfUZQCuBRxsDnwXM34oIZ4MboP8C0AQAcKfsHa0zoUwiMbDgwWYW7BHxkYFBFuw9yj6fgYEfkgCBkv7R+gIpTCLQ+Q8JVoIhSd01E3uQYAwG5+l5n76/Th5wAIsBgXYCBJ9ABE/TCbCga9sYXM/CAwLh2YMFyIkTAL69BTA889Fwdv4wo9vhXDcGXgHEQdCcwmrB7PcusHxlQPvp68vmr45ACOwMFCZSgvcZkAmJLyshALAaKI0TdPpCAFX/xUBAs5CA1fBGAs88ZRAL+D6Wbym9qCoYq/XT5+cNUklvBhcAP2km6sY6zFLcgaBFYJnIVoYu73IGPj2hdTgAox0AlgIgSvIcALl/3bGgelQluInVlFRRxsDHw+ZmoOOd9mWBBEWKoE6lUHuAgTAAYUaYNH6phCuTfNZPd4ciQQlKEIudLEkYkdUgAB68+CD6QQGhYNI9Wntv/Xj76FXgGXr2Rr8xsEAGscH6pbWy5JT1urZVQNiSOTUAmj7Lk8+ONw+bMkv9IYGAqCJmBtiIJvqrD8SAKcxJNjGBVPrx+s8mp0rzZABMvAcgZgFBBAP2WaVgZwCA2VGdYuDKALAKgnKjf2nLhYIXH2Q/Rjsu+q+lEhzcNJnYFgRG4/r18vdZCZyFCwBBQ8I8TxNyJLgHUAEVgHfFCkDmKV7wRwbA/+FlKNMhe0jBZ2qnVssaSTKbGbCYUYtKLC/NSJYP1CApwcvlrw0D41wVZDXEPBeF9Fit/akXaGfQ9IyuSPT0QTcA0Qmj+zH7IgG6oSSovaBsR2pGWlYmI5bZIDmMjOfL+5kByqAekI2oAIhmhOBvN6OyMRUG8GN1vyQAVIEm377+axlqncoUQu/9euZTu/QCMS/wWi+erowBrlykuRrP+0BUAVuxLxr0uC9HdUNi9u4BTQOvdE5obkL6aADUBzQR0XgycwOBzcg31GgmYtcrPrYhBdaGPA+mqAYBOFyDAXsxlg8tIrmUhAG536uT5avLXYHU4+4Qf5X2pVFMQg4391EFWBjZDziYMjgWy5mB6aoSF5aMDYhBP7o/I+N5P3wAAPvktxZOPWND3S/GscpQ3cySLG+vu2B0QdKU3xYQEPbxlgxMRtQen5LEJqvdcOfmJFtu4+nrjpKuMPgsAMTlI9fovBuIGUpgC0Vtrbo1Vq5L4JRhl70zcEcJggG4PC6RkoL+qEsmRCz3hUi+InnLQK/LUgCoDMiM+3Xab6t0MQ0JEMVqWfB4fEaCyZQPd/e4momB6T6nSyWqAxfYXSWU+R5s7DQPD9CxFcBf33GD2EwX+aYAAAAASUVORK5CYII='
              afterPlaceholder='blur'
              afterBlurDataURL='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAABCpJREFUWEeVV9luG0EMm5nt/+ZGW/R4bXqnTZzzX72FRFLSbBwUcWJ4fYqiKErTnz7v1tab/bc+ermPvPY39aG12W1d1+Z/9sh7a6v/49Zb77oPvx7DHnEd99cAMAxrPwygBYjDAIYFPQzgZgVaS3LDwEKkA++BJmRvqW4Z8JeDAn7XfnuM5gAse2NZLNjPPX26QQmAoI0owyjXGRz5WWiWgaUIBlgFw2q/B6oJwBk4BCA+3FCn0dtYigYcNUEEgLn+zoqDyVsPHTAwARgbDs7+Hj9er4HWAgtAPGZZqK2XRfgfHaQQBaC1/vjh2kGr/iiB0T/aMA0QCKiDBtQFon1d96UbCgX8XS/tpH4TFWM+vv8bGnDqGbwv0IAYgXgYnURnC+7buq/tWEGUlgsN1BK8+4MucKUja2QPFgBE4kkGvOWd8pI9QbhIwStZe+4J8J7e+sPbqzXEQvEFgGWZWQgG2AkU3l7Z7wEGJSpilOiKAaFDWusPF1dRAtHv2S+jLQ7AWMgayjVD9RTensGtFNtukOL90UrJH3FdPZz/Blml/gCwtIWPACYN2NfZbrJhC75f296eO5D0ChYiRCdvwAvGwNkvAkjRIfgCHZAFAQghwomgAZYgWFA7qgwsncwuPaW3fn/6MzVAwVlwZa8yAICJMWvrZZgyFwPoiJhNMJowMyRBBu5PfnAWwP2MbmQPFqIMGiZ0Tec5SpBMQJBZBk0H1T31gET6/bEBqBpg0DcEMFiKmGRoH7Uaam6Zz+XIEV29OR1QVPa7o+8rusS837KXAFMHi4EoJhJ2VL3AAAjMtCPMpgQnpT/Y1d3RNxpRuiCozzJEexoI9SGbPbN/DYAEQQDwZRgQsp1AyJ7FApPCWlCm4gsMRDNomoWQe+u3R1+LE6YI1YZOvwypOlkwsLHkaSbIkqsrInvdHACEnSXwDmBg18RWA6UXp52wsvFsNBcQpYz99uhylTvZouDBGDQ9gAMpSsDlxFudPT8tqFzb6kCYpzQ7qbV+e3yZ+4BNw9gFjAVmb9sR36suht/M9Sz0QAfSYAq6JxBoZgDQaLR54O1ILyAALSh1nVYfawnLKYhlFStDXdNpPFsQu5PLWMm0OhuIWExYf21K8nMIGoYkt0PgXNsjljd61UC53p1+KWt5bq8CYWxk8DxUaEVX8CxG7VFdz9lPYByAb6jc0aLWEp7Kkjs9P5xpaU+sKdeFpKBU8HjcnRkDDO6rmaZermLYC5G9loo4qrGlohDz2hjU80CVzwm2784JAGsq/EAbLAeQRnGL8wGAytf9tFR5nayGH6MO4mN6LgBxUKinmcIGAiowZ7u95vRJkJvIeovlCNrLczCgCTWdaHWYnM90lQX/3gRCaJ7JAxg3QPzTuwuUIA6orR6fy2FSDJgOeA1GDmSvFUyEVPo3LfkPNph4XynjZ/YAAAAASUVORK5CYII='
              width={356}
              height={400}
            />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
};

export default GlobalSignupModal;