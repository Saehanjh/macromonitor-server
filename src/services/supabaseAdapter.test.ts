import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupabaseConfigured } from './supabaseAdapter';

test('Supabase configuration follows the backend and both server secrets', () => {
  const expected = process.env.PERSONAL_STORE_BACKEND === 'supabase'
    && Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(isSupabaseConfigured(), expected);
});
