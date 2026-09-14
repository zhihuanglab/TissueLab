import { describe, expect, it } from 'vitest';
import {
  assertCanWrite,
  getRestrictedAccessMode,
  getWriteDenial,
  isPathAccessDenied,
  isPublicReadOnlyPath,
  isWriteBlockedPath,
  noticeFromDeniedError,
  PathAccessError,
} from '@/utils/common/pathAccess.utils';

describe('utils/common/pathAccess.utils', () => {
  describe('public Samples are read-only', () => {
    it.each([
      'samples',
      '/samples',
      'samples/',
      'samples/CMU-1.svs',
      'samples/Data/nested/file.tif',
      'samples\\windows\\style.svs',
      '/tissuelab/data/extra.svs',
    ])('%s is a public read-only path', (path) => {
      expect(isPublicReadOnlyPath(path)).toBe(true);
      expect(getRestrictedAccessMode(path)).toBe('samples');
      expect(isWriteBlockedPath(path)).toBe(true);
    });

    it('produces the samples denial notice for write operations', () => {
      const denial = getWriteDenial('rename', 'samples/CMU-1.svs');
      expect(denial).toMatchObject({ operation: 'rename', accessMode: 'samples', title: 'Read-only samples' });
      expect(denial?.description).toMatch(/Personal workspace/);
    });

    it('assertCanWrite throws a PathAccessError that the denial helpers recognise', () => {
      let caught: unknown;
      try {
        assertCanWrite('samples/CMU-1.svs', 'delete');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PathAccessError);
      const error = caught as PathAccessError;
      expect(error.errorCode).toBe('PUBLIC_READ_ONLY_FORBIDDEN');
      expect(error.accessMode).toBe('samples');
      expect(error.operation).toBe('delete');
      expect(error.message).toContain("can't delete");
      expect(isPathAccessDenied(error)).toBe(true);
      expect(noticeFromDeniedError(error).title).toBe('Read-only samples');
    });
  });

  describe('the personal workspace is writable', () => {
    it.each([
      'users/local',
      'users/local/CMU-1.svs',
      'users/local/folder/CMU-1.svs.zarr',
      '/users/local/x.tif',
      'users/local/samples-lookalike/file.svs',
      'my-samples/file.svs',
    ])('%s is not restricted', (path) => {
      expect(isPublicReadOnlyPath(path)).toBe(false);
      expect(getRestrictedAccessMode(path)).toBeNull();
      expect(isWriteBlockedPath(path)).toBe(false);
      expect(getWriteDenial('rename', path)).toBeNull();
      expect(() => assertCanWrite(path, 'rename')).not.toThrow();
    });

    it('treats empty / missing paths as unrestricted', () => {
      expect(isPublicReadOnlyPath('')).toBe(false);
      expect(isPublicReadOnlyPath(null)).toBe(false);
      expect(isPublicReadOnlyPath(undefined)).toBe(false);
      expect(getRestrictedAccessMode(undefined)).toBeNull();
      expect(getWriteDenial('rename', null)).toBeNull();
    });
  });

  describe('no share / collaborate modes in the local edition', () => {
    it('never produces a share-style access mode client-side', () => {
      const modes = new Set(
        ['users/local/a.svs', 'users/someone-else/b.svs', 'samples/c.svs', 'shared/d.svs', 'collaborate/e.svs'].map(
          getRestrictedAccessMode,
        ),
      );
      // Only `samples` (or nothing) — never `share`, `collaborate` or `view`.
      expect([...modes].every((m) => m === null || m === 'samples')).toBe(true);
    });

    it('does not treat share-like backend errors as path denials', () => {
      expect(isPathAccessDenied({ errorCode: 'SHARE_FORBIDDEN' })).toBe(false);
      expect(isPathAccessDenied({ accessMode: 'share' })).toBe(false);
      expect(isPathAccessDenied({ accessMode: 'collaborate' })).toBe(false);
      expect(isPathAccessDenied(new Error('403'))).toBe(false);
      expect(isPathAccessDenied(null)).toBe(false);
    });

    it('recognises backend denial payloads in both camelCase and snake_case', () => {
      expect(isPathAccessDenied({ errorCode: 'VIEW_ONLY_FORBIDDEN' })).toBe(true);
      expect(isPathAccessDenied({ error_code: 'PUBLIC_SAMPLES_EXTRACT_FORBIDDEN' })).toBe(true);
      expect(isPathAccessDenied({ data: { access_mode: 'public_samples' } })).toBe(true);
      expect(noticeFromDeniedError({ accessMode: 'viewer' }).title).toBe('Viewer only');
      expect(noticeFromDeniedError({ errorCode: 'PUBLIC_READ_ONLY_FORBIDDEN' }).title).toBe('Read-only samples');
      expect(noticeFromDeniedError({}).title).toBe('Not allowed');
    });
  });
});
