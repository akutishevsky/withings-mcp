import { z } from "zod";
import { getSleep, getSleepSummary } from "../withings/api.js";
import {
  addReadableTimestamps,
  addReadableNightEvents,
} from "../utils/timestamp.js";
import { withAnalytics, TOOL_ANNOTATIONS, toolResponse } from "./index.js";

export function registerSleepTools(server: any, mcpAccessToken: string) {
  // Sleep v2 - Get: High-frequency sleep data with timestamps
  server.registerTool(
    "get_sleep",
    {
      title: "Sleep Data",
      description:
        "Get high-frequency sleep data captured during sleep, including sleep stages and health metrics at minute-level resolution. Use this for detailed analysis of sleep patterns. For aggregated summaries, use get_sleep_summary instead. Note: If startdate and enddate are separated by more than 24h, only the first 24h after startdate will be returned. IMPORTANT: Before executing this tool, if the user's request references relative dates (like 'today', 'yesterday', 'last week', 'this month'), check if there is a date/time MCP tool available to detect the current date and time first.",
      inputSchema: {
        startdate: z
          .string()
          .describe(
            "Sleep period start date in YYYY-MM-DD format (e.g., '2025-11-17'). The date represents midnight UTC of that day."
          ),
        enddate: z
          .string()
          .describe(
            "Sleep period end date in YYYY-MM-DD format (e.g., '2025-11-18'). Note: Maximum 24h range from startdate."
          ),
        data_fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of data fields to return. Available fields: 'hr' (heart rate bpm), 'rr' (respiration rate breaths/min), 'snoring' (total snoring seconds), 'sdnn_1' (HRV standard deviation ms), 'rmssd' (HRV root mean square ms), 'hrv_quality' (HRV quality score), 'mvt_score' (movement intensity 0-255, Sleep Analyzer only), 'chest_movement_rate' (events/min), 'withings_index' (breathing events/hour for Sleep Rx), 'breathing_sounds' (breathing sounds tracked in seconds). If not specified, all available fields are returned."
          ),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (args: any) => {
      return withAnalytics(
        "get_sleep",
        async () => {
          const sleepData = await getSleep(
            mcpAccessToken,
            args.startdate,
            args.enddate,
            args.data_fields
          );

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(sleepData);

          return toolResponse(processedData);
        },
        { mcpAccessToken },
        args
      );
    }
  );

  // Sleep v2 - Getsummary: Aggregated sleep summaries
  server.registerTool(
    "get_sleep_summary",
    {
      title: "Sleep Summary",
      description:
        "Get aggregated sleep activity summaries for specified date range. Returns comprehensive sleep metrics including duration, stages, quality scores, heart rate, breathing analysis, and sleep apnea indicators. Use this for daily/weekly sleep reports. For detailed minute-by-minute data, use get_sleep instead. IMPORTANT: Before executing this tool, if the user's request references relative dates (like 'today', 'yesterday', 'last week', 'this month'), check if there is a date/time MCP tool available to detect the current date and time first.",
      inputSchema: {
        startdateymd: z
          .string()
          .optional()
          .describe(
            "Start date in YYYY-MM-DD format (e.g., '2024-01-15'). Required if lastupdate not provided."
          ),
        enddateymd: z
          .string()
          .optional()
          .describe(
            "End date in YYYY-MM-DD format (e.g., '2024-01-20'). Required if startdateymd is provided."
          ),
        lastupdate: z
          .number()
          .optional()
          .describe(
            "Unix timestamp (seconds since epoch) for requesting data updated or created after this date. Use this instead of date range for synchronization. IMPORTANT: Convert dates carefully."
          ),
        data_fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of data fields to return. Available fields include:\n" +
              "**Sleep Duration & Stages**: 'total_timeinbed' (total seconds in bed), 'total_sleep_time' (total asleep seconds = light+deep+rem), 'asleepduration' (when from external source), 'lightsleepduration', 'remsleepduration', 'deepsleepduration'.\n" +
              "**Sleep Quality**: 'sleep_efficiency' (ratio of sleep time/time in bed), 'sleep_latency' (seconds to fall asleep), 'wakeup_latency' (seconds in bed after waking), 'wakeupduration' (seconds awake), 'wakeupcount' (times woke up), 'waso' (wake after sleep onset seconds), 'nb_rem_episodes' (REM phase count), 'out_of_bed_count'.\n" +
              "**Heart & Respiration**: 'hr_average', 'hr_min', 'hr_max' (heart rate bpm), 'rr_average', 'rr_min', 'rr_max' (respiration breaths/min), 'rmssd_start_avg', 'rmssd_end_avg' (HRV ms).\n" +
              "**Breathing & Apnea**: 'breathing_disturbances_intensity', 'breathing_quality_assessment' (wellness metrics for all Sleep devices), 'apnea_hypopnea_index' (medical AHI for EU/AU devices with apnea detection), 'withings_index' (breathing events/hour for Sleep Rx: 0-15=No/Mild, 15-30=Moderate, >30=Severe, requires 5h sleep), 'breathing_sounds' (seconds tracked), 'breathing_sounds_episode_count', 'chest_movement_rate_average', 'chest_movement_rate_min', 'chest_movement_rate_max', 'chest_movement_rate_wellness_average', 'chest_movement_rate_wellness_min', 'chest_movement_rate_wellness_max'.\n" +
              "**Snoring**: 'snoring' (total seconds), 'snoringepisodecount' (episodes ≥1min).\n" +
              "**Movement**: 'mvt_score_avg' (0-255, Sleep Analyzer EU/Sleep Rx US only), 'mvt_active_duration' (seconds).\n" +
              "**Score & Events**: 'sleep_score', 'night_events' (dictionary of event types with timestamps: 1=got in bed, 2=fell asleep, 3=woke up, 4=got out of bed, 5=manual asleep period, 6=manual awake period).\n" +
              "If not specified, all available fields are returned."
          ),
      },
      annotations: TOOL_ANNOTATIONS,
    },
    async (args: any) => {
      return withAnalytics(
        "get_sleep_summary",
        async () => {
          const sleepData = await getSleepSummary(
            mcpAccessToken,
            args.startdateymd,
            args.enddateymd,
            args.lastupdate,
            args.data_fields
          );

          // Add readable datetime fields for timestamps
          let processedData = addReadableTimestamps(sleepData);

          // Process each sleep summary for night_events timestamps
          if (processedData?.series) {
            processedData.series = processedData.series.map(
              (sleepSummary: any) => addReadableNightEvents(sleepSummary)
            );
          }

          return toolResponse(processedData);
        },
        { mcpAccessToken },
        args
      );
    }
  );
}
