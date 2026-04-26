import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";

interface SummaryRow {
  panel: string;
  provider: string;
  upstream_calls: number;
  cache_hits: number;
  total_cost_usd: number;
}

interface RecentRow {
  id: string;
  panel: string;
  provider: string;
  model: string | null;
  cost_usd: number;
  cache_hit: boolean;
  created_at: string;
}

const AdminCosts = () => {
  const { session, isAdmin, loading: authLoading, signOut } = useAuth();
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [auditing, setAuditing] = useState(false);
  const [auditResult, setAuditResult] = useState<any>(null);

  const runAudit = async () => {
    setAuditing(true);
    setAuditResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("audit-refresh");
      if (error) setAuditResult({ error: error.message });
      else setAuditResult(data);
    } catch (e: any) {
      setAuditResult({ error: e?.message ?? String(e) });
    } finally {
      setAuditing(false);
    }
  };

  useEffect(() => {
    if (!session || !isAdmin) return;
    const load = async () => {
      setLoading(true);
      const [{ data: sum }, { data: rec }] = await Promise.all([
        (supabase as any).from("api_cost_summary_24h").select("*"),
        (supabase as any)
          .from("api_cost_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50),
      ]);
      setSummary((sum as SummaryRow[]) || []);
      setRecent((rec as RecentRow[]) || []);
      setLoading(false);
    };
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [session, isAdmin]);

  if (authLoading) {
    return <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>;
  }
  if (!session) return <Navigate to="/adminlogin" replace />;
  if (!isAdmin) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
        <h1 className="text-xl font-semibold">Access denied</h1>
        <p className="text-sm text-muted-foreground">Your account does not have admin privileges.</p>
        <Button variant="outline" onClick={signOut}>Sign out</Button>
      </div>
    );
  }

  const total24h = summary.reduce((s, r) => s + Number(r.total_cost_usd), 0);
  const totalCalls = summary.reduce((s, r) => s + r.upstream_calls, 0);
  const totalCacheHits = summary.reduce((s, r) => s + r.cache_hits, 0);
  const cacheHitRate =
    totalCalls + totalCacheHits > 0
      ? ((totalCacheHits / (totalCalls + totalCacheHits)) * 100).toFixed(1)
      : "0";

  // Group by panel for the breakdown
  const byPanel = summary.reduce<Record<string, SummaryRow[]>>((acc, r) => {
    (acc[r.panel] ||= []).push(r);
    return acc;
  }, {});

  return (
    <div className="min-h-screen bg-background text-foreground p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold mb-1">Cost Attribution</h1>
          <p className="text-sm text-muted-foreground">
            Per-panel API spend tracking. Auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="default" size="sm" onClick={runAudit} disabled={auditing}>
            {auditing ? "Auditing…" : "Run audit now"}
          </Button>
          <Button variant="outline" size="sm" onClick={signOut}>Sign out</Button>
        </div>
      </div>

      {auditResult && (
        <Card className="p-4 mb-6">
          <div className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Last audit result</div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
            {JSON.stringify(auditResult, null, 2)}
          </pre>
        </Card>
      )}

      {loading && <p className="text-muted-foreground">Loading…</p>}

      {!loading && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
            <Card className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">24h Spend</div>
              <div className="text-3xl font-bold mt-1">${total24h.toFixed(4)}</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Upstream Calls</div>
              <div className="text-3xl font-bold mt-1">{totalCalls}</div>
            </Card>
            <Card className="p-4">
              <div className="text-xs text-muted-foreground uppercase tracking-wide">Cache Hit Rate</div>
              <div className="text-3xl font-bold mt-1">{cacheHitRate}%</div>
              <div className="text-xs text-muted-foreground mt-1">{totalCacheHits} hits saved</div>
            </Card>
          </div>

          <h2 className="text-lg font-semibold mb-3">By Panel</h2>
          <div className="space-y-3 mb-8">
            {Object.entries(byPanel).map(([panel, rows]) => {
              const panelTotal = rows.reduce((s, r) => s + Number(r.total_cost_usd), 0);
              const panelCalls = rows.reduce((s, r) => s + r.upstream_calls, 0);
              return (
                <Card key={panel} className="p-4">
                  <div className="flex justify-between items-baseline mb-2">
                    <h3 className="font-semibold capitalize">{panel.replace(/-/g, " ")}</h3>
                    <div className="text-lg font-mono">${panelTotal.toFixed(4)}</div>
                  </div>
                  <div className="text-xs text-muted-foreground mb-2">
                    {panelCalls} upstream calls / {rows.reduce((s, r) => s + r.cache_hits, 0)} cache hits
                  </div>
                  <table className="w-full text-xs">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="text-left font-normal">Provider</th>
                        <th className="text-right font-normal">Calls</th>
                        <th className="text-right font-normal">Cache hits</th>
                        <th className="text-right font-normal">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="py-1">{r.provider}</td>
                          <td className="py-1 text-right">{r.upstream_calls}</td>
                          <td className="py-1 text-right">{r.cache_hits}</td>
                          <td className="py-1 text-right font-mono">${Number(r.total_cost_usd).toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              );
            })}
            {Object.keys(byPanel).length === 0 && (
              <p className="text-muted-foreground text-sm">No activity in the last 24 hours.</p>
            )}
          </div>

          <h2 className="text-lg font-semibold mb-3">Recent Activity</h2>
          <Card className="p-0 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted text-muted-foreground">
                <tr>
                  <th className="text-left p-2 font-normal">Time</th>
                  <th className="text-left p-2 font-normal">Panel</th>
                  <th className="text-left p-2 font-normal">Provider</th>
                  <th className="text-left p-2 font-normal">Model</th>
                  <th className="text-right p-2 font-normal">Cost</th>
                  <th className="text-center p-2 font-normal">Cache</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="p-2 font-mono">
                      {new Date(r.created_at).toLocaleTimeString()}
                    </td>
                    <td className="p-2">{r.panel}</td>
                    <td className="p-2">{r.provider}</td>
                    <td className="p-2 text-muted-foreground">{r.model || "—"}</td>
                    <td className="p-2 text-right font-mono">${Number(r.cost_usd).toFixed(4)}</td>
                    <td className="p-2 text-center">{r.cache_hit ? "✓" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
};

export default AdminCosts;
