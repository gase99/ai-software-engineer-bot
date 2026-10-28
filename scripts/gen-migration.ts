import { writeFileSync } from 'node:fs';
import { SCHEMA_SQL } from '../src/db/schema.js';

writeFileSync(new URL('../migrations/0001_init.sql', import.meta.url), SCHEMA_SQL, 'utf8');
console.log('migrations/0001_init.sql written from src/db/schema.ts');
