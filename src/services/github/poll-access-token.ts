import consola from "consola"

import {
  GITHUB_BASE_URL,
  GITHUB_CLIENT_ID,
  standardHeaders,
} from "~/lib/api-config"
import { sleep } from "~/lib/utils"

import type { DeviceCodeResponse } from "./get-device-code"

export async function pollAccessToken(
  deviceCode: DeviceCodeResponse,
): Promise<string> {
  // Interval is in seconds, we need to multiply by 1000 to get milliseconds
  // I'm also adding another second, just to be safe
  const sleepDuration = (deviceCode.interval + 1) * 1000
  consola.debug(`Polling access token with interval of ${sleepDuration}ms`)

  while (true) {
    const response = await fetch(
      `${GITHUB_BASE_URL}/login/oauth/access_token`,
      {
        method: "POST",
        headers: standardHeaders(),
        body: JSON.stringify({
          client_id: GITHUB_CLIENT_ID,
          device_code: deviceCode.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
    )

    if (!response.ok) {
      await sleep(sleepDuration)
      consola.error("Failed to poll access token:", await response.text())

      continue
    }

    const json: unknown = await response.json()
    consola.debug("Polling access token response:", json)

    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      throw new Error(
        "Invalid GitHub access token response: expected an object.",
      )
    }
    const accessToken = "access_token" in json ? json.access_token : undefined
    if (accessToken !== undefined && typeof accessToken !== "string") {
      throw new Error(
        "Invalid GitHub access token response: access_token must be a string.",
      )
    }

    if (accessToken) {
      return accessToken
    } else {
      await sleep(sleepDuration)
    }
  }
}
