#!/usr/bin/env python3
import json
import sys
from pathlib import Path

CONFIG = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/Users/iyen/.openclaw/openclaw.json')

with CONFIG.open() as f:
    data = json.load(f)

plugins = data.setdefault('plugins', {})
plugins.setdefault('load', {})
paths = plugins['load'].setdefault('paths', [])
path_value = '/Users/iyen/.openclaw/workspace/openclaw-runtime'
if path_value not in paths:
    paths.append(path_value)

slots = plugins.setdefault('slots', {})
slots['contextEngine'] = 'session-branch-engine'

entries = plugins.setdefault('entries', {})
entry = entries.setdefault('session-branch-engine', {})
entry.update({
    'enabled': True,
    'observeOnly': True,
    'softThreshold': 0.6,
    'flushThreshold': 0.75,
    'emergencyThreshold': 0.85,
    'toolOutputCharsClearThreshold': 40000,
    'recentWindowTurns': 8,
    'memoryOwn': {
        'enabled': True,
        'mode': 'async',
        'apiBase': 'http://127.0.0.1:8788',
        'disableHttp': False,
    },
    'subagent': {
        'preferForExploration': True,
        'minSignals': 2,
    },
})

print(json.dumps(data, indent=2))
