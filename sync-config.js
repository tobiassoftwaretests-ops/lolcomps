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
  url: 'https://lqsikmisqdktqrtuktoq.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxxc2lrbWlzcWRrdHFydHVrdG9xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5NjQxMTAsImV4cCI6MjA5OTU0MDExMH0.CPgZcTgg3teF0_KUrQTNSe8DyfcwlNfy91-CzLkJLkI',
};
