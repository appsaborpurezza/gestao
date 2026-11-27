// Operações administrativas do Supabase Auth para o portal: convidar, reenviar convite,
// revogar convite pendente e enviar redefinição de senha.
// A chave secreta (SUPABASE_SERVICE_ROLE_KEY) existe só neste ambiente do Supabase e nunca chega ao navegador.
// Quem chama precisa ser um perfil ADMINISTRADOR ativo; a conferência é feita aqui, com o token do próprio usuário.
import { createClient } from 'npm:@supabase/supabase-js@2'

const url = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
// Endereço do portal para onde os e-mails de convite e de senha levam (precisa estar nas Redirect URLs do Auth).
const portalUrl = Deno.env.get('PORTAL_URL') ?? 'https://appsaborpurezza.github.io/gestao/'
const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? 'https://appsaborpurezza.github.io,http://localhost:5173,http://127.0.0.1:4103')
  .split(',').map(item => item.trim()).filter(Boolean)
const roles = ['ADMINISTRADOR', 'VENDAS', 'PRODUCAO']

function cors(origin: string | null) {
  const allowed = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

const reply = (origin: string | null, status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(origin), 'Content-Type': 'application/json' } })

const validEmail = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 3 && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

Deno.serve(async request => {
  const origin = request.headers.get('Origin')
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) })
  if (request.method !== 'POST') return reply(origin, 405, { error: 'Método não permitido.' })

  // 1. Identifica quem chama com o token do próprio usuário (nunca com a chave secreta).
  const token = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  // getUser(token) valida o token no Auth: um token forjado ou expirado é recusado.
  if (!token) return reply(origin, 401, { error: 'Sessão inválida. Entre novamente.' })
  const { data: who, error: whoError } = await admin.auth.getUser(token)
  if (whoError || !who.user) return reply(origin, 401, { error: 'Sessão inválida. Entre novamente.' })

  const { data: profile } = await admin.from('profiles').select('role,active').eq('id', who.user.id).maybeSingle()
  if (!profile || profile.role !== 'ADMINISTRADOR' || !profile.active) {
    return reply(origin, 403, { error: 'Somente Administração pode gerenciar acessos.' })
  }

  let body: Record<string, unknown>
  try { body = await request.json() } catch { return reply(origin, 400, { error: 'Requisição inválida.' }) }
  const action = body.action
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!validEmail(email)) return reply(origin, 400, { error: 'Informe um e-mail válido.' })

  const audit = (operation: string, details: Record<string, unknown>) =>
    admin.from('audit_logs').insert({ actor: who.user.id, action: operation, details })

  // Busca a conta pelo e-mail (listUsers é paginado; a base de usuários do portal é pequena).
  async function findUser() {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
      if (error) throw error
      const found = data.users.find(user => user.email?.toLowerCase() === email)
      if (found || data.users.length < 200) return found ?? null
    }
    return null
  }

  try {
    if (action === 'invite') {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      const role = typeof body.role === 'string' ? body.role : ''
      if (name.length < 1 || name.length > 120 || !roles.includes(role)) return reply(origin, 400, { error: 'Confira nome e perfil.' })
      if (await findUser()) return reply(origin, 409, { error: 'Já existe uma conta com este e-mail. Use "Vincular conta" ou "Reenviar convite".' })
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: portalUrl, data: { display_name: name } })
      if (error || !data.user) return reply(origin, 422, { error: 'Não foi possível enviar o convite. Confira o e-mail e tente de novo.' })
      const { error: profileError } = await admin.from('profiles').insert({ id: data.user.id, display_name: name, role })
      if (profileError) {
        // Sem perfil, o convite é desfeito para não deixar conta órfã.
        await admin.auth.admin.deleteUser(data.user.id)
        return reply(origin, 500, { error: 'O convite foi cancelado porque o perfil não pôde ser criado.' })
      }
      await audit('CONVIDAR_USUARIO', { perfil_id: data.user.id, perfil: role })
      return reply(origin, 200, { ok: true, id: data.user.id })
    }

    const user = await findUser()
    if (!user) return reply(origin, 404, { error: 'Conta não encontrada.' })

    if (action === 'resend') {
      if (user.email_confirmed_at) return reply(origin, 409, { error: 'Esta conta já aceitou o convite. Use "Enviar redefinição de senha".' })
      const { error } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: portalUrl })
      if (error) return reply(origin, 422, { error: 'Não foi possível reenviar o convite agora. Aguarde alguns minutos.' })
      await audit('REENVIAR_CONVITE', { perfil_id: user.id })
      return reply(origin, 200, { ok: true })
    }

    if (action === 'revoke') {
      // Só convite pendente: conta que nunca entrou e não tem nenhuma operação além da própria criação do perfil.
      if (user.email_confirmed_at || user.last_sign_in_at) return reply(origin, 409, { error: 'A conta já foi usada. Desative o perfil em vez de revogar.' })
      const { count } = await admin.from('audit_logs').select('id', { count: 'exact', head: true }).eq('actor', user.id)
      if ((count ?? 0) > 0) return reply(origin, 409, { error: 'A conta possui histórico. Desative o perfil em vez de revogar.' })
      const { error: profileError } = await admin.from('profiles').delete().eq('id', user.id)
      if (profileError) return reply(origin, 409, { error: 'O perfil possui vínculos e não pode ser removido. Desative-o.' })
      const { error } = await admin.auth.admin.deleteUser(user.id)
      if (error) return reply(origin, 500, { error: 'Não foi possível revogar o convite.' })
      await audit('REVOGAR_CONVITE', { perfil_id: user.id })
      return reply(origin, 200, { ok: true })
    }

    if (action === 'reset_password') {
      const { error } = await admin.auth.resetPasswordForEmail(email, { redirectTo: portalUrl })
      if (error) return reply(origin, 422, { error: 'Não foi possível enviar a redefinição agora. Aguarde alguns minutos.' })
      await audit('ENVIAR_REDEFINICAO_SENHA', { perfil_id: user.id })
      return reply(origin, 200, { ok: true })
    }

    return reply(origin, 400, { error: 'Ação não suportada.' })
  } catch {
    return reply(origin, 500, { error: 'Falha inesperada. Tente de novo em instantes.' })
  }
})
