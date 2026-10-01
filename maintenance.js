/**
 * Maintenance helpers shared by the admin "reset" action and the local script.
 *
 * Keeping this in one place means wiping data from the dashboard and wiping it
 * from a laptop run exactly the same code.
 */
const { resetAllData } = require('./database');

const REPORT_BUCKET = 'report-photos';

/**
 * Remove every object from the report-photo bucket.
 *
 * Supabase lists at most `limit` entries per call, so this loops until the
 * bucket reports empty rather than guessing a total count.
 */
async function clearReportPhotos(supabaseClient, bucket = REPORT_BUCKET) {
  if (!supabaseClient) return { removed: 0, skipped: 'Supabase storage is not configured' };

  const storage = supabaseClient.storage.from(bucket);
  let removed = 0;

  for (let pass = 0; pass < 50; pass += 1) {
    const { data, error } = await storage.list('', { limit: 100 });
    if (error) throw new Error('Could not list report photos: ' + (error.message || error));
    if (!data || data.length === 0) break;

    const paths = data.map((entry) => entry.name);
    const { error: removeError } = await storage.remove(paths);
    if (removeError) throw new Error('Could not delete report photos: ' + (removeError.message || removeError));

    removed += paths.length;
    if (paths.length < 100) break;
  }

  return { removed };
}

/**
 * Wipe all operational data. Returns a summary suitable for logging or an HTTP body.
 */
async function resetAllDataAndPhotos(supabaseClient) {
  const database = await resetAllData();

  let photos = { removed: 0, skipped: 'Supabase storage is not configured' };
  try {
    photos = await clearReportPhotos(supabaseClient);
  } catch (err) {
    photos = { removed: 0, error: err.message || String(err) };
  }

  return { database, photos };
}

module.exports = { resetAllData, resetAllDataAndPhotos, clearReportPhotos, REPORT_BUCKET };
