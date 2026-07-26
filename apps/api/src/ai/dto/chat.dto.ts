import {
  IsString,
  IsOptional,
  IsUUID,
  MinLength,
  MaxLength,
  IsArray,
  ArrayMaxSize,
} from 'class-validator'

// Övre gräns på ett chattmeddelande. SECURITY (H4): utan tak kan en enda
// request skicka godtyckligt stora prompts → orimliga Anthropic-tokenkostnader
// och en DoS-vektor mot kvot/kostnadstaket. 4000 tecken räcker gott för en
// fråga; längre underlag hör hemma i bilagor/portföljkontexten, inte i prompten.
export const CHAT_MESSAGE_MAX_LENGTH = 4000

// Max antal bilagor per meddelande. Taket är LÅGT med flit: varje bilaga läses
// ur R2 och base64-kodas in i requesten, så antalet är den direkta hävstången
// på både request-storlek och tokenkostnad. Anthropics 32 MB-tak på hela
// requesten grindas i B3 — det här taket är den grova säkringen tills dess.
export const CHAT_MAX_ATTACHMENTS = 5

export class ChatDto {
  @IsString()
  @MinLength(1)
  @MaxLength(CHAT_MESSAGE_MAX_LENGTH)
  message!: string

  @IsUUID()
  @IsOptional()
  conversationId?: string

  /**
   * Id:n från `POST /v1/ai/attachments` (B1) — aldrig bytes. Bilagans innehåll
   * hämtas serversidan ur R2, vilket är hela poängen med den delade
   * uppladdningen: SSE-vägen kan bära id:n på en URL, men inte base64.
   */
  @IsArray()
  @ArrayMaxSize(CHAT_MAX_ATTACHMENTS)
  @IsUUID('4', { each: true })
  @IsOptional()
  attachmentIds?: string[]
}
