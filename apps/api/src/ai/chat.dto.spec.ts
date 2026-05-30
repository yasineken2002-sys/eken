/**
 * SECURITY (H4) — ChatDto.message har ett övre teckental (kostnads-/DoS-skydd).
 *
 * Verifierar att class-validator:
 *   • avvisar ett meddelande > CHAT_MESSAGE_MAX_LENGTH tecken
 *   • avvisar tomt meddelande (MinLength(1))
 *   • släpper igenom ett meddelande på exakt gränsen
 */

import 'reflect-metadata'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { ChatDto, CHAT_MESSAGE_MAX_LENGTH } from './dto/chat.dto'

async function errorsFor(message: string) {
  const dto = plainToInstance(ChatDto, { message })
  return validate(dto)
}

describe('ChatDto.message MaxLength (H4)', () => {
  it('avvisar > CHAT_MESSAGE_MAX_LENGTH tecken', async () => {
    const errors = await errorsFor('a'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1))
    const messageError = errors.find((e) => e.property === 'message')
    expect(messageError).toBeDefined()
    expect(messageError?.constraints).toHaveProperty('maxLength')
  })

  it('avvisar tomt meddelande', async () => {
    const errors = await errorsFor('')
    expect(errors.find((e) => e.property === 'message')).toBeDefined()
  })

  it('släpper igenom ett meddelande på exakt gränsen', async () => {
    const errors = await errorsFor('a'.repeat(CHAT_MESSAGE_MAX_LENGTH))
    expect(errors.find((e) => e.property === 'message')).toBeUndefined()
  })
})
