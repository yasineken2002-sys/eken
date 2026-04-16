import { forwardRef } from 'react'
import { cn } from '@/lib/cn'

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string | undefined
  hint?: string | undefined
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, className, ...props }, ref) => (
    <div className="space-y-1.5">
      {label && <label className="block text-[13px] font-medium text-gray-700">{label}</label>}
      <input
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-lg border bg-white px-3 text-[13.5px] text-gray-900 placeholder:text-gray-400',
          'transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-0',
          error ? 'border-red-300 focus:ring-red-400' : 'border-[#DDDFE4] hover:border-gray-300',
          className,
        )}
        {...props}
      />
      {error && <p className="text-[12px] text-red-500">{error}</p>}
      {hint && !error && <p className="text-[12px] text-gray-400">{hint}</p>}
    </div>
  ),
)
Input.displayName = 'Input'

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string | undefined
  options: { value: string; label: string }[]
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, className, ...props }, ref) => (
    <div className="space-y-1.5">
      {label && <label className="block text-[13px] font-medium text-gray-700">{label}</label>}
      <select
        ref={ref}
        className={cn(
          'flex h-9 w-full rounded-lg border bg-white px-3 text-[13.5px] text-gray-900',
          'transition-colors focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500',
          error ? 'border-red-300' : 'border-[#DDDFE4] hover:border-gray-300',
          className,
        )}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && <p className="text-[12px] text-red-500">{error}</p>}
    </div>
  ),
)
Select.displayName = 'Select'
