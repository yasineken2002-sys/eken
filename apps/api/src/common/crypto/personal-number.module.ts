import { Global, Module } from '@nestjs/common'
import { SigningCryptoService } from '../../signing/signing-crypto.service'
import { PersonalNumberService } from './personal-number.service'
import { PiiCoherenceService } from './pii-coherence.service'

/**
 * Gör personnummer-kryptot tillgängligt i hela appen.
 *
 * @Global med flit: personnummer skrivs och läses i sju moduler (tenants,
 * customers, leases, import, contracts, collections, tenant-portal, ai/tools).
 * Alternativet — att importera modulen i var och en — gör det lätt att glömma
 * en och lätt att av misstag lösa problemet med klartext i stället.
 *
 * `SigningCryptoService` provideras här på nytt i stället för att SigningModule
 * importeras: SigningModule:s SIGNING_PROVIDER-factory kastar med flit vid boot
 * när SIGNING_ENABLED=true utan skarp adapter, och den fail-fasten hör till
 * signeringsfunktionen — inte till att spara en hyresgäst. Klassen är samma
 * klass, så nyckel-, IV- och authtag-hanteringen är bokstavligen densamma.
 *
 * `PiiCoherenceService` hör hemma här och inte i SigningModule av samma skäl:
 * den kontrollerar att nyckeln och peppern fortfarande hör ihop med datan, och
 * den datan skrivs av tenants/customers långt utanför signeringsflödet. Den
 * exporteras inte — ingen anropar den, den larmar av sig själv vid uppstart.
 */
@Global()
@Module({
  providers: [SigningCryptoService, PersonalNumberService, PiiCoherenceService],
  exports: [PersonalNumberService],
})
export class PersonalNumberModule {}
