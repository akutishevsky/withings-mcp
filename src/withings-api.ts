import { tokenStore } from "./token-store.js";

const WITHINGS_API_BASE = "https://wbsapi.withings.net";

/**
 * Make an authenticated request to the Withings API
 */
export async function makeWithingsRequest(
  mcpToken: string,
  endpoint: string,
  action: string,
  additionalParams: Record<string, any> = {}
): Promise<any> {
  // Get Withings access token from MCP token
  const tokenData = await tokenStore.getTokens(mcpToken);
  if (!tokenData) {
    throw new Error("Invalid or expired token");
  }

  // Build request parameters
  const params = new URLSearchParams({
    action,
    ...additionalParams,
  });

  // Make request to Withings API
  const response = await fetch(`${WITHINGS_API_BASE}${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${tokenData.withingsAccessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  const data = await response.json();

  // Check Withings API status
  if (data.status !== 0) {
    const errorMessages: Record<number, string> = {
      100: "The hash is missing, invalid, or does not match the provided email",
      247: "The userid is either absent or invalid",
      250: "The provided userid and/or Oauth credentials do not match",
      286: "No such subscription was found",
      293: "The callback URL is either absent or incorrect",
      294: "No such subscription could be deleted",
      304: "The comment is either invalid or larger than 255 characters",
      305: "Too many notifications are already set",
      328: "The user is deactivated",
      342: "The signature (using Oauth) is invalid",
      343: "Wrong Notification Callback Url doesn't exist",
      601: "Too Many Requests",
      2554: "Unknown action",
      2555: "An unknown error occurred",
    };

    const errorMsg = errorMessages[data.status] || `Withings API error: ${data.status}`;
    throw new Error(errorMsg);
  }

  return data.body;
}

/**
 * Get sleep summary data
 */
export async function getSleepSummary(
  mcpToken: string,
  startDateYmd?: string,
  endDateYmd?: string,
  lastUpdate?: number,
  dataFields?: string
): Promise<any> {
  const params: Record<string, any> = {};

  if (lastUpdate) {
    params.lastupdate = lastUpdate;
  } else if (startDateYmd && endDateYmd) {
    params.startdateymd = startDateYmd;
    params.enddateymd = endDateYmd;
  } else {
    throw new Error("Either lastupdate or both startdateymd and enddateymd are required");
  }

  if (dataFields) {
    params.data_fields = dataFields;
  }

  return await makeWithingsRequest(mcpToken, "/v2/sleep", "getsummary", params);
}
