import { expect, test } from "bun:test"

test("production listener owns streaming timeout and cancellation lifecycle over sockets", async () => {
  const child = Bun.spawn(
    [process.execPath, "tests/fixtures/streaming-socket.ts"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const output = new Response(child.stdout).text()
  const errors = new Response(child.stderr).text()
  const deadline = setTimeout(() => child.kill(), 40_000)
  try {
    const code = await child.exited
    expect({ code, output: await output, errors: await errors }).toMatchObject({
      code: 0,
    })
  } finally {
    clearTimeout(deadline)
    child.kill()
  }
}, 45_000)
