# S6e: Chrome 브라우저 프로세스의 보이는 최상위 창(본창·저장 제안 말풍선·자동완성 팝업)을 열거하고 PrintWindow로 PNG를 남긴다.
# 화면 전체를 찍지 않으므로 다른 앱 내용은 들어가지 않고, 창이 가려져 있어도 찍힌다. 결과는 JSON 배열로 stdout에 쓴다.
param([Parameter(Mandatory = $true)][int]$ProcessId, [Parameter(Mandatory = $true)][string]$OutPrefix)
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
public static class S6eWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static List<IntPtr> Of(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Text(IntPtr h) { var s = new StringBuilder(512); GetWindowText(h, s, 512); return s.ToString(); }
  public static string Cls(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  public static void Save(IntPtr h, int w, int ht, string file) {
    using (var bmp = new Bitmap(w, ht)) {
      using (var g = Graphics.FromImage(bmp)) { var dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); }
      bmp.Save(file, ImageFormat.Png);
    }
  }
}
'@
[S6eWin]::SetProcessDPIAware() | Out-Null
$n = 0
$rows = foreach ($h in [S6eWin]::Of([uint32]$ProcessId)) {
  $r = New-Object S6eWin+RECT
  [S6eWin]::GetWindowRect($h, [ref]$r) | Out-Null
  $w = $r.R - $r.L; $ht = $r.B - $r.T
  if ($w -lt 2 -or $ht -lt 2) { continue }
  $file = "$OutPrefix-$n.png"
  [S6eWin]::Save($h, $w, $ht, $file)
  $n++
  [pscustomobject]@{ class = [S6eWin]::Cls($h); title = [S6eWin]::Text($h); left = $r.L; top = $r.T; width = $w; height = $ht; file = (Split-Path $file -Leaf) }
}
ConvertTo-Json -InputObject @($rows) -Compress
