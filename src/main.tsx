import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { loadStoredLanguage } from "./i18n";

async function start() {
  await loadStoredLanguage();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
