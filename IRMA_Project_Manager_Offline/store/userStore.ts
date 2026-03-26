import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PlannerItem {
  id: string; // project_id + tender_id
  projectId: string;
  tenderId: string;
  title: string;
  ulb: string;
}

interface UserState {
  selectedState: string;
  plannerItems: PlannerItem[];
  
  updateProfile: (data: Partial<UserState>) => void;
  addPlannerItem: (item: PlannerItem) => void;
  removePlannerItem: (id: string) => void;
}

export const useUserStore = create<UserState>()(
  persist(
    (set, get) => ({
      selectedState: 'All States',
      plannerItems: [],
      
      updateProfile: (data) => set((state) => ({ ...state, ...data })),
      
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