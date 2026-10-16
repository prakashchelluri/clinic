$env:PORT = '4000'
Write-Host "CUBOTT Clinical starting on http://localhost:4000 (first start takes ~30s)"
npx tsx src/server.ts
