# Releasing StickiChat, in one command.
#
# The three lines this replaces were: set GH_TOKEN, push, run the build. Two of them are easy to
# forget and the third is easy to run against a tree that is not ready, which is how a release ends
# up shipping a version whose changelog says nothing about it.
#
# The token is asked for once and kept encrypted with Windows DPAPI, which ties it to this Windows
# account: another user on this machine cannot read the file, and it is git-ignored besides. It is
# never printed, never passed on a command line, and only exists in plain text inside this process.
#
# Run it with: npm run publish

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) {
  Write-Host ''
  Write-Host "  $msg" -ForegroundColor Red
  Write-Host ''
  exit 1
}

function Step($msg) {
  Write-Host ''
  Write-Host "  $msg" -ForegroundColor Cyan
}

# ---------- what are we shipping ----------

$pkg = Get-Content package.json -Raw | ConvertFrom-Json
$version = $pkg.version
Step "StickiChat $version"

# ---------- checks that stop a half-ready release ----------

$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'main') { Fail "Ти на гілці '$branch', а релізи йдуть з main." }

if ((git status --porcelain)) {
  git status --short
  Fail 'У робочій копії є незакомічені зміни. Закоміть їх або прибери, і запусти ще раз.'
}

# the changelog is the one thing nobody notices is missing until users ask what changed
$changelog = Get-Content 'src/renderer/src/changelog.ts' -Raw
if ($changelog -notmatch [regex]::Escape("version: '$version'")) {
  Fail "У changelog.ts немає запису для $version. Додай його перед релізом."
}

# a version that already shipped would overwrite that release's files
$existingTag = (git tag --list "v$version")
if ($existingTag) { Fail "Тег v$version вже існує. Підніми версію в package.json." }

Write-Host '  гілка main, дерево чисте, запис у списку змін є' -ForegroundColor DarkGray

# ---------- the token ----------

$tokenFile = Join-Path $root '.gh-token'

function Read-SavedToken {
  if (-not (Test-Path $tokenFile)) { return $null }
  try {
    $secure = Get-Content $tokenFile | ConvertTo-SecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  } catch {
    # written by another Windows account, or corrupted: ask again rather than fail
    return $null
  }
}

$token = $env:GH_TOKEN
if (-not $token) { $token = Read-SavedToken }

if (-not $token) {
  Write-Host ''
  Write-Host '  Потрібен токен GitHub, щоб опублікувати реліз.' -ForegroundColor Yellow
  Write-Host '  Створити: github.com/settings/tokens' -ForegroundColor DarkGray
  Write-Host '  Права: repo (або contents: write для fine-grained на stickichat)' -ForegroundColor DarkGray
  Write-Host '  Введеться один раз, збережеться зашифрованим під твоїм користувачем Windows.' -ForegroundColor DarkGray
  Write-Host ''
  $secure = Read-Host '  Токен' -AsSecureString
  if ($secure.Length -eq 0) { Fail 'Токен не введено.' }
  $secure | ConvertFrom-SecureString | Set-Content $tokenFile -Encoding ascii
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  Write-Host "  Збережено у .gh-token (він у .gitignore)." -ForegroundColor DarkGray
}

# ---------- push, then build and publish ----------

Step 'Відправляю коміти на GitHub'
git push origin main
if ($LASTEXITCODE -ne 0) { Fail 'git push не пройшов.' }

Step 'Збираю і публікую (це надовго)'
$env:GH_TOKEN = $token
try {
  npm run release
  $code = $LASTEXITCODE
} finally {
  # out of the environment the moment it is not needed
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  $token = $null
}

if ($code -ne 0) { Fail 'Збірка або публікація не пройшла. Дивись помилку вище.' }

Write-Host ''
Write-Host "  Готово. StickiChat $version опубліковано." -ForegroundColor Green
Write-Host "  https://github.com/GouSsStickmen/stickichat/releases/tag/v$version" -ForegroundColor DarkGray
Write-Host ''
Write-Host '  Перевір, що поруч з .exe лежить latest.yml: без нього автооновлення' -ForegroundColor DarkGray
Write-Host '  у користувачів не побачить цю версію.' -ForegroundColor DarkGray
Write-Host ''
