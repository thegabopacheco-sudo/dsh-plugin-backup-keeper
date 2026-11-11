// Test end-to-end de backup-keeper (local, sin red).
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const packageDir = path.resolve(import.meta.dirname, '..');
const tmpDir = path.join(packageDir, 'test', 'tmp');
rmSync(tmpDir, { recursive: true, force: true });
const source = path.join(tmpDir, 'workspace');
const restoreTarget = path.join(tmpDir, 'restore');
const backupRoot = path.join(tmpDir, 'backups');
mkdirSync(path.join(source, 'sub'), { recursive: true });
mkdirSync(path.join(source, 'node_modules', 'x'), { recursive: true });
mkdirSync(restoreTarget, { recursive: true });
mkdirSync(path.join(tmpDir, 'dsh-home', 'backup-keeper'), { recursive: true });
writeFileSync(path.join(tmpDir, 'dsh-home', 'backup-keeper', 'config.json'), JSON.stringify({ backupRoot, allowedSources: [source, restoreTarget], exclude: ['node_modules', '.git', 'dist'], retention: 2, maxFiles: 5000 }, null, 2), 'utf8');

writeFileSync(path.join(source, 'nota.txt'), 'contenido original', 'utf8');
writeFileSync(path.join(source, 'sub', 'datos.json'), '{"a":1}', 'utf8');
writeFileSync(path.join(source, 'node_modules', 'x', 'ignorar.js'), 'x', 'utf8');

function makeClient(extraEnv = {}) {
  const entry = process.env.BACKUP_SERVER ? path.resolve(process.env.BACKUP_SERVER) : path.join(packageDir, 'server.mjs');
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.PATH, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME || process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP, DSH_HOME: path.join(tmpDir, 'dsh-home'), ...extraEnv }, stderr: 'pipe' });
  transport.stderr?.on('data', (c) => process.stderr.write(`[server] ${c}`));
  const client = new Client({ name: 'backup-test', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  return client.connect(transport).then(() => ({ client, transport }));
}
const textOf = (r) => (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');

const { client, transport } = await makeClient();
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('--- status ---'); console.log(textOf(await client.callTool({ name: 'status', arguments: {} })));
const noConfirm = await client.callTool({ name: 'backup', arguments: { dir: source, name: 'demo' } });
console.log('backup sin confirm isError:', noConfirm.isError === true);
const b1 = await client.callTool({ name: 'backup', arguments: { dir: source, name: 'demo', confirm: true } });
console.log('--- backup ---'); console.log(textOf(b1));
const id1 = (textOf(b1).match(/Snapshot (\S+) creado/) || [])[1];
const list = await client.callTool({ name: 'list', arguments: {} });
console.log('--- list ---'); console.log(textOf(list));
const verify = await client.callTool({ name: 'verify', arguments: { id: id1 } });
console.log('--- verify ---'); console.log(textOf(verify));
console.log('verify OK:', textOf(verify).includes('OK'));
// tamper: modificar un archivo dentro del snapshot
const snapshotDir = path.join(backupRoot, id1);
writeFileSync(path.join(snapshotDir, 'nota.txt'), 'alterado', 'utf8');
const verifyBad = await client.callTool({ name: 'verify', arguments: { id: id1 } });
console.log('--- verify alterado ---'); console.log(textOf(verifyBad).slice(0, 200));
console.log('detecta corrupción:', textOf(verifyBad).includes('problema'));
// restaurar en target
const restore = await client.callTool({ name: 'restore', arguments: { id: id1, target: restoreTarget, confirm: true } });
console.log('--- restore ---'); console.log(textOf(restore));
console.log('restaurado:', existsSync(path.join(restoreTarget, 'sub', 'datos.json')));
// segundo backup + prune
await client.callTool({ name: 'backup', arguments: { dir: source, name: 'demo2', confirm: true } });
const prune = await client.callTool({ name: 'prune', arguments: { keep: 1, confirm: true } });
console.log('--- prune ---'); console.log(textOf(prune));
console.log('quedan snapshots:', textOf(await client.callTool({ name: 'list', arguments: {} })).split('\n').filter(Boolean).length);
const outside = await client.callTool({ name: 'backup', arguments: { dir: path.join(tmpDir, 'otro'), confirm: true } });
console.log('fuente fuera isError:', outside.isError === true);
await client.close(); try { await transport.close?.(); } catch {}
const { client: roClient, transport: roTransport } = await makeClient({ DSH_BACKUP_MODE: 'read-only' });
const roBackup = await roClient.callTool({ name: 'backup', arguments: { dir: source, confirm: true } });
console.log('read-only backup isError:', roBackup.isError === true);
const roList = await roClient.callTool({ name: 'list', arguments: {} });
console.log('read-only list permitido:', roList.isError !== true);
await roClient.close(); try { await roTransport.close?.(); } catch {}
console.log('OK');
