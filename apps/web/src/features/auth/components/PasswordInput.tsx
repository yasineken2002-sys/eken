import { forwardRef, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/cn'

interface Props extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  // error/hint är frivilliga och får vara explicit undefined — react-hook-form
  // skickar `undefined` när formstatus saknar fel, vilket annars krockar med
  // exactOptionalPropertyTypes.
  error?: string | undefined
  hint?: string | undefined
}

export const PasswordInput = forwardRef<HTMLInputElement, Props>(
  ({ label, error, hint, className, autoComplete = 'new-password', ...props }, ref) => {
    const [show, setShow] = useState(false)
    return (
      <div className="space-y-1.5">
        {label && <label className="block text-[13px] font-medium text-gray-700">{label}</label>}
        <div className="relative">
          <input
            ref={ref}
            type={show ? 'text' : 'password'}
            autoComplete={autoComplete}
            placeholder="••••••••"
            className={cn(
              'flex h-10 w-full rounded-xl border bg-white px-3.5 pr-10 text-[13.5px] text-gray-900 placeholder:text-gray-400',
              'transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-0',
              error
                ? 'border-red-300 focus:border-red-400 focus:ring-red-500/15'
                : 'border-[#E5E7EB] hover:border-gray-300 focus:border-blue-500 focus:ring-blue-500/15',
              className,
            )}
            {...props}
          />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 transition-colors hover:text-gray-600"
            tabIndex={-1}
            aria-label={show ? 'Dölj lösenord' : 'Visa lösenord'}
          >
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        </div>
        {error ? (
          <p className="text-[12px] text-red-500">{error}</p>
        ) : hint ? (
          <p className="text-[12px] text-gray-400">{hint}</p>
        ) : null}
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'
