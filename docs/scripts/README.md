# Scripts Reference

Utility scripts for maintenance, debugging, and administration.

## Table of Contents

- [Overview](#overview)
- [Context Scripts](#context-scripts)
- [Import/Export Scripts](#importexport-scripts)
- [Maintenance Scripts](#maintenance-scripts)
- [Debug Scripts](#debug-scripts)
- [Test Scripts](#test-scripts)

## Overview

All scripts are located in the `scripts/` directory and can be run with:

```bash
npx tsx scripts/script-name.ts [args]
```

Or directly:
```bash
npm run script:dump-context
```

## Context Scripts

### dump_static_context.ts

Exports static context to a file for inspection.

```bash
npx tsx scripts/dump_static_context.ts [output-file]
```

**Default output:** `static_context.txt`

**Purpose:** Dumps the compiled static context (system knowledge) to a text file for debugging or documentation.

### dump_dynamic_context.ts

Exports dynamic context to a file.

```bash
npx tsx scripts/dump_dynamic_context.ts [output-file]
```

**Default output:** `dynamic_context.txt`

**Purpose:** Dumps runtime symbols and state for debugging.

## Import/Export Scripts

### export_gsm8k.ts

Exports data in GSM8K format for benchmarking.

```bash
npx tsx scripts/export_gsm8k.ts [output-path]
```

**Output:** Creates a `.zip` file with GSM8K-formatted questions.

**Purpose:** Generate benchmark datasets for testing reasoning capabilities.

### import_gsm8k.py

Imports GSM8K dataset into SignalZero.

```bash
python3 scripts/import_gsm8k.py [input-file]
```

**Purpose:** Load mathematical reasoning benchmarks for testing.

## Maintenance Scripts

### cleanup_state_symbols.ts

Cleans up old state symbols.

```bash
npx tsx scripts/cleanup_state_symbols.ts [--dry-run] [--older-than DAYS]
```

**Options:**
- `--dry-run` - Show what would be deleted without deleting
- `--older-than DAYS` - Delete symbols older than N days (default: 7)

**Purpose:** Prevent state domain from growing indefinitely.

### reindex_all.ts

Rebuilds all vector indices.

```bash
npx tsx scripts/reindex_all.ts [--domain DOMAIN]
```

**Options:**
- `--domain` - Reindex only specific domain

**Purpose:** Fix corrupted vector indices or update embeddings after model changes.

### reset_system_prompt.ts

Resets the system prompt to default.

```bash
npx tsx scripts/reset_system_prompt.ts [--confirm]
```

**Purpose:** Restore default system prompt if customized version causes issues.

### rebuild_test_metadata.ts

Rebuilds test metadata after schema changes.

```bash
npx tsx scripts/rebuild_test_metadata.ts
```

**Purpose:** Update test data to match new type definitions.

### fix_user_core.ts

Fixes user core data integrity issues.

```bash
npx tsx scripts/fix_user_core.ts [--user USER_ID]
```

**Purpose:** Repair corrupted user data.

## Debug Scripts

### inspect_chroma.ts

Inspects ChromaDB collections.

```bash
npx tsx scripts/inspect_chroma.ts [--collection NAME]
```

**Output:** Collection statistics, document count, sample entries.

### inspect_parquet.ts / inspect_parquet_v2.ts / inspect_parquet_v3.ts

Inspects Parquet files.

```bash
npx tsx scripts/inspect_parquet_v3.ts [file-path]
```

**Purpose:** Debug export/import file formats.

### inspect_user_core.ts

Inspects user core data in Redis.

```bash
npx tsx scripts/inspect_user_core.ts [user-id]
```

**Output:** User data, domains, symbols.

### find_symbol_location.ts

Finds where a symbol is stored.

```bash
npx tsx scripts/find_symbol_location.ts [symbol-id]
```

**Purpose:** Debug symbol storage and retrieval issues.

### test_search.ts

Tests vector search functionality.

```bash
npx tsx scripts/test_search.ts [query]
```

**Purpose:** Verify ChromaDB search is working correctly.

## Test Scripts

### migrate_test_data.ts

Migrates test data to new formats.

```bash
npx tsx scripts/migrate_test_data.ts [--from-version VERSION]
```

**Purpose:** Update test fixtures after breaking changes.

## Creating New Scripts

Template for new scripts:

```typescript
#!/usr/bin/env tsx
import { redisService } from '../services/redisService';
import { logger } from '../services/loggerService';

async function main() {
  const args = process.argv.slice(2);
  
  try {
    // Script logic here
    logger.info('Script completed successfully');
  } catch (error) {
    logger.error('Script failed', { error });
    process.exit(1);
  } finally {
    await redisService.disconnect();
  }
}

main();
```

## Automation

### Cron Jobs

Example crontab for maintenance:

```bash
# Clean up old state symbols weekly
0 2 * * 0 cd /opt/signalzero && npx tsx scripts/cleanup_state_symbols.ts --older-than 14

# Reindex vectors monthly
0 3 1 * * cd /opt/signalzero && npx tsx scripts/reindex_all.ts
```

### Systemd Timers

For systemd-based systems:

```ini
# /etc/systemd/system/signalzero-cleanup.service
[Unit]
Description=SignalZero State Cleanup

[Service]
Type=oneshot
WorkingDirectory=/opt/signalzero
ExecStart=/usr/bin/npx tsx scripts/cleanup_state_symbols.ts --older-than 14
User=signalzero

# /etc/systemd/system/signalzero-cleanup.timer
[Unit]
Description=Run SignalZero cleanup weekly

[Timer]
OnCalendar=weekly
Persistent=true

[Install]
WantedBy=timers.target
```

Enable:
```bash
sudo systemctl enable signalzero-cleanup.timer
sudo systemctl start signalzero-cleanup.timer
```
