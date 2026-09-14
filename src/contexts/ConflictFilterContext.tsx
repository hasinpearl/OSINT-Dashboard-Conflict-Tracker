import { createContext, useContext, useState, ReactNode } from "react";

// The selected conflict key, or "all". A plain string rather than a union of
// the three theatres: which conflicts exist is now the API's answer, read from
// /api/conflicts, so a frontend union would have to be edited and redeployed
// every time Hessa switched one on. The API validates the key it is sent and
// serves the "all" tab for anything it does not reveal, so an unknown value
// here degrades to "all" rather than erroring.
export type ConflictFilter = string;

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
