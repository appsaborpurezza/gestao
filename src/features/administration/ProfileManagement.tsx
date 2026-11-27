import { useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { KeyRound, Link2, MailPlus, ShieldCheck } from 'lucide-react'
import { supabase } from '../../lib/supabase'
import { Badge, PageHeader } from '../../ui'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar, SearchInput } from '../../ui/filters'
import { Modal, RecordActions, RecordDrawer } from '../../ui/records'
import { toast } from '../../ui/toast'
import { matchesTerm } from '../../lib/text'

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

  return <section aria-label="Editar perfil" className="ui-form">
    {own && <p className="ui-message">Você está editando o próprio perfil: perfil, situação e permissões só podem ser alterados por outro administrador.</p>}
    <form className="ui-form" onSubmit={prepare} hidden={!!review || saved}>
      <label>Nome <input name="name" required maxLength={120} defaultValue={profile.display_name}/></label>
      {!own && <fieldset className="ui-fieldset">
        <legend>Acesso</legend>
        <label>Perfil <select name="role" defaultValue={profile.role}>
          {Object.entries(roles).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
        </select></label>
        <label className="customer-check"><input type="checkbox" name="active" defaultChecked={profile.active}/> Conta ativa</label>
        <label className="customer-check"><input type="checkbox" name="release" defaultChecked={profile.can_release_lot}/> Liberar lotes</label>
        <label className="customer-check"><input type="checkbox" name="approve" defaultChecked={profile.can_approve_recipe}/> Aprovar receitas</label>
      </fieldset>}
      <div className="ui-modal-actions"><button type="button" className="secondary" onClick={onClose}>Cancelar</button>
        <button type="submit">Revisar alterações</button></div>
    </form>
    {review && !saved && <>
      <p className="ui-message">Confira antes de confirmar. A alteração fica registrada na auditoria.</p>
      <p>{review.name} · {roles[review.next_role]} · {review.next_active ? 'Conta ativa' : 'Conta inativa'}</p>
      <p>Liberar lotes: {review.release_lot ? 'Sim' : 'Não'} · Aprovar receitas: {review.approve_recipe ? 'Sim' : 'Não'}</p>
      <div className="ui-modal-actions">
        <button type="button" className="secondary" disabled={saving} onClick={() => { setReview(null); setMessage('') }}>Voltar à edição</button>
        <button type="button" onClick={() => void save()} disabled={saving}>{saving ? 'Salvando…' : 'Confirmar alterações'}</button>
      </div>
    </>}
    {message && <p className="ui-message" data-tone={failed ? 'danger' : 'success'} role={failed ? 'alert' : 'status'}>{message}</p>}
    {saved && <div className="ui-modal-actions"><button type="button" onClick={onClose}>Voltar aos perfis</button></div>}
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
  return <form className="ui-form" onSubmit={submit}>
    <p className="ui-muted">Use quando a conta já foi criada e confirmada diretamente no Supabase Auth.</p>
    <label>E-mail da conta confirmada <input name="email" type="email" required maxLength={254}/></label>
    <label>Nome <input name="name" required maxLength={120}/></label>
    <label>Perfil <select name="role" defaultValue="PRODUCAO">
      {Object.entries(roles).map(([key,label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    {message && <p className="ui-message" data-tone="danger" role="alert">{message}</p>}
    <div className="ui-modal-actions"><button disabled={busy}>{busy ? 'Vinculando…' : 'Confirmar vínculo'}</button></div>
  </form>
}

type AuthAction = 'invite' | 'resend' | 'revoke' | 'reset_password'

/**
 * Operações do Supabase Auth pela Edge Function admin-users, que guarda a chave secreta no servidor.
 * O navegador só envia o token do próprio administrador; a função confere o perfil antes de agir.
 */
async function callAuthAdmin(body: Record<string, unknown> & { action: AuthAction }) {
  const { data, error } = await supabase.functions.invoke('admin-users', { body })
  if (error) {
    // A resposta de erro da função traz uma mensagem pronta para o operador.
    const context = (error as { context?: Response }).context
    const detail = context ? await context.json().catch(() => null) as { error?: string } | null : null
    if (detail?.error) throw new Error(detail.error)
    throw new Error(/not found|404|Failed to send/i.test(error.message)
      ? 'O serviço de convites ainda não está publicado neste ambiente.' : 'Não foi possível concluir a operação.')
  }
  return data as { ok: boolean; id?: string }
}

function InviteUser({ onDone }: { onDone: () => void }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setBusy(true); setMessage('')
    try {
      await callAuthAdmin({ action: 'invite', email: String(fields.get('email')).trim(), name: String(fields.get('name')).trim(), role: fields.get('role') })
      await cache.invalidateQueries({ queryKey: ['profile-management'] })
      toast('Convite enviado. O perfil aparece na lista e o acesso começa quando a pessoa definir a senha.')
      onDone()
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Não foi possível enviar o convite.') } finally { setBusy(false) }
  }
  return <form className="ui-form" onSubmit={submit}>
    <p className="ui-muted">A pessoa recebe um e-mail para definir a senha e entrar no portal. Permissões especiais (liberar lotes, aprovar receitas) são concedidas depois, na edição do perfil.</p>
    <label><span>E-mail <span className="ui-required" aria-hidden="true">*</span></span><input name="email" type="email" required maxLength={254} autoComplete="off"/></label>
    <label><span>Nome <span className="ui-required" aria-hidden="true">*</span></span><input name="name" required maxLength={120}/></label>
    <label><span>Perfil <span className="ui-required" aria-hidden="true">*</span></span><select name="role" defaultValue="PRODUCAO">
      {Object.entries(roles).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
    </select></label>
    {message && <p className="ui-message" data-tone="danger" role="alert">{message}</p>}
    <div className="ui-modal-actions"><button disabled={busy}>{busy ? 'Enviando…' : 'Enviar convite'}</button></div>
  </form>
}

/** Reenviar convite, revogar convite pendente ou enviar redefinição de senha, pelo e-mail da conta. */
function AccessByEmail({ onDone }: { onDone: () => void }) {
  const cache = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [action, setAction] = useState<Exclude<AuthAction, 'invite'>>('reset_password')
  const labels = { reset_password: 'Enviar redefinição de senha', resend: 'Reenviar convite', revoke: 'Revogar convite pendente' }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const email = String(new FormData(event.currentTarget).get('email')).trim()
    setBusy(true); setMessage('')
    try {
      await callAuthAdmin({ action, email })
      if (action === 'revoke') await cache.invalidateQueries({ queryKey: ['profile-management'] })
      toast(action === 'revoke' ? 'Convite revogado.' : action === 'resend' ? 'Convite reenviado.' : 'E-mail de redefinição enviado.')
      onDone()
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'Não foi possível concluir.') } finally { setBusy(false) }
  }
  return <form className="ui-form" onSubmit={submit}>
    <label><span>Ação</span><select value={action} onChange={event => setAction(event.target.value as typeof action)}>
      {Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    <label><span>E-mail da conta <span className="ui-required" aria-hidden="true">*</span></span><input name="email" type="email" required maxLength={254} autoComplete="off"/></label>
    {action === 'revoke' && <p className="ui-message">Só vale para convite nunca aceito e sem nenhuma operação. Contas usadas são preservadas: desative o perfil.</p>}
    {message && <p className="ui-message" data-tone="danger" role="alert">{message}</p>}
    <div className="ui-modal-actions"><button className={action === 'revoke' ? 'danger' : undefined} disabled={busy}>{busy ? 'Aguarde…' : labels[action]}</button></div>
  </form>
}

export default function ProfileManagement({ userId }: { userId: string }) {
  const [editor, setEditor] = useState<Profile | null>(null)
  const [panel, setPanel] = useState<'invite' | 'link' | 'access' | null>(null)
  const [term, setTerm] = useState('')
  const [status, setStatus] = useState('')
  const profiles = useQuery({
    queryKey: ['profile-management', userId],
    queryFn: async ({ signal }) => {
      // Perfis são poucos (dezenas): a lista inteira vem de uma vez e filtra no navegador.
      const { data, error } = await supabase.from('profiles')
        .select('id,display_name,role,active,can_release_lot,can_approve_recipe,profile_version')
        .order('display_name').order('id').limit(500).abortSignal(signal)
      if (error) throw error
      return data as Profile[]
    },
  })
  const rows = profiles.data?.filter(profile => matchesTerm(term, profile.display_name, roles[profile.role])
    && (!status || (status === 'active') === profile.active))
  const activeAdmins = profiles.data?.filter(profile => profile.role === 'ADMINISTRADOR' && profile.active).length ?? 0
  const columns: Column<Profile>[] = [
    { id: 'name', header: 'Nome', sortValue: row => row.display_name, cell: row => <strong>{row.display_name}{row.id === userId && <small className="ui-muted"> (você)</small>}</strong> },
    { id: 'role', header: 'Perfil', sortValue: row => roles[row.role], cell: row => <Badge tone={row.role === 'ADMINISTRADOR' ? 'info' : 'neutral'}>{roles[row.role]}</Badge> },
    { id: 'active', header: 'Conta', sortValue: row => row.active ? 0 : 1, cell: row => <Badge tone={row.active ? 'success' : 'neutral'}>{row.active ? 'Ativa' : 'Inativa'}</Badge> },
    { id: 'release', header: 'Libera lotes', optional: true, cell: row => row.can_release_lot ? 'Sim' : 'Não' },
    { id: 'approve', header: 'Aprova receitas', optional: true, cell: row => row.can_approve_recipe ? 'Sim' : 'Não' },
  ]
  const panelTitle = { invite: 'Convidar usuário', link: 'Vincular conta confirmada', access: 'Senha e convites' }
  return <section className="panel">
    <PageHeader icon={ShieldCheck} title="Usuários e permissões"
      description={`Perfis de acesso, convites e redefinição de senha. ${activeAdmins} administrador(es) ativo(s); o último nunca pode ser desativado.`}
      actions={<>
        <button type="button" className="secondary" onClick={() => setPanel('access')}><KeyRound aria-hidden="true" size={16}/>Senha e convites</button>
        <button type="button" className="secondary" onClick={() => setPanel('link')}><Link2 aria-hidden="true" size={16}/>Vincular conta</button>
        <button type="button" onClick={() => setPanel('invite')}><MailPlus aria-hidden="true" size={16}/>Convidar usuário</button>
      </>}/>
    <FilterBar activeCount={[term, status].filter(Boolean).length} onClear={() => { setTerm(''); setStatus('') }}
      onRefresh={() => void profiles.refetch()} refreshing={profiles.isFetching}>
      <SearchInput label="Pesquisar por nome ou perfil" value={term} onChange={setTerm}/>
      <select aria-label="Situação da conta" value={status} onChange={event => setStatus(event.target.value)}>
        <option value="">Ativas e inativas</option><option value="active">Somente ativas</option><option value="inactive">Somente inativas</option>
      </select>
    </FilterBar>
    <DataTable caption="Perfis" rows={rows} columns={columns} rowKey={row => row.id} loading={profiles.isFetching}
      error={profiles.isError} onRetry={() => void profiles.refetch()} preferenceKey="profiles"
      filtered={Boolean(term || status)} onClearFilters={() => { setTerm(''); setStatus('') }}
      empty={{ title: 'Nenhum perfil encontrado', description: 'Use “Convidar usuário” para dar acesso ao portal.' }}
      onRowOpen={row => setEditor(row)}
      rowActions={row => <RecordActions label={row.display_name} onEdit={() => setEditor(row)} actions={[]}/>}/>
    <RecordDrawer open={editor !== null} dirty={false} onClose={() => setEditor(null)} title={'Editar ' + (editor?.display_name ?? '')}
      subtitle="Usuários com histórico nunca são excluídos: desative a conta para bloquear o acesso.">
      {editor && <EditProfile key={editor.id + editor.profile_version} profile={editor} own={editor.id === userId} onClose={() => setEditor(null)}/>}
    </RecordDrawer>
    <Modal open={panel !== null} title={panel ? panelTitle[panel] : ''} onClose={() => setPanel(null)}>
      {panel === 'invite' && <InviteUser onDone={() => setPanel(null)}/>}
      {panel === 'link' && <LinkProfile onDone={() => { toast('Conta vinculada.'); setPanel(null) }}/>}
      {panel === 'access' && <AccessByEmail onDone={() => setPanel(null)}/>}
    </Modal>
  </section>
}
