'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CTRL_SERVICE_API_ENDPOINT } from '@/config/api.config'
import { apiFetch } from '@/utils/common/apiFetch'

// The service's LLM connection (see app/service/app/services/llm_settings.py).
// Saved by the service and applied at once; an empty field falls back to its
// default, shown as the placeholder (.env.local, or the built-in one).
const API = () => `${CTRL_SERVICE_API_ENDPOINT}/agent/v1/model_settings`

type PlainName = 'OPENAI_BASE_URL' | 'LLM_MODEL' | 'LLM_API' | 'DISCOVERY_BASE_URL' | 'DISCOVERY_MODEL'
type SecretName = 'OPENAI_API_KEY' | 'DISCOVERY_API_KEY'

interface PlainField { value: string; env_value: string }
interface SecretField { set: boolean; hint: string | null; env_set: boolean; env_hint: string | null }
interface ModelSettings {
  fields: Record<PlainName, PlainField> & Record<SecretName, SecretField> & { RESEARCH_USES_AGENT: { value: boolean } }
  status: {
    agent_configured: boolean
    agent_protocol: string
    agent_model: string
    research_model: string
    research_unavailable_reason: string | null
  }
}

const PLAIN: PlainName[] = ['OPENAI_BASE_URL', 'LLM_MODEL', 'LLM_API', 'DISCOVERY_BASE_URL', 'DISCOVERY_MODEL']
const SECRETS: SecretName[] = ['OPENAI_API_KEY', 'DISCOVERY_API_KEY']
const AUTO = 'auto'
const OPENAI_URL = 'https://api.openai.com/v1'
const PROTOCOL_LABEL: Record<string, string> = { chat: 'Chat Completions', responses: 'Responses' }

// Where a key goes: an endpoint's host and port (empty means OpenAI).
const hostOf = (url: string) => {
  try {
    return new URL(url || OPENAI_URL).host.toLowerCase()
  } catch {
    return url
  }
}

const emptyPlain = (): Record<PlainName, string> =>
  Object.fromEntries(PLAIN.map((name) => [name, ''])) as Record<PlainName, string>

const ModelSettingsSection: React.FC<{ isOpen: boolean }> = ({ isOpen }) => {
  const [settings, setSettings] = useState<ModelSettings | null>(null)
  const [plain, setPlain] = useState<Record<PlainName, string>>(emptyPlain)
  // A typed key replaces the saved one; untouched keys stay as they are.
  const [keys, setKeys] = useState<Record<SecretName, string>>({ OPENAI_API_KEY: '', DISCOVERY_API_KEY: '' })
  const [clearKeys, setClearKeys] = useState<Record<SecretName, boolean>>({ OPENAI_API_KEY: false, DISCOVERY_API_KEY: false })
  // The eye shows what is typed; a saved key never comes back from the service
  // (its CORS is open, so any page could read it), only its last characters.
  const [showKeys, setShowKeys] = useState<Record<SecretName, boolean>>({ OPENAI_API_KEY: false, DISCOVERY_API_KEY: false })
  // Like "billing address same as shipping": research on the Agent's endpoint and key.
  const [usesAgent, setUsesAgent] = useState(true)
  // As loaded: the switch is sent only when changed, so an untouched one keeps
  // following .env.local instead of being pinned by every save.
  const [loadedUsesAgent, setLoadedUsesAgent] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const show = useCallback((next: ModelSettings) => {
    setSettings(next)
    setPlain(Object.fromEntries(PLAIN.map((name) => [name, next.fields[name].value])) as Record<PlainName, string>)
    setKeys({ OPENAI_API_KEY: '', DISCOVERY_API_KEY: '' })
    setClearKeys({ OPENAI_API_KEY: false, DISCOVERY_API_KEY: false })
    setShowKeys({ OPENAI_API_KEY: false, DISCOVERY_API_KEY: false })
    setUsesAgent(next.fields.RESEARCH_USES_AGENT.value)
    setLoadedUsesAgent(next.fields.RESEARCH_USES_AGENT.value)
  }, [])

  useEffect(() => {
    if (!isOpen) return
    apiFetch(API(), { method: 'GET' })
      .then((data) => {
        show(data as ModelSettings)
        setError(null)
        setSaved(false)
      })
      .catch((e: any) => setError(`Could not load model settings: ${e?.message ?? e}`))
  }, [isOpen, show])

  const save = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    const fields: Record<string, string | null> = { ...plain }
    for (const name of SECRETS) fields[name] = keys[name].trim() ? keys[name].trim() : clearKeys[name] ? '' : null
    if (usesAgent !== loadedUsesAgent) fields.RESEARCH_USES_AGENT = usesAgent ? 'true' : 'false'
    // The service drops research's own endpoint / key while the switch is on.
    if (usesAgent) fields.DISCOVERY_BASE_URL = fields.DISCOVERY_API_KEY = null
    try {
      show((await apiFetch(API(), { method: 'PUT', body: JSON.stringify({ fields }) })) as ModelSettings)
      setSaved(true)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  const setField = (name: PlainName, value: string) => {
    setSaved(false)
    setPlain((prev) => ({ ...prev, [name]: value }))
  }

  // What an empty field falls back to.
  const envHint = (name: PlainName, fallback: string) => {
    const env = settings?.fields[name].env_value
    return env ? `default: ${env} (from .env.local)` : `default: ${fallback}`
  }

  // A saved key never follows its endpoint to another host (the service clears it).
  const keyWillBeCleared = (url: PlainName, key: SecretName) => {
    const field = settings?.fields[key]
    if (!settings || !field?.set || clearKeys[key] || keys[key].trim()) return false
    const effective = (value: string) => value.trim() || settings.fields[url].env_value
    return hostOf(effective(plain[url])) !== hostOf(effective(settings.fields[url].value))
  }
  const keyNote = (url: PlainName, key: SecretName) => keyWillBeCleared(url, key) && (
    <p className="text-xs text-amber-600">
      The saved key will be cleared — enter the key for the new endpoint.
    </p>
  )

  // Research's own key with no endpoint of its own goes to OpenAI.
  const researchHasKey = Boolean(
    keys.DISCOVERY_API_KEY.trim()
    || (settings?.fields.DISCOVERY_API_KEY.set && !clearKeys.DISCOVERY_API_KEY)
    || settings?.fields.DISCOVERY_API_KEY.env_set,
  )
  const protocolDefault = settings?.fields.LLM_API.env_value

  const keyInput = (name: SecretName, fallback: string) => {
    const field = settings?.fields[name]
    const cleared = clearKeys[name]
    const placeholder = field?.set && !cleared
      ? `Saved ${field.hint} — type to replace`
      : field?.env_set
        ? `default: ${field.env_hint} (from .env.local)`
        : fallback
    const shown = showKeys[name]
    return (
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Input
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            aria-label={name === 'OPENAI_API_KEY' ? 'Agent API key' : 'Research API key'}
            placeholder={placeholder}
            value={keys[name]}
            className={keys[name] ? 'pr-9' : undefined}
            onChange={(e) => {
              setSaved(false)
              setKeys((prev) => ({ ...prev, [name]: e.target.value }))
              // Emptied: the next key starts hidden again.
              if (!e.target.value) setShowKeys((prev) => ({ ...prev, [name]: false }))
            }}
          />
          {/* Only while typing: there is nothing to reveal otherwise. */}
          {keys[name] && (
          <button
            type="button"
            aria-label={shown ? 'Hide API key' : 'Show API key'}
            title={shown ? 'Hide' : 'Show'}
            className="absolute inset-y-0 right-0 flex w-9 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={() => setShowKeys((prev) => ({ ...prev, [name]: !prev[name] }))}
          >
            {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          )}
        </div>
        {field?.set && !cleared && (
          <Button
            type="button"
            variant="outline"
            className="border-border text-foreground hover:bg-accent"
            onClick={() => {
              setSaved(false)
              setKeys((prev) => ({ ...prev, [name]: '' }))
              setClearKeys((prev) => ({ ...prev, [name]: true }))
            }}
          >
            Remove
          </Button>
        )}
      </div>
    )
  }

  const row = (label: string, hint: string, control: React.ReactNode) => (
    <div className="grid grid-cols-1 md:grid-cols-[14rem_1fr] gap-2 md:items-center">
      <div className="space-y-1">
        <Label className="text-sm font-medium text-muted-foreground">{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {control}
    </div>
  )

  const status = settings?.status

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-lg font-medium text-foreground">AI Models</h3>
        <p className="text-xs text-muted-foreground">
          Any OpenAI-compatible endpoint. Saved on this computer and used from the next request; an empty field
          resets to the default shown in it (.env.local, or the built-in one).
        </p>
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Agent (chat &amp; workflows)</h4>
        {row('Endpoint', 'Base URL, e.g. http://localhost:11434/v1',
          <Input
            aria-label="Agent endpoint"
            placeholder={envHint('OPENAI_BASE_URL', `${OPENAI_URL} (OpenAI)`)}
            value={plain.OPENAI_BASE_URL}
            onChange={(e) => setField('OPENAI_BASE_URL', e.target.value)}
          />)}
        {keyNote('OPENAI_BASE_URL', 'OPENAI_API_KEY')}
        {row('API key', 'Stored locally, never shown again', keyInput('OPENAI_API_KEY', 'sk-...'))}
        {row('Model', 'Model name on that endpoint',
          <Input
            aria-label="Agent model"
            placeholder={envHint('LLM_MODEL', 'gpt-5.2 (built-in)')}
            value={plain.LLM_MODEL}
            onChange={(e) => setField('LLM_MODEL', e.target.value)}
          />)}
        {row('Protocol', 'Auto: Responses on OpenAI, Chat Completions elsewhere',
          <Select value={plain.LLM_API || AUTO} onValueChange={(v) => setField('LLM_API', v === AUTO ? '' : v)}>
            <SelectTrigger aria-label="Agent protocol"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={AUTO}>
                {protocolDefault ? `Default: ${PROTOCOL_LABEL[protocolDefault] ?? protocolDefault} (from .env.local)` : 'Auto'}
              </SelectItem>
              <SelectItem value="chat">Chat Completions</SelectItem>
              <SelectItem value="responses">Responses</SelectItem>
            </SelectContent>
          </Select>)}
      </div>

      <div className="space-y-3">
        <h4 className="text-sm font-semibold text-foreground">Research (discovery)</h4>
        <p className="text-xs text-muted-foreground">
          Needs the OpenAI Responses API. Give it its own endpoint when the Agent runs on a self-hosted model.
        </p>
        <div className="flex items-center gap-2">
          <Checkbox
            id="research-uses-agent"
            checked={usesAgent}
            onCheckedChange={(checked) => {
              setSaved(false)
              setUsesAgent(checked === true)
            }}
          />
          <Label htmlFor="research-uses-agent" className="text-sm text-foreground cursor-pointer">
            Use the Agent&apos;s endpoint and API key
          </Label>
        </div>
        {!usesAgent && (
          <>
            {row('Endpoint', 'Responses API base URL',
              <Input
                aria-label="Research endpoint"
                placeholder={envHint('DISCOVERY_BASE_URL', researchHasKey
                  ? `${OPENAI_URL} (OpenAI, for the research key)`
                  : 'the Agent endpoint and key')}
                value={plain.DISCOVERY_BASE_URL}
                onChange={(e) => setField('DISCOVERY_BASE_URL', e.target.value)}
              />)}
            {keyNote('DISCOVERY_BASE_URL', 'DISCOVERY_API_KEY')}
            {row('API key', 'Stored locally, never shown again', keyInput('DISCOVERY_API_KEY', 'sk-... (empty: the Agent key, with the Agent endpoint)'))}
          </>
        )}
        {row('Model', 'Model the research loop runs on',
          <Input
            aria-label="Research model"
            placeholder={envHint('DISCOVERY_MODEL', 'gpt-5.4 (built-in)')}
            value={plain.DISCOVERY_MODEL}
            onChange={(e) => setField('DISCOVERY_MODEL', e.target.value)}
          />)}
      </div>

      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="text-xs space-y-1" data-testid="model-settings-status">
          {status && (
            <>
              <p className={status.agent_configured ? 'text-muted-foreground' : 'text-amber-600'}>
                Agent: {status.agent_configured
                  ? `ready (${status.agent_model}, ${status.agent_protocol === 'chat' ? 'Chat Completions' : 'Responses'})`
                  : 'no API key'}
              </p>
              <p className={status.research_unavailable_reason ? 'text-amber-600' : 'text-muted-foreground'}>
                Research: {status.research_unavailable_reason ?? `ready (${status.research_model})`}
              </p>
            </>
          )}
          {error && <p className="text-red-600">{error}</p>}
          {saved && !error && <p className="text-green-600">Saved — in effect now.</p>}
        </div>
        <Button onClick={save} disabled={saving || !settings}>
          {saving ? 'Saving...' : 'Save AI Models'}
        </Button>
      </div>
    </div>
  )
}

export default ModelSettingsSection
