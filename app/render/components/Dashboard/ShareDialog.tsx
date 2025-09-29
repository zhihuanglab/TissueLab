import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getShareInfo, updateShareInfo } from '@/utils/fileManager.service';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { app } from '@/config/firebaseConfig';
import { lookupUserByEmail, searchUsersByEmail, getUsersBasicInfo } from '@/utils/fileManager.service';

interface ShareDialogProps {
  path: string;
  onClose: () => void;
}

export const ShareDialog: React.FC<ShareDialogProps> = ({ path, onClose }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fallbackName = useMemo(() => (path ? path.split('/').pop() || '' : ''), [path]);
  const [fileName, setFileName] = useState(fallbackName);
  const [ownerId, setOwnerId] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [sharedWithIds, setSharedWithIds] = useState<string[]>([]);
  const [sharedUsers, setSharedUsers] = useState<Array<{ userId: string; email: string; name: string }>>([]);
  const [newEmail, setNewEmail] = useState('');
  const [suggestions, setSuggestions] = useState<Array<{ userId: string; email: string; name: string }>>([]);
  const [suggesting, setSuggesting] = useState(false);
  const debounceRef = useRef<number | null>(null);
  

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError(null);
      // reset transient state to avoid leftovers when reopening
      setSharedWithIds([]);
      setSharedUsers([]);
      setNewEmail('');
      setSuggestions([]);
      debounceRef.current && clearTimeout(debounceRef.current);
      debounceRef.current = null;
      try {
        const data = await getShareInfo(path);
        setFileName(data.fileName || path.split('/').pop() || '');
        setOwnerId(data.ownerId || '');
        const rawIds = Array.isArray(data.sharedWith) ? (data.sharedWith as string[]) : [];
        const uidPattern = /^[A-Za-z0-9_-]{20,}$/; // Firebase UID-like
        const ids = Array.from(new Set(rawIds.filter((uid) => typeof uid === 'string' && uidPattern.test(uid.trim()))));
        setSharedWithIds(ids);
        // Resolve existing shared user display info
        try {
          const res = await getUsersBasicInfo(ids);
          const map = new Map<string, { email?: string; preferred_name?: string }>();
          if (res && Array.isArray(res.users)) {
            res.users.forEach((u: any) => {
              map.set(u.user_id, { email: u.email, preferred_name: u.preferred_name });
            });
          }
          const results = ids.map(uid => {
            const info = map.get(uid) || {};
            return {
              userId: uid,
              email: typeof info.email === 'string' ? info.email : '',
              name: info.preferred_name || (uid ? uid.substring(0, 8) : 'Unknown'),
            };
          });
          setSharedUsers(results);
        } catch {}
        // Fetch owner's preferred_name from Firestore
        try {
          const owner = data.ownerId || '';
          if (owner) {
            const db = getFirestore(app);
            const snap = await getDoc(doc(db, 'users', owner));
            const preferred = snap.exists() ? (snap.data() as any)?.preferred_name : null;
            setOwnerName(preferred || (owner ? owner.substring(0, 8) : 'Unknown'));
          } else {
            setOwnerName('Unknown');
          }
        } catch (e) {
          const owner = data.ownerId || '';
          setOwnerName(owner ? owner.substring(0, 8) : 'Unknown');
        }
      } catch (e: any) {
        setError(e?.message || 'Failed to load share info');
      } finally {
        setLoading(false);
      }
    })();
  }, [path]);

  

  const findUserByEmail = async (email: string): Promise<{ userId: string; email: string; name: string } | null> => {
    try {
      const res = await lookupUserByEmail(email);
      if (!res?.found || !res?.user_id) return null;
      return {
        userId: res.user_id,
        email: res.email || email,
        name: res.preferred_name || (res.user_id ? res.user_id.substring(0, 8) : email),
      };
    } catch {
      return null;
    }
  };

  const addUserByEmail = async () => {
    const email = newEmail.trim();
    if (!email) return;
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      setError('Please enter a valid email');
      return;
    }
    setError(null);
    const user = await findUserByEmail(email);
    if (!user) {
      setError('User not found');
      return;
    }
    if (sharedWithIds.includes(user.userId)) {
      setNewEmail('');
      return;
    }
    setSharedWithIds([...sharedWithIds, user.userId]);
    setSharedUsers([...sharedUsers, user]);
    setNewEmail('');
  };

  // Debounced suggestions
  useEffect(() => {
    const q = newEmail.trim();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (q.length < 3) {
      setSuggestions([]);
      setSuggesting(false);
      return;
    }
    const t = window.setTimeout(async () => {
      setSuggesting(true);
      try {
        const res = await searchUsersByEmail(q, 5);
        const users = Array.isArray(res?.users) ? res.users : [];
        setSuggestions(users.map((u: any) => ({
          userId: u.user_id,
          email: u.email,
          name: u.preferred_name || (u.user_id ? u.user_id.substring(0,8) : u.email)
        })));
      } catch {
        setSuggestions([]);
      } finally {
        setSuggesting(false);
      }
    }, 300);
    debounceRef.current = t as unknown as number;
    return () => {
      clearTimeout(t);
    };
  }, [newEmail]);

  const chooseSuggestion = (s: { userId: string; email: string; name: string }) => {
    if (sharedWithIds.includes(s.userId)) {
      setNewEmail('');
      setSuggestions([]);
      return;
    }
    setSharedWithIds([...sharedWithIds, s.userId]);
    setSharedUsers([...sharedUsers, s]);
    setNewEmail('');
    setSuggestions([]);
  };

  const removeUser = (userId: string) => {
    setSharedWithIds(sharedWithIds.filter(x => x !== userId));
    setSharedUsers(sharedUsers.filter(u => u.userId !== userId));
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: any = { path, sharedWith: sharedWithIds };
      await updateShareInfo(payload);
      onClose();
    } catch (e: any) {
      setError(e?.message || 'Failed to save share settings');
    } finally {
      setSaving(false);
    }
  };
  

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Share &quot;{fileName || fallbackName}&quot;</DialogTitle>
          <DialogDescription>
            {loading ? 'Loading...' : (error ? error : `Owner: ${ownerName || 'Unknown'}`)}
          </DialogDescription>
        </DialogHeader>

        {!loading && (
          <div className="space-y-6">
            {error && <div className="text-sm text-red-500">{error}</div>}


            <div className="space-y-2">
              <div className="font-medium">Share with specific users</div>
              <div className="flex items-center gap-2 relative">
                <Input value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder="Enter user email" />
                <Button onClick={addUserByEmail} disabled={!newEmail.trim()}>Add</Button>
                {suggestions.length > 0 && (
                  <div className="absolute z-50 top-full left-0 mt-1 w-full bg-white border rounded shadow">
                    {suggestions.map(s => (
                      <div key={s.userId} className="px-3 py-2 hover:bg-gray-50 cursor-pointer" onClick={() => chooseSuggestion(s)}>
                        <div className="text-sm font-medium">{s.name}</div>
                        <div className="text-xs text-gray-500">{s.email}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {sharedUsers.length > 0 && (
                <div className="border rounded divide-y">
                  {sharedUsers.map(u => (
                    <div key={u.userId} className="flex items-center justify-between p-2">
                      <div className="text-sm">
                        <div className="font-medium">{u.name}</div>
                        <div className="text-xs text-gray-500">{u.email}</div>
                      </div>
                      <Button variant="ghost" size="sm" onClick={() => removeUser(u.userId)}>Remove</Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button onClick={handleSave} disabled={saving || loading}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ShareDialog;
