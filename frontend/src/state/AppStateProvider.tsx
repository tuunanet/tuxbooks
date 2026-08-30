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
  const [state, dispatch] = useReducer(appStateReducer, initialState ?? initialAppState);
  return (
    <AppStateContext.Provider value={state}>
      <AppDispatchContext.Provider value={dispatch}>{children}</AppDispatchContext.Provider>
    </AppStateContext.Provider>
  );
}
