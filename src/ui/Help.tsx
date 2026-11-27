import { useState, useSyncExternalStore } from 'react'
import { Lightbulb, X } from 'lucide-react'
import { Modal } from './records'
import { getWorkspaceUser } from '../lib/workspace'
import { normalizeText } from '../lib/text'

type Tip = { title: string; text: string }
const tips: Record<string, Tip[]> = {
  ADMINISTRADOR: [
    { title: 'Busque qualquer coisa com Ctrl+K', text: 'Módulos, pedidos, clientes, produtos, lotes e ações como “Novo produto”. Use as setas e Enter.' },
    { title: 'Ações rápidas', text: 'Os botões no topo da Visão geral abrem direto o formulário mais usado do seu perfil.' },
    { title: 'Excluir ou inativar', text: 'No menu ⋮ de cada cadastro, veja as dependências antes. O que já foi usado não é excluído: inative.' },
    { title: 'Favoritos', text: 'Clique na estrela ao lado do nome da página para fixá-la no topo do menu.' },
  ],
  VENDAS: [
    { title: 'Novo pedido em um clique', text: 'Use “Novo pedido” nas ações rápidas da Visão geral ou digite “novo pedido” no Ctrl+K.' },
    { title: 'Pedidos atrasados', text: 'Em Pedidos, a visualização “Atrasados” mostra só o que passou do prazo e ainda não saiu.' },
    { title: 'Salve suas visualizações', text: 'Monte os filtros e clique em “Salvar visualização” para voltar a eles com um clique.' },
  ],
  PRODUCAO: [
    { title: 'Terminal da estação', text: 'Escolha sua estação uma vez. O terminal mostra a próxima massada e os botões para apontar.' },
    { title: 'Consultar lote', text: 'Na Rastreabilidade, digite ou leia o código do lote para ver origem e destino.' },
    { title: 'Modo TV', text: 'Abra “Modo TV” na TV da produção: atualiza sozinho e não permite alterações.' },
    { title: 'Registrar desperdício', text: 'Perdas durante a massada são apontadas no próprio cartão; as demais em Desperdícios.' },
  ],
}
const glossary: Tip[] = [
  { title: 'Estoque físico × disponível', text: 'Físico é o que está na prateleira. Disponível é o físico menos o que já está reservado para pedidos.' },
  { title: 'FEFO', text: '“Primeiro que vence, primeiro que sai”: o sistema sugere o lote com validade mais próxima.' },
  { title: 'OTIF', text: 'Pedidos entregues no prazo e completos, sobre o total de pedidos que venceram no período.' },
  { title: 'Excluir × inativar', text: 'Excluir apaga de vez e só vale para cadastro nunca usado. Inativar esconde das novas operações e preserva o histórico.' },
  { title: 'Receita aprovada × pendente', text: 'Só versões aprovadas tecnicamente entram em produção. Pendentes ainda estão em revisão.' },
  { title: 'Rendimento', text: 'Quanto de produto a receita gera. A massada compara o rendimento previsto com o medido.' },
  { title: 'Massada e OP', text: 'A ordem de produção (OP) é dividida em massadas; cada massada tem seu lote e sua rastreabilidade.' },
]

const listeners = new Set<() => void>()
let helpOpen = false
export const openHelp = () => { helpOpen = true; listeners.forEach(listener => listener()) }
const closeHelp = () => { helpOpen = false; listeners.forEach(listener => listener()) }
const useHelpOpen = () => useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener) }, () => helpOpen)

/** Central de ajuda pesquisável: dicas do perfil e glossário. Abre pelo menu do usuário. */
export function HelpCenter({ role }: { role?: string }) {
  const open = useHelpOpen()
  const [term, setTerm] = useState('')
  const needle = normalizeText(term)
  const match = (tip: Tip) => normalizeText(tip.title + ' ' + tip.text).includes(needle)
  const roleTips = (tips[role ?? ''] ?? []).filter(match)
  const terms = glossary.filter(match)
  return <Modal open={open} wide title="Dicas e ajuda" onClose={() => { closeHelp(); setTerm('') }}>
    <input type="search" aria-label="Pesquisar na ajuda" placeholder="Pesquisar na ajuda" value={term} onChange={event => setTerm(event.target.value)}/>
    {roleTips.length > 0 && <section><h3>Para o seu perfil</h3><dl className="ui-help-list">
      {roleTips.map(tip => <div key={tip.title}><dt>{tip.title}</dt><dd>{tip.text}</dd></div>)}</dl></section>}
    {terms.length > 0 && <section><h3>Termos do sistema</h3><dl className="ui-help-list">
      {terms.map(tip => <div key={tip.title}><dt>{tip.title}</dt><dd>{tip.text}</dd></div>)}</dl></section>}
    {!roleTips.length && !terms.length && <p className="ui-muted">Nada encontrado. Tente outra palavra.</p>}
    <p className="ui-muted">Estas dicas não substituem os procedimentos técnicos aprovados da fábrica.</p>
  </Modal>
}

const onboardingKey = () => 'purezza:onboarding:' + getWorkspaceUser()

/** Boas-vindas curtas por perfil na Visão geral. Dispensáveis; continuam em “Dicas e ajuda”. */
export function Onboarding({ role }: { role: string }) {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(onboardingKey()) === '1' } catch { return true } })
  const list = tips[role]
  if (dismissed || !list) return null
  const dismiss = () => { try { localStorage.setItem(onboardingKey(), '1') } catch { /* indisponível */ } setDismissed(true) }
  return <aside className="ui-onboarding" aria-label="Primeiros passos">
    <Lightbulb aria-hidden="true" size={22}/>
    <div>
      <strong>Primeiros passos</strong>
      <ul>{list.slice(0, 3).map(tip => <li key={tip.title}><b>{tip.title}.</b> {tip.text}</li>)}</ul>
      <div className="ui-inline-actions">
        <button type="button" className="secondary" onClick={openHelp}>Ver todas as dicas</button>
        <button type="button" className="secondary" onClick={dismiss}>Entendi, não mostrar de novo</button>
      </div>
    </div>
    <button type="button" className="icon-button" aria-label="Dispensar primeiros passos" onClick={dismiss}><X aria-hidden="true" size={18}/></button>
  </aside>
}
