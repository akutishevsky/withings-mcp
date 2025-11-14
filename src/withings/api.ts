import { tokenStore } from "../auth/token-store.js";
import { refreshWithingsToken } from "../auth/oauth.js";
import { getOAuthConfig } from "../config.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "withings-api" });
const WITHINGS_API_BASE = "https://wbsapi.withings.net";

// Refresh tokens if they expire within this buffer (5 minutes)
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/**
 * Make an authenticated request to the Withings API
 * Automatically refreshes expired tokens
 */
export async function makeWithingsRequest(
  mcpToken: string,
  endpoint: string,
  action: string,
  additionalParams: Record<string, any> = {}
): Promise<any> {
  // Get Withings access token from MCP token
  let tokenData = await tokenStore.getTokens(mcpToken);
  if (!tokenData) {
    throw new Error("Invalid or expired token");
  }

  // Check if token is expired or about to expire
  const now = Date.now();
  const isExpiringSoon = tokenData.expiresAt - now < EXPIRY_BUFFER_MS;

  if (isExpiringSoon) {
    logger.info("Access token expired or expiring soon, refreshing");

    try {
      // Refresh the Withings token
      const config = getOAuthConfig();
      const refreshedTokens = await refreshWithingsToken(
        tokenData.withingsRefreshToken,
        config
      );

      // Update the stored tokens
      await tokenStore.updateTokens(mcpToken, {
        withingsAccessToken: refreshedTokens.accessToken,
        withingsRefreshToken: refreshedTokens.refreshToken,
        expiresAt: now + refreshedTokens.expiresIn * 1000,
      });

      // Get the updated token data
      tokenData = await tokenStore.getTokens(mcpToken);
      if (!tokenData) {
        throw new Error("Failed to retrieve updated tokens");
      }

      logger.info("Token refresh successful");
    } catch (error) {
      logger.error("Token refresh failed", { error: String(error) });
      throw new Error(`Failed to refresh access token: ${error}`);
    }
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
 * Get high-frequency sleep data with timestamps
 */
export async function getSleep(
  mcpToken: string,
  startDate: number,
  endDate: number,
  dataFields?: string
): Promise<any> {
  const params: Record<string, any> = {
    startdate: startDate,
    enddate: endDate,
  };

  if (dataFields) {
    params.data_fields = dataFields;
  }

  return await makeWithingsRequest(mcpToken, "/v2/sleep", "get", params);
}

/**
 * Get sleep summary data (aggregated metrics)
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

/**
 * Get measures (weight, height, blood pressure, heart rate, etc.)
 */
export async function getMeasures(
  mcpToken: string,
  meastype?: number,
  meastypes?: string,
  startdate?: number,
  enddate?: number,
  lastupdate?: number,
  offset?: number
): Promise<any> {
  const params: Record<string, any> = {};

  if (meastype !== undefined) {
    params.meastype = meastype;
  }

  if (meastypes) {
    params.meastypes = meastypes;
  }

  if (startdate !== undefined) {
    params.startdate = startdate;
  }

  if (enddate !== undefined) {
    params.enddate = enddate;
  }

  if (lastupdate !== undefined) {
    params.lastupdate = lastupdate;
  }

  if (offset !== undefined) {
    params.offset = offset;
  }

  return await makeWithingsRequest(mcpToken, "/measure", "getmeas", params);
}

/**
 * Get workout summaries
 */
export async function getWorkouts(
  mcpToken: string,
  startDateYmd?: string,
  endDateYmd?: string,
  lastUpdate?: number,
  offset?: number,
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

  if (offset !== undefined) {
    params.offset = offset;
  }

  if (dataFields) {
    params.data_fields = dataFields;
  }

  return await makeWithingsRequest(mcpToken, "/v2/measure", "getworkouts", params);
}

/**
 * Get daily aggregated activity data
 */
export async function getActivity(
  mcpToken: string,
  startDateYmd?: string,
  endDateYmd?: string,
  lastUpdate?: number,
  offset?: number,
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

  if (offset !== undefined) {
    params.offset = offset;
  }

  if (dataFields) {
    params.data_fields = dataFields;
  }

  return await makeWithingsRequest(mcpToken, "/v2/measure", "getactivity", params);
}

/**
 * Get high-frequency intraday activity data
 * Note: If startdate and enddate are separated by more than 24h, only the first 24h after startdate will be returned
 */
export async function getIntradayActivity(
  mcpToken: string,
  startDate?: number,
  endDate?: number,
  dataFields?: string
): Promise<any> {
  const params: Record<string, any> = {};

  if (startDate !== undefined) {
    params.startdate = startDate;
  }

  if (endDate !== undefined) {
    params.enddate = endDate;
  }

  if (dataFields) {
    params.data_fields = dataFields;
  }

  return await makeWithingsRequest(mcpToken, "/v2/measure", "getintradayactivity", params);
}

/**
 * Get list of user's linked devices
 */
export async function getUserDevices(mcpToken: string): Promise<any> {
  return await makeWithingsRequest(mcpToken, "/v2/user", "getdevice", {});
}

/**
 * Get user's goals
 */
export async function getUserGoals(mcpToken: string): Promise<any> {
  return await makeWithingsRequest(mcpToken, "/v2/user", "getgoals", {});
}

/**
 * List ECG records with Afib classification
 */
export async function listHeartRecords(
  mcpToken: string,
  startDate?: number,
  endDate?: number,
  offset?: number
): Promise<any> {
  const params: Record<string, any> = {};

  if (startDate !== undefined) {
    params.startdate = startDate;
  }

  if (endDate !== undefined) {
    params.enddate = endDate;
  }

  if (offset !== undefined) {
    params.offset = offset;
  }

  return await makeWithingsRequest(mcpToken, "/v2/heart", "list", params);
}

/**
 * Get detailed ECG signal data
 */
export async function getHeartSignal(
  mcpToken: string,
  signalId: string,
  withFiltered?: boolean,
  withIntervals?: boolean
): Promise<any> {
  const params: Record<string, any> = {
    signalid: signalId,
  };

  if (withFiltered !== undefined) {
    params.with_filtered = withFiltered;
  }

  if (withIntervals !== undefined) {
    params.with_intervals = withIntervals;
  }

  return await makeWithingsRequest(mcpToken, "/v2/heart", "get", params);
}

/**
 * List stethoscope recordings
 */
export async function listStethoRecords(
  mcpToken: string,
  startDate?: number,
  endDate?: number,
  offset?: number
): Promise<any> {
  const params: Record<string, any> = {};

  if (startDate !== undefined) {
    params.startdate = startDate;
  }

  if (endDate !== undefined) {
    params.enddate = endDate;
  }

  if (offset !== undefined) {
    params.offset = offset;
  }

  return await makeWithingsRequest(mcpToken, "/v2/stetho", "list", params);
}

/**
 * Get detailed stethoscope signal data
 */
export async function getStethoSignal(
  mcpToken: string,
  signalId: string
): Promise<any> {
  const params: Record<string, any> = {
    signalid: signalId,
  };

  return await makeWithingsRequest(mcpToken, "/v2/stetho", "get", params);
}
