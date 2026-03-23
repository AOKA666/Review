export type QaPair = {
  id: string;
  question: string;
  answer: string;
  showAnswer: boolean;
  order_index: number;
};

export type LogItem = {
  id: string;
  text: string;
  order_index: number;
  reflection_qas: QaPair[];
};

export type TodayLog = {
  red: LogItem[];
  black: LogItem[];
};

export type ReflectionFields = {
  qas: QaPair[];
  // Legacy fields kept optional for backward compatibility.
  whatHappened?: string;
  why?: string;
  optimization?: string;
};

export type ReviewRecord = {
  id: string;
  date: string;
  created_at: string;
  updated_at: string;
  today_log: TodayLog;
  // Legacy fields kept optional for backward compatibility.
  daily_log?: string;
  reflection?: ReflectionFields;
};
