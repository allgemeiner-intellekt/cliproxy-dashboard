import { ClaudeLogo, GeminiLogo, GrokLogo, KimiLogo, MetaLogo, OpenAILogo } from './ProviderLogos'

// Accepts usage vendors, upstream account providers, or client tools.
export function ProviderMark({ of, size = 14 }: { of: string; size?: number }) {
  const provider = of === 'claude-code' ? 'claude' : of === 'muse' || of === 'muse-code' ? 'meta' : of
  if (provider === 'claude' || provider === 'anthropic') return <ClaudeLogo className="mark mark-claude" width={size} height={size} />
  if (provider === 'codex' || provider === 'openai') return <OpenAILogo className="mark mark-codex" width={size} height={size} />
  if (provider === 'gemini' || provider === 'google') return <GeminiLogo className="mark mark-gemini" width={size} height={size} />
  if (provider === 'kimi' || provider === 'moonshot') return <KimiLogo className="mark mark-kimi" width={size} height={size} />
  if (provider === 'meta') return <MetaLogo className="mark mark-meta" width={size} height={size} />
  if (provider === 'xai' || provider === 'grok') return <GrokLogo className="mark mark-xai" width={size} height={size} />
  return <span className="dot" />
}
