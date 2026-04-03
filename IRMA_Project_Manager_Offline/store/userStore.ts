import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

interface UserState {
  selectedState: string;
  updateProfile: (data: Partial<UserState>) => void;
}

// Planner state is now strictly localized per user in `planner_cache.json`
// This store now only handles global UI preferences like the selected region.
export const useUserStore = create<UserState>()(
  persist(
    (set) => ({
      selectedState: 'All States',
      updateProfile: (data) => set((state) => ({ ...state, ...data })),
    }),
    {
      name: 'irma-user-storage',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);