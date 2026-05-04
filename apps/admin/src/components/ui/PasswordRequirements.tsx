import { Check, X } from 'lucide-react'
import { passwordChecks } from '@eken/shared'

interface Props {
  password: string
}

export function PasswordRequirements({ password }: Props) {
  const checks = passwordChecks(password)
  return (
    <ul
      className="space-y-1.5 rounded-xl border border-[#EAEDF0] bg-gray-50/60 p-3"
      aria-label="Lösenordskrav"
    >
      {checks.map((c) => (
        <li key={c.key} className="flex items-center gap-2 text-[12.5px]">
          <span
            className={
              c.passed
                ? 'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white'
                : 'flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border border-gray-300 bg-white text-gray-300'
            }
          >
            {c.passed ? <Check size={10} strokeWidth={3} /> : <X size={9} strokeWidth={2.5} />}
          </span>
          <span className={c.passed ? 'text-emerald-700' : 'text-gray-500'}>{c.label}</span>
        </li>
      ))}
    </ul>
  )
}
