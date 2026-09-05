import { useEffect, useState } from 'react'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useUpdateTenant } from '../hooks/useTenants'
import { bygguppdatering, kontaktFel, type Kontaktutkast } from './tenant-contact-form'
import { extractApiError } from '@/lib/api'

/**
 * REDIGERA HYRESGÄST — människans väg till AI-verktyget `update_tenant`.
 *
 * Verktyget stod i `tool-human-path.baseline.json` med skälet: "Endpoint finns
 * och useUpdateTenant finns, men ingen komponent anropar hooken — TenantsPage är
 * läsning, portalinbjudan och avidentifiering, så en hyresvärd kan inte rätta en
 * felstavad hyresgäst i gränssnittet."
 *
 * Det var en av de otäckare posterna i baslinjen, därför att en sökning på
 * `useUpdateTenant` gav en träff och SÅG ut som en väg. En exporterad hook utan
 * anropare är död kod som liknar täckning.
 *
 * ── SAMMA TJÄNSTEMETOD SOM VERKTYGET ────────────────────────────────────────
 *
 * Verktyget anropar `tenantsService.update(id, { email?, phone? }, orgId)`.
 * Hooken går via `PATCH /v1/tenants/:id` → `TenantsController.update` → samma
 * `tenantsService.update`. Ingen parallell implementation, och ingen ny endpoint
 * behövdes: den fanns redan och saknade bara en knapp.
 *
 * ── FÄLTMÄNGDEN ─────────────────────────────────────────────────────────────
 *
 * Exakt de två fält verktyget kan ändra. Se `tenant-contact-form.ts` för varför
 * modalen inte passar på att öppna namn och personnummer också.
 */

interface Props {
  open: boolean
  onClose: () => void
  tenantId: string
  namn: string
  epost: string
  telefon: string | null
}

export function EditTenantModal({ open, onClose, tenantId, namn, epost, telefon }: Props) {
  const utgang: Kontaktutkast = { email: epost, phone: telefon ?? '' }
  const [utkast, setUtkast] = useState<Kontaktutkast>(utgang)
  const [serverfel, setServerfel] = useState<string | null>(null)
  const mutation = useUpdateTenant()

  // Utgångsläget kommer från propsen och kan bytas medan modalen är stängd
  // (användaren väljer en annan hyresgäst). Utan den här synkroniseringen hade
  // formuläret öppnats med FÖREGÅENDE hyresgästs uppgifter — och en spara-knapp
  // hade då skrivit dem på fel person.
  useEffect(() => {
    if (open) {
      setUtkast({ email: epost, phone: telefon ?? '' })
      setServerfel(null)
    }
  }, [open, tenantId, epost, telefon])

  const fel = kontaktFel(utkast)
  const uppdatering = bygguppdatering(utgang, utkast)
  const oforandrat = uppdatering === null

  const spara = () => {
    if (fel || !uppdatering) return
    setServerfel(null)
    mutation.mutate(
      { id: tenantId, ...uppdatering },
      {
        onSuccess: onClose,
        onError: (err) => setServerfel(extractApiError(err, 'Kunde inte spara ändringen')),
      },
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Redigera hyresgäst"
      description={`Kontaktuppgifter för ${namn}. Namn och personnummer ändras inte här.`}
    >
      <div className="space-y-4">
        <Input
          label="E-postadress"
          type="email"
          value={utkast.email}
          onChange={(e) => setUtkast((u) => ({ ...u, email: e.target.value }))}
          hint="Hyresgästen nås via den här adressen — avier och portalinbjudan går hit."
          data-testid="tenant-email"
        />
        <Input
          label="Telefon"
          value={utkast.phone}
          onChange={(e) => setUtkast((u) => ({ ...u, phone: e.target.value }))}
          placeholder="Valfritt"
          data-testid="tenant-phone"
        />

        {(serverfel ?? fel) && (
          <p
            className={
              serverfel
                ? 'rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-[13px] text-red-600'
                : 'text-[12px] text-red-500'
            }
            data-testid="tenant-edit-error"
          >
            {serverfel ?? fel}
          </p>
        )}
      </div>

      <ModalFooter>
        <Button variant="secondary" onClick={onClose}>
          Avbryt
        </Button>
        <Button
          variant="primary"
          onClick={spara}
          disabled={fel !== null || oforandrat || mutation.isPending}
          data-testid="tenant-edit-save"
        >
          {mutation.isPending ? 'Sparar…' : 'Spara'}
        </Button>
      </ModalFooter>
    </Modal>
  )
}
