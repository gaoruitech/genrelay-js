import { createWriteStream } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  APIError,
  AuthenticationError,
  InsufficientCreditsError,
  JobFailedError,
  JobTimeout,
  RateLimitError,
} from "./errors.js";
import {
  isDone,
  videoFromJson,
  type CreateParams,
  type GenerateParams,
  type Video,
  type WaitOptions,
} from "./types.js";

export * from "./errors.js";
export * from "./types.js";

export const VERSION = "0.1.0";
const DEFAULT_BASE_URL = "https://genrelay.ai/v1";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL = 3;
const DEFAULT_MAX_WAIT = 900;

export interface GenRelayOptions {
  apiKey?: string;
  baseUrl?: string;
  /** Per-request HTTP timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Retries for 429/5xx and timeouts. Default 2. */
  maxRetries?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8000) + Math.random() * 300;

export class Videos {
  constructor(private readonly client: GenRelay) {}

  /** Submit a job and return immediately. */
  async create(params: CreateParams): Promise<Video> {
    const { model, prompt, seconds, size, tier, referenceImages, metadata, ...extra } = params;
    const body: Record<string, unknown> = { model, prompt };
    if (seconds !== undefined) body.seconds = seconds;
    if (size !== undefined) body.size = size;
    if (tier !== undefined) body.tier = tier;
    if (referenceImages && referenceImages.length) body.reference_images = referenceImages;
    if (metadata && Object.keys(metadata).length) body.metadata = metadata;
    Object.assign(body, extra);
    return videoFromJson(await this.client.request("POST", "/videos", body));
  }

  /** Read the job's current state. One HTTP call, no waiting. */
  async retrieve(taskId: string): Promise<Video> {
    return videoFromJson(await this.client.request("GET", `/videos/${taskId}`));
  }

  /**
   * Poll until the job is terminal.
   * Throws JobFailedError if it failed, JobTimeout if still running at `timeout`
   * (the job is not cancelled: poll the id again, do not resubmit).
   */
  async wait(taskId: string, opts: WaitOptions = {}): Promise<Video> {
    const timeout = opts.timeout ?? DEFAULT_MAX_WAIT;
    const poll = opts.pollInterval ?? DEFAULT_POLL_INTERVAL;
    const deadline = Date.now() + timeout * 1000;
    for (let attempt = 0; ; attempt++) {
      const video = await this.retrieve(taskId);
      opts.onProgress?.(video);
      if (isDone(video)) {
        if (video.status === "failed") {
          throw new JobFailedError(`job ${video.id} failed: ${video.error?.message || "no detail given"}`, { video });
        }
        return video;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new JobTimeout(
          `job ${taskId} still ${video.status} after ${timeout}s; poll it again later instead of resubmitting`,
          { taskId },
        );
      }
      const delay = Math.min(poll * (1 + 0.25 * attempt), 10) * 1000 + Math.random() * 400;
      await sleep(Math.min(delay, Math.max(remaining, 100)));
    }
  }

  /** Submit and wait: the one-liner. */
  async generate(params: GenerateParams): Promise<Video> {
    const { timeout, pollInterval, onProgress, ...createParams } = params;
    const job = await this.create(createParams as CreateParams);
    return this.wait(job.id, { timeout, pollInterval, onProgress });
  }

  /** Stream the finished asset to `dest` (written via a .part file first). Returns dest. */
  async download(taskId: string, dest: string): Promise<string> {
    await mkdir(dirname(dest) || ".", { recursive: true });
    const res = await this.client.rawRequest("GET", `/videos/${taskId}/content`);
    if (!res.body) throw new APIError("empty download body", { status: res.status });
    const tmp = `${dest}.part`;
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
    await rename(tmp, dest);
    return dest;
  }
}

export class GenRelay {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly maxRetries: number;
  readonly videos: Videos;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: GenRelayOptions = {}) {
    const key = opts.apiKey || process.env.GENRELAY_API_KEY || "";
    if (!key) throw new AuthenticationError("no API key: pass apiKey or set GENRELAY_API_KEY");
    this.apiKey = key;
    this.baseUrl = (opts.baseUrl || process.env.GENRELAY_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, opts.maxRetries ?? 2);
    this.fetchImpl = opts.fetch ?? fetch;
    this.videos = new Videos(this);
  }

  /** @internal */
  async rawRequest(method: string, path: string, json?: unknown): Promise<Response> {
    const url = `${this.baseUrl}/${path.replace(/^\/+/, "")}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "User-Agent": `genrelay-js/${VERSION}`,
    };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: json === undefined ? undefined : JSON.stringify(json),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        if (attempt < this.maxRetries) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new APIError(`request to ${path} failed: ${(e as Error).message}`);
      }
      if (res.status < 400) return res;
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < this.maxRetries) {
        const ra = Number(res.headers.get("Retry-After"));
        await res.arrayBuffer().catch(() => undefined);
        await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt));
        continue;
      }
      throw await errorFor(res, path);
    }
  }

  /** @internal */
  async request(method: string, path: string, json?: unknown): Promise<Record<string, unknown>> {
    const res = await this.rawRequest(method, path, json);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new APIError(`${path} returned non-JSON body`, { status: res.status });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new APIError(`${path} returned an unexpected body, expected an object`, { status: res.status, body: data });
    }
    return data as Record<string, unknown>;
  }
}

async function errorFor(res: Response, path: string): Promise<APIError> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  let message = "";
  let code: string | undefined;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    const e = b.error;
    if (e && typeof e === "object") {
      message = String((e as Record<string, unknown>).message || "");
      code = ((e as Record<string, unknown>).code as string) || undefined;
    } else if (typeof e === "string") message = e;
    else if (b.message) {
      message = String(b.message);
      code = (b.code as string) || undefined;
    }
  } else if (text) message = text.slice(0, 300);
  message = message || `${path} failed with HTTP ${res.status}`;
  const Cls =
    ({ 401: AuthenticationError, 403: AuthenticationError, 402: InsufficientCreditsError, 429: RateLimitError } as Record<number, typeof APIError>)[
      res.status
    ] ?? APIError;
  return new Cls(message, { status: res.status, code, body });
}
