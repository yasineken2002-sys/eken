/* Lucide-style stroke icons for the Eveno portal. Match the Claude Design
 * prototype (project/Icons.jsx) so the new design renders 1:1.
 */
import type { SVGProps } from 'react'

interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'stroke'> {
  size?: number
  stroke?: number
}

function base({ size = 16, stroke = 1.8, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    ...rest,
  }
}

export function EvBell(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  )
}

export function EvDownload(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  )
}

export function EvWrench(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M14.7 6.3a4.5 4.5 0 0 0 6 6L17 8.6 21 4.6 19 2l-4 4-4.3-3.7a4.5 4.5 0 0 0-6 6L9 13l-6 6 3 3 6-6 4.7 3.3a4.5 4.5 0 0 0 6-6" />
    </svg>
  )
}

export function EvMail(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 6L2 7" />
    </svg>
  )
}

export function EvFileText(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  )
}

export function EvSparkles(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m12 3-1.9 5.8L4 11l6.1 1.9L12 19l1.9-6.1L20 11l-5.9-2.2z" />
      <path d="M5 3v4M3 5h4M19 17v4M17 19h4" />
    </svg>
  )
}

export function EvReceipt(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M4 2v20l2-1.5L8 22l2-1.5L12 22l2-1.5L16 22l2-1.5L20 22V2l-2 1.5L16 2l-2 1.5L12 2l-2 1.5L8 2 6 3.5z" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="13" x2="14" y2="13" />
    </svg>
  )
}

export function EvMenu(p: IconProps) {
  return (
    <svg {...base(p)}>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="17" x2="20" y2="17" />
    </svg>
  )
}

export function EvHome(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2h-4v-7H10v7H6a2 2 0 0 1-2-2z" />
    </svg>
  )
}

export function EvArrowLeft(p: IconProps) {
  return (
    <svg {...base(p)}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  )
}

export function EvArrowRight(p: IconProps) {
  return (
    <svg {...base(p)}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </svg>
  )
}

export function EvChevronRight(p: IconProps) {
  return (
    <svg {...base(p)}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

export function EvCamera(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  )
}

export function EvPlus(p: IconProps) {
  return (
    <svg {...base(p)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

export function EvX(p: IconProps) {
  return (
    <svg {...base(p)}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export function EvMic(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
    </svg>
  )
}

export function EvSend(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m3 11 18-8-8 18-2-7z" />
      <path d="m11 13 10-10" />
    </svg>
  )
}

export function EvDroplet(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M12 2.7s7 6.3 7 11.3a7 7 0 0 1-14 0c0-5 7-11.3 7-11.3" />
    </svg>
  )
}

export function EvZap(p: IconProps) {
  return (
    <svg {...base(p)}>
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

export function EvFlame(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 17c2 0 3.5-1.5 3.5-3.5 0-2.5-3-4-3-7C8 6 5 9.5 5 13a7 7 0 0 0 14 0c0-3-2-5-4-7-1.6-1.6-3-3.5-3-5-1.5 2-4 4-4 4" />
    </svg>
  )
}

export function EvHammer(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="m15 12-8.5 8.5a2.12 2.12 0 1 1-3-3L12 9" />
      <path d="M17.6 6.4 22 10.8 18.6 14.2 14.2 9.8z" />
      <path d="M11.6 12.4 14.4 9.6" />
      <path d="M16 7 22 1" />
    </svg>
  )
}

export function EvBuilding(p: IconProps) {
  return (
    <svg {...base(p)}>
      <rect x="4" y="3" width="16" height="18" rx="1" />
      <path d="M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01" />
      <path d="M10 21v-4h4v4" />
    </svg>
  )
}

export function EvAlertCircle(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

export function EvCheckCircle(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

export function EvClock(p: IconProps) {
  return (
    <svg {...base(p)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

export function EvCheck(p: IconProps) {
  return (
    <svg {...base(p)}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function EvKey(p: IconProps) {
  return (
    <svg {...base(p)}>
      <path d="M21 2l-9.6 9.6" />
      <circle cx="7.5" cy="15.5" r="5.5" />
      <path d="m21 2-3 3 2 2-3 3-2-2-3 3" />
    </svg>
  )
}
