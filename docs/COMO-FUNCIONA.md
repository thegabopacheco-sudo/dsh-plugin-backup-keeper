# Cómo funciona dsh-plugin-backup-keeper

Copias de seguridad versionadas para DeepSeek Harness: snapshots de carpetas con manifiesto SHA-256, verificacion, restore seguro y retencion, sin borrar originales.

## Arquitectura

```
DSH ──MCP stdio──► server.mjs (bundle single-file)
                    └─ lógica local del plugin
```

## Herramientas reales

- `status`: Estado
- `backup`: Crear snapshot
- `list`: Listar snapshots
- `verify`: Verificar snapshot
- `restore`: Restaurar snapshot
- `prune`: Podar snapshots

## Seguridad

- Lectura por defecto; acciones con `confirm:true`.
- Modo `read-only` por variable de entorno.
- Listas blancas cuando aplique.
- Auditoría en `<DSH_HOME>\cache\backup-keeper\audit.jsonl`.
- Rate limit de acciones.

## Verificación

Tests end-to-end con el cliente MCP oficial (`@modelcontextprotocol/client@2.2.0`)
y artefacto empaquetado (`npm pack` → `postinstall` → servidor desplegado).
