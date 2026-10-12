# genrelay

[![npm](https://img.shields.io/npm/v/genrelay)](https://www.npmjs.com/package/genrelay) [![license](https://img.shields.io/npm/l/genrelay)](LICENSE)

JavaScript/TypeScript client for [GenRelay](https://genrelay.ai/?utm_source=github&utm_medium=readme&utm_campaign=genrelay-js), a generative media API: **Veo 3.1**, **Grok Imagine**, **Nano Banana Pro/2**, **GPT Image 2** and **Omni Flash** behind one key. Text-to-video, image-to-video, first/last-frame, and image generation. Node 18+, zero runtime dependencies, written in TypeScript.

```bash
npm install genrelay
```

## Quick start

```ts
import { GenRelay } from "genrelay";

const client = new GenRelay(); // reads GENRELAY_API_KEY

const video = await client.videos.generate({
  model: "veo_3_1",
  prompt: "a neon fox running through a rainy city at night",
  seconds: 8,
  size: "1280x720",
  tier: "1080p",
});

await client.videos.download(video.id, "fox.mp4");
```

`generate` submits the job, polls with backoff until it finishes, and returns the result. Generation takes seconds to minutes depending on the model and length.

## Async, when you need control

```ts
const job = await client.videos.create({ model: "veo_3_1", prompt: "a lighthouse at dusk", seconds: 8 });
console.log(job.id, job.status); // persist job.id, come back later

const video = await client.videos.wait(job.id, {
  timeout: 900,
  onProgress: (v) => console.log(v.status, v.progress),
});
```

## Parameters

| Name | Type | Notes |
|---|---|---|
| `model` | string | required |
| `prompt` | string | required |
| `seconds` | number \| string | 1-60, default 4. Ignored by image models |
| `size` | string | `"1280x720"`. Aspect ratio is inferred |
| `tier` | string | `1k`/`2k`/`4k` (images), `720p`/`1080p`/`4k` (Veo) |
| `referenceImages` | string[] | HTTPS or `data:` URLs |
| `metadata` | object | model-specific extras, e.g. `{ first_last_frame: true }` |

> **Set `tier` explicitly.** Pricing is per tier, and a `size` that matches no tier falls back to the model's base rate, which can cost more than you expect.

Unknown properties are forwarded as-is, so new API fields work before this client knows about them.

## Errors

```ts
import { InsufficientCreditsError, JobFailedError, JobTimeout } from "genrelay";

try {
  const video = await client.videos.generate({ model: "veo_3_1", prompt: "..." });
} catch (e) {
  if (e instanceof InsufficientCreditsError) {
    // 402: top up
  } else if (e instanceof JobFailedError) {
    console.log(e.video?.error); // the model could not produce a result
  } else if (e instanceof JobTimeout) {
    console.log(e.taskId); // still running: poll later, do not resubmit
  } else throw e;
}
```

`JobTimeout` keeps the task id on purpose: resubmitting bills a second time, polling does not. All errors extend `GenRelayError`.

## Chat and image edits

Those are OpenAI-compatible, so the official `openai` package pointed at `https://genrelay.ai/v1` works. This package covers the asynchronous generation jobs.

## Configuration

| | |
|---|---|
| `GENRELAY_API_KEY` | API key, or pass `apiKey` |
| `GENRELAY_BASE_URL` | override the endpoint (default `https://genrelay.ai/v1`) |

```ts
const client = new GenRelay({ apiKey: "sk-...", timeoutMs: 60000, maxRetries: 2 });
```

## FAQ

**How do I get an API key?** Sign up at [genrelay.ai](https://genrelay.ai/?utm_source=github&utm_medium=readme&utm_campaign=genrelay-js) and create a key in the console.

**How is it billed?** Prepaid credits in USD, pay as you go. See [Pricing](https://genrelay.ai/pricing?utm_source=github&utm_medium=readme&utm_campaign=genrelay-js).

**Is there a Python SDK or an MCP server?** Yes: [genrelay-python](https://github.com/gaoruitech/genrelay-python) and [genrelay-mcp](https://github.com/gaoruitech/genrelay-mcp).

## License

MIT
