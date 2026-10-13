# manual-test.ps1 -- one-command manual-test harness (ASCII only!)
#
# WHY THIS FILE EXISTS
#   The acceptance rule for this project is "it counts only if it RUNS and can be clicked
#   through by hand". Every phase boundary therefore ends with ONE command that
#   (a) builds the front end, (b) wires the built front end where the api serves it,
#   (c) starts the api against a database that can actually boot, (d) prints a reachable URL
#   plus the manual checklist, and (e) can stop exactly the process it started.
#   That command is `verify:manual-test` (root package.json); this is its implementation.
#
# ASCII ONLY
#   powershell.exe -File reads a .ps1 file as ANSI, so any non-ASCII byte in this file is
#   parsed as garbage and the script dies with a syntax error (measured on this machine,
#   same lesson as apps/api/scripts/mysql-local.ps1). Keep every byte below 0x80.
#   File is UTF-8 without BOM, LF line endings (node tools/check-eol.cjs proves it).
#
# THE HARD FACTS THIS SCRIPT ENCODES (all measured on this machine)
#
#   1) THE REPO dev DATABASE CANNOT BE THE MANUAL-TEST TARGET.
#      apps/api/data/db2.sqlite is the pre-migrations LEGACY snapshot: 29 user tables with
#      real data, and NO `knex_migrations` table. Booting the app on it (the startup path
#      runs migrate.latest()) therefore fails outright with
#        create table `o_user` ... - table `o_user` already exists
#      and it leaves two side effects in that file: knex's bookkeeping tables are created
#      and the hard-constraint sha256 changes from 44716850... to 8C3C2F38....
#      That is documented behaviour, not a bug -- README "does not support running
#      migrations in place on an old database". The schema is also 19 `userId` columns
#      behind the migration schema, so "just insert the bookkeeping rows" would leave a
#      silently drifted database (exactly what the README forbids).
#      => Manual test runs against a disposable COPY of that database, outside the repo.
#         No repo database is opened, so the hard-constraint sha256 cannot move.
#
#   2) THE COPY NEEDS ONE BOOTSTRAP STEP.
#      The legacy snapshot has no migration history, so the copy gets knex's bookkeeping
#      rows for the migrations that were already applied when that snapshot was taken
#      (001_schema / 002_platform_seed / 003_vendor_asset_sync, read from
#      apps/api/src/db/migrations/index.ts). Without it the copy fails exactly like the
#      repo database. With it the app boots, the real data (o_user admin, 8 projects,
#      o_setting.tokenKey) is present, and login works -- which is the whole point of a
#      MANUAL test: an empty freshly-migrated db has no user and no tokenKey, so step 1 of
#      the checklist (sign in) is impossible (Phase 1c work).
#
#   3) MIWO_ALLOW_REPO_DEV_DB=1 IS STILL SET, AND IT IS WHAT MAKES STARTUP LEGAL.
#      The guard (apps/api/scripts/db-target-guard.cjs, Ruling 131/139/149/156) refuses to
#      start when the resolved sqlite target is the repo database. This script points
#      MIWO_DATA_DIR at the scratch copy, so the target is outside the repo, but the
#      opt-in is kept on purpose: it is the one switch that makes "start the app at all"
#      explicit. Drop it and point MIWO_DATA_DIR back at apps/api/data (i.e. remove the
#      override and let apps/api/.env's ./data apply) and startup is REFUSED with
#        MIWO_REPO_DEV_DB_BLOCKED
#      -- that is the discriminating red/green of this harness, reproduced in the task
#      report. See also the README section "database target guard".
#
#   4) THE API IS A LONG-RUNNING DAEMON -- NEVER LAUNCH IT INLINE.
#      Starting a resident process inline makes the CALLER'S COMMAND NEVER RETURN (the
#      harness keeps waiting for the process tree to end). Same lesson as
#      mysql-local.ps1 -Action start. So: Start-Process -PassThru with redirected stdio
#      (which also forces CreateProcess instead of ShellExecute, so no Mark-of-the-Web
#      dialog) and the pid is remembered in a file.
#      If this command looks hung, check the port -- do not call it a failure.
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
#      from the esbuild child process: esbuild extracts a temp copy of itself under %TEMP%
#      and cannot delete that copy again. The SYSTEM temp directory is what is hostile here
#      -- the identical build exits 0 and writes dist/ when TMP/TEMP point at a directory we
#      own, and the leftover file is deletable by hand right after the failure. So TMP/TEMP
#      are pointed at a scratch directory next to the repo for the build. It is a
#      process-level environment override (NOT a new MIWO_* variable, and the built artifact
#      is identical). With the system %TEMP% the failure comes back -- that is the red/green.
#
# The built web bundle goes to apps/api/data/web (git-ignored); the front end is built with
# `build-only` because `build` runs vue-tsc and apps/web currently has 47 inherited type
# errors (Phase 3 work), which would make `build` fail outright.
#
# Usage (arguments are parsed by hand -- see the ARGUMENTS note below):
#   pnpm.cmd run verify:manual-test                 # build + start + print URL + checklist
#   pnpm.cmd run verify:manual-test -- -Stop        # stop exactly the pid it started
#   pnpm.cmd run verify:manual-test -- -Port 10589  # same thing on another port
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
#   two flags are read from it directly and a stray `--` is simply skipped.
$Stop = $false
$Port = 0
$rest = @()
for ($i = 0; $i -lt $args.Count; $i++) {
  $a = [string]$args[$i]
  if ($a -eq '--') { continue }
  if ($a -eq '-Stop' -or $a -eq '/Stop') { $Stop = $true; continue }
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
  Write-Error "unrecognized argument(s): $($rest -join ' ') -- usage: verify:manual-test [-Stop] [-Port <1..65535>]"
  exit 2
}
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'pnpm-workspace.yaml'))) { Write-Error "run from the repo root (pnpm-workspace.yaml not found)"; exit 2 }
$api = Join-Path $root 'apps\api'
if (-not (Test-Path (Join-Path $api 'node_modules'))) { Write-Error "deps missing: run pnpm.cmd install first"; exit 2 }
if ($Port -eq 0) { $Port = 10588 }
$pidFile = Join-Path $env:TEMP 'miwo-manual-test.pid'
$logDir = Join-Path $env:TEMP 'miwo-manual-test-logs'
$outLog = Join-Path $logDir 'api.out.log'
$errLog = Join-Path $logDir 'api.err.log'
$url = "http://127.0.0.1:$Port"

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

Write-Host "[1/5] building web (build-only; 'build' includes vue-tsc which has 47 known inherited type errors)"
# Keep TMP/TEMP outside the system temp dir for the build (fact 7) and outside the repo.
$scratch = Join-Path (Split-Path -Parent $root) '.tmp-manual-test'
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$env:TMP = $scratch
$env:TEMP = $scratch
Push-Location $root
try { & pnpm.cmd --filter @miwo/web run build-only; if ($LASTEXITCODE -ne 0) { throw "web build failed" } } finally { Pop-Location }

Write-Host "[2/5] wiring dist -> apps/api/data/web"
$dist = Join-Path $root 'apps\web\dist'
$web  = Join-Path $api 'data\web'
if (-not (Test-Path $dist)) { throw "dist missing: $dist" }
New-Item -ItemType Directory -Force -Path $web | Out-Null
Copy-Item (Join-Path $dist '*') $web -Recurse -Force

Write-Host "[3/5] preparing a disposable database copy (the repo dev db is a pre-migrations snapshot and cannot boot -- see fact 1)"
$devDb = Join-Path $api 'data\db2.sqlite'
if (-not (Test-Path $devDb)) { throw "dev database not found: $devDb" }
$dataDir = Join-Path $scratch 'db'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$scratchDb = Join-Path $dataDir 'db2.sqlite'
Copy-Item $devDb $scratchDb -Force
# The api resolves the site directory as <MIWO_DATA_DIR>/web, so the bundle goes here (the
# copy under apps/api/data/web is the one a hand-started `pnpm dev` uses).
# Bootstrap = write knex's own bookkeeping rows for the migrations that were already applied
# when the legacy snapshot was taken, so the migrator does not replay 001_schema.
# The scratch dir lives outside the repo (so a failed run cannot dirty the working tree),
# which is also why better-sqlite3 is resolved from apps/api instead of from here.
$bootJs = @'
const path = require("path");
const { createRequire } = require("module");
const apiRequire = createRequire(path.join(process.env.MIWO_BOOT_API, "package.json"));
const D = apiRequire("better-sqlite3");
const db = new D(process.env.MIWO_BOOT_DB);
db.exec('create table if not exists knex_migrations (id integer primary key autoincrement, name varchar(255), batch integer, migration_time timestamp)');
db.exec('create table if not exists knex_migrations_lock ("index" integer primary key, is_locked integer)');
if (!db.prepare('select 1 from knex_migrations_lock where "index" = 1').get()) db.prepare('insert into knex_migrations_lock ("index", is_locked) values (1, 0)').run();
const names = ["001_schema", "002_platform_seed", "003_vendor_asset_sync"];
const ins = db.prepare('insert into knex_migrations (name, batch, migration_time) values (?, 1, ?)');
for (const n of names) { if (!db.prepare('select 1 from knex_migrations where name = ?').get(n)) ins.run(n, new Date().toISOString()); }
console.log("[boot] applied-migration rows: " + db.prepare("select name from knex_migrations").all().map(r => r.name).join(", "));
db.close();
'@
$bootFile = Join-Path $scratch 'bootstrap.cjs'
Set-Content -Path $bootFile -Value $bootJs -Encoding ascii
$env:MIWO_BOOT_DB = $scratchDb
$env:MIWO_BOOT_API = $api
Push-Location $api
try { & node $bootFile; if ($LASTEXITCODE -ne 0) { throw "database bootstrap failed" } } finally { Pop-Location }
Remove-Item Env:MIWO_BOOT_DB -ErrorAction SilentlyContinue
Remove-Item Env:MIWO_BOOT_API -ErrorAction SilentlyContinue

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$scratchWeb = Join-Path $dataDir 'web'
New-Item -ItemType Directory -Force -Path $scratchWeb | Out-Null
Copy-Item (Join-Path $dist '*') $scratchWeb -Recurse -Force

Write-Host "[4/5] starting api on port $Port (MIWO_ALLOW_REPO_DEV_DB=1; data dir is the copy, the repo db is never opened)"
$env:MIWO_ALLOW_REPO_DEV_DB = '1'
$env:MIWO_PORT = "$Port"
$env:MIWO_ENV  = 'dev'
$env:MIWO_DATA_DIR = $dataDir
# --env-file-if-exists=.env is how the repo loads the rest of MIWO_* (see nodemon.json).
# Real environment variables win over the file (Node --env-file semantics), which is why the
# overrides above stay authoritative.
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
}

$deadline = (Get-Date).AddSeconds(90); $ok = $false
while ((Get-Date) -lt $deadline) {
  # If our own process died (guard refusal / config error), do not sit here for 90s.
  if ($p.HasExited) { break }
  try { $r = Invoke-WebRequest -Uri "$url/api/other/configHealth?summary=1" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop; if ($r.StatusCode -eq 200) { $ok = $true; break } } catch { }
  Start-Sleep -Milliseconds 700
}
if (-not $ok) {
  Write-Host "api not ready in 90s (hasExited=$($p.HasExited), exitCode=$($p.ExitCode)); stopping pid $($p.Id)"
  if (Test-Path $errLog) { Write-Host "---- last lines of $errLog ----"; Get-Content $errLog -Tail 40 }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  exit 1
}

Write-Host ""
Write-Host "[5/5] READY -> $url"

# "the service is up" is NOT "the page opens". Prove the front end is actually served: fetch
# the page, then fetch every asset the built site references OR ships next to index.html.
# apps/web builds with vite-plugin-singlefile, so the main bundle is INLINED into index.html
# and the only separate .js files are the monaco workers -- walking the built files covers
# both shapes without hardcoding a filename (and a "no references" answer is not a pass).
$page = Invoke-WebRequest -Uri "$url/" -TimeoutSec 30 -UseBasicParsing
Write-Host "  GET /                 -> HTTP $($page.StatusCode), $($page.RawContentLength) bytes (index.html)"
if ($page.StatusCode -ne 200) {
  Write-Host "page not served; stopping pid $($p.Id)"
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -Force $pidFile -ErrorAction SilentlyContinue
  exit 1
}
$html = Get-Content (Join-Path $dist 'index.html') -Raw
$refs = [regex]::Matches($html, '(?:src|href)="((?:\./)?[\w./-]+?\.(?:js|css))"') | ForEach-Object { $_.Groups[1].Value }
$files = Get-ChildItem $dist -Recurse -File -Include '*.js', '*.css' | ForEach-Object { $_.FullName.Substring($dist.Length + 1).Replace('\', '/') }
$assets = @($refs) + @($files) | ForEach-Object { $_ -replace '^\./', '' } | Where-Object { $_ } | Select-Object -Unique
if (-not $assets -or $assets.Count -eq 0) { Write-Host "  WARNING: no .js/.css files found in $dist -- nothing to prove about the front end" }
foreach ($a in $assets) {
  $r = Invoke-WebRequest -Uri "$url/$a" -TimeoutSec 120 -UseBasicParsing
  Write-Host "  GET /$a -> HTTP $($r.StatusCode), $($r.RawContentLength) bytes"
}

Write-Host "Manual checklist (open the URL in a browser):"
Write-Host "  1) sign in (before Phase 1c use the existing account; after 1c use register/login)"
Write-Host "  2) create a project"
Write-Host "  3) run one generation flow (sync before Phase 1d; queued after 1d)"
Write-Host "  4) see media / credits (media after 1e; credits after Phase 2)"
Write-Host ""
Write-Host "api pid $($p.Id), logs: $outLog / $errLog"
Write-Host "Stop with: pnpm.cmd run verify:manual-test -- -Stop"
