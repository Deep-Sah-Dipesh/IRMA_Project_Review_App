import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PlannerItem {
  id: string; // project_id + tender_id
  projectId: string;
  tenderId: string;
  title: string;
  ulb: string;
  date: string; // 'YYYY-MM-DD' or 'Unscheduled'
}

interface UserState {
  name: string;
  email: string;
  phone: string;
  selectedState: string;
  theme: 'light' | 'dark' | 'system';
  fontScale: number;
  plannerItems: PlannerItem[];
  
  updateProfile: (data: Partial<UserState>) => void;
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  setFontScale: (scale: number) => void;
  addPlannerItem: (item: PlannerItem) => void;
  removePlannerItem: (id: string) => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      name: '',
      email: '',
      phone: '',
      selectedState: 'All States',
      theme: 'system',
      fontScale: 1,
      plannerItems: [],
      
      updateProfile: (data) => set((state) => ({ ...state, ...data })),
      setTheme: (theme) => set({ theme }),
      setFontScale: (scale) => set({ fontScale: Math.max(0.8, Math.min(scale, 1.5)) }),
      
      addPlannerItem: (item) => {
        const items = get().plannerItems.filter(i => i.id !== item.id);
        set({ plannerItems: [...items, item] });
      },
      removePlannerItem: (id) => {
        set({ plannerItems: get().plannerItems.filter(i => i.id !== id) });
      }
    }),
    {
      name: 'irma-user-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);