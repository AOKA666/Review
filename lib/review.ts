export type QaPair = {
  id: string;
  question: string;
  answer: string;
  showAnswer: boolean;
  order_index: number;
};

export type ReviewRow = {
  id: string;
  category: string;
  context: string;
  solutions: string;
  order_index: number;
  qas: QaPair[];
};

export type ReviewRecord = {
  id: string;
  date: string;
  created_at: string;
  updated_at: string;
  rows: ReviewRow[];
};
