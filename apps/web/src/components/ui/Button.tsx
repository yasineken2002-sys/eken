import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline'
type Size = 'xs' | 'sm' | 'md'

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium rounded-[10px] transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-1 disabled:opacity-50 disabled:pointer-events-none select-none active:scale-[0.97]'

const variants: Record<Variant, string> = {
  primary:
    'bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800 shadow-[0_1px_2px_rgba(37,99,235,0.3),0_0_0_1px_rgba(37,99,235,0.08)]',
  secondary:
    'bg-white text-gray-700 border border-[#E5E7EB] hover:bg-gray-50 hover:border-gray-300 shadow-[0_1px_2px_rgba(0,0,0,0.05)]',
  outline:
    'bg-transparent text-blue-600 border border-blue-200 hover:bg-blue-50 hover:border-blue-400',
  ghost: 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
  danger:
    'bg-red-500 text-white hover:bg-red-600 active:bg-red-700 shadow-[0_1px_2px_rgba(239,68,68,0.25)]',
}

const sizes: Record<Size, string> = {
  xs: 'h-7 px-2.5 text-[12px]',
  sm: 'h-8 px-3.5 text-[13px]',
  md: 'h-9 px-4 text-[13.5px]',
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
        <svg className="h-3.5 w-3.5 flex-shrink-0 animate-spin" fill="none" viewBox="0 0 24 24">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
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
