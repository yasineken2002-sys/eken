import { Injectable, Logger, BadRequestException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AiUsageService } from '../ai/usage/ai-usage.service'
import { AiQuotaService } from '../ai/usage/ai-quota.service'
import { AI_MODELS } from '../ai/ai.config'

// Mirror av ContractScannerService — Claude läser PDF:en direkt som
// document-block (ingen separat pdf-parse-pipeline). Anropas synkront
// från reconciliation-flödet; en typisk bankutdrags-PDF (3–5 sidor,
// 30–80 transaktioner) tar 8–20 sek genom Sonnet 4.5.

const PARSER_MODEL = AI_MODELS.VISION_CONTRACT

// Generös max — vi ber Claude returnera ett potentiellt långt JSON-objekt
// (50+ transaktioner × ~100 tokens vardera). Empiriskt räcker ~6k för
// realistiska kontoutdrag; vi sätter 8k för marginal.
const MAX_TOKENS = 8192

export interface ParsedTransaction {
  date: string // YYYY-MM-DD
  description: string
  ocr: string | null
  amount: number // positivt = inbetalning
  isIncoming: boolean
}

export interface ParsedBankStatement {
  bank: string | null
  accountNumber: string | null
  periodStart: string | null // YYYY-MM-DD
  periodEnd: string | null
  transactions: ParsedTransaction[]
}

const PROMPT = `Du är en svensk bankutdrag-tolkare. Extrahera ALLA transaktioner från detta PDF-kontoutdrag.

Svara ENDAST med ett JSON-objekt, ingen annan text, inga kodblock, inga kommentarer.

Schema:
{
  "bank": "Swedbank" | "SEB" | "Nordea" | "Handelsbanken" | "Annan" eller null,
  "accountNumber": "kontonummer som sträng" eller null,
  "periodStart": "YYYY-MM-DD" eller null,
  "periodEnd": "YYYY-MM-DD" eller null,
  "transactions": [
    {
      "date": "YYYY-MM-DD",
      "description": "Beskrivning från utdraget",
      "ocr": "OCR-nummer som sträng" eller null,
      "amount": tal med decimalpunkt (positivt för inbetalningar),
      "isIncoming": true för inbetalning, false för uttag
    }
  ]
}

REGLER:
- Inkludera ENDAST transaktionsrader. Hoppa över sidhuvuden, sidfötter, ingående/utgående saldo, summor.
- OCR-nummer är typiskt 10–25 siffror — leta i referens-/beskrivningsfältet, särskilt på rader som börjar med "Bg-inbet" eller "Bgmax".
- Hitta inte på OCR-nummer. Om raden saknar OCR → null.
- Belopp: använd PUNKT som decimaltecken. Inbetalningar är positiva, uttag/avgifter är negativa.
- Datum: konvertera alla svenska format till YYYY-MM-DD.
- Beskrivningen ska vara tagen ordagrant från utdraget (eventuellt trimmad till max 120 tecken).
- Om kontoutdraget inte innehåller några transaktioner, returnera \`"transactions": []\`.

Returnera ENDAST JSON-objektet, ingenting annat.`

@Injectable()
export class PdfStatementParserService {
  private readonly logger = new Logger(PdfStatementParserService.name)

  constructor(
    private readonly config: ConfigService,
    private readonly usage: AiUsageService,
    private readonly quota: AiQuotaService,
  ) {}

  async parse(
    fileBuffer: Buffer,
    organizationId: string,
    userId: string | null,
  ): Promise<ParsedBankStatement> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY')
    if (!apiKey) {
      throw new BadRequestException(
        'AI-tolkning av PDF-kontoutdrag är inte konfigurerad. Kontakta administratören.',
      )
    }

    // Org-wide daglig kostnadscap — skydd mot upprepade misslyckade
    // PDF-uppladdningar som annars kan kosta pengar via tokens. Manuella
    // kvoten räknar inte denna typ av automatik (samma policy som
    // ContractScannerService).
    await this.quota.checkOrgDailyCostCap(organizationId)

    const base64 = fileBuffer.toString('base64')

    const body = {
      model: PARSER_MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: 'user' as const,
          content: [
            {
              type: 'document' as const,
              source: {
                type: 'base64' as const,
                media_type: 'application/pdf' as const,
                data: base64,
              },
            },
            { type: 'text' as const, text: PROMPT },
          ],
        },
      ],
    }

    let response: Response
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new BadRequestException(
        'Kunde inte ansluta till AI-tjänsten. Kontrollera nätverket och försök igen.',
      )
    }

    if (!response.ok) {
      const errBody = await response.text().catch(() => 'Okänt fel')
      this.logger.error(`Anthropic API error ${response.status}: ${errBody}`)
      throw new BadRequestException(
        'Kunde inte tolka PDF-kontoutdraget. Kontrollera att filen är ett läsbart kontoutdrag och försök igen.',
      )
    }

    let data: {
      content: Array<{ type: string; text: string }>
      usage?: {
        input_tokens?: number
        output_tokens?: number
        cache_creation_input_tokens?: number
        cache_read_input_tokens?: number
      }
    }
    try {
      data = (await response.json()) as typeof data
    } catch {
      throw new BadRequestException('Kunde inte tolka AI-svaret. Försök igen.')
    }

    // Fire-and-forget — bristande loggning får aldrig blockera parsningen.
    void this.usage
      .logUsage({
        organizationId,
        userId: userId ?? null,
        endpoint: 'pdf-bank-statement-parse',
        model: PARSER_MODEL,
        usage: data.usage ?? null,
        isAutomated: true,
        source: 'bank_statement_pdf',
      })
      .catch(() => undefined)

    const text = data.content?.[0]?.text ?? ''
    const clean = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim()

    let parsed: unknown
    try {
      parsed = JSON.parse(clean)
    } catch {
      throw new BadRequestException(
        'AI:n gav ett svar som inte kunde tolkas som JSON. Försök ladda upp filen igen.',
      )
    }

    return this.validate(parsed)
  }

  // Strikt validering — AI kan i kantfall returnera felaktiga typer.
  // Vi accepterar bara svar som är säkra att skriva som BankTransaction.
  private validate(input: unknown): ParsedBankStatement {
    if (!input || typeof input !== 'object') {
      throw new BadRequestException('AI-svaret hade fel struktur (förväntade ett objekt).')
    }
    const obj = input as Record<string, unknown>
    const txRaw = obj.transactions
    if (!Array.isArray(txRaw)) {
      throw new BadRequestException(
        'AI-svaret saknade en lista med transaktioner — försök ladda upp PDF:en igen.',
      )
    }

    const transactions: ParsedTransaction[] = []
    for (const row of txRaw) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const date = typeof r.date === 'string' ? r.date.trim() : null
      const description = typeof r.description === 'string' ? r.description.trim() : ''
      const amount = typeof r.amount === 'number' ? r.amount : parseFloat(String(r.amount))
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
      if (!Number.isFinite(amount)) continue
      const ocrVal = r.ocr
      const ocr = typeof ocrVal === 'string' && ocrVal.trim().length > 0 ? ocrVal.trim() : null
      const isIncoming = typeof r.isIncoming === 'boolean' ? r.isIncoming : amount > 0
      transactions.push({ date, description, ocr, amount, isIncoming })
    }

    const stringOrNull = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
    const dateStringOrNull = (v: unknown): string | null => {
      const s = stringOrNull(v)
      return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null
    }

    return {
      bank: stringOrNull(obj.bank),
      accountNumber: stringOrNull(obj.accountNumber),
      periodStart: dateStringOrNull(obj.periodStart),
      periodEnd: dateStringOrNull(obj.periodEnd),
      transactions,
    }
  }
}
