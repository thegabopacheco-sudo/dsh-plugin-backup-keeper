#!/usr/bin/env node
// dsh-plugin-backup-keeper — snapshots versionados con manifiesto SHA-256.
// Tools: status, backup, list, verify, restore, prune.

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const VERSION = '0.1.0';
const DSH_HOME = (() => {
  const v = process.env.DSH_HOME && process.env.DSH_HOME.trim();
  return v || path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh');
})();
const CONFIG_FILE = path.join(DSH_HOME, 'backup-keeper', 'config.json');
const CACHE_DIR = path.join(DSH_HOME, 'cache', 'backup-keeper');
const AUDIT_FILE = path.join(CACHE_DIR, 'audit.jsonl');
const READ_ONLY = String(process.env.DSH_BACKUP_MODE || '').toLowerCase() === 'read-only';
const log = (m) => process.stderr.write(`[backups] ${m}\n`);

function loadConfig() {
  const defaults = {
    backupRoot: path.join(DSH_HOME, 'backups'),
    allowedSources: [path.join(DSH_HOME, 'cache', 'backup-keeper', 'sandbox')],
    exclude: ['node_modules', '.git', 'test/tmp', 'dist'],
    retention: 10,
    maxFiles: 20_000,
  };
  try { if (existsSync(CONFIG_FILE)) return { ...defaults, ...(JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) || {}) }; } catch (e) { log(`config: ${e.message}`); }
  return defaults;
}
function saveConfig(config) { mkdirSync(path.dirname(CONFIG_FILE), { recursive: true }); writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8'); }
function audit(entry) { try { mkdirSync(CACHE_DIR, { recursive: true }); appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n'); } catch { /* best effort */ } }
function sha256(file) { return crypto.createHash('sha256').update(readFileSync(file)).digest('hex'); }
function human(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : bytes < 1024 ** 3 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${(bytes / 1024 ** 3).toFixed(2)} GB`; }
function ensureSource(config, dir) {
  const abs = path.resolve(dir);
  const lower = abs.toLowerCase();
  const ok = (config.allowedSources || []).some((root) => {
    const r = path.resolve(root).toLowerCase();
    return lower === r || lower.startsWith(r + path.sep);
  });
  if (!ok) throw new Error(`fuente no permitida: ${abs}. allowedSources: ${(config.allowedSources || []).join(', ')}`);
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`carpeta no encontrada: ${abs}`);
  return abs;
}
function isExcluded(rel, config) {
  const normalized = rel.replace(/\\/g, '/');
  return (config.exclude || []).some((pattern) => normalized === pattern || normalized.startsWith(pattern + '/') || normalized.includes('/' + pattern + '/'));
}
function snapshotId(name) { return `${String(name || 'snapshot').replace(/[^a-z0-9-_]/gi, '-')}-${new Date().toISOString().replace(/[:.]/g, '-')}`; }
function walkSource(config, root, current = root, acc = []) {
  let entries;
  try { entries = readdirSync(current, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full);
    if (isExcluded(rel, config)) continue;
    if (entry.isDirectory()) walkSource(config, root, full, acc);
    else if (entry.isFile()) {
      acc.push({ rel, full, size: statSync(full).size });
      if (acc.length >= (config.maxFiles || 20_000)) break;
    }
  }
  return acc;
}
function backupDirOf(config, id) { return path.join(config.backupRoot, id); }
function readManifest(dir) { return JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')); }
function listBackups(config) {
  try {
    return readdirSync(config.backupRoot, { withFileTypes: true }).filter((e) => e.isDirectory() && existsSync(path.join(config.backupRoot, e.name, 'manifest.json')))
      .map((e) => { try { return { id: e.name, ...readManifest(path.join(config.backupRoot, e.name)) }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch { return []; }
}
function textResult(t) { return { content: [{ type: 'text', text: t }] }; }

function buildInstructions() {
  return [
    'Backup Keeper: copias versionadas de carpetas con manifiesto SHA-256 y restauración segura.',
    '',
    `Config: ${CONFIG_FILE}`,
    '',
    'Herramientas: status, backup, list, verify, restore, prune.',
    '',
    'Reglas:',
    '- backup/restore/prune requieren confirm:true y pedido explícito.',
    '- Nunca toca ni borra la carpeta original; solo escribe en backupRoot (snapshots) o en el destino de restore.',
    '- restore no sobrescribe archivos existentes salvo overwrite:true.',
    '- Reporta hashes y diferencias reales; no prometas recuperaciones imposibles.',
  ].join('\n');
}

function buildServer() {
  const server = new McpServer({ name: 'dsh-plugin-backup-keeper', version: VERSION }, { capabilities: { tools: {} }, instructions: buildInstructions() });

  server.registerTool(
    'status',
    { title: 'Estado', description: 'Configuración, backupRoot, snapshots y retención.', inputSchema: z.object({}) },
    async () => {
      const config = loadConfig();
      const backups = listBackups(config);
      return textResult([`Modo: ${READ_ONLY ? 'read-only' : 'normal'}`, `Config: ${CONFIG_FILE}`, `BackupRoot: ${config.backupRoot}`, `Snapshots: ${backups.length} · retención: ${config.retention}`, `Fuentes permitidas: ${(config.allowedSources || []).join(', ')}`].join('\n'));
    },
  );

  server.registerTool(
    'backup',
    {
      title: 'Crear snapshot',
      description: 'Copia una carpeta a un snapshot con manifiesto SHA-256. Requiere confirm:true.',
      inputSchema: z.object({ dir: z.string().min(2), name: z.string().max(60).optional(), confirm: z.boolean().optional() }),
    },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: backup deshabilitado');
      if (args.confirm !== true) throw new Error('backup requiere confirm:true y confirmación explícita');
      const config = loadConfig();
      const source = ensureSource(config, args.dir);
      const id = snapshotId(args.name || path.basename(source));
      const target = backupDirOf(config, id);
      if (existsSync(target)) throw new Error(`ya existe el snapshot ${id}`);
      const files = walkSource(config, source);
      let bytes = 0; const entries = [];
      for (const file of files) {
        const dest = path.join(target, file.rel);
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(file.full, dest);
        entries.push({ rel: file.rel, size: file.size, sha256: sha256(dest) });
        bytes += file.size;
      }
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({ id, source, createdAt: new Date().toISOString(), files: entries, bytes }, null, 2) + '\n', 'utf8');
      audit({ tool: 'backup', id, source, files: entries.length, bytes, ok: true });
      return textResult(`Snapshot ${id} creado: ${entries.length} archivo(s), ${human(bytes)} en ${target}`);
    },
  );

  server.registerTool(
    'list',
    { title: 'Listar snapshots', description: 'Lista los snapshots con fecha, fuente y tamaño.', inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional() }) },
    async (args) => {
      const backups = listBackups(loadConfig()).slice(0, args.limit ?? 20);
      if (backups.length === 0) return textResult('Sin snapshots todavía.');
      return textResult(backups.map((b) => `${b.id} · ${b.createdAt} · ${(b.files || []).length} archivo(s) · ${human(b.bytes)} · origen ${b.source}`).join('\n'));
    },
  );

  server.registerTool(
    'verify',
    { title: 'Verificar snapshot', description: 'Recalcula SHA-256 de cada archivo y compara con el manifiesto.', inputSchema: z.object({ id: z.string().min(3) }) },
    async (args) => {
      const config = loadConfig();
      const dir = backupDirOf(config, args.id);
      if (!existsSync(path.join(dir, 'manifest.json'))) throw new Error(`snapshot no encontrado: ${args.id}`);
      const manifest = readManifest(dir);
      const problems = [];
      for (const file of manifest.files || []) {
        const full = path.join(dir, file.rel);
        if (!existsSync(full)) { problems.push(`falta: ${file.rel}`); continue; }
        if (sha256(full) !== file.sha256) problems.push(`hash distinto: ${file.rel}`);
      }
      if (problems.length === 0) return textResult(`Snapshot ${args.id}: OK · ${(manifest.files || []).length} archivo(s) intactos (${human(manifest.bytes || 0)}).`);
      return textResult(`Snapshot ${args.id}: ${problems.length} problema(s)\n${problems.slice(0, 30).join('\n')}`);
    },
  );

  server.registerTool(
    'restore',
    {
      title: 'Restaurar snapshot',
      description: 'Copia los archivos del snapshot a una carpeta destino. Requiere confirm:true.',
      inputSchema: z.object({ id: z.string().min(3), target: z.string().min(2), overwrite: z.boolean().optional(), confirm: z.boolean().optional() }),
    },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: restore deshabilitado');
      if (args.confirm !== true) throw new Error('restore requiere confirm:true y confirmación explícita');
      const config = loadConfig();
      const dir = backupDirOf(config, args.id);
      const manifest = readManifest(dir);
      const target = ensureSource(config, args.target);
      let copied = 0; let skipped = 0;
      for (const file of manifest.files || []) {
        const dest = path.join(target, file.rel);
        if (existsSync(dest) && args.overwrite !== true) { skipped++; continue; }
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(path.join(dir, file.rel), dest);
        copied++;
      }
      audit({ tool: 'restore', id: args.id, target, copied, skipped, ok: true });
      return textResult(`Snapshot ${args.id} restaurado en ${target}: ${copied} copiado(s), ${skipped} omitido(s) por existir.`);
    },
  );

  server.registerTool(
    'prune',
    { title: 'Podar snapshots', description: 'Conserva los últimos N snapshots y elimina los viejos. Requiere confirm:true.', inputSchema: z.object({ keep: z.number().int().min(1).max(100).optional(), confirm: z.boolean().optional() }) },
    async (args) => {
      if (READ_ONLY) throw new Error('modo read-only: prune deshabilitado');
      if (args.confirm !== true) throw new Error('prune requiere confirm:true');
      const config = loadConfig();
      const keep = args.keep ?? config.retention ?? 10;
      const backups = listBackups(config);
      const remove = backups.slice(keep);
      for (const backup of remove) {
        const dir = backupDirOf(config, backup.id);
        const { rmSync } = await import('node:fs');
        rmSync(dir, { recursive: true, force: true });
      }
      audit({ tool: 'prune', removed: remove.length, kept: Math.min(keep, backups.length), ok: true });
      return textResult(remove.length === 0 ? `Nada que podar (${backups.length} snapshot(s), retención ${keep}).` : `Podados ${remove.length} snapshot(s); conservados ${Math.min(keep, backups.length)}.`);
    },
  );

  return server;
}

try {
  mkdirSync(CACHE_DIR, { recursive: true });
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const sandbox = path.join(DSH_HOME, 'cache', 'backup-keeper', 'sandbox');
    writeFileSync(CONFIG_FILE, JSON.stringify({ backupRoot: path.join(DSH_HOME, 'backups'), allowedSources: [sandbox], exclude: ['node_modules', '.git', 'test/tmp', 'dist'], retention: 10, maxFiles: 20000 }, null, 2) + '\n', 'utf8');
  }
} catch (e) { log(`init: ${e.message}`); }
log(`modo ${READ_ONLY ? 'read-only' : 'normal'} · config: ${CONFIG_FILE}`);
serveStdio(buildServer, { onerror: (e) => log(`serveStdio: ${e.message}`) });
process.on('uncaughtException', (e) => log(`excepción: ${e.message}`));
process.on('unhandledRejection', (e) => log(`rechazo: ${e && e.message ? e.message : String(e)}`));
