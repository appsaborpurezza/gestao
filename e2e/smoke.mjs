// E2E autenticado contra a HOMOLOGAÇÃO. Nunca aponte para produção.
// Uso: E2E_PASSWORD=... node e2e/smoke.mjs [baseUrl]
// Pré-requisito: build de homologação servido (ver e2e/README.md).
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'

const base = (process.argv[2] ?? 'http://localhost:4173/gestao/').replace(/\/?$/, '/')
const password = process.env.E2E_PASSWORD
if (!password) { console.error('Defina E2E_PASSWORD.'); process.exit(2) }
const users = [
  { role: 'ADMINISTRADOR', email: 'admin.homolog@saborpurezza.test' },
  { role: 'VENDAS', email: 'vendas.homolog@saborpurezza.test' },
  { role: 'PRODUCAO', email: 'producao.homolog@saborpurezza.test' },
]
const modules = ['dashboard', 'alerts', 'orders', 'customers', 'production-demand', 'production-board', 'recipes', 'inventory',
  'shipping', 'traceability', 'recall', 'losses', 'reports', 'products', 'operational-catalog', 'recipe-assignments', 'profiles', 'import']
const operational = new Set(['production-demand', 'recipes', 'inventory', 'traceability', 'recall', 'losses'])
const commercial = new Set(['orders', 'customers'])
const administrative = new Set(['operational-catalog', 'recipe-assignments', 'import', 'profiles'])
const allowed = (id, role) => administrative.has(id) ? role === 'ADMINISTRADOR'
  : operational.has(id) ? role !== 'VENDAS' : commercial.has(id) ? role !== 'PRODUCAO' : true

const out = 'e2e-output'
mkdirSync(out, { recursive: true })
const results = []
const record = (user, step, ok, detail = '') => {
  results.push({ role: user.role, step, ok, detail })
  console.log(`${ok ? 'OK  ' : 'FAIL'} [${user.role}] ${step}${detail ? ' · ' + detail : ''}`)
}

const browser = await chromium.launch()
for (const user of users) {
  for (const [viewport, size] of [['desktop', { width: 1366, height: 768 }], ['celular', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport: size, locale: 'pt-BR' })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('response', response => { if (response.url().includes('supabase.co') && response.status() >= 500) errors.push(`${response.status()} ${response.url()}`) })
    try {
      await page.goto(base, { waitUntil: 'networkidle' })
      await page.fill('input[name=email]', user.email)
      await page.fill('input[name=password]', password)
      await page.click('button[type=submit]')
      await page.waitForSelector('.shell-header, header.shell-header', { timeout: 20_000 })
      record(user, `login (${viewport})`, true)
      if (viewport === 'celular') {
        await page.screenshot({ path: `${out}/${user.role}-celular-inicio.png` })
        for (const id of ['orders', 'production-board', 'inventory']) {
          if (!allowed(id, user.role)) continue
          await page.goto(base + '#/' + id, { waitUntil: 'networkidle' })
          await page.waitForTimeout(800)
          await page.screenshot({ path: `${out}/${user.role}-celular-${id}.png`, fullPage: true })
        }
      } else for (const id of modules) {
        await page.goto(base + '#/' + id, { waitUntil: 'networkidle' })
        await page.waitForTimeout(1200)
        const forbidden = await page.locator('text=Acesso não autorizado').count()
        const failed = await page.locator('.ui-state[data-tone=danger], [role=alert]:has-text("Falha")').count()
        const expected = allowed(id, user.role)
        if (expected) record(user, `abrir ${id}`, !forbidden && !failed, forbidden ? 'bloqueado indevidamente' : failed ? 'estado de erro na tela' : '')
        else record(user, `bloquear ${id}`, forbidden > 0, forbidden ? '' : 'módulo acessível sem permissão')
        if (expected) await page.screenshot({ path: `${out}/${user.role}-desktop-${id}.png`, fullPage: true })
      }
      if (viewport === 'desktop' && user.role !== 'PRODUCAO') {
        await page.goto(base + '#/customers', { waitUntil: 'networkidle' })
        await page.getByRole('searchbox').first().fill('sao')
        await page.waitForTimeout(1500)
        const rows = await page.locator('tbody tr').count()
        record(user, 'busca sem acento em clientes ("sao")', rows > 0, `${rows} linha(s)`)
      }
      if (viewport === 'desktop') {
        await page.keyboard.press('Control+k')
        await page.keyboard.type('massa')
        await page.waitForTimeout(1500)
        const hits = await page.locator('dialog.shell-search li').count()
        record(user, 'busca global Ctrl+K ("massa")', hits > 0, `${hits} resultado(s)`)
        await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
        await page.click('.shell-user-trigger')
        await page.getByRole('menuitem', { name: 'Sair' }).click()
        await page.waitForSelector('input[name=email]', { timeout: 15_000 })
        record(user, 'logout', true)
      }
    } catch (error) {
      record(user, `fluxo ${viewport}`, false, String(error?.message ?? error).split('\n')[0])
      await page.screenshot({ path: `${out}/${user.role}-${viewport}-erro.png` }).catch(() => {})
    }
    if (errors.length) record(user, `erros de console/servidor (${viewport})`, false, errors.slice(0, 3).join(' | '))
    await context.close()
  }
}
await browser.close()
writeFileSync(`${out}/resultado.json`, JSON.stringify(results, null, 2))
const failures = results.filter(result => !result.ok)
console.log(`\n${results.length - failures.length}/${results.length} verificações passaram.`)
process.exit(failures.length ? 1 : 0)
