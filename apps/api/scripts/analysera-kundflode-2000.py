"""Oberoende omräkning av sparad integration. Endast Python-standardbiblioteket."""
import hashlib
import json
import re
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path


def analyse(folder):
    world = json.loads((folder / 'kund-och-facit.json').read_text())
    payments = {p['id']: p for p in world['betalningar']}
    notices = {n['id']: n for n in world['avier']}
    assert len(payments) == len(notices) == 2000
    months = {name: index + 1 for index, name in enumerate([
        'januari', 'februari', 'mars', 'april', 'maj', 'juni',
        'juli', 'augusti', 'september', 'oktober', 'november', 'december',
    ])}
    result = {}
    for arm in ('AGENT_AV', 'AGENT_PA'):
        report = json.loads((folder / f'{arm}.json').read_text())
        rows = report['rader']
        assert len(rows) == 2000 and {r['id'] for r in rows} == set(payments)
        counts = Counter()
        examples = []
        for row in rows:
            payment = payments[row['id']]
            assert row['facit'] == payment['facit']
            assert row['status'] in ('MATCHED', 'UNMATCHED'), row['id']
            counts['betalningar'] += 1
            allocation = row['allokeringar']
            incoming = Decimal(str(row['bankrad']['belopp'])) * 100
            assert incoming == payment['beloppOre']
            assert all(isinstance(a['beloppOre'], int) and a['beloppOre'] > 0 for a in allocation)
            assert sum(a['beloppOre'] for a in allocation) == (incoming if allocation else 0)
            assert bool(allocation) == (row['status'] == 'MATCHED')
            canon = lambda aa: sorted((a['avi'], a['beloppOre']) for a in aa)
            correct = bool(allocation) and not payment['facit']['granskningKravsAvUnderlaget'] and canon(allocation) == canon(payment['facit']['allokeringar'])
            assert correct == row['automatiskRatt']
            counts['godkanda_automatiska'] += correct
            counts['omatchade'] += row['status'] == 'UNMATCHED'
            target = notices[payment['facit']['avseddAvi']]
            wrong_household = any(notices[a['avi']]['hyresgast'] != target['hyresgast'] for a in allocation)
            wrong_period = bool(allocation) and payment['typ'] == 'OVERBETALNING' and any(a['avi'] != target['id'] for a in allocation)
            conflict_intended = bool(allocation) and payment['typ'] == 'MOTSTRIDIGA_IDENTIFIERARE' and all(a['avi'] == target['id'] for a in allocation)
            counts['fel_hushall'] += wrong_household
            counts['annan_period_an_angiven'] += wrong_period
            counts['avsedd_avi_trots_konflikt'] += conflict_intended
            counts['automatisk_med_kontrollbrist'] += bool(allocation) and not correct
            if wrong_household or wrong_period or conflict_intended:
                examples.append({
                    'id': row['id'], 'typ': payment['typ'],
                    'avseddAvi': target['id'], 'allokeringar': allocation,
                    'felHushall': wrong_household, 'felPeriod': wrong_period,
                    'konfliktMenAvseddAvi': conflict_intended,
                })
            counts['artal_som_ocr'] += row['bankrad'].get('rawOcr') == '2026'
            counts['artal_som_ocr_omatchad'] += row['bankrad'].get('rawOcr') == '2026' and row['status'] == 'UNMATCHED'
            if payment['typ'] not in ('NAMN_OCH_PERIOD', 'FELSKRIVEN_OCR'):
                continue
            # Informationsaudit, INTE ny matcher. Varken id eller facit väljer kandidaten.
            # Formatet är avsiktligt snävt. Säger inget om annan fritext eller verkliga namn.
            matches = []
            posts = row['underlag']['kandidater']
            for post in posts:
                name = post['motpartNamn']
                if not name:
                    continue
                match = re.fullmatch(r'Hyra ([a-zåäö]+) (\d{4}) ' + re.escape(name), row['bankrad']['text'], re.I)
                if not match or match[1] not in months:
                    continue
                prefix = f'AVI-{match[2]}-{months[match[1]]:02}-'
                if post['nummer'].startswith(prefix) and Decimal(str(post['utestaende'])) * 100 == incoming:
                    matches.append(post)
            counts['unik_namn_period_belopp'] += len(matches) == 1
            counts['unik_namn_period_belopp_ratt'] += len(matches) == 1 and matches[0]['nummer'] == target['nummer']
            counts['avsedd_avi_i_kandidater'] += any(p['nummer'] == target['nummer'] and p['id'] in row['referensstod']['kandidater'] for p in posts)
        counts['betalningar_med_granskningsbehov'] = counts['omatchade'] + counts['automatisk_med_kontrollbrist']
        assert counts['godkanda_automatiska'] == report['sammanfattning']['korrektAutomatiska']
        assert counts['betalningar_med_granskningsbehov'] == report['sammanfattning']['behovAvManskligInsats']
        assert counts['betalningar_med_granskningsbehov'] + counts['godkanda_automatiska'] == 2000
        result[arm] = {'matning': dict(counts), 'exempel': examples}
    assert result['AGENT_AV']['matning'] == result['AGENT_PA']['matning']
    return {
        'indata': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(folder.glob('*.json'))},
        'resultat': result,
        'begransning': 'Syntetisk efterhandsdiagnostik. Ingen ny matcher eller bokföringsåtgärd. Namn/period-auditen är utvecklingsdata, inte bevisad träffsäkerhet. Två kundkopior är samma 2 000 grundfall.',
    }


if __name__ == '__main__':
    folder = Path(sys.argv[1])
    output = Path(sys.argv[2])
    result = analyse(folder)
    with output.open('x') as file:
        json.dump(result, file, ensure_ascii=False, indent=2)
        file.write('\n')
    print(json.dumps({arm: data['matning'] for arm, data in result['resultat'].items()}, ensure_ascii=False, indent=2))
