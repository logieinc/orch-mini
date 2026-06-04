#!/usr/bin/env node
// Shim cross-platform: registra el loader CJS de tsx y require el cli TS directo.
// Evita spawn-ear `tsx` por path (que se rompe en Windows con .cmd vs binario raw).
const path = require('node:path');

require('tsx/cjs');
require(path.join(__dirname, '..', 'src', 'cli.ts'));
