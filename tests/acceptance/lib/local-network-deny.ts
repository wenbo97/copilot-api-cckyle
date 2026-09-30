const originalFetch = globalThis.fetch
globalThis.fetch = Object.assign(
  (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const loopback = ["[::1]", "127.0.0.1", "localhost"].includes(url.hostname)
    if (!loopback || ["18774", "4141", "4142", "4143"].includes(url.port))
      return Promise.reject(
        new Error("External network disabled for offline acceptance"),
      )
    return originalFetch(input, init)
  },
  { preconnect: () => {} },
)
