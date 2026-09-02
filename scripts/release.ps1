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

# A GitHub token is ASCII and long. Anything else is not a token, and the most likely thing to
# arrive instead is a single control character: pressing Ctrl+V at a console prompt types 0x16
# rather than pasting, and electron-builder only complains about it at the very end of a build.
function Test-Token($value) {
  return ($value -and $value -match '^[A-Za-z0-9_-]{20,255}$')
}

function Read-SavedToken {
  if (-not (Test-Path $tokenFile)) { return $null }
  try {
    $secure = Get-Content $tokenFile | ConvertTo-SecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  } catch {
    # written by another Windows account, or corrupted: ask again rather than fail
    return $null
  }
  if (-not (Test-Token $plain)) {
    Write-Host '  Збережений токен виглядає зіпсованим, питаю знову.' -ForegroundColor Yellow
    Remove-Item $tokenFile -ErrorAction SilentlyContinue
    return $null
  }
  return $plain
}

# A real window with a masked field, because Ctrl+V works there and does not at a console prompt.
# Falls back to Read-Host if WinForms is unavailable, with the paste that actually works spelled out.
function Prompt-ForToken {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
  } catch {
    Write-Host '  Встав токен правою кнопкою миші (Ctrl+V у консолі не вставляє).' -ForegroundColor Yellow
    $secure = Read-Host '  Токен' -AsSecureString
    if ($secure.Length -eq 0) { return $null }
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  }

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'StickiChat: токен GitHub'
  $form.Size = New-Object System.Drawing.Size(460, 190)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true

  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Встав токен (Ctrl+V працює).`r`nПотрібні права: repo, або contents: write."
  $label.Location = New-Object System.Drawing.Point(14, 14)
  $label.Size = New-Object System.Drawing.Size(420, 40)
  $form.Controls.Add($label)

  $box = New-Object System.Windows.Forms.TextBox
  $box.UseSystemPasswordChar = $true
  $box.Location = New-Object System.Drawing.Point(14, 62)
  $box.Size = New-Object System.Drawing.Size(420, 24)
  $form.Controls.Add($box)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Далі'
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(258, 100)
  $form.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Скасувати'
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(345, 100)
  $form.Controls.Add($cancel)

  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $form.Add_Shown({ $box.Focus() })
  $result = $form.ShowDialog()
  $value = $box.Text
  $form.Dispose()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return $value
}

$token = $env:GH_TOKEN
if (-not $token) { $token = Read-SavedToken }

if (-not $token) {
  Write-Host ''
  Write-Host '  Потрібен токен GitHub, щоб опублікувати реліз.' -ForegroundColor Yellow
  Write-Host '  Створити: github.com/settings/tokens' -ForegroundColor DarkGray
  Write-Host '  Права: repo (або contents: write для fine-grained на stickichat)' -ForegroundColor DarkGray
  Write-Host '  Введеться один раз, збережеться зашифрованим під твоїм користувачем Windows.' -ForegroundColor DarkGray

  $token = (Prompt-ForToken)
  if ($token) { $token = $token.Trim() }
  if (-not $token) { Fail 'Токен не введено.' }
  if (-not (Test-Token $token)) {
    Fail 'Це не схоже на токен GitHub. Найчастіша причина: Ctrl+V у консолі не вставляє з буфера, а вводить керуючий символ. Скопіюй токен ще раз і встав у поле вікна.'
  }

  # only a token that passed the check is worth keeping
  $secure = ConvertTo-SecureString $token -AsPlainText -Force
  $secure | ConvertFrom-SecureString | Set-Content $tokenFile -Encoding ascii
  Write-Host '  Збережено у .gh-token (він у .gitignore).' -ForegroundColor DarkGray
}

if (-not (Test-Token $token)) {
  Fail 'Токен у змінній GH_TOKEN виглядає зіпсованим. Прибери її або встав токен наново.'
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
