/**
 * Type definitions for Withings API integration.
 * Centralizes type aliases and response interfaces for API data structures.
 */

/** Parameters for Withings API requests (mixed string/number/boolean values) */
// deno-lint-ignore no-explicit-any
export type ApiParams = Record<string, any>;

// --- Sleep ---

export interface SleepSeries {
  startdate: number;
  enddate: number;
  state: number;
  hr?: Record<string, number>;
  rr?: Record<string, number>;
  snoring?: Record<string, number>;
  [key: string]: unknown;
}

export interface SleepGetResponse {
  series: SleepSeries[];
  [key: string]: unknown;
}

export interface SleepSummary {
  startdate: number;
  enddate: number;
  date: string;
  timezone: string;
  night_events?: Record<string, number[]>;
  [key: string]: unknown;
}

export interface SleepSummaryResponse {
  series: SleepSummary[];
  more: boolean;
  offset: number;
  [key: string]: unknown;
}

// --- Measures ---

export interface Measure {
  value: number;
  type: number;
  unit: number;
  algo?: number;
  fm?: number;
  [key: string]: unknown;
}

export interface MeasureGroup {
  grpid: number;
  created: number;
  date: number;
  measures: Measure[];
  [key: string]: unknown;
}

export interface MeasuresResponse {
  updatetime: number;
  timezone: string;
  measuregrps: MeasureGroup[];
  more?: number;
  offset?: number;
  [key: string]: unknown;
}

// --- Workouts ---

export interface Workout {
  id: number;
  category: number | string;
  model: number | string;
  startdate: number;
  enddate: number;
  timezone: string;
  data?: Record<string, number>;
  [key: string]: unknown;
}

export interface WorkoutsResponse {
  series: Workout[];
  more: boolean;
  offset: number;
  [key: string]: unknown;
}

// --- Activity ---

export interface ActivityDay {
  date: string;
  timezone: string;
  steps?: number;
  distance?: number;
  [key: string]: unknown;
}

export interface ActivityResponse {
  activities: ActivityDay[];
  more: boolean;
  offset: number;
  [key: string]: unknown;
}

// --- Intraday Activity ---

export interface IntradayActivityResponse {
  series: Record<string, Record<string, number>>;
  [key: string]: unknown;
}

// --- User ---

export interface Device {
  type: string;
  model: string;
  battery: string;
  deviceid: string;
  timezone: string;
  [key: string]: unknown;
}

export interface DevicesResponse {
  devices: Device[];
  [key: string]: unknown;
}

export interface GoalsResponse {
  steps: { value: number };
  sleep: { value: number };
  weight: { value: number; unit: number };
  [key: string]: unknown;
}

// --- Heart ---

export interface HeartRecord {
  signalid: number;
  timestamp: number;
  ecg?: object;
  bloodpressure?: object;
  [key: string]: unknown;
}

export interface HeartListResponse {
  series: HeartRecord[];
  more: number;
  offset: number;
  [key: string]: unknown;
}

export interface HeartSignalResponse {
  signal: number[];
  sampling_frequency: number;
  wearposition: number;
  [key: string]: unknown;
}

// --- Stetho ---

export interface StethoRecord {
  signalid: number;
  timestamp: number;
  deviceid: string;
  [key: string]: unknown;
}

export interface StethoListResponse {
  series: StethoRecord[];
  more: number;
  offset: number;
  [key: string]: unknown;
}

export interface StethoSignalResponse {
  signal: number[];
  frequency: number;
  duration: number;
  [key: string]: unknown;
}
