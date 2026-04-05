const DEFAULT_MAX_BYTES = 102400; // 100KB

/**
 * @param {Record<string, unknown>} params
 * @returns {Promise<{ success: boolean; output: unknown; durationMs: number; error?: string }>}
 */
export async function execute(params) {
  const start = Date.now();
  const url = params.url;

  if (typeof url !== "string" || url.length === 0) {
    return {
      success: false,
      output: null,
      error: "Missing required parameter: url",
      durationMs: Date.now() - start,
    };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return {
      success: false,
      output: null,
      error: `Invalid URL: ${url}`,
      durationMs: Date.now() - start,
    };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      success: false,
      output: null,
      error: `Unsupported protocol: ${parsed.protocol}`,
      durationMs: Date.now() - start,
    };
  }

  const method =
    typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  const headers =
    params.headers !== null && typeof params.headers === "object"
      ? /** @type {Record<string, string>} */ (params.headers)
      : {};
  const body = typeof params.body === "string" ? params.body : undefined;
  const maxBytes =
    typeof params.maxBytes === "number" ? params.maxBytes : DEFAULT_MAX_BYTES;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method !== "GET" && method !== "HEAD" ? body : undefined,
    });

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    let responseBody;
    let truncated = false;

    if (method === "HEAD") {
      responseBody = "";
    } else {
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        responseBody = new TextDecoder().decode(buffer.slice(0, maxBytes));
        truncated = true;
      } else {
        responseBody = new TextDecoder().decode(buffer);
      }
    }

    return {
      success: response.ok,
      output: {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        body: responseBody,
        truncated,
        byteLength: method === "HEAD" ? 0 : responseBody.length,
      },
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      success: false,
      output: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    };
  }
}
