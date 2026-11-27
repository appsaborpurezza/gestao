import { useMemo, useRef, useState, type FormEvent } from 'react'
import { Boxes, X } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { LotLabel } from './LotLabel'
import { LotScanner } from './LotScanner'
import { StockPosition } from './StockPosition'
import { InventorySessions } from './InventorySessions'
import { StockWasteDetails } from './StockWaste'
import { Badge, ErrorState, PageHeader, Skeleton } from '../../ui'
import { Tabs } from '../../ui/Tabs'
import { Combobox } from '../../ui/Combobox'
import { DataTable, type Column } from '../../ui/DataTable'
import { FilterBar, SearchInput, useSessionState } from '../../ui/filters'
import { formatDate, matchesTerm } from '../../lib/text'
import { todayInSaoPaulo } from '../../lib/periods'
import { expiryLabels, expiryState, lotStatusLabels, lotStatusTones, lotTotal, type LotStatus } from './lotStatus'

type View = 'stock' | 'receive' | 'opening' | 'position' | 'sessions'
type LotFilters = { term: string; status: string; expiry: string }
const emptyLotFilters: LotFilters = { term: '', status: '', expiry: '' }

export function Inventory({ admin, release, initialLot, onOpen }: {
  admin: boolean; release: boolean; initialLot?: string | null; onOpen?: (lotId: string | null) => void
}) {
  const cache = useQueryClient()
  const [view, setView] = useState<View>('stock')
  const [filters, setFilters] = useSessionState<LotFilters>('inventory-lots', emptyLotFilters)
  // O lote aberto vem da URL quando há navegação; senão, fica no estado local.
  const [localLot, setLocalLot] = useState<string | null>(initialLot ?? null)
  const selectedLot = onOpen ? initialLot ?? null : localLot
  const openLot = (id: string | null) => { setScrollToLot(true); if (onOpen) onOpen(id); else setLocalLot(id) }
  const [scrollToLot, setScrollToLot] = useState(false)
  const [lotCode, setLotCode] = useState<string | null>(null)
  const opening = view === 'opening'
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const pending = useRef(new Map<string, string>())
  const data = useQuery({
    queryKey: ['inventory', lotCode],
    queryFn: async () => {
      const lots = supabase.from('inventory_lots').select('id,internal_code,original_lot,expires_on,expiry,status,version,unit,opening_reference,return_shipment_id,production_batch_id,items(original_description,classification),stock_balances(location_id,quantity,locations(code))').order('internal_code')
      if (lotCode) lots.eq('internal_code', lotCode)
      const [stock, items, suppliers, manufacturers, locations, counts] = await Promise.all([
        lots,
        supabase.from('items').select('id,original_code,original_description,base_unit,active').order('original_code'),
        supabase.from('suppliers').select('id,name').eq('active', true).order('name'),
        supabase.from('manufacturers').select('id,name').eq('active', true).order('name'),
        supabase.from('locations').select('id,code,active').order('code'),
        supabase.from('inventory_counts').select('id,lot_id,location_id,expected_quantity,counted_quantity,reason,counted_at')
          .is('decision', null).order('counted_at'),
      ])
      for (const result of [stock, items, suppliers, manufacturers, locations, counts]) {
        if (result.error) throw result.error
      }
      return {
        stock: stock.data!, counts: counts.data!, suppliers: suppliers.data!, manufacturers: manufacturers.data!,
        items: items.data!.filter(item => item.active && item.base_unit !== null),
        locations: locations.data!.filter(location => location.active),
        allItems: items.data!, allLocations: locations.data!,
      }
    },
  })
  const [itemId, setItemId] = useState('')
  const [manufacturerId, setManufacturerId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [fefoItem, setFefoItem] = useState('')
  const [expiry, setExpiry] = useState('INFORMADA')
  const item = data.data?.items.find(row => row.id === itemId)
  const [suggestions, setSuggestions] = useState<{ internal_code: string; location_id: string; suggested_quantity: number }[] | null>(null)
  const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 6 })

  async function mutate(operation: string, payload: Record<string, unknown>, success: string) {
    if (inFlight.current) return false
    inFlight.current = true
    setBusy(true)
    setMessage('')
    const key = JSON.stringify([operation, payload])
    const request_id = pending.current.get(key) ?? crypto.randomUUID()
    pending.current.set(key, request_id)
    try {
      const { error } = await supabase.rpc(operation, { ...payload, request_id })
      if (error) throw error
      pending.current.delete(key)
      setFailed(false)
      setMessage(success)
      setSuggestions(null)
      await cache.invalidateQueries({ queryKey: ['inventory'] })
      if (operation === 'decide_inventory_lot') {
        await Promise.all([
          cache.invalidateQueries({ queryKey: ['shipping'] }),
          cache.invalidateQueries({ queryKey: ['orders', 'reservations'] }),
        ])
      }
      return true
    } catch (error) {
      setFailed(true)
      setMessage(typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Falha na operação.')
      return false
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  async function receive(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const input = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value || null]))
    input.quantity = String(input.quantity).replace(',', '.')
    input.unit = item?.base_unit
    const operation = opening ? 'open_inventory_lot' : 'receive_stock'
    const success = opening ? 'Lote criado em quarentena. Contagem inicial pendente de revisão.' : 'Recebimento registrado em quarentena.'
    if (await mutate(operation, { input }, success)) {
      form.reset()
      setItemId('')
      setSupplierId('')
      setManufacturerId('')
      setExpiry('INFORMADA')
    }
  }

  async function suggest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setSuggestions(null)
    setMessage('')
    const fields = new FormData(event.currentTarget)
    const { data, error } = await supabase.rpc('suggest_fefo_lots', {
      target_item: fields.get('item_id'),
      requested_quantity: String(fields.get('quantity')).replace(',', '.'),
    })
    if (error) {
      setFailed(true)
      setMessage(error.message)
    } else setSuggestions(data)
  }

  const today = todayInSaoPaulo()
  const lots = useMemo(() => (data.data?.stock ?? []).map(lot => {
    const catalog = lot.items as unknown as { original_description: string; classification: string } | null
    return { ...lot, catalog, total: lotTotal(lot.stock_balances), expiryInfo: expiryState(lot.expires_on, today) }
  }), [data.data, today])
  type LotRow = typeof lots[number]
  const visibleLots = lots.filter(lot =>
    matchesTerm(filters.term, lot.internal_code, lot.original_lot, lot.catalog?.original_description)
    && (!filters.status || lot.status === filters.status)
    && (!filters.expiry || (filters.expiry === 'expired' ? lot.expiryInfo.state === 'expired'
      : filters.expiry === 'soon' ? lot.expiryInfo.state === 'soon' : lot.expiryInfo.state === 'none')))
  const activeFilters = [filters.term, filters.status, filters.expiry].filter(Boolean).length + (lotCode ? 1 : 0)
  const itemOptions = (data.data?.items ?? []).map(row => ({ value: row.id, label: row.original_code + ' · ' + row.original_description, hint: row.base_unit ?? undefined }))
  const columns: Column<LotRow>[] = [
    { id: 'code', header: 'Lote', sortValue: row => row.internal_code, cell: row => <span className="ui-cell-stack">
      <strong className="ui-code">{row.internal_code}</strong><small>Original {row.original_lot}</small></span> },
    { id: 'item', header: 'Item', sortValue: row => row.catalog?.original_description ?? '', cell: row => row.catalog?.original_description ?? '—' },
    { id: 'status', header: 'Situação', sortValue: row => row.status, cell: row =>
      <Badge tone={lotStatusTones[row.status as LotStatus] ?? 'neutral'}>{lotStatusLabels[row.status as LotStatus] ?? row.status}</Badge> },
    { id: 'expiry', header: 'Validade', sortValue: row => row.expires_on ?? '9999', cell: row => <span className="ui-cell-stack">
      <span>{row.expires_on ? formatDate(row.expires_on) : expiryLabels[row.expiry] ?? row.expiry}</span>
      {row.expiryInfo.state === 'expired' && <Badge tone="danger">Vencido</Badge>}
      {row.expiryInfo.state === 'soon' && <Badge tone="warning">{row.expiryInfo.days === 0 ? 'Vence hoje' : `Vence em ${row.expiryInfo.days} d`}</Badge>}
    </span> },
    { id: 'balance', header: 'Saldo físico', align: 'end', sortValue: row => row.total, cell: row => <span className="ui-cell-stack">
      <strong>{number.format(row.total)} {row.unit}</strong>
      <small>{row.stock_balances.filter(balance => Number(balance.quantity) > 0).length} {row.stock_balances.length === 1 ? 'local' : 'locais'}</small></span> },
    { id: 'origin', header: 'Origem', optional: true, cell: row => row.opening_reference ? 'Inventário inicial'
      : row.return_shipment_id ? 'Devolução' : row.production_batch_id ? 'Fabricação própria' : 'Recebimento' },
  ]
  const lot = lots.find(row => row.id === selectedLot)

  return <section className="panel">
    <PageHeader icon={Boxes} title="Estoque" description="Lotes, saldos por local, recebimentos e inventário."/>
    <Tabs label="Estoque" value={view} onChange={next => { setView(next); setMessage('') }} items={[
      { id: 'stock', label: 'Lotes e FEFO' },
      { id: 'receive', label: 'Registrar recebimento' },
      { id: 'opening', label: 'Inventário inicial', hidden: !admin },
      { id: 'position', label: 'Posição por data' },
      { id: 'sessions', label: 'Sessões de inventário' },
    ]}/>
    {message && <p className="ui-message" data-tone={failed ? 'danger' : 'success'} role={failed ? 'alert' : 'status'}>{message}</p>}
    {data.isPending && <Skeleton lines={5} label="Carregando estoque…"/>}
    {data.isError && <ErrorState title="Falha ao consultar o estoque" onRetry={() => void data.refetch()}/>}
    {data.data && view === 'sessions' && <InventorySessions admin={admin} busy={busy}
      locations={data.data.locations} mutate={mutate}/>}
    {data.data && view === 'position' && <StockPosition
      items={data.data.allItems.map(item => ({ id: item.id, label: item.original_code + ' · ' + item.original_description }))}
      locations={data.data.allLocations.map(location => ({ id: location.id, label: location.code }))}
    />}
    {data.data && (view === 'receive' || (opening && admin)) && (
      data.data.items.length && (opening || data.data.suppliers.length > 0) && data.data.manufacturers.length && data.data.locations.length ?
        <form className="ui-form" onSubmit={receive} key={view}>
          <fieldset className="ui-fieldset"><legend>Item e origem</legend>
            <Combobox label="Item" name="item_id" required value={itemId} onChange={setItemId} options={itemOptions}/>
            {!opening && <Combobox label="Fornecedor" name="supplier_id" required value={supplierId} onChange={setSupplierId}
              options={data.data.suppliers.map(row => ({ value: row.id, label: row.name }))}/>}
            <Combobox label="Fabricante" name="manufacturer_id" required value={manufacturerId} onChange={setManufacturerId}
              options={data.data.manufacturers.map(row => ({ value: row.id, label: row.name }))}/>
            <label>Localização <select name="location_id" required><option value="">Selecione</option>{data.data.locations.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}</select></label>
          </fieldset>
          <fieldset className="ui-fieldset"><legend>Lote e quantidade</legend>
            <label>Lote original <input name="original_lot" required/></label>
            <label>Quantidade {item?.base_unit && `(${item.base_unit})`} <input name="quantity" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
            <label>Fabricação <input name="manufactured_on" type="date"/></label>
            <label>Validade <select name="expiry" value={expiry} onChange={event => setExpiry(event.target.value)}>
              <option value="INFORMADA">Informada</option><option value="DESCONHECIDA">Desconhecida</option><option value="NAO_APLICAVEL">Não aplicável</option>
            </select></label>
            {expiry === 'INFORMADA' && <label>Data de validade <input name="expires_on" type="date" required/></label>}
            {expiry === 'NAO_APLICAVEL' && <label>Justificativa <input name="expiry_reason" required/></label>}
          </fieldset>
          <fieldset className="ui-fieldset"><legend>Documentação</legend>
          {opening ? <>
            <label>Referência da contagem inicial <input name="opening_reference" required/></label>
            <label>Documento de origem para liberação <input name="opening_invoice"/></label>
          </> : <>
            <label>Número da NF <input name="invoice_number"/></label>
            <label>Motivo da ausência da NF <input name="documentation_reason"/></label>
          </>}
          </fieldset>
          <div className="ui-form-actions">
            <button disabled={busy}>{opening ? 'Enviar abertura para revisão' : 'Registrar em quarentena'}</button>
          </div>
        </form>
      : <p>{opening ? 'A abertura exige item com unidade base, fabricante e localização ativos.'
        : 'O recebimento exige item com unidade base, fornecedor, fabricante e localização ativos.'}</p>
    )}
    {data.data && view === 'stock' && <>
      <FilterBar activeCount={activeFilters} onClear={() => { setFilters(emptyLotFilters); setLotCode(null) }}
        onRefresh={() => void data.refetch()} refreshing={data.isFetching}>
        <SearchInput label="Pesquisar por lote, lote original ou item" value={filters.term}
          onChange={term => setFilters({ ...filters, term })}/>
        <label>Situação <select value={filters.status} onChange={event => setFilters({ ...filters, status: event.target.value })}>
          <option value="">Todas</option>
          {Object.entries(lotStatusLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select></label>
        <label>Validade <select value={filters.expiry} onChange={event => setFilters({ ...filters, expiry: event.target.value })}>
          <option value="">Qualquer</option><option value="expired">Vencidos</option>
          <option value="soon">Vencem em até 30 dias</option><option value="none">Sem data informada</option>
        </select></label>
      </FilterBar>
      <LotScanner onFind={setLotCode}/>
      {lotCode && <p>Código lido: <strong className="ui-code">{lotCode}</strong>{' '}
        <button type="button" className="secondary" onClick={() => setLotCode(null)}>Limpar leitura</button>
      </p>}
      <DataTable caption="Lotes" rows={visibleLots} columns={columns} rowKey={row => row.id}
        loading={data.isFetching && !data.data} preferenceKey="inventory-lots"
        filtered={activeFilters > 0} onClearFilters={() => { setFilters(emptyLotFilters); setLotCode(null) }}
        empty={{ title: lotCode ? 'Nenhum lote encontrado para este código' : 'Nenhum lote cadastrado',
          description: 'Registre um recebimento para criar o primeiro lote.' }}
        onRowOpen={row => openLot(row.id)}
        rowActions={row => <button type="button" className="secondary" onClick={() => openLot(row.id)}>Abrir</button>}/>
      {selectedLot && !lot && !data.isFetching && <ErrorState title="Lote não encontrado"
        description="O lote não existe ou não está visível para o seu perfil."/>}
      {lot && (() => {
        const catalog = lot.catalog
        const locations = data.data!.locations
        const discardLocations = locations.filter(location => lot.stock_balances.some(balance =>
          balance.location_id === location.id && Number(balance.quantity) > 0
        ))
        const counts = data.data!.counts.filter(count => count.lot_id === lot.id)
        return <article className="ui-detail" aria-labelledby="lot-detail-title" key={lot.id}
          ref={element => { if (element && scrollToLot) { setScrollToLot(false); element.scrollIntoView({ block: 'start', behavior: 'smooth' }) } }}>
          <div className="ui-detail-header">
            <div>
              <h2 id="lot-detail-title">{catalog?.original_description} · {lot.original_lot}</h2>
              <span className="ui-code">{lot.internal_code}</span>{' '}
              <Badge tone={lotStatusTones[lot.status as LotStatus] ?? 'neutral'}>{lotStatusLabels[lot.status as LotStatus] ?? lot.status}</Badge>
            </div>
            <button type="button" className="secondary" onClick={() => openLot(null)}><X aria-hidden="true" size={16}/>Fechar</button>
          </div>
          <dl>
            <div><dt>Validade</dt><dd>{lot.expires_on ? formatDate(lot.expires_on) : expiryLabels[lot.expiry] ?? lot.expiry}
              {lot.expiryInfo.state === 'expired' && <> <Badge tone="danger">Vencido</Badge></>}
              {lot.expiryInfo.state === 'soon' && <> <Badge tone="warning">{lot.expiryInfo.days === 0 ? 'Vence hoje' : `Vence em ${lot.expiryInfo.days} d`}</Badge></>}</dd></div>
            <div><dt>Saldo físico total</dt><dd>{number.format(lot.total)} {lot.unit}</dd></div>
            <div><dt>Origem</dt><dd>{lot.opening_reference ? 'Inventário inicial · ' + lot.opening_reference
              : lot.return_shipment_id ? 'Devolução de expedição' : lot.production_batch_id ? 'Fabricação própria' : 'Recebimento'}</dd></div>
            {lot.stock_balances.map(balance => {
              const location = balance.locations as unknown as { code: string } | null
              return <div key={balance.location_id}><dt>Local {location?.code}</dt><dd>{number.format(balance.quantity)} {lot.unit}</dd></div>
            })}
          </dl>
          {lot.stock_balances.length > 0 && <LotLabel lotId={lot.id}/>}
          {admin && catalog && lot.stock_balances.length > 0 &&
            <StockWasteDetails lotId={lot.id} unit={lot.unit} classification={catalog.classification} locations={discardLocations}/>}
          {locations.length > 0 && <details><summary>Registrar contagem</summary>
            <form onSubmit={async event => {
              event.preventDefault()
              const form = event.currentTarget
              const fields = new FormData(form)
              const saved = await mutate('record_inventory_count', {
                target_lot: lot.id,
                target_location: fields.get('location'),
                amount: String(fields.get('amount')).replace(',', '.'),
                reason: fields.get('reason'),
              }, 'Contagem registrada para revisão.')
              if (saved) form.reset()
            }}>
              <label>Local <select name="location" required><option value="">Selecione</option>
                {locations.map(location => <option key={location.id} value={location.id}>{location.code}</option>)}
              </select></label>
              <label>Quantidade contada ({lot.unit}) <input name="amount" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
              <label>Motivo <input name="reason" required/></label>
              <button disabled={busy}>Enviar para revisão</button>
            </form>
          </details>}
          {counts.length > 0 && <details><summary>Contagens pendentes ({counts.length})</summary>
            {counts.map(count => <article key={count.id}>
              <p>{locations.find(location => location.id === count.location_id)?.code ?? 'Local inativo'}
                {' · '}{new Date(count.counted_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p>
              <p>Saldo registrado {number.format(count.expected_quantity)} {lot.unit} · Contagem {number.format(count.counted_quantity)} {lot.unit}</p>
              <p>{count.reason}</p>
              {admin && <form onSubmit={event => {
                event.preventDefault()
                const fields = new FormData(event.currentTarget)
                void mutate('review_inventory_count', {
                  target_count: count.id, approve: fields.get('decision') === 'approve', reason: fields.get('reason'),
                }, 'Revisão registrada.')
              }}>
                <label>Decisão <select name="decision" required><option value="">Selecione</option>
                  <option value="approve">Aprovar ajuste</option><option value="reject">Rejeitar contagem</option>
                </select></label>
                <label>Justificativa <input name="reason" required/></label>
                <button disabled={busy}>Confirmar decisão</button>
              </form>}
            </article>)}
          </details>}
          {data.data!.locations.length > 1 && lot.stock_balances.some(balance => Number(balance.quantity) > 0) &&
            <details><summary>Transferir saldo</summary>
              <form onSubmit={async event => {
                event.preventDefault()
                const form = event.currentTarget
                const fields = new FormData(form)
                const moved = await mutate('transfer_stock', {
                  target_lot: lot.id,
                  from_location: fields.get('from'),
                  to_location: fields.get('to'),
                  amount: String(fields.get('amount')).replace(',', '.'),
                }, 'Transferência registrada.')
                if (moved) form.reset()
              }}>
                <label>Origem <select name="from" required><option value="">Selecione</option>
                  {data.data!.locations.filter(location => lot.stock_balances.some(balance =>
                    balance.location_id === location.id && Number(balance.quantity) > 0
                  )).map(location => <option key={location.id} value={location.id}>{location.code}</option>)}
                </select></label>
                <label>Destino <select name="to" required><option value="">Selecione</option>
                  {data.data!.locations.map(location => <option key={location.id} value={location.id}>{location.code}</option>)}
                </select></label>
                <label>Quantidade ({lot.unit}) <input name="amount" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
                <button disabled={busy}>Registrar transferência</button>
              </form>
            </details>}
          {admin && lot.status !== 'REPROVADO' && <form className="ui-inline-form lot-decision" aria-label="Decisão de qualidade" onSubmit={event => {
            event.preventDefault()
            const fields = new FormData(event.currentTarget)
            void mutate('decide_inventory_lot', { target: lot.id, expected_version: lot.version, decision: fields.get('decision'), reason: fields.get('reason') }, 'Decisão registrada.')
          }}>
            <label>Decisão <select name="decision" required><option value="">Selecione</option>
              {release && lot.status !== 'LIBERADO' && !lot.return_shipment_id && <option value="LIBERADO">Liberar</option>}
              {lot.status !== 'BLOQUEADO' && <option value="BLOQUEADO">Bloquear</option>}
              <option value="REPROVADO">Reprovar</option>
            </select></label>
            <label>Motivo <input name="reason" required/></label>
            <div><button disabled={busy}>Registrar decisão</button></div>
          </form>}
        </article>
      })()}
      <section className="ui-fieldset" aria-labelledby="fefo-title">
        <h2 id="fefo-title">Sugestão FEFO</h2>
        <form className="ui-inline-form" onSubmit={suggest}>
          <Combobox label="Item" name="item_id" required value={fefoItem}
            onChange={value => { setFefoItem(value); setSuggestions(null) }} options={itemOptions}/>
          <label>Quantidade na unidade base <input name="quantity" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required
            onChange={() => setSuggestions(null)}/></label>
          <div><button>Consultar</button></div>
        </form>
        {suggestions && (suggestions.length ? <ol>{suggestions.map(row => <li key={row.internal_code + row.location_id}>
          <span className="ui-code">{row.internal_code}</span> · {data.data?.locations.find(location => location.id === row.location_id)?.code} · {number.format(row.suggested_quantity)}
        </li>)}</ol> : <p>Nenhum lote elegível para a consulta.</p>)}
      </section>
    </>}
  </section>
}
