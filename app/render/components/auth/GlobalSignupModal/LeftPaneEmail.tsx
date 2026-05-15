'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { motion } from 'framer-motion';
import { Loader2, Mail } from 'lucide-react';
import Image from 'next/image';
import React from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '../../ui/button';
import {
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
import { Input } from '../../ui/input';
import { EmailSchema } from './GlobalSignupModal';

interface LeftPaneEmailProps {
  email: string;
  setEmail: (email: string) => void;
  isGooglePending: boolean;
  isEmailPending: boolean;
  onGoogleClick: () => void;
  onSendCode: () => void;
  signupModalContext?: {
    description?: string;
  } | null;
  errorTip?: string;
}

export default function LeftPaneEmail({
  email,
  setEmail,
  isGooglePending,
  isEmailPending,
  onGoogleClick,
  onSendCode,
  signupModalContext,
  errorTip,
}: LeftPaneEmailProps) {
  const form = useForm({
    resolver: zodResolver(EmailSchema),
    defaultValues: { email: '' },
  });

  React.useEffect(() => {
    form.setValue('email', email);
  }, [email, form]);

  return (
    <motion.div
      key="email-pane"
      initial={{ opacity: 0, x: -30 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: 30 }}
      transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
      className="flex w-[21.25rem] flex-col gap-4 overflow-hidden p-6 justify-center items-center"
    >
      <DialogHeader>
        <DialogTitle className="flex flex-row items-center">
          <span className="text-2xl font-semibold">Continue to TissueLab</span>
        </DialogTitle>
      </DialogHeader>
      <DialogDescription className="text-sm leading-5 text-muted-foreground">
        {signupModalContext?.description || 'Sign up or log in to continue.'}
      </DialogDescription>
      <div className="flex flex-col gap-3 w-full">
        {errorTip && (
          <div className="rounded-lg bg-[#f8d8d9] px-3 py-1 text-xs">
            {errorTip}
          </div>
        )}

        <Button
          onClick={onGoogleClick}
          variant="outline"
          className={`flex h-11 w-full items-center justify-center gap-3 rounded-md border-2 text-sm font-bold hover:shadow ${isGooglePending ? 'pointer-events-none opacity-70' : ''}`}
          disabled={isGooglePending}
        >
          <Image
            src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg"
            width={24}
            height={24}
            alt="Google"
            className="h-6 w-6 pr-2"
          />
          {isGooglePending ? (
            <>
              <Loader2 className="animate-spin" size={16} />
              Processing...
            </>
          ) : (
            'Continue with Google'
          )}
        </Button>

        {/* Email Login Form */}
        <div className="w-full">
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-3 text-muted-foreground font-medium">
                Or continue with email
              </span>
            </div>
          </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSendCode)} className="space-y-6">
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium text-foreground">
                      Email address
                    </FormLabel>
                    <FormControl>
                      <div className="relative">
                        <Input
                          placeholder="Enter your email"
                          className="h-11 border-border focus:border-blue-500 focus:ring-blue-500 !px-0 !pl-12 !pr-2"
                          {...field}
                          onChange={(e) => {
                            field.onChange(e);
                            setEmail(e.target.value);
                          }}
                        />
                      </div>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 rounded-md"
              disabled={isEmailPending}
            >
              {isEmailPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending code...
                </>
              ) : (
                <>
                  <Mail className="mr-2 h-4 w-4" />
                  Send verification code
                </>
              )}
            </Button>
          </form>
        </Form>

        {/* Terms */}
        <p className="mt-6 text-xs text-muted-foreground">
          By continuing up, you agree to our{' '}
          <a
            href="https://tissuelab.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-blue-600"
          >
            Terms of Service
          </a>{' '}
          and our{' '}
          <a
            href="https://tissuelab.org/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-blue-600"
          >
            Privacy Policy
          </a>
          .
        </p>
      </div>
    </motion.div>
  );
}

