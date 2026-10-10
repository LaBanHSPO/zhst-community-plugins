import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { theme: { type: 'string' }, core: { type: 'string', default: 'baseline' } } });
const pluginSource = fileURLToPath(new URL('../', import.meta.url));
const themeSource = resolve(values.theme ?? resolve(pluginSource, '../../../zhst-community-themes/themes/erp-mini'));
const packageAt = async (directory) => JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
const pluginPackage = await packageAt(pluginSource);
const themePackage = await packageAt(themeSource);
const baseline = pluginPackage.devDependencies.emdash;
if (themePackage.dependencies.emdash !== baseline || themePackage.devDependencies['@emdash-cms/cloudflare'] !== baseline) {
  throw new Error('The plugin, theme and Cloudflare adapter must pin the same approved EmDash baseline.');
}

function command(args, cwd, env = process.env, capture = false) {
  const result = spawnSync('npm', args, { cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status}). ${capture ? result.stderr : ''}`);
  return result.stdout?.trim();
}
const version = values.core === 'baseline' ? baseline : values.core === 'latest'
  ? command(['view', 'emdash', 'dist-tags.latest'], pluginSource, process.env, true)
  : values.core;
if (!/^1\.\d+\.\d+$/.test(version)) throw new Error(`Core ${version} needs a reviewed compatibility/peer-range decision; this release targets stable EmDash 1.x.`);
if (command(['view', `@emdash-cms/cloudflare@${version}`, 'version'], pluginSource, process.env, true) !== version) {
  throw new Error(`A matching @emdash-cms/cloudflare@${version} release is required.`);
}
console.log(`ERP compatibility: Node ${process.version}; baseline ${baseline}; candidate ${version}; isolated copy, no deployment.`);

// Never install/update dependencies or bring private runtime state into the caller's checkout.
const excluded = new Set(['node_modules', '.git', 'dist', '.astro', '.local', '.emdash', '.wrangler', 'uploads', 'coverage', 'wrangler.json', 'wrangler.jsonc']);
const copySource = (source, destination) => cp(source, destination, { recursive: true, filter(path) {
  const name = basename(path);
  return !excluded.has(name) && !name.startsWith('.env') && !name.startsWith('.dev.vars') &&
    !/\.(?:db|sqlite|sqlite3)(?:-|$)/.test(name) && !/\.(?:tgz|pem|key|log)$/.test(name);
} });
const directory = await mkdtemp(join(tmpdir(), 'erp-mini-compat-'));
let server;
async function freePort() {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolveClose, reject) => reservation.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
async function stopServer() {
  const current = server;
  server = undefined;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  const exited = once(current, 'exit');
  current.kill('SIGTERM');
  const killTimer = setTimeout(() => current.kill('SIGKILL'), 5000);
  await exited;
  clearTimeout(killTimer);
}
async function checkServer(origin, label) {
  server.on('error', (error) => { console.error(error); });
  const deadline = Date.now() + 45_000;
  let home;
  while (Date.now() < deadline) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error(`${label} exited before readiness (${server.exitCode ?? server.signalCode}).`);
    try { home = await fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }); break; }
    catch { await new Promise((ready) => setTimeout(ready, 200)); }
  }
  if (!home || home.status !== 200) throw new Error(`${label} homepage failed: ${home?.status ?? 'readiness timeout'}`);
  await home.text();
  const denied = await fetch(`${origin}/_emdash/api/plugins/erp-mini/info`, {
    headers: { 'X-EmDash-Request': '1' }, redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  if (![401, 403].includes(denied.status)) throw new Error(`${label} private API must deny anonymous access, received ${denied.status}: ${await denied.text()}`);
  await denied.text();
  console.log(`PASS: ${label} homepage 200 and unauthenticated ERP denial ${denied.status}.`);
}
try {
  const plugin = join(directory, 'zhst-community-plugins/plugins/erp-mini');
  const theme = join(directory, 'zhst-community-themes/themes/erp-mini');
  await Promise.all([copySource(pluginSource, plugin), copySource(themeSource, theme)]);
  command(['ci', '--no-audit', '--no-fund'], plugin);
  if (version !== baseline) command(['install', '--save-dev', '--save-exact', `emdash@${version}`, '--no-audit', '--no-fund'], plugin);
  command(['run', 'check'], plugin);
  const pack = JSON.parse(command(['pack', '--json', '--pack-destination', directory], plugin, process.env, true));
  command(['ci', '--no-audit', '--no-fund'], theme);
  if (version !== baseline) {
    command(['install', '--save-exact', `emdash@${version}`, '--no-audit', '--no-fund'], theme);
    command(['install', '--save-dev', '--save-exact', `@emdash-cms/cloudflare@${version}`, '--no-audit', '--no-fund'], theme);
  }
  command(['install', '--save-exact', join(directory, pack[0].filename), '--no-audit', '--no-fund'], theme);

  const port = await freePort();
  const origin = `http://localhost:${port}`;
  const env = { ...process.env, EMDASH_SITE_URL: origin, ERP_DATA_DIR: '.local', ERP_CURRENCY: 'USD',
    HOST: '127.0.0.1', PORT: String(port), EMDASH_ENCRYPTION_KEY: `emdash_enc_v1_${randomBytes(32).toString('base64url')}`,
    WRANGLER_SEND_METRICS: 'false', CI: 'true' };
  command(['run', 'typecheck'], theme, env);
  command(['run', 'build'], theme, env);
  server = spawn(process.execPath, ['scripts/start.mjs'], { cwd: theme, env, stdio: ['ignore', 'inherit', 'inherit'] });
  await checkServer(origin, 'Built Node host');
  await stopServer();

  // Synthetic identifiers are confined to this disposable copy; --local forbids remote bindings.
  command(['run', 'cloudflare:configure', '--',
    '--name', 'erp-mini-compat-local',
    '--account-id', '11111111111111111111111111111111',
    '--database-id', '11111111-1111-4111-8111-111111111111',
    '--database-name', 'erp-mini-compat-local',
    '--bucket-name', 'erp-mini-compat-local',
    '--site-url', 'https://erp-mini-compat.example.invalid', '--currency', 'USD',
  ], theme, env);
  await writeFile(join(theme, '.dev.vars'), `EMDASH_ENCRYPTION_KEY=${env.EMDASH_ENCRYPTION_KEY}\n`, { mode: 0o600 });
  command(['run', 'cloudflare:build'], theme, env);
  const workerPort = await freePort();
  server = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev',
    '--config', 'dist/server/wrangler.json', '--local', '--ip', '127.0.0.1',
    '--port', String(workerPort), '--inspector-port', '0', '--log-level', 'warn',
  ], { cwd: theme, env, stdio: ['ignore', 'inherit', 'inherit'] });
  await checkServer(`http://127.0.0.1:${workerPort}`, 'Built local Cloudflare Worker');
  console.log(`PASS: packed plugin, real SQLite business tests, typechecks, Node and local Worker runtime smoke; core ${version}.`);
  console.log('Authenticated browser and deployed Cloudflare acceptance remain manual release checks. No customer upgraded.');
} finally {
  await stopServer();
  await rm(directory, { recursive: true, force: true });
}
