import { usePathWriteAccess } from "@/hooks/usePathWriteAccess"
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { AlertTriangle, CheckCircle2, FileArchive, Folder, Loader2, Upload } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { RootState } from '@/store';
import {
  uploadZarrStaging,
  deleteZarrStaging,
  validateZarrReplacement,
  replaceZarr,
  type ZarrReplacementValidation,
} from '@/services/data.service';
import { getErrorMessage } from '@/utils/common/apiResponse';

/** `users/<uid>` prefix of a storage path (the caller's own root, where staging is
 *  allowed). Replaces only work on the user's own slide, so this equals the caller. */
function userRootOf(slidePath: string | null): string | null {
  if (!slidePath) return null;
  const parts = slidePath.replace(/^\/+/, '').split('/');
  if (parts[0] === 'users' && parts[1]) return `users/${parts[1]}`;
  return null;
}

interface ZarrReplaceDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** The slide whose sidecar .zarr will be replaced (used for dims + target). */
  targetSlidePath: string | null;
  /** Called after a successful replace so the parent can reload the slide + refresh. */
  onReplaced: () => void;
}

type Picked = { files: File[]; relativePaths: string[]; label: string };

/** Recursively enumerate a dropped directory into {file, relativePath}. */
async function readDirectory(
  dirEntry: FileSystemDirectoryEntry,
  prefix: string
): Promise<{ file: File; relativePath: string }[]> {
  const reader = dirEntry.createReader();
  const out: { file: File; relativePath: string }[] = [];
  const readBatch = () =>
    new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
  let batch = await readBatch();
  while (batch.length) {
    for (const entry of batch) {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) =>
          (entry as FileSystemFileEntry).file(res, rej)
        );
        out.push({ file, relativePath: `${prefix}/${file.name}` });
      } else if (entry.isDirectory) {
        out.push(...(await readDirectory(entry as FileSystemDirectoryEntry, `${prefix}/${entry.name}`)));
      }
    }
    batch = await readBatch();
  }
  return out;
}

/** Turn a drop (a .zip file, or a .zarr folder) into files + relative paths. */
async function pickFromDrop(e: React.DragEvent): Promise<Picked | null> {
  const items = e.dataTransfer.items;
  if (!items || items.length === 0) return null;
  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = items[i].webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  // A single dropped .zip → upload as a zip.
  if (entries.length === 1 && entries[0].isFile && entries[0].name.toLowerCase().endsWith('.zip')) {
    const file = await new Promise<File>((res, rej) => (entries[0] as FileSystemFileEntry).file(res, rej));
    return { files: [file], relativePaths: [file.name], label: file.name };
  }
  const gathered: { file: File; relativePath: string }[] = [];
  let rootLabel = '';
  for (const entry of entries) {
    if (entry.isDirectory) {
      rootLabel = entry.name;
      gathered.push(...(await readDirectory(entry as FileSystemDirectoryEntry, entry.name)));
    } else if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      gathered.push({ file, relativePath: file.name });
    }
  }
  const files = gathered.filter((g) => g.file.size > 0);
  if (files.length === 0) return null;
  return {
    files: files.map((g) => g.file),
    relativePaths: files.map((g) => g.relativePath),
    label: rootLabel || `${files.length} files`,
  };
}

const ZarrReplaceDialog: React.FC<ZarrReplaceDialogProps> = ({
  isOpen,
  onClose,
  targetSlidePath,
  onReplaced,
}) => {
  const { allowed: pathWritable, tooltip: writeBlockTitle } = usePathWriteAccess(targetSlidePath);

  const [picked, setPicked] = useState<Picked | null>(null);
  const [stagingRel, setStagingRel] = useState<string | null>(null);
  const [validation, setValidation] = useState<ZarrReplacementValidation | null>(null);
  const [busy, setBusy] = useState<'staging' | 'validate' | 'replace' | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Slide dimensions come from the viewer — no slide reader needed on the backend.
  const slideDims = useSelector((s: RootState) => s.svsPath.slideInfo?.dimensions ?? null);

  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipInputRef = useRef<HTMLInputElement>(null);
  const stagingRelRef = useRef<string | null>(null);
  stagingRelRef.current = stagingRel;

  const resetAll = useCallback(() => {
    setPicked(null);
    setStagingRel(null);
    setValidation(null);
    setError(null);
    setAcknowledged(false);
    setBusy(null);
  }, []);

  // Clean up any staging folder when the dialog goes away.
  useEffect(() => {
    if (!isOpen) {
      if (stagingRelRef.current) deleteZarrStaging(stagingRelRef.current);
      resetAll();
    }
  }, [isOpen, resetAll]);

  // Upload → stage → validate, as soon as something is picked.
  const ingest = useCallback(
    async (p: Picked) => {
      if (!targetSlidePath) return;
      if (!pathWritable) return;
      const userRoot = userRootOf(targetSlidePath);
      if (!userRoot) {
        setError('Can only replace preprocessing for a slide in your own workspace.');
        return;
      }
      // Drop any previous staging first.
      if (stagingRelRef.current) deleteZarrStaging(stagingRelRef.current);
      const uuid =
        (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      // The file-manager upload only writes into an EXISTING top-level `path`, but it
      // makedirs subfolders from each relative path. So upload into the user's root
      // (which exists) and put the staging subfolder in the relative-path prefix.
      const stagingSub = `.zarr_replace_staging/${uuid}`;
      const rel = `${userRoot}/${stagingSub}`;
      setPicked(p);
      setValidation(null);
      setError(null);
      setAcknowledged(false);
      setStagingRel(rel);
      setUploadPct(0);
      try {
        setBusy('staging');
        await uploadZarrStaging(
          userRoot,
          p.files,
          p.relativePaths.map((r) => `${stagingSub}/${r.replace(/^\/+/, '')}`),
          (f) => setUploadPct(Math.round(f * 100))
        );

        setUploadPct(null);
        setBusy('validate');
        const v = await validateZarrReplacement(rel, targetSlidePath, slideDims?.[0], slideDims?.[1]);
        setValidation(v);
      } catch (e) {
        setError(getErrorMessage(e, 'Upload / validation failed'));
      } finally {
        setBusy(null);
      }
    },
    [targetSlidePath, slideDims, pathWritable]
  );

  const onDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      try {
        const p = await pickFromDrop(e);
        if (p) await ingest(p);
        else setError('Drop a .zarr folder or a .zip file.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not read the dropped item.');
      }
    },
    [ingest]
  );

  const onFolderInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const list = e.target.files;
      if (!list || list.length === 0) return;
      const files: File[] = [];
      const rels: string[] = [];
      for (let i = 0; i < list.length; i++) {
        if (list[i].size === 0) continue;
        files.push(list[i]);
        rels.push((list[i] as File & { webkitRelativePath?: string }).webkitRelativePath || list[i].name);
      }
      const label = rels[0]?.split('/')[0] || `${files.length} files`;
      if (files.length) void ingest({ files, relativePaths: rels, label });
      e.target.value = '';
    },
    [ingest]
  );

  const onZipInput = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) void ingest({ files: [f], relativePaths: [f.name], label: f.name });
      e.target.value = '';
    },
    [ingest]
  );

  const handleReplace = useCallback(async () => {
    if (!stagingRel || !targetSlidePath || !validation?.ok) return;
    if (!pathWritable) return;
    setBusy('replace');
    setError(null);
    try {
      // Backend deletes the staging folder on success.
      await replaceZarr(stagingRel, targetSlidePath, slideDims?.[0], slideDims?.[1]);
      stagingRelRef.current = null;
      onReplaced();
      onClose();
    } catch (e) {
      setError(getErrorMessage(e, 'Replace failed'));
    } finally {
      setBusy(null);
    }
  }, [stagingRel, targetSlidePath, validation, slideDims, onReplaced, onClose, pathWritable]);

  const uploadDisabled = !pathWritable || !!busy;
  const sum = validation?.summary;
  const busyLabel =
    busy === 'staging'
      ? uploadPct != null
        ? `Uploading… ${uploadPct}%`
        : 'Uploading…'
      : busy === 'validate'
        ? 'Validating…'
        : busy === 'replace'
          ? 'Replacing…'
          : null;

  return (
    <Dialog open={isOpen} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-primary" />
            Replace preprocessing (Zarr)
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs text-muted-foreground">
            Upload your own preprocessing (including nuclei segmentation) to replace this slide&apos;s
            data. It is validated against this slide before anything is overwritten — your source is
            copied, never moved.
          </p>

          {!pathWritable && writeBlockTitle && (
            <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{writeBlockTitle}</span>
            </div>
          )}

          {/* Drop zone + pickers */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              if (uploadDisabled) return;
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={uploadDisabled ? undefined : onDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors ${
              uploadDisabled
                ? 'cursor-not-allowed border-border bg-muted/30 opacity-60'
                : dragOver
                  ? 'border-primary bg-primary/5'
                  : 'border-border'
            }`}
          >
            <Upload className="h-6 w-6 text-muted-foreground" />
            <div className="text-xs text-muted-foreground">
              Drag a <span className="font-medium text-foreground">.zarr folder</span> or a{' '}
              <span className="font-medium text-foreground">.zip</span> here
            </div>
            <div className="mt-1 flex gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => folderInputRef.current?.click()} disabled={uploadDisabled}>
                <Folder className="mr-1 h-3.5 w-3.5" /> Select folder
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => zipInputRef.current?.click()} disabled={uploadDisabled}>
                <FileArchive className="mr-1 h-3.5 w-3.5" /> Select .zip
              </Button>
            </div>
            {picked && (
              <div className="mt-1 w-full break-all text-[11px] text-foreground" title={picked.label}>
                Selected: {picked.label}
              </div>
            )}
            <input
              ref={folderInputRef}
              type="file"
              // @ts-ignore — webkitdirectory is not in React's types
              webkitdirectory=""
              directory=""
              multiple
              hidden
              onChange={onFolderInput}
            />
            <input ref={zipInputRef} type="file" accept=".zip" hidden onChange={onZipInput} />
          </div>

          {busyLabel && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> {busyLabel}
              </div>
              {busy === 'staging' && (
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-150"
                    style={{ width: `${uploadPct ?? 0}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          {/* Validation report */}
          {validation && !busy && (
            <div className="flex flex-col gap-2 rounded-md border border-border p-3 text-xs">
              <div className={`flex items-center gap-1.5 font-medium ${validation.ok ? 'text-primary' : 'text-destructive'}`}>
                {validation.ok ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
                {validation.ok ? 'Compatible — ready to replace' : 'Incompatible — cannot replace'}
              </div>

              {sum && (
                <div className="text-muted-foreground">
                  {typeof sum.nuclei_count === 'number' && (
                    <div>Nuclei in candidate: <span className="font-medium text-foreground">{sum.nuclei_count.toLocaleString()}</span></div>
                  )}
                  {sum.top_level_groups && <div>Groups: {sum.top_level_groups.join(', ')}</div>}
                  {sum.centroid_max && sum.slide_dimensions && (
                    <div>Max coord [{sum.centroid_max.join(', ')}] · slide [{sum.slide_dimensions.join(', ')}]</div>
                  )}
                </div>
              )}

              {validation.errors.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-destructive">
                  {validation.errors.map((er, i) => <li key={i}>{er}</li>)}
                </ul>
              )}
              {validation.warnings.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-amber-600 dark:text-amber-500">
                  {validation.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}

              {validation.ok && (
                <label className="mt-1 flex items-start gap-2 text-[11px] leading-snug text-muted-foreground">
                  <Checkbox checked={acknowledged} onCheckedChange={(v) => setAcknowledged(v === true)} className="mt-0.5" />
                  <span>I understand this replaces <span className="font-medium text-foreground">all</span> preprocessing for this slide (segmentation, classification, and any annotations in it). The current data is discarded.</span>
                </label>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={!!busy}>
            {validation?.ok ? 'Replace later' : 'Cancel'}
          </Button>
          {validation?.ok && (
            <Button onClick={handleReplace} disabled={!pathWritable || !acknowledged || !!busy}>
              {busy === 'replace' ? <><Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />Replacing…</> : 'Replace now'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ZarrReplaceDialog;
