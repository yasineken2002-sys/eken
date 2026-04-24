import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { PageHeader } from '@/components/ui/PageHeader'
import { Button } from '@/components/ui/Button'
import { Input, Label, Select } from '@/components/ui/Input'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { post } from '@/lib/api'

interface CreatedOrg {
  organization: { id: string; name: string }
  admin: { id: string; email: string; temporaryPassword: string }
}

export function NewOrganizationPage() {
  const navigate = useNavigate()
  const [form, setForm] = useState({
    name: '',
    orgNumber: '',
    email: '',
    phone: '',
    street: '',
    city: '',
    postalCode: '',
    plan: 'TRIAL',
    trialDays: 30,
    billingEmail: '',
    monthlyFee: 0,
    adminEmail: '',
    adminFirstName: '',
    adminLastName: '',
  })
  const [created, setCreated] = useState<CreatedOrg | null>(null)

  const mutation = useMutation({
    mutationFn: (payload: typeof form) =>
      post<CreatedOrg>('/platform/organizations', {
        ...payload,
        orgNumber: payload.orgNumber || undefined,
        phone: payload.phone || undefined,
        billingEmail: payload.billingEmail || undefined,
        trialDays: Number(payload.trialDays),
        monthlyFee: Number(payload.monthlyFee),
      }),
    onSuccess: (d) => setCreated(d),
  })

  function onChange<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  if (created) {
    return (
      <>
        <PageHeader
          title="Kund skapad"
          description={`${created.organization.name} är nu på plattformen`}
        />
        <Card className="mt-6">
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Första admin-användaren</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="text-[13px] text-gray-700">
              E-post: <code className="font-mono">{created.admin.email}</code>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] text-amber-900">
              Temporärt lösenord (skickas INTE automatiskt – vidarebefordra säkert):
              <div className="mt-1 font-mono text-[14px] font-semibold">
                {created.admin.temporaryPassword}
              </div>
            </div>
            <div className="flex gap-2 pt-2">
              <Button onClick={() => navigate(`/organizations/${created.organization.id}`)}>
                Öppna kund
              </Button>
              <Button variant="secondary" onClick={() => navigate('/organizations')}>
                Tillbaka till listan
              </Button>
            </div>
          </CardBody>
        </Card>
      </>
    )
  }

  return (
    <>
      <PageHeader
        title="Ny kund"
        description="Skapa en ny organisation och första admin-användaren"
      />
      <form
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate(form)
        }}
        className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2"
      >
        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Företag</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            <div>
              <Label htmlFor="name">Företagsnamn</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => onChange('name', e.target.value)}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="orgNumber">Organisationsnummer</Label>
                <Input
                  id="orgNumber"
                  value={form.orgNumber}
                  onChange={(e) => onChange('orgNumber', e.target.value)}
                  placeholder="556001-0001"
                />
              </div>
              <div>
                <Label htmlFor="email">E-post</Label>
                <Input
                  id="email"
                  type="email"
                  value={form.email}
                  onChange={(e) => onChange('email', e.target.value)}
                  required
                />
              </div>
            </div>
            <div>
              <Label htmlFor="phone">Telefon</Label>
              <Input
                id="phone"
                value={form.phone}
                onChange={(e) => onChange('phone', e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="street">Adress</Label>
              <Input
                id="street"
                value={form.street}
                onChange={(e) => onChange('street', e.target.value)}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="postalCode">Postnr</Label>
                <Input
                  id="postalCode"
                  value={form.postalCode}
                  onChange={(e) => onChange('postalCode', e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="city">Ort</Label>
                <Input
                  id="city"
                  value={form.city}
                  onChange={(e) => onChange('city', e.target.value)}
                  required
                />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Plan & fakturering</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            <div>
              <Label htmlFor="plan">Plan</Label>
              <Select
                id="plan"
                value={form.plan}
                onChange={(e) => onChange('plan', e.target.value)}
              >
                <option value="TRIAL">Trial</option>
                <option value="BASIC">Basic</option>
                <option value="STANDARD">Standard</option>
                <option value="PREMIUM">Premium</option>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="trialDays">Trial-dagar</Label>
                <Input
                  id="trialDays"
                  type="number"
                  value={form.trialDays}
                  onChange={(e) => onChange('trialDays', Number(e.target.value))}
                />
              </div>
              <div>
                <Label htmlFor="monthlyFee">Månadsavgift (SEK)</Label>
                <Input
                  id="monthlyFee"
                  type="number"
                  value={form.monthlyFee}
                  onChange={(e) => onChange('monthlyFee', Number(e.target.value))}
                />
              </div>
            </div>
            <div>
              <Label htmlFor="billingEmail">Faktura-mail</Label>
              <Input
                id="billingEmail"
                type="email"
                value={form.billingEmail}
                onChange={(e) => onChange('billingEmail', e.target.value)}
              />
            </div>
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <h3 className="text-[14px] font-semibold text-gray-900">Första admin-användare</h3>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="adminFirstName">Förnamn</Label>
                <Input
                  id="adminFirstName"
                  value={form.adminFirstName}
                  onChange={(e) => onChange('adminFirstName', e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="adminLastName">Efternamn</Label>
                <Input
                  id="adminLastName"
                  value={form.adminLastName}
                  onChange={(e) => onChange('adminLastName', e.target.value)}
                  required
                />
              </div>
              <div>
                <Label htmlFor="adminEmail">E-post</Label>
                <Input
                  id="adminEmail"
                  type="email"
                  value={form.adminEmail}
                  onChange={(e) => onChange('adminEmail', e.target.value)}
                  required
                />
              </div>
            </div>
            <p className="text-[12px] text-gray-500">
              Ett temporärt lösenord genereras automatiskt och visas när kunden är skapad.
            </p>
          </CardBody>
        </Card>

        {mutation.error ? (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-[13px] text-red-700 lg:col-span-2">
            {(mutation.error as Error).message}
          </div>
        ) : null}

        <div className="flex justify-end gap-2 lg:col-span-2">
          <Button type="button" variant="secondary" onClick={() => navigate('/organizations')}>
            Avbryt
          </Button>
          <Button type="submit" loading={mutation.isPending}>
            Skapa kund
          </Button>
        </div>
      </form>
    </>
  )
}
