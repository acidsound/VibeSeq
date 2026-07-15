$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ServerRoot = Join-Path $ProjectRoot "server"
$EnvFile = Join-Path $ProjectRoot ".env"
$EnvFileArgs = @()
if (Test-Path -LiteralPath $EnvFile -PathType Leaf) {
    # Let python-dotenv parse data. Dot-sourcing would execute PowerShell syntax.
    $EnvFileArgs = @("--env-file", $EnvFile)
}
$SyncArgs = @("sync", "--project", $ServerRoot, "--inexact")
if ($env:VIBESEQ_INSTALL_MODELS -eq "1") {
    $SyncArgs += @("--extra", "models")
}
& uv @SyncArgs

$HostAddress = if ($env:VIBESEQ_HOST) { $env:VIBESEQ_HOST } else { "127.0.0.1" }
$Port = if ($env:VIBESEQ_PORT) { $env:VIBESEQ_PORT } else { "8787" }
& uv run --project $ServerRoot uvicorn vibeseq_inference.app:app @EnvFileArgs `
    --host $HostAddress --port $Port @args
exit $LASTEXITCODE
