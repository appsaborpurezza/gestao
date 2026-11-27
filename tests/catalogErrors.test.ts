import { expect, test } from 'vitest'
import { friendlyError } from '../src/lib/catalog'

test('mensagens de regra do banco chegam ao operador; SQL cru nunca', () => {
  expect(friendlyError({ code: '23503', message: 'Este cadastro possui histórico de utilização.' }, 'x'))
    .toBe('Este cadastro possui histórico de utilização.')
  expect(friendlyError({ code: '23503', message: 'update or delete on table "suppliers" violates foreign key constraint "receipts_supplier_fk"' }, 'x'))
    .toBe('Não foi possível concluir: existem registros vinculados a este cadastro.')
  expect(friendlyError({ code: '23505', message: 'duplicate key value violates unique constraint "items_code_idx"' }, 'x'))
    .toBe('Já existe um cadastro com estes dados.')
  expect(friendlyError({ code: '42883', message: 'function public.foo(text) does not exist' }, 'Falha.')).toBe('Falha.')
  expect(friendlyError({ code: '42501', message: 'permission denied for table items' }, 'Sem acesso.')).toBe('Sem acesso.')
  expect(friendlyError({ code: 'PGRST202', message: 'Could not find the function' }, 'x')).toMatch(/ainda não disponível/)
  expect(friendlyError(null, 'Falha geral.')).toBe('Falha geral.')
})
