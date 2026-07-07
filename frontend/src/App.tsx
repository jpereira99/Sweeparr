import { useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Shell } from "./components/Shell";
import { endpoints } from "./lib/api";
import { Dashboard } from "./pages/Dashboard";
import { Upcoming } from "./pages/Upcoming";
import { RulesPage } from "./pages/Rules";
import { QC } from "./pages/QC";
import { Explorer } from "./pages/Explorer";
import { KeepRequests } from "./pages/KeepRequests";
import { History } from "./pages/History";
import { Settings } from "./pages/Settings";
import { Login } from "./pages/Login";
import { KeepDeepLink } from "./pages/user/KeepDeepLink";

function useLiveEvents() {
  const qc = useQueryClient();
  useEffect(() => {
    const es = new EventSource("/api/v1/events");
    es.onmessage = () => qc.invalidateQueries();
    es.onerror = () => {};
    return () => es.close();
  }, [qc]);
}

function AdminApp() {
  useLiveEvents();
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/upcoming" element={<Upcoming />} />
        <Route path="/qc" element={<QC />} />
        <Route path="/library" element={<Explorer />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/rules/:id" element={<RulesPage />} />
        <Route path="/requests" element={<KeepRequests />} />
        <Route path="/history" element={<History />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  const location = useLocation();
  const { data: me, isLoading, isError } = useQuery({ queryKey: ["me"], queryFn: endpoints.me, retry: false });

  if (location.pathname.startsWith("/keep/")) {
    return (
      <Routes>
        <Route path="/keep/:token" element={<KeepDeepLink />} />
      </Routes>
    );
  }

  if (isLoading) return <div className="p-10 font-mono text-ink-low">Loading Sweeparr…</div>;
  if (isError || !me?.is_admin) return <Login />;

  return <AdminApp />;
}
