#!/usr/bin/env python3
"""Require a genuinely failing behavioral test for each weakened implementation."""
from pathlib import Path
import subprocess
import sys

test = Path(__file__).with_name('test_start.py')
for mutant, case, reason in (
    ('migration', 'test_crash_restarts_through_gate_without_migration', 'MIGRATOR_STARTED'),
    ('hash', 'test_declared_content', 'changed declared content started app'),
):
    r = subprocess.run([sys.executable, str(test), '--mutant', mutant,
                        'RuntimeTests.' + case], capture_output=True, text=True, timeout=120)
    output = r.stdout + r.stderr
    print(output, end='')
    if r.returncode == 0 or 'AssertionError:' not in output or reason not in output:
        raise SystemExit('NEGATIVE_CONTROL_FAIL ' + mutant + ': missing expected behavioral failure')
    print('NEGATIVE_CONTROL_CAUGHT ' + mutant + ' exit=' + str(r.returncode))
