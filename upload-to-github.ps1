<#
    Prepare this directory to be pushed to GitHub, up to (but not including) the
    network step. Run it with your real GitHub account name:

        pwsh -File .\upload-to-github.ps1 -User <your-github-name>

    It rewrites the placeholder account "chimney" in package.json and in the
    awesome-dsh-plugin submission entry, refreshes SHA256SUMS, and stages a local
    git commit. It never contacts the network: the login and the push stay with
    you, in the three commands it prints at the end.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$User,
    [string]$Placeholder = 'chimney'
)
$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Text([string]$path, [string]$text) {
    [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}

# ---- 1. the account name, in both places that carry it ----------------------
$pkgPath = Join-Path $dir 'package.json'
$pkg = Get-Content $pkgPath -Raw
if ($User -ne $Placeholder) {
    Write-Text $pkgPath ($pkg.Replace($Placeholder, $User))
    Write-Host ("package.json: '" + $Placeholder + "' -> '" + $User + "'")
} else {
    Write-Host ("package.json: placeholder kept ('" + $Placeholder + "' is the real account)")
}

$entryDir = Join-Path $dir 'awesome-dsh-plugin-entry\data\plugins'
$oldEntry = Join-Path $entryDir ($Placeholder + '__dsh-model-rotator.yml')
$newEntry = Join-Path $entryDir ($User + '__dsh-model-rotator.yml')
if (Test-Path $oldEntry) {
    if ($oldEntry -ne $newEntry) { Rename-Item $oldEntry $newEntry }
    Write-Text $newEntry ((Get-Content $newEntry -Raw).Replace($Placeholder, $User))
    Write-Host ('submission entry: ' + (Split-Path -Leaf $newEntry))
} else {
    Write-Host ('submission entry already at ' + (Split-Path -Leaf $newEntry))
}

# ---- 2. SHA256SUMS must describe the bytes that are actually shipped -------
$listed = @('index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE', 'package.json')
$lines = foreach ($f in $listed) {
    $h = (Get-FileHash (Join-Path $dir $f) -Algorithm SHA256).Hash.ToLower()
    '{0}  {1}' -f $h, $f
}
Write-Text (Join-Path $dir 'SHA256SUMS.txt') (($lines -join "`n") + "`n")
Write-Host 'SHA256SUMS.txt: refreshed'

# ---- 3. the local commit (no network) --------------------------------------
if (-not (Test-Path (Join-Path $dir '.git'))) { git init -b main | Out-Null }
git add -A
$subject = 'dsh-model-rotator: model auto-ranking and transparent failover'
git commit -m $subject | Out-Null
$origin = 'https://github.com/' + $User + '/dsh-model-rotator.git'
$current = (git remote) 2>$null
if ($current -contains 'origin') { git remote set-url origin $origin } else { git remote add origin $origin }
Write-Host ''
Write-Host 'Prepared locally. It is committed but NOT pushed.'
git --no-pager log --oneline -1
git --no-pager remote -v
Write-Host ''
Write-Host 'Now the three steps that need you (network + credentials):'
Write-Host '  1) git config --global --unset url."https://gh-proxy.net/".insteadOf'
Write-Host '  2) gh auth login'
Write-Host '  3) git push -u origin main'
