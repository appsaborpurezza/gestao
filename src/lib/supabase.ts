import { createClient } from '@supabase/supabase-js'

/**
 * Link de convite aceito: o Supabase troca o token da URL por uma sessão e apaga o fragmento,
 * então a marca é lida antes de criar o cliente. A pessoa define a senha antes de entrar.
 */
export const invitedFromLink = typeof location !== 'undefined' && /(^|[#&])type=invite(&|$)/.test(location.hash)

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? 'https://kyawevmitvmwmjxgyxan.supabase.co',
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? 'sb_publishable_fZK0adf3U8r8vCTPwKnP3w_k6WIxNAl',
)
