import { z } from "zod";
import { getMeasures, getWorkouts } from "../withings/api.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "tools:measure" });

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

const MEASURE_TYPES_DESCRIPTION = "1=Weight(kg), 4=Height(meter), 5=Fat Free Mass(kg), 6=Fat Ratio(%), 8=Fat Mass Weight(kg), 9=Diastolic Blood Pressure(mmHg), 10=Systolic Blood Pressure(mmHg), 11=Heart Pulse(bpm)-only for BPM and scale devices, 12=Temperature(celsius), 54=SP02(%), 71=Body Temperature(celsius), 73=Skin Temperature(celsius), 76=Muscle Mass(kg), 77=Hydration(kg), 88=Bone Mass(kg), 91=Pulse Wave Velocity(m/s), 123=VO2 max is a numerical measurement of your body's ability to consume oxygen(ml/min/kg), 130=Atrial fibrillation result, 135=QRS interval duration based on ECG signal, 136=PR interval duration based on ECG signal, 137=QT interval duration based on ECG signal, 138=Corrected QT interval duration based on ECG signal, 139=Atrial fibrillation result from PPG, 155=Vascular age, 167=Nerve Health Score Conductance 2 electrodes Feet, 168=Extracellular Water in kg, 169=Intracellular Water in kg, 170=Visceral Fat(without unity), 173=Fat Free Mass for segments, 174=Fat Mass for segments in mass unit, 175=Muscle Mass for segments, 196=Electrodermal activity feet, 226=Basal Metabolic Rate(BMR), 227=Metabolic Age, 229=Electrochemical Skin Conductance(ESC)";

export function registerMeasureTools(server: any, mcpAccessToken: string) {
  // Register get_measures tool
  server.registerTool(
    "get_measures",
    {
      description: "Get health measures including weight, height, body composition, blood pressure, heart rate, temperature, and more. Supports single or multiple measure types.",
      inputSchema: {
        meastype: z.number().optional().describe(`Single measure type ID. Available types: ${MEASURE_TYPES_DESCRIPTION}`),
        meastypes: z.string().optional().describe(`Comma-separated list of measure type IDs (e.g., '1,9,10' for weight and blood pressure). Available types: ${MEASURE_TYPES_DESCRIPTION}`),
        startdate: z.number().optional().describe("Start date as Unix timestamp"),
        enddate: z.number().optional().describe("End date as Unix timestamp"),
        lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated/created after this date. Use for synchronization instead of startdate/enddate"),
        offset: z.number().optional().describe("Pagination offset. Use value from previous response when more=1"),
      },
    },
    async (args: any) => {
      logger.info("Tool invoked: get_measures");
      try {
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
        if (measures?.measuregrps) {
          measures.measuregrps = measures.measuregrps.map((grp: any) => {
            if (grp.measures) {
              grp.measures = grp.measures.map((measure: any) => {
                const calculatedValue = measure.value * Math.pow(10, measure.unit);
                return {
                  ...measure,
                  type_description: MEASURE_TYPE_MAP[measure.type] || `Unknown type ${measure.type}`,
                  calculated_value: calculatedValue,
                };
              });
            }
            return grp;
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(measures, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_measures");
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Register get_workouts tool
  server.registerTool(
    "get_workouts",
    {
      description: "Get workout summaries including calories burned, heart rate data, distance, steps, elevation, and swimming metrics. Returns aggregated data for each workout session. By default returns ALL available data fields.",
      inputSchema: {
        startdateymd: z.string().optional().describe("Start date in YYYY-MM-DD format (e.g., '2024-01-15'). Required if lastupdate not provided."),
        enddateymd: z.string().optional().describe("End date in YYYY-MM-DD format (e.g., '2024-01-20'). Required if startdateymd is provided."),
        lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated or created after this date. Use this instead of date range for synchronization."),
        offset: z.number().optional().describe("Pagination offset. Use value from previous response when more=true"),
        data_fields: z.string().optional().default("calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation,pool_laps,strokes,pool_length").describe("Comma-separated list of data fields to return. Available fields: calories=Active calories(Kcal), intensity=Workout intensity(0-100), manual_distance=User-entered distance(m), manual_calories=User-entered calories(Kcal), hr_average=Average heart rate(bpm), hr_min=Min heart rate(bpm), hr_max=Max heart rate(bpm), hr_zone_0=Light zone duration(sec), hr_zone_1=Moderate zone duration(sec), hr_zone_2=Intense zone duration(sec), hr_zone_3=Maximal zone duration(sec), pause_duration=User pause time(sec), algo_pause_duration=Device-detected pause time(sec), spo2_average=Average SpO2(%), steps=Step count, distance=Distance(m), elevation=Floors climbed, pool_laps=Pool lap count, strokes=Stroke count, pool_length=Pool length(m). Defaults to all fields."),
      },
    },
    async (args: any) => {
      logger.info("Tool invoked: get_workouts");
      try {
        const workouts = await getWorkouts(
          mcpAccessToken,
          args.startdateymd,
          args.enddateymd,
          args.lastupdate,
          args.offset,
          args.data_fields
        );

        // Remove category field from each workout in the series
        if (workouts?.series) {
          workouts.series = workouts.series.map((workout: any) => {
            const { category, ...rest } = workout;
            return rest;
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(workouts, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_workouts");
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
