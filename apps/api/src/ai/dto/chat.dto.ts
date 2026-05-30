import { IsString, IsOptional, IsUUID, MinLength, MaxLength } from 'class-validator'

// Övre gräns på ett chattmeddelande. SECURITY (H4): utan tak kan en enda
// request skicka godtyckligt stora prompts → orimliga Anthropic-tokenkostnader
// och en DoS-vektor mot kvot/kostnadstaket. 4000 tecken räcker gott för en
// fråga; längre underlag hör hemma i bilagor/portföljkontexten, inte i prompten.
export const CHAT_MESSAGE_MAX_LENGTH = 4000

export class ChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MESSAGE_MAX_LENGTH)
  message!: string

  @IsUUID()
  @IsOptional()
  conversationId?: string
}
