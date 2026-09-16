#!/usr/bin/env python3
"""Verify saved Railway deployment metadata, not serviceInstance settings.

Input: query { deployment(id:...) { id status deploymentStopped instances {
id status } meta } }. No credentials/network/mutations; reject missing fields.
"""
import argparse
import hashlib
import json
from pathlib import Path


def verify(response, deployment_id, revision, command, role):
    if response.get('errors'):
        raise ValueError('GraphQL errors')
    d = response['data']['deployment']
    if d['id'] != deployment_id or d['deploymentStopped'] is not False:
        raise ValueError('wrong or stopped deployment')
    m = d['meta']
    if m['commitHash'] != revision or m['configFile'] != '/railway.json':
        raise ValueError('wrong revision or config file')
    manifest = m['serviceManifest']
    if manifest['build']['builder'] != 'DOCKERFILE':
        raise ValueError('wrong builder')
    config = manifest['deploy']
    if config['startCommand'] != command:
        raise ValueError('applied start command differs from reviewed package')
    if config['preDeployCommand'] is not None or config['numReplicas'] != 1:
        raise ValueError('pre-deploy command or replica count differs')
    if config['cronSchedule'] is not None or config['sleepApplication'] is not False:
        raise ValueError('cron or sleeping service')
    if role == 'app':
        if (config['restartPolicyType'], config['restartPolicyMaxRetries']) != ('ON_FAILURE', 3):
            raise ValueError('app applied policy must be ON_FAILURE/3')
        if config['healthcheckPath'] != '/v1/health':
            raise ValueError('app healthcheck differs')
    else:
        # Railway normalizes NEVER's unused maxRetries=0 to null.
        if config['restartPolicyType'] != 'NEVER' or config['restartPolicyMaxRetries'] not in (None, 0):
            raise ValueError('migrator applied policy must be NEVER/null-or-0')
        if config['healthcheckPath'] is not None:
            raise ValueError('migrator must have no healthcheck')
    return {
        'deployment': d['id'], 'revision': revision, 'role': role,
        'appliedPolicy': config['restartPolicyType'],
        'appliedMaxRetries': config['restartPolicyMaxRetries'],
        'startCommandSha256': hashlib.sha256(command.encode()).hexdigest(),
        'status': d['status'], 'instances': d['instances'],
        'scope': 'configuration only; observe process, logs and health separately',
    }


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('metadata', type=Path)
    p.add_argument('--deployment', required=True)
    p.add_argument('--revision', required=True)
    p.add_argument('--command', type=Path, required=True)
    p.add_argument('--role', choices=('app', 'migrator'), required=True)
    a = p.parse_args()
    try:
        result = verify(json.loads(a.metadata.read_text()), a.deployment,
                        a.revision, a.command.read_text(), a.role)
    except (KeyError, TypeError, ValueError) as e:
        raise SystemExit('APPLIED_FAIL ' + str(e))
    print(json.dumps(result, indent=2))
