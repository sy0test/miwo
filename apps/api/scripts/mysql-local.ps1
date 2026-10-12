<#
  Local portable MySQL 8 helper for miwo (Phase 1a).

  ASCII ONLY. PowerShell 5.1 reads a .ps1 file as ANSI, so any non-ASCII byte in
  this file is parsed as garbage and the script fails with a syntax error
  (measured on this machine). Keep every character in this file below 0x80.

  Layout (all OUTSIDE the repository, so nothing here can ever be committed):
    tools dir : D:\sy_workspace\.tools
    basedir   : <tools>\mysql          (unzipped mysql-8.4.11-winx64)
    datadir   : <tools>\mysql-data     (never inside the repo, never in apps/api/data)
    tmpdir    : <tools>\mysql-tmp      (see the note below -- InnoDB cannot always use %TEMP%)
    options   : <tools>\my.ini         (port 3307, utf8mb4, loopback only)

  Note on tmpdir (measured on this machine, Task 7):
    With the stock configuration InnoDB creates its temporary files under %TEMP% and
    --initialize-insecure aborts with
      [ERROR] [MY-012576] [InnoDB] Unable to create temporary file inside
      "C:\Users\<user>\AppData\Local\Temp"; errno: 13
    even though that directory is writable by this shell. Pointing my.ini at a tmpdir
    we own (D:\sy_workspace\.tools\mysql-tmp) fixes it. Keep tmpdir set.

  Usage:
    powershell -ExecutionPolicy Bypass -File apps/api/scripts/mysql-local.ps1 -Action init
    powershell -ExecutionPolicy Bypass -File apps/api/scripts/mysql-local.ps1 -Action start
    powershell -ExecutionPolicy Bypass -File apps/api/scripts/mysql-local.ps1 -Action status
    powershell -ExecutionPolicy Bypass -File apps/api/scripts/mysql-local.ps1 -Action createdb
    powershell -ExecutionPolicy Bypass -File apps/api/scripts/mysql-local.ps1 -Action stop
    powershell -ExecutionPolicy Bypass -File apps/api/scripts/mysql-local.ps1 -Action cli

  Notes:
    - No Windows service is registered and nothing auto-starts: "start" launches
      mysqld.exe as a hidden child of this shell, "stop" shuts it down again.
    - --initialize-insecure means user root has NO password. That is acceptable
      only because bind-address is 127.0.0.1 on a developer machine.
#>
param(
  [Parameter(Mandatory = $true)][ValidateSet("init","start","stop","status","createdb","cli")] [string]$Action,
  [string]$ToolsDir = "D:\sy_workspace\.tools",
  [string]$Database = "miwo_test",
  [string]$User = "miwo",
  [string]$Password = "miwo"
)
$ErrorActionPreference = "Stop"
$mysql  = Join-Path $ToolsDir "mysql"
$data   = Join-Path $ToolsDir "mysql-data"
$tmp    = Join-Path $ToolsDir "mysql-tmp"
$ini    = Join-Path $ToolsDir "my.ini"
$mysqld = Join-Path $mysql "bin\mysqld.exe"
$mysqlc = Join-Path $mysql "bin\mysql.exe"
$port   = 3307

switch ($Action) {
  "init" {
    if (-not (Test-Path $mysqld)) { throw "mysqld not found: $mysqld (download + unzip first)" }
    if (-not (Test-Path $ini)) { throw "options file not found: $ini (see the 'data layer' section of README.md for its content)" }
    New-Item -ItemType Directory -Force -Path $data | Out-Null
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    if (Test-Path (Join-Path $data "auto.cnf")) { Write-Host "already initialized: $data"; break }
    # --console: measured on 8.4.11 that it does NOT clash with log-error= in my.ini --
    # it simply takes precedence, so the initialize output goes to this terminal and
    # error.log is not written for this step (the two are mutually exclusive in practice).
    # That is why a failing init is visible right here instead of only in the log file.
    & $mysqld --defaults-file="$ini" --initialize-insecure --console
    Write-Host "initialize exit=$LASTEXITCODE"
    if (Test-Path (Join-Path $data "error.log")) {
      Write-Host "---- tail of $data\error.log ----"
      Get-Content (Join-Path $data "error.log") -Tail 20
      Write-Host "--------------------------------"
    }
    if ($LASTEXITCODE -ne 0) { throw "initialize failed (see the output above / $data\error.log)" }
  }
  "start" {
    if (-not (Test-Path $mysqld)) { throw "mysqld not found: $mysqld" }
    if (-not (Test-Path $ini)) { throw "options file not found: $ini" }
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    # Start-Process lets it detach from this console (mysqld would otherwise hold the prompt).
    Start-Process -FilePath $mysqld -ArgumentList "--defaults-file=`"$ini`"" -WindowStyle Hidden
    for ($i = 0; $i -lt 60; $i++) {
      Start-Sleep -Milliseconds 500
      if (Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue) {
        Write-Host "mysql is listening on 127.0.0.1:$port"
        break
      }
      if ($i -eq 59) { throw "mysql did not start in 30s; see $data\error.log" }
    }
  }
  "stop" {
    # Graceful shutdown first: mysqladmin shutdown (root has no password after --initialize-insecure).
    $admin = Join-Path $mysql "bin\mysqladmin.exe"
    if (Test-Path $admin) { & $admin --protocol=TCP --host=127.0.0.1 --port=$port --user=root shutdown 2>$null }
    Start-Sleep -Seconds 2
    Get-Process mysqld -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-Host "stopped"
  }
  "status" {
    $ok = Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
    Write-Host ("listening=" + $ok)
  }
  "createdb" {
    # root (no password after --initialize-insecure) creates the databases and the app account.
    $sql = "CREATE DATABASE IF NOT EXISTS ``$Database`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; " +
           "CREATE DATABASE IF NOT EXISTS ``miwo`` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; " +
           "CREATE USER IF NOT EXISTS '$User'@'%' IDENTIFIED BY '$Password'; " +
           "GRANT ALL PRIVILEGES ON ``$Database``.* TO '$User'@'%'; " +
           "GRANT ALL PRIVILEGES ON ``miwo``.* TO '$User'@'%'; FLUSH PRIVILEGES;"
    & $mysqlc --protocol=TCP --host=127.0.0.1 --port=$port --user=root --execute="$sql"
    Write-Host "createdb exit=$LASTEXITCODE ; db=$Database and miwo ; user=$User"
  }
  "cli" {
    & $mysqlc --protocol=TCP --host=127.0.0.1 --port=$port --user=$User "--password=$Password" $Database
  }
}
