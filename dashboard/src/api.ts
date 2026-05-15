import type { BrandPreset, Brief, Character, Batch } from "./types";

// API base URL.
// - In dev (Vite proxy handles /api): empty string → relative URLs
// - In prod on Vercel: VITE_API_BASE points at Railway backend
// - When backend is served alongside SPA (Railway monolith): empty string
export const API_BASE =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    ?.VITE_API_BASE || "";

const url = (p: string) => `${API_BASE}${p}`;

// For <img src=...> on uploaded logos, character photos, and card images.
// Prepends API_BASE when set so images on the Vercel frontend point at
// the Railway backend; in dev returns the relative path (Vite proxy).
export const assetUrl = (p: string) => `${API_BASE}${p.startsWith("/") ? p : `/${p}`}`;

const json = async <T,>(p: string, init?: RequestInit): Promise<T> => {
  const resp = await fetch(url(p), {
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status}: ${text}`);
  }
  return resp.json();
};

// Brand
export const getBrand = () => json<BrandPreset[]>("/api/brand");
export const saveBrand = (p: BrandPreset) =>
  json<BrandPreset>("/api/brand", {
    method: "POST",
    body: JSON.stringify(p),
  });
export const uploadLogo = async (presetId: string, file: File) => {
  const fd = new FormData();
  fd.append("logo", file);
  fd.append("presetId", presetId);
  const resp = await fetch(url("/api/brand/logo"), {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  if (!resp.ok) throw new Error("Upload failed");
  return resp.json() as Promise<{ logoSrc: string }>;
};

// Briefs
export const getBriefs = () => json<Brief[]>("/api/briefs");
export const saveBrief = (b: Brief) =>
  json<Brief>("/api/briefs", { method: "POST", body: JSON.stringify(b) });
export const deleteBrief = (id: string) =>
  json<{ ok: true }>(`/api/briefs/${id}`, { method: "DELETE" });

// Characters
export const getCharacters = () => json<Character[]>("/api/characters");
export const saveCharacter = (c: Character) =>
  json<Character>("/api/characters", {
    method: "POST",
    body: JSON.stringify(c),
  });
export const deleteCharacter = (id: string) =>
  json<{ ok: true }>(`/api/characters/${id}`, { method: "DELETE" });
export const uploadCharacterPhoto = async (charId: string, file: File) => {
  const fd = new FormData();
  fd.append("photo", file);
  fd.append("charId", charId);
  const resp = await fetch(url("/api/characters/photo"), {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  if (!resp.ok) throw new Error("Upload failed");
  return resp.json() as Promise<{ path: string }>;
};

// Batches
export const getBatches = () => json<Batch[]>("/api/batches");
export const getBatch = (stamp: string) =>
  json<Batch>(`/api/batches/${stamp}`);
export const getAllBatchesCombined = () =>
  json<Batch>("/api/batches/all");
export const setCardApproval = (
  stamp: string,
  idx: number,
  status: "approved" | "rejected" | "pending",
) =>
  json<{ ok: true }>(`/api/batches/${stamp}/cards/${idx}/approval`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });

export const deleteCard = (stamp: string, idx: number) =>
  json<{ ok: true; deleted: string }>(`/api/batches/${stamp}/cards/${idx}`, {
    method: "DELETE",
  });

export const unpostCard = (stamp: string, idx: number) =>
  json<{ ok: true }>(`/api/queue/${stamp}/${idx}/unpost`, {
    method: "POST",
  });

export const refreshPostStatus = () =>
  json<{ updated: number }>(`/api/queue/refresh-status`, {
    method: "POST",
  });

export const getVersion = () =>
  json<{ version: string }>(`/api/version`);

// Generate
export type GenerateOpts = {
  count: number;
  brandPresetId?: string;
  briefId?: string;
  useCharacters?: boolean;
  layoutMix?: { classic: number; image: number; bold: number };
};

export const generateBatch = async (
  opts: GenerateOpts,
  onLine: (line: string) => void,
  signal?: AbortSignal,
) => {
  const resp = await fetch(url("/api/generate"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
    credentials: "include",
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Generate failed: ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  }
  if (buf.trim()) onLine(buf);
};

// Posting config
export type PostingConfig = {
  pageId: string;
  token: string;          // masked
  hasToken: boolean;
  pageName: string;
  pageFans?: number;
  timezone: string;
  peakHours: string[];
  dailyCap: number;
  paused?: boolean;
  pausedAt?: string;
};

export const getPostingConfig = () => json<PostingConfig>("/api/posting/config");
export const savePostingConfig = (cfg: Partial<PostingConfig> & { token?: string }) =>
  json<PostingConfig>("/api/posting/config", {
    method: "POST",
    body: JSON.stringify(cfg),
  });

export const pausePosting = () =>
  json<{ ok: true; paused: number }>("/api/posting/pause", { method: "POST" });

export const resumePosting = () =>
  json<{ ok: true; pausedCards: number }>("/api/posting/resume", { method: "POST" });

export const restorePausedCards = () =>
  json<{ restored: number }>("/api/queue/restore-paused", { method: "POST" });

// Queue
export type QueueItem = {
  stamp: string;
  index: number;
  cardId?: string;
  file: string;
  quote: string;
  caption: string;
  variant: string;
  aspectRatio: string;
};

export type HistoryItem = QueueItem & {
  status: "scheduled" | "posted" | "failed";
  scheduledAt?: string;
  postedAt?: string;
  fbPostId?: string;
  fbUrl?: string;
  error?: string;
};

export const getQueue = () => json<QueueItem[]>("/api/queue");
export const getHistory = () => json<HistoryItem[]>("/api/queue/history");

export const scheduleAll = (startAt?: string) =>
  json<{ scheduled: number; failed: number; results: unknown[] }>(
    "/api/queue/schedule-all",
    {
      method: "POST",
      body: JSON.stringify({ startAt }),
    },
  );

export const postNow = (stamp: string, idx: number) =>
  json<{ ok: boolean; fbUrl: string; id: string }>(
    `/api/queue/${stamp}/${idx}/post-now`,
    { method: "POST" },
  );
