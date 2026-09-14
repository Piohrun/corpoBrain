import { createContext, useContext } from 'react';

export const ContextPreview = createContext<{
  open: (path: string) => void;
  resolve: (target: string) => void;
} | null>(null);

export function useContextPreview() {
  return useContext(ContextPreview);
}
