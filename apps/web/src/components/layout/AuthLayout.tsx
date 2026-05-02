import { Outlet } from '@tanstack/react-router'

export function AuthLayout() {
  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      {/* Left – branding panel */}
      <div className="bg-primary text-primary-foreground hidden flex-col justify-between p-10 lg:flex">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <span className="bg-primary-foreground/20 h-6 w-6 rounded-md" />
          Eveno
        </div>
        <blockquote className="space-y-2">
          <p className="text-lg leading-relaxed">
            "Det moderna fastighetssystemet — byggt för den som förvaltar på riktigt."
          </p>
        </blockquote>
      </div>

      {/* Right – form */}
      <div className="flex items-center justify-center p-8">
        <Outlet />
      </div>
    </div>
  )
}
