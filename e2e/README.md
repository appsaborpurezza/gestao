# E2E autenticado (homologação)

Roda login, navegação por todos os módulos, bloqueio por perfil, busca sem acento, busca global e logout para os três perfis de teste da homologação, no desktop e no celular.

```powershell
pnpm install
$env:VITE_SUPABASE_URL="https://vooyoomskkaivlluioeq.supabase.co"
$env:VITE_SUPABASE_PUBLISHABLE_KEY="<chave publicável de homologação>"
pnpm build
Start-Process -NoNewWindow npx "vite preview --port 4173 --strictPort"
# Playwright fica fora do projeto para não alterar o lockfile
mkdir $env:TEMP\purezza-e2e; cd $env:TEMP\purezza-e2e; npm init -y; npm i playwright; npx playwright install chromium
copy <repo>\e2e\smoke.mjs .
$env:E2E_PASSWORD="<senha dos usuários de teste>"
node smoke.mjs http://localhost:4173/gestao/
```

Saída em `e2e-output/` (capturas e `resultado.json`). Nunca use usuários ou URL de produção.
