export type VideoStatus = "queued" | "in_progress" | "completed" | "failed";

export interface VideoError {
  message: string;
  code: string;
}

/** One generation job. The API models image jobs as "videos" too. */
export interface Video {
  id: string;
  status: VideoStatus;
  model: string;
  progress: number;
  createdAt: number;
  completedAt: number | null;
  expiresAt: number | null;
  outputUrl: string | null;
  error: VideoError | null;
  /** Untouched response body, for fields this client does not model yet. */
  raw: Record<string, unknown>;
}

export interface CreateParams {
  model: string;
  prompt: string;
  /** Clip length, 1-60 (default 4). Ignored by image models. */
  seconds?: number | string;
  /** Pixel size as "WxH", e.g. "1280x720". Aspect ratio is inferred. */
  size?: string;
  /** 1k/2k/4k (images), 720p/1080p/4k (Veo). Set it explicitly: pricing is per tier. */
  tier?: string;
  /** HTTPS or data: URLs. */
  referenceImages?: string[];
  /** Model-specific extras, e.g. { first_last_frame: true }. */
  metadata?: Record<string, unknown>;
  /** Passed through verbatim, so new API fields work before this client knows them. */
  [extra: string]: unknown;
}

export interface WaitOptions {
  /** Seconds before giving up polling. Default 900. */
  timeout?: number;
  /** Seconds between polls. Default 3. */
  pollInterval?: number;
  onProgress?: (video: Video) => void;
}

export type GenerateParams = CreateParams & WaitOptions;

export function isDone(video: Video): boolean {
  return video.status === "completed" || video.status === "failed";
}

export function videoFromJson(data: Record<string, unknown>): Video {
  const optInt = (k: string): number | null => (typeof data[k] === "number" ? (data[k] as number) : null);
  const err = data.error;
  return {
    id: String(data.id || data.task_id || ""),
    status: String(data.status || "queued") as VideoStatus,
    model: String(data.model || ""),
    progress: Number(data.progress || 0),
    createdAt: Number(data.created_at || 0),
    completedAt: optInt("completed_at"),
    expiresAt: optInt("expires_at"),
    outputUrl: (data.output_url as string) || null,
    error:
      err && typeof err === "object"
        ? {
            message: String((err as Record<string, unknown>).message || ""),
            code: String((err as Record<string, unknown>).code || ""),
          }
        : null,
    raw: data,
  };
}
