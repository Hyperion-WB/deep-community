export interface ReadingHistoryItem {
  id: string;
  title: string;
  author_username: string;
  author_nickname?: string;
  author_avatar?: string;
  category_name?: string;
  reading_time_minutes?: number;
  visited_at: number; // Unix timestamp
}

const STORAGE_KEY = 'wb_reading_history_v1';
const MAX_HISTORY = 60;

export const getReadingHistory = (): ReadingHistoryItem[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

export const addReadingHistory = (item: Omit<ReadingHistoryItem, 'visited_at'>) => {
  if (!item || !item.id) return;
  try {
    const current = getReadingHistory();
    const filtered = current.filter((h) => h.id !== item.id);
    const updated: ReadingHistoryItem[] = [
      {
        ...item,
        visited_at: Date.now(),
      },
      ...filtered,
    ].slice(0, MAX_HISTORY);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {}
};

export const removeReadingHistoryItem = (id: string): ReadingHistoryItem[] => {
  try {
    const current = getReadingHistory();
    const updated = current.filter((h) => h.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    return updated;
  } catch {
    return [];
  }
};

export const clearReadingHistory = () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
};
