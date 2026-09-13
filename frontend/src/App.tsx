import { AppShell } from "@/components/layout/AppShell";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";

export default function App() {
  return (
    <ThemeStateProvider>
      <AppShell />
    </ThemeStateProvider>
  );
}
