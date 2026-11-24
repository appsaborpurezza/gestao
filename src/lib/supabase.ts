import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? 'https://kyawevmitvmwmjxgyxan.supabase.co',
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_fZK0adf3U8r8vCTPwKnP3w_k6WIxNAl',
)
