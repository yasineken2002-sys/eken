/* Eveno brand-lockup: navy rounded square with a white door mark + "eveno"
 * wordmark. Återanvänds både i portal-shellen och på auth-sidorna så
 * varumärket ser identiskt ut överallt. */

interface EvenoLogoProps {
  size?: 'sm' | 'md' | 'lg'
  showWordmark?: boolean
  subtitle?: string
  className?: string
}

const SIZES = {
  sm: { mark: 28, icon: 16, word: 17 },
  md: { mark: 40, icon: 22, word: 20 },
  lg: { mark: 48, icon: 26, word: 22 },
} as const

export function EvenoLogo({
  size = 'md',
  showWordmark = true,
  subtitle,
  className,
}: EvenoLogoProps) {
  const dims = SIZES[size]
  const radius = size === 'sm' ? 8 : size === 'md' ? 11 : 13

  return (
    <div
      className={className}
      style={{ display: 'flex', alignItems: 'center', gap: size === 'sm' ? 8 : 12 }}
    >
      <div
        aria-hidden="true"
        style={{
          width: dims.mark,
          height: dims.mark,
          borderRadius: radius,
          background: 'var(--color-primary)',
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
        }}
      >
        <svg width={dims.icon} height={dims.icon} viewBox="0 0 16 16" fill="none">
          <path
            d="M4 13.5V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v8.5"
            stroke="#fff"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
          <circle cx="9.6" cy="9" r="0.7" fill="#fff" />
        </svg>
      </div>

      {showWordmark && (
        <div>
          <p
            style={{
              fontSize: dims.word,
              fontWeight: 500,
              letterSpacing: '-0.03em',
              color: 'var(--color-primary)',
              lineHeight: 1.1,
              margin: 0,
            }}
          >
            eveno
          </p>
          {subtitle && (
            <p
              style={{
                fontSize: 13,
                color: 'var(--color-fg-2)',
                margin: '2px 0 0',
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
