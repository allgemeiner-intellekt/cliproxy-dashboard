import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTheme, type ThemePreference } from '../lib/theme'

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
]

function ThemeIcon({ pref }: { pref: ThemePreference }) {
  if (pref === 'light') return <Sun size={14} aria-hidden />
  if (pref === 'dark') return <Moon size={14} aria-hidden />
  return <Monitor size={14} aria-hidden />
}

export function ThemeMenu() {
  const { preference, setPreference } = useTheme()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const currentLabel = OPTIONS.find((o) => o.value === preference)?.label ?? 'System'

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpen(false)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const select = (next: ThemePreference) => {
    setPreference(next)
    setOpen(false)
    triggerRef.current?.focus()
  }

  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = itemRefs.current.indexOf(document.activeElement as HTMLButtonElement | null)
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      itemRefs.current[(idx + 1) % OPTIONS.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      itemRefs.current[(idx - 1 + OPTIONS.length) % OPTIONS.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      itemRefs.current[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      itemRefs.current[OPTIONS.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="theme-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${currentLabel}`}
        title={`Theme: ${currentLabel}`}
        onClick={() => setOpen((v) => !v)}
      >
        <ThemeIcon pref={preference} />
      </button>

      {open && (
        <div className="theme-menu-pop" role="menu" aria-label="Theme" onKeyDown={onMenuKeyDown}>
          {OPTIONS.map((opt, i) => (
            <button
              key={opt.value}
              ref={(el) => {
                itemRefs.current[i] = el
              }}
              type="button"
              role="menuitemradio"
              aria-checked={preference === opt.value}
              className="theme-menu-item"
              onClick={() => select(opt.value)}
            >
              <ThemeIcon pref={opt.value} />
              <span>{opt.label}</span>
              <Check size={13} className="theme-menu-check" aria-hidden />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
