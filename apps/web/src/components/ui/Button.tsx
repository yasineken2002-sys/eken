import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type Size = 'xs' | 'sm' | 'md'

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded transition-all duration-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#218F52] focus-visible:ring-offset-1 disabled:opacity-50 disabled:pointer-events-none select-none active:scale-[0.98]'

const variants: Record<Variant, string> = {
  primary: 'bg-[#218F52] text-white hover:bg-[#1A7C45] active:bg-[#166638] shadow-sm',
  secondary:
    'bg-white text-[#3A4553] border border-[#D4D9E0] hover:bg-[#F7F9FB] hover:border-[#B8BFC8] shadow-sm',
  outline: 'bg-transparent text-[#218F52] border border-[#218F52] hover:bg-[#218F52]/5',
  ghost: 'text-[#5A6A7A] hover:bg-[#EEF1F4] hover:text-[#182030]',
  danger: 'bg-[#DC3545] text-white hover:bg-[#C82333] shadow-sm',
}

const sizes: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-[12px]',
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-[34px] px-4 text-[13px]',
}

interface Props extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ variant = 'secondary', size = 'md', loading, children, className, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(base, variants[variant], sizes[size], className)}
      disabled={loading ?? props.disabled}
      {...props}
    >
      {loading && (
        <svg className="h-3 w-3 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'
