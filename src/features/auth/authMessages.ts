/** Traduz respostas do Supabase Auth sem revelar se uma conta existe. */
export function authMessage(message: string | undefined | null) {
  const text = (message ?? '').toLowerCase()
  if (text.includes('invalid login credentials')) return 'E-mail ou senha incorretos.'
  if (text.includes('email not confirmed')) return 'Confirme o e-mail pelo link de convite antes de entrar.'
  if (text.includes('rate limit') || text.includes('too many')) return 'Muitas tentativas. Aguarde alguns minutos e tente novamente.'
  if (text.includes('password should be') || text.includes('weak password')) return 'A senha não atende aos requisitos mínimos de segurança.'
  if (text.includes('same password') || text.includes('different from the old')) return 'A nova senha precisa ser diferente da atual.'
  if (text.includes('expired') || text.includes('invalid') && text.includes('token')) return 'O link expirou. Solicite uma nova recuperação de senha.'
  if (text.includes('fetch') || text.includes('network')) return 'Não foi possível conectar ao serviço de autenticação.'
  return 'Não foi possível concluir a operação. Tente novamente.'
}
