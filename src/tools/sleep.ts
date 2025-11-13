import { z } from "zod";
import { getSleep, getSleepSummary } from "../withings/api.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "tools:sleep" });

// Output schema for Sleep v2 - Get (high-frequency data)
const sleepDataOutputSchema = z.object({
  series: z.object({
    startdate: z.number().describe("Unix timestamp of sleep period start"),
    enddate: z.number().describe("Unix timestamp of sleep period end"),
    state: z.number().describe("Sleep state indicator"),
    model: z.string().describe("Device model name"),
    model_id: z.number().describe("Device model ID"),
    hr: z
      .record(z.number())
      .optional()
      .describe("Heart rate data (bpm) keyed by Unix timestamp"),
    rr: z
      .record(z.number())
      .optional()
      .describe("Respiration rate data (breaths/min) keyed by Unix timestamp"),
    snoring: z
      .record(z.number())
      .optional()
      .describe("Snoring data (seconds) keyed by Unix timestamp"),
    sdnn_1: z
      .record(z.number())
      .optional()
      .describe("HRV SDNN data (ms) keyed by Unix timestamp"),
    rmssd: z
      .record(z.number())
      .optional()
      .describe("HRV RMSSD data (ms) keyed by Unix timestamp"),
    hrv_quality: z
      .record(z.number())
      .optional()
      .describe("HRV quality score keyed by Unix timestamp"),
    mvt_score: z
      .record(z.number())
      .optional()
      .describe("Movement intensity (0-255) keyed by Unix timestamp"),
    chest_movement_rate: z
      .record(z.number())
      .optional()
      .describe("Chest movement rate (events/min) keyed by Unix timestamp"),
    withings_index: z
      .record(z.number())
      .optional()
      .describe("Breathing events per hour keyed by Unix timestamp"),
    breathing_sounds: z
      .record(z.number())
      .optional()
      .describe("Breathing sounds tracked (seconds) keyed by Unix timestamp"),
  }),
});

// Output schema for Sleep v2 - Getsummary (aggregated summaries)
const sleepSummaryOutputSchema = z.object({
  series: z.array(
    z.object({
      timezone: z.string().describe("Timezone of the sleep session"),
      model: z.number().describe("Device model identifier"),
      model_id: z.number().describe("Device model ID"),
      startdate: z.number().describe("Unix timestamp of sleep start"),
      enddate: z.number().describe("Unix timestamp of sleep end"),
      date: z.string().describe("Date in YYYY-MM-DD format"),
      created: z.number().describe("Unix timestamp when record was created"),
      modified: z
        .number()
        .describe("Unix timestamp when record was last modified"),
      data: z
        .object({
          // Sleep Duration & Stages
          total_timeinbed: z
            .number()
            .optional()
            .describe("Total time in bed (seconds)"),
          total_sleep_time: z
            .number()
            .optional()
            .describe("Total sleep time = light+deep+rem (seconds)"),
          asleepduration: z
            .number()
            .optional()
            .describe("Sleep duration from external source (seconds)"),
          lightsleepduration: z
            .number()
            .optional()
            .describe("Light sleep duration (seconds)"),
          remsleepduration: z
            .number()
            .optional()
            .describe("REM sleep duration (seconds)"),
          deepsleepduration: z
            .number()
            .optional()
            .describe("Deep sleep duration (seconds)"),

          // Sleep Quality
          sleep_efficiency: z
            .number()
            .optional()
            .describe("Ratio of sleep time / time in bed"),
          sleep_latency: z
            .number()
            .optional()
            .describe("Time to fall asleep (seconds)"),
          wakeup_latency: z
            .number()
            .optional()
            .describe("Time in bed after waking (seconds)"),
          wakeupduration: z
            .number()
            .optional()
            .describe("Time spent awake (seconds)"),
          wakeupcount: z
            .number()
            .optional()
            .describe("Number of times woke up"),
          waso: z
            .number()
            .optional()
            .describe("Wake after sleep onset (seconds)"),
          nb_rem_episodes: z
            .number()
            .optional()
            .describe("Count of REM sleep phases"),
          out_of_bed_count: z
            .number()
            .optional()
            .describe("Times got out of bed"),

          // Heart & Respiration
          hr_average: z
            .number()
            .optional()
            .describe("Average heart rate (bpm)"),
          hr_min: z.number().optional().describe("Minimum heart rate (bpm)"),
          hr_max: z.number().optional().describe("Maximum heart rate (bpm)"),
          rr_average: z
            .number()
            .optional()
            .describe("Average respiration rate (breaths/min)"),
          rr_min: z
            .number()
            .optional()
            .describe("Minimum respiration rate (breaths/min)"),
          rr_max: z
            .number()
            .optional()
            .describe("Maximum respiration rate (breaths/min)"),
          rmssd_start_avg: z
            .number()
            .optional()
            .describe("HRV start average (ms)"),
          rmssd_end_avg: z.number().optional().describe("HRV end average (ms)"),

          // Breathing & Apnea
          breathing_disturbances_intensity: z
            .number()
            .optional()
            .describe("Breathing disturbances intensity"),
          breathing_quality_assessment: z
            .number()
            .optional()
            .describe("Breathing quality score (wellness)"),
          apnea_hypopnea_index: z
            .number()
            .optional()
            .describe("Medical AHI (EU/AU devices)"),
          withings_index: z
            .number()
            .optional()
            .describe("Breathing events/hour (Sleep Rx)"),
          breathing_sounds: z
            .number()
            .optional()
            .describe("Breathing sounds tracked (seconds)"),
          breathing_sounds_episode_count: z
            .number()
            .optional()
            .describe("Breathing sound episodes count"),
          chest_movement_rate_average: z
            .number()
            .optional()
            .describe("Average chest movement rate (events/min)"),
          chest_movement_rate_min: z
            .number()
            .optional()
            .describe("Minimum chest movement rate (events/min)"),
          chest_movement_rate_max: z
            .number()
            .optional()
            .describe("Maximum chest movement rate (events/min)"),
          chest_movement_rate_wellness_average: z
            .number()
            .optional()
            .describe("Average chest movement wellness rate (breaths/min)"),
          chest_movement_rate_wellness_min: z
            .number()
            .optional()
            .describe("Minimum chest movement wellness rate (breaths/min)"),
          chest_movement_rate_wellness_max: z
            .number()
            .optional()
            .describe("Maximum chest movement wellness rate (breaths/min)"),

          // Snoring
          snoring: z
            .number()
            .optional()
            .describe("Total snoring time (seconds)"),
          snoringepisodecount: z
            .number()
            .optional()
            .describe("Snoring episodes ≥1min"),

          // Movement
          mvt_score_avg: z
            .number()
            .optional()
            .describe("Average movement score 0-255 (Sleep Analyzer)"),
          mvt_active_duration: z
            .number()
            .optional()
            .describe("Active movement duration (seconds)"),

          // Score & Events
          sleep_score: z.number().optional().describe("Overall sleep score"),
          night_events: z
            .array(z.any())
            .optional()
            .describe("Sleep events with timestamps"),

          // Deprecated fields
          durationtosleep: z
            .number()
            .optional()
            .describe("Time to sleep (deprecated)"),
          durationtowakeup: z
            .number()
            .optional()
            .describe("Time to wake up (deprecated)"),
        })
        .passthrough(), // Allow additional fields not explicitly defined
    })
  ),
  more: z.boolean().describe("Whether more results are available"),
  offset: z.number().describe("Offset for pagination"),
});

export function registerSleepTools(server: any, mcpAccessToken: string) {
  // Sleep v2 - Get: High-frequency sleep data with timestamps
  server.registerTool(
    "get_sleep",
    {
      description:
        "Get high-frequency sleep data captured during sleep, including sleep stages and health metrics at minute-level resolution. Use this for detailed analysis of sleep patterns. For aggregated summaries, use get_sleep_summary instead. Note: If startdate and enddate are separated by more than 24h, only the first 24h after startdate will be returned.",
      inputSchema: {
        startdate: z
          .number()
          .describe("Sleep period start date as Unix timestamp (required)."),
        enddate: z
          .number()
          .describe("Sleep period end date as Unix timestamp (required)."),
        data_fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of data fields to return. Available fields: 'hr' (heart rate bpm), 'rr' (respiration rate breaths/min), 'snoring' (total snoring seconds), 'sdnn_1' (HRV standard deviation ms), 'rmssd' (HRV root mean square ms), 'hrv_quality' (HRV quality score), 'mvt_score' (movement intensity 0-255, Sleep Analyzer only), 'chest_movement_rate' (events/min), 'withings_index' (breathing events/hour for Sleep Rx), 'breathing_sounds' (breathing sounds tracked in seconds). If not specified, all available fields are returned."
          ),
      },
      outputSchema: sleepDataOutputSchema,
    },
    async (args: any) => {
      logger.info("Tool invoked: get_sleep");
      try {
        const sleepData = await getSleep(
          mcpAccessToken,
          args.startdate,
          args.enddate,
          args.data_fields
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sleepData, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_sleep");
        return {
          content: [
            {
              type: "text",
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Sleep v2 - Getsummary: Aggregated sleep summaries
  server.registerTool(
    "get_sleep_summary",
    {
      description:
        "Get aggregated sleep activity summaries for specified date range. Returns comprehensive sleep metrics including duration, stages, quality scores, heart rate, breathing analysis, and sleep apnea indicators. Use this for daily/weekly sleep reports. For detailed minute-by-minute data, use get_sleep instead.",
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
            "Unix timestamp for requesting data updated or created after this date. Use this instead of date range for synchronization."
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
      outputSchema: sleepSummaryOutputSchema,
    },
    async (args: any) => {
      logger.info("Tool invoked: get_sleep_summary");
      try {
        const sleepData = await getSleepSummary(
          mcpAccessToken,
          args.startdateymd,
          args.enddateymd,
          args.lastupdate,
          args.data_fields
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sleepData, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_sleep_summary");
        return {
          content: [
            {
              type: "text",
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
