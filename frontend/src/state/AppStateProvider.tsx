import { useReducer, type ReactNode } from "react";
import {
  AppDispatchContext,
  AppStateContext,
  appStateReducer,
  initialAppState,
  type AppState,
} from "./appState";

interface AppStateProviderProps {
  children: ReactNode;
  /** Optional override for tests and previews; defaults to the real initial state. */
  initialState?: AppState;
}

export function AppStateProvider({ children, initialState }: AppStateProviderProps) {
  // Merge so partial overrides from tests/previews keep new fields valid.
  const [state, dispatch] = useReducer(appStateReducer, initialState, (override) =>
    override ? { ...initialAppState, ...override } : initialAppState,
  );
  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>{children}</AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}
