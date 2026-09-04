import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/**
 * QR-koden för identifiering på annan enhet.
 *
 * ── VALET AV RENDERARE, OCH DE TVÅ SOM VALDES BORT ────────────────────────
 *
 * 1. CDN — uteslutet. Repot laddar inga externa skript alls; typsnitten är
 *    self-hostade av samma skäl (CLAUDE.md, F4).
 * 2. En egen, beroendefri renderare — övervägt och avvisat. QR-kodning är
 *    Reed–Solomon plus maskval, några hundra rader, och en QR som kodar FEL är
 *    värre än ingen QR: den ser riktig ut och misslyckas hos användaren, inte
 *    hos oss.
 * 3. `qrcode`, som VALDES. Paketet finns redan i monorepot — `apps/api` använder
 *    det för TOTP-koden i plattformsadmin — så versionen är känd och ingen ny
 *    leverantör tillkommer. Det har ett `browser`-fält och renderar via canvas.
 *
 * ── TEXTFALLBACKEN ÄR INTE PYNT ───────────────────────────────────────────
 *
 * Renderingen är asynkron och kan misslyckas (canvas otillgänglig, för lång
 * nyttolast). Utan fallback blir utfallet en tom ruta, alltså ett flöde som ser
 * ut att hänga. Med den kan användaren fortfarande komma vidare — koden går att
 * skriva in, och `autoStartToken`-knappen bredvid är dessutom kvar.
 */
export function BankIdQr({ value }: { value: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [misslyckades, setMisslyckades] = useState(false)

  useEffect(() => {
    let aktuell = true
    setMisslyckades(false)
    QRCode.toDataURL(value, { margin: 1, width: 208 })
      .then((url) => {
        // Vakten mot en rendering som blir klar efter att `value` bytts (QR:n
        // roterar hos vissa brokers) eller efter avmontering. Utan den kan en
        // gammal kod skriva över en ny.
        if (aktuell) setDataUrl(url)
      })
      .catch(() => {
        if (aktuell) setMisslyckades(true)
      })
    return () => {
      aktuell = false
    }
  }, [value])

  if (misslyckades || (!dataUrl && value.length === 0)) {
    return (
      <div className="border-line bg-canvas rounded-xl border p-4 text-center">
        <p className="text-ink-muted text-[12px]">QR-koden kunde inte visas. Kod att ange:</p>
        <p className="text-ink mt-2 break-all font-mono text-[12px]">{value}</p>
      </div>
    )
  }

  return (
    <div className="border-line bg-surface flex h-[208px] w-[208px] items-center justify-center rounded-xl border">
      {dataUrl ? (
        <img
          src={dataUrl}
          alt="QR-kod för BankID"
          width={208}
          height={208}
          className="rounded-xl"
        />
      ) : (
        <span className="text-ink-muted text-[12px]">Laddar…</span>
      )}
    </div>
  )
}
