'use client';

import { motion, useAnimation } from 'framer-motion';
import { GraduationCap, Loader2, Mail } from 'lucide-react';
import Image from 'next/image';
import React from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { Button } from '../../ui/button';
import { Checkbox } from '../../ui/checkbox';
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
  isUPennPending: boolean;
  isEmailPending: boolean;
  onGoogleClick: () => void;
  onUPennClick: () => void;
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
  isUPennPending,
  isEmailPending,
  onGoogleClick,
  onUPennClick,
  onSendCode,
  signupModalContext,
  errorTip,
}: LeftPaneEmailProps) {
  // UPenn SSO uses a browser popup — desktop (Electron) is out of scope, so
  // only offer it on the web app.
  const isWeb = typeof window !== 'undefined' && !(window as any).electron;
  const [agreed, setAgreed] = React.useState(false);
  const consentControls = useAnimation();
  // Buttons stay enabled visually so users don't read the disabled
  // greys as "this site is broken". When they click without ticking
  // the box we shake the consent row + the highlighted card draws
  // their eye, rather than silently bouncing the click.
  const ensureConsent = React.useCallback(
    (run: () => void) => {
      if (!agreed) {
        consentControls.start({
          x: [0, -8, 8, -6, 6, -3, 3, 0],
          transition: { duration: 0.45 },
        });
        return;
      }
      run();
    },
    [agreed, consentControls]
  );
  const form = useForm<{ email: string }>({
    // Hand-written safeParse resolver instead of zodResolver: the installed
    // @hookform/resolvers (v3, zod-v3 era) mishandles zod v4's error shape and
    // rethrows the ZodError, which escaped as an unhandledrejection (raw issue
    // array). safeParse never throws, so validation stays inside the form.
    resolver: (async (values: { email: string }) => {
      const result = EmailSchema.safeParse(values);
      if (result.success) return { values: result.data, errors: {} };
      const errors: Record<string, { type: string; message: string }> = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? '');
        if (key && !errors[key]) {
          errors[key] = { type: issue.code ?? 'validation', message: issue.message };
        }
      }
      return { values: {}, errors };
    }) as Resolver<{ email: string }>,
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
          onClick={() => ensureConsent(onGoogleClick)}
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

        {isWeb && (
          <Button
            onClick={() => ensureConsent(onUPennClick)}
            variant="outline"
            className={`flex h-11 w-full items-center justify-center gap-3 rounded-md border-2 text-sm font-bold hover:shadow ${isUPennPending ? 'pointer-events-none opacity-70' : ''}`}
            disabled={isUPennPending}
          >
            {isUPennPending ? (
              <>
                <Loader2 className="animate-spin" size={16} />
                Processing...
              </>
            ) : (
              <>
                <GraduationCap className="mr-2 h-10 w-10" />
                Continue with UPenn
              </>
            )}
          </Button>
        )}

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
          <form
            onSubmit={form.handleSubmit(() => ensureConsent(onSendCode))}
            className="space-y-6"
          >
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

        {/* Terms — active consent. Buttons stay enabled visually so
            they don't read as "the site is broken"; clicking before
            ticking shakes this row (via `consentControls`) so the
            user notices what's missing. */}
        <motion.label
          animate={consentControls}
          className="mt-6 flex cursor-pointer items-start gap-2 text-xs text-muted-foreground"
        >
          <Checkbox
            checked={agreed}
            onCheckedChange={(v) => setAgreed(v === true)}
            className="mt-0.5"
            aria-label="I agree to the Terms of Service and Privacy Policy"
          />
          <span className="leading-5">
            I agree to the{' '}
            <a
              href="/legal#terms"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-blue-600"
            >
              Terms of Service
            </a>{' '}
            and{' '}
            <a
              href="/legal#privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-blue-600"
            >
              Privacy Policy
            </a>
            .
          </span>
        </motion.label>
      </div>
    </motion.div>
  );
}

