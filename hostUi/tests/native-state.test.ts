import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { automationScript, powershellExecutable } from "../src/ui-adapter.js";

describe.skipIf(process.platform !== "win32")("native active transcript tracking", () => {
  it("uses the first window and only pins explicitly selected processes", () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${automationScript.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$node = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-Context' }, $true)
. ([scriptblock]::Create($node.Extent.Text))
function Check($ok) { if (-not $ok) { throw 'Native window selection assertion failed' } }
function Get-Windows { $script:windows }
function Enable-Tree($window) { $script:selected = $window; throw 'Selection captured' }
$first = @{ Current = @{ ProcessId = 101 } }
$second = @{ Current = @{ ProcessId = 202 } }
foreach ($windows in @(@($first), @($first, $second), @($second, $first))) {
    $script:windows = $windows
    try { Get-Context | Out-Null } catch { Check ($_.Exception.Message -eq 'Selection captured') }
    Check ($script:selected.Current.ProcessId -eq $windows[0].Current.ProcessId)
}
$script:windows = @()
$rejected = $false
try { Get-Context | Out-Null } catch { $rejected = $_.Exception.Message -like 'No matching VS Code window*' }
Check $rejected
$load = $ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('if ($WindowProcessId -eq 0 -and (Test-Path') }
Check (@($load).Count -eq 1)
$TargetFile = [System.IO.Path]::GetTempFileName()
try {
    foreach ($mode in @('legacy', 'first', 'pinned')) {
        $binding = @{ processId = 123; processStartedAt = 'test-start' }
        if ($mode -ne 'legacy') { $binding.selectionMode = $mode }
        $binding | ConvertTo-Json | Set-Content -LiteralPath $TargetFile
        $script:target = $null
        $WindowProcessId = 0
        . ([scriptblock]::Create($load.Extent.Text))
        if ($mode -eq 'pinned') {
            Check ($WindowProcessId -eq 123)
            Check ($script:target.processStartedAt -eq 'test-start')
        } else {
            Check ($WindowProcessId -eq 0)
            Check ($null -eq $script:target)
        }
    }
    $script:target = $null
    $WindowProcessId = 456
    . ([scriptblock]::Create($load.Extent.Text))
    Check ($WindowProcessId -eq 456)
    Check ($null -eq $script:target)
} finally {
    Remove-Item -LiteralPath $TargetFile
}
$script:target = $null
$WindowProcessId = 0
. ([scriptblock]::Create($load.Extent.Text))
Check ($WindowProcessId -eq 0)
Check ($null -eq $script:target)
'PASS'
`;
    const output = execFileSync(powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 15_000
    });
    expect(output.trim()).toBe("PASS");
  });

  it("tracks overlapping rows, detects chat changes, and rejects changed submission baselines", () => {
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${automationScript.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in @('Get-TranscriptIdentity', 'Assert-ExpectedTranscript', 'Get-Snapshot')) {
    $node = $ast.Find({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
    . ([scriptblock]::Create($node.Extent.Text))
}
function Check($ok) { if (-not $ok) { throw 'Native transcript assertion failed' } }
$a = Get-TranscriptIdentity 'runtime' @()
Check ($a -ceq (Get-TranscriptIdentity 'runtime' @(@{id='one'})))
Check ($a -ceq (Get-TranscriptIdentity 'runtime' @(@{id='one'}, @{id='two'})))
Check ($a -ceq (Get-TranscriptIdentity 'runtime' @(@{id='two'})))
$b = Get-TranscriptIdentity 'runtime' @(@{id='other-session'})
Check ($a -cne $b)
$c = Get-TranscriptIdentity 'runtime' @()
Check ($b -cne $c)
Check ($c -cne (Get-TranscriptIdentity 'different-runtime' @()))
$d = Get-TranscriptIdentity 'reused-control' @(@{id='same-row';role='user';text='first session'})
Check ($d -cne (Get-TranscriptIdentity 'reused-control' @(@{id='same-row';role='user';text='other session'})))
$e = Get-TranscriptIdentity 'streaming' @(@{id='reply';role='assistant';text='partial';completed=$false})
Check ($e -ceq (Get-TranscriptIdentity 'streaming' @(@{id='reply';role='assistant';text='finished';completed=$true})))
Check ($e -cne (Get-TranscriptIdentity 'streaming' @(@{id='reply';role='assistant';text='other completed reply';completed=$true})))
$baseline = @{targetId='session'; messages=@(@{id='one';role='user';text='question'})}
Assert-ExpectedTranscript $baseline ($baseline | ConvertTo-Json -Depth 6 | ConvertFrom-Json)
foreach ($changed in @(
    @{targetId='other'; messages=$baseline.messages},
    @{targetId='session'; messages=@(@{id='new';role='user';text='question'})},
    @{targetId='session'; messages=@(@{id='one';role='user';text='changed'})}
)) {
    $rejected = $false
    try { Assert-ExpectedTranscript $changed $baseline } catch { $rejected = $true }
    Check $rejected
}
$valid = @(@{id='valid';role='user';text='test'})
$identity = Get-TranscriptIdentity 'validation' $valid
foreach ($bad in @(
    @(@{role='user';text='no identity'}),
    @(@{id='';role='user';text='empty identity'}),
    @(@{id='duplicate'}, @{id='duplicate'})
)) {
    $rejected = $false
    try { Get-TranscriptIdentity 'validation' $bad | Out-Null } catch [System.IO.InvalidDataException] { $rejected = $true }
    Check $rejected
    Check ($identity -ceq (Get-TranscriptIdentity 'validation' $valid))
}
$script:reads = 0
function Get-Context { return @{ refreshed = $true } }
function Get-SnapshotOnce($context) {
    $script:reads++
    if ($script:reads -lt 3) { throw [System.IO.InvalidDataException]::new('Incomplete row') }
    Check $context.refreshed
    return @{ targetId = 'recovered' }
}
Check ((Get-Snapshot @{}).targetId -ceq 'recovered')
Check ($script:reads -eq 3)
$script:reads = 0
function Get-SnapshotOnce($context) {
    $script:reads++
    throw [System.IO.InvalidDataException]::new('Still incomplete')
}
$rejected = $false
try { Get-Snapshot @{} | Out-Null } catch [System.IO.InvalidDataException] { $rejected = $true }
Check $rejected
Check ($script:reads -eq 3)
$script:reads = 0
function Get-SnapshotOnce($context) {
    $script:reads++
    throw 'Target changed'
}
$rejected = $false
try { Get-Snapshot @{} | Out-Null } catch { $rejected = $_.Exception.Message -eq 'Target changed' }
Check $rejected
Check ($script:reads -eq 1)
'PASS'
`;
    const output = execFileSync(powershellExecutable, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", timeout: 15_000
    });
    expect(output.trim()).toBe("PASS");
  });
});
