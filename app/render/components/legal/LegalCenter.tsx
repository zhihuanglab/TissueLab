'use client';

import { ArrowLeft } from 'lucide-react';
import { marked } from 'marked';
import Head from 'next/head';
import Link from 'next/link';
import React, { useEffect, useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/utils/common/twMerge';

/** TissueLab grid mark — same artwork as the app sidebar / homepage logo. */
function TissueLabLogo() {
  return (
    <Link href="/" className="flex items-center gap-2" aria-label="TissueLab home">
      <svg
        viewBox="0 0 176.68 176.68"
        width={26}
        height={26}
        className="object-contain"
        aria-hidden="true"
      >
        <g>
          <rect fill="rgb(215,217,219)" x="0" width="52.19" height="52.19" />
          <rect fill="rgb(215,217,219)" x="62.24" width="52.19" height="52.19" />
          <rect fill="rgb(215,217,219)" x="124.49" width="52.19" height="52.19" />
          <rect fill="#6352a2" x="0" y="62.24" width="52.19" height="52.19" />
          <rect fill="rgb(215,217,219)" x="62.24" y="62.24" width="52.19" height="52.19" />
          <rect fill="#6352a2" x="0" y="124.49" width="52.19" height="52.19" />
          <rect fill="#6352a2" x="62.24" y="124.49" width="52.19" height="52.19" />
          <rect fill="#6352a2" x="124.49" y="124.49" width="52.19" height="52.19" />
        </g>
      </svg>
      <span className="text-lg font-bold">
        <span className="text-foreground">Tissue</span>
        <span className="text-primary">Lab</span>
      </span>
    </Link>
  );
}

marked.setOptions({ breaks: true, gfm: true });

const markdownToHtml = (markdown: string): string => {
  try {
    return marked.parse(markdown) as string;
  } catch (error) {
    console.error('Error parsing legal markdown:', error);
    return markdown;
  }
};

/**
 * The legal documents shown on the single /legal page, in tab order.
 * Each `id` is the hash anchor that selects its tab (e.g. /legal#privacy).
 */
const LEGAL_DOCS = [
  { id: 'terms', file: 'terms-of-service.md', label: 'Terms of Service' },
  { id: 'privacy', file: 'privacy-policy.md', label: 'Privacy Policy' },
  { id: 'acceptable-use', file: 'acceptable-use-policy.md', label: 'Acceptable Use' },
  { id: 'cookies', file: 'cookie-notice.md', label: 'Cookie Notice' },
  { id: 'model-ip', file: 'model-and-ip-rider.md', label: 'Model & IP Rider' },
] as const;

type LoadedDoc = (typeof LEGAL_DOCS)[number] & { html: string };

const DOC_IDS = LEGAL_DOCS.map((d) => d.id) as readonly string[];

/** Shared prose styling for the rendered markdown body. */
const legalProseClasses = cn(
  'text-foreground/90',
  '[&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:mb-2 [&_h1]:mt-0 [&_h1]:text-foreground',
  '[&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mb-3 [&_h2]:mt-10 [&_h2]:text-foreground',
  '[&_h3]:text-base [&_h3]:font-semibold [&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-foreground',
  '[&_p]:mb-4 [&_p]:leading-7',
  '[&_strong]:font-semibold [&_strong]:text-foreground',
  '[&_em]:italic',
  '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 [&_a]:hover:text-primary/80',
  '[&_ul]:list-disc [&_ul]:ml-6 [&_ul]:mb-4 [&_ul]:space-y-1.5',
  '[&_ol]:list-decimal [&_ol]:ml-6 [&_ol]:mb-4 [&_ol]:space-y-1.5',
  '[&_li]:leading-7',
  '[&_hr]:my-8 [&_hr]:border-border',
  '[&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm [&_code]:font-mono',
  '[&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-4 [&_pre]:my-4 [&_pre]:overflow-x-auto',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs [&_pre_code]:leading-relaxed',
  '[&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted-foreground [&_blockquote]:my-4',
  '[&_table]:w-full [&_table]:border-collapse [&_table]:my-4 [&_table]:text-sm',
  '[&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:bg-muted [&_th]:font-semibold [&_th]:text-left',
  '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top'
);

export default function LegalCenter() {
  const [docs, setDocs] = useState<LoadedDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string>(LEGAL_DOCS[0].id);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load every legal markdown file in parallel.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all(
      LEGAL_DOCS.map((doc) =>
        fetch(`/legal/${doc.file}`)
          .then((res) => {
            if (!res.ok) throw new Error(`Failed to load ${doc.file}`);
            return res.text();
          })
          .then((text) => ({ ...doc, html: markdownToHtml(text) }))
      )
    )
      .then((loaded) => {
        if (!cancelled) setDocs(loaded);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError('These documents could not be loaded. Please try again later.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Sync the active tab with the URL hash (initial load + back/forward + in-page links).
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash.replace('#', '');
      if (hash && DOC_IDS.includes(hash)) setActiveId(hash);
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  const handleTabChange = (id: string) => {
    setActiveId(id);
    // Reflect the selection in the URL without adding a history entry or jumping.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${id}`);
    }
    scrollRef.current?.scrollTo({ top: 0 });
  };

  // Open external links in a new tab; keep cross-document links as in-page hashes.
  useEffect(() => {
    if (docs.length === 0) return;
    const container = document.getElementById(`legal-content-${activeId}`);
    if (!container) return;
    container.querySelectorAll('a').forEach((link) => {
      const href = link.getAttribute('href') || '';
      if (href.startsWith('http://') || href.startsWith('https://')) {
        link.setAttribute('target', '_blank');
        link.setAttribute('rel', 'noopener noreferrer');
      } else if (href.startsWith('/legal#')) {
        link.setAttribute('href', href.slice('/legal'.length));
      }
    });
  }, [docs, activeId]);

  return (
    <>
      <Head>
        <title>{`Legal — TissueLab`}</title>
        <meta
          name="description"
          content="Terms of Service, Privacy Policy, Acceptable Use Policy, Cookie Notice, and Model & IP Rider for the TissueLab platform."
        />
      </Head>

      <div
        ref={scrollRef}
        className="h-screen w-full select-text overflow-y-auto bg-background font-sans text-foreground"
      >
        {/* Header */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/80 backdrop-blur">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-5 py-4">
            <TissueLabLogo />
            <Link
              href="/"
              className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to app
            </Link>
          </div>
        </header>

        <div className="mx-auto max-w-4xl px-5 py-10">
          <div
            role="note"
            className="mb-8 rounded-lg border border-border bg-muted/40 px-5 py-4 text-sm leading-relaxed text-muted-foreground"
          >
            <span className="mb-2 inline-block rounded border border-border bg-background px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-foreground">
              Research Preview
            </span>
            <p>
              TissueLab is pre-release research software, provided <em>as is</em> for non-commercial
              research and evaluation only — <strong className="font-medium text-foreground">not a
              medical device</strong> and not for clinical or diagnostic use. A project of the Zhi
              Huang Lab at the Department of Pathology and Laboratory Medicine, Perelman School of
              Medicine, University of Pennsylvania, registered as an innovation with the Penn Center
              for Innovation (PCI).
            </p>
          </div>

          <div className="mb-8">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Legal</h1>
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
              The policies that govern your use of TissueLab.
            </p>
          </div>

          {loading && <div className="py-16 text-center text-muted-foreground">Loading…</div>}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
              {error}
            </div>
          )}

          {!loading && !error && (
            <Tabs value={activeId} onValueChange={handleTabChange} className="w-full">
              {/* Horizontal underline tabs on top */}
              <div className="sticky top-[57px] z-10 -mx-5 mb-8 bg-background/80 px-5 backdrop-blur">
                <div className="overflow-x-auto">
                  <TabsList className="h-auto w-full flex-nowrap justify-start gap-6 rounded-none border-b border-border bg-transparent p-0">
                    {LEGAL_DOCS.map((doc) => (
                      <TabsTrigger
                        key={doc.id}
                        value={doc.id}
                        className="whitespace-nowrap rounded-none border-b-2 border-transparent bg-transparent px-1 py-3 text-sm font-medium text-muted-foreground shadow-none transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
                      >
                        {doc.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
              </div>

              {docs.map((doc) => (
                <TabsContent key={doc.id} value={doc.id} className="mt-0 focus-visible:ring-0">
                  <article
                    id={`legal-content-${doc.id}`}
                    className={legalProseClasses}
                    dangerouslySetInnerHTML={{ __html: doc.html }}
                  />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </div>
      </div>
    </>
  );
}
