import type { Video } from "./types.js";

/** Base class for everything this library throws. */
export class GenRelayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The API returned a non-2xx response. */
export class APIError extends GenRelayError {
  status?: number;
  code?: string;
  body?: unknown;
  constructor(message: string, opts: { status?: number; code?: string; body?: unknown } = {}) {
    super(message);
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

/** 401/403: the API key is missing, malformed or revoked. */
export class AuthenticationError extends APIError {}

/** 402: the account is out of credits. Expected outcome, not a bug: top up. */
export class InsufficientCreditsError extends APIError {}

/** 429: too many requests. Retry after a delay. */
export class RateLimitError extends APIError {}

/** The job was accepted but finished as `failed`. */
export class JobFailedError extends GenRelayError {
  video?: Video;
  constructor(message: string, opts: { video?: Video } = {}) {
    super(message);
    this.video = opts.video;
  }
}

/**
 * The job did not finish within `timeout` seconds. It keeps running
 * server-side: poll `taskId` again instead of resubmitting, which bills twice.
 */
export class JobTimeout extends GenRelayError {
  taskId?: string;
  constructor(message: string, opts: { taskId?: string } = {}) {
    super(message);
    this.taskId = opts.taskId;
  }
}
