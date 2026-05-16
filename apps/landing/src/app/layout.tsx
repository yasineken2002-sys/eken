import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { LenisProvider } from '@/components/LenisProvider'
import { SiteNav } from '@/components/SiteNav'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Eveno — Sveriges smartaste fastighetssystem',
  description:
    'AI-driven fastighetsförvaltning för 1–300 lägenheter. Allt på ett ställe. AI som tar smarta beslut åt dig.',
  metadataBase: new URL('https://eveno.se'),
}

export const viewport: Viewport = {
  themeColor: '#0A0E1F',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="sv" className={inter.variable}>
      <body className="bg-eveno-deep-space font-sans text-white antialiased">
        <LenisProvider>
          <SiteNav />
          {children}
        </LenisProvider>
      </body>
    </html>
  )
}
