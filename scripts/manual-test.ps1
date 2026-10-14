# manual-test.ps1 -- one-command manual-test harness (ASCII only!)
#
# WHY THIS FILE EXISTS
#   The acceptance rule for this project is "it counts only if it RUNS and can be clicked
#   through by hand". Every phase boundary therefore ends with ONE command that
#   (a) builds the front end, (b) wires the built front end where the api serves it,
#   (c) prepares a database the CURRENT code can actually boot on, (d) starts the api,
#   (e) prints a reachable URL plus the manual checklist, and (f) can stop exactly the
#   process it started. That command is `verify:manual-test` (root package.json).
#
# ASCII ONLY
#   powershell.exe -File reads a .ps1 file as ANSI, so any non-ASCII byte in this file is
#   parsed as garbage and the script dies with a syntax error (measured on this machine,
#   same lesson as apps/api/scripts/mysql-local.ps1). Keep every byte below 0x80.
#   File is UTF-8 without BOM, LF line endings (node tools/check-eol.cjs proves it).
#
# ============================================================================
# WHAT CHANGED IN PHASE 1c TASK 12 (and why the old shape could NOT work)
# ============================================================================
#   The old harness reused the legacy snapshot as the manual-test database: it copied
#   apps/api/data/db2.sqlite to a scratch dir and injected knex bookkeeping rows for
#   001_schema / 002_platform_seed / 003_vendor_asset_sync, so that `migrate.latest()`
#   would only run 004/005/006. That is fatal, and it was measured:
#     * 004_backfill_userid does `select userId, id, projectId from o_tasks where userId is null`
#       and the legacy snapshot has NO userId columns at all (it predates them)
#       => `SqliteError: no such column: userId` => the process exits before printing a URL.
#   `pnpm run verify:manual-test` was therefore a BROKEN DOOR at HEAD (Phase 1b deferred #16).
#
#   The caliber that actually works is the one verify:phase1b already used, and the plan
#   named it explicitly ("new db db:migrate -> import the old snapshot data -> print URL"):
#
#     [1] build the web bundle
#     [2] create a DISPOSABLE data directory OUTSIDE the repo (never apps/api/data)
#     [3] run the real migration chain on a brand-new database there (001..006)
#     [4] db:bootstrap-admin ---- the one-time admin (ruling 1c-25: plaintext passwords are
#         NOT migrated, so a freshly migrated db has no account anyone can log in with)
#     [5] seed-manual-test ---- one invite code + one demo project + one real media file
#     [6] start the api against that directory and wait for readiness
#     [7] prove the page is actually served (GET / and every .js/.css in the build)
#
#   The repo snapshot is NOT imported here, on purpose: `db:import` refuses a non-empty
#   target, and the point of a MANUAL test is the four clicks below, not "old rows exist".
#   The migration of real legacy data is a separate, documented operation (README-auth.md
#   "upgrade order"). The repo database is never opened by this script at all, so its
#   hard-constraint sha256 cannot move -- step [0] prints that sha256 so the claim is
#   checkable against a value taken before/after.
#
# THE HARD FACTS THIS SCRIPT ENCODES (all measured on this machine)
#
#   1) THE REPO DATABASE IS A READ-ONLY SNAPSHOT AND IS NEVER THE TARGET.
#      apps/api/data/db2.sqlite is the pre-migration legacy snapshot (real data, NO
#      knex_migrations table). Booting the app on it fails with
#        create table `o_user` ... - table `o_user` already exists
#      and leaves knex's bookkeeping tables behind (sha256 moves). Manual test therefore
#      targets a disposable directory outside the repo; the guard
#      (apps/api/scripts/db-target-guard.cjs, Ruling 131/139) would refuse the repo path
#      anyway, and it is checked BEFORE any connection is opened.
#
#   2) THE ADMIN MUST BE CREATED EXPLICITLY (ruling 1c-25).
#      005_accounts migrates old plaintext rows to status='disabled' + passwordHash=''
#      (an empty hash cannot pass argon2), and nothing in the migration chain creates a
#      usable account. Without step [4] the login page has literally nothing to log in
#      with. The password is generated per run and printed at the end.
#
#   3) THE DEFAULT REGISTRATION MODE IS `invite`.
#      So "register a new user" needs an invite code; the invite-management HTTP routes are
#      NOT in Phase 1c. Step [5] inserts one o_invite row directly (a deliberate, documented
#      bypass of HTTP -- not a test-only backdoor: it writes the same table/columns the
#      registration path consumes).
#
#   4) THE API IS A LONG-RUNNING DAEMON -- NEVER LAUNCH IT INLINE.
#      Starting a resident process inline makes the CALLER'S COMMAND NEVER RETURN.
#      So: Start-Process -PassThru with redirected stdio (which also forces CreateProcess
#      instead of ShellExecute, so no Mark-of-the-Web dialog); the pid is remembered in a
#      file. If this command looks hung, check the port -- do not call it a failure.
#
#   5) -Stop MAY ONLY KILL THE PID THIS SCRIPT RECORDED.
#      Never `Get-Process node | Stop-Process` and friends: that is how an unrelated node
#      process gets killed (Ruling 98 lesson). The pid file is a claim, not proof, so
#      -Stop also checks the process name and refuses to touch anything that is not node.
#
#   6) MYSQL IS NOT REQUIRED HERE.
#      The manual-test caliber runs the sqlite branch (the default driver). Port 3307 is an
#      exclusive resource and is deliberately NOT touched by this script.
#
#   7) TMP/TEMP ARE REDIRECTED FOR THE WEB BUILD (measured on this machine).
#      `vite build` dies with
#        [vite:worker] remove C:\Users\<user>\AppData\Local\Temp\esbuild-<hash>: Access is denied.
#      from the esbuild child process. The SYSTEM temp directory is what is hostile here --
#      the identical build exits 0 when TMP/TEMP point at a directory we own. So TMP/TEMP
#      are pointed at a scratch directory next to the repo for the build (a process-level
#      environment override, NOT a new MIWO_* variable; the artifact is identical).
#
#   8) DEFAULT PORTS (measured on this machine): 10588 is the dev server, 18080 is the
#      LAN production server. Either one being up would make the readiness probe answer
#      from the WRONG process, so the default here is a third port and the script says who
#      owns it when that happens.
#
# The built web bundle goes to <scratch>/db/web (the api resolves the SPA dir as
# <MIWO_DATA_DIR>/web). `build-only` is used because `build` runs vue-tsc and apps/web
# currently has 47 inherited type errors (Phase 3 work), which would make `build` fail.
#
# Usage (arguments are parsed by hand -- see the ARGUMENTS note below):
#   pnpm.cmd run verify:manual-test                 # build + migrate + seed + start + print URL
#   pnpm.cmd run verify:manual-test -- -Stop        # stop exactly the pid it started
#   pnpm.cmd run verify:manual-test -- -Port 10688  # same thing on another port
#   powershell -File scripts/manual-test.ps1 -Stop  # same, without pnpm

param()
$ErrorActionPreference = 'Stop'

# ARGUMENTS (parsed by hand, and why)
#   pnpm forwards the `--` separator to -File as a LITERAL argument token on Windows
#   (measured: `pnpm.cmd run verify:manual-test -- -Stop` reaches this script as
#   `... -File <script> "--" "-Stop"`). PowerShell's parameter binder sees a parameter whose
#   name is empty and aborts with
#     Parameter cannot be processed because the parameter name '' is ambiguous
#   BEFORE the script body runs at all -- so a param([switch]$Stop) block cannot work end to
#   end with the documented acceptance command. `$args` does not have that problem, so the
#   flags are read from it directly and a stray `--` is simply skipped.
$Stop = $false
$Port = 0
$Keep = $false
$rest = @()
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($a -eq '--') { continue }
  if ($a -eq '-Stop' -or $a -eq '/Stop') { $Stop = $true; continue }
  if ($a -eq '-Keep' -or $a -eq '/Keep') { $Keep = $true; continue }
  if ($a -eq '-Port' -or $a -eq '/Port') {
    if ($i + 1 -ge $args.Count) { Write-Error "-Port needs a value"; exit 2 }
    $i++
    $v = [string]$args[$i]
    $n = 0
    if (-not [int]::TryParse($v, [ref]$n) -or $n -lt 1 -or $n -gt 65535) { Write-Error "-Port must be 1..65535, got '$v'"; exit 2 }
    $Port = $n
    continue
  }
  if ($a -like '-Port=*') {
    $v = $a.Substring(6)
    $n = 0
    if (-not [int]::TryParse($v, [ref]$n) -or $n -lt 1 -or $n -gt 65535) { Write-Error "-Port must be 1..65535, got '$v'"; exit 2 }
    $Port = $n
    continue
  }
  $rest += $a
}
if ($rest.Count -gt 0) {
  Write-Error "unrecognized argument(s): $($rest -join ' ') -- usage: verify:manual-test [-Stop] [-Port <1..65535>] [-Keep]"
  exit 2
}
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'pnpm-workspace.yaml'))) { Write-Error "run from the repo root (pnpm-workspace.yaml not found)"; exit 2 }
$api = Join-Path $root 'apps\api'
if (-not (Test-Path (Join-Path $api 'node_modules'))) { Write-Error "deps missing: run pnpm.cmd install first"; exit 2 }
if ($Port -eq 0) { $Port = 10688 }
$pidFile = Join-Path $env:TEMP 'miwo-manual-test.pid'
$logDir = Join-Path $env:TEMP 'miwo-manual-test-logs'
$outLog = Join-Path $logDir 'api.out.log'
$errLog = Join-Path $logDir 'api.err.log'
$url = "http://127.0.0.1:$Port"
# The disposable data dir lives NEXT TO the repo (never inside it, never in apps/api/data).
$scratchRoot = Join-Path (Split-Path -Parent $root) '.tmp-manual-test'
$dataDir = Join-Path $scratchRoot 'db'
$inviteCode = 'manual-test-invite'
$adminUser = 'admin'
# Printed at the end; also fed to db:bootstrap-admin through the environment (never argv).
# Not a secret worth protecting (the service listens on 127.0.0.1 only) but still: it is
# per-run, and it is printed ONLY here.
$adminPassword = 'Miwo-' + ([guid]::NewGuid().ToString('N').Substring(0, 12))

if ($Stop) {
  if (-not (Test-Path $pidFile)) { Write-Host "not running (no pid file)"; exit 0 }
  $p = [int](Get-Content $pidFile -Raw).Trim()
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  # Never kill a pid we do not recognize: the pid file is a claim, and pids get recycled.
  if ($proc -and $proc.ProcessName -ne 'node') {
    Write-Host "refusing to stop pid ${p}: process name is '$($proc.ProcessName)', not node"
    Write-Host "leaving $pidFile in place for inspection"
    exit 3
  }
  if ($proc) { Stop-Process -Id $p -Force; Write-Host "stopped pid $p (the api this script started)" } else { Write-Host "pid $p already gone" }
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  exit 0
}

function Fail($msg) {
  Write-Host "FAILED: $msg"
  if (Test-Path $pidFile) {
    $p = [int](Get-Content $pidFile -Raw).Trim()
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node') { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
    Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  }
  if (Test-Path $errLog) { Write-Host "---- last lines of $errLog ----"; Get-Content $errLog -Tail 40 }
  if (Test-Path $outLog) { Write-Host "---- last lines of $outLog ----"; Get-Content $outLog -Tail 20 }
  exit 1
}

Write-Host "[0/7] repo database snapshot (must not move; this script never opens it)"
$repoDb = Join-Path $api 'data\db2.sqlite'
if (Test-Path $repoDb) {
  $sha = (Get-FileHash $repoDb -Algorithm SHA256).Hash
  Write-Host "      apps/api/data/db2.sqlite sha256 = $sha"
} else {
  Write-Host "      apps/api/data/db2.sqlite not present (fresh clone) -- nothing to protect"
}

Write-Host "[1/7] building web (build-only; 'build' includes vue-tsc which has 47 known inherited type errors)"
# Keep TMP/TEMP outside the system temp dir for the build (fact 7) and outside the repo.
New-Item -ItemType Directory -Force -Path $scratchRoot | Out-Null
$env:TMP = $scratchRoot
$env:TEMP = $scratchRoot
Push-Location $root
try { & pnpm.cmd --filter @miwo/web run build-only; if ($LASTEXITCODE -ne 0) { Fail "web build failed" } } finally { Pop-Location }

Write-Host "[2/7] preparing a disposable data dir OUTSIDE the repo: $dataDir"
$dist = Join-Path $root 'apps\web\dist'
if (-not (Test-Path $dist)) { Fail "dist missing: $dist" }
if (Test-Path $dataDir) { Remove-Item -Recurse -Force $dataDir }
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'web') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'oss') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'assets') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'skills') | Out-Null
# The api resolves the SPA directory as <MIWO_DATA_DIR>/web, so the bundle goes here.
Copy-Item (Join-Path $dist '*') (Join-Path $dataDir 'web') -Recurse -Force

# Every child process below gets the same environment. `--env-file-if-exists=.env` still
# loads the rest of MIWO_* (see nodemon.json); real environment variables win over the file
# (Node --env-file semantics), which is why these overrides stay authoritative.
$env:MIWO_ENV = 'dev'
$env:MIWO_PORT = "$Port"
$env:MIWO_HOST = '127.0.0.1'
$env:MIWO_DATA_DIR = $dataDir
$env:MIWO_DB_DRIVER = 'sqlite'
$env:MIWO_JWT_SECRET = 'manual-test-only-secret-at-least-32-bytes'
$env:MIWO_PUBLIC_BASE_URL = $url

Write-Host "[3/7] running the real migration chain on the brand-new database (001..006)"
Push-Location $api
try {
  & node '--env-file-if-exists=.env' '--import=tsx' 'scripts/db-migrate.ts'
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "db:migrate failed" }

  Write-Host "[4/7] bootstrapping the one-time administrator (ruling 1c-25: no plaintext passwords migrate)"
  $env:MIWO_BOOTSTRAP_PASSWORD = $adminPassword
  & node '--env-file-if-exists=.env' '--import=tsx' 'scripts/bootstrap-admin.ts' "--username=$adminUser" '--apply'
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "db:bootstrap-admin failed (exit $LASTEXITCODE)" }
  Remove-Item Env:MIWO_BOOTSTRAP_PASSWORD -ErrorAction SilentlyContinue

  Write-Host "[5/7] seeding the manual-test fixtures (invite code + demo project + media file)"
  & node '--env-file-if-exists=.env' '--import=tsx' 'scripts/seed-manual-test.ts' "--admin=$adminUser" "--invite=$inviteCode"
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "seed-manual-test failed" }
} finally { Pop-Location }

Write-Host "[6/7] starting api on port $Port (data dir is the disposable copy; the repo db is never opened)"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
# stdio is redirected on purpose: it keeps this a CreateProcess launch (no ShellExecute, no
# Mark-of-the-Web dialog) and leaves the api log in $logDir for troubleshooting.
$p = Start-Process -FilePath 'node' `
  -ArgumentList '--env-file-if-exists=.env','--import=tsx','src/app.ts' `
  -WorkingDirectory $api -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Set-Content -Path $pidFile -Value $p.Id -NoNewline

# The port may be held by something else (for example a dev server started by hand, or a
# leftover from a previous run). Ask the OS who owns it instead of guessing.
$holder = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($holder -and $holder.OwningProcess -ne $p.Id) {
  Write-Host "WARNING: 127.0.0.1:${Port} is ALREADY owned by pid $($holder.OwningProcess) ($((Get-Process -Id $holder.OwningProcess -ErrorAction SilentlyContinue).ProcessName))"
  Write-Host "         the readiness probe below would then be answered by THAT process, not by us."
  Write-Host "         use -Port <other> if you want to be sure."
}

$deadline = (Get-Date).AddSeconds(90); $ok = $false
while ((Get-Date) -lt $deadline) {
  # If our own process died (guard refusal / config error), do not sit here for 90s.
  if ($p.HasExited) { break }
  try { $r = Invoke-WebRequest -Uri "$url/api/other/configHealth?summary=1" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
  Start-Sleep -Milliseconds 700
}
if (-not $ok) { Fail "api not ready in 90s (hasExited=$($p.HasExited))" }

Write-Host ""
Write-Host "[7/7] READY -> $url"

# "the service is up" is NOT "the page opens". Prove the front end is actually served: fetch
# the page, then fetch every asset the built site references OR ships next to index.html.
# apps/web builds with vite-plugin-singlefile, so the main bundle is INLINED into index.html
# and the only separate .js files are the monaco workers -- walking the built files covers
# both shapes without hardcoding a filename (and a "no references" answer is not a pass).
$page = Invoke-WebRequest -Uri "$url/" -TimeoutSec 60 -UseBasicParsing
Write-Host "      GET /  -> HTTP $($page.StatusCode), $($page.RawContentLength) bytes (index.html)"
if ($page.StatusCode -ne 200) { Fail "page not served" }
$html = Get-Content (Join-Path $dist 'index.html') -Raw
$refs = [regex]::Matches($html, '(?:src|href)="((?:\./)?[\w./-]+?\.(?:js|css))"') | ForEach-Object { $_.Groups[1].Value }
$files = Get-ChildItem $dist -Recurse -File -Include '*.js', '*.css' | ForEach-Object { $_.FullName.Substring($dist.Length + 1).Replace('\', '/') }
$assets = @($refs) + @($files) | ForEach-Object { $_ -replace '^\./', '' } | Where-Object { $_ } | Select-Object -Unique
if (-not $assets -or $assets.Count -eq 0) { Write-Host "      WARNING: no .js/.css files found in $dist -- nothing to prove about the front end" }
$assetCount = 0
foreach ($a in $assets) {
  $r = Invoke-WebRequest -Uri "$url/$a" -TimeoutSec 180 -UseBasicParsing
  Write-Host "      GET /$a -> HTTP $($r.StatusCode), $($r.RawContentLength) bytes"
  $assetCount++
}

# The readiness probe is the app's own health endpoint; the four steps below are what the
# human must actually click. Credentials/URLs are printed here so the checklist is runnable
# without re-reading this file.
Write-Host ""
Write-Host "=== READY: open $url in a browser and click through these four steps ==="
Write-Host ""
Write-Host "  1) SIGN IN (first: forced password change is ON for a fresh admin)"
Write-Host "       username: $adminUser"
Write-Host "       password: $adminPassword"
Write-Host "     The account was created with mustChangePassword=1, so the page must send you to"
Write-Host "     the change-password screen first; that IS step 1 succeeding."
Write-Host ""
Write-Host "  2) REGISTER A SECOND USER (default registration mode is 'invite')"
Write-Host "       invite code: $inviteCode      (maxUses=5, valid 7 days)"
Write-Host "     Then log in as that new user in a private window."
Write-Host ""
Write-Host "  3) CREATE A PROJECT as the new user (project list also already shows the seeded"
Write-Host "     demo project id=900001 for the admin)."
Write-Host ""
Write-Host "  4) SEE MEDIA: open this signed link (bypasses nothing -- it is the same HMAC the"
Write-Host "     app hands to <img> tags; valid 24h):"
Write-Host "       $url/oss/manual-test/demo.png?<exp+sig printed by seed-manual-test above>"
Write-Host "     The control case: the SAME path without the query string must answer 403."
Write-Host ""
Write-Host "  Also worth clicking: refresh the page while logged in (session must survive via the"
Write-Host "  HttpOnly refresh cookie) and then log out (the old access token must die immediately)."
Write-Host ""
Write-Host "api pid $($p.Id); log: $outLog / $errLog"
Write-Host "data dir (disposable, outside the repo): $dataDir"
Write-Host "Stop with: pnpm.cmd run verify:manual-test -- -Stop"
if ($Keep) { Write-Host "(-Keep: the data dir is left in place)" } else { Write-Host "(the data dir is kept for troubleshooting; the next run recreates it)" }
