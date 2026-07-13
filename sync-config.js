'use strict';
// ── Cloud sync configuration (Supabase) ──────────────────────────────────────
// Leave both fields empty to disable cloud sync — the app then works purely
// locally (localStorage + team-data.js defaults).
//
// SECURITY NOTE: the anon key is meant to be public. It only allows what the
// database row-level-security rules permit: reading the roster and calling
// save_roster(), which requires the team password (checked inside the DB).
// Never put the service_role key here.
const SYNC = {
  url: '',      // e.g. 'https://abcdefgh.supabase.co'
  anonKey: '',  // the "anon public" API key
};
