import { Hono } from "hono"
import type { Context, Next } from "hono"
import { cors } from "hono/cors"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { logger } from "hono/logger"

const app = new Hono()

const CustomProxyQuerySchema = z.object({
  url: z.string().url(),
})

app.use(cors())

app.use(logger())

app.use(async (c: Context, next: Next) => {
  await next()
  c.res.headers.set("X-Accel-Buffering", "no")
})

app.get("/", (c: Context) => c.text("A proxy for AI!"))

const fetchWithTimeout = async (
  url: string,
  { timeout, ...options }: RequestInit & { timeout: number },
) => {
  const controller = new AbortController()

  const timeoutId = setTimeout(() => {
    controller.abort()
  }, timeout)

  try {
    // Directly use standard fetch
    const res = await fetch(url, {
      ...options, // Pass method, headers, body etc.
      signal: controller.signal,
    });
    clearTimeout(timeoutId)
    return res // Return the raw Response object
  } catch (error) {
    clearTimeout(timeoutId)
    if (controller.signal.aborted) {
      return new Response("Request timeout", {
        status: 504,
      })
    }

    throw error
  }
}

const proxies: { pathSegment: string; target: string; orHostname?: string }[] =
  [
    {
      pathSegment: "generativelanguage",
      orHostname: "gooai.chatkit.app",
      target: "https://generativelanguage.googleapis.com",
    },
    {
      pathSegment: "groq",
      target: "https://api.groq.com",
    },
    {
      pathSegment: "anthropic",
      target: "https://api.anthropic.com",
    },
    {
      pathSegment: "pplx",
      target: "https://api.perplexity.ai",
    },
    {
      pathSegment: "openai",
      target: "https://api.openai.com",
    },
    {
      pathSegment: "mistral",
      target: "https://api.mistral.ai",
    },
    {
      pathSegment: "openrouter/api",
      target: "https://openrouter.ai/api",
    },
    {
      pathSegment: "openrouter",
      target: "https://openrouter.ai/api",
    },
    {
      pathSegment: "xai",
      target: "https://api.x.ai",
    },
  ]

app.post(
  "/custom-model-proxy",
  zValidator(
    "query",
    CustomProxyQuerySchema,
  ),
  async (c) => {
    const queryData = c.req.valid("query")
    const url = queryData.url

    const res = await fetch(url, {
      method: c.req.method,
      body: c.req.raw.body,
      headers: c.req.raw.headers,
    })

    return new Response(res.body, {
      headers: res.headers,
      status: res.status,
    })
  },
)

app.use(async (c: Context, next: Next) => {
  const url = new URL(c.req.url)

  const proxy = proxies.find(
    (p) =>
      url.pathname.startsWith(`/${p.pathSegment}/`) ||
      (p.orHostname && url.hostname === p.orHostname),
  )

  if (proxy) {
    const headers = new Headers(c.req.raw.headers)
    if (proxy.pathSegment === "anthropic") {
      headers.delete("origin")
    }
    // headers.delete('content-length') // Let Workers/Hono handle this
    // headers.delete('host')           // Let Workers/Hono handle this

    // Get the raw Response from the target
    const targetRes = await fetchWithTimeout(
      `${proxy.target}${url.pathname.replace(
        `/${proxy.pathSegment}/`,
        "/",
      )}${url.search}`,
      {
        method: c.req.method,
        headers,             // Pass the modified headers
        body: c.req.raw.body, // Pass the original body
        timeout: 60000,
      },
    )

    // Check if the fetch was successful before streaming
    if (!targetRes) {
      // fetchWithTimeout might return undefined/null on error before throwing, handle defensively
      return c.text("Proxy fetch error", 500);
    }

    // Create a new Response, passing the target's body (ReadableStream) and headers directly.
    // This enables streaming.
    c.res = new Response(targetRes.body, {
      headers: targetRes.headers,
      status: targetRes.status,
      statusText: targetRes.statusText,
    });
    // Need to return c.res or just modify c.res and call next() if Hono requires returning it?
    // Hono middleware typically modifies 'c' or returns a Response. Returning c.res is safer.
    return c.res;
  }

  next()
})

export default {
  fetch: app.fetch,
}
