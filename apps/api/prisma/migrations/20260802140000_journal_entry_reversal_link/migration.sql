-- Rättelsekedja: länk från ett rättelseverifikat till det verifikat det rättar
-- (T5 PR1c2).
--
-- Ett verifikat ändras aldrig i efterhand. En felaktig post rättas med ett nytt,
-- omvänt verifikat daterat den dag felet upptäcktes — originalet står kvar precis
-- som det var. Den här länken är det som gör paret läsbart åt båda håll i
-- efterhand: "vad rättar det här?" och "är det här redan rättat?".
--
-- Konventionen sourceId = 'entry-reversal:<id>' bär redan samma information, men
-- som en sträng man måste tolka. En riktig relation går att fråga på.

-- AlterTable
-- NULLABLE: allt befintligt (och alla verifikat som inte är rättelser) har ingen
-- länk och ska inte ha någon. Att lägga till kolumnen rör ingen rad.
ALTER TABLE "JournalEntry" ADD COLUMN "reversalOfEntryId" TEXT;

-- CreateIndex
-- UNIKT: ett verifikat får rättas EN gång. En andra rättelse hade tagit ut den
-- första och lämnat tre verifikat där en rättelse skedde — historiken blir brus,
-- och läsbar historik är hela poängen med rättelseposten. Den som råkat rätta fel
-- reverserar i stället SIN rättelse, som i sin tur bara får rättas en gång.
--
-- Indexet är också spärren mot dubbelklick: två samtidiga rättelser av samma
-- verifikat kan inte båda landa.
CREATE UNIQUE INDEX "JournalEntry_reversalOfEntryId_key" ON "JournalEntry"("reversalOfEntryId");

-- AddForeignKey
-- SET NULL, aldrig CASCADE: verifikat raderas aldrig, men skulle originalet mot
-- förmodan försvinna får rättelsen inte följa med i fallet — den är egen
-- räkenskapsinformation.
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfEntryId_fkey" FOREIGN KEY ("reversalOfEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
