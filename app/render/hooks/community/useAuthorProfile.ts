/**
 * Public-author lookup hook.
 *
 * Resolves `{displayName, avatarUrl}` for any Firebase uid by calling the
 * stateless ctrl-service endpoint `/community/v1/users/{uid}/public-profile`.
 * That endpoint sets aggressive `Cache-Control` headers, so the browser HTTP
 * cache keeps repeat lookups off the wire across pages and tabs.
 *
 * On top of the browser cache, this module keeps a Map<uid, Promise<profile>>
 * so that K cards on the same page sharing the same author still only fire
 * one in-flight request — without it React would schedule N parallel useEffects
 * before any of them have a response to share.
 */

import { useEffect, useState } from "react"
import { COMMUNITY_API_ENDPOINT } from "@/config/api.config"
import { apiFetch } from "@/utils/common/apiFetch"

export interface PublicAuthorProfile {
  uid: string
  displayName: string
  avatarUrl: string | null
}

/**
 * Reserved brand author. TissueLab-owned community classifiers render with our
 * name + logo. Resolved entirely on the frontend (the logo is a frontend brand
 * asset served from /public/brand) — no ctrl-service round-trip and no backend
 * coupling to the asset path.
 */
const TISSUELAB_PROFILE: PublicAuthorProfile = {
  uid: "tissuelab",
  displayName: "TissueLab",
  avatarUrl: "/brand/logo.svg",
}

/**
 * Open edition: the local service reports its fixed user as `local` when there
 * is no Firebase session (desktop before sign-in, offline). That is not a
 * community uid, so it is skipped like `anonymous` — looking it up would only
 * make the hosted server ask for a sign-in on every page.
 */
const LOCAL_UID = "local"
const isLookupUid = (uid: string | null | undefined): uid is string =>
  !!uid && uid !== "anonymous" && uid !== LOCAL_UID

/** Pending requests keyed by uid. Resolves to the profile or null on failure. */
const inFlight: Map<string, Promise<PublicAuthorProfile | null>> = new Map()
/** Cached results so a remounted card doesn't re-fire even if the browser
 *  HTTP cache was evicted. Lives for the page lifetime. */
const resolved: Map<string, PublicAuthorProfile> = new Map()

function fetchProfile(uid: string): Promise<PublicAuthorProfile | null> {
  if (uid === "tissuelab") return Promise.resolve(TISSUELAB_PROFILE)
  const existing = inFlight.get(uid)
  if (existing) return existing

  const cached = resolved.get(uid)
  if (cached) return Promise.resolve(cached)

  const url = `${COMMUNITY_API_ENDPOINT}/community/v1/users/${encodeURIComponent(uid)}/public-profile`
  const promise = apiFetch(url, { method: "GET" })
    .then((data: unknown) => {
      const profile = normalizeProfile(uid, data)
      if (profile) resolved.set(uid, profile)
      return profile
    })
    .catch((err) => {
      // Soft failure — callers should fall back to the uid prefix.
      console.warn(`useAuthorProfile: lookup failed for ${uid}:`, err)
      return null
    })
    .finally(() => {
      inFlight.delete(uid)
    })

  inFlight.set(uid, promise)
  return promise
}

function normalizeProfile(uid: string, raw: unknown): PublicAuthorProfile | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  return {
    uid: typeof obj.uid === "string" && obj.uid ? obj.uid : uid,
    displayName: typeof obj.displayName === "string" ? obj.displayName : "",
    avatarUrl: typeof obj.avatarUrl === "string" && obj.avatarUrl ? obj.avatarUrl : null,
  }
}

/**
 * React hook variant. Returns the cached profile synchronously on remount
 * (so the card doesn't flash a fallback), then updates when the request
 * resolves. Pass an empty / anonymous uid to skip the request entirely.
 */
export function useAuthorProfile(uid: string | null | undefined): PublicAuthorProfile | null {
  const initial =
    uid === "tissuelab"
      ? TISSUELAB_PROFILE
      : isLookupUid(uid)
        ? resolved.get(uid) ?? null
        : null
  const [profile, setProfile] = useState<PublicAuthorProfile | null>(initial)

  useEffect(() => {
    if (!isLookupUid(uid)) {
      setProfile(null)
      return
    }
    let active = true
    void fetchProfile(uid).then((p) => {
      if (active) setProfile(p)
    })
    return () => {
      active = false
    }
  }, [uid])

  return profile
}
