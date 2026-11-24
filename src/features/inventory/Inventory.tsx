import { useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '../../lib/supabase'
import { LotLabel } from './LotLabel'
import { LotScanner } from './LotScanner'
import { StockPosition } from './StockPosition'
import { InventorySessions } from './InventorySessions'
import { StockWasteDetails } from './StockWaste'

export function Inventory({ admin, release }: { admin: boolean; release: boolean }) {
  const cache = useQueryClient()
  const [view, setView] = useState<'stock' | 'receive' | 'opening' | 'position' | 'sessions'>('stock')
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

  return <section className="panel">
    <h1>Estoque e recebimento</h1>
    <nav aria-label="Estoque">
      <button aria-pressed={view === 'stock'} onClick={() => setView('stock')}>Lotes e FEFO</button>
      <button aria-pressed={view === 'receive'} onClick={() => setView('receive')}>Registrar recebimento</button>
      {admin && <button aria-pressed={opening} onClick={() => setView('opening')}>Inventário inicial</button>}
      <button aria-pressed={view === 'position'} onClick={() => setView('position')}>Posição por data</button>
      <button aria-pressed={view === 'sessions'} onClick={() => setView('sessions')}>Sessões de inventário</button>
    </nav>
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
    {view === 'stock' && <LotScanner onFind={setLotCode}/>}
    {view === 'stock' && lotCode && <p>Filtro ativo: {lotCode}{' '}
      <button type="button" className="secondary" onClick={() => setLotCode(null)}>Limpar filtro</button>
    </p>}
    {data.isPending && <p role="status">Carregando estoque…</p>}
    {data.isError && <p role="alert">Falha ao consultar o estoque.</p>}
    {data.data && view === 'sessions' && <InventorySessions admin={admin} busy={busy}
      locations={data.data.locations} mutate={mutate}/>}
    {data.data && view === 'position' && <StockPosition
      items={data.data.allItems.map(item => ({ id: item.id, label: item.original_code + ' · ' + item.original_description }))}
      locations={data.data.allLocations.map(location => ({ id: location.id, label: location.code }))}
    />}
    {data.data && (view === 'receive' || (opening && admin)) && (
      data.data.items.length && (opening || data.data.suppliers.length > 0) && data.data.manufacturers.length && data.data.locations.length ?
        <form onSubmit={receive} key={view}>
          <label>Item <select name="item_id" required value={itemId} onChange={event => setItemId(event.target.value)}>
            <option value="">Selecione</option>{data.data.items.map(row => <option key={row.id} value={row.id}>{row.original_code} · {row.original_description}</option>)}
          </select></label>
          {!opening && <label>Fornecedor <select name="supplier_id" required><option value="">Selecione</option>{data.data.suppliers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
          <label>Fabricante <select name="manufacturer_id" required><option value="">Selecione</option>{data.data.manufacturers.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
          <label>Localização <select name="location_id" required><option value="">Selecione</option>{data.data.locations.map(row => <option key={row.id} value={row.id}>{row.code}</option>)}</select></label>
          <label>Lote original <input name="original_lot" required/></label>
          <label>Quantidade {item?.base_unit && `(${item.base_unit})`} <input name="quantity" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
          <label>Fabricação <input name="manufactured_on" type="date"/></label>
          <label>Validade <select name="expiry" value={expiry} onChange={event => setExpiry(event.target.value)}>
            <option value="INFORMADA">Informada</option><option value="DESCONHECIDA">Desconhecida</option><option value="NAO_APLICAVEL">Não aplicável</option>
          </select></label>
          {expiry === 'INFORMADA' && <label>Data de validade <input name="expires_on" type="date" required/></label>}
          {expiry === 'NAO_APLICAVEL' && <label>Justificativa <input name="expiry_reason" required/></label>}
          {opening ? <>
            <label>Referência da contagem inicial <input name="opening_reference" required/></label>
            <label>Documento de origem para liberação <input name="opening_invoice"/></label>
          </> : <>
            <label>Número da NF <input name="invoice_number"/></label>
            <label>Motivo da ausência da NF <input name="documentation_reason"/></label>
          </>}
          <button disabled={busy}>{opening ? 'Enviar abertura para revisão' : 'Registrar em quarentena'}</button>
        </form>
      : <p>{opening ? 'A abertura exige item com unidade base, fabricante e localização ativos.'
        : 'O recebimento exige item com unidade base, fornecedor, fabricante e localização ativos.'}</p>
    )}
    {data.data && view === 'stock' && <>
      <h2>Sugestão FEFO</h2>
      <form onSubmit={suggest} onChange={() => setSuggestions(null)}>
        <label>Item e unidade base <select name="item_id" required>
          <option value="">Selecione</option>{data.data.items.map(row => <option key={row.id} value={row.id}>{row.original_code} · {row.original_description} ({row.base_unit})</option>)}
        </select></label>
        <label>Quantidade na unidade base <input name="quantity" inputMode="decimal" pattern="[0-9]+([,.][0-9]{1,6})?" required/></label>
        <button>Consultar</button>
      </form>
      {suggestions && (suggestions.length ? <ul>{suggestions.map(row => <li key={row.internal_code + row.location_id}>
        {row.internal_code} · {data.data?.locations.find(location => location.id === row.location_id)?.code} · {number.format(row.suggested_quantity)}
      </li>)}</ul> : <p>Nenhum lote elegível para a consulta.</p>)}
      <h2>Lotes</h2>
      {data.data.stock.length === 0 && <p>{lotCode ? 'Nenhum lote encontrado para este código.' : 'Nenhum lote cadastrado.'}</p>}
      {data.data.stock.map(lot => {
        const catalog = lot.items as unknown as { original_description: string; classification: string } | null
        const locations = data.data!.locations
        const discardLocations = locations.filter(location => lot.stock_balances.some(balance =>
          balance.location_id === location.id && Number(balance.quantity) > 0
        ))
        const counts = data.data!.counts.filter(count => count.lot_id === lot.id)
        return <article key={lot.id}>
          <h2>{catalog?.original_description} · {lot.original_lot}</h2>
          <p>{lot.internal_code} · {lot.status} · {lot.expires_on?.split('-').reverse().join('/') ?? lot.expiry.replaceAll('_', ' ')}</p>
          {lot.opening_reference && <p>Inventário inicial · {lot.opening_reference}</p>}
          {lot.return_shipment_id && <p>Origem: devolução de expedição</p>}
          {lot.production_batch_id && <p>Origem: fabricação própria</p>}
          {lot.stock_balances.length > 0 && <LotLabel lotId={lot.id}/>}
          {admin && catalog && lot.stock_balances.length > 0 &&
            <StockWasteDetails lotId={lot.id} unit={lot.unit} classification={catalog.classification} locations={discardLocations}/>}
          <ul>{lot.stock_balances.map(balance => {
            const location = balance.locations as unknown as { code: string } | null
            return <li key={balance.location_id}>{location?.code} · {number.format(balance.quantity)} {lot.unit}</li>
          })}</ul>
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
          {admin && lot.status !== 'REPROVADO' && <form onSubmit={event => {
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
            <button disabled={busy}>Registrar decisão</button>
          </form>}
        </article>
      })}
    </>}
  </section>
}
