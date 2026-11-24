#!/usr/bin/env node
// Explicit child environment: Electron flags must not inherit a CLI's Node mode.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2), opt = name => { const i = args.indexOf(`--${name}`); return i < 0 ? undefined : args[i + 1]; };
const paths = Object.fromEntries(['app', 'home', 'user-data', 'workspace'].map(name => [name, opt(name)]));
for (const [key, value] of Object.entries(paths)) if (!value || !path.isAbsolute(value) || /["\r\n\0]/.test(value)) throw new Error(`invalid ${key} path`);
const exe = path.join(paths.app, 'DeepSeek Harness.exe');
if (!fs.existsSync(exe)) throw new Error('official Desktop executable is missing');
const env = { ...process.env, DSH_HOME: paths.home, LEADERTEAM_MAGPIE_KEY: process.env.LEADERTEAM_MAGPIE_KEY || 'magpie-local' };
for (const key of Object.keys(env)) if (['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR'].includes(key.toUpperCase())) delete env[key];
const child = spawn(exe, [`--user-data-dir=${paths['user-data']}`], { cwd: paths.workspace, env, detached: true, windowsHide: false, stdio: 'ignore' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.unref();
console.log(`Official LeaderTeam Desktop started (PID ${child.pid}).`);
