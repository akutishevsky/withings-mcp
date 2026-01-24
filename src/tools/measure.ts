import { z } from "zod";
import {
  getMeasures,
  getWorkouts,
  getActivity,
  getIntradayActivity,
} from "../withings/api.js";
import { addReadableTimestamps } from "../utils/timestamp.js";
import { withAnalytics } from "./index.js";

// Map of measure type IDs to descriptions
const MEASURE_TYPE_MAP: Record<number, string> = {
  1: "Weight (kg)",
  4: "Height (meter)",
  5: "Fat Free Mass (kg)",
  6: "Fat Ratio (%)",
  8: "Fat Mass Weight (kg)",
  9: "Diastolic Blood Pressure (mmHg)",
  10: "Systolic Blood Pressure (mmHg)",
  11: "Heart Pulse (bpm) - only for BPM and scale devices",
  12: "Temperature (celsius)",
  54: "SP02 (%)",
  71: "Body Temperature (celsius)",
  73: "Skin Temperature (celsius)",
  76: "Muscle Mass (kg)",
  77: "Hydration (kg)",
  88: "Bone Mass (kg)",
  91: "Pulse Wave Velocity (m/s)",
  123: "VO2 max is a numerical measurement of your body's ability to consume oxygen (ml/min/kg)",
  130: "Atrial fibrillation result",
  135: "QRS interval duration based on ECG signal",
  136: "PR interval duration based on ECG signal",
  137: "QT interval duration based on ECG signal",
  138: "Corrected QT interval duration based on ECG signal",
  139: "Atrial fibrillation result from PPG",
  155: "Vascular age",
  167: "Nerve Health Score Conductance 2 electrodes Feet",
  168: "Extracellular Water in kg",
  169: "Intracellular Water in kg",
  170: "Visceral Fat (without unity)",
  173: "Fat Free Mass for segments",
  174: "Fat Mass for segments in mass unit",
  175: "Muscle Mass for segments",
  196: "Electrodermal activity feet",
  226: "Basal Metabolic Rate (BMR)",
  227: "Metabolic Age",
  229: "Electrochemical Skin Conductance (ESC)",
};

const MEASURE_TYPES_DESCRIPTION =
  "1=Weight(kg), 4=Height(meter), 5=Fat Free Mass(kg), 6=Fat Ratio(%), 8=Fat Mass Weight(kg), 9=Diastolic Blood Pressure(mmHg), 10=Systolic Blood Pressure(mmHg), 11=Heart Pulse(bpm)-only for BPM and scale devices, 12=Temperature(celsius), 54=SP02(%), 71=Body Temperature(celsius), 73=Skin Temperature(celsius), 76=Muscle Mass(kg), 77=Hydration(kg), 88=Bone Mass(kg), 91=Pulse Wave Velocity(m/s), 123=VO2 max is a numerical measurement of your body's ability to consume oxygen(ml/min/kg), 130=Atrial fibrillation result, 135=QRS interval duration based on ECG signal, 136=PR interval duration based on ECG signal, 137=QT interval duration based on ECG signal, 138=Corrected QT interval duration based on ECG signal, 139=Atrial fibrillation result from PPG, 155=Vascular age, 167=Nerve Health Score Conductance 2 electrodes Feet, 168=Extracellular Water in kg, 169=Intracellular Water in kg, 170=Visceral Fat(without unity), 173=Fat Free Mass for segments, 174=Fat Mass for segments in mass unit, 175=Muscle Mass for segments, 196=Electrodermal activity feet, 226=Basal Metabolic Rate(BMR), 227=Metabolic Age, 229=Electrochemical Skin Conductance(ESC)";

// Map of workout category IDs to descriptions
const WORKOUT_CATEGORY_MAP: Record<number, string> = {
  1: "Walk",
  2: "Run",
  3: "Hiking",
  4: "Skating",
  5: "BMX",
  6: "Bicycling",
  7: "Swimming",
  8: "Surfing",
  9: "Kitesurfing",
  10: "Windsurfing",
  11: "Bodyboard",
  12: "Tennis",
  13: "Table tennis",
  14: "Squash",
  15: "Badminton",
  16: "Lift weights",
  17: "Fitness",
  18: "Elliptical",
  19: "Pilates",
  20: "Basket-ball",
  21: "Soccer",
  22: "Football",
  23: "Rugby",
  24: "Volley-ball",
  25: "Waterpolo",
  26: "Horse riding",
  27: "Golf",
  28: "Yoga",
  29: "Dancing",
  30: "Boxing",
  31: "Fencing",
  32: "Wrestling",
  33: "Martial arts",
  34: "Skiing",
  35: "Snowboarding",
  36: "Other",
  128: "No activity",
  187: "Rowing",
  188: "Zumba",
  191: "Baseball",
  192: "Handball",
  193: "Hockey",
  194: "Ice hockey",
  195: "Climbing",
  196: "Ice skating",
  272: "Multi-sport",
  306: "Indoor walk",
  307: "Indoor running",
  308: "Indoor cycling",
};

// Map of device model IDs to device names
const DEVICE_MODEL_MAP: Record<number, string> = {
  1: "Withings WBS01",
  2: "Withings WBS03",
  3: "Kid Scale",
  4: "Withings WBS02",
  5: "Body+",
  6: "Body Cardio",
  7: "Body",
  13: "Body+",
  21: "Smart Baby Monitor",
  22: "Withings Home",
  41: "Withings Blood Pressure V1",
  42: "Withings Blood Pressure V2",
  43: "Withings Blood Pressure V3",
  44: "BPM Core",
  45: "BPM Connect",
  51: "Pulse",
  52: "Activite",
  53: "Activite (Pop, Steel)",
  54: "Withings Go",
  55: "Activite Steel HR",
  58: "Pulse HR",
  59: "Activite Steel HR Sport Edition",
  60: "Aura dock",
  61: "Aura sensor",
  62: "Aura dock",
  63: "Sleep sensor",
  70: "Thermo",
  91: "Move ECG",
  92: "Move ECG",
  1051: "iOS step tracker",
  1052: "iOS step tracker",
  1053: "Android step tracker",
  1054: "Android step tracker",
  1055: "GoogleFit tracker",
  1056: "Samsung Health tracker",
  1057: "HealthKit step iPhone tracker",
  1058: "HealthKit step Apple Watch tracker",
  1059: "HealthKit other step tracker",
  1060: "Android step tracker",
  1062: "Huawei tracker",
};

export function registerMeasureTools(server: any, mcpAccessToken: string) {
  // Register get_measures tool
  server.registerTool(
    "get_measures",
    {
      description:
        "Get health measures including weight, height, body composition, blood pressure, heart rate, temperature, and more. Supports single or multiple measure types. IMPORTANT: Before executing this tool, if the user's request references relative dates (like 'today', 'yesterday', 'last week', 'this month'), check if there is a date/time MCP tool available to detect the current date and time first.",
      inputSchema: {
        meastype: z
          .number()
          .optional()
          .describe(
            `Single measure type ID. Available types: ${MEASURE_TYPES_DESCRIPTION}`
          ),
        meastypes: z
          .string()
          .optional()
          .describe(
            `Comma-separated list of measure type IDs (e.g., '1,9,10' for weight and blood pressure). Available types: ${MEASURE_TYPES_DESCRIPTION}`
          ),
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
        lastupdate: z
          .number()
          .optional()
          .describe(
            "Unix timestamp for requesting data updated/created after this date. Use for synchronization instead of startdate/enddate"
          ),
        offset: z
          .number()
          .optional()
          .describe(
            "Pagination offset. Use value from previous response when more=1"
          ),
      },
    },
    async (args: any) => {
      return withAnalytics(
        "get_measures",
        async () => {
          const measures = await getMeasures(
            mcpAccessToken,
            args.meastype,
            args.meastypes,
            args.startdate,
            args.enddate,
            args.lastupdate,
            args.offset
          );

          // Add type descriptions and calculated values to each measure
          // Remove deprecated fields (algo, fm)
          if (measures?.measuregrps) {
            measures.measuregrps = measures.measuregrps.map((grp: any) => {
              if (grp.measures) {
                grp.measures = grp.measures.map((measure: any) => {
                  const calculatedValue =
                    measure.value * Math.pow(10, measure.unit);
                  // Destructure to remove deprecated fields
                  const { algo, fm, ...cleanMeasure } = measure;
                  return {
                    ...cleanMeasure,
                    type_description:
                      MEASURE_TYPE_MAP[measure.type] ||
                      `Unknown type ${measure.type}`,
                    calculated_value: calculatedValue,
                  };
                });
              }
              return grp;
            });
          }

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(measures);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(processedData, null, 2),
              },
            ],
          };
        },
        { mcpAccessToken },
        args
      );
    }
  );

  // Register get_workouts tool
  server.registerTool(
    "get_workouts",
    {
      description:
        "Get workout summaries including calories burned, heart rate data, distance, steps, elevation, and swimming metrics. Returns aggregated data for each workout session. By default returns ALL available data fields. IMPORTANT: Before executing this tool, if the user's request references relative dates (like 'today', 'yesterday', 'last week', 'this month'), check if there is a date/time MCP tool available to detect the current date and time first.",
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
        offset: z
          .number()
          .optional()
          .describe(
            "Pagination offset. Use value from previous response when more=true"
          ),
        data_fields: z
          .string()
          .optional()
          .default(
            "calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation,pool_laps,strokes,pool_length"
          )
          .describe(
            "Comma-separated list of data fields to return. Available fields: calories=Active calories(Kcal), intensity=Workout intensity(0-100), manual_distance=User-entered distance(m), manual_calories=User-entered calories(Kcal), hr_average=Average heart rate(bpm), hr_min=Min heart rate(bpm), hr_max=Max heart rate(bpm), hr_zone_0=Light zone duration(sec), hr_zone_1=Moderate zone duration(sec), hr_zone_2=Intense zone duration(sec), hr_zone_3=Maximal zone duration(sec), pause_duration=User pause time(sec), algo_pause_duration=Device-detected pause time(sec), spo2_average=Average SpO2(%), steps=Step count, distance=Distance(m), elevation=Floors climbed, pool_laps=Pool lap count, strokes=Stroke count, pool_length=Pool length(m). Defaults to all fields."
          ),
      },
    },
    async (args: any) => {
      return withAnalytics(
        "get_workouts",
        async () => {
          const workouts = await getWorkouts(
            mcpAccessToken,
            args.startdateymd,
            args.enddateymd,
            args.lastupdate,
            args.offset,
            args.data_fields
          );

          // Replace category and model field values with descriptions
          if (workouts?.series) {
            workouts.series = workouts.series.map((workout: any) => {
              const updatedWorkout = { ...workout };

              // Replace category ID with description
              if (typeof updatedWorkout.category === "number") {
                updatedWorkout.category =
                  WORKOUT_CATEGORY_MAP[updatedWorkout.category] ||
                  `Unknown category ${updatedWorkout.category}`;
              }

              // Replace model ID with device name
              if (typeof updatedWorkout.model === "number") {
                updatedWorkout.model =
                  DEVICE_MODEL_MAP[updatedWorkout.model] ||
                  `Unknown model ${updatedWorkout.model}`;
              }

              return updatedWorkout;
            });
          }

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(workouts);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(processedData, null, 2),
              },
            ],
          };
        },
        { mcpAccessToken },
        args
      );
    }
  );

  // Register get_activity tool
  server.registerTool(
    "get_activity",
    {
      description:
        "Get daily aggregated activity data including steps, distance, elevation, heart rate, calories, and activity durations (soft/moderate/intense). Returns summary data aggregated per day. IMPORTANT: Before executing this tool, if the user's request references relative dates (like 'today', 'yesterday', 'last week', 'this month'), check if there is a date/time MCP tool available to detect the current date and time first.",
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
        offset: z
          .number()
          .optional()
          .describe(
            "Pagination offset. Use value from previous response when more=true"
          ),
        data_fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of data fields to return. Available fields: steps=Number of steps, distance=Distance travelled(m), elevation=Floors climbed, soft=Soft activity duration(sec), moderate=Moderate activity duration(sec), intense=Intense activity duration(sec), active=Sum of intense and moderate durations(sec), calories=Active calories burned(Kcal), totalcalories=Total calories burned(Kcal), hr_average=Average heart rate(bpm), hr_min=Min heart rate(bpm), hr_max=Max heart rate(bpm), hr_zone_0=Light zone duration(sec), hr_zone_1=Moderate zone duration(sec), hr_zone_2=Intense zone duration(sec), hr_zone_3=Maximal zone duration(sec). If not specified, all fields are returned."
          ),
      },
    },
    async (args: any) => {
      return withAnalytics(
        "get_activity",
        async () => {
          const activity = await getActivity(
            mcpAccessToken,
            args.startdateymd,
            args.enddateymd,
            args.lastupdate,
            args.offset,
            args.data_fields
          );

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(activity);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(processedData, null, 2),
              },
            ],
          };
        },
        { mcpAccessToken },
        args
      );
    }
  );

  // Register get_intraday_activity tool
  server.registerTool(
    "get_intraday_activity",
    {
      description:
        "Get high-frequency intraday activity data captured throughout the day. Returns time-series data with timestamps. Note: If startdate and enddate are separated by more than 24h, only the first 24h after startdate will be returned. If no dates provided, returns most recent activity data. IMPORTANT: Before executing this tool, if the user's request references relative dates (like 'today', 'yesterday', 'last week', 'this month'), check if there is a date/time MCP tool available to detect the current date and time first.",
      inputSchema: {
        startdate: z
          .string()
          .optional()
          .describe(
            "Start date in YYYY-MM-DD format (e.g., '2025-11-17'). Optional - if not provided, returns most recent data. The date represents midnight UTC of that day."
          ),
        enddate: z
          .string()
          .optional()
          .describe(
            "End date in YYYY-MM-DD format (e.g., '2025-11-18'). Optional - if not provided, returns most recent data. Note: Maximum 24h range from startdate."
          ),
        data_fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of data fields to return. Available fields: steps=Number of steps, elevation=Floors climbed, calories=Active calories burned(Kcal), distance=Distance travelled(m), stroke=Number of strokes, pool_lap=Number of pool laps, duration=Activity duration(sec), heart_rate=Measured heart rate(bpm), spo2_auto=SpO2 percentage, rmssd=HRV-Root mean square of successive differences(ms), sdnn1=HRV-Standard deviation over 1 minute(ms), hrv_quality=HRV quality score. If not specified, all fields are returned."
          ),
      },
    },
    async (args: any) => {
      return withAnalytics(
        "get_intraday_activity",
        async () => {
          const intradayActivity = await getIntradayActivity(
            mcpAccessToken,
            args.startdate,
            args.enddate,
            args.data_fields
          );

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(intradayActivity);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(processedData, null, 2),
              },
            ],
          };
        },
        { mcpAccessToken },
        args
      );
    }
  );
}
