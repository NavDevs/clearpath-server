#!/usr/bin/env node
/**
 * Wipe all ClearPath data so you can demo from a clean slate.
 *
 * Uses exactly the same code as the dashboard's "Reset demo data" action, so
 * wiping locally and wiping on Render behave identically.
 *
 * Usage (PowerShell):
 *   $env:DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require"
 *   $env:SUPABASE_URL="https://xxxx.supabase.co"
 *   $env:SUPABASE_SERVICE_ROLE_KEY="eyJ..."
 *   node scripts/reset-data.js --yes
 *
 * Usage (bash):
 *   DATABASE_URL=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/reset-data.js --yes
 *
 * Without --yes the script prints what it would delete and exits.
 */
const { initPromise } = require('../database');
const { resetAllDataAndPhotos } = require('../maintenance');

const confirmed = process.argv.includes('--yes');
const hasSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const target = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.replace(/\/\/[^@]*@/, '//***:***@')
  : 'sqlite fallback (backend/clearpath.db)';

(async () => {
  console.log('ClearPath data reset');
  console.log('  database :', target);
  console.log('  supabase :', hasSupabase ? 'report-photos bucket will be emptied' : 'not configured (photos skipped)');

  if (!confirmed) {
    console.log('\nDry run. Re-run with --yes to actually delete everything.');
    process.exit(0);
  }

  await initPromise;

  let supabase = null;
  if (hasSupabase) {
    const { createClient } = require('@supabase/supabase-js');
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }

  const summary = await resetAllDataAndPhotos(supabase);

  console.log('\nDeleted:');
  console.log('  tables   :', summary.database.tables.join(', '), '(' + summary.database.engine + ')');
  console.log('  photos   :', summary.photos.error ? 'FAILED - ' + summary.photos.error : summary.photos.removed + ' removed');
  if (summary.photos.skipped) console.log('  note     :', summary.photos.skipped);
  console.log('\nDone. Admin logins are environment-based, so the dashboard still works.');
  process.exit(0);
})().catch((err) => {
  console.error('\nReset failed:', err.message || err);
  process.exit(1);
});
