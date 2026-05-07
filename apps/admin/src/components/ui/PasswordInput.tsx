import { forwardRef, useState, type InputHTMLAttributes } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/cn'

/**
 * Lösenordsinput med visa/dölj-toggle. Drop-in kompatibel med admin-app:ens
 * Input-komponent (samma höjd, border, focus-ring) men har en eye-knapp i
 * höger kant. När lösenordet visas får fältet en svag blå-tonad bakgrund
 * som visuell signal till användaren att det inte längre är dolt.
 */
type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(
  function PasswordInput({ className, ...rest }, ref) {
    const [visible, setVisible] = useState(false)
    return (
      <div className="relative">
        <input
          ref={ref}
          type={visible ? 'text' : 'password'}
          className={cn(
            'h-9 w-full rounded-lg border border-[#DDDFE4] px-3 pr-9 text-[13.5px] text-gray-900 shadow-sm placeholder:text-gray-400',
            'focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:bg-gray-50',
            visible ? 'bg-blue-50/30' : 'bg-white',
            className,
          )}
          {...rest}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Dölj lösenord' : 'Visa lösenord'}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30"
        >
          {visible ? <EyeOff size={14} strokeWidth={1.8} /> : <Eye size={14} strokeWidth={1.8} />}
        </button>
      </div>
    )
  },
)
