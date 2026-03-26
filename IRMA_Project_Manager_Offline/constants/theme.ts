/**
 * Below are the colors that are used in the app. The colors are defined in the light and dark mode.
 * There are many other ways to style your app. For example, [Nativewind](https://www.nativewind.dev/), [Tamagui](https://tamagui.dev/), [unistyles](https://reactnativeunistyles.vercel.app), etc.
 */

import { create } from 'zustand';
import { useColorScheme } from 'react-native';

// Available theme modes
export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

// Global Zustand store for saving the user's preference
export const useThemeStore = create<ThemeState>((set) => ({
  mode: 'system', // Default to following device settings
  setMode: (mode) => set({ mode }),
}));

// Light Mode Palette (Matches your current default app colors)
export const lightTheme = {
  background: '#F8FAFC',
  card: '#FFF',
  text: '#1E293B',
  textMuted: '#64748B',
  primary: '#2563EB',
  border: '#E2E8F0',
  danger: '#EF4444',
  success: '#10B981',
  warning: '#EAB308',
  overlay: 'rgba(0,0,0,0.5)',
  inputBg: '#F1F5F9',
};

// Dark Mode Palette (Matches your current auth/migration screens)
export const darkTheme = {
  background: '#0F172A',
  card: '#1E293B',
  text: '#F8FAFC',
  textMuted: '#94A3B8',
  primary: '#3B82F6',
  border: '#334155',
  danger: '#F87171',
  success: '#34D399',
  warning: '#FACC15',
  overlay: 'rgba(0,0,0,0.7)',
  inputBg: '#334155',
};

// Custom Hook to be used inside your components (e.g., VisitManager)
export const useAppTheme = () => {
  const mode = useThemeStore((state) => state.mode);
  const systemColorScheme = useColorScheme(); // React Native's hook for device OS theme
  
  // Determine actual theme based on user selection OR system settings
  const isDark = mode === 'dark' || (mode === 'system' && systemColorScheme === 'dark');
  const colors = isDark ? darkTheme : lightTheme;
  
  return { 
    isDark, 
    colors, 
    mode, 
    setMode: useThemeStore.getState().setMode 
  };
};