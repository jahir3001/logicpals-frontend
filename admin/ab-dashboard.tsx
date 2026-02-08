import { useEffect, useMemo, useState } from "react";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!
  
);

type Bundle = {
  latest?: any[];
  variant_summary_7d?: any[];
  lift_7d?: any[];
  experiment?: any;
};

export default function AbDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [experimentKey, setExperimentKey] = useState("reg_home_tutor_hint_v1");
  const [track, setTrack] = useState<"regular" | "olympiad">("regular");
  const [days, setDays] = useState(14);

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => {
    const latest = bundle?.latest?.[0] ?? null;
    return {
      exposures: latest?.exposures ?? 0,
      unique_users: latest?.unique_users ?? latest?.unique_users_7d ?? 0,
      variant_key: latest?.variant_key ?? "unknown",
      updated_at: latest?.updated_at ?? null,
    };
  }, [bundle]);

  async function load() {
    setLoading(true);
    setError(null);
    setAuthError(null);

    const { data: sessionRes } = await supabase.auth.getSession();
    const jwt = sessionRes.session?.access_token;
    if (!jwt) {
      setAuthError("Not logged in. Please login as admin.");
      setLoading(false);
      return;
    }

    const res = await fetch("/api/ab/admin-bundle", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify({
        experiment_key: experimentKey,
        track,
        days,
      }),
    });

    const json = await res.json();
    if (!res.ok) {
      setError(json?.detail || json?.error || "Failed to load bundle");
      setLoading(false);
      return;
    }

    setBundle(json.data);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <h1>A/B Dashboard</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>
          Experiment key
          <input
            value={experimentKey}
            onChange={(e) => setExperimentKey(e.target.value)}
            style={{ marginLeft: 8, padding: 6, minWidth: 280 }}
          />
        </label>

        <label>
          Track
          <select value={track} onChange={(e) => setTrack(e.target.value as any)} style={{ marginLeft: 8, padding: 6 }}>
            <option value="regular">regular</option>
            <option value="olympiad">olympiad</option>
          </select>
        </label>

        <label>
          Days
          <input
            type="number"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            style={{ marginLeft: 8, padding: 6, width: 80 }}
            min={1}
            max={90}
          />
        </label>

        <button onClick={load} style={{ padding: "8px 12px" }}>
          Refresh
        </button>
      </div>

      <div style={{ marginTop: 12 }}>
        {authError && <div style={{ color: "crimson" }}>{authError}</div>}
        {error && <div style={{ color: "crimson" }}>{error}</div>}
        {loading && <div>Loading…</div>}
      </div>

      {!loading && bundle && (
        <>
          <h2 style={{ marginTop: 20 }}>Latest</h2>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Card title="Variant" value={summary.variant_key} />
            <Card title="Exposures" value={summary.exposures} />
            <Card title="Unique users" value={summary.unique_users} />
            <Card title="Updated" value={summary.updated_at ? String(summary.updated_at) : "-"} />
          </div>

          <h2 style={{ marginTop: 20 }}>Variant summary (7d)</h2>
          <pre style={{ background: "#111", color: "#0f0", padding: 12, overflow: "auto" }}>
            {JSON.stringify(bundle.variant_summary_7d ?? [], null, 2)}
          </pre>

          <h2 style={{ marginTop: 20 }}>Lift (7d)</h2>
          <pre style={{ background: "#111", color: "#0f0", padding: 12, overflow: "auto" }}>
            {JSON.stringify(bundle.lift_7d ?? [], null, 2)}
          </pre>
        </>
      )}
    </div>
  );
}

function Card({ title, value }: { title: string; value: any }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12, minWidth: 160 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>{title}</div>
      <div style={{ fontSize: 18, fontWeight: 600, marginTop: 6 }}>{String(value)}</div>
    </div>
  );
}