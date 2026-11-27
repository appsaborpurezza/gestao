import { useState, type FormEvent } from 'react'
import { Eye, EyeOff, Loader2, LogIn } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { authMessage } from './authMessages'

export function Access({ recovery }: { recovery: boolean }) {
  const [reset, setReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const values = new FormData(event.currentTarget)
    const email = String(values.get('email') ?? '').trim()
    const password = String(values.get('password') ?? '')
    setBusy(true)
    setMessage('')
    try {
      const result = recovery
        ? await supabase.auth.updateUser({ password })
        : reset
          ? await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.origin + import.meta.env.BASE_URL })
          : await supabase.auth.signInWithPassword({ email, password })
      // A recuperação sempre mostra a mesma resposta, para não revelar se o e-mail existe.
      const error = reset && !recovery ? null : result.error
      setFailed(Boolean(error))
      if (error) setMessage(authMessage(error.message))
      else if (recovery) {
        await supabase.auth.signOut()
        location.replace(location.origin + import.meta.env.BASE_URL)
      } else if (reset) setMessage('Se o endereço estiver cadastrado, você receberá as instruções por e-mail.')
    } catch {
      setFailed(true)
      setMessage('Não foi possível conectar ao serviço de autenticação.')
    } finally {
      setBusy(false)
    }
  }

  const title = recovery ? 'Definir nova senha' : reset ? 'Recuperar senha' : 'Entrar no sistema'
  const subtitle = recovery ? 'Escolha uma senha segura para sua conta.'
    : reset ? 'Informe o e-mail cadastrado para receber o link.'
      : 'Gestão industrial Sabor Purezza Massas'

  return <main className="access">
    <section className="access-card" aria-labelledby="access-title">
      <img className="access-logo" src={import.meta.env.BASE_URL + 'logo-320.webp'} alt="Sabor Purezza Massas"
        width={128} height={128} fetchPriority="high"/>
      <h1 id="access-title">{title}</h1>
      <p className="access-subtitle">{subtitle}</p>
      <form onSubmit={submit} aria-busy={busy}>
        {!recovery && <label>E-mail
          <input name="email" type="email" inputMode="email" autoComplete="username" required autoFocus/>
        </label>}
        {!reset && <label className="access-password">{recovery ? 'Nova senha' : 'Senha'}
          <input name="password" type={showPassword ? 'text' : 'password'} minLength={recovery ? 8 : undefined}
            autoComplete={recovery ? 'new-password' : 'current-password'} required/>
          <button type="button" className="icon-button" aria-pressed={showPassword}
            aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} onClick={() => setShowPassword(value => !value)}>
            {showPassword ? <EyeOff aria-hidden="true" size={18}/> : <Eye aria-hidden="true" size={18}/>}
          </button>
        </label>}
        <button type="submit" disabled={busy}>
          {busy ? <Loader2 className="access-spinner" aria-hidden="true" size={18}/> : !reset && !recovery && <LogIn aria-hidden="true" size={18}/>}
          {busy ? 'Aguarde…' : recovery ? 'Salvar senha' : reset ? 'Enviar instruções' : 'Entrar'}
        </button>
      </form>
      {!recovery && <button type="button" className="access-link" disabled={busy} onClick={() => { setReset(!reset); setMessage('') }}>
        {reset ? 'Voltar ao acesso' : 'Esqueci minha senha'}
      </button>}
      {message && <p className="access-feedback" role={failed ? 'alert' : 'status'}>{message}</p>}
      <p className="access-version">Sabor Purezza SMART · versão {__APP_VERSION__}</p>
    </section>
  </main>
}
