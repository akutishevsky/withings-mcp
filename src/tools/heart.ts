import { z } from "zod";
import { listHeartRecords, getHeartSignal } from "../withings/api.js";
import { addReadableTimestamps } from "../utils/timestamp.js";
import { withAnalytics, TOOL_ANNOTATIONS, toolResponse } from "./index.js";

export function registerHeartTools(server: any, mcpAccessToken: string) {
  // Register list_heart_records tool
  server.registerTool(
    "list_heart_records",
    {
      title: "Heart Records",
      description:
        "Get a list of ECG (electrocardiogram) records with Afib (atrial fibrillation) classification for a given time period. Returns ECG metadata including signal IDs, timestamps, heart rate, Afib detection results, and blood pressure measurements (if taken with BPM Core). Use the signal ID from this list with get_heart_signal to retrieve the full ECG waveform data. IMPORTANT: Before executing this tool, if the user's request references relative dates (like 'today', 'yesterday', 'last week', 'this month'), check if there is a date/time MCP tool available to detect the current date and time first.",
      inputSchema: {
        startdate: z
          .string()
          .optional()
          .describe(
            "Start date in YYYY-MM-DD format (e.g., '2025-11-01'). The date represents midnight UTC of that day."
          ),
        enddate: z
          .string()
          .optional()
          .describe(
            "End date in YYYY-MM-DD format (e.g., '2025-11-30')."
          ),
        offset: z
          .number()
          .optional()
          .describe(
            "Pagination offset. Use value from previous response when more=true"
          ),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (args: any) => {
      return withAnalytics(
        "list_heart_records",
        async () => {
          const records = await listHeartRecords(
            mcpAccessToken,
            args.startdate,
            args.enddate,
            args.offset
          );

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(records);

          return toolResponse(processedData);
        },
        { mcpAccessToken },
        args
      );
    }
  );

  // Register get_heart_signal tool
  server.registerTool(
    "get_heart_signal",
    {
      title: "ECG Signal",
      description:
        "Get detailed ECG (electrocardiogram) signal data in micro-volts (μV) for a specific recording. Returns high-frequency waveform data with sampling information. Recording duration: BPM Core (20s), Move ECG/ScanWatch (30s). Sampling frequency: BPM Core (500 Hz), Move ECG/ScanWatch (300 Hz). First use list_heart_records to get the signal ID.",
      inputSchema: {
        signalid: z
          .string()
          .describe(
            "ID of the ECG signal to retrieve. Obtain this from list_heart_records response."
          ),
        with_filtered: z
          .boolean()
          .optional()
          .describe(
            "Request filtered version of the signal. Optional, defaults to false."
          ),
        with_intervals: z
          .boolean()
          .optional()
          .describe(
            "Request features with inactive ones. Optional, defaults to false."
          ),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (args: any) => {
      return withAnalytics(
        "get_heart_signal",
        async () => {
          const signal = await getHeartSignal(
            mcpAccessToken,
            args.signalid,
            args.with_filtered,
            args.with_intervals
          );

          return toolResponse(signal);
        },
        { mcpAccessToken }
      );
    }
  );
}
