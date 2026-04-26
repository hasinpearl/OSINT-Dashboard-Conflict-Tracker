import { createContext, useContext, useState, ReactNode } from "react";

export type ConflictFilter = "all" | "iran-us" | "ukraine-russia" | "china-taiwan";

interface ConflictFilterContextType {
  conflict: ConflictFilter;
  setConflict: (c: ConflictFilter) => void;
}

const ConflictFilterContext = createContext<ConflictFilterContextType | undefined>(undefined);

export const ConflictFilterProvider = ({ children }: { children: ReactNode }) => {
  const [conflict, setConflict] = useState<ConflictFilter>("all");
  return (
    <ConflictFilterContext.Provider value={{ conflict, setConflict }}>
      {children}
    </ConflictFilterContext.Provider>
  );
};

export const useConflictFilter = () => {
  const ctx = useContext(ConflictFilterContext);
  if (!ctx) throw new Error("useConflictFilter must be used within ConflictFilterProvider");
  return ctx;
};
