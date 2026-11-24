import Papa from 'papaparse'
import { z } from 'zod'

const nonBlank = z.string().refine(value => value.trim().length > 0, 'Campo obrigatório')
const product = z.object({
  codigo_original: nonBlank,
  descricao_original: nonBlank,
  classificacao_preliminar: z.enum(['TERCEIRO', 'FABRICACAO_PROPRIA', 'REVENDA_A_VALIDAR', 'FARINHA_USO_REVENDA_A_VALIDAR']),
  status_validacao: z.literal('PENDENTE_VALIDACAO'),
})
const recipe = z.object({
  codigo: nonBlank,
  nome: nonBlank,
  versao: z.number().int().positive(),
  status: z.literal('PENDENTE_VALIDACAO'),
  rendimento_kg: z.object({
    minimo: z.number().positive(),
    medio: z.number().positive(),
    maximo: z.number().positive(),
  }).refine(value => value.minimo <= value.medio && value.medio <= value.maximo, 'Faixa de rendimento inválida'),
  ingredientes: z.array(z.object({
    nome: nonBlank,
    quantidade: z.number().positive().nullable(),
    unidade: z.enum(['kg', 'g', 'L', 'mL', 'un']),
    etapa: z.enum(['PREPARACAO', 'BATER_MASSA']).nullable(),
    tolerancia: z.number().nonnegative().nullable(),
  })).min(1),
})

export async function previewImport(productFile?: File, recipeFile?: File) {
  const products = productFile
    ? Papa.parse(await productFile.text(), { header: true, delimiter: ';', skipEmptyLines: 'greedy' })
    : { data: [], errors: [] }
  if (products.errors.length) throw new Error('CSV inválido. Confira o separador e os campos de cada linha.')
  const parsed = {
    products: z.array(product).parse(products.data),
    formulas: z.array(recipe).parse(recipeFile ? JSON.parse(await recipeFile.text()) : []),
  }
  const productCodes = new Set(parsed.products.map(item => item.codigo_original))
  const recipeCodes = new Set(parsed.formulas.map(item => JSON.stringify([item.codigo, item.versao])))
  if (productCodes.size !== parsed.products.length || recipeCodes.size !== parsed.formulas.length) {
    throw new Error('O arquivo contém códigos ou versões duplicados.')
  }
  if (productCodes.size + recipeCodes.size === 0) throw new Error('Selecione ao menos um arquivo com registros.')
  return parsed
}
