# dsh-plugin-backup-keeper — Backup Keeper

Copias de seguridad versionadas para DeepSeek Harness: snapshots de carpetas con manifiesto SHA-256, verificacion, restore seguro y retencion, sin borrar originales.

## Herramientas

| Tool | Qué hace |
|---|---|
| `status` | Estado |
| `backup` | Crear snapshot |
| `list` | Listar snapshots |
| `verify` | Verificar snapshot |
| `restore` | Restaurar snapshot |
| `prune` | Podar snapshots |

## Instalación

Desde **DSH → Settings → Plugins** instala `github:thegabopacheco-sudo/dsh-plugin-backup-keeper` y permite el script de instalación.

```
dsh plugin --profile <perfil> add github:thegabopacheco-sudo/dsh-plugin-backup-keeper
```

## Seguridad

- Lectura por defecto; escritura solo con `confirm:true` y pedido explícito.
- `DSH_BACKUP_KEEPER_MODE=read-only` desactiva acciones.
- Listas blancas y auditoría en `<DSH_HOME>\cache\backup-keeper\audit.jsonl`.

## Licencia

MIT © thegabopacheco-sudo
