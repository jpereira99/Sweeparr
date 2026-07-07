export type Json = Record<string, any>;

async function req(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status}: ${detail}`);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res.text();
}

export const api = {
  get: (p: string) => req("GET", p),
  post: (p: string, b?: unknown) => req("POST", p, b),
  put: (p: string, b?: unknown) => req("PUT", p, b),
  del: (p: string) => req("DELETE", p),
};

const B = "/api/v1";

export const endpoints = {
  me: () => api.get(`${B}/auth/me`),
  login: (username: string, password: string) => api.post(`${B}/auth/login`, { username, password }),
  logout: () => api.post(`${B}/auth/logout`),
  changePassword: (current_password: string, new_password: string) =>
    api.post(`${B}/auth/change-password`, { current_password, new_password }),

  dashboard: () => api.get(`${B}/dashboard`),
  schedule: () => api.get(`${B}/schedule`),
  media: (params: string) => api.get(`${B}/media${params}`),
  mediaDetail: (id: number) => api.get(`${B}/media/${id}`),

  rules: () => api.get(`${B}/rules`),
  rule: (id: number) => api.get(`${B}/rules/${id}`),
  catalog: () => api.get(`${B}/rules/catalog`),
  createRule: (b: unknown) => api.post(`${B}/rules`, b),
  updateRule: (id: number, b: unknown) => api.put(`${B}/rules/${id}`, b),
  deleteRule: (id: number) => api.del(`${B}/rules/${id}`),
  preview: (b: unknown) => api.post(`${B}/rules/preview`, b),
  enableRule: (id: number) => api.post(`${B}/rules/${id}/enable`),
  disableRule: (id: number) => api.post(`${B}/rules/${id}/disable`),
  qc: (id: number) => api.get(`${B}/rules/${id}/qc`),

  keepUnit: (t: string, id: number, b: unknown) => api.post(`${B}/units/${t}/${id}/keep`, b),
  postpone: (t: string, id: number, days: number) => api.post(`${B}/units/${t}/${id}/postpone`, { days }),
  unschedule: (t: string, id: number) => api.post(`${B}/units/${t}/${id}/unschedule`),
  deleteNow: (t: string, id: number) => api.post(`${B}/units/${t}/${id}/delete-now`),
  createKeepRequest: (t: string, id: number, b: unknown) => api.post(`${B}/units/${t}/${id}/keep-request`, b),

  keepRequests: (status = "pending") => api.get(`${B}/keep-requests?status=${status}`),
  approveKeep: (id: number, b: unknown) => api.post(`${B}/keep-requests/${id}/approve`, b),
  denyKeep: (id: number, b: unknown) => api.post(`${B}/keep-requests/${id}/deny`, b),

  jobs: () => api.get(`${B}/jobs`),
  runJob: (name: string) => api.post(`${B}/jobs/${name}/run`),
  pauseJob: (name: string) => api.post(`${B}/jobs/${name}/pause`),
  resumeJob: (name: string) => api.post(`${B}/jobs/${name}/resume`),

  history: (action?: string) => api.get(`${B}/history${action ? `?action=${action}` : ""}`),
  settings: () => api.get(`${B}/settings`),
  updateSettings: (b: unknown) => api.put(`${B}/settings`, b),
  testConnection: (svc: string) => api.post(`${B}/settings/test/${svc}`),
};
