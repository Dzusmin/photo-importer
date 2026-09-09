import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadStoredLanguage } from "./i18n";
import { initializeTheme, ThemeProvider } from "./theme/ThemeProvider";

async function start() {
  initializeTheme();
  await loadStoredLanguage();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
}

void start();
