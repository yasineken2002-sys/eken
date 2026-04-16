import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Server,
  Database,
  Zap,
  Monitor,
  Building2,
  Home,
  Users,
  FileText,
  Receipt,
  Calculator,
  LayoutDashboard,
  Settings,
  Lock,
  GitBranch,
  Cloud,
  Shield,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
} from 'lucide-react'
import { PageWrapper } from '@/components/ui/PageWrapper'

// ─── Animation variants ───────────────────────────────────────────────────────

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
}

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
}

// ─── Data ─────────────────────────────────────────────────────────────────────

const STATUS_CARDS = [
  {
    icon: Server,
    title: 'NestJS API',
    value: 'Online',
    sub: 'Port 3000 · Fastify adapter',
  },
  {
    icon: Database,
    title: 'PostgreSQL 16',
    value: 'Ansluten',
    sub: 'Prisma ORM · ACID',
  },
  {
    icon: Zap,
    title: 'Redis 7',
    value: 'Aktiv',
    sub: 'Sessions · BullMQ',
  },
  {
    icon: Monitor,
    title: 'React 18 + Vite',
    value: 'Körs',
    sub: 'TanStack Query · Zustand',
  },
]

interface Module {
  icon: React.ElementType
  color: string
  bg: string
  name: string
  route: string
  description: string
  features: string[]
  endpoints: number
}

const MODULES: Module[] = [
  {
    icon: Building2,
    color: '#2563EB',
    bg: '#EFF6FF',
    name: 'Fastigheter',
    route: 'properties',
    description: 'Hantera dina fastigheter',
    features: ['CRUD', 'Enhetslista', 'Adresshantering', 'Borttagningsskydd'],
    endpoints: 5,
  },
  {
    icon: Home,
    color: '#7C3AED',
    bg: '#F5F3FF',
    name: 'Enheter',
    route: 'units',
    description: 'Lägenheter, kontor och lokaler',
    features: ['CRUD', 'Statushantering', 'Kontraktshistorik', 'Hyresnivåer'],
    endpoints: 5,
  },
  {
    icon: Users,
    color: '#EA580C',
    bg: '#FFF7ED',
    name: 'Hyresgäster',
    route: 'tenants',
    description: 'Privatpersoner och företag',
    features: ['CRUD', 'Sök & filtrera', 'Fakturahistorik', 'Adressbok'],
    endpoints: 5,
  },
  {
    icon: FileText,
    color: '#0D9488',
    bg: '#F0FDFA',
    name: 'Kontrakt',
    route: 'leases',
    description: 'Hyreskontrakt med statustransitioner',
    features: ['CRUD', 'State machine', 'PENDING→ACTIVE→EXPIRED', 'Borttagningsskydd'],
    endpoints: 6,
  },
  {
    icon: Receipt,
    color: '#16A34A',
    bg: '#F0FDF4',
    name: 'Fakturor',
    route: 'invoices',
    description: 'Komplett faktureringssystem',
    features: [
      'CRUD',
      'PDF-generering',
      'E-post',
      'Bulk-fakturering',
      'Live-förhandsgranskning',
      'Statusflöde',
    ],
    endpoints: 9,
  },
  {
    icon: Calculator,
    color: '#4338CA',
    bg: '#EEF2FF',
    name: 'Bokföring',
    route: 'accounting',
    description: 'Dubbel bokföring med BAS-kontoplan',
    features: ['Verifikationer', 'BAS-konton', 'Auto-bokföring', 'Journal'],
    endpoints: 4,
  },
  {
    icon: LayoutDashboard,
    color: '#DB2777',
    bg: '#FDF2F8',
    name: 'Dashboard',
    route: 'dashboard',
    description: 'Realtidsstatistik och överblick',
    features: ['6 statistikkort', 'Senaste fakturor', 'Parallella queries', 'Live-data'],
    endpoints: 1,
  },
  {
    icon: Settings,
    color: '#6B7280',
    bg: '#F9FAFB',
    name: 'Inställningar',
    route: 'settings',
    description: 'Organisationsinställningar',
    features: ['Logotyp', 'Fakturafärg', '3 mallar', 'Bankgiro', 'Påminnelser'],
    endpoints: 3,
  },
  {
    icon: Lock,
    color: '#DC2626',
    bg: '#FEF2F2',
    name: 'Autentisering',
    route: 'login',
    description: 'JWT-autentisering med refresh tokens',
    features: ['Login', 'Registrering', 'Auto-refresh', 'RBAC 5 nivåer', 'Logout'],
    endpoints: 4,
  },
]

const BACKEND_STACK = [
  ['NestJS 10', 'Modulärt ramverk med DI'],
  ['Fastify', '2× snabbare än Express'],
  ['Prisma 5', 'Type-safe ORM'],
  ['PostgreSQL 16', 'ACID, index, relationer'],
  ['Redis 7', 'Cache + sessions'],
  ['JWT RS256', '15min access + 30d refresh'],
  ['Puppeteer', 'PDF-generering'],
  ['Nodemailer', 'E-postutskick'],
  ['BullMQ', 'Job queues'],
  ['Zod', 'Runtime-validering'],
]

const FRONTEND_STACK = [
  ['React 18', 'Concurrent mode'],
  ['Vite 5', '<300ms cold start'],
  ['TanStack Query', 'Server-state + cache'],
  ['Zustand', 'Auth-state'],
  ['Framer Motion', 'Animationer'],
  ['react-hook-form', 'Formulärhantering'],
  ['Tailwind CSS 3', 'Utility-first styling'],
  ['Axios', 'HTTP + interceptors'],
  ['lucide-react', 'Ikoner'],
]

interface EndpointGroup {
  resource: string
  color: string
  endpoints: { method: string; path: string }[]
}

const ENDPOINT_GROUPS: EndpointGroup[] = [
  {
    resource: 'AUTH',
    color: '#DC2626',
    endpoints: [
      { method: 'POST', path: '/auth/register' },
      { method: 'POST', path: '/auth/login' },
      { method: 'POST', path: '/auth/refresh' },
      { method: 'POST', path: '/auth/logout' },
    ],
  },
  {
    resource: 'PROPERTIES',
    color: '#2563EB',
    endpoints: [
      { method: 'GET', path: '/properties' },
      { method: 'GET', path: '/properties/:id' },
      { method: 'POST', path: '/properties' },
      { method: 'PATCH', path: '/properties/:id' },
      { method: 'DELETE', path: '/properties/:id' },
    ],
  },
  {
    resource: 'UNITS',
    color: '#7C3AED',
    endpoints: [
      { method: 'GET', path: '/units' },
      { method: 'GET', path: '/units/:id' },
      { method: 'POST', path: '/units' },
      { method: 'PATCH', path: '/units/:id' },
      { method: 'DELETE', path: '/units/:id' },
    ],
  },
  {
    resource: 'TENANTS',
    color: '#EA580C',
    endpoints: [
      { method: 'GET', path: '/tenants' },
      { method: 'GET', path: '/tenants/:id' },
      { method: 'POST', path: '/tenants' },
      { method: 'PATCH', path: '/tenants/:id' },
      { method: 'DELETE', path: '/tenants/:id' },
    ],
  },
  {
    resource: 'LEASES',
    color: '#0D9488',
    endpoints: [
      { method: 'GET', path: '/leases' },
      { method: 'GET', path: '/leases/:id' },
      { method: 'POST', path: '/leases' },
      { method: 'PATCH', path: '/leases/:id' },
      { method: 'PATCH', path: '/leases/:id/status' },
      { method: 'DELETE', path: '/leases/:id' },
    ],
  },
  {
    resource: 'INVOICES',
    color: '#16A34A',
    endpoints: [
      { method: 'GET', path: '/invoices' },
      { method: 'GET', path: '/invoices/:id' },
      { method: 'GET', path: '/invoices/:id/events' },
      { method: 'GET', path: '/invoices/:id/pdf' },
      { method: 'POST', path: '/invoices' },
      { method: 'POST', path: '/invoices/bulk' },
      { method: 'POST', path: '/invoices/:id/send-email' },
      { method: 'PATCH', path: '/invoices/:id' },
      { method: 'PATCH', path: '/invoices/:id/status' },
      { method: 'DELETE', path: '/invoices/:id' },
    ],
  },
  {
    resource: 'ACCOUNTING',
    color: '#4338CA',
    endpoints: [
      { method: 'GET', path: '/accounting/accounts' },
      { method: 'POST', path: '/accounting/accounts/seed' },
      { method: 'GET', path: '/accounting/journal' },
      { method: 'GET', path: '/accounting/journal/:id' },
    ],
  },
  {
    resource: 'DASHBOARD',
    color: '#DB2777',
    endpoints: [{ method: 'GET', path: '/dashboard/stats' }],
  },
  {
    resource: 'ORGANIZATIONS',
    color: '#0369A1',
    endpoints: [
      { method: 'GET', path: '/organizations/me' },
      { method: 'PATCH', path: '/organizations/me' },
      { method: 'PATCH', path: '/organizations/me/logo' },
    ],
  },
  {
    resource: 'NOTIFICATIONS',
    color: '#B45309',
    endpoints: [{ method: 'POST', path: '/notifications/send-overdue-reminders' }],
  },
]

const METHOD_COLORS: Record<string, { bg: string; text: string }> = {
  GET: { bg: '#EFF6FF', text: '#2563EB' },
  POST: { bg: '#F0FDF4', text: '#16A34A' },
  PATCH: { bg: '#FFF7ED', text: '#EA580C' },
  DELETE: { bg: '#FEF2F2', text: '#DC2626' },
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EndpointAccordion({ group }: { group: EndpointGroup }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="overflow-hidden rounded-xl border border-gray-100 bg-white">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-gray-50/80"
      >
        <div className="flex items-center gap-3">
          <span className="inline-block h-2 w-2 rounded-full" style={{ background: group.color }} />
          <span className="text-[13.5px] font-semibold text-gray-800">{group.resource}</span>
          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-500">
            {group.endpoints.length}
          </span>
        </div>
        {open ? (
          <ChevronUp size={14} className="text-gray-400" />
        ) : (
          <ChevronDown size={14} className="text-gray-400" />
        )}
      </button>

      {open && (
        <div className="border-t border-gray-100 px-4 py-2">
          {group.endpoints.map((ep, i) => {
            const mc = METHOD_COLORS[ep.method] ?? { bg: '#F3F4F6', text: '#374151' }
            return (
              <div
                key={i}
                className="flex items-center gap-3 border-b border-gray-100 py-2 last:border-0"
              >
                <span
                  className="w-14 rounded px-1.5 py-0.5 text-center text-[11px] font-bold"
                  style={{ background: mc.bg, color: mc.text }}
                >
                  {ep.method}
                </span>
                <code className="font-mono text-[12.5px] text-gray-600">{ep.path}</code>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function OverviewPage() {
  const today = new Date().toLocaleDateString('sv-SE', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  const totalEndpoints = ENDPOINT_GROUPS.reduce((s, g) => s + g.endpoints.length, 0)

  return (
    <PageWrapper id="overview">
      <div className="px-6 py-6" style={{ maxWidth: 1200, margin: '0 auto' }}>
        {/* ── Header ── */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="flex items-start justify-between"
        >
          <div>
            <h1 className="text-[22px] font-semibold tracking-tight text-gray-900">
              Plattformsöversikt
            </h1>
            <p className="mt-1 text-[13px] text-gray-500">
              Fullständig översikt över alla moduler och funktioner
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-[12px] font-semibold text-emerald-700">
              v1.0
            </span>
            <span className="rounded-full border border-gray-100 bg-white px-3 py-1 text-[12px] text-gray-500">
              {today}
            </span>
          </div>
        </motion.div>

        {/* ── Section 1: Systemstatus ── */}
        <div className="mt-8">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Systemstatus
          </p>
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            className="grid grid-cols-2 gap-3 sm:grid-cols-4"
          >
            {STATUS_CARDS.map((card) => (
              <motion.div
                key={card.title}
                variants={item}
                className="rounded-2xl border border-gray-100 bg-white p-4"
                whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-50">
                    <card.icon size={14} className="text-emerald-600" strokeWidth={1.8} />
                  </div>
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                </div>
                <p className="mt-2.5 text-[13px] font-medium text-gray-500">{card.title}</p>
                <p className="text-[15px] font-semibold text-emerald-600">{card.value}</p>
                <p className="mt-0.5 text-[11px] text-gray-400">{card.sub}</p>
              </motion.div>
            ))}
          </motion.div>
        </div>

        {/* ── Section 2: Moduler ── */}
        <div className="mt-8">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Moduler
          </p>
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          >
            {MODULES.map((mod) => (
              <motion.div
                key={mod.name}
                variants={item}
                className="flex cursor-pointer flex-col rounded-2xl border border-gray-100 bg-white p-5 transition-shadow"
                whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
              >
                {/* Top */}
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-9 w-9 items-center justify-center rounded-xl"
                    style={{ background: mod.bg }}
                  >
                    <mod.icon size={16} strokeWidth={1.8} style={{ color: mod.color }} />
                  </div>
                  <span className="text-[14px] font-semibold text-gray-900">{mod.name}</span>
                </div>

                {/* Description */}
                <p className="mt-2.5 text-[13px] text-gray-500">{mod.description}</p>

                {/* Feature pills */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {mod.features.map((f) => (
                    <span
                      key={f}
                      className="rounded-full px-2 py-0.5 text-[11px] font-medium"
                      style={{ background: mod.bg, color: mod.color }}
                    >
                      {f}
                    </span>
                  ))}
                </div>

                {/* Footer */}
                <div className="mt-auto pt-4">
                  <span className="rounded-full border border-gray-100 px-2.5 py-0.5 text-[11px] font-medium text-gray-400">
                    {mod.endpoints} endpoints
                  </span>
                </div>
              </motion.div>
            ))}
          </motion.div>
        </div>

        {/* ── Section 3: Teknisk stack ── */}
        <div className="mt-8">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            Teknisk stack
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* Backend */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: 0.05 }}
              className="rounded-2xl border border-gray-100 bg-white p-5"
            >
              <div className="mb-3 flex items-center gap-2">
                <Server size={14} className="text-gray-400" strokeWidth={1.8} />
                <span className="text-[13px] font-semibold text-gray-700">Backend</span>
              </div>
              <table className="w-full">
                <tbody>
                  {BACKEND_STACK.map(([tech, desc]) => (
                    <tr key={tech} className="border-b border-gray-100 last:border-0">
                      <td className="w-36 py-2 pr-4 text-[12.5px] font-semibold text-gray-800">
                        {tech}
                      </td>
                      <td className="py-2 text-[12.5px] text-gray-500">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>

            {/* Frontend */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2, delay: 0.1 }}
              className="rounded-2xl border border-gray-100 bg-white p-5"
            >
              <div className="mb-3 flex items-center gap-2">
                <Monitor size={14} className="text-gray-400" strokeWidth={1.8} />
                <span className="text-[13px] font-semibold text-gray-700">Frontend</span>
              </div>
              <table className="w-full">
                <tbody>
                  {FRONTEND_STACK.map(([tech, desc]) => (
                    <tr key={tech} className="border-b border-gray-100 last:border-0">
                      <td className="w-36 py-2 pr-4 text-[12.5px] font-semibold text-gray-800">
                        {tech}
                      </td>
                      <td className="py-2 text-[12.5px] text-gray-500">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </motion.div>
          </div>
        </div>

        {/* ── Section 4: API Endpoints ── */}
        <div className="mt-8">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            API Endpoints
          </p>
          <motion.div variants={container} initial="hidden" animate="show" className="space-y-2">
            {ENDPOINT_GROUPS.map((group) => (
              <motion.div key={group.resource} variants={item}>
                <EndpointAccordion group={group} />
              </motion.div>
            ))}
          </motion.div>
          <div className="mt-3 text-right">
            <span className="rounded-full border border-gray-100 bg-white px-3 py-1 text-[12px] font-medium text-gray-500">
              {totalEndpoints} endpoints totalt
            </span>
          </div>
        </div>

        {/* ── Section 5: CI/CD & Deployment ── */}
        <div className="mt-8">
          <p className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
            CI/CD & Deployment
          </p>
          <motion.div
            variants={container}
            initial="hidden"
            animate="show"
            className="grid grid-cols-1 gap-4 sm:grid-cols-3"
          >
            {[
              {
                icon: GitBranch,
                color: '#2563EB',
                bg: '#F0FDF4',
                title: 'CI Pipeline',
                subtitle: 'GitHub Actions',
                items: [
                  'TypeScript typecheck',
                  'ESLint',
                  'Build verification',
                  'Docker build test',
                ],
              },
              {
                icon: Cloud,
                color: '#2563EB',
                bg: '#EFF6FF',
                title: 'Produktionsmiljö',
                subtitle: 'Railway',
                items: [
                  'API Docker container',
                  'Web nginx container',
                  'PostgreSQL managed',
                  'Redis managed',
                  'Auto-deploy på push',
                ],
              },
              {
                icon: Shield,
                color: '#7C3AED',
                bg: '#F5F3FF',
                title: 'Säkerhetslager',
                subtitle: 'Inbyggt skydd',
                items: [
                  'JWT rotation',
                  'bcrypt(12) lösenord',
                  'Rate limiting 100/min',
                  'CORS locked',
                  'Helmet headers',
                  'Multi-tenant isolering',
                ],
              },
            ].map((card) => (
              <motion.div
                key={card.title}
                variants={item}
                className="rounded-2xl border border-gray-100 bg-white p-5"
                whileHover={{ y: -2, boxShadow: '0 8px 24px rgba(0,0,0,0.08)' }}
              >
                <div
                  className="mb-3 flex h-9 w-9 items-center justify-center rounded-xl"
                  style={{ background: card.bg }}
                >
                  <card.icon size={16} strokeWidth={1.8} style={{ color: card.color }} />
                </div>
                <p className="text-[14px] font-semibold text-gray-900">{card.title}</p>
                <p className="mb-3 text-[12px] text-gray-400">{card.subtitle}</p>
                <ul className="space-y-1.5">
                  {card.items.map((it) => (
                    <li key={it} className="flex items-center gap-2">
                      <CheckCircle2
                        size={12}
                        strokeWidth={2.2}
                        style={{ color: card.color }}
                        className="flex-shrink-0"
                      />
                      <span className="text-[12.5px] text-gray-600">{it}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </motion.div>
        </div>

        {/* ── Footer ── */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, delay: 0.4 }}
          className="mt-10 border-t border-gray-100 pb-6 pt-5 text-center"
        >
          <p className="text-[12px] text-gray-400">
            Byggt med Claude Code · Eken v1.0 · {new Date().getFullYear()}
          </p>
        </motion.div>
      </div>
    </PageWrapper>
  )
}
