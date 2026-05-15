'use client';

import { AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import * as z from 'zod';
import { getApiResponseErrorMessage, getErrorMessage } from '@/utils/common/apiResponse';
import { initUserAssetsEndpoint, sendCodeEndpoint, verifyCodeEndpoint } from '../../../config/endpoints';
import useGlobalSignup from '../../../hooks/useGlobalSignup';
import { useSignupModal } from '../../../store/zustand/store';
import ImageComparisonSlider from '../../assets/ImageComparisonSlider';
import {
  Dialog,
  DialogContent,
  DialogTrigger
} from '../../ui/dialog';
import LeftPaneEmail from './LeftPaneEmail';
import LeftPaneVerify from './LeftPaneVerify';
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
  const [isEmailPending, setIsEmailPending] = useState(false);
  const [emailStep, setEmailStep] = useState<'email' | 'verify'>('email');
  const [email, setEmail] = useState('');
  const [verificationCode, setVerificationCode] = useState<string[]>(Array(6).fill(''));
  
  const handleGoogleClick = async () => {
    if (isGooglePending) return;
    try {
      setIsGooglePending(true);
      await loginViaGoogle();
      // loginViaGoogle handles modal closing and signupSuccess callback internally
      // onAuthStateChanged will also trigger to update global user state
      // Reset pending state to allow UI to update immediately
      setIsGooglePending(false);
      // Modal will be closed by loginViaGoogle or onAuthStateChanged
    } catch (error: any) {
      console.log('Google login error:', error?.code || error);

      // recover pending on popup errors
      if (
        error?.code === 'auth/popup-closed-by-user' ||
        error?.code === 'auth/cancelled-popup-request' ||
        error?.code === 'auth/popup-blocked'
      ) {
        setIsGooglePending(false);
        return;
      }

      // reset pending for all other errors
      setIsGooglePending(false);
    }
  };

  const handleSendCode = async () => {
    if (isEmailPending) return;
    try {
      setIsEmailPending(true);
      
      const response = await fetch(sendCodeEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });
      
      const result = await response.json();
      
      const backendMessage = getApiResponseErrorMessage(result);
      if (result.success) {
        toast.success('Verification code sent to your email');
        setEmailStep('verify');
      } else {
        toast.error(backendMessage || result.message || 'Failed to send verification code');
      }
    } catch (error) {
      console.error('Send code error:', error);
      toast.error(getErrorMessage(error, 'Failed to send verification code'));
    } finally {
      setIsEmailPending(false);
    }
  };

  const handleVerifyCode = async () => {
    if (isEmailPending) return;
    const codeString = verificationCode.join('');
    if (codeString.length !== 6) return;
    
    try {
      setIsEmailPending(true);
      
      const response = await fetch(verifyCodeEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          email, 
          code: codeString 
        }),
      });
      
      const result = await response.json();
      
      const backendMessage = getApiResponseErrorMessage(result);
      if (result.success && result.user?.custom_token) {
        // Use Firebase custom token to sign in
        const { getAuth, signInWithCustomToken } = await import('firebase/auth');
        const { app } = await import('../../../config/firebaseConfig');
        
        const auth = getAuth(app);
        const userCredential = await signInWithCustomToken(auth, result.user.custom_token);
        
        // Get ID token for backend API calls
        const idToken = await userCredential.user.getIdToken();
        
        // Call /v1/me to create user data
        const meResponse = await fetch(initUserAssetsEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${idToken}`,
          },
        });
        
        if (meResponse.ok) {
          toast.success('Email verification successful');
          setSignupModalOpen(false);
        } else {
          console.error('Failed to create user data');
          toast.error('Login successful but failed to initialize user data');
        }
      } else {
        toast.error(backendMessage || result.message || 'Invalid verification code');
      }
    } catch (error) {
      console.error('Verify code error:', error);
      toast.error(getErrorMessage(error, 'Failed to verify code'));
    } finally {
      setIsEmailPending(false);
    }
  };

  const handleResendCode = async () => {
    if (isEmailPending) return;
    try {
      setIsEmailPending(true);
      
      const response = await fetch(sendCodeEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email }),
      });
      
      const result = await response.json();
      
      const backendMessage = getApiResponseErrorMessage(result);
      if (result.success) {
        toast.success('New verification code sent to your email');
      } else {
        toast.error(backendMessage || result.message || 'Failed to resend verification code');
      }
    } catch (error) {
      console.error('Resend code error:', error);
      toast.error(getErrorMessage(error, 'Failed to resend verification code'));
    } finally {
      setIsEmailPending(false);
    }
  };
  
  const [errorTip, setErrorTip] = useState('');

  // Reset states when modal closes
  useEffect(() => {
    if (!isSignupModalOpen) {
      setIsGooglePending(false);
      setIsEmailPending(false);
      setEmailStep('email');
      setEmail('');
      setVerificationCode(Array(6).fill(''));
      setErrorTip('');
    }
  }, [isSignupModalOpen]);

  return (
    <Dialog open={isSignupModalOpen} onOpenChange={setSignupModalOpen}>
      {children && <DialogTrigger asChild={asChild}>{children}</DialogTrigger>}
      {isSignupModalOpen && (
        <DialogContent
          className={`flex w-[21.25rem] max-w-full flex-row gap-x-0 gap-y-4 overflow-hidden rounded-lg border-text-foreground/50 p-0 lg:w-[48rem]  ${customClassName}`}
          /* TODO: Centered version without side image - for future use */
          /* className={`flex w-[21.25rem] max-w-full flex-col gap-x-0 gap-y-4 overflow-hidden rounded-lg border-none p-0 items-center justify-center ${customClassName}`} */
          onInteractOutside={(e) => {
            if (preventInteractOutside) e.preventDefault();
          }}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          {/* Close button in top right - always visible */}
          <button
            className="absolute top-2 right-2 h-8 w-8 rounded-full p-0 z-10 bg-card/20 shadow-sm hover:bg-card/20 hover:shadow-md transition-all flex items-center justify-center border-0 cursor-pointer"
            onClick={() => setSignupModalOpen(false)}
          >
            <X className="h-4 w-4 text-foreground/80 hover:text-foreground" />
          </button>

          <AnimatePresence initial={false} mode="wait">
            {emailStep === 'email' ? (
              <LeftPaneEmail
                key="email-pane"
                email={email}
                setEmail={setEmail}
                isGooglePending={isGooglePending}
                isEmailPending={isEmailPending}
                onGoogleClick={handleGoogleClick}
                onSendCode={handleSendCode}
                signupModalContext={signupModalContext}
                errorTip={errorTip}
              />
            ) : (
              <LeftPaneVerify
                key="verify-pane"
                email={email}
                verificationCode={verificationCode}
                setVerificationCode={setVerificationCode}
                isEmailPending={isEmailPending}
                onVerifyCode={handleVerifyCode}
                onResendCode={handleResendCode}
                onBack={() => setEmailStep('email')}
              />
            )}
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
