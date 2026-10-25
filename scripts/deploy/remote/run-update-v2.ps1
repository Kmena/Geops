# Single supervised Windows entrypoint for the signed B22-safe v2 point update.
# -VerifyOnly performs local cryptographic checks and remote read-only preflight.
param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$out = Join-Path $root 'output\mdm-no-oauth-20261025'
$package = Join-Path $out 'controller-v2-update.tar.gz'
$signature = Join-Path $out 'controller-v2-update.sig'
$public = Join-Path $root 'output\mdm-oauth-release-20261025\controller-v2-operational-public.pem'
$packageSha = '5be9434a7ef6d87a6d2f93a00de1af69a6d1274f2ebf6d99981f0873d17310c4'
$signatureSha = '28223e09f4e2912aa6f13eff5b4f057ce9ca4b4afd09fe352b80e4ac104c2c89'
$publicSha = 'd01423d005fe09fbec30be0b6ed8a66d144ffc5f44c3869f64aa84756a814a27'
$oldPolicySha = 'c733cdd30eace4c464bcc1490290566a9bc8f7631be6d5ab8a7e771061cc2987'
$newPolicySha = 'c439e50912842d339d32705426dd028eaa23c3390d4a6c6d29a1ac14b4fc4951'
$b22LedgerSha = 'aca17d3d9155351596a98ca412fe02b37dca575f2b8b6e8441d7466ed81abaf2'
$ssh = Join-Path $env:WINDIR 'System32\OpenSSH\ssh.exe'
$scp = Join-Path $env:WINDIR 'System32\OpenSSH\scp.exe'
foreach ($item in @(@($package, $packageSha), @($signature, $signatureSha), @($public, $publicSha))) {
    if (-not (Test-Path -LiteralPath $item[0])) { throw 'V2_UPDATE_ARTIFACT_MISSING' }
    if ((Get-FileHash -LiteralPath $item[0] -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item[1]) {
        throw 'V2_UPDATE_ARTIFACT_HASH_MISMATCH'
    }
}
$verifyScript = @'
const fs=require('fs'), crypto=require('crypto');
const [archivePath,signaturePath,publicPath]=process.argv.slice(1);
const archive=fs.readFileSync(archivePath), signature=fs.readFileSync(signaturePath);
const publicKey=fs.readFileSync(publicPath);
const digest=crypto.createHash('sha256').update(archive).digest('hex');
const message=Buffer.from(`GEOPS-V2-PACKAGE-SHA256\n${digest}\n`);
if(!crypto.verify(null,message,crypto.createPublicKey(publicKey),signature)) process.exit(42);
'@
& node -e $verifyScript $package $signature $public
if ($LASTEXITCODE -ne 0) { throw 'V2_UPDATE_SIGNATURE_INVALID' }
if ($VerifyOnly) {
    $beforeText = & $ssh -o BatchMode=yes geops-staging 'sudo -n /usr/local/sbin/geops-deploy-v2 inspect-evidence'
    if ($LASTEXITCODE -ne 0) { throw 'V2_UPDATE_REMOTE_EVIDENCE_UNAVAILABLE' }
    $before = $beforeText | ConvertFrom-Json
    if ($before.activeProfile -ne 'B22-safe' -or $before.phase -ne 'steady' -or
        $before.policySha256 -ne $oldPolicySha -or $before.ledger.sqlCount -ne 22 -or
        $before.ledger.sqlListSha256 -ne $b22LedgerSha -or
        $before.api.health -ne 'healthy' -or $before.web.health -ne 'healthy' -or
        $before.dbHealth -ne 'healthy' -or $before.gatePhase -ne 'open' -or
        $before.imageMatch -ne $true -or $before.compose.mdmEnabled -ne 'false') {
        throw 'V2_UPDATE_B22_SAFE_BASELINE_CHANGED'
    }
    $checked = & $ssh -o BatchMode=yes geops-staging 'sudo -n /usr/local/sbin/geops-deploy-v2 verify'
    if ($LASTEXITCODE -ne 0 -or ($checked | ConvertFrom-Json).result -ne 'VERIFIED') {
        throw 'V2_UPDATE_INSTALLED_CONTROLLER_VERIFY_FAILED'
    }
    Write-Output 'V2_UPDATE_PRECHECK_OK'
    exit 0
}
$remoteDir = '/home/abi/geops-v2-mdm-no-oauth-20261025'
& $ssh -o BatchMode=yes geops-staging "test ! -L '$remoteDir' && mkdir -p -m 700 '$remoteDir' && test -O '$remoteDir'"
if ($LASTEXITCODE -ne 0) { throw 'V2_UPDATE_REMOTE_STAGE_BLOCKED' }
foreach ($item in @(@($package, 'controller-v2-update.tar.gz', $packageSha),
                   @($signature, 'controller-v2-update.sig', $signatureSha))) {
    & $scp -q $item[0] "geops-staging:$remoteDir/$($item[1])"
    if ($LASTEXITCODE -ne 0) { throw 'V2_UPDATE_TRANSFER_FAILED' }
    & $ssh -o BatchMode=yes geops-staging "chmod 600 '$remoteDir/$($item[1])' && printf '%s  %s\n' '$($item[2])' '$remoteDir/$($item[1])' | sha256sum -c -"
    if ($LASTEXITCODE -ne 0) { throw 'V2_UPDATE_REMOTE_HASH_MISMATCH' }
}
$remote = @'
set -eu
source_dir=/home/abi/geops-v2-mdm-no-oauth-20261025
target_dir=/var/lib/geops-deploy/v2-point-update-no-oauth-20261025
sudo /usr/bin/install -d -o root -g root -m 0700 "$target_dir"
sudo /usr/bin/install -o root -g root -m 0600 "$source_dir/controller-v2-update.tar.gz" "$target_dir/controller-v2-update.tar.gz"
sudo /usr/bin/install -o root -g root -m 0600 "$source_dir/controller-v2-update.sig" "$target_dir/controller-v2-update.sig"
sudo /usr/bin/tar -xOzf "$target_dir/controller-v2-update.tar.gz" operator/install-v2.py | sudo /usr/bin/tee "$target_dir/install-v2.py" >/dev/null
sudo /usr/bin/chown root:root "$target_dir/install-v2.py"
sudo /usr/bin/chmod 0700 "$target_dir/install-v2.py"
sudo /usr/bin/python3 -I "$target_dir/install-v2.py" update-v2 "$target_dir/controller-v2-update.tar.gz" "$target_dir/controller-v2-update.sig"
'@
& $ssh -tt geops-staging $remote
if ($LASTEXITCODE -ne 0) { throw 'V2_UPDATE_INSTALL_BLOCKED_RETRY_SAME_COMMAND_AFTER_REVIEW' }
$afterText = & $ssh -o BatchMode=yes geops-staging 'sudo -n /usr/local/sbin/geops-deploy-v2 inspect-evidence'
if ($LASTEXITCODE -ne 0) { throw 'V2_UPDATE_FINAL_EVIDENCE_UNAVAILABLE' }
$after = $afterText | ConvertFrom-Json
if ($after.activeProfile -ne 'B22-safe' -or $after.phase -ne 'steady' -or
    $after.policySha256 -ne $newPolicySha -or $after.ledger.sqlCount -ne 22 -or
    $after.ledger.sqlListSha256 -ne $b22LedgerSha -or
    $after.api.id -ne $after.api.observedId -or
    $after.web.id -ne $after.web.observedId -or
    $after.api.health -ne 'healthy' -or $after.web.health -ne 'healthy' -or
    $after.dbHealth -ne 'healthy' -or $after.gatePhase -ne 'open' -or
    $after.imageMatch -ne $true -or $after.compose.mdmEnabled -ne 'false') {
    throw 'V2_UPDATE_FINAL_B22_SAFE_EVIDENCE_INVALID'
}
$checked = & $ssh -o BatchMode=yes geops-staging 'sudo -n /usr/local/sbin/geops-deploy-v2 verify'
if ($LASTEXITCODE -ne 0 -or ($checked | ConvertFrom-Json).result -ne 'VERIFIED') {
    throw 'V2_UPDATE_FINAL_VERIFY_FAILED'
}
Write-Output 'V2_UPDATED_B22_SAFE_VERIFIED'
