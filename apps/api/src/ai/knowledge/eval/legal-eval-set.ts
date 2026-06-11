import type { LegalEvalCase } from './legal-eval.types'

/**
 * Eval-set för hyresjuridik (Version 1 — hyresjuristen). ~20–30 verkliga
 * hyresvärdsfrågor med facit: rätt källa (verifierad mot LEGAL_KNOWLEDGE),
 * kärnsvar, och om svaret bör rekommendera jurist.
 *
 * VIKTIGT: paragraferna i `expectedSources` verifieras av legal-eval-set.spec.ts
 * mot den faktiska lagtexten — peka aldrig på en paragraf som inte finns.
 * Lätt att utöka: lägg till fler objekt; testet fångar självmotsägelser.
 *
 * Källverifiering gjord mot .claude/knowledge/lagar/hyreslagen.md (JB 12 kap),
 * räntelagen och diskrimineringslagen. Topiken är människo-verifierad; testet
 * verifierar endast att de citerade paragraferna existerar.
 */
export const LEGAL_EVAL_SET: LegalEvalCase[] = [
  // ── Besittningsskydd (inkl. regressionsfallet från #129) ───────────────────
  {
    id: 'besittningsskydd-forstahand-1ar',
    category: 'besittningsskydd',
    question:
      'Kan jag säga upp min hyresgäst? Hon har ett förstahands-bostadskontrakt och har bott här i ett år.',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['45', '46'] }],
    expectedAnswerCore:
      'En förstahands-bostadshyresgäst har besittningsskydd (förlängningsrätt) från början av hyresförhållandet — inte först efter två år. Du kan inte fritt säga upp henne; det krävs sakliga skäl enligt förlängningsgrunderna och frågan kan prövas av hyresnämnden.',
    shouldRecommendJurist: true,
    expectedOutcome: 'answerable',
    isRegression: true,
    note: 'Regressionsfall för #129: "efter 2 år"-felet får aldrig återkomma.',
  },
  {
    id: 'besittningsskydd-andrahand-2ar',
    category: 'besittningsskydd',
    question: 'Min andrahandshyresgäst — när får hon besittningsskydd mot mig?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['45'] }],
    expectedAnswerCore:
      'Vid andrahandsupplåtelse för självständigt brukande får hyresgästen besittningsskydd först när hyresförhållandet har varat längre än två år i följd. Tvåårsregeln gäller alltså andrahand — inte förstahand.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },
  {
    id: 'besittningsskydd-lokal',
    category: 'besittningsskydd',
    question: 'Har min lokalhyresgäst (ett företag) besittningsskydd?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['57'] }],
    expectedAnswerCore:
      'Lokalhyresgäster har inte direkt besittningsskydd, men ett indirekt skydd: vid obefogad uppsägning kan hyresgästen ha rätt till ersättning. Bedömningen är komplex.',
    shouldRecommendJurist: true,
    expectedOutcome: 'answerable',
  },
  {
    id: 'besittningsskydd-eget-behov',
    category: 'besittningsskydd',
    question: 'Jag behöver lägenheten för eget bruk — kan jag säga upp hyresgästen då?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['46'] }],
    expectedAnswerCore:
      'Eget behov kan i vissa fall vara skäl mot förlängning, men det är starkt fakta- och skälighetsberoende och gäller långt ifrån alltid. Utgången avgörs ytterst av hyresnämnden.',
    shouldRecommendJurist: true,
    expectedOutcome: 'needs-jurist',
  },

  // ── Uppsägning & delgivning ────────────────────────────────────────────────
  {
    id: 'uppsagningstid-bostad-tillsvidare',
    category: 'uppsägning',
    question: 'Hur lång uppsägningstid gäller för ett tillsvidareavtal på en bostadslägenhet?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['4'] }],
    expectedAnswerCore:
      'För bostadslägenhet som hyrs på obestämd tid är uppsägningstiden tre månader (kan vara längre vid hyresvärdens uppsägning i vissa fall).',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },
  {
    id: 'uppsagningstid-lokal',
    category: 'uppsägning',
    question: 'Vilken uppsägningstid gäller för en lokal på tillsvidareavtal?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['4'] }],
    expectedAnswerCore:
      'För lokal på obestämd tid är uppsägningstiden nio månader, om inte längre tid avtalats.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },
  {
    id: 'uppsagning-skriftlig-form',
    category: 'uppsägning',
    question: 'Måste en uppsägning vara skriftlig?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['8'] }],
    expectedAnswerCore:
      'En uppsägning ska vara skriftlig om hyresförhållandet har varat längre än tre månader i följd. (Hyresgästen kan i vissa fall säga upp muntligt mot skriftligt erkännande.)',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },
  {
    id: 'delgivning-uppsagning',
    category: 'delgivning',
    question: 'Hur ser jag till att en uppsägning blir korrekt delgiven hyresgästen?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['8', '63'] }],
    expectedAnswerCore:
      'Uppsägningen ska vara skriftlig och nå hyresgästen. Vissa meddelanden anses lämnade när de avsänts i rekommenderat brev till mottagarens vanliga adress. Formfel kan göra uppsägningen verkningslös.',
    shouldRecommendJurist: true,
    expectedOutcome: 'answerable',
  },

  // ── Kontrakt & form ────────────────────────────────────────────────────────
  {
    id: 'kontrakt-skriftligt',
    category: 'kontrakt',
    question: 'Måste hyresavtalet vara skriftligt?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['2'] }],
    expectedAnswerCore:
      'Hyresavtal ska upprättas skriftligen om hyresvärden eller hyresgästen begär det. Skriftligt avtal rekommenderas alltid.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },
  {
    id: 'kontrakt-tidsbestamt-forlangning',
    category: 'kontrakt',
    question: 'Mitt tidsbestämda avtal löper ut snart — förlängs det automatiskt?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['3'] }],
    expectedAnswerCore:
      'Ett tidsbestämt avtal kan anses förlängt på obestämd tid om det inte sägs upp i tid eller om hyresgästen bor kvar utan att anmodas flytta. Beror på avtalets villkor.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },

  // ── Hyra, betalning & dröjsmål ─────────────────────────────────────────────
  {
    id: 'hyra-forfallodag',
    category: 'hyra',
    question: 'När ska hyran senast betalas?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['20'] }],
    expectedAnswerCore:
      'Saknas avtal om betalningstid ska hyran betalas senast sista vardagen före varje kalendermånads början (förskott).',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },
  {
    id: 'drojsmalsranta-sen-hyra',
    category: 'hyra',
    question: 'Vilken dröjsmålsränta får jag ta ut på en sen hyra?',
    expectedSources: [{ lawId: 'ranteslagen', paragraphs: ['4', '6'] }],
    expectedAnswerCore:
      'Dröjsmålsränta utgår enligt räntelagen — referensräntan plus åtta procentenheter — och löper från förfallodagen när den är bestämd i förväg.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
    note: 'Cross-law: räntelagen, inte hyreslagen.',
  },

  // ── Förverkande & störningar ───────────────────────────────────────────────
  {
    id: 'forverkande-obetald-hyra',
    category: 'förverkande',
    question: 'Hyresgästen har inte betalat hyran på två månader — kan jag vräka direkt?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['42', '43', '44'] }],
    expectedAnswerCore:
      'Nej, inte direkt. Hyresdröjsmål kan göra hyresrätten förverkad, men hyresgästen har en återvinningsmöjlighet: betalar hyresgästen inom viss frist efter delgiven underrättelse (och socialnämnden underrättats för bostad) får hen bo kvar. Processen är formstyrd.',
    shouldRecommendJurist: true,
    expectedOutcome: 'answerable',
  },
  {
    id: 'storning-uppsagning',
    category: 'störningar',
    question: 'Grannarna klagar på en störande hyresgäst — kan jag säga upp honom?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['25', '25 a'] }],
    expectedAnswerCore:
      'Vid störningar i boendet ska hyresvärden först uppmana hyresgästen till rättelse och, för bostad, underrätta socialnämnden — innan uppsägning på den grunden. Endast vid särskilt allvarliga störningar finns undantag.',
    shouldRecommendJurist: true,
    expectedOutcome: 'answerable',
  },

  // ── Andrahand ──────────────────────────────────────────────────────────────
  {
    id: 'andrahand-utan-samtycke',
    category: 'andrahand',
    question: 'Min hyresgäst hyr ut i andra hand utan att fråga mig — vad gäller?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['39', '40'] }],
    expectedAnswerCore:
      'Andrahandsupplåtelse för självständigt brukande kräver normalt hyresvärdens samtycke eller hyresnämndens tillstånd. Utan det kan hyresrätten riskera förverkande efter tillsägelse om rättelse inte sker.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },

  // ── Hyressättning & hyreshöjning ───────────────────────────────────────────
  {
    id: 'hyreshojning-formkrav',
    category: 'hyreshöjning',
    question: 'Hur höjer jag hyran på rätt sätt?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['54', '54 a'] }],
    expectedAnswerCore:
      'Hyreshöjning sker genom ett skriftligt meddelande som måste innehålla vissa lagstadgade uppgifter; godtas det inte kan frågan hänskjutas till hyresnämnden. Formkraven är tvingande.',
    shouldRecommendJurist: true,
    expectedOutcome: 'answerable',
  },
  {
    id: 'hyressattning-bruksvarde',
    category: 'hyressättning',
    question: 'Hur mycket får jag egentligen ta i hyra för en bostad?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['55'] }],
    expectedAnswerCore:
      'För bostad gäller bruksvärdesprincipen: hyran är inte skälig om den är påtagligt högre än hyran för likvärdiga lägenheter. Tvist prövas av hyresnämnden.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },

  // ── Tillträde ──────────────────────────────────────────────────────────────
  {
    id: 'tilltrade-arbeten',
    category: 'tillträde',
    question: 'Får jag gå in i lägenheten för att utföra förbättringsarbeten?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['26'] }],
    expectedAnswerCore:
      'Mindre brådskande förbättringsarbeten får utföras efter tillsägelse i god tid (minst en månad), om de inte vållar väsentligt hinder. Akuta åtgärder och tillsyn har egna regler.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
  },

  // ── Diskriminering vid hyresgästval ────────────────────────────────────────
  {
    id: 'hyresgastval-diskriminering',
    category: 'diskriminering',
    question: 'Får jag välja bort en sökande hyresgäst på grund av etnicitet eller ålder?',
    expectedSources: [{ lawId: 'diskrimineringslagen', paragraphs: ['12'] }],
    expectedAnswerCore:
      'Nej. Den som tillhandahåller bostäder åt allmänheten får inte diskriminera på grund av de skyddade grunderna (kön, etnicitet, religion, funktionsnedsättning m.fl.). Sakliga, konsekvent tillämpade urvalskriterier är tillåtna.',
    shouldRecommendJurist: false,
    expectedOutcome: 'answerable',
    note: 'Cross-law: diskrimineringslagen 2 kap 12 §.',
  },

  // ── Behöver jurist / ingen exakt regel (för miss-grinden i 2.3) ────────────
  {
    id: 'deposition-storlek',
    category: 'deposition',
    question: 'Hur stor deposition (säkerhet) får jag kräva av en hyresgäst?',
    expectedSources: [],
    expectedAnswerCore:
      'Hyreslagen reglerar inte uttryckligen storleken på en säkerhetsdeposition — det bygger på praxis och avtal. Ange därför inte ett bestämt maxbelopp som lag; rekommendera juridisk avstämning.',
    shouldRecommendJurist: true,
    expectedOutcome: 'no-clear-rule',
    note: 'Miss-grind: ingen exakt lagregel i kunskapsbasen — får ej besvaras med påhittad siffra.',
  },
  {
    id: 'altan-utan-lov-tvist',
    category: 'tvist',
    question:
      'Hyresgästen har byggt en altan på gården utan lov och vägrar ta bort den. Kan jag säga upp henne?',
    expectedSources: [{ lawId: 'hyreslagen', paragraphs: ['24', '42'] }],
    expectedAnswerCore:
      'Frågan rör hyresgästens vårdplikt och eventuellt förverkande, men utgången är starkt beroende av omständigheterna och en skälighetsbedömning. Detta är en tolkningsfråga.',
    shouldRecommendJurist: true,
    expectedOutcome: 'needs-jurist',
    note:
      'Facit vidgat §24 → §24+§42 (juristbedömt 2026-06-11): frågan gäller UPPSÄGNING, ' +
      '§24 är grundnormen (vårdplikt) men säger inget om uppsägning — den vägen går via ' +
      '§42 (förverkande), närmast p.9 (vanvård på annat sätt). §42 är därför korrekt ' +
      'källa, inte bara försvarbar. MEN förverkande är inte automatiskt: p.9 kräver ' +
      'rättelse efter uppmaning, och sista stycket undantar ringa betydelse — därav ' +
      'needs-jurist (skälighetsbedömning).',
  },
  {
    id: 'agandeform-skatt-paketering',
    category: 'skatt',
    question:
      'Ska jag äga fastigheten privat eller via ett aktiebolag — vad är bäst skattemässigt?',
    expectedSources: [],
    expectedAnswerCore:
      'Detta är en skatte-/bolagsstrukturfråga utanför hyresjuridiken och beror på din helhetssituation. Rekommendera kontakt med revisor/skatterådgivare; ange inga exakta skattesatser som säker fakta.',
    shouldRecommendJurist: true,
    expectedOutcome: 'needs-jurist',
    note: 'Miss-grind: utanför kunskapsbasen — revisor/skatterådgivare, inte påhittade siffror.',
  },
]
