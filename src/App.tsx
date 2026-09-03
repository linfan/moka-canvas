import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./app/AppShell";
import { OverviewPage } from "./pages/OverviewPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { ShowcasePage } from "./pages/ShowcasePage";
import { TokensPage } from "./pages/TokensPage";

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="showcase" element={<ShowcasePage />} />
        <Route path="playground" element={<PlaygroundPage />} />
        <Route path="tokens" element={<TokensPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
