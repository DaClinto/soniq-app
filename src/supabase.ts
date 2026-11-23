import { createClient } from '@supabase/supabase-js';

const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/$/, '');
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

const missingConfig = [
  ['VITE_SUPABASE_URL', supabaseUrl],
  ['VITE_SUPABASE_ANON_KEY', supabaseAnonKey],
]
  .filter(([, value]) => !value)
  .map(([key]) => key);

export const supabaseConfigurationError = missingConfig.length
  ? `Missing Supabase configuration: ${missingConfig.join(', ')}`
  : '';

export const supabase = supabaseConfigurationError
  ? null
  : createClient(supabaseUrl, supabaseAnonKey);

export const SUPABASE_AUDIO_BUCKET = 'music';
