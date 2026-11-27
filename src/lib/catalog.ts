import { useRef, useState } from 'react'
import { supabase } from './supabase'

/** Entidades aceitas pelas RPCs de ciclo de vida (lista fixa também no banco). */
export type CatalogEntity = 'CLIENTE' | 'PRODUTO' | 'INSUMO' | 'FORNECEDOR' | 'FABRICANTE' | 'LOCAL'
  | 'MOTIVO_PERDA' | 'DESTINACAO_PERDA' | 'VERSAO_RECEITA' | 'CONFIG_EMBALAGEM'

export const entityLabels: Record<CatalogEntity, string> = {
  CLIENTE: 'Cliente', PRODUTO: 'Produto', INSUMO: 'Insumo', FORNECEDOR: 'Fornecedor', FABRICANTE: 'Fabricante',
  LOCAL: 'Local de estoque', MOTIVO_PERDA: 'Motivo de perda', DESTINACAO_PERDA: 'Destinação de perda',
  VERSAO_RECEITA: 'Versão de receita', CONFIG_EMBALAGEM: 'Configuração de embalagem',
}

export type CatalogPreview = {
  entity: CatalogEntity; record_id: string; record_version: number
  code: string | null; name: string; active: boolean | null
  can_delete: boolean; can_deactivate: boolean; can_reactivate: boolean
  reasons: string[]; deactivation_blockers: string[]
  dependencies: { type: string; label: string; count: number }[]
}

export type CatalogHistory = {
  total: number
  rows: { id: string; action: string; details: Record<string, unknown>; created_at: string; operator: string }[]
}

export const historyLabels: Record<string, string> = {
  SALVAR_CADASTRO_OPERACIONAL: 'Cadastro salvo', SALVAR_CLIENTE: 'Cliente salvo', SALVAR_PRODUTO: 'Produto salvo',
  EXCLUIR_CADASTRO: 'Excluído', INATIVAR_CADASTRO: 'Inativado', REATIVAR_CADASTRO: 'Reativado',
  CONFIGURAR_UNIDADE_ITEM: 'Unidade configurada', CONFIGURAR_EMBALAGEM: 'Embalagem configurada',
  SALVAR_ASSOCIACAO_RECEITA: 'Associação de receita', SALVAR_REVISAO_RECEITA: 'Revisão técnica salva',
  APROVAR_RECEITA: 'Receita aprovada', CADASTRAR_OPCAO_PERDA: 'Cadastro de perda',
}

/** Mensagem segura para o operador: nunca expõe SQL cru. */
export function friendlyError(error: { code?: string; message?: string } | null | undefined, fallback: string) {
  const message = error?.message ?? ''
  const raw = /violates|relation|constraint|syntax|column|function .* does not exist|permission denied for/i.test(message)
  if (error?.code === '23503' && raw) return 'Não foi possível concluir: existem registros vinculados a este cadastro.'
  if (error?.code === '23505' && raw) return 'Já existe um cadastro com estes dados.'
  if (error?.code === '40001' && raw) return 'Este cadastro foi alterado por outro usuário. Atualize os dados para continuar.'
  if (error?.code === 'PGRST202') return 'Recurso ainda não disponível neste ambiente. Atualize o banco antes de usar esta ação.'
  if (!message || raw) return fallback
  return message
}

export async function fetchCatalogPreview(entity: CatalogEntity, id: string) {
  const { data, error } = await supabase.rpc('catalog_dependencies', { entity, record_id: id })
  if (error) throw new Error(friendlyError(error, 'Falha ao consultar as dependências.'))
  return data as CatalogPreview
}

export async function fetchCatalogHistory(entity: CatalogEntity, id: string, page = 0, pageSize = 20) {
  const { data, error } = await supabase.rpc('catalog_history', { entity, record_id: id, page_size: pageSize, page_offset: page * pageSize })
  if (error) throw new Error(friendlyError(error, 'Falha ao consultar o histórico.'))
  return data as CatalogHistory
}

/**
 * Executa uma RPC com request_id estável por conteúdo: um reenvio (duplo clique, timeout, nova tentativa)
 * reutiliza a mesma chave e o servidor devolve o resultado já gravado.
 */
export function useIdempotentRpc() {
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const keys = useRef(new Map<string, string>())

  async function run<T>(fn: string, params: Record<string, unknown>, fallback: string): Promise<T> {
    if (inFlight.current) throw new Error('Aguarde a operação em andamento.')
    const fingerprint = fn + JSON.stringify(params)
    const request_id = keys.current.get(fingerprint) ?? crypto.randomUUID()
    keys.current.set(fingerprint, request_id)
    inFlight.current = true
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc(fn, { ...params, request_id })
      if (error) {
        // Erro de regra definitivo: a próxima tentativa com outros dados recebe nova chave.
        if (error.code && !['08000', '08006', '57014'].includes(error.code)) keys.current.delete(fingerprint)
        throw new Error(friendlyError(error, fallback))
      }
      keys.current.delete(fingerprint)
      return data as T
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }
  return { run, busy }
}
