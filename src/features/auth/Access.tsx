import { useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'

export function Access({ recovery }: { recovery: boolean }) {
  const [reset, setReset] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
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
      setFailed(Boolean(result.error))
      if (result.error) setMessage(result.error.message)
      else if (recovery) {
        await supabase.auth.signOut()
        location.replace(location.origin + import.meta.env.BASE_URL)
      } else if (reset) setMessage('Se o endereço estiver cadastrado, confira as instruções no seu e-mail.')
    } catch {
      setFailed(true)
      setMessage('Não foi possível conectar ao serviço de autenticação.')
    } finally {
      setBusy(false)
    }
  }

  return <main className="access">
    <section className="panel">
      <img className="logo" src={import.meta.env.BASE_URL + 'logo.png'} alt="Sabor Purezza Massas"/>
      <h1>{recovery ? 'Nova senha' : reset ? 'Recuperar senha' : 'Sabor Purezza SMART'}</h1>
      <form onSubmit={submit}>
        {!recovery && <label>E-mail <input name="email" type="email" autoComplete="username" required/></label>}
        {!reset && <label>{recovery ? 'Nova senha' : 'Senha'}
          <input name="password" type="password" autoComplete={recovery ? 'new-password' : 'current-password'} required/>
        </label>}
        <button disabled={busy}>{busy ? 'Aguarde…' : recovery ? 'Salvar senha' : reset ? 'Enviar instruções' : 'Entrar'}</button>
      </form>
      {!recovery && <button className="secondary" disabled={busy} onClick={() => { setReset(!reset); setMessage('') }}>
        {reset ? 'Voltar ao acesso' : 'Esqueci a senha'}
      </button>}
      {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    </section>
  </main>
}
