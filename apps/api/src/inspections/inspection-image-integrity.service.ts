import { Injectable, Logger } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { StorageService } from '../storage/storage.service'

/**
 * BILDKONTROLLEN SOM FAKTISKT LÄSER BYTEN.
 *
 * ── VAD SOM SAKNADES ────────────────────────────────────────────────────────
 *
 * `InspectionImage.contentSha256` lagrades vid uppladdningen och togs in i
 * signaturunderlaget. Kolumnens egen kommentar är ärlig om gränsen:
 *
 *   "Detta UPPTÄCKER ett byte, det HINDRAR det inte — och ingen kod läser i dag
 *    tillbaka objektet ur lagringen för att jämföra. Fältet gör kontrollen
 *    MÖJLIG; den är inte inkopplad."
 *
 * En sparad digest som aldrig jämförs med någonting är inte en kontroll. Den är
 * ett tal i en kolumn. Den här tjänsten är jämförelsen: den hämtar de bytes som
 * ligger bakom `storageKey` NU och räknar om digesten.
 *
 * ── FYRA UTFALL, INTE TVÅ ───────────────────────────────────────────────────
 *
 * Ett booleskt `verifierad: true/false` hade varit en lögn i tre av fyra fall.
 * Utfallen måste hållas isär därför att de kräver olika handling och bär olika
 * grad av kunskap:
 *
 *   VERIFIERAD    — bytena lästes och digesten stämmer. Det ENDA utfall där
 *                   ordet "verifierad" får stå i ett gränssnitt.
 *   AVVIKANDE     — bytena lästes och digesten stämmer INTE. Objektet bakom
 *                   nyckeln är inte det som laddades upp. Ett larm, inte en not.
 *   SAKNAS        — objektet gick inte att läsa. Vi vet inte vad det innehöll,
 *                   bara att det inte finns där det ska.
 *   DIGEST_SAKNAS — raden har ingen lagrad digest (uppladdad före
 *                   20260917150000_inspection_image_digest). Ingen kontroll är
 *                   MÖJLIG. Det här är inte ett underkännande av bilden och får
 *                   aldrig visas som ett godkännande av den heller.
 *
 * Skillnaden mellan `SAKNAS` och `DIGEST_SAKNAS` är skillnaden mellan "bilden
 * är borta" och "vi har inget att jämföra med". Att slå ihop dem hade gjort
 * varje gammal bilaga till ett larm, och varje larm till brus.
 *
 * ── VAD KONTROLLEN INTE BEVISAR ─────────────────────────────────────────────
 *
 *   • Ingenting om VEM som bytte bytena. Digesten säger att innehållet skiljer
 *     sig, inte vem som skrev.
 *   • Ingenting om bilder utan lagrad digest. De är och förblir okända.
 *   • Ingenting om tiden mellan två kontroller. Utfallet gäller den sekund
 *     läsningen skedde; `kontrolleradAt` bär den tidpunkten just därför.
 *   • Ingen lagringsimmutabilitet. Kontrollen upptäcker ett byte i efterhand —
 *     den hindrar det inte, och den här kodbasen påstår inte att lagringen är
 *     oföränderlig.
 */

export const BILDKONTROLL_UTFALL = ['VERIFIERAD', 'AVVIKANDE', 'SAKNAS', 'DIGEST_SAKNAS'] as const

export type BildkontrollUtfall = (typeof BILDKONTROLL_UTFALL)[number]

export type Bildkontroll = {
  imageId: string
  filename: string
  utfall: BildkontrollUtfall
  /** Tidpunkten kontrollen utfördes. Utfallet gäller den, inte "alltid". */
  kontrolleradAt: Date
  /** Digesten som lagrades vid uppladdningen. `null` = ingen fanns. */
  forvantadDigest: string | null
  /** Digesten över de bytes som lästes nu. `null` = inget lästes. */
  faktiskDigest: string | null
}

/** Den form kontrollen behöver ur en bildrad. Avsiktligt smalare än Prismas. */
export type KontrollerbarBild = {
  id: string
  filename: string
  storageKey: string
  contentSha256: string | null
}

@Injectable()
export class InspectionImageIntegrityService {
  private readonly logger = new Logger(InspectionImageIntegrityService.name)

  constructor(private readonly storage: StorageService) {}

  /**
   * Kontrollerar en bild och svarar med ett av fyra utfall.
   *
   * Ett fel från lagringen blir `SAKNAS` och inte ett kastat undantag: en
   * borttappad bilaga ska visas som borttappad i protokollet, inte fälla hela
   * visningen av det. Felet loggas, så att en trasig lagring inte blir tyst.
   */
  async kontrolleraBild(bild: KontrollerbarBild): Promise<Bildkontroll> {
    const kontrolleradAt = new Date()

    if (!bild.contentSha256) {
      return {
        imageId: bild.id,
        filename: bild.filename,
        utfall: 'DIGEST_SAKNAS',
        kontrolleradAt,
        forvantadDigest: null,
        faktiskDigest: null,
      }
    }

    let faktiskDigest: string
    try {
      const bytes = await this.storage.getFileBuffer(bild.storageKey)
      faktiskDigest = createHash('sha256').update(bytes).digest('hex')
    } catch (fel) {
      this.logger.warn(
        `Bildkontroll: kunde inte läsa ${bild.storageKey} (bild ${bild.id}): ${
          fel instanceof Error ? fel.message : String(fel)
        }`,
      )
      return {
        imageId: bild.id,
        filename: bild.filename,
        utfall: 'SAKNAS',
        kontrolleradAt,
        forvantadDigest: bild.contentSha256,
        faktiskDigest: null,
      }
    }

    return {
      imageId: bild.id,
      filename: bild.filename,
      utfall: faktiskDigest === bild.contentSha256 ? 'VERIFIERAD' : 'AVVIKANDE',
      kontrolleradAt,
      forvantadDigest: bild.contentSha256,
      faktiskDigest,
    }
  }

  /**
   * Kontrollerar samtliga bilder i ett protokoll.
   *
   * Seriellt med flit. Ett protokoll har storleksordningen tio bilagor, och tio
   * samtidiga hämtningar mot lagringen köar ändå — medan en `Promise.all` över
   * en obegränsad mängd är ett självmål den dagen någon laddar upp hundra.
   */
  async kontrolleraBilder(bilder: KontrollerbarBild[]): Promise<Bildkontroll[]> {
    const utfall: Bildkontroll[] = []
    for (const bild of bilder) {
      utfall.push(await this.kontrolleraBild(bild))
    }
    return utfall
  }

  /**
   * Sammanfattar en mängd utfall till EN rad som går att visa i en lista.
   *
   * Ordningen är strikt: ett enda `AVVIKANDE` färgar hela protokollet, därefter
   * `SAKNAS`, därefter `DIGEST_SAKNAS`. `VERIFIERAD` kräver att ALLA bilder
   * verifierades — ett protokoll där nio av tio stämmer och en saknas är inte
   * verifierat, det är delvis okänt.
   *
   * Ett protokoll UTAN bilder får `INGA_BILDER` och inte `VERIFIERAD`: det finns
   * ingenting att verifiera, och tomhet är inget godkännande.
   */
  sammanfatta(utfall: Bildkontroll[]): BildkontrollUtfall | 'INGA_BILDER' {
    if (utfall.length === 0) return 'INGA_BILDER'
    if (utfall.some((u) => u.utfall === 'AVVIKANDE')) return 'AVVIKANDE'
    if (utfall.some((u) => u.utfall === 'SAKNAS')) return 'SAKNAS'
    if (utfall.some((u) => u.utfall === 'DIGEST_SAKNAS')) return 'DIGEST_SAKNAS'
    return 'VERIFIERAD'
  }
}
