// Reading tasks and check-in rewards. Progress, streak and the week come from what the user really did (TaskContext).

export type ReadingTask = {
  id: string;
  /** Minutes of reading in a day needed to complete the task. */
  minutes: number;
  points: number;
};

export const readingTasks: ReadingTask[] = [
  { id: '10', minutes: 10, points: 5 },
  { id: '30', minutes: 30, points: 15 },
  { id: '60', minutes: 60, points: 30 },
  { id: '120', minutes: 120, points: 100 },
];

// Demo history so the week strip shows both check-ins and "Miss" days right away. Days ago, relative to today:
// checked 1-9 (a 9-day streak), missed 10-11, checked 12-16, missed 17-18, checked 19-21. Set to false for real data only.
export const DEMO_CHECK_IN_HISTORY = true;
export const DEMO_CHECKED_DAYS_AGO = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 20, 21] as const;
export const DEMO_SINCE_DAYS_AGO = 21;

export const WEEK_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
// Points for checking in on each day of the week, Monday first
export const WEEK_REWARDS = [1, 2, 4, 6, 8, 10, 20] as const;
// Streak lengths that are shown as the next goal in the check-in popup
export const STREAK_MILESTONES = [7, 14, 30, 60, 100, 365] as const;
