import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'

const roles = { ADMINISTRADOR: 'Administração', VENDAS: 'Vendas', PRODUCAO: 'Produção' }
type Profile = {
  id: string; display_name: string; role: keyof typeof roles; active: boolean
  can_release_lot: boolean; can_approve_recipe: boolean; profile_version: number
}
type Fields = { name: string; next_role: Profile['role']; next_active: boolean; release_lot: boolean; approve_recipe: boolean }

function EditProfile({ profile, own, onClose }: { profile: Profile; own: boolean; onClose: () => void }) {
  const cache = useQueryClient()
  const [review, setReview] = useState<Fields | null>(null)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)
  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setMessage('')
    setReview({
      name: String(fields.get('name')).trim(),
      next_role: own ? profile.role : String(fields.get('role')) as Profile['role'],
      next_active: own ? profile.active : fields.has('active'),
      release_lot: own ? profile.can_release_lot : fields.has('release'),
      approve_recipe: own ? profile.can_approve_recipe : fields.has('approve'),
    })
  }
  async function save() {
    if (!review || saving) return
    setSaving(true)
    setMessage('')
    try {
      const { error } = await supabase.rpc('manage_profile', {
        target: profile.id, expected_version: profile.profile_version, ...review,
      })
      if (error) {
        setFailed(true)
        setMessage(error.code === '40001' ? 'Outro usuário alterou este perfil. Feche e abra a edição para recarregar.'
          : error.code === '23514' ? 'Mantenha pelo menos um administrador ativo.' : 'Não foi possível salvar o perfil.')
        return
      }
      setFailed(false)
      setSaved(true)
      setMessage('Perfil salvo.')
      await Promise.all([cache.invalidateQueries({ queryKey: ['profile-management'] }),cache.invalidateQueries({ queryKey: ['profile', profile.id] })])
    } catch {
      setFailed(true)
      setMessage('Não foi possível conectar ao serviço. Tente novamente.')
    } finally { setSaving(false) }
  }

  return <section aria-label="Editar perfil">
    <h2>Editar {profile.display_name}</h2>
    <form onSubmit={prepare} hidden={!!review || saved}>
      <label>Nome <input name="name" required maxLength={120} defaultValue={profile.display_name}/></label>
      {!own && <fieldset>
        <legend>Acesso</legend>
        <label>Perfil <select name="role" defaultValue={profile.role}>
          {Object.entries(roles).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label className="customer-check"><input type="checkbox" name="active" defaultChecked={profile.active}/> Conta ativa</label>
        <label className="customer-check"><input type="checkbox" name="release" defaultChecked={profile.can_release_lot}/> Liberar lotes</label>
        <label className="customer-check"><input type="checkbox" name="approve" defaultChecked={profile.can_approve_recipe}/> Aprovar receitas</label>
      </fieldset>}
      <div className="customer-actions"><button type="submit">Revisar alterações</button>
        <button type="button" className="secondary" onClick={onClose}>Cancelar</button></div>
    </form>
    {review && !saved && <>
      <p>{review.name} · {roles[review.next_role]} · {review.next_active ? 'Conta ativa' : 'Conta inativa'}</p>
      <p>Liberar lotes: {review.release_lot ? 'Sim' : 'Não'} · Aprovar receitas: {review.approve_recipe ? 'Sim' : 'Não'}</p>
      <div className="customer-actions">
        <button type="button" onClick={() => void save()} disabled={saving}>{saving ? 'Salvando…' : 'Confirmar alterações'}</button>
        <button type="button" className="secondary" disabled={saving} onClick={() => { setReview(null); setMessage('') }}>Voltar à edição</button>
        <button type="button" className="secondary" disabled={saving} onClick={onClose}>Fechar</button>
      </div>
    </>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    {saved && <button type="button" className="secondary" onClick={onClose}>Voltar aos perfis</button>}
  </section>
}

function LinkProfile({ onDone }: { onDone: () => void }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const fields = new FormData(event.currentTarget)
    setBusy(true)
    setMessage('')
    try {
      const { error } = await supabase.rpc('link_auth_profile', {
        email_address: String(fields.get('email')).trim(),
        name: String(fields.get('name')).trim(),
        assigned_role: fields.get('role'),
      })
      if (error) {
        setMessage(error.code === '23505' ? 'A conta já possui perfil.'
          : error.code === '22023' ? 'Confira o nome e o e-mail da conta confirmada no Supabase Auth.'
          : 'Não foi possível vincular a conta.')
        return
      }
      await cache.invalidateQueries({ queryKey: ['profile-management'] })
      onDone()
    } catch {
      setMessage('Não foi possível conectar ao serviço. Tente novamente.')
    } finally { setBusy(false) }
  }
  return <form onSubmit={submit}>
    <label>E-mail da conta confirmada <input name="email" type="email" required maxLength={254}/></label>
    <label>Nome <input name="name" required maxLength={120}/></label>
    <label>Perfil <select name="role" defaultValue="PRODUCAO">
      {Object.entries(roles).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    <button disabled={busy}>{busy ? 'Vinculando…' : 'Confirmar vínculo'}</button>
    {message && <p role="alert">{message}</p>}
  </form>
}

export default function ProfileManagement({ userId }: { userId: string }) {
  const [page, setPage] = useState(0)
  const [editor, setEditor] = useState<Profile | null>(null)
  const [linked, setLinked] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const size = 25
  const profiles = useQuery({
    queryKey: ['profile-management', userId, page],
    queryFn: async ({ signal }) => {
      const { data, count, error } = await supabase.from('profiles')
        .select('id,display_name,role,active,can_release_lot,can_approve_recipe,profile_version', { count: 'exact' })
        .order('display_name').order('id').range(page * size, (page + 1) * size - 1).abortSignal(signal)
      if (error) throw error
      return { rows: data as Profile[], total: count ?? 0 }
    },
  })
  return <section className="panel">
    <h1>Usuários e permissões</h1>
    {editor ? <EditProfile key={editor.id} profile={editor} own={editor.id === userId} onClose={() => setEditor(null)}/> : <>
      {linked && <p role="status">Conta vinculada.</p>}
      <button type="button" className="secondary" aria-expanded={linkOpen} onClick={() => {
        setLinked(false)
        setLinkOpen(!linkOpen)
      }}>{linkOpen ? 'Fechar vínculo' : 'Vincular conta confirmada'}</button>
      {linkOpen && <LinkProfile onDone={() => { setLinked(true); setLinkOpen(false) }}/>}
      {profiles.isPending && <p role="status">Carregando perfis…</p>}
      {profiles.isError && <p role="alert">Falha ao consultar perfis. <button type="button" onClick={() => void profiles.refetch()}>Tentar novamente</button></p>}
      {profiles.data?.total === 0 && <p>Nenhum perfil encontrado.</p>}
      {!!profiles.data?.rows.length && <div className="table-scroll"><table>
        <thead><tr><th>Nome</th><th>Perfil</th><th>Conta</th><th>Libera lotes</th><th>Aprova receitas</th><th>Ação</th></tr></thead>
        <tbody>{profiles.data.rows.map(profile => <tr key={profile.id}>
          <th scope="row">{profile.display_name}</th><td>{roles[profile.role]}</td><td>{profile.active ? 'Ativa' : 'Inativa'}</td>
          <td>{profile.can_release_lot ? 'Sim' : 'Não'}</td><td>{profile.can_approve_recipe ? 'Sim' : 'Não'}</td>
          <td><button type="button" className="secondary" onClick={() => setEditor(profile)}>Editar<span className="sr-only"> {profile.display_name}</span></button></td>
        </tr>)}</tbody>
      </table></div>}
      {profiles.data && (page > 0 || profiles.data.total > size) && <nav aria-label="Páginas de perfis">
        <button type="button" disabled={!page} onClick={() => setPage(page - 1)}>Anterior</button>
        <button type="button" disabled={(page + 1) * size >= profiles.data.total} onClick={() => setPage(page + 1)}>Próxima</button>
      </nav>}
    </>}
  </section>
}
