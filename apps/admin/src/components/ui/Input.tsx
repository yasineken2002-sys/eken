import {
  forwardRef,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn'

const base =
  'h-9 w-full rounded-lg border border-[#DDDFE4] bg-white px-3 text-[13.5px] text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:bg-gray-50'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn(base, className)} {...rest} />
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cn(base, 'appearance-none bg-white pr-8', className)} {...rest}>
        {children}
      </select>
    )
  },
)

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        'min-h-[80px] w-full rounded-lg border border-[#DDDFE4] bg-white px-3 py-2 text-[13.5px] text-gray-900 shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/30',
        className,
      )}
      {...rest}
    />
  )
})

interface LabelProps {
  children: React.ReactNode
  htmlFor?: string
  className?: string
}
export function Label({ children, htmlFor, className }: LabelProps) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('mb-1 block text-[13px] font-medium text-gray-700', className)}
    >
      {children}
    </label>
  )
}
